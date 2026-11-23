import {
  decryptBytes,
  defaultDeviceName,
  deriveRoomId,
  formatFileSize,
  isSafeHttpUrl,
  isValidKeyB64,
} from './crypto.js';
import { completeWord, joinPairing, looksLikeCode, PairingError, parseCode, suggestWords } from './pairing.js';

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const devicePill = document.getElementById('devicePill');
const toggleSettingsBtn = document.getElementById('toggleSettings');
const toastEl = document.getElementById('toast');
const settingsView = document.getElementById('settingsView');
const chatView = document.getElementById('chatView');
const devicesHeading = document.getElementById('devicesHeading');
const deviceList = document.getElementById('deviceList');
const togglePairBtn = document.getElementById('togglePairBtn');
const pairBox = document.getElementById('pairBox');
const pairInput = document.getElementById('pairInput');
const savePairBtn = document.getElementById('savePair');
const pairSuggestions = document.getElementById('pairSuggestions');
const serverBox = document.getElementById('serverBox');
const serverInput = document.getElementById('serverInput');
const autoOpenEl = document.getElementById('autoOpen');
const targetBar = document.getElementById('targetBar');
const sendTabBtn = document.getElementById('sendTab');
const sendTabLabel = document.getElementById('sendTabLabel');
const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');
const draftEl = document.getElementById('draft');
const sendDraftBtn = document.getElementById('sendDraft');
const clearBtn = document.getElementById('clearBtn');
const versionText = document.getElementById('versionText');
const updateHint = document.getElementById('updateHint');
const historyList = document.getElementById('historyList');
const extVersion = chrome.runtime.getManifest().version;
versionText.textContent = `Version v${extVersion}`;

// Firefox closes the popup when a native file picker opens, so attachments
// are picked from a full tab instead (opened with ?tab=1).
const IS_FIREFOX = chrome.runtime.getURL('').startsWith('moz-extension:');
const IS_TAB_VIEW = new URLSearchParams(location.search).has('tab');
if (IS_TAB_VIEW) document.documentElement.classList.add('tab-view');

// Firefox lets users withhold or revoke host permissions, and the server sends
// no CORS headers, so the extension needs explicit access to the server origin.
function originPattern(serverUrl) {
  return `${new URL(serverUrl).origin}/*`;
}

async function hasServerAccess(serverUrl) {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(serverUrl)] });
  } catch {
    return true;
  }
}

let needsAccess = false;
let privateRepoUrl = '';

// Servers can restrict which rooms they serve (ALLOWED_ROOM_IDS); they answer
// 403 { error: 'private_server', repoUrl } for any other room.
async function checkPrivateServer(serverUrl, keyB64) {
  try {
    const rid = await deriveRoomId(keyB64);
    const res = await fetch(
      `${new URL(serverUrl).origin}/api/room/${encodeURIComponent(rid)}/status`,
      { cache: 'no-store' },
    );
    if (res.status !== 403) return '';
    const data = await res.json().catch(() => null);
    return data?.error === 'private_server'
      ? data.repoUrl || 'https://github.com/luismbo/push-it'
      : '';
  } catch {
    return '';
  }
}

let myDeviceId = '';
let currentDeviceOs = 'windows';
let currentDeviceName = 'Windows';
let currentServerUrl = '';
let currentKeyB64 = '';
let pairedDevices = [];
let selectedTargetIds = [];
let showingSettings = false;
let toastTimer;

const OS_PATHS = {
  windows:
    'M3 5.5L10.8 4.4V11.5H3V5.5ZM11.8 4.25L21 3V11.5H11.8V4.25ZM3 12.5H10.8V19.6L3 18.5V12.5ZM11.8 12.5H21V21L11.8 19.75V12.5Z',
  android:
    'M17.6 9.48l1.84-3.18a.48.48 0 0 0-.18-.65.48.48 0 0 0-.65.18l-1.86 3.22a11.35 11.35 0 0 0-9.5 0L5.39 5.83a.48.48 0 0 0-.65-.18.48.48 0 0 0-.18.65L6.4 9.48A10.7 10.7 0 0 0 1 18.5h22a10.7 10.7 0 0 0-5.4-9.02zM7.5 15a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm9 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z',
  macos:
    'M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83zM13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z',
  ios: 'M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83zM13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z',
  linux:
    'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 5l3 3-3 3 1.4 1.4L12.8 12 8.4 7.6 7 9zm5 6h5v-2h-5v2z',
  other: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v10h16V7H4z',
};

