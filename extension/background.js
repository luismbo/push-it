import {
  decryptBytes,
  decryptEnvelope,
  decryptJson,
  defaultDeviceName,
  deriveRoomId,
  detectOs,
  detectPayloadType,
  encryptBytes,
  encryptJson,
  encryptPayload,
  isSafeHttpUrl,
  normalizeOs,
} from './crypto.js';

const KEEPALIVE_ALARM = 'push-it-keepalive';
const MAX_HISTORY = 40;
const LONG_TEXT_THRESHOLD = 1800;
const LOCAL_OS = detectOs();

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectDelay = 3000;
let wsStatus = 'disconnected';
let cachedDevices = [];
const notifUrls = new Map();

async function getConfig() {
  const data = await chrome.storage.local.get([
    'serverUrl',
    'keyB64',
    'deviceId',
    'deviceName',
    'autoOpen',
    'history',
    'lastSeenTs',
    'unreadCount',
  ]);
  let deviceId = data.deviceId;
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId });
  }
  let deviceName = data.deviceName;
  if (!deviceName) {
    deviceName = defaultDeviceName(LOCAL_OS);
    await chrome.storage.local.set({ deviceName });
  }
  return {
    serverUrl: data.serverUrl || '',
    keyB64: data.keyB64 || '',
    deviceId,
    deviceName,
    deviceOs: LOCAL_OS,
    autoOpen: typeof data.autoOpen === 'boolean' ? data.autoOpen : false,
    history: Array.isArray(data.history) ? data.history : [],
    lastSeenTs: typeof data.lastSeenTs === 'number' ? data.lastSeenTs : 0,
    unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0,
  };
}

async function updateBadge(status = wsStatus) {
  const { unreadCount } = await getConfig();
  if (unreadCount > 0) {
    chrome.action.setBadgeText({ text: String(unreadCount > 99 ? '99+' : unreadCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    return;
  }
  if (status === 'connected') {
    chrome.action.setBadgeText({ text: '' });
  } else {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({
      color: status === 'connecting' ? '#f59e0b' : '#64748b',
    });
  }
}

function setStatus(status) {
  wsStatus = status;
  updateBadge(status);
}

async function appendHistory(item) {
  const { history } = await getConfig();
  if (history.some((m) => m.id === item.id)) return false;
  const next = [...history, item].slice(-MAX_HISTORY);
  await chrome.storage.local.set({ history: next });
  return true;
}

async function markDeliveredInHistory(ids) {
  if (!ids?.length) return;
  const set = new Set(ids);
  const { history } = await getConfig();
  let changed = false;
  const next = history.map((m) => {
    if (set.has(m.id) && m.status !== 'delivered') {
      changed = true;
      return { ...m, status: 'delivered' };
    }
    return m;
  });
  if (changed) {
    await chrome.storage.local.set({ history: next });
  }
}

async function setupContextMenus() {
  const { deviceId } = await getConfig();
  const others = cachedDevices.filter((d) => d.deviceId !== deviceId);

  chrome.contextMenus.removeAll(() => {
    const contexts = ['page', 'link', 'selection'];
    if (others.length < 2) {
      chrome.contextMenus.create({
        id: 'push-it-all',
        title: 'Push It',
        contexts,
      });
      return;
    }

    chrome.contextMenus.create({
      id: 'push-it-root',
      title: 'Push It',
      contexts,
    });
    chrome.contextMenus.create({
      id: 'push-it-all',
      parentId: 'push-it-root',
      title: 'All Devices',
      contexts,
    });
    for (const dev of others) {
      chrome.contextMenus.create({
        id: `push-it-dev:${dev.deviceId}`,
        parentId: 'push-it-root',
        title: dev.name,
        contexts,
      });
    }
  });
}

async function registerDeviceRecord(devId, name, os) {
  const { serverUrl, keyB64 } = await getConfig();
  if (!serverUrl || !keyB64 || !devId) return;
  const roomId = await deriveRoomId(keyB64);
  const base = new URL(serverUrl);
  const enc = await encryptJson(keyB64, { name, os });
  await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: devId, iv: enc.iv, ciphertext: enc.ciphertext }),
  }).catch(() => {});
}

