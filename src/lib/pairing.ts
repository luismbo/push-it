// Pairing with a short one-time code such as "42-amber-kettle-river".
//
// The number (the "nameplate") only locates a pairing session on the server. The three words
// are a password that never leaves either device: both sides run SPAKE2 over ristretto255 with
// it, so the server only relays values it cannot brute-force offline. An attacker gets one
// online guess per code (the session closes after the first join), i.e. 1 in 2^33.
//
// Once both sides share a key, the joiner proves it with a confirmation hash and the host sends
// the room key encrypted under it. The decryption doubles as the host's confirmation.
//
// This file is also bundled into the browser extension (extension/pairing.js), so it must not
// import anything app-specific.

import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export const PAIR_WORD_COUNT = 3;
export const PAIR_TTL_MS = 10 * 60 * 1000;
const POLL_MS = 1500;
const JOIN_TIMEOUT_MS = 60 * 1000;

const DST = 'push-it-pair-v1';
const enc = new TextEncoder();
const Point = ristretto255.Point;
type RPoint = InstanceType<typeof Point>;
const M = ristretto255_hasher.hashToCurve(enc.encode('M'), { DST: `${DST}-M` }) as RPoint;
const N = ristretto255_hasher.hashToCurve(enc.encode('N'), { DST: `${DST}-N` }) as RPoint;
const WORD_INDEX = new Map(wordlist.map((w, i) => [w, i]));

export interface PairCode {
  nameplate: number;
  words: string[];
}

// ---- Codes and words ----

export function randomWords(count = PAIR_WORD_COUNT): string[] {
  // 2048 words divide 65536 evenly, so masking 16 random bits is unbiased.
  const idx = crypto.getRandomValues(new Uint16Array(count));
  return Array.from(idx, (i) => wordlist[i & 2047]);
}

export function formatCode(code: PairCode): string {
  return `${code.nameplate}-${code.words.join('-')}`;
}

/** Wallet words are unique by their first four letters, so a 4+ letter prefix is enough. */
function resolveWord(token: string): string | null {
  if (WORD_INDEX.has(token)) return token;
  if (token.length < 4) return null;
  const matches = wordlist.filter((w) => w.startsWith(token));
  return matches.length === 1 ? matches[0] : null;
}

/** Parses "42 amber kettle river", "42-amber-kettle-river", etc. Returns null if it isn't one. */
export function parseCode(input: string): PairCode | null {
  const tokens = input
    .trim()
    .toLowerCase()
    .split(/[\s\-.,_·]+/)
    .filter(Boolean);
  if (tokens.length !== PAIR_WORD_COUNT + 1 || !/^\d{1,3}$/.test(tokens[0])) return null;
  const nameplate = Number(tokens[0]);
  if (nameplate < 1) return null;
  const words: string[] = [];
  for (const t of tokens.slice(1)) {
    const w = resolveWord(t);
    if (!w) return null;
    words.push(w);
  }
  return { nameplate, words };
}

/** Looks like the user is typing a code (starts with a number), as opposed to a pair link. */
export function looksLikeCode(input: string): boolean {
  return /^\s*\d{1,3}(?:[\s\-.,_·]|$)/.test(input);
}

/** Up to `limit` words completing the last token of `input`, for autocomplete. */
export function suggestWords(input: string, limit = 4): string[] {
  if (!looksLikeCode(input) || /[\s\-.,_·]$/.test(input)) return [];
  const tokens = input.trim().toLowerCase().split(/[\s\-.,_·]+/);
  const last = tokens[tokens.length - 1];
  if (tokens.length < 2 || !last || WORD_INDEX.has(last)) return [];
  return wordlist.filter((w) => w.startsWith(last)).slice(0, limit);
}

/** Replaces the last token of `input` with `word` and adds a separator. */
export function completeWord(input: string, word: string): string {
  const tokens = input.trim().split(/[\s\-.,_·]+/);
  tokens[tokens.length - 1] = word;
  return tokens.join('-') + (tokens.length <= PAIR_WORD_COUNT ? '-' : '');
}

// ---- SPAKE2 ----

function toB64u(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(std);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  const len = parts.reduce((n, p) => n + p.length + 4, 0);
  const buf = new Uint8Array(new ArrayBuffer(len));
  let off = 0;
  for (const p of parts) {
    new DataView(buf.buffer).setUint32(off, p.length);
    buf.set(p, off + 4);
    off += p.length + 4;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

function passwordScalar(words: string[]): bigint {
  return ristretto255_hasher.hashToScalar(enc.encode(words.join(' ')), { DST: `${DST}-w` });
}

function randomScalar(): bigint {
  return ristretto255_hasher.hashToScalar(crypto.getRandomValues(new Uint8Array(64)), {
    DST: `${DST}-r`,
  });
}

interface SessionKeys {
  aesKey: CryptoKey;
  confirmB: string;
}

/** One side of a SPAKE2 exchange: its public message and how to finish with the peer's. */
function spake(side: 'A' | 'B', words: string[]) {
  const w = passwordScalar(words);
  const x = randomScalar();
  const [mine, theirs] = side === 'A' ? [M, N] : [N, M];
  const msgPoint = Point.BASE.multiply(x).add(mine.multiply(w));
  const msg = msgPoint.toBytes();

  async function finish(peerMsgB64: string): Promise<SessionKeys> {
    const peerBytes = fromB64u(peerMsgB64);
    const peer = Point.fromBytes(peerBytes);
    const shared = peer.subtract(theirs.multiply(w)).multiply(x);
    if (shared.is0()) throw new Error('Invalid pairing message');
    const [msgA, msgB] = side === 'A' ? [msg, peerBytes] : [peerBytes, msg];
    const transcript = await sha256(enc.encode(DST), msgA, msgB, shared.toBytes(), enc.encode(w.toString(16)));
    const keyBytes = await sha256(transcript, enc.encode('key'));
    return {
      aesKey: await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]),
      confirmB: toB64u(await sha256(transcript, enc.encode('confirm-B'))),
    };
  }

  return { msg: toB64u(msg), finish };
}