function createOsSvg(os, size = 13) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', OS_PATHS[os] || OS_PATHS.other);
  svg.appendChild(path);
  return svg;
}

const MSG_ICON_PATHS = {
  archive: 'M3 4h18v5H3zM5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3',
};

function createMsgIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'msg-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', MSG_ICON_PATHS[name]);
  svg.appendChild(path);
  return svg;
}

function createIconButton(name, label, onClick) {
  const btn = document.createElement('button');
  btn.className = `msg-icon-btn${name === 'trash' ? ' danger' : ''}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.appendChild(createMsgIcon(name));
  btn.onclick = onClick;
  return btn;
}

async function sendMessageOp(op, ids, toast) {
  const res = await chrome.runtime.sendMessage({ type: 'MESSAGE_OP', op, ids }).catch(() => null);
  showToast(res?.ok ? toast : 'Could not update history');
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2200);
}

function setView(showSettings) {
  showingSettings = showSettings;
  settingsView.classList.toggle('hidden', !showSettings);
  chatView.classList.toggle('hidden', showSettings);
  devicePill.classList.toggle('hidden', showSettings);
  toggleSettingsBtn.textContent = showSettings ? '← Back' : 'Settings';
}

function renderDevicePill() {
  devicePill.innerHTML = '';
  devicePill.appendChild(createOsSvg(currentDeviceOs, 13));
  const span = document.createElement('span');
  span.textContent = currentDeviceName;
  devicePill.appendChild(span);
}

function renderTargetBar() {
  const others = pairedDevices.filter((d) => d.deviceId !== myDeviceId);
  if (others.length < 2) {
    targetBar.classList.add('hidden');
    selectedTargetIds = [];
    return;
  }

  targetBar.classList.remove('hidden');
  targetBar.innerHTML = '';

  const lbl = document.createElement('span');
  lbl.className = 'target-label';
  lbl.textContent = 'To:';
  targetBar.appendChild(lbl);

  const allBtn = document.createElement('button');
  allBtn.className = `target-pill ${selectedTargetIds.length === 0 ? 'active' : ''}`;
  allBtn.textContent = 'All';
  allBtn.onclick = () => {
    selectedTargetIds = [];
    renderTargetBar();
  };
  targetBar.appendChild(allBtn);

  for (const dev of others) {
    const btn = document.createElement('button');
    btn.className = `target-pill ${selectedTargetIds.includes(dev.deviceId) ? 'active' : ''}`;
    btn.appendChild(createOsSvg(dev.os, 11));
    const s = document.createElement('span');
    s.textContent = dev.name;
    btn.appendChild(s);
    btn.onclick = () => {
      if (selectedTargetIds.includes(dev.deviceId)) {
        selectedTargetIds = selectedTargetIds.filter((id) => id !== dev.deviceId);
      } else {
        selectedTargetIds = [...selectedTargetIds, dev.deviceId];
      }
      renderTargetBar();
    };
    targetBar.appendChild(btn);
  }
}

function renderDeviceList() {
  devicesHeading.textContent = `Devices (${pairedDevices.length})`;
  deviceList.innerHTML = '';

  for (const dev of pairedDevices) {
    const isSelf = dev.deviceId === myDeviceId;
    const row = document.createElement('div');
    row.className = 'device-row';

    const info = document.createElement('div');
    info.className = 'device-info';

    const dot = document.createElement('span');
    dot.className = `dot ${dev.online || isSelf ? 'connected' : 'disconnected'}`;
    info.appendChild(dot);
    info.appendChild(createOsSvg(dev.os, 13));

    const nameEl = document.createElement('span');
    nameEl.className = 'device-name';
    nameEl.textContent = isSelf ? `${dev.name} (You)` : dev.name;
    info.appendChild(nameEl);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'chip';
    renameBtn.textContent = 'Rename';
    renameBtn.onclick = () => {
      row.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 24;
      input.value = dev.name;
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn primary small';
      saveBtn.textContent = 'Save';
      const commit = async () => {
        const nextName = input.value.trim() || defaultDeviceName(dev.os);
        await chrome.runtime.sendMessage({
          type: 'RENAME_DEVICE',
          deviceId: dev.deviceId,
          name: nextName,
          os: dev.os,
        });
        showToast(`Renamed to "${nextName}"`);
        refresh();
      };
      saveBtn.onclick = commit;
      input.onkeydown = (e) => {
        if (e.key === 'Enter') commit();
      };
      row.appendChild(input);
      row.appendChild(saveBtn);
      input.focus();
      input.select();
    };
    actions.appendChild(renameBtn);

    if (!isSelf) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'chip danger';
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = async () => {
        await chrome.runtime.sendMessage({
          type: 'REMOVE_DEVICE',
          deviceId: dev.deviceId,
        });
        showToast(`Removed "${dev.name}"`);
        refresh();
      };
      actions.appendChild(removeBtn);
    }

    row.appendChild(info);
    row.appendChild(actions);
    deviceList.appendChild(row);
  }
}

async function downloadFileItem(item) {
  if (!item.blobId || !item.blobIv || !currentServerUrl || !currentKeyB64) return;
  try {
    const roomId = await deriveRoomId(currentKeyB64);
    const base = new URL(currentServerUrl);
    const res = await fetch(
      `${base.origin}/api/room/${encodeURIComponent(roomId)}/blob/${encodeURIComponent(item.blobId)}?deviceId=${encodeURIComponent(myDeviceId)}`,
    );
    if (!res.ok) {
      showToast('File already expired or downloaded');
      return;
    }
    const cipher = new Uint8Array(await res.arrayBuffer());
    const plain = await decryptBytes(currentKeyB64, item.blobIv, cipher);
    const blob = new Blob([plain], { type: item.mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.fileName || 'file';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch {
    showToast('Could not download file');
  }
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  myDeviceId = state.deviceId || '';
  currentDeviceOs = state.deviceOs || 'windows';
  currentDeviceName = state.deviceName || defaultDeviceName(currentDeviceOs);
  currentServerUrl = state.serverUrl || '';
  currentKeyB64 = state.keyB64 || '';
  pairedDevices = Array.isArray(state.devices) ? state.devices : [];
  renderDevicePill();
  renderDeviceList();
  renderTargetBar();

  needsAccess = Boolean(state.paired && currentServerUrl) && !(await hasServerAccess(currentServerUrl));
  privateRepoUrl =
    state.paired && !needsAccess && state.status !== 'connected'
      ? await checkPrivateServer(currentServerUrl, currentKeyB64)
      : '';
  statusText.classList.toggle('action', needsAccess || Boolean(privateRepoUrl));
  statusText.title = privateRepoUrl
    ? 'This server only serves rooms its owner approved. Click to get your own Push It.'
    : needsAccess
      ? `Click to allow access to ${new URL(currentServerUrl).host}`
      : '';

  const blocked = needsAccess || Boolean(privateRepoUrl);
  statusDot.className = `dot ${state.paired && !blocked ? state.status : 'disconnected'}`;
  statusText.textContent = !state.paired
    ? 'Not paired'
    : privateRepoUrl
      ? 'Private server · get your own'
      : needsAccess
      ? 'Access needed · click to allow'
      : state.status === 'connected'
      ? 'Connected'
      : state.status === 'connecting'
        ? 'Connecting...'
        : 'Offline';
  autoOpenEl.checked = Boolean(state.autoOpen);

  if (!state.paired) {
    setView(true);
    pairBox.classList.remove('hidden');
  } else if (currentServerUrl) {
    fetch(`${new URL(currentServerUrl).origin}/api/version`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.version && d.version !== extVersion) {
          updateHint.textContent = IS_FIREFOX
            ? `v${d.version} available · click to update`
            : `v${d.version} available · reload extension`;
          updateHint.classList.remove('hidden');
        } else {
          updateHint.classList.add('hidden');
        }
      })
      .catch(() => {});
  }

  renderHistory(state.history || []);
}

function renderHistory(allItems) {
  // Archived messages live in the web app's Archived tab; the popup only shows the feed.
  const items = allItems.filter((m) => !m.archivedAt);
  historyList.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing pushed yet.';
    historyList.appendChild(empty);
    return;
  }

  for (const item of items.slice(-20)) {
    const row = document.createElement('div');
    row.className = `bubble-row ${item.direction}`;

    const bubble = document.createElement('div');
    bubble.className = `bubble ${item.direction}`;

    const head = document.createElement('div');
    head.className = 'bubble-head';

    const sender = document.createElement('span');
    sender.className = 'sender-tag';
    const os = item.senderOs || (item.direction === 'out' ? currentDeviceOs : 'other');
    sender.appendChild(createOsSvg(os, 12));
    const nameSpan = document.createElement('span');
    const baseName =
      item.senderName || (item.direction === 'out' ? currentDeviceName : 'Other device');
    const toSuffix =
      Array.isArray(item.targetNames) && item.targetNames.length > 0
        ? ` → ${item.targetNames.join(', ')}`
        : '';
    nameSpan.textContent = `${baseName}${toSuffix}`;
    sender.appendChild(nameSpan);
    head.appendChild(sender);

    const metaRight = document.createElement('span');
    metaRight.className = 'meta-right';
    const time = document.createElement('time');
    time.textContent = new Date(item.ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    metaRight.appendChild(time);

    if (item.direction === 'out') {
      const check = document.createElement('span');
      check.className = `check ${item.status === 'delivered' ? 'delivered' : ''}`;
      check.textContent = item.status === 'delivered' ? '✓✓' : '✓';
      check.title = item.status === 'delivered' ? 'Delivered' : 'Queued';
      metaRight.appendChild(check);
    }

    head.appendChild(metaRight);
    bubble.appendChild(head);

    if (item.type === 'link' && isSafeHttpUrl(item.content)) {
      const link = document.createElement('a');
      link.className = 'bubble-link';
      link.href = item.content;
      link.textContent = item.content;
      link.onclick = (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: item.content, active: true });
      };
      bubble.appendChild(link);
    } else {
      const text = document.createElement('div');
      text.className = 'bubble-text';
      text.textContent =
        item.type === 'file'
          ? `${item.fileName || item.content}${item.fileSize ? ` (${formatFileSize(item.fileSize)})` : ''}`
          : item.content;
      bubble.appendChild(text);
    }

    const actions = document.createElement('div');
    actions.className = 'bubble-actions';

    if (item.type === 'file') {
      const dlBtn = document.createElement('button');
      dlBtn.className = 'chip primary';
      dlBtn.textContent = 'Download';
      dlBtn.onclick = () => downloadFileItem(item);
      actions.appendChild(dlBtn);
    } else if (item.type === 'link' && isSafeHttpUrl(item.content)) {
      const openBtn = document.createElement('button');
      openBtn.className = 'chip primary';
      openBtn.textContent = 'Open';
      openBtn.onclick = () => chrome.tabs.create({ url: item.content, active: true });
      actions.appendChild(openBtn);
    }

    if (item.type !== 'file') {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'chip';
      copyBtn.textContent = 'Copy';
      copyBtn.onclick = async () => {
        await navigator.clipboard.writeText(item.content);
        showToast('Copied');
      };
      actions.appendChild(copyBtn);
    }

    const spacer = document.createElement('span');
    spacer.className = 'actions-spacer';
    actions.appendChild(spacer);
    actions.appendChild(
      createIconButton('archive', 'Archive', () => sendMessageOp('archive', [item.id], 'Archived')),
    );
    actions.appendChild(
      createIconButton('trash', 'Delete', () => {
        // There's no undo in the popup, so ask first, right on the message.
        actions.replaceChildren();
        actions.classList.add('confirm');
        const question = document.createElement('span');
        question.className = 'confirm-text';
        question.textContent = 'Delete on all devices?';
        const del = document.createElement('button');
        del.className = 'chip danger';
        del.textContent = 'Delete';
        del.onclick = () => sendMessageOp('delete', [item.id], 'Deleted');
        const keep = document.createElement('button');
        keep.className = 'chip';
        keep.textContent = 'Keep';
        keep.onclick = () => refresh();
        actions.append(question, del, keep);
      }),
    );

    bubble.appendChild(actions);
    row.appendChild(bubble);
    historyList.appendChild(row);
  }

  historyList.scrollTop = historyList.scrollHeight;
}

toggleSettingsBtn.addEventListener('click', () => {
  setView(!showingSettings);
});

devicePill.addEventListener('click', () => {
  setView(true);
});

togglePairBtn.addEventListener('click', () => {
  pairBox.classList.toggle('hidden');
});

function updatePairHints() {
  const raw = pairInput.value;
  const isCode = looksLikeCode(raw);
  // A code doesn't say which server it came from, so ask once if we don't know yet.
  serverBox.classList.toggle('hidden', !isCode || Boolean(currentServerUrl));

  pairSuggestions.replaceChildren();
  const words = suggestWords(raw);
  pairSuggestions.classList.toggle('hidden', words.length === 0);
  for (const word of words) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.textContent = word;
    chip.onclick = () => {
      pairInput.value = completeWord(pairInput.value, word);
      pairInput.focus();
      updatePairHints();
    };
    pairSuggestions.appendChild(chip);
  }
}

pairInput.addEventListener('input', updatePairHints);
pairInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') savePairBtn.click();
});

/** "push-it.example.workers.dev" or a full URL → its origin, or null. */
function parseServerOrigin(input) {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.origin;
  } catch {
    return null;
  }
}

async function pairWithCode(raw) {
  const code = parseCode(raw);
  if (!code) {
    showToast('A code is a number and three words');
    return;
  }
  const origin = currentServerUrl ? new URL(currentServerUrl).origin : parseServerOrigin(serverInput.value);
  if (!origin) {
    showToast('Enter your Push It address');
    serverInput.focus();
    return;
  }

  // Must be the first await so it still counts as a user gesture in Firefox.
  const granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
  if (!granted) {
    showToast(`Allow access to ${new URL(origin).host} to connect`);
    return;
  }

  savePairBtn.disabled = true;
  savePairBtn.textContent = 'Pairing…';
  let keyB64;
  try {
    keyB64 = await joinPairing(origin, code);
  } catch (err) {
    showToast(err instanceof PairingError ? err.message : `Could not reach ${new URL(origin).host}`);
    return;
  } finally {
    savePairBtn.disabled = false;
    savePairBtn.textContent = 'Save & Connect';
  }
  await finishPairing(origin, keyB64);
}

async function finishPairing(origin, keyB64) {
  await chrome.storage.local.set({ serverUrl: origin, keyB64 });
  pairInput.value = '';
  serverInput.value = '';
  updatePairHints();
  pairBox.classList.add('hidden');
  await chrome.runtime.sendMessage({ type: 'RECONNECT' });
  if (await checkPrivateServer(origin, keyB64)) {
    showToast('This server is private · click the status to learn more');
    setTimeout(refresh, 0);
    return;
  }
  setView(false);
  showToast('Paired!');
  setTimeout(refresh, 600);
}

savePairBtn.addEventListener('click', async () => {
  const raw = pairInput.value.trim();
  if (looksLikeCode(raw)) {
    await pairWithCode(raw);
    return;
  }
  try {
    const parsed = new URL(raw);
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const keyB64 = hashParams.get('key')?.trim() || '';
    if (!isValidKeyB64(keyB64)) {
      showToast('That pair link is not valid');
      return;
    }

    // Must be the first await so it still counts as a user gesture in Firefox.
    const granted = await chrome.permissions.request({ origins: [originPattern(parsed.origin)] });
    if (!granted) {
      showToast(`Allow access to ${parsed.host} to connect`);
      return;
    }

    await finishPairing(parsed.origin, keyB64);
  } catch {
    showToast('Enter a code like 42 amazing ketchup river, or paste the full pair link');
  }
});

autoOpenEl.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoOpen: autoOpenEl.checked });
  showToast(autoOpenEl.checked ? 'Auto-open on' : 'Auto-open off');
});

function getSelectedTargetsPayload() {
  if (!selectedTargetIds.length) return {};
  const names = pairedDevices
    .filter((d) => selectedTargetIds.includes(d.deviceId))
    .map((d) => d.name);
  return { targetIds: selectedTargetIds, targetNames: names };
}

attachBtn.addEventListener('click', () => {
  if (IS_FIREFOX && !IS_TAB_VIEW) {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1'), active: true });
    window.close();
    return;
  }
  fileInput.click();
});

// On Firefox, the server may offer a signed .xpi; opening it installs the update in place.
// Without one, the link just opens the app, whose Settings has the download.
updateHint.addEventListener('click', () => {
  if (!IS_FIREFOX || !currentServerUrl) return;
  chrome.tabs.create({ url: `${new URL(currentServerUrl).origin}/push-it-firefox.xpi`, active: true });
});

statusText.addEventListener('click', async () => {
  if (privateRepoUrl) {
    chrome.tabs.create({ url: privateRepoUrl, active: true });
    return;
  }
  if (!needsAccess || !currentServerUrl) return;
  const granted = await chrome.permissions
    .request({ origins: [originPattern(currentServerUrl)] })
    .catch(() => false);
  if (!granted) return;
  await chrome.runtime.sendMessage({ type: 'RECONNECT' });
  setTimeout(refresh, 600);
});

async function pushFileObject(file) {
  if (!file) return;
  if (file.size > 7.5 * 1024 * 1024) {
    showToast('File is too large (max 7.5 MB)');
    return;
  }
  showToast('Pushing file...');
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  const res = await chrome.runtime.sendMessage({
    type: 'SEND_FILE',
    bytes,
    fileName: file.name || (file.type?.startsWith('image/') ? 'screenshot.png' : 'file'),
    mimeType: file.type || 'application/octet-stream',
    ...getSelectedTargetsPayload(),
  });
  if (!res.ok) {
    showToast('Could not send file');
    return;
  }
  showToast('Pushed!');
  refresh();
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  await pushFileObject(file);
});

function autoResizeDraft() {
  draftEl.style.height = 'auto';
  draftEl.style.height = `${Math.min(draftEl.scrollHeight, 96)}px`;
}

draftEl.addEventListener('input', autoResizeDraft);

draftEl.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        pushFileObject(file);
        return;
      }
    }
  }
});

// Show active tab title/host in the quick Push This Tab bar
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (tab?.url && isSafeHttpUrl(tab.url)) {
    const label = tab.title ? `Push tab: ${tab.title}` : `Push tab: ${new URL(tab.url).host}`;
    sendTabLabel.textContent = label;
  }
}).catch(() => {});

sendTabBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !isSafeHttpUrl(tab.url)) {
    showToast('Open a website tab first');
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: 'SEND',
    content: tab.url,
    title: tab.title,
    ...getSelectedTargetsPayload(),
  });
  if (!res.ok) {
    showToast('Could not send right now');
    return;
  }
  showToast('Pushed!');
  refresh();
});

async function submitDraft() {
  const content = draftEl.value.trim();
  if (!content) return;
  const res = await chrome.runtime.sendMessage({
    type: 'SEND',
    content,
    ...getSelectedTargetsPayload(),
  });
  if (!res.ok) {
    showToast('Could not send right now');
    return;
  }
  draftEl.value = '';
  autoResizeDraft();
  showToast('Pushed!');
  refresh();
}

sendDraftBtn.addEventListener('click', submitDraft);
draftEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitDraft();
  }
});

clearBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  showToast('History cleared');
  refresh();
});

// Archive/delete (from here or another device) and new messages update the stored history.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.history) {
    renderHistory(Array.isArray(changes.history.newValue) ? changes.history.newValue : []);
  }
});

chrome.runtime.sendMessage({ type: 'MARK_READ' }).catch(() => {});
refresh();