async function refreshDevices() {
  const { serverUrl, keyB64, deviceId, deviceName } = await getConfig();
  if (!serverUrl || !keyB64) {
    cachedDevices = [];
    setupContextMenus();
    return [];
  }
  try {
    const roomId = await deriveRoomId(keyB64);
    const base = new URL(serverUrl);
    const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/devices`);
    if (!res.ok) return cachedDevices;
    const data = await res.json();
    const list = [];
    for (const d of data.devices || []) {
      try {
        const meta = await decryptJson(keyB64, d.iv, d.ciphertext);
        const os = normalizeOs(meta.os);
        const name = meta.name ? String(meta.name) : defaultDeviceName(os);
        list.push({
          deviceId: d.deviceId,
          name,
          os,
          online: Boolean(d.online),
          updatedAt: d.updatedAt,
        });
        if (d.deviceId === deviceId && name !== deviceName) {
          await chrome.storage.local.set({ deviceName: name });
        }
      } catch {
        // ignore other-key devices
      }
    }
    cachedDevices = list;
    setupContextMenus();
    return list;
  } catch {
    return cachedDevices;
  }
}

async function hydrateLongTextIfNeeded(item, cfg) {
  if (item.type !== 'longtext' || !item.blobId || !item.blobIv) return item;
  try {
    const roomId = await deriveRoomId(cfg.keyB64);
    const base = new URL(cfg.serverUrl);
    const res = await fetch(
      `${base.origin}/api/room/${encodeURIComponent(roomId)}/blob/${encodeURIComponent(item.blobId)}?deviceId=${encodeURIComponent(cfg.deviceId)}`,
    );
    if (!res.ok) return item;
    const cipher = new Uint8Array(await res.arrayBuffer());
    const plain = await decryptBytes(cfg.keyB64, item.blobIv, cipher);
    return {
      ...item,
      type: 'text',
      content: new TextDecoder().decode(plain),
    };
  } catch {
    return item;
  }
}

async function syncPending() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.keyB64) return;
  try {
    const roomId = await deriveRoomId(cfg.keyB64);
    const base = new URL(cfg.serverUrl);
    const res = await fetch(
      `${base.origin}/api/room/${encodeURIComponent(roomId)}/pending?deviceId=${encodeURIComponent(cfg.deviceId)}&since=${cfg.lastSeenTs}`,
    );
    if (!res.ok) return;
    const data = await res.json();
    if (!data.messages?.length) return;

    let maxTs = cfg.lastSeenTs;
    for (const env of data.messages) {
      try {
        const decrypted = await decryptEnvelope(cfg.keyB64, env);
        let item = {
          id: env.id,
          senderId: env.senderId,
          senderName: decrypted.senderName,
          senderOs: decrypted.senderOs,
          targetNames: decrypted.targetNames,
          ts: env.ts || Date.now(),
          type: decrypted.type,
          content: decrypted.content,
          title: decrypted.title,
          blobId: decrypted.blobId,
          blobIv: decrypted.blobIv,
          fileName: decrypted.fileName,
          mimeType: decrypted.mimeType,
          fileSize: decrypted.fileSize,
          direction: 'in',
        };
        if (item.ts > maxTs) maxTs = item.ts;
        item = await hydrateLongTextIfNeeded(item, cfg);
        const added = await appendHistory(item);
        if (added) {
          await handleIncoming(item, cfg.autoOpen);
        }
      } catch {
        // ignore unreadable
      }
    }

    if (maxTs > cfg.lastSeenTs) {
      await chrome.storage.local.set({ lastSeenTs: maxTs });
    }
  } catch {
    // ignore
  }
}

function stopSocket() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function connect() {
  const { serverUrl, keyB64, deviceId, deviceName, deviceOs } = await getConfig();
  if (!serverUrl || !keyB64) {
    stopSocket();
    setStatus('disconnected');
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    stopSocket();
    setStatus('disconnected');
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  stopSocket();
  setStatus('connecting');

  try {
    const roomId = await deriveRoomId(keyB64);
    const base = new URL(serverUrl);
    const proto = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${base.host}/api/room/${encodeURIComponent(roomId)}/ws?deviceId=${encodeURIComponent(deviceId)}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      reconnectDelay = 3000;
      setStatus('connected');
      await registerDeviceRecord(deviceId, deviceName, deviceOs);
      await refreshDevices();
      await syncPending();
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
          // Firefox suspends idle event pages; an extension API call resets its idle timer.
          chrome.runtime.getPlatformInfo().catch(() => {});
        }
      }, 20000);
    };

    ws.onmessage = async (event) => {
      if (typeof event.data !== 'string' || event.data === 'pong') return;
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'devices_updated') {
          await refreshDevices();
          return;
        }
        if (parsed.type === 'delivered' && Array.isArray(parsed.ids)) {
          await markDeliveredInHistory(parsed.ids);
          return;
        }
        if (parsed.type !== 'message' || !parsed.envelope) return;

        const cfg = await getConfig();
        if (!cfg.keyB64 || parsed.envelope.senderId === cfg.deviceId) return;

        const decrypted = await decryptEnvelope(cfg.keyB64, parsed.envelope);
        let item = {
          id: parsed.envelope.id,
          senderId: parsed.envelope.senderId,
          senderName: decrypted.senderName,
          senderOs: decrypted.senderOs,
          targetNames: decrypted.targetNames,
          ts: parsed.envelope.ts || Date.now(),
          type: decrypted.type,
          content: decrypted.content,
          title: decrypted.title,
          blobId: decrypted.blobId,
          blobIv: decrypted.blobIv,
          fileName: decrypted.fileName,
          mimeType: decrypted.mimeType,
          fileSize: decrypted.fileSize,
          direction: 'in',
        };

        item = await hydrateLongTextIfNeeded(item, cfg);
        const added = await appendHistory(item);
        if (item.ts > cfg.lastSeenTs) {
          await chrome.storage.local.set({ lastSeenTs: item.ts });
        }
        if (added) {
          await handleIncoming(item, cfg.autoOpen);
        }
      } catch {
        // Ignore malformed or wrong-key payloads
      }
    };

    ws.onclose = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      ws = null;
      setStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws?.close();
    };
  } catch {
    setStatus('disconnected');
    scheduleReconnect();
  }
}

async function handleIncoming(item, autoOpen) {
  const isLink = item.type === 'link' && isSafeHttpUrl(item.content);

  if (isLink && autoOpen) {
    await chrome.tabs.create({ url: item.content, active: true });
    return;
  }

  const { unreadCount } = await getConfig();
  await chrome.storage.local.set({ unreadCount: unreadCount + 1 });
  await updateBadge();

  const notifId = `push-it-${item.id}`;
  if (isLink) {
    notifUrls.set(notifId, item.content);
  }

  const fromPrefix = item.senderName ? `${item.senderName} · ` : '';
  const isPhoto = item.type === 'file' && item.mimeType?.startsWith('image/');
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: isLink
      ? `${fromPrefix}${item.title || 'New Link — Click to Open'}`
      : item.type === 'file'
        ? `${fromPrefix}${isPhoto ? 'New Photo' : 'New File'}`
        : `${fromPrefix}${item.title || 'New Message'}`,
    message: item.type === 'file' ? item.fileName || 'Open Push It to download' : item.content.slice(0, 200),
    priority: 2,
  });
}

async function uploadEncryptedBlob(cfg, roomId, plainBytes, targetIds) {
  const blobId = crypto.randomUUID().replace(/-/g, '');
  const { iv: blobIv, ciphertext } = await encryptBytes(cfg.keyB64, plainBytes);
  const base = new URL(cfg.serverUrl);
  const params = new URLSearchParams({ senderId: cfg.deviceId });
  if (targetIds && targetIds.length > 0) params.set('targetIds', targetIds.join(','));

  const res = await fetch(
    `${base.origin}/api/room/${encodeURIComponent(roomId)}/blob/${encodeURIComponent(blobId)}?${params.toString()}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: ciphertext,
    },
  );
  if (!res.ok) throw new Error('File too large (max 8 MB)');
  return { blobId, blobIv };
}

