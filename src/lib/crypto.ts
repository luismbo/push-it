import { normalizeOs, type DeviceOs } from './device';

export type PayloadType = 'link' | 'text' | 'longtext' | 'file';

export interface DecryptedPayload {
  type: PayloadType;
  content: string;
  title?: string;
  senderName?: string;
  senderOs?: DeviceOs;
  targetNames?: string[];
  blobId?: string;
  blobIv?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface EncryptedEnvelope {
  id: string;
  senderId: string;
  targetIds?: string[];
  iv: string;
  ciphertext: string;
  ts: number;
}

export interface DeviceMeta {
  name: string;
  os: DeviceOs;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const std = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function generateRawKeyB64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function isValidKeyB64(keyB64: string): boolean {
  try {
    return fromBase64Url(keyB64.trim()).length === 32;
  } catch {
    return false;
  }
}

export async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64Url(keyB64);
  if (raw.length !== 32) {
    throw new Error('Key must be 256 bits (32 bytes)');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function deriveRoomId(keyB64: string): Promise<string> {
  const data = new TextEncoder().encode(`push-it-room-v1:${keyB64}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash).slice(0, 24);
}

export async function encryptBytes(
  keyB64: string,
  plainBytes: Uint8Array<ArrayBuffer>,
): Promise<{ iv: string; ciphertext: Uint8Array<ArrayBuffer> }> {
  const key = await importAesKey(keyB64);
  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  crypto.getRandomValues(iv);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
  return {
    iv: toBase64Url(iv),
    ciphertext: new Uint8Array(cipherBuf),
  };
}

export async function decryptBytes(
  keyB64: string,
  ivB64: string,
  cipherBytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importAesKey(keyB64);
  const iv = fromBase64Url(ivB64);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBytes);
  return new Uint8Array(plainBuf);
}

export async function encryptJson(
  keyB64: string,
  value: unknown,
): Promise<{ iv: string; ciphertext: string }> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const buf = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buf).set(encoded);
  const { iv, ciphertext } = await encryptBytes(keyB64, new Uint8Array(buf));
  return { iv, ciphertext: toBase64Url(ciphertext) };
}

export async function decryptJson<T>(
  keyB64: string,
  ivB64: string,
  ciphertextB64: string,
): Promise<T> {
  const plain = await decryptBytes(keyB64, ivB64, fromBase64Url(ciphertextB64));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export async function encryptPayload(
  keyB64: string,
  senderId: string,
  payload: DecryptedPayload,
  targetIds?: string[],
): Promise<EncryptedEnvelope> {
  const { iv, ciphertext } = await encryptJson(keyB64, payload);
  return {
    id: crypto.randomUUID(),
    senderId,
    targetIds: targetIds && targetIds.length > 0 ? targetIds : undefined,
    iv,
    ciphertext,
    ts: Date.now(),
  };
}

/** Wraps an archive/delete op in an envelope for the /op route. */
export async function encryptOp(
  keyB64: string,
  senderId: string,
  op: unknown,
): Promise<EncryptedEnvelope> {
  const { iv, ciphertext } = await encryptJson(keyB64, op);
  return { id: crypto.randomUUID(), senderId, iv, ciphertext, ts: Date.now() };
}

export async function decryptEnvelope(
  keyB64: string,
  envelope: EncryptedEnvelope,
): Promise<DecryptedPayload> {
  const parsed = await decryptJson<Partial<DecryptedPayload>>(
    keyB64,
    envelope.iv,
    envelope.ciphertext,
  );
  const type: PayloadType =
    parsed.type === 'link' || parsed.type === 'file' || parsed.type === 'longtext'
      ? parsed.type
      : 'text';
  return {
    type,
    content: String(parsed.content ?? ''),
    title: parsed.title ? String(parsed.title) : undefined,
    senderName: parsed.senderName ? String(parsed.senderName) : undefined,
    senderOs: parsed.senderOs ? normalizeOs(parsed.senderOs) : undefined,
    targetNames: Array.isArray(parsed.targetNames)
      ? parsed.targetNames.map((n) => String(n))
      : undefined,
    blobId: parsed.blobId ? String(parsed.blobId) : undefined,
    blobIv: parsed.blobIv ? String(parsed.blobIv) : undefined,
    fileName: parsed.fileName ? String(parsed.fileName) : undefined,
    mimeType: parsed.mimeType ? String(parsed.mimeType) : undefined,
    fileSize: typeof parsed.fileSize === 'number' ? parsed.fileSize : undefined,
  };
}

export function isSafeHttpUrl(input: string): boolean {
  try {
    const u = new URL(input.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function detectPayloadType(input: string): 'link' | 'text' {
  const trimmed = input.trim();
  if (!trimmed.includes('\n') && !trimmed.includes(' ') && isSafeHttpUrl(trimmed)) {
    return 'link';
  }
  return 'text';
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
