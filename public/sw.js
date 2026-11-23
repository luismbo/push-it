// Push It Service Worker — E2EE Web Push decrypt + silent Android Share Target handler

const DB_NAME = 'push-it-db';
const DB_VERSION = 2;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function openDb() {
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

async function kvGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveMessage(msg) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put(msg);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const std = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveRoomId(keyB64) {
  const data = new TextEncoder().encode(`push-it-room-v1:${keyB64}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash).slice(0, 24);
}

async function encryptPayload(keyB64, senderId, payload) {
  const rawKey = fromBase64Url(keyB64);
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plainBytes = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
  return {
    id: crypto.randomUUID(),
    senderId,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(cipherBuf)),
    ts: Date.now(),
  };
}

async function decryptEnvelope(keyB64, envelope) {
  const rawKey = fromBase64Url(keyB64);
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const iv = fromBase64Url(envelope.iv);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const text = new TextDecoder().decode(plainBuf);
  return JSON.parse(text);
}

function isSafeHttpUrl(str) {
  try {
    const u = new URL(String(str).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function detectPayloadType(input) {
  const trimmed = String(input).trim();
  if (!trimmed.includes('\n') && !trimmed.includes(' ') && isSafeHttpUrl(trimmed)) {
    return 'link';
  }
  return 'text';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Intercept Android Share Target (/share?...) directly in SW so it sends immediately
// and auto-closes without loading or showing the full PWA UI.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && url.pathname === '/share') {
    event.respondWith(handleSilentShare(url));
  }
});

async function handleSilentShare(url) {
  const sharedUrl = (url.searchParams.get('url') || '').trim();
  const sharedText = (url.searchParams.get('text') || '').trim();
  const sharedTitle = (url.searchParams.get('title') || '').trim() || undefined;
  const content = sharedUrl || sharedText;

  let statusMsg = 'Sent';
  let ok = false;

  try {
    const [keyB64, deviceId, deviceName, deviceOs] = await Promise.all([
      kvGet('keyB64'),
      kvGet('deviceId'),
      kvGet('deviceName'),
      kvGet('deviceOs'),
    ]);

    if (!keyB64 || !deviceId) {
      return Response.redirect('/', 302);
    }

    if (content) {
      const roomId = await deriveRoomId(keyB64);
      const type = detectPayloadType(content);
      const senderName = deviceName || 'Android';
      const senderOs = deviceOs || 'android';

      const envelope = await encryptPayload(keyB64, deviceId, {
        type,
        content,
        title: sharedTitle,
        senderName,
        senderOs,
      });

      const res = await fetch(`/api/room/${encodeURIComponent(roomId)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });

      if (res.ok) {
        ok = true;
        const item = {
          id: envelope.id,
          senderId: deviceId,
          senderName,
          senderOs,
          ts: envelope.ts,
          type,
          content,
          title: sharedTitle,
          direction: 'out',
        };
        await saveMessage(item);

        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of clients) {
          c.postMessage({ type: 'PUSH_RECEIVED', item });
        }
      } else {
        statusMsg = `Failed (${res.status})`;
      }
    }
  } catch {
    statusMsg = 'Send failed';
  }

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="theme-color" content="#14161c" />
<style>
  body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#14161c;color:#f1efe9;font:600 16px/1.4 system-ui,sans-serif}
  .pill{padding:12px 20px;border-radius:999px;background:#1c1f27;border:1px solid ${ok ? '#6fcf8f' : '#f59e0b'}}
</style>
</head>
<body>
  <div class="pill">${ok ? '✓ Pushed' : escapeHtml(statusMsg)}</div>
  <script>
    window.close();
    setTimeout(() => { window.close(); if (history.length > 1) history.back(); }, 250);
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  if (!event.data) return;

  let envelope;
  try {
    envelope = event.data.json();
  } catch {
    return;
  }

  const keyB64 = await kvGet('keyB64');
  if (!keyB64) {
    await self.registration.showNotification('Push It', {
      body: 'Open Push It to pair this device',
      icon: '/icon.svg',
      data: { type: 'app' },
    });
    return;
  }

  let payload;
  try {
    payload = await decryptEnvelope(keyB64, envelope);
  } catch {
    await self.registration.showNotification('Push It', {
      body: 'Re-pair this device to read this message',
      icon: '/icon.svg',
      data: { type: 'app' },
    });
    return;
  }

  const pType =
    payload.type === 'link' || payload.type === 'file' || payload.type === 'longtext'
      ? payload.type
      : 'text';

  const item = {
    id: envelope.id,
    senderId: envelope.senderId,
    senderName: payload.senderName ? String(payload.senderName) : undefined,
    senderOs: payload.senderOs ? String(payload.senderOs) : undefined,
    targetNames: Array.isArray(payload.targetNames)
      ? payload.targetNames.map((n) => String(n))
      : undefined,
    ts: envelope.ts || Date.now(),
    type: pType,
    content: String(payload.content || ''),
    title: payload.title ? String(payload.title) : undefined,
    blobId: payload.blobId ? String(payload.blobId) : undefined,
    blobIv: payload.blobIv ? String(payload.blobIv) : undefined,
    fileName: payload.fileName ? String(payload.fileName) : undefined,
    mimeType: payload.mimeType ? String(payload.mimeType) : undefined,
    fileSize: typeof payload.fileSize === 'number' ? payload.fileSize : undefined,
    direction: 'in',
  };

  await saveMessage(item);
  const prevLastSeen = (await kvGet('lastSeenTs')) || 0;
  if (item.ts > prevLastSeen) {
    await kvSet('lastSeenTs', item.ts);
  }

  // Send delivery receipt back so sender sees ✓✓
  const myDeviceId = await kvGet('deviceId');
  if (myDeviceId) {
    deriveRoomId(keyB64)
      .then((rid) =>
        fetch(`/api/room/${encodeURIComponent(rid)}/ack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceId: myDeviceId, messageId: item.id }),
        }),
      )
      .catch(() => {});
  }

  const windowClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  for (const client of windowClients) {
    client.postMessage({ type: 'PUSH_RECEIVED', item });
  }

  const hasVisibleClient = windowClients.some((c) => c.visibilityState === 'visible');
  if (hasVisibleClient) return;

  const nextUnread = ((await kvGet('unreadCount')) || 0) + 1;
  await kvSet('unreadCount', nextUnread);
  if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
    await self.navigator.setAppBadge(nextUnread).catch(() => {});
  }

  const isLink = item.type === 'link' && isSafeHttpUrl(item.content);
  const isPhoto = item.type === 'file' && item.mimeType && item.mimeType.startsWith('image/');
  const fromPrefix = item.senderName ? `${item.senderName} · ` : '';
  const notifTitle = isLink
    ? `${fromPrefix}${item.title || 'New Link — Tap to Open'}`
    : item.type === 'file'
      ? `${fromPrefix}${isPhoto ? 'New Photo' : 'New File'}`
      : `${fromPrefix}${item.title || 'New Message'}`;

  const notifBody =
    item.type === 'file'
      ? item.fileName || 'Open Push It to view'
      : item.content.slice(0, 180);

  await self.registration.showNotification(notifTitle, {
    body: notifBody,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: item.id,
    data: {
      id: item.id,
      type: isLink ? 'link' : 'text',
      url: isLink ? item.content : `/?msg=${encodeURIComponent(item.id)}`,
    },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    (async () => {
      if (data.type === 'link' && data.url && isSafeHttpUrl(data.url)) {
        await self.clients.openWindow(data.url);
        return;
      }

      const targetUrl = data.url || '/';
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({ type: 'FOCUS_MESSAGE', id: data.id });
          return;
        }
      }

      await self.clients.openWindow(targetUrl);
    })(),
  );
});