async function sendContent(rawContent, title, targetIds, targetNames) {
  const content = String(rawContent || '').trim();
  const cfg = await getConfig();
  if (!content) throw new Error('Nothing to send');
  if (!cfg.serverUrl || !cfg.keyB64) throw new Error('Pair this device first');

  const roomId = await deriveRoomId(cfg.keyB64);
  const isLong = content.length > LONG_TEXT_THRESHOLD;
  let envelope;

  if (isLong) {
    const plain = new TextEncoder().encode(content);
    const { blobId, blobIv } = await uploadEncryptedBlob(cfg, roomId, plain, targetIds);
    envelope = await encryptPayload(
      cfg.keyB64,
      cfg.deviceId,
      {
        type: 'longtext',
        content: content.slice(0, 140) + '…',
        title,
        senderName: cfg.deviceName,
        senderOs: cfg.deviceOs,
        targetNames: targetNames?.length ? targetNames : undefined,
        blobId,
        blobIv,
        fileSize: plain.byteLength,
      },
      targetIds?.length ? targetIds : undefined,
    );
  } else {
    const type = detectPayloadType(content);
    envelope = await encryptPayload(
      cfg.keyB64,
      cfg.deviceId,
      {
        type,
        content,
        title,
        senderName: cfg.deviceName,
        senderOs: cfg.deviceOs,
        targetNames: targetNames?.length ? targetNames : undefined,
      },
      targetIds?.length ? targetIds : undefined,
    );
  }

  const base = new URL(cfg.serverUrl);
  const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });

  if (!res.ok) throw new Error('Could not send right now');

  const result = await res.json();
  await appendHistory({
    id: envelope.id,
    senderId: cfg.deviceId,
    senderName: cfg.deviceName,
    senderOs: cfg.deviceOs,
    targetNames: targetNames?.length ? targetNames : undefined,
    ts: envelope.ts,
    type: isLong ? 'text' : detectPayloadType(content),
    content,
    title,
    direction: 'out',
    status: result.delivered ? 'delivered' : 'queued',
  });
  return result;
}

