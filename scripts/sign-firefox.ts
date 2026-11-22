/**
 * Signs the extension as an unlisted Firefox add-on on addons.mozilla.org (AMO) and saves
 * the signed .xpi to .firefox/, where the Vite build picks it up and serves it at
 * /push-it-firefox.xpi.
 *
 * Idempotent: AMO only accepts each version number once, so if the current manifest version
 * is already on AMO, the signed file is downloaded instead of uploading again.
 *
 * Never fails the build: without credentials, on a non-production branch, or on any error,
 * it logs why and exits 0, and the site just offers the unsigned zip.
 *
 * Environment:
 *   AMO_JWT_ISSUER, AMO_JWT_SECRET  API key + secret from https://addons.mozilla.org/developers/addon/api/key/
 *   FIREFOX_ADDON_ID                optional; overrides browser_specific_settings.gecko.id
 *   FIREFOX_SIGN_BRANCH             optional; branch to sign on in Cloudflare builds (default: main)
 */
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readExtensionManifest, zipExtension } from './extension-zip.ts';

const AMO = 'https://addons.mozilla.org/api/v5';
const XPI_DIR = '.firefox';
const POLL_INTERVAL_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const SIGN_TIMEOUT_MS = 10 * 60_000;

const log = (msg: string) => console.log(`[firefox-sign] ${msg}`);

const issuer = process.env.AMO_JWT_ISSUER?.trim();
const secret = process.env.AMO_JWT_SECRET?.trim();

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

// AMO wants a fresh short-lived HS256 JWT on every request.
function authHeader(): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 }));
  const sig = createHmac('sha256', secret!).update(`${head}.${body}`).digest('base64url');
  return `JWT ${head}.${body}.${sig}`;
}

async function amo(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', authHeader());
  return fetch(path.startsWith('http') ? path : `${AMO}${path}`, { ...init, headers });
}

async function amoJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await amo(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AmoVersion {
  version: string;
  file?: { status?: string; url?: string } | null;
}

async function findVersion(guid: string, version: string): Promise<AmoVersion | null> {
  const res = await amo(
    `/addons/addon/${encodeURIComponent(guid)}/versions/?filter=all_with_unlisted&page_size=50`,
  );
  if (res.status === 404 || res.status === 401 || res.status === 403) return null; // add-on not created yet
  if (!res.ok) throw new Error(`listing versions → ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as { results?: AmoVersion[] };
  return data.results?.find((v) => v.version === version) ?? null;
}

async function upload(xpi: Uint8Array): Promise<string> {
  const form = new FormData();
  form.set('upload', new Blob([xpi], { type: 'application/zip' }), 'push-it.zip');
  form.set('channel', 'unlisted');
  const created = await amoJson<{ uuid: string }>('/addons/upload/', { method: 'POST', body: form });

  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await amoJson<{ processed: boolean; valid: boolean; validation?: unknown }>(
      `/addons/upload/${created.uuid}/`,
    );
    if (status.processed) {
      if (!status.valid) {
        throw new Error(`AMO validation failed:\n${JSON.stringify(status.validation, null, 2)}`);
      }
      return created.uuid;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('timed out waiting for AMO to validate the upload');
}

async function submit(guid: string, uploadUuid: string): Promise<void> {
  const path = `/addons/addon/${encodeURIComponent(guid)}`;
  // New version of an existing add-on…
  const res = await amo(`${path}/versions/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upload: uploadUuid }),
  });
  if (res.ok) return;
  if (res.status !== 404) {
    throw new Error(`creating version → ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  // …or the first version, which creates the add-on under this GUID.
  await amoJson(`${path}/`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: { upload: uploadUuid } }),
  });
}

async function waitForSigned(guid: string, version: string): Promise<string> {
  const deadline = Date.now() + SIGN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const v = await findVersion(guid, version);
    const status = v?.file?.status;
    if (status === 'public' && v?.file?.url) return v.file.url;
    if (status === 'disabled') throw new Error(`AMO rejected or disabled v${version}`);
    log(`waiting for AMO to sign v${version} (status: ${status ?? 'pending'})…`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for AMO to sign v${version}; the next build will pick it up`);
}

async function main(): Promise<void> {
  rmSync(XPI_DIR, { recursive: true, force: true });

  if (!issuer || !secret) {
    log('AMO_JWT_ISSUER / AMO_JWT_SECRET not set; skipping (site will offer the unsigned zip)');
    return;
  }
  const branch = process.env.WORKERS_CI_BRANCH;
  const signBranch = process.env.FIREFOX_SIGN_BRANCH || 'main';
  if (branch && branch !== signBranch) {
    log(`building branch "${branch}", only "${signBranch}" is signed; skipping`);
    return;
  }

  const manifest = readExtensionManifest();
  const guid = process.env.FIREFOX_ADDON_ID?.trim() || manifest.browser_specific_settings?.gecko?.id;
  if (!guid) throw new Error('no add-on ID: set browser_specific_settings.gecko.id or FIREFOX_ADDON_ID');
  manifest.browser_specific_settings = {
    ...manifest.browser_specific_settings,
    gecko: { ...manifest.browser_specific_settings?.gecko, id: guid },
  };
  const { version } = manifest;

  let fileUrl: string;
  const existing = await findVersion(guid, version);
  if (existing) {
    log(`v${version} of ${guid} is already on AMO; reusing it`);
    fileUrl = await waitForSigned(guid, version);
  } else {
    log(`uploading v${version} of ${guid} for signing…`);
    const uploadUuid = await upload(zipExtension(manifest));
    await submit(guid, uploadUuid);
    fileUrl = await waitForSigned(guid, version);
  }

  const res = await amo(fileUrl);
  if (!res.ok) throw new Error(`downloading signed file → ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  mkdirSync(XPI_DIR, { recursive: true });
  writeFileSync(`${XPI_DIR}/push-it-firefox-${version}.xpi`, bytes);
  log(`saved signed v${version} (${bytes.byteLength} bytes)`);
}

main().catch((err) => {
  console.warn(`[firefox-sign] WARNING: signing skipped: ${err instanceof Error ? err.message : err}`);
  process.exit(0);
});
