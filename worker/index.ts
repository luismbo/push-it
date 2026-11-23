import pkg from '../package.json';
import { RoomDO, VAPID_DO_NAME, type Env } from './room-do';

export { RoomDO };

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