// ---- Server round trips ----

async function api<T>(base: string, path: string, init?: RequestInit): Promise<{ status: number; data: T | null }> {
  const res = await fetch(`${base}/api/pair${path}`, {
    cache: 'no-store',
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const data = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, data };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type HostEvent =
  | { type: 'code'; code: PairCode; expiresAt: number }
  | { type: 'paired' }
  | { type: 'mismatch' }
  | { type: 'error'; message: string };

/**
 * Shows codes for another device to enter, until `signal` aborts. A code that expires or gets a
 * wrong guess is replaced by a fresh one; after a successful pairing a new code is offered too,
 * so several devices can be added in a row.
 */
export async function hostPairing(
  base: string,
  roomId: string,
  roomKeyB64: string,
  onEvent: (e: HostEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const words = randomWords();
    const side = spake('A', words);
    const created = await api<{ nameplate: number; token: string; expiresAt: number; error?: string }>(
      base,
      '',
      { method: 'POST', body: JSON.stringify({ roomId, msgA: side.msg }) },
    ).catch(() => null);
    if (!created?.data?.token) {
      onEvent({ type: 'error', message: created?.data?.error || 'Could not create a pairing code' });
      await sleep(5000);
      continue;
    }
    const { nameplate, token, expiresAt } = created.data;
    onEvent({ type: 'code', code: { nameplate, words }, expiresAt });

    const q = `?token=${encodeURIComponent(token)}`;
    let joined: { msgB: string; confirmB: string } | null = null;
    while (!signal.aborted && Date.now() < expiresAt) {
      await sleep(POLL_MS);
      const st = await api<{ state: string; msgB?: string; confirmB?: string }>(
        base,
        `/${nameplate}/status${q}`,
      ).catch(() => null);
      if (st?.data?.state === 'joined' && st.data.msgB && st.data.confirmB) {
        joined = { msgB: st.data.msgB, confirmB: st.data.confirmB };
        break;
      }
      if (st && st.status === 404) break;
    }

    if (signal.aborted || !joined) {
      // Expired or closed: drop the session so the number is free again.
      api(base, `/${nameplate}/finish`, { method: 'POST', body: JSON.stringify({ token, ok: false }), keepalive: true }).catch(
        () => {},
      );
      continue;
    }

    let keys: SessionKeys | null = null;
    try {
      keys = await side.finish(joined.msgB);
    } catch {
      keys = null;
    }
    if (!keys || keys.confirmB !== joined.confirmB) {
      await api(base, `/${nameplate}/finish`, { method: 'POST', body: JSON.stringify({ token, ok: false }) }).catch(() => {});
      onEvent({ type: 'mismatch' });
      continue;
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys.aesKey, enc.encode(JSON.stringify({ key: roomKeyB64 }))),
    );
    await api(base, `/${nameplate}/finish`, {
      method: 'POST',
      body: JSON.stringify({ token, ok: true, payload: `${toB64u(iv)}.${toB64u(sealed)}` }),
    }).catch(() => {});
    onEvent({ type: 'paired' });
  }
}

export class PairingError extends Error {}

/** Enters a code shown on another device and returns that device's room key. */
export async function joinPairing(base: string, code: PairCode): Promise<string> {
  const session = await api<{ msgA?: string }>(base, `/${code.nameplate}`);
  if (!session.data?.msgA) {
    throw new PairingError('That code has expired or was already used. Ask for a new one.');
  }

  const side = spake('B', code.words);
  const keys = await side.finish(session.data.msgA).catch(() => {
    throw new PairingError('That code is not valid');
  });
  const joined = await api<{ joinToken?: string }>(base, `/${code.nameplate}/join`, {
    method: 'POST',
    body: JSON.stringify({ msgB: side.msg, confirmB: keys.confirmB }),
  });
  if (!joined.data?.joinToken) {
    throw new PairingError('That code was already used. Ask for a new one.');
  }

  const deadline = Date.now() + JOIN_TIMEOUT_MS;
  const q = `?joinToken=${encodeURIComponent(joined.data.joinToken)}`;
  while (Date.now() < deadline) {
    await sleep(POLL_MS / 2);
    const res = await api<{ state: string; payload?: string }>(base, `/${code.nameplate}/result${q}`).catch(() => null);
    const state = res?.data?.state;
    if (state === 'failed' || res?.status === 404) {
      throw new PairingError("The words don't match the code on your other device. Check them and try again.");
    }
    if (state === 'done' && res?.data?.payload) {
      const [ivB64, ctB64] = res.data.payload.split('.');
      try {
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromB64u(ivB64) },
          keys.aesKey,
          fromB64u(ctB64),
        );
        const { key } = JSON.parse(new TextDecoder().decode(plain)) as { key?: string };
        if (typeof key === 'string' && key) return key;
      } catch {
        // falls through to the error below
      }
      throw new PairingError("The words don't match the code on your other device.");
    }
  }
  throw new PairingError('Your other device did not answer. Keep its Add Device screen open and try again.');
}
