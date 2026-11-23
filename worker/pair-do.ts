import { DurableObject } from 'cloudflare:workers';

// Relays the few messages of a code-based pairing (see src/lib/pairing.ts). Everything stored
// here is either public SPAKE2 values or encrypted under the session key, which the server
// can't derive. Sessions live for 10 minutes and accept a single join, so each code allows
// exactly one guess.

interface PairSession {
  nameplate: number;
  token: string;
  msgA: string;
  expiresAt: number;
  state: 'waiting' | 'joined' | 'done' | 'failed';
  joinToken?: string;
  msgB?: string;
  confirmB?: string;
  payload?: string;
}

const PREFIX = 's:';
const TTL_MS = 10 * 60 * 1000;
// How long a finished session lingers so the joiner can read the outcome.
const RESULT_TTL_MS = 2 * 60 * 1000;
const MAX_NAMEPLATE = 999;
const MAX_SESSIONS = 800;
const B64U_32 = /^[A-Za-z0-9_-]{43}$/;

export const PAIR_DO_NAME = 'pairing';

export class PairDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/pair(?:\/(\d{1,3})(?:\/(join|status|finish|result))?)?$/);
    if (!m) return new Response('Not Found', { status: 404 });
    const [, num, action] = m;
    const now = Date.now();

    if (!num) {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return this.create(request, now);
    }

    const key = `${PREFIX}${Number(num)}`;
    const session = await this.ctx.storage.get<PairSession>(key);
    if (!session || session.expiresAt < now) {
      if (session) await this.ctx.storage.delete(key);
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    if (!action && request.method === 'GET') {
      if (session.state !== 'waiting') return Response.json({ error: 'not_found' }, { status: 404 });
      return Response.json({ msgA: session.msgA }, { headers: { 'cache-control': 'no-store' } });
    }

    if (action === 'join' && request.method === 'POST') {
      if (session.state !== 'waiting') return Response.json({ error: 'used' }, { status: 409 });
      const body = (await request.json().catch(() => ({}))) as { msgB?: string; confirmB?: string };
      if (!body.msgB || !body.confirmB || !B64U_32.test(body.msgB) || !B64U_32.test(body.confirmB)) {
        return Response.json({ error: 'invalid' }, { status: 400 });
      }
      session.state = 'joined';
      session.msgB = body.msgB;
      session.confirmB = body.confirmB;
      session.joinToken = crypto.randomUUID();
      await this.ctx.storage.put(key, session);
      return Response.json({ joinToken: session.joinToken });
    }

    if (action === 'status' && request.method === 'GET') {
      if (url.searchParams.get('token') !== session.token) return Response.json({ error: 'forbidden' }, { status: 403 });
      return Response.json(
        session.state === 'joined'
          ? { state: 'joined', msgB: session.msgB, confirmB: session.confirmB }
          : { state: session.state },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    if (action === 'finish' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { token?: string; ok?: boolean; payload?: string };
      if (body.token !== session.token) return Response.json({ error: 'forbidden' }, { status: 403 });
      if (session.state === 'waiting') {
        // Host closed the code before anyone joined.
        await this.ctx.storage.delete(key);
        return Response.json({ ok: true });
      }
      if (session.state !== 'joined') return Response.json({ error: 'finished' }, { status: 409 });
      if (body.ok && (typeof body.payload !== 'string' || body.payload.length > 400)) {
        return Response.json({ error: 'invalid' }, { status: 400 });
      }
      session.state = body.ok ? 'done' : 'failed';
      session.payload = body.ok ? body.payload : undefined;
      session.expiresAt = Math.min(session.expiresAt, now + RESULT_TTL_MS);
      await this.ctx.storage.put(key, session);
      return Response.json({ ok: true });
    }

    if (action === 'result' && request.method === 'GET') {
      if (!session.joinToken || url.searchParams.get('joinToken') !== session.joinToken) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      if (session.state === 'done' || session.state === 'failed') {
        await this.ctx.storage.delete(key);
        return Response.json({ state: session.state, payload: session.payload });
      }
      return Response.json({ state: 'waiting' }, { headers: { 'cache-control': 'no-store' } });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }

  private async create(request: Request, now: number): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { msgA?: string };
    if (!body.msgA || !B64U_32.test(body.msgA)) {
      return Response.json({ error: 'invalid' }, { status: 400 });
    }

    const all = await this.ctx.storage.list<PairSession>({ prefix: PREFIX });
    const expired: string[] = [];
    const used = new Set<number>();
    for (const [k, s] of all) {
      if (s.expiresAt < now) expired.push(k);
      else used.add(s.nameplate);
    }
    if (expired.length) await this.ctx.storage.delete(expired);
    if (used.size >= MAX_SESSIONS) {
      return Response.json({ error: 'Too many pairings in progress. Try again in a few minutes.' }, { status: 503 });
    }

    // Small numbers are easier to type, so pick randomly among the lowest free ones.
    const free: number[] = [];
    for (let n = 1; n <= MAX_NAMEPLATE && free.length < 50; n++) if (!used.has(n)) free.push(n);
    const nameplate = free[crypto.getRandomValues(new Uint32Array(1))[0] % free.length];

    const session: PairSession = {
      nameplate,
      token: crypto.randomUUID(),
      msgA: body.msgA,
      expiresAt: now + TTL_MS,
      state: 'waiting',
    };
    await this.ctx.storage.put(`${PREFIX}${nameplate}`, session);
    return Response.json({ nameplate, token: session.token, expiresAt: session.expiresAt });
  }
}
