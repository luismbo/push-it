# 🚀 Push It

Send links, notes, screenshots, and files between **Android** and **desktop browsers** — end-to-end encrypted, instant, and hosted 100% on **Cloudflare Workers**.

Nothing runs on your local machine. Open a link on your phone, tap **Share → Push It**, and it pops right open in your desktop browser.

---

## ✨ What It Does

- 🔐 **End-to-End Encrypted:** Every link, message, device name, photo, and file is encrypted in your browser with **AES-GCM 256-bit** using the Web Crypto API. Your key lives in the pairing QR code (`#key=...`) and never touches Cloudflare.
- 💬 **Device-to-Device Chat:** Clean chat-style feed with **OS icons**, customizable **device names**, targeted sending (**All** or specific devices), and live delivery checkmarks (`✓` queued / `✓✓` delivered).
- 📱 **Silent Android Share Sheet:** Install as a PWA on Android and share from any app — the Service Worker encrypts and pushes in the background, then closes itself right back to what you were doing.
- 🧩 **Browser Extension (`extension/`):** Works in **Firefox** and any Chromium-based desktop browser with no pinned tab and no Google push services required. Automatically opens incoming links in new tabs, shows native OS notifications with an unread red badge counter, pushes the active tab in one click, and adds a right-click **Push It → Device** menu.
- 📎 **Long Notes, Photos & Files:** Paste screenshots (`Ctrl+V`), drag-and-drop, or attach files up to **7.5 MB** (and long notes of any length). Blobs are encrypted client-side and auto-deleted on Cloudflare as soon as every recipient downloads them.
- 📬 **Offline Queue (Up to 28 Days):** If your computer or phone is turned off, encrypted messages wait safely in Cloudflare Durable Object storage (and Web Push) for up to 28 days — then deliver immediately and auto-delete once received.
- ⚡ **Zero-Config Web Push:** On first request, Cloudflare automatically generates and persists its own P-256 VAPID keypair inside Durable Object storage.

---

## 🛠️ Tech Stack

| Layer | Technology |
| --- | --- |
| **Frontend PWA** | [SolidJS 2.0](https://www.solidjs.com/) (`solid-js`, `@solidjs/web`), [Vite 8](https://vite.dev/) (`@solidjs/vite-plugin`), [Bun](https://bun.sh/) |
| **Desktop Extension** | Manifest V3 WebExtension for Firefox & Chromium (`extension/`) |
| **Backend & Hosting** | [Cloudflare Workers](https://workers.cloudflare.com/) Static Assets + SQLite-backed **Durable Objects** (WebSocket Hibernation API) |
| **Encryption** | Native Web Crypto API (`AES-GCM` 256-bit + `SHA-256` one-way room routing) |
| **Web Push** | RFC 8291 via [`@block65/webcrypto-web-push`](https://github.com/block65/webcrypto-web-push) + Service Worker (`public/sw.js`) |
| **Local Storage** | IndexedDB (shared between the PWA and Service Worker) & `chrome.storage.local` |

---

## 🧠 How It Works

```text
📱 Android (PWA / Share Sheet)          🖥️ Desktop (Browser Extension / PWA)  
        │                                             ▲
        │ 1. Encrypt with AES-GCM key (IndexedDB)     │ 4. Decrypt locally
        │    Derive roomId = SHA-256(key)             │    • Link  → auto-open tab
        ▼                                             │    • Text  → badge + toast
   ☁️ Cloudflare Worker + Durable Object              │    • File  → preview / download
        │  (sees only roomId hash + ciphertext)       │
        ├── Online device  ──▶ WebSocket (instant) ───┘
        ├── Offline PC     ──▶ 28-day encrypted queue (auto-deletes on delivery)
        └── Offline Phone  ──▶ Web Push (RFC 8291) ──▶ Service Worker decrypts & notifies
```

1. **Zero-Knowledge Pairing:** Your first device generates a random 256-bit key and derives a one-way `SHA-256` room ID. Scanning the QR code or pasting the `#key=...` link pairs another device — URL fragments are never sent to the server.
2. **Real-Time & Offline Delivery:** Online devices receive messages immediately over a hibernating WebSocket. Offline devices receive them via Web Push (Android) or the 28-day encrypted Durable Object queue (desktop), which deletes each message the moment all intended recipients receive it.
3. **Encrypted Blobs:** Photos, files, and long notes are encrypted into raw binary chunks in Durable Object SQLite storage, with only a tiny encrypted pointer sent over WebSocket/Push. Blobs are deleted automatically once downloaded by every recipient.

---

## 📁 Project Structure

- `src/` — SolidJS 2.0 PWA (`App.tsx`, `components/OsIcon.tsx`, `lib/crypto.ts`, `lib/db.ts`, `lib/device.ts`, `lib/push.ts`)
- `public/` — PWA manifest (`manifest.webmanifest`), Service Worker (`sw.js`), and icons
- `worker/` — Cloudflare Worker (`index.ts`) and Durable Object (`room-do.ts`)
- `extension/` — Ready-to-load Manifest V3 extension for Firefox and Chromium-based browsers

---

## ☁️ Deploy on Cloudflare Workers

1. Open **Cloudflare Dashboard → Workers & Pages → Create → Import a repository** and select this repo.
2. Set:
   - **Build command:** `bun run build`
   - **Deploy command:** `bunx wrangler deploy`
3. Click **Save and Deploy**.

---

## 🧩 Install the Browser Extension

### Chromium (Chrome, Edge, Brave, Vivaldi, …)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder from this repository.

### Firefox (128+)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `extension/manifest.json`.

Temporary add-ons are removed when Firefox restarts. To keep it installed, sign it as an unlisted add-on on [addons.mozilla.org](https://addons.mozilla.org/developers/) (e.g. `npx web-ext sign --channel unlisted` inside `extension/`) and install the resulting `.xpi`.

> In Firefox, clicking **+** to attach a file opens Push It in a tab, because Firefox closes popups when a file picker opens. Pasting a screenshot into the popup still works. If you've revoked the extension's site access, the status line shows **Access needed**. Click it to grant access again.

### Pair it

1. Open your deployed Push It URL → **Settings → + Add Device → Copy Pair Link**.
2. Click the **Push It** toolbar icon, paste the pair link, and click **Save & Connect**.
