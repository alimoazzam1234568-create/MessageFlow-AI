# MessageFlow AI — Universal Messaging Manager

Organize, schedule and manage multi-section message campaigns across messaging platforms — **safely and honestly**.

- **Simulated by default.** Test mode and the sandbox mock adapter never deliver anything.
- **Real when you connect official APIs.** Discord **Incoming Webhooks** and the **Telegram Bot API** work end-to-end: paste your own credentials, verify with a test message, run live campaigns.
- **Never fake.** WhatsApp & Instagram stay *copy-assist* until an approved Meta integration exists — the app blocks live sends instead of pretending.

---

## 1. Feature map

| Area | Status |
|---|---|
| Full dashboard — Overview, Campaigns, Builder, Sections, Platforms, Schedule, Logs, Settings | ✅ Web app **and** packaged extension |
| Multi-section campaigns — reps, intervals, section delays, earliest-start, enable/disable, reorder, progress | ✅ Sequential processing guaranteed |
| Scheduling — one-time & daily, timezone-aware, quiet hours, global + per-campaign daily caps | ✅ |
| Safety — consent gate, consent declaration, Stop All, duplicate guards, retries with backoff, manual per-message approval | ✅ |
| Persistence — campaigns, progress, logs, settings & credentials survive restarts | ✅ localStorage / chrome.storage |
| **Discord sending via your own Incoming Webhook** | ✅ Working (official API) |
| **Telegram sending via your own bot (BotFather)** | ✅ Working (official Bot API) |
| **Thread scanner** — detect the chat from your open browser tab | ✅ Working (extension) |
| WhatsApp / Instagram automation | ❌ Assisted copy mode only (needs Meta app approval) |

---

## 2. Repository layout

```
├── src/                        # React web dashboard (the full app, runs anywhere)
│   ├── store.tsx               # Engine: tick loop, reducer, persistence
│   ├── lib/deliver.ts          # Delivery adapters (mock / Discord webhook / Telegram bot)
│   └── lib/platforms.ts        # Platform registry
└── extension/                  # Chrome MV3 package (loadable as unpacked)
    ├── manifest.json           # storage + alarms + tabs permissions, scoped host permissions
    ├── background/service-worker.js   # alarm-driven scheduler, runs while dashboard is closed
    ├── popup/                  # Compact popup: stats, Stop All, "Open full dashboard"
    ├── dashboard/              # FULL dashboard (all 7 sections) as an extension page
    └── js/                     # Shared vanilla engine + adapters (same logic as the React app)
```

The web app and the extension share the same data model and engine design. The extension's dashboard, popup and service worker all read/write the **same chrome.storage state**, so a schedule you create in the extension dashboard keeps executing via `chrome.alarms` even after you close the tab.

---

## 3. Run the web dashboard

```bash
npm install
npm run dev      # development
npm run build    # production → dist/
npm run preview  # serve the build
```

## 4. Install the Chrome extension (MV3) — full dashboard included

**Download first (easiest):** open the web dashboard → **Settings → Chrome extension package → Download .zip** (or the button on the Platforms page). The zip is generated in your browser from the exact `extension/` sources of this build.

Then:

1. Extract the zip anywhere.
2. `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → select the extracted `messageflow-ai-extension` folder (the one containing `manifest.json`).

*Alternatively, if you have this repository locally, just load `extension/` directly.*
3. Click the toolbar icon → **"Open full dashboard"** — you get every page from the website (campaigns, builder, sections, platforms, schedule, logs, settings), running inside the extension.
4. Chrome → ⋮ on the extension → **Options** opens the same dashboard.

### Permissions (and why)

| Permission | Why |
|---|---|
| `storage` | Persist campaigns, progress, logs, settings, credentials. |
| `alarms` | Wake the service worker (~30s) to process due scheduled actions. |
| `tabs` | **Thread scanner**: read the active tab's URL to detect a Discord channel / Telegram / WhatsApp / Instagram thread. |
| `https://discord.com/api/*` | Deliver messages to **your** webhook. |
| `https://api.telegram.org/*` | Deliver messages via **your** bot. |

No other hosts are touched. There is no analytics, no telemetry, no remote config.

## 5. Connecting real platforms (do it in one minute each)

### Discord — Incoming Webhook (official)
1. In your server: **channel ⚙ → Integrations → Webhooks → New Webhook** → **Copy Webhook URL**.
2. Dashboard → **Campaigns → New campaign → Discord**. The webhook paste + **Send test message** controls appear directly inside the message sender. You can also manage it from **Platforms → Discord**.
3. Build a live campaign on platform *Discord*. The webhook determines the channel; each repetition is a real message.

