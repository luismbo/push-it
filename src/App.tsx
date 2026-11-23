import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import QRCode from 'qrcode';
import { OsIcon } from './components/OsIcon';
import {
  decryptBytes,
  decryptEnvelope,
  decryptJson,
  deriveRoomId,
  detectPayloadType,
  encryptBytes,
  encryptJson,
  encryptOp,
  encryptPayload,
  formatFileSize,
  generateRawKeyB64,
  isSafeHttpUrl,
  isValidKeyB64,
  type DeviceMeta,
  type EncryptedEnvelope,
} from './lib/crypto';
import {
  applyMessageOp,
  clearMessages,
  getBlob,
  kvGet,
  kvSet,
  listMessages,
  markMessagesDelivered,
  reconcileIncoming,
  saveBlob,
  saveMessage,
  trimFeed,
  type StoredMessage,
} from './lib/db';
import { chunkIds, parseOp, type MessageOp, type MessageOpKind } from './lib/ops';
import { defaultDeviceName, detectOs, normalizeOs, type DeviceOs } from './lib/device';
import {
  getCurrentPushSubscription,
  isPushSupported,
  registerServiceWorker,
  subscribePush,
  unsubscribePush,
} from './lib/push';

interface PairedDevice {
  deviceId: string;
  name: string;
  os: DeviceOs;
  online: boolean;
  updatedAt: number;
}

const MAX_FILE_BYTES = 7.5 * 1024 * 1024;
const LONG_TEXT_THRESHOLD = 1800;
const UNDO_MS = 5000;
const SWIPE_ARCHIVE_PX = 90;

function ArchiveIcon() {
  return (
    <svg viewBox="0 0 24 24" class="msg-icon" aria-hidden="true">
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" class="msg-icon" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 24 24" class="msg-icon" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
    </svg>
  );
}

