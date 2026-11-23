// Archive / restore / delete ops that keep every paired device's history in step.
//
// An op names messages by their envelope id, which is the same on every device. Each device
// keeps a log of the latest op per message id, so ops can arrive in any order relative to the
// messages they affect: a message that shows up after it was deleted elsewhere is dropped, and
// one that was archived elsewhere lands straight in the archive.

export type MessageOpKind = 'archive' | 'unarchive' | 'delete';

export interface MessageOp {
  op: MessageOpKind;
  ids: string[];
  at: number;
}

export interface OpRecord {
  op: MessageOpKind;
  at: number;
}

export type OpLog = Record<string, OpRecord>;

/** Ids per op envelope, which keeps each one under the server's 3500-character limit. */
export const OP_BATCH_SIZE = 40;
const OP_LOG_MAX = 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseOp(value: unknown): MessageOp | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<MessageOp>;
  if (v.op !== 'archive' && v.op !== 'unarchive' && v.op !== 'delete') return null;
  if (!Array.isArray(v.ids) || typeof v.at !== 'number') return null;
  const ids = v.ids.filter((id): id is string => typeof id === 'string' && ID_RE.test(id));
  return ids.length ? { op: v.op, ids, at: v.at } : null;
}

/**
 * Records `op` in `log` (mutating it) and returns the ids whose state it changes.
 * Delete always wins; otherwise the op with the later timestamp wins.
 */
export function mergeOp(log: OpLog, op: MessageOp): string[] {
  const changed: string[] = [];
  for (const id of op.ids) {
    const prev = log[id];
    if (prev?.op === 'delete') continue;
    if (op.op !== 'delete' && prev && prev.at >= op.at) continue;
    log[id] = { op: op.op, at: op.at };
    changed.push(id);
  }
  trimLog(log);
  return changed;
}

function trimLog(log: OpLog) {
  const ids = Object.keys(log);
  if (ids.length <= OP_LOG_MAX) return;
  ids.sort((a, b) => log[a].at - log[b].at);
  for (const id of ids.slice(0, ids.length - OP_LOG_MAX)) delete log[id];
}

/** How a message should be stored given the log: dropped (null) or with its archive time. */
export function reconcile<T extends { id: string; archivedAt?: number }>(
  log: OpLog,
  msg: T,
): T | null {
  const rec = log[msg.id];
  if (!rec) return msg;
  if (rec.op === 'delete') return null;
  if (rec.op === 'archive') return { ...msg, archivedAt: rec.at };
  const { archivedAt: _drop, ...rest } = msg;
  return rest as T;
}

export function chunkIds(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += OP_BATCH_SIZE) out.push(ids.slice(i, i + OP_BATCH_SIZE));
  return out;
}