### Telegram — Bot API (official)
1. Message **@BotFather** → `/newbot` → copy the token.
2. Recipients must press **Start** on your bot (that's Telegram's built-in consent). For groups/channels, add the bot as **admin**.
3. Find the chat ID via `@userinfobot` (or the scanner) — groups look like `-100…`.
4. **Platforms → Telegram** → paste token + chat ID → **Save** → verify.

> **Credential safety:** values are stored only in local extension storage, masked in the UI, redacted in every log line, and sent to exactly one place — the official API endpoint. Never commit them anywhere.

### WhatsApp & Instagram — assisted mode (honest by design)
Live campaigns targeting these platforms pause for **manual confirmation**: the message and destination pop up with **Copy** — you review and press send yourself. True automation requires Meta's approved APIs (Business Cloud API / Messenger API with App Review); see the per-platform "Rules & setup" dialog. We do not automate WhatsApp Web, ask for session cookies, or scrape — ever.

## 6. Thread scanner ("connect the chat in front of me")

In the extension dashboard (Platforms page or the campaign builder's destination row):

1. Open the chat in a normal tab — e.g. a Discord channel, a Telegram Web chat, WhatsApp Web, an Instagram DM thread.
2. Best path: click the extension toolbar icon over that chat → **Scan current chat & compose**. Or, from the dashboard, press **⌖ Scan**: it searches all open messaging tabs (not the dashboard tab) and lets you choose the thread.
3. The scanner parses the URL (`/channels/{guild}/{channel}`, `web.telegram.org…#<id>`, `web.whatsapp.com…`, `instagram.com/direct/t/<id>`) and offers the detected destination — **Use it** fills both destination and platform.

For Discord this records which channel the campaign refers to (the webhook you connected posts into its own channel). For Telegram it gives you the exact `chat_id` to paste into the integration.

## 7. Testing the engine

- **Test mode** simulates every send; logs are tagged *Simulated*.
- **`[fail]`** in a message body forces a retryable failure — watch backoff and the retry limit trip the campaign to *Failed*.
- **Settings → Confirm every live message**: live campaigns wait on an approval bar (Approve / Skip / Copy) for each send. Required for WhatsApp/Instagram flows.
- Set quiet hours to include "now" and watch actions hold and resume; reload the browser mid-campaign — progress persists; **Stop All** halts everything.

## 8. Scheduling honesty

Browser `setInterval` and MV3 `chrome.alarms` are **best-effort**: they drift under load, throttling, suspension and OS sleep, and alarms are limited to ≥30s granularity. Delivery times are therefore never guaranteed: countdowns are estimates, while quiet hours, daily caps, consent gates and duplicate guards are enforced *at dispatch time* — nothing leaves early, late-due sends catch up safely, and nothing ever fires twice.

## 9. Troubleshooting

| Symptom | Explanation / fix |
|---|---|
| Live start blocked | That platform isn't connected — paste credentials on the Platforms page and verify, or use test mode. WhatsApp/Instagram: assisted only. |
| Discord 429 | Discord rate limit; the engine retries automatically. Space your intervals out. |
| Telegram 403 / "bot was blocked" | The user blocked the bot or never pressed Start — removal is the correct outcome. |
| "Chat not found" (Telegram) | Wrong chat ID, or the bot isn't a member/admin of that chat. |
| Scan finds nothing | The active tab isn't a recognized chat URL; paste the URL manually with "Paste a URL instead". |
| Dashboard closed overnight | The service worker continues due sends via alarms (~30s). Sub-30s precision only exists while a dashboard tab is open. |
| Verification fails | Check the URL/token for typos. Discord webhooks can be deleted server-side; regenerate and re-save. |

## 10. Known limitations & unfinished work

- **WhatsApp / Instagram automation is intentionally unimplemented** — it needs Meta App Review; assisted mode is the honest stand-in.
- The web app storage and the extension storage are separate universes (by design); export/import JSON to move between them.
- One Discord webhook targets one channel — multi-channel flows need one webhook per channel (multiple named webhooks are on the roadmap).
- chrome.alarms granularity ⇒ background ticks are 30s; open-dashboard ticks are 1s.
- Roadmap: message templates with variables, drag-and-drop section reorder, per-platform rich payloads (Discord embeds, Telegram buttons), webhook presence check, localization.

## 11. Compliance

MessageFlow AI will not: send unsolicited bulk messages, contact non-consenting recipients, automate logins, scrape private data, bypass CAPTCHAs/rate limits/blocks, or evade messaging windows. Every real send goes through an official API you connected — with that platform's own consent model intact.