export default function App() {
  const localOs: DeviceOs = detectOs();
  const isMobile = localOs === 'android' || localOs === 'ios';
  const isFirefox = /Firefox\//.test(navigator.userAgent);

  // The full composer hint wraps onto a clipped second line on phone-width screens.
  const narrowQuery = window.matchMedia('(max-width: 480px)');
  const [narrowComposer, setNarrowComposer] = createSignal(narrowQuery.matches);
  const onNarrowChange = (e: MediaQueryListEvent) => setNarrowComposer(e.matches);
  narrowQuery.addEventListener('change', onNarrowChange);
  onCleanup(() => narrowQuery.removeEventListener('change', onNarrowChange));

  const [view, setView] = createSignal<'chat' | 'settings'>('chat');
  const [showAddDevice, setShowAddDevice] = createSignal<boolean>(false);
  const [keyB64, setKeyB64] = createSignal<string>('');
  const [roomId, setRoomId] = createSignal<string>('');
  const [deviceId, setDeviceId] = createSignal<string>('');
  const [deviceName, setDeviceName] = createSignal<string>(defaultDeviceName(localOs));

  const [devices, setDevices] = createSignal<PairedDevice[]>([]);
  const [selectedTargets, setSelectedTargets] = createSignal<string[]>([]);
  const [editingDeviceId, setEditingDeviceId] = createSignal<string | null>(null);
  const [editDeviceDraft, setEditDeviceDraft] = createSignal<string>('');

  const [messages, setMessages] = createSignal<StoredMessage[]>([]);
  const [blobUrls, setBlobUrls] = createSignal<Record<string, string>>({});
  const [draft, setDraft] = createSignal<string>('');
  const [sending, setSending] = createSignal(false);
  const [wsStatus, setWsStatus] = createSignal<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [autoOpen, setAutoOpen] = createSignal<boolean>(false);
  const [pushEnabled, setPushEnabled] = createSignal<boolean>(false);
  const [pushBusy, setPushBusy] = createSignal<boolean>(false);
  const [qrDataUrl, setQrDataUrl] = createSignal<string>('');
  const [importInput, setImportInput] = createSignal<string>('');
  const [privateServer, setPrivateServer] = createSignal<{ repoUrl: string } | null>(null);
  const [toast, setToast] = createSignal<string>('');
  const [popupWarning, setPopupWarning] = createSignal<string>('');
  const [unreadCount, setUnreadCount] = createSignal<number>(0);
  const [serverVersion, setServerVersion] = createSignal<string | null>(null);
  const [feedTab, setFeedTab] = createSignal<'feed' | 'archived'>('feed');
  const [selecting, setSelecting] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<string[]>([]);
  const [confirmDeleteAll, setConfirmDeleteAll] = createSignal(false);
  // Messages deleted locally but still within their undo window.
  const [hiddenIds, setHiddenIds] = createSignal<string[]>([]);
  const [undoToast, setUndoToast] = createSignal<{ text: string; undo: () => void } | null>(null);
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';

  let chatEndEl: HTMLDivElement | undefined;
  let fileInputEl: HTMLInputElement | undefined;
  let toastTimer: number | undefined;
  let undoTimer: number | undefined;
  let pendingDelete: { ids: string[]; timer: number } | null = null;
  let flushingOps = false;

  function notify(msg: string) {
    setToast(msg);
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(''), 2800);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatEndEl?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  const otherDevices = createMemo(() =>
    devices().filter((d) => d.deviceId !== deviceId()),
  );

  const visibleMessages = createMemo(() => {
    const hidden = new Set(hiddenIds());
    return messages().filter((m) => !hidden.has(m.id));
  });
  const feedMessages = createMemo(() => visibleMessages().filter((m) => !m.archivedAt));
  const archivedMessages = createMemo(() =>
    visibleMessages()
      .filter((m) => m.archivedAt)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
  );
  const shownMessages = createMemo(() =>
    feedTab() === 'archived' ? archivedMessages() : feedMessages(),
  );

  const pairUrl = createMemo(() => {
    const k = keyB64();
    if (!k) return '';
    return `${window.location.origin}/#key=${encodeURIComponent(k)}`;
  });

  const statusLabel = createMemo(() => {
    if (privateServer()) return 'Private server';
    if (wsStatus() === 'connected') return 'Connected';
    if (wsStatus() === 'connecting') return 'Connecting...';
    return 'Offline';
  });

  // The server may restrict which rooms it serves (ALLOWED_ROOM_IDS). Returns false if
  // this room is refused, in which case the "private server" page is shown instead.
  async function checkRoomAccess(rid: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/status`, { cache: 'no-store' });
      if (res.status === 403) {
        const data = (await res.json().catch(() => null)) as { error?: string; repoUrl?: string } | null;
        if (data?.error === 'private_server') {
          setPrivateServer({ repoUrl: data.repoUrl || 'https://github.com/luismbo/push-it' });
          return false;
        }
      }
    } catch {
      // Offline or unreachable: carry on and let the normal reconnect logic handle it.
    }
    setPrivateServer(null);
    return true;
  }

  async function updateBadge(count: number) {
    setUnreadCount(count);
    document.title = count > 0 ? `(${count}) Push It` : 'Push It';
    await kvSet('unreadCount', count);
    const nav = navigator as Navigator & {
      setAppBadge?: (n: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (count > 0) {
      await nav.setAppBadge?.(count).catch(() => {});
    } else {
      await nav.clearAppBadge?.().catch(() => {});
    }
  }

  async function ensureBlobHydrated(
    item: StoredMessage,
    rid = roomId(),
    k = keyB64(),
    myId = deviceId(),
  ): Promise<StoredMessage> {
    if (!item.blobId || !item.blobIv || !rid || !k) return item;

    let cached = await getBlob(item.blobId);
    if (!cached) {
      try {
        const res = await fetch(
          `/api/room/${encodeURIComponent(rid)}/blob/${encodeURIComponent(item.blobId)}?deviceId=${encodeURIComponent(myId)}`,
        );
        if (!res.ok) return item;
        const cipherBuf = await res.arrayBuffer();
        const plainBytes = await decryptBytes(k, item.blobIv, new Uint8Array(cipherBuf));
        const copyBuf = new ArrayBuffer(plainBytes.byteLength);
        new Uint8Array(copyBuf).set(plainBytes);
        cached = {
          id: item.blobId,
          data: copyBuf,
          mimeType: item.mimeType || 'application/octet-stream',
          fileName: item.fileName || 'file',
        };
        await saveBlob(cached);
      } catch {
        return item;
      }
    }

    if (item.type === 'longtext') {
      const fullText = new TextDecoder().decode(new Uint8Array(cached.data));
      const updated: StoredMessage = { ...item, type: 'text', content: fullText };
      await saveMessage(updated);
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      return updated;
    }

    if (item.type === 'file' && !blobUrls()[item.blobId]) {
      const url = URL.createObjectURL(new Blob([cached.data], { type: cached.mimeType }));
      setBlobUrls((prev) => ({ ...prev, [item.blobId!]: url }));
    }

    return item;
  }

  async function hydrateExistingBlobs(list: StoredMessage[], rid: string, k: string, myId: string) {
    for (const m of list) {
      if (m.blobId && m.blobIv) {
        await ensureBlobHydrated(m, rid, k, myId);
      }
    }
  }

  async function registerDeviceRecord(
    rid: string,
    k: string,
    devId: string,
    name: string,
    os: DeviceOs,
  ) {
    if (!rid || !k || !devId) return;
    const enc = await encryptJson(k, { name, os } satisfies DeviceMeta);
    await fetch(`/api/room/${encodeURIComponent(rid)}/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: devId, iv: enc.iv, ciphertext: enc.ciphertext }),
    }).catch(() => {});
  }

  async function refreshDevices(rid = roomId(), k = keyB64(), myId = deviceId()) {
    if (!rid || !k) return;
    try {
      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/devices`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        devices: Array<{
          deviceId: string;
          iv: string;
          ciphertext: string;
          updatedAt: number;
          online: boolean;
        }>;
      };

      const decrypted: PairedDevice[] = [];
      for (const d of data.devices) {
        try {
          const meta = await decryptJson<Partial<DeviceMeta>>(k, d.iv, d.ciphertext);
          const os = normalizeOs(meta.os);
          const name = meta.name ? String(meta.name) : defaultDeviceName(os);
          decrypted.push({
            deviceId: d.deviceId,
            name,
            os,
            online: d.online,
            updatedAt: d.updatedAt,
          });
          if (d.deviceId === myId && name !== deviceName()) {
            setDeviceName(name);
            await kvSet('deviceName', name);
          }
        } catch {
          // Ignore devices with another key
        }
      }

      setDevices(decrypted);
      const validIds = new Set(decrypted.map((d) => d.deviceId));
      setSelectedTargets((prev) => prev.filter((id) => validIds.has(id) && id !== myId));
    } catch {
      // ignore
    }
  }

  async function syncPending(rid = roomId(), k = keyB64(), myId = deviceId()) {
    if (!rid || !k || !myId) return;
    try {
      const since = (await kvGet<number>('lastSeenTs')) || 0;
      const res = await fetch(
        `/api/room/${encodeURIComponent(rid)}/pending?deviceId=${encodeURIComponent(myId)}&since=${since}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: EncryptedEnvelope[]; ops?: EncryptedEnvelope[] };
      if (!data.messages?.length && !data.ops?.length) return;

      let maxTs = since;
      for (const env of data.messages ?? []) {
        try {
          const decrypted = await decryptEnvelope(k, env);
          let item: StoredMessage = {
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
          const kept = await reconcileIncoming(item);
          if (!kept) continue;
          item = kept;
          const existed = messages().some((m) => m.id === item.id);
          await saveMessage(item);
          addOrUpdateMessage(item);
          item = await ensureBlobHydrated(item, rid, k, myId);
          if (!existed && !item.archivedAt) {
            handleIncomingAction(item);
          }
        } catch {
          // ignore
        }
      }

      for (const env of data.ops ?? []) {
        await receiveOp(k, env);
      }

      if (maxTs > since) {
        await kvSet('lastSeenTs', maxTs);
      }
    } catch {
      // ignore
    }
  }

  // 1. Bootstrap key, device identity, preferences, SW, and URL hash/share target
  createEffect(
    () => true,
    () => {
      let cancelled = false;

      const onSwMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; item?: StoredMessage } | undefined;
        if (data?.type === 'PUSH_RECEIVED' && data.item) {
          addOrUpdateMessage(data.item);
          ensureBlobHydrated(data.item);
        }
      };

      const onVisibility = () => {
        if (document.visibilityState === 'visible') {
          updateBadge(0);
          syncPending();
        }
      };

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', onSwMessage);
      }
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', commitPendingDelete);

      (async () => {
        await registerServiceWorker().catch(() => {});

        let devId = await kvGet<string>('deviceId');
        if (!devId) {
          devId = crypto.randomUUID();
          await kvSet('deviceId', devId);
        }

        let devName = await kvGet<string>('deviceName');
        if (!devName) {
          devName = defaultDeviceName(localOs);
          await kvSet('deviceName', devName);
        }
        await kvSet('deviceOs', localOs);

        const savedAutoOpen = await kvGet<boolean>('autoOpen');
        if (typeof savedAutoOpen === 'boolean') {
          setAutoOpen(savedAutoOpen);
        }

        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const hashKey = hashParams.get('key');
        let activeKey = await kvGet<string>('keyB64');

        if (hashKey && isValidKeyB64(hashKey)) {
          activeKey = hashKey.trim();
          await kvSet('keyB64', activeKey);
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          notify('Devices paired!');
        } else if (!activeKey) {
          activeKey = generateRawKeyB64();
          await kvSet('keyB64', activeKey);
        }

        const rid = await deriveRoomId(activeKey);
        const existingMsgs = await listMessages();
        const currentSub = await getCurrentPushSubscription().catch(() => null);

        if (cancelled) return;

        setDeviceId(devId);
        setDeviceName(devName);
        setKeyB64(activeKey);
        setRoomId(rid);
        setMessages(existingMsgs);
        setPushEnabled(Boolean(currentSub));
        await updateBadge(0);
        scrollToBottom();

        if (!(await checkRoomAccess(rid))) return;

        await registerDeviceRecord(rid, activeKey, devId, devName, localOs);
        await refreshDevices(rid, activeKey, devId);
        await hydrateExistingBlobs(existingMsgs, rid, activeKey, devId);
        await syncPending(rid, activeKey, devId);

        if (
          window.location.pathname === '/share' ||
          window.location.search.includes('url=') ||
          window.location.search.includes('text=')
        ) {
          const sp = new URLSearchParams(window.location.search);
          const sharedUrl = sp.get('url')?.trim() || '';
          const sharedText = sp.get('text')?.trim() || '';
          const sharedTitle = sp.get('title')?.trim() || undefined;
          const payloadText = sharedUrl || sharedText;

          window.history.replaceState(null, '', '/');

          if (payloadText) {
            await sendText(payloadText, sharedTitle, activeKey, rid, devId, devName);
            window.close();
          }
        }
      })();

      return () => {
        cancelled = true;
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.removeEventListener('message', onSwMessage);
        }
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', commitPendingDelete);
      };
    },
  );

  // 2. Generate QR code & check server version when Settings is open
  createEffect(
    () => [view(), showAddDevice(), pairUrl()] as const,
    ([activeView, adding, url]) => {
      if (activeView === 'settings') {
        fetch('/api/version', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { version?: string } | null) => {
            if (d?.version) setServerVersion(d.version);
          })
          .catch(() => {});
      }
      if (activeView !== 'settings' || !adding || !url) return;
      QRCode.toDataURL(url, {
        width: 220,
        margin: 2,
        color: { dark: '#14161c', light: '#ffffff' },
      })
        .then(setQrDataUrl)
        .catch(() => {});
    },
  );

  // 3. Live connection
  createEffect(
    () => [roomId(), deviceId(), keyB64(), privateServer()] as const,
    ([rid, did, k, blocked]) => {
      if (!rid || !did || !k || blocked) return;

      let ws: WebSocket | null = null;
      let reconnectTimer: number | undefined;
      let pingTimer: number | undefined;
      let closed = false;

      const connect = () => {
        if (closed) return;
        setWsStatus('connecting');
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/room/${encodeURIComponent(rid)}/ws?deviceId=${encodeURIComponent(did)}`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setWsStatus('connected');
          refreshDevices(rid, k, did);
          syncPending(rid, k, did);
          flushOpOutbox(rid);
          pingTimer = window.setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping');
          }, 25000);
        };

        ws.onmessage = async (event) => {
          if (typeof event.data !== 'string' || event.data === 'pong') return;
          try {
            const parsed = JSON.parse(event.data) as {
              type?: string;
              ids?: string[];
              envelope?: EncryptedEnvelope;
            };
            if (parsed.type === 'devices_updated') {
              await refreshDevices(rid, k, did);
              return;
            }
            if (parsed.type === 'delivered' && Array.isArray(parsed.ids)) {
              const deliveredSet = new Set(parsed.ids);
              setMessages((prev) =>
                prev.map((m) => (deliveredSet.has(m.id) ? { ...m, status: 'delivered' } : m)),
              );
              await markMessagesDelivered(parsed.ids);
              return;
            }
            if (parsed.type === 'op' && parsed.envelope) {
              if (parsed.envelope.senderId !== did) await receiveOp(k, parsed.envelope);
              return;
            }
            if (parsed.type !== 'message' || !parsed.envelope) return;
            if (parsed.envelope.senderId === did) return;

            const decrypted = await decryptEnvelope(k, parsed.envelope);
            let item: StoredMessage = {
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

            await kvSet('lastSeenTs', item.ts);
            const kept = await reconcileIncoming(item);
            if (!kept) return;
            item = kept;
            await saveMessage(item);
            addOrUpdateMessage(item);
            item = await ensureBlobHydrated(item, rid, k, did);
            if (item.archivedAt) return;

            if (document.visibilityState !== 'visible') {
              await updateBadge(unreadCount() + 1);
            }

            handleIncomingAction(item);
          } catch {
            // Ignore unreadable messages
          }
        };

        ws.onclose = () => {
          if (pingTimer) window.clearInterval(pingTimer);
          setWsStatus('disconnected');
          if (!closed) {
            reconnectTimer = window.setTimeout(connect, 2500);
          }
        };

        ws.onerror = () => {
          ws?.close();
        };
      };

      connect();

      return () => {
        closed = true;
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        if (pingTimer) window.clearInterval(pingTimer);
        ws?.close();
      };
    },
  );

  function addOrUpdateMessage(item: StoredMessage) {
    setMessages((prev) => {
      if (prev.some((m) => m.id === item.id)) return prev;
      return trimFeed([...prev, item]);
    });
    if (!item.archivedAt) scrollToBottom();
  }

  // ---- Archive / delete, synced to the other devices through /op ----

  async function applyOpLocally(op: MessageOp) {
    const changed = new Set(await applyMessageOp(op));
    if (!changed.size) return;
    if (op.op === 'delete') {
      const urls = blobUrls();
      for (const m of messages()) {
        if (changed.has(m.id) && m.blobId && urls[m.blobId]) URL.revokeObjectURL(urls[m.blobId]);
      }
      setMessages((prev) => prev.filter((m) => !changed.has(m.id)));
    } else {
      setMessages((prev) =>
        prev.map((m) => {
          if (!changed.has(m.id)) return m;
          if (op.op === 'archive') return { ...m, archivedAt: op.at };
          const { archivedAt: _drop, ...rest } = m;
          return rest;
        }),
      );
    }
    setSelectedIds((prev) => prev.filter((id) => !changed.has(id)));
  }

  async function receiveOp(k: string, env: EncryptedEnvelope) {
    try {
      const op = parseOp(await decryptJson(k, env.iv, env.ciphertext));
      if (op) await applyOpLocally(op);
    } catch {
      // Ignore ops encrypted with another key
    }
  }

  async function performOp(kind: MessageOpKind, ids: string[]) {
    if (!ids.length) return;
    const at = Date.now();
    await applyOpLocally({ op: kind, ids, at });
    const k = keyB64();
    const did = deviceId();
    if (!k || !did) return;
    const envs = await Promise.all(
      chunkIds(ids).map((chunk) => encryptOp(k, did, { op: kind, ids: chunk, at })),
    );
    const outbox = (await kvGet<EncryptedEnvelope[]>('opOutbox')) || [];
    await kvSet('opOutbox', [...outbox, ...envs]);
    await flushOpOutbox();
  }

  /** Sends queued ops in order; whatever can't be sent now waits for the next reconnect. */
  async function flushOpOutbox(rid = roomId()) {
    if (flushingOps || !rid) return;
    flushingOps = true;
    try {
      for (;;) {
        const next = ((await kvGet<EncryptedEnvelope[]>('opOutbox')) || [])[0];
        if (!next) break;
        const res = await fetch(`/api/room/${encodeURIComponent(rid)}/op`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
          keepalive: true,
        }).catch(() => null);
        // Offline or a server hiccup: keep it for later. Other errors would never succeed.
        if (!res || res.status >= 500 || res.status === 429) break;
        const current = (await kvGet<EncryptedEnvelope[]>('opOutbox')) || [];
        await kvSet('opOutbox', current.filter((e) => e.id !== next.id));
      }
    } finally {
      flushingOps = false;
    }
  }

  function showUndo(text: string, undo: () => void) {
    // A new toast takes away the previous one's Undo, so a pending delete happens now.
    commitPendingDelete();
    setUndoToast({ text, undo });
    if (undoTimer) window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(() => setUndoToast(null), UNDO_MS);
  }

  function runUndo() {
    const t = undoToast();
    if (undoTimer) window.clearTimeout(undoTimer);
    setUndoToast(null);
    t?.undo();
  }

  const countLabel = (n: number) => (n === 1 ? '' : ` ${n} messages`);

  function archiveIds(ids: string[]) {
    if (!ids.length) return;
    performOp('archive', ids);
    showUndo(`Archived${countLabel(ids.length)}`, () => performOp('unarchive', ids));
  }

  function restoreIds(ids: string[]) {
    if (!ids.length) return;
    performOp('unarchive', ids);
    showUndo(`Restored${countLabel(ids.length)} to the feed`, () => performOp('archive', ids));
  }

  function deleteIds(ids: string[]) {
    if (!ids.length) return;
    showUndo(`Deleted${countLabel(ids.length)}`, () => {
      if (pendingDelete?.ids !== ids) return;
      window.clearTimeout(pendingDelete.timer);
      pendingDelete = null;
      setHiddenIds((prev) => prev.filter((id) => !ids.includes(id)));
    });
    setHiddenIds((prev) => [...prev, ...ids]);
    pendingDelete = { ids, timer: window.setTimeout(commitPendingDelete, UNDO_MS) };
  }

  function commitPendingDelete() {
    if (!pendingDelete) return;
    const { ids, timer } = pendingDelete;
    pendingDelete = null;
    window.clearTimeout(timer);
    performOp('delete', ids).finally(() =>
      setHiddenIds((prev) => prev.filter((id) => !ids.includes(id))),
    );
  }

  function switchFeedTab(tab: 'feed' | 'archived') {
    setFeedTab(tab);
    setSelecting(false);
    setSelectedIds([]);
    setConfirmDeleteAll(false);
    if (tab === 'feed') scrollToBottom();
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function runBulk(action: 'archive' | 'restore' | 'delete') {
    const ids = selectedIds();
    setSelecting(false);
    setSelectedIds([]);
    if (action === 'archive') archiveIds(ids);
    else if (action === 'restore') restoreIds(ids);
    else deleteIds(ids);
  }

  function handleIncomingAction(item: StoredMessage) {
    const from = item.senderName || 'Other device';
    if (item.type === 'link' && isSafeHttpUrl(item.content)) {
      if (autoOpen()) {
        const win = window.open(item.content, '_blank', 'noopener,noreferrer');
        if (!win) {
          setPopupWarning('Allow pop-ups for this site to open incoming links automatically.');
          notify(`Link from ${from}`);
        } else {
          setPopupWarning('');
          notify(`Opened link from ${from}`);
        }
      } else {
        notify(`Link from ${from}`);
      }
    } else if (item.type === 'file') {
      notify(`File from ${from}`);
    } else {
      notify(`Message from ${from}`);
    }
  }

  function toggleTarget(id: string) {
    setSelectedTargets((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function getTargetInfo() {
    const chosenIds = selectedTargets();
    const chosenNames =
      chosenIds.length > 0
        ? otherDevices()
            .filter((d) => chosenIds.includes(d.deviceId))
            .map((d) => d.name)
        : undefined;
    return {
      targetIds: chosenIds.length > 0 ? chosenIds : undefined,
      targetNames: chosenNames,
    };
  }

  async function uploadEncryptedBlob(
    rid: string,
    k: string,
    did: string,
    plainBytes: Uint8Array<ArrayBuffer>,
    targetIds?: string[],
  ): Promise<{ blobId: string; blobIv: string }> {
    const blobId = crypto.randomUUID().replace(/-/g, '');
    const { iv: blobIv, ciphertext } = await encryptBytes(k, plainBytes);
    const params = new URLSearchParams({ senderId: did });
    if (targetIds && targetIds.length > 0) params.set('targetIds', targetIds.join(','));

    const res = await fetch(
      `/api/room/${encodeURIComponent(rid)}/blob/${encodeURIComponent(blobId)}?${params.toString()}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: ciphertext,
      },
    );

    if (!res.ok) {
      throw new Error('File too large (max 8 MB)');
    }
    return { blobId, blobIv };
  }

  async function sendText(
    rawText: string,
    title?: string,
    overrideKey?: string,
    overrideRoom?: string,
    overrideDev?: string,
    overrideName?: string,
  ) {
    const content = rawText.trim();
    const k = overrideKey || keyB64();
    const rid = overrideRoom || roomId();
    const did = overrideDev || deviceId();
    const dName = overrideName || deviceName();
    if (!content || !k || !rid || !did) return;

    const { targetIds, targetNames } = getTargetInfo();
    setSending(true);
    try {
      const isLong = content.length > LONG_TEXT_THRESHOLD;
      let envelope: EncryptedEnvelope;

      if (isLong) {
        const encoded = new TextEncoder().encode(content);
        const buf = new ArrayBuffer(encoded.byteLength);
        new Uint8Array(buf).set(encoded);
        const { blobId, blobIv } = await uploadEncryptedBlob(
          rid,
          k,
          did,
          new Uint8Array(buf),
          targetIds,
        );
        envelope = await encryptPayload(
          k,
          did,
          {
            type: 'longtext',
            content: content.slice(0, 140) + '…',
            title,
            senderName: dName,
            senderOs: localOs,
            targetNames,
            blobId,
            blobIv,
            fileSize: buf.byteLength,
          },
          targetIds,
        );
      } else {
        const type = detectPayloadType(content);
        envelope = await encryptPayload(
          k,
          did,
          {
            type,
            content,
            title,
            senderName: dName,
            senderOs: localOs,
            targetNames,
          },
          targetIds,
        );
      }

      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });

      if (!res.ok) {
        throw new Error('Could not send right now');
      }

      const result = (await res.json()) as { delivered?: boolean };
      const item: StoredMessage = {
        id: envelope.id,
        senderId: did,
        senderName: dName,
        senderOs: localOs,
        targetNames,
        ts: envelope.ts,
        type: isLong ? 'text' : detectPayloadType(content),
        content,
        title,
        direction: 'out',
        status: result.delivered ? 'delivered' : 'queued',
      };

      await saveMessage(item);
      addOrUpdateMessage(item);
      setDraft('');
      notify('Pushed!');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setSending(false);
    }
  }

  async function sendFile(file: File) {
    const k = keyB64();
    const rid = roomId();
    const did = deviceId();
    const dName = deviceName();
    if (!k || !rid || !did) return;

    if (file.size > MAX_FILE_BYTES) {
      notify('File is too large (max 7.5 MB)');
      return;
    }

    const { targetIds, targetNames } = getTargetInfo();
    setSending(true);
    try {
      const fileBuf = await file.arrayBuffer();
      const { blobId, blobIv } = await uploadEncryptedBlob(
        rid,
        k,
        did,
        new Uint8Array(fileBuf),
        targetIds,
      );

      const mimeType = file.type || 'application/octet-stream';
      const fileName = file.name || (mimeType.startsWith('image/') ? 'photo.png' : 'file');

      const envelope = await encryptPayload(
        k,
        did,
        {
          type: 'file',
          content: fileName,
          senderName: dName,
          senderOs: localOs,
          targetNames,
          blobId,
          blobIv,
          fileName,
          mimeType,
          fileSize: file.size,
        },
        targetIds,
      );

      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });

      if (!res.ok) {
        throw new Error('Could not send file');
      }

      const result = (await res.json()) as { delivered?: boolean };
      await saveBlob({ id: blobId, data: fileBuf, mimeType, fileName });
      const localUrl = URL.createObjectURL(new Blob([fileBuf], { type: mimeType }));
      setBlobUrls((prev) => ({ ...prev, [blobId]: localUrl }));

      const item: StoredMessage = {
        id: envelope.id,
        senderId: did,
        senderName: dName,
        senderOs: localOs,
        targetNames,
        ts: envelope.ts,
        type: 'file',
        content: fileName,
        blobId,
        blobIv,
        fileName,
        mimeType,
        fileSize: file.size,
        direction: 'out',
        status: result.delivered ? 'delivered' : 'queued',
      };

      await saveMessage(item);
      addOrUpdateMessage(item);
      notify('Pushed!');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not send file');
    } finally {
      setSending(false);
    }
  }

  async function saveEditedDevice(dev: PairedDevice) {
    const nextName = editDeviceDraft().trim() || defaultDeviceName(dev.os);
    setEditingDeviceId(null);
    if (dev.deviceId === deviceId()) {
      setDeviceName(nextName);
      await kvSet('deviceName', nextName);
    }
    await registerDeviceRecord(roomId(), keyB64(), dev.deviceId, nextName, dev.os);
    await refreshDevices();
    notify(`Renamed to "${nextName}"`);
  }

  async function removeDevice(dev: PairedDevice) {
    await fetch(`/api/room/${encodeURIComponent(roomId())}/devices`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: dev.deviceId }),
    }).catch(() => {});
    await refreshDevices();
    notify(`Removed "${dev.name}"`);
  }

  async function handleToggleAutoOpen() {
    const next = !autoOpen();
    setAutoOpen(next);
    setPopupWarning('');
    await kvSet('autoOpen', next);
  }

  async function handleTogglePush() {
    const rid = roomId();
    const did = deviceId();
    if (!rid || !did) return;

    setPushBusy(true);
    try {
      if (pushEnabled()) {
        await unsubscribePush(rid, did);
        setPushEnabled(false);
        notify('Notifications turned off');
      } else {
        await subscribePush(rid, did);
        setPushEnabled(true);
        notify('Notifications turned on');
      }
    } catch {
      notify('Notifications are not supported in this browser');
    } finally {
      setPushBusy(false);
    }
  }

  async function handleImportKey() {
    let raw = importInput().trim();
    if (!raw) return;
    if (raw.includes('#key=')) {
      raw = decodeURIComponent(raw.split('#key=')[1].split('&')[0]);
    }
    if (!isValidKeyB64(raw)) {
      notify('That pair link is not valid');
      return;
    }
    await kvSet('keyB64', raw);
    const rid = await deriveRoomId(raw);
    setKeyB64(raw);
    setRoomId(rid);
    setImportInput('');
    if (!(await checkRoomAccess(rid))) return;
    await registerDeviceRecord(rid, raw, deviceId(), deviceName(), localOs);
    await refreshDevices(rid, raw, deviceId());
    notify('Devices paired!');
  }

  async function handleRotateKey() {
    const fresh = generateRawKeyB64();
    await kvSet('keyB64', fresh);
    const rid = await deriveRoomId(fresh);
    setKeyB64(fresh);
    setRoomId(rid);
    if (!(await checkRoomAccess(rid))) {
      notify('This server only allows approved rooms');
      return;
    }
    await registerDeviceRecord(rid, fresh, deviceId(), deviceName(), localOs);
    await refreshDevices(rid, fresh, deviceId());
    notify('Created a new pairing code');
  }

  async function copyToClipboard(text: string, label = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      notify(label);
    } catch {
      notify('Could not copy');
    }
  }

  return (
    <div
      class="app-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file) sendFile(file);
      }}
    >
      <header class="topbar">
        <div class="brand">
          <img src="/icon.svg" alt="" class="logo" />
          <div>
            <h1>Push It</h1>
            <div class="status-row">
              <span class={`dot ${wsStatus()}`} />
              <span>{statusLabel()}</span>
            </div>
          </div>
        </div>

        <div class="topbar-actions">
          <Show
            when={view() === 'chat'}
            fallback={
              <button
                class="btn secondary small"
                onClick={() => {
                  setView('chat');
                  scrollToBottom();
                }}
              >
                ← Back
              </button>
            }
          >
            <button
              class="device-pill"
              title="Manage devices"
              onClick={() => setView('settings')}
            >
              <OsIcon os={localOs} size={14} />
              <span>{deviceName()}</span>
            </button>
            <button
              class="btn secondary small"
              aria-label="Settings"
              onClick={() => setView('settings')}
            >
              Settings
            </button>
          </Show>
        </div>
      </header>

      <Show when={toast()}>
        <div class="toast">{toast()}</div>
      </Show>

      <Show when={popupWarning() && view() === 'chat'}>
        <div class="banner warning">{popupWarning()}</div>
      </Show>

      <Show
        when={!privateServer()}
        fallback={
          <main class="settings-page private-server">
            <section class="card">
              <h2>🔒 This Push It server is private</h2>
              <p class="muted">
                It only works for devices its owner has approved. Push It is free and open source, so
                you can run your own copy on Cloudflare's free tier in a few minutes.
              </p>
              <a class="btn primary" href={privateServer()?.repoUrl} target="_blank" rel="noopener">
                Get Push It on GitHub →
              </a>
            </section>
            <section class="card">
              <strong>Got a pair link from the owner?</strong>
              <div class="import-row">
                <input
                  type="text"
                  placeholder="Paste pair link..."
                  value={importInput()}
                  onInput={(e) => setImportInput(e.currentTarget.value)}
                />
                <button class="btn secondary" onClick={handleImportKey}>
                  Pair
                </button>
              </div>
            </section>
            <section class="card">
              <span class="muted">
                Own this server? Add this room ID to <code>ALLOWED_ROOM_IDS</code>:
              </span>
              <code class="room-id">{roomId()}</code>
            </section>
          </main>
        }
      >
      <Show
        when={view() === 'chat'}
        fallback={
          <main class="settings-page">
            <section class="card">
              <div class="row between">
                <h2>Devices ({devices().length})</h2>
                <button
                  class="btn primary small"
                  onClick={() => setShowAddDevice((v) => !v)}
                >
                  {showAddDevice() ? 'Hide Pair' : '+ Add Device'}
                </button>
              </div>

              <div class="device-list">
                <For each={devices()}>
                  {(dev) => {
                    const isSelf = dev.deviceId === deviceId();
                    return (
                      <div class="device-row">
                        <Show
                          when={editingDeviceId() !== dev.deviceId}
                          fallback={
                            <form
                              class="import-row full-width"
                              onSubmit={(e) => {
                                e.preventDefault();
                                saveEditedDevice(dev);
                              }}
                            >
                              <input
                                type="text"
                                maxlength={24}
                                value={editDeviceDraft()}
                                onInput={(e) => setEditDeviceDraft(e.currentTarget.value)}
                                autofocus
                              />
                              <button class="btn primary small" type="submit">
                                Save
                              </button>
                              <button
                                class="btn secondary small"
                                type="button"
                                onClick={() => setEditingDeviceId(null)}
                              >
                                Cancel
                              </button>
                            </form>
                          }
                        >
                          <div class="device-info">
                            <span
                              class={`dot ${dev.online || isSelf ? 'connected' : 'disconnected'}`}
                            />
                            <OsIcon os={dev.os} size={15} />
                            <span class="device-name">{dev.name}</span>
                            <Show when={isSelf}>
                              <span class="self-tag">This device</span>
                            </Show>
                          </div>
                          <div class="row gap">
                            <button
                              class="chip"
                              onClick={() => {
                                setEditingDeviceId(dev.deviceId);
                                setEditDeviceDraft(dev.name);
                              }}
                            >
                              Rename
                            </button>
                            <Show when={!isSelf}>
                              <button class="chip danger" onClick={() => removeDevice(dev)}>
                                Remove
                              </button>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>

              <Show when={showAddDevice()}>
                <div class="divider" />
                <p class="muted">
                  Scan this code on your phone or copy the link into another device.
                </p>
                <Show when={qrDataUrl()}>
                  <div class="qr-wrap">
                    <img src={qrDataUrl()} alt="Pairing QR Code" class="qr-img" />
                  </div>
                </Show>
                <div class="row gap">
                  <button
                    class="btn primary"
                    onClick={() => copyToClipboard(pairUrl(), 'Pair link copied')}
                  >
                    Copy Pair Link
                  </button>
                  <button class="btn secondary" onClick={handleRotateKey}>
                    New Code
                  </button>
                </div>
                <div class="import-row">
                  <input
                    type="text"
                    placeholder="Paste pair link from another device..."
                    value={importInput()}
                    onInput={(e) => setImportInput(e.currentTarget.value)}
                  />
                  <button class="btn secondary" onClick={handleImportKey}>
                    Pair
                  </button>
                </div>
              </Show>
            </section>

            <Show when={!isMobile}>
              <section class="card">
                <div class="row between">
                  <div>
                    <strong>Browser Extension</strong>
                    <span class="muted">
                      Auto-open links, notifications and a right-click menu, with no tab left open
                    </span>
                  </div>
                  <Show
                    when={isFirefox && __FIREFOX_XPI__}
                    fallback={
                      <a class="btn primary small" href="/push-it-extension.zip" download>
                        Download
                      </a>
                    }
                  >
                    {/* No `download` attribute: Firefox installs .xpi links directly. */}
                    <a class="btn primary small" href="/push-it-firefox.xpi">
                      Install
                    </a>
                  </Show>
                </div>
                <details class="install-steps" open={isFirefox}>
                  <summary>Install in Firefox</summary>
                  <Show
                    when={__FIREFOX_XPI__}
                    fallback={
                      <>
                        <ol>
                          <li>
                            Open <code>about:debugging#/runtime/this-firefox</code>
                          </li>
                          <li>
                            Click <strong>Load Temporary Add-on…</strong> and pick the downloaded zip
                          </li>
                        </ol>
                        <p class="muted">Temporary add-ons are removed when Firefox restarts.</p>
                      </>
                    }
                  >
                    <ol>
                      <li>
                        In Firefox, click{' '}
                        <a href="/push-it-firefox.xpi">
                          <strong>Install</strong>
                        </a>
                      </li>
                      <li>
                        Allow this site to install the add-on, then click <strong>Add</strong>
                      </li>
                    </ol>
                    <p class="muted">
                      Signed by Mozilla, so it stays installed. To update, click Install again.
                    </p>
                  </Show>
                </details>
                <details class="install-steps" open={!isFirefox}>
                  <summary>Install in Chrome, Edge, Brave and other Chromium browsers</summary>
                  <ol>
                    <li>Unzip the download into a folder you'll keep</li>
                    <li>
                      Open <code>chrome://extensions</code> and turn on <strong>Developer mode</strong>
                    </li>
                    <li>
                      Click <strong>Load unpacked</strong> and select the folder
                    </li>
                  </ol>
                  <p class="muted">To update later, unzip over the same folder and click reload.</p>
                </details>
                <span class="muted">
                  Then open the extension, paste a pair link from <strong>+ Add Device</strong> above, and
                  click <strong>Save &amp; Connect</strong>.
                </span>
              </section>
            </Show>

            <section class="card">
              <h2>Preferences</h2>
              <label class="toggle">
                <div>
                  <strong>Auto-open links</strong>
                  <span class="muted">Open incoming links automatically while this tab is open</span>
                </div>
                <input type="checkbox" checked={autoOpen()} onChange={handleToggleAutoOpen} />
              </label>

              <div class="divider" />

              <div class="toggle">
                <div>
                  <strong>Notifications</strong>
                  <span class="muted">
                    {isPushSupported()
                      ? 'Notify me when the app is closed'
                      : 'Not available in this browser'}
                  </span>
                </div>
                <button
                  class={`btn small ${pushEnabled() ? 'success' : 'secondary'}`}
                  disabled={!isPushSupported() || pushBusy()}
                  onClick={handleTogglePush}
                >
                  {pushBusy() ? '...' : pushEnabled() ? 'On' : 'Turn On'}
                </button>
              </div>
            </section>

            <section class="card">
              <div class="row between">
                <div>
                  <strong>Chat History</strong>
                  <span class="muted">Stored only on this device</span>
                </div>
                <button
                  class="btn secondary small"
                  disabled={messages().length === 0}
                  onClick={async () => {
                    await clearMessages();
                    setMessages([]);
                    setBlobUrls({});
                    notify('History cleared');
                  }}
                >
                  Clear
                </button>
              </div>
            </section>

            <section class="card">
              <div class="row between">
                <div>
                  <strong>Room ID</strong>
                  <span class="muted">
                    Server owners: add this to <code>ALLOWED_ROOM_IDS</code> to make the server private
                  </span>
                </div>
                <button class="btn secondary small" onClick={() => copyToClipboard(roomId(), 'Room ID copied')}>
                  Copy
                </button>
              </div>
              <code class="room-id">{roomId()}</code>
            </section>

            <div class="version-footer">
              <span>Version v{appVersion}</span>
              <Show when={serverVersion() && serverVersion() !== appVersion}>
                <button
                  class="chip primary"
                  onClick={() => window.location.reload()}
                >
                  v{serverVersion()} available · Refresh
                </button>
              </Show>
            </div>
          </main>
        }
      >
        <div class="feedbar">
          <div class="seg" role="tablist">
            <button
              role="tab"
              aria-selected={feedTab() === 'feed' ? 'true' : 'false'}
              class={feedTab() === 'feed' ? 'active' : ''}
              onClick={() => switchFeedTab('feed')}
            >
              Feed
            </button>
            <button
              role="tab"
              aria-selected={feedTab() === 'archived' ? 'true' : 'false'}
              class={feedTab() === 'archived' ? 'active' : ''}
              onClick={() => switchFeedTab('archived')}
            >
              Archived
              <Show when={archivedMessages().length > 0}>
                <span class="seg-count">{archivedMessages().length}</span>
              </Show>
            </button>
          </div>
          <button
            class="text-btn"
            disabled={!selecting() && shownMessages().length === 0}
            onClick={() => {
              setSelecting(!selecting());
              setSelectedIds([]);
            }}
          >
            {selecting() ? 'Done' : 'Select'}
          </button>
        </div>

        <main class={`chat-stream ${selecting() ? 'selecting' : ''}`}>
          <For
            each={shownMessages()}
            fallback={
              feedTab() === 'archived' ? (
                <div class="empty">
                  <p>Nothing archived.</p>
                  <p class="muted">Archive a message to keep it out of the feed without deleting it.</p>
                </div>
              ) : (
                <div class="empty">
                  <p>Nothing pushed yet.</p>
                  <p class="muted">
                    Send a link, note, or photo below—or share straight from Android’s Share menu.
                  </p>
                </div>
              )
            }
          >
            {(msg) => {
              const os = msg.senderOs ?? (msg.direction === 'out' ? localOs : 'other');
              const label =
                msg.senderName || (msg.direction === 'out' ? deviceName() : 'Other device');
              const targetLabel =
                msg.targetNames && msg.targetNames.length > 0
                  ? ` → ${msg.targetNames.join(', ')}`
                  : '';
              const isLink = msg.type === 'link' && isSafeHttpUrl(msg.content);
              const isFile = msg.type === 'file';
              const isImage = isFile && Boolean(msg.mimeType?.startsWith('image/'));
              const fileUrl = () => (msg.blobId ? blobUrls()[msg.blobId] : undefined);
              const isSelected = () => selectedIds().includes(msg.id);

              // Swipe left to archive (touch and pen only; mouse users have the icon).
              let cardEl: HTMLElement | undefined;
              let revealEl: HTMLDivElement | undefined;
              let swipe: { x0: number; y0: number; dx: number; active: boolean; pid: number } | null =
                null;
              const resetSwipe = () => {
                swipe = null;
                if (cardEl) {
                  cardEl.classList.remove('dragging');
                  cardEl.style.transform = '';
                }
                if (revealEl) revealEl.style.opacity = '0';
              };
              const onPointerDown = (e: PointerEvent) => {
                if (e.pointerType === 'mouse' || msg.archivedAt || selecting()) return;
                if ((e.target as HTMLElement).closest('a, button')) return;
                swipe = { x0: e.clientX, y0: e.clientY, dx: 0, active: false, pid: e.pointerId };
              };
              const onPointerMove = (e: PointerEvent) => {
                if (!swipe || e.pointerId !== swipe.pid || !cardEl || !revealEl) return;
                const dx = Math.min(0, e.clientX - swipe.x0);
                const dy = e.clientY - swipe.y0;
                if (!swipe.active) {
                  if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
                    swipe.active = true;
                    cardEl.classList.add('dragging');
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  } else if (Math.abs(dy) > 8) {
                    swipe = null;
                    return;
                  } else {
                    return;
                  }
                }
                swipe.dx = dx;
                cardEl.style.transform = `translateX(${dx}px)`;
                revealEl.style.opacity = String(Math.min(1, -dx / SWIPE_ARCHIVE_PX));
              };
              const onPointerUp = () => {
                if (!swipe?.active || !cardEl) {
                  swipe = null;
                  return;
                }
                const archive = swipe.dx < -SWIPE_ARCHIVE_PX;
                swipe = null;
                cardEl.classList.remove('dragging');
                if (archive) {
                  cardEl.style.transform = 'translateX(-110%)';
                  window.setTimeout(() => archiveIds([msg.id]), 160);
                } else {
                  resetSwipe();
                }
              };

              return (
                <div
                  class={`bubble-row ${msg.direction}`}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={resetSwipe}
                >
                  <Show when={!msg.archivedAt}>
                    <div class="swipe-reveal" ref={revealEl} aria-hidden="true">
                      <ArchiveIcon />
                      Archive
                    </div>
                  </Show>
                  <article
                    ref={cardEl}
                    class={`bubble ${msg.direction} ${isSelected() ? 'selected' : ''}`}
                    onClick={(e) => {
                      if (!selecting()) return;
                      e.preventDefault();
                      toggleSelected(msg.id);
                    }}
                  >
                    <div class="bubble-head">
                      <span class="sender-tag">
                        <Show when={selecting()}>
                          <span class="select-check" aria-hidden="true" />
                        </Show>
                        <OsIcon os={os} size={13} />
                        <span>
                          {label}
                          {targetLabel}
                        </span>
                      </span>
                      <span class="meta-right">
                        <time>
                          {new Date(msg.ts).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                        <Show when={msg.direction === 'out'}>
                          <span
                            class={`check ${msg.status === 'delivered' ? 'delivered' : ''}`}
                            title={msg.status === 'delivered' ? 'Delivered' : 'Queued'}
                          >
                            {msg.status === 'delivered' ? '✓✓' : '✓'}
                          </span>
                        </Show>
                      </span>
                    </div>

                    <Show when={msg.title}>
                      <div class="bubble-title">{msg.title}</div>
                    </Show>

                    <div class="bubble-body">
                      {isFile ? (
                        <div class="file-card">
                          <Show when={isImage && fileUrl()}>
                            <a href={fileUrl()} target="_blank" rel="noopener noreferrer">
                              <img src={fileUrl()} alt={msg.fileName || 'Photo'} class="photo-preview" />
                            </a>
                          </Show>
                          <div class="file-meta">
                            <span class="file-name">{msg.fileName || msg.content}</span>
                            <Show when={msg.fileSize}>
                              <span class="muted">{formatFileSize(msg.fileSize)}</span>
                            </Show>
                          </div>
                        </div>
                      ) : isLink ? (
                        <a href={msg.content} target="_blank" rel="noopener noreferrer">
                          {msg.content}
                        </a>
                      ) : (
                        <pre>{msg.content}</pre>
                      )}
                    </div>

                    <div class="bubble-actions">
                      <Show when={isLink}>
                        <a
                          class="chip primary"
                          href={msg.content}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open
                        </a>
                      </Show>
                      <Show when={isFile && fileUrl()}>
                        <a
                          class="chip primary"
                          href={fileUrl()}
                          download={msg.fileName || 'file'}
                        >
                          Download
                        </a>
                      </Show>
                      <Show when={!isFile}>
                        <button
                          class="chip"
                          onClick={() => copyToClipboard(msg.content, 'Copied')}
                        >
                          Copy
                        </button>
                      </Show>
                      <span class="actions-spacer" />
                      <Show
                        when={msg.archivedAt}
                        fallback={
                          <>
                            <button
                              class="msg-icon-btn"
                              title="Archive"
                              aria-label="Archive"
                              onClick={() => archiveIds([msg.id])}
                            >
                              <ArchiveIcon />
                            </button>
                            <button
                              class="msg-icon-btn danger"
                              title="Delete"
                              aria-label="Delete"
                              onClick={() => deleteIds([msg.id])}
                            >
                              <TrashIcon />
                            </button>
                          </>
                        }
                      >
                        <button class="chip" onClick={() => restoreIds([msg.id])}>
                          <RestoreIcon />
                          Restore
                        </button>
                        <button class="chip danger" onClick={() => deleteIds([msg.id])}>
                          <TrashIcon />
                          Delete
                        </button>
                      </Show>
                    </div>
                  </article>
                </div>
              );
            }}
          </For>
          <div ref={chatEndEl} />
        </main>

        <Show when={undoToast()}>
          <div class="undo-toast" role="status">
            <span>{undoToast()?.text}</span>
            <button class="text-btn" onClick={runUndo}>
              Undo
            </button>
          </div>
        </Show>

        <Show when={selecting()}>
          <div class="bulk-bar">
            <span class="bulk-count">{selectedIds().length} selected</span>
            <Show
              when={feedTab() === 'archived'}
              fallback={
                <button
                  class="btn primary small"
                  disabled={selectedIds().length === 0}
                  onClick={() => runBulk('archive')}
                >
                  <ArchiveIcon />
                  Archive
                </button>
              }
            >
              <button
                class="btn secondary small"
                disabled={selectedIds().length === 0}
                onClick={() => runBulk('restore')}
              >
                <RestoreIcon />
                Restore
              </button>
            </Show>
            <button
              class="btn danger small"
              disabled={selectedIds().length === 0}
              onClick={() => runBulk('delete')}
            >
              <TrashIcon />
              Delete
            </button>
          </div>
        </Show>

        <Show when={!selecting() && feedTab() === 'archived' && archivedMessages().length > 0}>
          <div class="archive-footer">
            <Show
              when={confirmDeleteAll()}
              fallback={
                <button class="text-btn danger" onClick={() => setConfirmDeleteAll(true)}>
                  Delete all archived
                </button>
              }
            >
              <span>
                Delete {archivedMessages().length} message
                {archivedMessages().length === 1 ? '' : 's'} everywhere?
              </span>
              <button
                class="btn danger small"
                onClick={() => {
                  setConfirmDeleteAll(false);
                  deleteIds(archivedMessages().map((m) => m.id));
                }}
              >
                Delete
              </button>
              <button class="btn secondary small" onClick={() => setConfirmDeleteAll(false)}>
                Keep
              </button>
            </Show>
          </div>
        </Show>

        <Show when={!selecting() && feedTab() === 'feed'}>
        <Show when={otherDevices().length > 1}>
          <div class="target-bar">
            <span class="target-label">To:</span>
            <button
              class={`target-pill ${selectedTargets().length === 0 ? 'active' : ''}`}
              onClick={() => setSelectedTargets([])}
            >
              All
            </button>
            <For each={otherDevices()}>
              {(dev) => (
                <button
                  class={`target-pill ${selectedTargets().includes(dev.deviceId) ? 'active' : ''}`}
                  onClick={() => toggleTarget(dev.deviceId)}
                >
                  <OsIcon os={dev.os} size={12} />
                  <span>{dev.name}</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <footer class="composer-bar">
          <input
            ref={fileInputEl}
            type="file"
            class="hidden-file"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file) sendFile(file);
              e.currentTarget.value = '';
            }}
          />
          <button
            class="btn secondary icon-btn"
            title="Attach photo or file"
            disabled={sending()}
            onClick={() => fileInputEl?.click()}
          >
            +
          </button>
          <textarea
            rows={1}
            placeholder={narrowComposer() ? 'Paste a link or note…' : 'Paste a link, note, or screenshot…'}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              for (const item of items) {
                if (item.kind === 'file') {
                  const file = item.getAsFile();
                  if (file) {
                    e.preventDefault();
                    sendFile(file);
                    return;
                  }
                }
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendText(draft());
              }
            }}
          />
          <button
            class="btn primary send-btn"
            title="Push It"
            aria-label="Push It"
            disabled={sending() || !draft().trim()}
            onClick={() => sendText(draft())}
          >
            <svg class="send-icon" viewBox="105 96 340 340" aria-hidden="true">
              <path class="plane" d="M124 268l256-124-76 264-58-82-122-58z" />
              <path class="fold" d="M246 326l134-182-164 148 30 34z" />
            </svg>
          </button>
        </footer>
        </Show>
      </Show>
      </Show>
    </div>
  );
}
