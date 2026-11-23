import type { PayloadType } from './crypto';
import type { DeviceOs } from './device';
import { mergeOp, reconcile, type MessageOp, type OpLog } from './ops';

export interface StoredMessage {
  id: string;
  senderId: string;
  senderName?: string;
  senderOs?: DeviceOs;
  targetNames?: string[];
  ts: number;
  type: PayloadType;
  content: string;
  title?: string;
  direction: 'in' | 'out';
  status?: 'queued' | 'delivered';
  blobId?: string;
  blobIv?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  /** Set while the message sits in the Archived tab. */
  archivedAt?: number;
}

export interface StoredBlob {
  id: string;
  data: ArrayBuffer;
  mimeType: string;
  fileName: string;
}

const DB_NAME = 'push-it-db';
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
      if (!db.objectStoreNames.contains('messages')) {
        db.createObjectStore('messages', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet<T = string>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveMessage(msg: StoredMessage): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put(msg);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function markMessagesDelivered(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');
    for (const id of ids) {
      const req = store.get(id);
      req.onsuccess = () => {
        const msg = req.result as StoredMessage | undefined;
        if (msg && msg.status !== 'delivered') {
          store.put({ ...msg, status: 'delivered' });
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** The newest `limit` feed messages plus every archived one, oldest first. */
export async function listMessages(limit = 60): Promise<StoredMessage[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const req = tx.objectStore('messages').getAll();
    req.onsuccess = () => {
      const all = (req.result as StoredMessage[]) || [];
      all.sort((a, b) => a.ts - b.ts);
      resolve(trimFeed(all, limit));
    };
    req.onerror = () => reject(req.error);
  });
}

/** Keeps every archived message and only the newest `limit` feed messages. */
export function trimFeed(list: StoredMessage[], limit = 60): StoredMessage[] {
  const feedCount = list.filter((m) => !m.archivedAt).length;
  let skip = Math.max(0, feedCount - limit);
  if (!skip) return list;
  return list.filter((m) => m.archivedAt || skip-- <= 0);
}

const OP_LOG_KEY = 'messageOps';

/**
 * Applies the op log to an incoming message before it is stored. Returns null when the
 * message was already deleted on another device.
 */
export async function reconcileIncoming(msg: StoredMessage): Promise<StoredMessage | null> {
  const log = (await kvGet<OpLog>(OP_LOG_KEY)) || {};
  return reconcile(log, msg);
}

/**
 * Records an op and updates or removes the stored messages (and their files) it changes.
 * Returns the ids that changed.
 */
export async function applyMessageOp(op: MessageOp): Promise<string[]> {
  const log = (await kvGet<OpLog>(OP_LOG_KEY)) || {};
  const changed = mergeOp(log, op);
  await kvSet(OP_LOG_KEY, log);
  if (!changed.length) return changed;

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['messages', 'blobs'], 'readwrite');
    const messages = tx.objectStore('messages');
    const blobs = tx.objectStore('blobs');
    for (const id of changed) {
      const req = messages.get(id);
      req.onsuccess = () => {
        const msg = req.result as StoredMessage | undefined;
        if (!msg) return;
        if (op.op === 'delete') {
          messages.delete(id);
          if (msg.blobId) blobs.delete(msg.blobId);
          return;
        }
        const next = reconcile(log, msg);
        if (next) messages.put(next);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return changed;
}

export async function saveBlob(blob: StoredBlob): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(blob);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getBlob(id: string): Promise<StoredBlob | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => resolve(req.result as StoredBlob | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function clearMessages(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['messages', 'blobs'], 'readwrite');
    tx.objectStore('messages').clear();
    tx.objectStore('blobs').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