async function sendFileBytes(bytesArray, fileName, mimeType, targetIds, targetNames) {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.keyB64) throw new Error('Pair this device first');

  const plainBytes = new Uint8Array(bytesArray);
  const roomId = await deriveRoomId(cfg.keyB64);
  const { blobId, blobIv } = await uploadEncryptedBlob(cfg, roomId, plainBytes, targetIds);

  const envelope = await encryptPayload(
    cfg.keyB64,
    cfg.deviceId,
    {
      type: 'file',
      content: fileName,
      senderName: cfg.deviceName,
      senderOs: cfg.deviceOs,
      targetNames: targetNames?.length ? targetNames : undefined,
      blobId,
      blobIv,
      fileName,
      mimeType,
      fileSize: plainBytes.byteLength,
    },
    targetIds?.length ? targetIds : undefined,
  );

  const base = new URL(cfg.serverUrl);
  const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });

  if (!res.ok) throw new Error('Could not send file');

  const result = await res.json();
  await appendHistory({
    id: envelope.id,
    senderId: cfg.deviceId,
    senderName: cfg.deviceName,
    senderOs: cfg.deviceOs,
    targetNames: targetNames?.length ? targetNames : undefined,
    ts: envelope.ts,
    type: 'file',
    content: fileName,
    blobId,
    blobIv,
    fileName,
    mimeType,
    fileSize: plainBytes.byteLength,
    direction: 'out',
    status: result.delivered ? 'delivered' : 'queued',
  });
  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    connect();
  }
});

chrome.notifications.onClicked.addListener(async (notifId) => {
  chrome.notifications.clear(notifId);
  const url = notifUrls.get(notifId);
  notifUrls.delete(notifId);
  if (url && isSafeHttpUrl(url)) {
    await chrome.tabs.create({ url, active: true });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuId = String(info.menuItemId || '');
  if (menuId !== 'push-it-all' && !menuId.startsWith('push-it-dev:')) return;

  const content = info.linkUrl || info.selectionText || info.pageUrl || tab?.url;
  if (!content) return;

  let targetIds;
  let targetNames;
  if (menuId.startsWith('push-it-dev:')) {
    const devId = menuId.slice('push-it-dev:'.length);
    const dev = cachedDevices.find((d) => d.deviceId === devId);
    if (dev) {
      targetIds = [dev.deviceId];
      targetNames = [dev.name];
    }
  }

  try {
    await sendContent(content, tab?.title, targetIds, targetNames);
  } catch (err) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Push It',
      message: err instanceof Error ? err.message : 'Could not send',
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'GET_STATUS') {
      const cfg = await getConfig();
      const devices = await refreshDevices();
      sendResponse({
        status: wsStatus,
        paired: Boolean(cfg.serverUrl && cfg.keyB64),
        serverUrl: cfg.serverUrl,
        keyB64: cfg.keyB64,
        deviceId: cfg.deviceId,
        deviceName: cfg.deviceName,
        deviceOs: cfg.deviceOs,
        autoOpen: cfg.autoOpen,
        history: cfg.history,
        devices,
      });
      return;
    }

    if (msg.type === 'MARK_READ') {
      await chrome.storage.local.set({ unreadCount: 0 });
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'RENAME_DEVICE') {
      const cfg = await getConfig();
      if (msg.deviceId === cfg.deviceId) {
        await chrome.storage.local.set({ deviceName: msg.name });
      }
      await registerDeviceRecord(msg.deviceId, msg.name, msg.os);
      const devices = await refreshDevices();
      sendResponse({ ok: true, devices });
      return;
    }

    if (msg.type === 'REMOVE_DEVICE') {
      const cfg = await getConfig();
      if (cfg.serverUrl && cfg.keyB64) {
        const roomId = await deriveRoomId(cfg.keyB64);
        const base = new URL(cfg.serverUrl);
        await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/devices`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceId: msg.deviceId }),
        }).catch(() => {});
      }
      const devices = await refreshDevices();
      sendResponse({ ok: true, devices });
      return;
    }

    if (msg.type === 'RECONNECT') {
      stopSocket();
      await connect();
      sendResponse({ ok: true, status: wsStatus });
      return;
    }

    if (msg.type === 'SEND') {
      const res = await sendContent(msg.content, msg.title, msg.targetIds, msg.targetNames);
      sendResponse({ ok: true, result: res });
      return;
    }

    if (msg.type === 'SEND_FILE') {
      const res = await sendFileBytes(
        msg.bytes,
        msg.fileName,
        msg.mimeType,
        msg.targetIds,
        msg.targetNames,
      );
      sendResponse({ ok: true, result: res });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message' });
  })().catch((err) => {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

self.addEventListener('online', () => {
  reconnectDelay = 3000;
  connect();
});

self.addEventListener('offline', () => {
  stopSocket();
  setStatus('disconnected');
});

connect();
