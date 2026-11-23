import pkg from '../package.json';
import { PAIR_DO_NAME, PairDO } from './pair-do';
import { RoomDO, VAPID_DO_NAME, type Env } from './room-do';

export { PairDO, RoomDO };

const ROOM_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const HSTS = 'max-age=31536000';
const DEFAULT_REPO_URL = 'https://github.com/luismbo/push-it';

function isRoomAllowed(env: Env, roomId: string): boolean {
  const allowed = (env.ALLOWED_ROOM_IDS || '').split(/[\s,]+/).filter(Boolean);
  return allowed.length === 0 || allowed.includes(roomId);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Force HTTPS (except for local `wrangler dev`). 308 keeps the method and body.
    if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 308);
    }

    if (url.pathname === '/api/version' && request.method === 'GET') {
      return Response.json(
        { version: pkg.version },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    if (url.pathname === '/api/vapid-public-key' && request.method === 'GET') {
      if (env.VAPID_PUBLIC_KEY) {
        return Response.json({ publicKey: env.VAPID_PUBLIC_KEY });
      }
      const vapidStub = env.ROOMS.get(env.ROOMS.idFromName(VAPID_DO_NAME));
      const res = await vapidStub.fetch('https://internal/internal/vapid-keys');
      const keys = (await res.json()) as { publicKey: string };
      return Response.json({ publicKey: keys.publicKey });
    }

    if (url.pathname === '/api/pair' || url.pathname.startsWith('/api/pair/')) {
      // Creating a code is tied to a room, so private servers only hand out codes for their
      // approved rooms. Joining needs no room: the joiner doesn't know it yet.
      if (url.pathname === '/api/pair' && request.method === 'POST') {
        const body = (await request.clone().json().catch(() => ({}))) as { roomId?: string };
        if (!body.roomId || !ROOM_ID_RE.test(body.roomId)) {
          return Response.json({ error: 'Invalid roomId' }, { status: 400 });
        }
        if (!isRoomAllowed(env, body.roomId)) {
          return Response.json({ error: 'This server only allows approved rooms' }, { status: 403 });
        }
      }
      return env.PAIRS.get(env.PAIRS.idFromName(PAIR_DO_NAME)).fetch(request);
    }

    const roomMatch = url.pathname.match(
      /^\/api\/room\/([^/]+)\/(ws|send|op|ack|pending|devices|subscribe|status|blob\/[A-Za-z0-9_-]{8,64})$/,
    );
    if (roomMatch) {
      const roomId = roomMatch[1];
      if (!ROOM_ID_RE.test(roomId) || roomId === VAPID_DO_NAME) {
        return Response.json({ error: 'Invalid roomId' }, { status: 400 });
      }
      if (!isRoomAllowed(env, roomId)) {
        const repoUrl = env.REPO_URL || DEFAULT_REPO_URL;
        return Response.json(
          {
            error: 'private_server',
            message: `This Push It server is private. Deploy your own for free: ${repoUrl}`,
            repoUrl,
          },
          { status: 403 },
        );
      }
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    const asset = await env.ASSETS.fetch(request);
    const res = new Response(asset.body, asset);
    if (url.protocol === 'https:') res.headers.set('strict-transport-security', HSTS);
    return res;
  },
} satisfies ExportedHandler<Env>;
