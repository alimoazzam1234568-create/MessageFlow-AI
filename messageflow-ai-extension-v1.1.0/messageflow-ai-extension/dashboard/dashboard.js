/* ------------------------------------------------------------------ */
/* MessageFlow AI — extension dashboard (vanilla ES module)            */
/* Shares the same storage + engine as the background service worker,  */
/* so schedules you configure here are executed even when this tab is  */
/* closed (via chrome.alarms). When opened outside the extension it    */
/* falls back to localStorage — handy for testing.                     */
/* ------------------------------------------------------------------ */

import {
  makeStorage, loadState, saveState, seedState, pushLog, uid, esc,
  fmtCountdown, fmtDateTime, fmtSecs, toLocalInput, fromLocalInput,
  tickEngine, applySendResult, advanceAfter, campaignTotals, currentSection,
  validateCampaign, buildPreview, blankCampaign, isLiveAllowed, isQuiet,
  localDayKey, scanThreadUrl, clone, withEngineLock, markDashboardAlive,
} from "../js/engine.js";
import { deliver, verifyIntegration, redactUrl } from "../js/adapters.js";

const storage = makeStorage();
const hasTabs = typeof chrome !== "undefined" && !!chrome.tabs?.query;

let state = null;
const ui = {
  page: "overview",
  filter: "all",
  draft: null,
  startId: null,
  deleteId: null,
  previewId: null,
  stopAsk: false,
  scanAskUrl: false,
  scanCandidates: null,
  verifying: null,
  logFilter: { level: "all", platform: "all", q: "" },
};

/* ------------------------------ platforms -------------------------- */

const PLATFORMS = [
  { id: "mock", name: "Sandbox (Mock)", letter: "M", cls: "mock", tag: "Built-in simulated adapter" },
  { id: "discord", name: "Discord", letter: "D", cls: "discord", tag: "Official Incoming Webhooks" },
  { id: "telegram", name: "Telegram", letter: "T", cls: "telegram", tag: "Official Bot API" },
  { id: "whatsapp", name: "WhatsApp", letter: "W", cls: "whatsapp", tag: "Business Cloud API — assisted" },
  { id: "instagram", name: "Instagram", letter: "I", cls: "instagram", tag: "Messenger API — assisted" },
];
const plat = (id) => PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0];
const chip = (id) => { const p = plat(id); return `<span class="chip chip-${p.cls}"><span class="sq">${p.letter}</span>${p.name}</span>`; };

const PAGES = [
  ["overview", "Overview", "Live activity across every integration", "OV"],
  ["campaigns", "Campaigns", "Create, schedule and control message flows", "CP"],
  ["sections", "Message Sections", "Every section across your campaigns", "SC"],
  ["platforms", "Platforms & Integrations", "Connect official APIs — Discord webhook, Telegram bot", "PL"],
  ["schedule", "Schedule", "Upcoming actions, timezone and quiet hours", "SD"],
  ["logs", "Activity Logs", "Successes, failures, skips and system events", "LG"],
  ["settings", "Settings", "Safety limits and data management", "ST"],
];
const PAGE_META = Object.fromEntries(PAGES.map((p) => [p[0], p]));
PAGE_META.editor = ["editor", "Campaign Builder", "Design your message flow section by section", "ED"];

/* ------------------------------ helpers ---------------------------- */

const $view = () => document.getElementById("view");
const $nav = () => document.getElementById("nav");
const STATUS = ["draft", "scheduled", "running", "paused", "completed", "failed"];
const pill = (s) => `<span class="pill pill-${s}"><span class="dot"></span>${s}</span>`;
const modePill = (m) => `<span class="pill pill-mode-${m}"><span class="dot"></span>${m}</span>`;
const secPill = (s) => `<span class="pill pill-${s}">${s}</span>`;
const pctOf = (c) => { const t = campaignTotals(c); return t.total === 0 ? 0 : Math.round((t.done / t.total) * 100); };
const findCmp = (id) => state.campaigns.find((c) => c.id === id) ?? null;

function toast(kind, title, desc) {
  const root = document.getElementById("toastRoot");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<strong>${esc(title)}</strong>${desc ? `<span>${esc(desc)}</span>` : ""}`;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4600);
}
const ok = (t, d) => toast("success", t, d);
const bad = (t, d) => toast("error", t, d);
const note = (t, d) => toast("info", t, d);

let saveTimer = 0;
/** Debounced persist for ordinary UI edits. Bumps the revision so other
 *  contexts (worker / second tab) know this copy is newer. */
function save() {
  clearTimeout(saveTimer);
  state.rev = (state.rev ?? 0) + 1;
  saveTimer = setTimeout(() => void saveState(storage, state), 200);
}
/** Immediate persist used inside the engine lock — supersede pending saves. */
async function persistNow() {
  clearTimeout(saveTimer);
  state.rev = (state.rev ?? 0) + 1;
  await saveState(storage, state);
}

/* ------------------------------ heartbeat -------------------------- */

async function heartbeat() {
  let needRender = false;
  await withEngineLock(async () => {
    // If another context wrote newer state (worker tick, second tab), adopt it.
    const stored = await loadState(storage);
    if ((stored.rev ?? 0) > (state.rev ?? 0)) {
      const queued = state.confirmQueue; // confirm queue is session-local
      state = stored;
      state.confirmQueue = queued;
      needRender = true;
    }
    const out = [];
    const changed = tickEngine(state, Date.now(), out);
    for (const a of out) {
      try {
        await deliver(a, state.integrations);
        applySendResult(state, { ...a, ok: true }, Date.now());
      } catch (err) {
        applySendResult(state, { ...a, ok: false, error: String(err && err.message ? err.message : err) }, Date.now());
      }
    }
    if (changed || out.length) { await persistNow(); needRender = true; }
  });
  if (needRender) rerender();
  renderConfirmBar();
}

/* ------------------------------ render ----------------------------- */

function rerender() {
  renderNav();
  renderTopbar();
  // Don't yank focus away while the user is editing a field.
  const a = document.activeElement;
  const typing = a && $view().contains(a) && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName);
  if (!typing) renderPage();
}

function renderNav() {
  const running = state.campaigns.filter((c) => c.status === "running").length;
  $nav().innerHTML = PAGES.map(([id, label, , mono]) =>
    `<button class="${ui.page === id || (id === "campaigns" && ui.page === "editor") ? "active" : ""}" data-act="nav" data-page="${id}">
      <span class="n-ic tnum tiny muted">${mono}</span>${label}${id === "campaigns" && running > 0 ? `<span class="n-count">${running}</span>` : ""}
    </button>`
  ).join("");
}

function renderTopbar() {
  const meta = PAGE_META[ui.page] ?? PAGE_META.overview;
  document.getElementById("pageTitle").textContent = meta[1];
  document.getElementById("pageSub").textContent = meta[2];
  document.getElementById("clockTz").textContent = (state.settings.timezone.split("/").pop() || "UTC").replace("_", " ");
}

function renderPage() {
  const fn = { overview: renderOverview, campaigns: renderCampaigns, sections: renderSections, platforms: renderPlatforms, schedule: renderSchedule, logs: renderLogs, settings: renderSettings, editor: renderEditor }[ui.page] ?? renderOverview;
  $view().innerHTML = fn();
  renderConfirmBar();
}

/* ------------------------------ overview --------------------------- */

function statCard(k, v, s) {
  return `<div class="card stat-card"><div class="k">${k}</div><div class="v tnum">${v}</div><div class="s">${s}</div></div>`;
}

function renderOverview() {
  const now = Date.now();
  const tz = state.settings.timezone;
  const today = localDayKey(now, tz);
  const running = state.campaigns.filter((c) => c.status === "running").length;
  const scheduled = state.campaigns.filter((c) => c.status === "scheduled").length;
  const sentToday = state.logs.filter((l) => (l.level === "success" || l.level === "test") && localDayKey(l.ts, tz) === today);
  const fails = state.logs.filter((l) => l.level === "error" && now - l.ts < 86400000).length;

  const upcoming = [];
  for (const c of state.campaigns) {
    if (c.status !== "running" && c.status !== "scheduled") continue;
    for (const it of buildPreview(c, state.settings, now, 3).items) upcoming.push({ ...it, campaign: c.name, platform: c.platform });
  }
  upcoming.sort((a, b) => a.ts - b.ts);

  return `
    <div class="grid grid-4">
      ${statCard("Running now", running, running ? "Engine processing" : "Nothing in flight")}
      ${statCard("Scheduled", scheduled, orchestratedLabel())}
      ${statCard("Processed today", sentToday.length, sentToday.filter((l) => l.level === "test").length + " simulated · " + sentToday.filter((l) => l.level === "success").length + " delivered")}
      ${statCard("Failures · 24h", fails, fails ? "Review activity logs" : "No recent failures")}
    </div>
    <div class="grid grid-2">
      <div class="card">
        <div class="row between"><span class="title">⏱ Next scheduled actions</span><span class="tiny muted">${isQuiet(now, state.settings) ? "Quiet hours active" : "Engine live"}</span></div>
        ${upcoming.length === 0 ? `<div class="empty mt">Nothing queued. Start a campaign to see the timeline.</div>` : upcoming.slice(0, 6).map((u, i) => `
          <div class="row mt" style="gap:10px">
            <span class="tnum small" style="width:70px;color:${i === 0 ? "#67e8f9" : "#94a3b8"}" data-ts="${u.ts}">${fmtCountdown(u.ts - now)}</span>
            <div class="grow"><div class="small clamp">${esc(u.campaign)}</div><div class="tiny muted clamp">${esc(u.sectionTitle)} · rep ${u.rep}/${u.total}</div></div>
            ${chip(u.platform)}
          </div>`).join("")}
      </div>
      <div class="card">
        <span class="title">Integrations</span>
        ${PLATFORMS.map((p) => integrationRow(p)).join("")}
        <div class="mt"><button class="btn btn-sm" data-act="nav" data-page="platforms">Manage integrations →</button></div>
      </div>
    </div>
    <div class="card">
      <div class="row between"><span class="title">Recent activity</span><button class="btn btn-plain btn-sm" data-act="nav" data-page="logs">All logs →</button></div>
      ${state.logs.slice(0, 7).map(logRow).join("") || `<div class="empty mt">No activity yet.</div>`}
    </div>`;

  function orchestratedLabel() {
    const planned = state.campaigns.filter((c) => c.status === "running" || c.status === "scheduled")
      .reduce((acc, c) => acc + (campaignTotals(c).total - campaignTotals(c).done), 0);
    return planned + " messages queued";
  }
}

function integrationRow(p) {
  const integ = state.integrations;
  let status, cls;
  if (p.id === "mock") { status = "Sandbox ready"; cls = "conn-on"; }
  else if (p.id === "discord" && isLiveAllowed("discord", integ)) { status = "Connected"; cls = "conn-on"; }
  else if (p.id === "telegram" && isLiveAllowed("telegram", integ)) { status = "Connected"; cls = "conn-on"; }
  else if (p.id === "whatsapp" || p.id === "instagram") { status = "Assisted only"; cls = "conn-assist"; }
  else { status = "Not configured"; cls = "conn-off"; }
  return `<div class="row mt"><span class="plat-ic plat-${p.cls}">${p.letter}</span>
    <div class="grow"><div class="small" style="color:#e2e8f0;font-weight:600">${p.name}</div><div class="tiny muted">${p.tag}</div></div>
    <span class="${cls}">${status}</span></div>`;
}

function logRow(l) {
  return `<div class="log-row"><span class="tnum log-time">${fmtDateTime(l.ts, state.settings.timezone)}</span>
    <span class="dot-lv lv-${l.level}"></span>
    <div class="grow"><div class="log-text">${esc(l.text)}</div>${l.campaignName ? `<div class="log-sub">${esc(l.campaignName)}</div>` : ""}</div></div>`;
}

/* ----------------------------- campaigns --------------------------- */

function nextActionHtml(c) {
  if (c.inFlight) return `<span style="color:#a5b4fc">Sending…</span>`;
  if (c.status === "running" || c.status === "scheduled") return c.nextActionAt ? `<span data-ts="${c.nextActionAt}">${fmtCountdown(c.nextActionAt - Date.now())}</span>` : "—";
  if (c.status === "paused") return `<span class="muted">Paused</span>`;
  if (c.status === "completed") return `<span style="color:#67e8f9">Completed</span>`;
  if (c.status === "failed") return `<span style="color:#fda4af">Failed</span>`;
  return `<span class="muted">Not scheduled</span>`;
}

function campaignCard(c) {
  const t = campaignTotals(c);
  const sec = currentSection(c);
  const liveGate = c.mode === "live" && !isLiveAllowed(c.platform, state.integrations);
  const controls = [];
  if (c.status === "draft") controls.push(`<button class="btn btn-primary btn-sm" data-act="start-ask" data-id="${c.id}">▶ Start</button>`);
  if (c.status === "scheduled") { controls.push(`<button class="btn btn-primary btn-sm" data-act="start-ask" data-id="${c.id}">▶ Start now</button>`); controls.push(`<button class="btn btn-sm" data-act="pause" data-id="${c.id}">❚❚ Pause</button>`); }
  if (c.status === "running") controls.push(`<button class="btn btn-sm" data-act="pause" data-id="${c.id}">❚❚ Pause</button>`);
  if (c.status === "paused") controls.push(`<button class="btn btn-success btn-sm" data-act="resume" data-id="${c.id}">▶ Resume</button>`);
  if (c.status === "completed" || c.status === "failed") controls.push(`<button class="btn btn-sm" data-act="reset" data-id="${c.id}">↺ Reset</button>`);
  if (c.status === "failed") controls.push(`<button class="btn btn-primary btn-sm" data-act="start-ask" data-id="${c.id}">▶ Retry</button>`);
  controls.push(`<button class="btn btn-sm" data-act="preview" data-id="${c.id}">Preview</button>`);
  controls.push(`<button class="btn btn-plain btn-sm" data-act="edit" data-id="${c.id}">Edit</button>`);
  controls.push(`<button class="btn btn-plain btn-sm" data-act="duplicate" data-id="${c.id}">Duplicate</button>`);
  controls.push(`<button class="btn btn-plain btn-sm" style="color:#fda4af" data-act="delete-ask" data-id="${c.id}">Delete</button>`);

  return `<div class="card camp">
    <div class="row wrap">
      <span class="title grow clamp">${esc(c.name)}</span>
      ${pill(c.status)} ${modePill(c.mode)}
    </div>
    <div class="row wrap mt small muted">${chip(c.platform)} <span class="clamp">→ ${esc(c.destination || "—")}</span></div>
    ${liveGate ? `<div class="warn-note mt small">Live start is blocked — connect the official ${plat(c.platform).name} integration on the Platforms page (or switch to test mode).</div>` : ""}
    <div class="row between mt small muted">
      <span>${sec && c.status === "running" ? `Section: <b style="color:#e2e8f0">${esc(sec.title)}</b> · rep ${Math.min(sec.progress + 1, sec.repetitions)}/${sec.repetitions}` : `${c.sections.filter((s) => s.enabled).length} sections`}</span>
      <span class="tnum">${t.done}/${t.total} sent</span>
    </div>
    <div class="progress mt"><i style="width:${pctOf(c)}%"></i></div>
    <div class="grid grid-2 mt">
      <div class="mini"><div class="tiny muted">NEXT ACTION</div><div class="small tnum mt" style="color:#e2e8f0">${nextActionHtml(c)}</div></div>
      <div class="mini"><div class="tiny muted">STARTS</div><div class="small tnum mt" style="color:#e2e8f0">${fmtDateTime(c.startAt, state.settings.timezone)}</div></div>
    </div>
    <div class="row wrap mt" style="gap:6px;border-top:1px solid var(--line);padding-top:12px">${controls.join("")}</div>
  </div>`;
}

function renderCampaigns() {
  const filters = ["all", ...STATUS];
  const list = state.campaigns.filter((c) => ui.filter === "all" || c.status === ui.filter);
  return `
    <div class="row between wrap">
      <div class="row wrap" style="gap:6px">${filters.map((f) => {
        const n = f === "all" ? state.campaigns.length : state.campaigns.filter((c) => c.status === f).length;
        return `<button class="btn btn-sm ${ui.filter === f ? "btn-primary" : ""}" data-act="filter" data-f="${f}">${f} <span class="tnum tiny" style="opacity:.7">${n}</span></button>`;
      }).join("")}</div>
      <button class="btn btn-primary btn-sm" data-act="edit-new">+ New campaign</button>
    </div>
    ${list.length === 0 ? `<div class="empty">No campaigns${ui.filter !== "all" ? " with this status" : ""}. Create one to get started.</div>` : `<div class="grid grid-2">${list.map(campaignCard).join("")}</div>`}`;
}

/* ------------------------------ editor ----------------------------- */

function sectionEditorHtml(s, i, total) {
  return `<div class="sec-card ${s.enabled ? "" : "off"}">
    <div class="sec-head">
      <span class="sec-idx tnum">${i + 1}</span>
      <input class="sec-title" data-si="${i}" data-sf="title" value="${esc(s.title)}" placeholder="Section title" />
      <button class="btn btn-plain btn-sm" title="Move up" data-act="sec-move" data-i="${i}" data-d="-1" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="btn btn-plain btn-sm" title="Move down" data-act="sec-move" data-i="${i}" data-d="1" ${i === total - 1 ? "disabled" : ""}>↓</button>
      <button class="btn btn-plain btn-sm" style="color:#fda4af" title="Delete section" data-act="sec-del" data-i="${i}">✕</button>
      <label class="row tiny muted" style="gap:4px"><input type="checkbox" data-si="${i}" data-sf="enabled" ${s.enabled ? "checked" : ""}/> on</label>
    </div>
    <div class="sec-body">
      <textarea class="input" rows="2" data-si="${i}" data-sf="message" placeholder='Message text — include "[fail]" to test retry handling'>${esc(s.message)}</textarea>
      <div class="grid grid-4">
        <div><span class="label">Repetitions</span><input class="input tnum" type="number" min="1" max="500" value="${s.repetitions}" data-si="${i}" data-sf="repetitions"/></div>
        <div><span class="label">Interval (sec)</span><input class="input tnum" type="number" min="2" value="${s.intervalSec}" data-si="${i}" data-sf="intervalSec"/></div>
        <div><span class="label">Delay after (sec)</span><input class="input tnum" type="number" min="0" value="${s.delayAfterSec}" data-si="${i}" data-sf="delayAfterSec"/></div>
        <div><span class="label">Earliest start</span><input class="input tnum" type="datetime-local" value="${toLocalInput(s.startAt)}" data-si="${i}" data-sf="startAt"/></div>
      </div>
      <div class="tiny muted">${s.repetitions}× every ${fmtSecs(s.intervalSec)}${s.delayAfterSec > 0 ? ` · ${fmtSecs(s.delayAfterSec)} before next section` : ""}${s.progress > 0 ? ` · already sent ${s.progress}` : ""}</div>
    </div>
  </div>`;
}

function builderConnectionHtml(d) {
  const integ = state.integrations;
  if (d.platform === "discord") {
    const connected = isLiveAllowed("discord", integ);
    const detected = state.scanResult?.platform === "discord" ? state.scanResult : null;
    return `<div class="connection-box ${connected ? "connected" : ""}" style="grid-column:1/-1">
      <div class="connection-head">
        <div><strong>Discord webhook connection</strong><p>Paste the Incoming Webhook URL for the channel this campaign must send to.</p></div>
        <span class="${connected ? "conn-on" : "conn-off"}">${connected ? "Connected" : "Required for live"}</span>
      </div>
      <span class="label">Incoming Webhook URL <span>stored locally and masked</span></span>
      <div class="secret-row">
        <input class="input tnum" id="builder-dc-wh" type="password" placeholder="https://discord.com/api/webhooks/…" value="${esc(integ.discordWebhookUrl)}" autocomplete="off" spellcheck="false"/>
        <button class="btn btn-sm" data-act="toggle-secret" data-target="builder-dc-wh">Show</button>
        <button class="btn btn-primary btn-sm" data-act="builder-int-save" data-platform="discord">Save webhook</button>
      </div>
      <div class="row wrap mt" style="gap:6px">
        <button class="btn btn-sm" data-act="builder-int-verify" data-platform="discord">Send test message</button>
        ${integ.discordVerifiedAt ? `<span class="tiny" style="color:#6ee7b7">✓ verified ${fmtDateTime(integ.discordVerifiedAt, state.settings.timezone)}</span>` : ""}
      </div>
      ${detected ? `<div class="scan-box mt">Scanned Discord channel: <b>${esc(detected.label)}</b>. The webhook controls the actual delivery channel; make sure this webhook was created in that same channel.</div>` : ""}
      <p class="tiny muted mt">Discord: channel ⚙ → Integrations → Webhooks → New Webhook → Copy Webhook URL. No bot token or user login is needed.</p>
    </div>`;
  }
  if (d.platform === "telegram") {
    const connected = isLiveAllowed("telegram", integ);
    return `<div class="connection-box ${connected ? "connected" : ""}" style="grid-column:1/-1">
      <div class="connection-head">
        <div><strong>Telegram bot connection</strong><p>Connect the official bot that is allowed to send to this destination.</p></div>
        <span class="${connected ? "conn-on" : "conn-off"}">${connected ? "Connected" : "Required for live"}</span>
      </div>
      <div class="grid grid-2">
        <div><span class="label">Bot token <span>from @BotFather</span></span><div class="secret-row" style="grid-template-columns:minmax(0,1fr) auto"><input class="input tnum" id="builder-tg-token" type="password" value="${esc(integ.telegramBotToken)}" placeholder="123456789:AA…" autocomplete="off"/><button class="btn btn-sm" data-act="toggle-secret" data-target="builder-tg-token">Show</button></div></div>
        <div><span class="label">Chat ID</span><input class="input tnum" id="builder-tg-chat" value="${esc(integ.telegramChatId)}" placeholder="123456789, -100… or @channel" autocomplete="off"/></div>
      </div>
      <div class="row wrap mt" style="gap:6px"><button class="btn btn-primary btn-sm" data-act="builder-int-save" data-platform="telegram">Save connection</button><button class="btn btn-sm" data-act="builder-int-verify" data-platform="telegram">Send test message</button>${integ.telegramVerifiedAt ? `<span class="tiny" style="color:#6ee7b7">✓ verified ${fmtDateTime(integ.telegramVerifiedAt, state.settings.timezone)}</span>` : ""}</div>
      <p class="tiny muted mt">The recipient must press Start on your bot first. In groups/channels, add the bot as an administrator.</p>
    </div>`;
  }
  if (d.platform === "whatsapp" || d.platform === "instagram") {
    return `<div class="warn-note" style="grid-column:1/-1"><span>⚠</span><div><b>${plat(d.platform).name} assisted mode:</b> this extension does not automate the website or reuse your login. The scheduler shows each message for review and copy; you confirm the send yourself. Official API automation requires Meta approval.</div></div>`;
  }
  return "";
}

function renderEditor() {
  if (!ui.draft) ui.draft = blankCampaign();
  const d = ui.draft;
  const pv = buildPreview(d, state.settings, Date.now(), 40);
  const liveGate = d.mode === "live" && !isLiveAllowed(d.platform, state.integrations);
  return `
    <div class="row wrap">
      <button class="btn btn-sm" data-act="nav" data-page="campaigns">← Back</button>
      ${d.mode ? modePill(d.mode) : ""}
      <span class="muted small">${existingMeta()}</span>
    </div>
    <div class="split">
      <div class="grid" style="grid-template-columns:1fr">
        <div class="card grid grid-2">
          <div style="grid-column:1/-1"><span class="label">Campaign name</span><input class="input" id="f-name" data-f="name" value="${esc(d.name)}" placeholder="e.g. Onboarding Welcome Flow"/></div>
          <div><span class="label">Platform</span><select class="input" data-f="platform">${PLATFORMS.map((p) => `<option value="${p.id}" ${d.platform === p.id ? "selected" : ""}>${p.name}${p.id === "mock" ? " — sandbox" : p.id === "discord" || p.id === "telegram" ? " — webhook/bot" : " — assisted"}</option>`).join("")}</select></div>
          <div>
            <span class="label">Destination <span>authorized chat / channel only</span></span>
            <div class="row">
              <input class="input grow" id="f-destination" data-f="destination" value="${esc(d.destination)}" placeholder="#channel, chat ID, or use the scanner"/>
              <button class="btn btn-sm" data-act="scan" title="Detect the chat/thread from your active browser tab">⌖ Scan</button>
            </div>
            ${state.scanResult ? `<div class="scan-box mt">Detected: <b>${esc(state.scanResult.label)}</b> · <button class="btn btn-sm btn-primary" data-act="use-scan">Use it</button> <button class="btn btn-plain btn-sm" data-act="clear-scan">✕</button></div>` : ""}
          </div>
          ${builderConnectionHtml(d)}
          <div style="grid-column:1/-1">
            <span class="label">Mode</span>
            <div class="seg"><button class="${d.mode === "test" ? "on" : ""}" data-act="mode" data-m="test">Test (simulated)</button><button class="${d.mode === "live" ? "on" : ""}" data-act="mode" data-m="live">Live</button></div>
            ${liveGate ? `<div class="warn-note mt">Live sending to ${plat(d.platform).name} is blocked until the connection directly above is configured and verified.${d.platform === "whatsapp" || d.platform === "instagram" ? " Use test mode or assisted copy mode." : ""}</div>` : `<p class="tiny muted mt">${d.mode === "test" ? "Every send is simulated locally. Nothing is delivered." : "Real sends go through your connected official integration, with every safeguard applied."}</p>`}
          </div>
          <div><span class="label">Start date & time</span><input class="input tnum" type="datetime-local" data-f="startAt" value="${toLocalInput(d.startAt)}"/></div>
          <div><span class="label">End date <span>optional</span></span><input class="input tnum" type="datetime-local" data-f="endAt" value="${toLocalInput(d.endAt)}"/></div>
          <div><span class="label">Repeats</span><select class="input" data-f="scheduleType"><option value="once" ${d.scheduleType === "once" ? "selected" : ""}>One-time</option><option value="daily" ${d.scheduleType === "daily" ? "selected" : ""}>Daily (re-arm)</option></select></div>
          <div class="grid grid-2" style="gap:8px">
            <div><span class="label">Retries</span><input class="input tnum" type="number" min="0" max="10" data-f="retryLimit" value="${d.retryLimit}"/></div>
            <div><span class="label">Daily cap</span><input class="input tnum" type="number" min="0" data-f="maxPerDay" value="${d.maxPerDay}"/></div>
          </div>
        </div>
        <div class="row between"><span class="title">Message sections</span><button class="btn btn-sm" data-act="sec-add">+ Add section</button></div>
        ${d.sections.map((s, i) => sectionEditorHtml(s, i, d.sections.length)).join("") || `<div class="empty">No sections yet — add one.</div>`}
        <div class="row wrap" style="gap:8px">
          <button class="btn btn-primary" data-act="save-editor">Save campaign</button>
          <button class="btn" data-act="discard-editor">Discard</button>
        </div>
      </div>
      <div class="card" style="position:sticky;top:74px">
        <span class="title">Schedule preview</span>
        <div class="grid grid-2 mt">
          <div class="card" style="padding:8px;text-align:center"><b class="tnum" style="font-size:18px;color:#fff">${pv.totalActions}</b><div class="tiny muted">MESSAGES</div></div>
          <div class="card" style="padding:8px;text-align:center"><b class="tnum" style="font-size:18px;color:#fff">${pv.end ? fmtCountdown(pv.end - Date.now()) : "—"}</b><div class="tiny muted">RUN TIME</div></div>
        </div>
        <div class="mt" style="max-height:300px;overflow-y:auto">
          ${pv.items.slice(0, 20).map((it) => `<div class="row" style="gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)">
            <span class="tnum tiny" style="width:56px;color:#67e8f9" data-ts="${it.ts}">${fmtCountdown(it.ts - Date.now())}</span>
            <div class="grow"><div class="small clamp">${esc(it.sectionTitle)} <span class="muted">${it.rep}/${it.total}</span></div><div class="tiny muted clamp">“${esc(it.message)}”</div></div></div>`).join("") || `<div class="empty">Add an enabled section to see the timeline.</div>`}
        </div>
        <p class="tiny muted mt">Timers are best-effort, never exact. Quiet hours hold actions automatically.</p>
      </div>
    </div>`;

  function existingMeta() {
    const ex = findCmp(d.id);
    if (!ex) return "New campaign — not saved yet";
    if (["running", "scheduled", "paused"].includes(ex.status)) return "Saving will pause this campaign for review";
    return `Editing “${ex.name}”`;
  }
}

/* ------------------------------ sections --------------------------- */

function renderSections() {
  if (state.campaigns.length === 0) return `<div class="empty">Sections live inside campaigns. Create a campaign first.</div>`;
  return state.campaigns.map((c) => {
    const t = campaignTotals(c);
    return `<div class="card" style="padding:0;overflow:hidden">
      <div class="row wrap" style="padding:12px 16px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.02)">
        <span class="title grow clamp">${esc(c.name)}</span>${pill(c.status)} ${chip(c.platform)}
        <span class="tiny muted tnum">${t.done}/${t.total} messages</span>
        <button class="btn btn-plain btn-sm" data-act="edit" data-id="${c.id}">Edit →</button>
      </div>
      ${c.sections.map((s, i) => {
        const p = s.repetitions === 0 ? 0 : Math.min(100, Math.round((Math.min(s.progress, s.repetitions) / s.repetitions) * 100));
        return `<div style="padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.04);${s.enabled ? "" : "opacity:.5"}">
          <div class="row wrap"><span class="sec-idx tnum">${i + 1}</span><b class="small" style="color:#e2e8f0">${esc(s.title || `Section ${i + 1}`)}</b>
          ${secPill(s.enabled ? s.status : "skipped")}
          <span class="tiny muted" style="margin-left:auto">${s.repetitions}× · every ${fmtSecs(s.intervalSec)}${s.delayAfterSec > 0 ? ` · +${fmtSecs(s.delayAfterSec)} after` : ""}</span></div>
          <div class="tiny muted clamp" style="margin-left:30px">“${esc(s.message)}”</div>
          <div class="row" style="margin-left:30px;margin-top:6px"><div class="progress grow"><i style="width:${p}%"></i></div><span class="tnum tiny muted">${Math.min(s.progress, s.repetitions)}/${s.repetitions}</span></div>
        </div>`;
      }).join("")}
    </div>`;
  }).join("");
}

/* ------------------------------ platforms -------------------------- */

function renderPlatforms() {
  const integ = state.integrations;
  const dc = isLiveAllowed("discord", integ);
  const tg = isLiveAllowed("telegram", integ);
  return `
    <div class="info-note"><span>ⓘ</span><div><b>Honest integrations only.</b> Paste credentials for official APIs you own — they are stored only in this browser (chrome.storage / localStorage), masked, never logged, and sent nowhere except the official platform endpoint. WhatsApp & Instagram stay assisted: automation there requires Meta app approval, so we copy messages for you to send manually instead of faking it.</div></div>

    <div class="grid grid-2">
      <div class="card">
        <div class="row"><span class="plat-ic plat-mock">M</span><div class="grow"><b class="small" style="color:#fff">Sandbox (Mock)</b><div class="tiny muted">Simulated sends, zero network</div></div><span class="conn-on">Ready</span></div>
        <p class="tiny muted mt">Used by test-mode campaigns. Include <code class="k">[fail]</code> in a message to simulate a retryable delivery failure.</p>
      </div>

      <div class="card" id="discordIntegration">
        <div class="row"><span class="plat-ic plat-discord">D</span><div class="grow"><b class="small" style="color:#fff">Discord — Incoming Webhook</b><div class="tiny muted">Posts into one channel you control</div></div>
        <span class="${dc ? "conn-on" : "conn-off"}">${dc ? "Connected" : "Not configured"}</span></div>
        <ol class="setup">
          <li>In your Discord server: <b> channel ⚙ → Integrations → Webhooks → New Webhook</b>.</li>
          <li>Click the webhook → <b>Copy Webhook URL</b>.</li>
          <li>Paste it below. Each webhook targets its own channel — create more webhooks for other channels.</li>
        </ol>
        <span class="label mt">Webhook URL <span>stored locally, masked</span></span>
        <input class="input tnum" id="int-dc-wh" type="password" placeholder="https://discord.com/api/webhooks/…" value="${esc(integ.discordWebhookUrl)}" autocomplete="off"/>
        <div class="row mt wrap" style="gap:6px">
          <button class="btn btn-sm btn-primary" data-act="int-save" data-platform="discord">Save</button>
          <button class="btn btn-sm" data-act="int-verify" data-platform="discord" ${dc ? "" : "disabled"}>${ui.verifying === "discord" ? "Verifying…" : "Send test message"}</button>
          ${integ.discordVerifiedAt ? `<span class="tiny" style="color:#6ee7b7">✓ verified ${fmtDateTime(integ.discordVerifiedAt, state.settings.timezone)}</span>` : ""}
        </div>
        ${dc ? `<p class="tiny muted mt">Active: <code class="k">${esc(redactUrl(integ.discordWebhookUrl))}</code></p>` : ""}
      </div>

      <div class="card">
        <div class="row"><span class="plat-ic plat-telegram">T</span><div class="grow"><b class="small" style="color:#fff">Telegram — Bot API</b><div class="tiny muted">Bot you created via @BotFather</div></div>
        <span class="${tg ? "conn-on" : "conn-off"}">${tg ? "Connected" : "Not configured"}</span></div>
        <ol class="setup">
          <li>Message <code class="k">@BotFather</code> → <code class="k">/newbot</code> → copy the token.</li>
          <li>For DMs: the user must press <b>Start</b> on your bot. Get their chat id via <code class="k">@userinfobot</code> or the scanner.</li>
          <li>For groups/channels: add the bot as <b>admin</b>; group ids look like <code class="k">-100…</code>.</li>
        </ol>
        <span class="label mt">Bot token</span>
        <input class="input tnum" id="int-tg-token" type="password" placeholder="123456789:AA…" value="${esc(integ.telegramBotToken)}" autocomplete="off"/>
        <span class="label mt">Chat ID</span>
        <input class="input tnum" id="int-tg-chat" placeholder="123456789 or -100… or @channel" value="${esc(integ.telegramChatId)}" autocomplete="off"/>
        <div class="row mt wrap" style="gap:6px">
          <button class="btn btn-sm btn-primary" data-act="int-save" data-platform="telegram">Save</button>
          <button class="btn btn-sm" data-act="int-verify" data-platform="telegram" ${tg ? "" : "disabled"}>${ui.verifying === "telegram" ? "Verifying…" : "Send test message"}</button>
          ${integ.telegramVerifiedAt ? `<span class="tiny" style="color:#6ee7b7">✓ verified ${fmtDateTime(integ.telegramVerifiedAt, state.settings.timezone)}</span>` : ""}
        </div>
      </div>

      <div class="card">
        <div class="row"><span class="plat-ic plat-whatsapp">W</span><div class="grow"><b class="small" style="color:#fff">WhatsApp</b><div class="tiny muted">Business Cloud API only</div></div><span class="conn-assist">Assisted</span></div>
        <p class="tiny muted mt">Automated sending requires a verified Meta Business + approved templates (24h messaging window). The extension never automates WhatsApp Web. Live campaigns here pause for <b>manual confirmation</b>: we show the message and copy it — you press send yourself. No faking, no scraping.</p>
      </div>

      <div class="card">
        <div class="row"><span class="plat-ic plat-instagram">I</span><div class="grow"><b class="small" style="color:#fff">Instagram</b><div class="tiny muted">Messenger API (app review)</div></div><span class="conn-assist">Assisted</span></div>
        <p class="tiny muted mt">DM automation requires the Messenger API for Instagram with Advanced Access (Meta App Review) and a professional account — plus the user must message you first. Until then: assisted copy mode only.</p>
      </div>

      <div class="card">
        <span class="title">⌖ Thread scanner</span>
        <p class="tiny muted mt">Detects the chat/channel from your <b>active browser tab</b> — Discord <code class="k">/channels/…</code>, Telegram <code class="k">web.telegram.org</code>, WhatsApp Web, Instagram DM threads — and offers it as a campaign destination.${hasTabs ? "" : " (Running outside the extension: paste the tab URL manually.)"}</p>
        <div class="row mt wrap" style="gap:6px">
          <button class="btn btn-sm btn-primary" data-act="scan">Scan active tab</button>
          <button class="btn btn-sm" data-act="scan-url">Paste a URL instead</button>
        </div>
        ${state.scanResult ? `<div class="scan-box mt">Detected: <b>${esc(state.scanResult.label)}</b> (${esc(state.scanResult.platform)}) <div class="row mt" style="gap:6px"><button class="btn btn-sm" data-act="copy-scan">Copy</button><button class="btn btn-plain btn-sm" data-act="clear-scan">Clear</button></div></div>` : ""}
      </div>
    </div>`;
}

/* ------------------------------ schedule --------------------------- */

const COMMON_TZ = ["UTC","Europe/London","Europe/Berlin","Europe/Moscow","Africa/Lagos","Asia/Dubai","Asia/Karachi","Asia/Kolkata","Asia/Bangkok","Asia/Shanghai","Asia/Tokyo","Australia/Sydney","America/Sao_Paulo","America/New_York","America/Chicago","America/Los_Angeles"];

function renderSchedule() {
  const s = state.settings;
  const rows = state.campaigns
    .filter((c) => c.status === "running" || c.status === "scheduled")
    .map((c) => ({ c, pv: buildPreview(c, s, Date.now(), 5) }));
  rows.sort((a, b) => (a.pv.items[0]?.ts ?? Infinity) - (b.pv.items[0]?.ts ?? Infinity));
  const tzOptions = Array.from(new Set([s.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", ...COMMON_TZ]));
  return `
    <div class="split">
      <div class="grid" style="grid-template-columns:1fr">
        ${rows.length === 0 ? `<div class="empty">Nothing scheduled. Start or schedule a campaign to populate the timeline.</div>` : rows.map(({ c, pv }) => `
          <div class="card" style="padding:0;overflow:hidden">
            <div class="row wrap" style="padding:10px 14px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.02)">
              <b class="small grow clamp" style="color:#fff">${esc(c.name)}</b>${chip(c.platform)}
              <span class="tiny muted">${c.scheduleType === "daily" ? "Repeats daily" : "One-time"} · remaining ${pv.totalActions}</span>
            </div>
            ${pv.items.map((it, i) => `<div class="row" style="gap:10px;padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.04)">
              <span class="tnum small" style="width:80px;color:${i === 0 ? "#67e8f9" : "#94a3b8"}" data-ts="${it.ts}">${fmtCountdown(it.ts - Date.now())}</span>
              <div class="grow"><div class="small clamp">${esc(it.sectionTitle)} · rep ${it.rep}/${it.total}</div><div class="tiny muted clamp">“${esc(it.message)}”</div></div>
              <span class="tnum tiny muted">${fmtDateTime(it.ts, s.timezone)}</span></div>`).join("") || `<div class="empty" style="margin:10px">No pending actions.</div>`}
          </div>`).join("")}
      </div>
      <div class="grid" style="grid-template-columns:1fr">
        <div class="card">
          <span class="title">Timezone</span>
          <select class="input mt" data-set="timezone">${tzOptions.map((tz) => `<option ${tz === s.timezone ? "selected" : ""}>${tz}</option>`).join("")}</select>
          <p class="tiny muted mt">All countdowns, quiet hours and previews use this zone. Timers are best-effort, never exact.</p>
        </div>
        <div class="card">
          <div class="row between"><span class="title">Quiet hours</span><input type="checkbox" data-set="quietEnabled" ${s.quietEnabled ? "checked" : ""}/></div>
          <div class="grid grid-2 mt">
            <div><span class="label">From</span><input class="input tnum" type="time" data-set="quietStart" value="${esc(s.quietStart)}" ${s.quietEnabled ? "" : "disabled"}/></div>
            <div><span class="label">To</span><input class="input tnum" type="time" data-set="quietEnd" value="${esc(s.quietEnd)}" ${s.quietEnabled ? "" : "disabled"}/></div>
          </div>
          <p class="tiny muted mt">Scheduled actions are held during quiet hours and resume automatically afterwards.</p>
        </div>
      </div>
    </div>`;
}

/* -------------------------------- logs ----------------------------- */

function renderLogList() {
  const el = document.getElementById("logList");
  if (!el) return;
  const { level, platform, q } = ui.logFilter;
  const needle = q.trim().toLowerCase();
  const rows = state.logs.filter((l) =>
    (level === "all" || l.level === level) &&
    (platform === "all" || l.platform === platform) &&
    (!needle || l.text.toLowerCase().includes(needle) || (l.campaignName || "").toLowerCase().includes(needle)));
  el.innerHTML = rows.slice(0, 250).map(logRow).join("") || `<div class="empty">No log entries match.</div>`;
  const cnt = document.getElementById("logCount");
  if (cnt) cnt.textContent = `${rows.length} of ${state.logs.length} entries`;
}

function renderLogs() {
  const f = ui.logFilter;
  const levels = ["all", "success", "test", "info", "warn", "error", "skip"];
  return `
    <div class="card row wrap" style="gap:6px">
      ${levels.map((lv) => `<button class="btn btn-sm ${f.level === lv ? "btn-primary" : ""}" data-act="log-level" data-l="${lv}">${lv}</button>`).join("")}
      <select class="input" style="width:auto" data-lf="platform">
        <option value="all" ${f.platform === "all" ? "selected" : ""}>All platforms</option>
        <option value="system" ${f.platform === "system" ? "selected" : ""}>System</option>
        ${PLATFORMS.map((p) => `<option value="${p.id}" ${f.platform === p.id ? "selected" : ""}>${p.name}</option>`).join("")}
      </select>
      <input class="input grow" id="logSearch" data-lf="q" placeholder="Search messages or campaigns…" value="${esc(f.q)}"/>
      <button class="btn btn-sm" data-act="export-logs">Export</button>
      <button class="btn btn-sm" data-act="clear-logs">Clear</button>
      <span class="tiny muted" id="logCount" style="margin-left:auto"></span>
    </div>
    <div class="card" style="padding:0" id="logListWrap"><div id="logList"></div></div>`;
}

/* ------------------------------ settings --------------------------- */

function renderSettings() {
  const s = state.settings;
  return `
    <div class="grid grid-2">
      <div class="card">
        <span class="title">Safety & control</span>
        <div class="row between mt"><div class="grow"><b class="small" style="color:#e2e8f0">Confirm every live message</b><div class="tiny muted">Live campaigns wait for your approval before each send.</div></div><input type="checkbox" data-set="manualConfirm" ${s.manualConfirm ? "checked" : ""}/></div>
        <div class="row between mt"><div class="grow"><b class="small" style="color:#e2e8f0">Require consent declaration</b><div class="tiny muted">Live starts require confirming recipients opted in.</div></div><input type="checkbox" data-set="requireConsent" ${s.requireConsent ? "checked" : ""}/></div>
        <div class="row between mt"><div class="grow"><b class="small" style="color:#e2e8f0">Global daily send limit</b><div class="tiny muted">Across all campaigns. 0 = unlimited. Used today: <span class="tnum">${state.daily.count}</span></div></div><input class="input tnum" style="width:90px" type="number" min="0" data-set="maxPerDay" value="${s.maxPerDay}"/></div>
        <div class="warn-note mt">MessageFlow AI never sends unsolicited bulk messages and never bypasses rate limits, CAPTCHAs or platform blocks. Platform policies always win.</div>
      </div>
      <div class="card">
        <span class="title">Data management</span>
        <p class="tiny muted mt">Campaigns, progress, logs, settings and integration credentials live in <b>${hasTabs ? "chrome.storage (extension)" : "localStorage (browser preview)"}</b> — nothing is synced anywhere.</p>
        <div class="grid grid-2 mt" style="gap:8px">
          <button class="btn" data-act="export-data">Export backup</button>
          <button class="btn" data-act="import-data">Import backup</button>
          <button class="btn" data-act="load-demo">Load demo data</button>
          <button class="btn btn-danger" data-act="wipe-ask">Wipe everything</button>
        </div>
        <hr class="hr"/>
        <b class="small" style="color:#e2e8f0">About this build</b>
        <div class="row between tiny mt"><span class="muted">Version</span><span class="tnum">1.1.0 · MV3</span></div>
        <div class="row between tiny mt"><span class="muted">Real integrations</span><span>Discord webhooks · Telegram Bot API</span></div>
        <div class="row between tiny mt"><span class="muted">Assisted only</span><span>WhatsApp · Instagram</span></div>
        <div class="row between tiny mt"><span class="muted">Background scheduling</span><span>chrome.alarms (~30s, best-effort)</span></div>
      </div>
    </div>`;
}

/* ------------------------------- modals ---------------------------- */

function openModal(html, wide) {
  document.getElementById("modalRoot").innerHTML =
    `<div class="modal-bg" data-act=""><div class="modal card ${wide ? "modal-wide" : ""}" >${html}</div></div>`;
  document.querySelector(".modal-bg").addEventListener("mousedown", (e) => { if (e.target.classList.contains("modal-bg")) closeModal(); });
}
function closeModal() {
  ui.startId = ui.deleteId = ui.previewId = null;
  ui.stopAsk = ui.scanAskUrl = false;
  ui.scanCandidates = null;
  document.getElementById("modalRoot").innerHTML = "";
}

function renderStartModal() {
  const c = findCmp(ui.startId);
  if (!c) return closeModal();
  const t = campaignTotals(c);
  const blocked = c.mode === "live" && !isLiveAllowed(c.platform, state.integrations);
  if (blocked) {
    openModal(`
      <span class="title">Integration required</span>
      <div class="warn-note mt"><span>⚠</span><div><b>${plat(c.platform).name}</b> is not connected. Live sending is only possible through the official integration — MessageFlow AI never fakes a connection.</div></div>
      <div class="row mt-lg wrap" style="justify-content:flex-end;gap:6px">
        <button class="btn btn-sm" data-act="modal-close">Close</button>
        <button class="btn btn-sm" data-act="goto-platforms">Open Platforms</button>
      </div>`);
    return;
  }
  const willStartNow = c.startAt <= Date.now() || c.status === "scheduled";
  openModal(`
    <span class="title">${c.mode === "live" ? "Confirm live campaign" : "Start test campaign"}</span>
    <div class="card mt" style="background:rgba(0,0,0,.3)">
      <div class="row between"><b class="small" style="color:#fff">${esc(c.name)}</b>${modePill(c.mode)}</div>
      <div class="tiny muted mt">Platform: ${plat(c.platform).name}</div>
      <div class="tiny mt" style="color:#94a3b8">Destination: <b style="color:#e2e8f0">${esc(c.destination)}</b></div>
      <div class="tiny muted mt">Messages: ${t.total} across ${c.sections.filter((s) => s.enabled).length} sections · retries ${c.retryLimit}</div>
      <div class="tiny muted mt">Start: ${willStartNow ? "Immediately" : fmtDateTime(c.startAt, state.settings.timezone)} ${c.scheduleType === "daily" ? "· repeats daily" : ""}</div>
      <hr class="hr"/>
      ${c.sections.filter((s) => s.enabled).slice(0, 4).map((s) => `<div class="tiny muted clamp">“${esc(s.message)}” ×${s.repetitions} / ${fmtSecs(s.intervalSec)}</div>`).join("")}
    </div>
    ${c.mode === "live" && state.settings.requireConsent ? `<label class="ok-note info-note mt row" style="cursor:pointer;align-items:flex-start"><input type="checkbox" id="consentCk" style="margin-top:3px"/> <span class="small">I confirm recipients explicitly consented, and this flow complies with ${plat(c.platform).name} policies, rate limits and messaging windows.</span></label>` : ""}
    ${c.mode === "test" ? `<p class="tiny muted mt">Test mode simulates every send locally — nothing is delivered to anyone.</p>` : ""}
    <div class="row mt-lg wrap" style="justify-content:flex-end;gap:6px">
      <button class="btn btn-sm" data-act="modal-close">Cancel</button>
      <button class="btn btn-sm ${c.mode === "live" ? "btn-success" : "btn-primary"}" data-act="start-confirm" data-id="${c.id}">▶ ${willStartNow ? "Start now" : "Schedule"}</button>
    </div>`);
}

function renderPreviewModal() {
  const c = findCmp(ui.previewId);
  if (!c) return closeModal();
  const pv = buildPreview(c, state.settings, Date.now(), 60);
  openModal(`
    <span class="title">Schedule preview — ${esc(c.name)}</span>
    <div class="row wrap mt small muted">${chip(c.platform)} <span>→ ${esc(c.destination)}</span> ${modePill(c.mode)} ${pv.truncated ? `<span class="tiny">showing 60 of ${pv.totalActions}</span>` : ""}</div>
    <div class="mt" style="max-height:46vh;overflow-y:auto">
      ${pv.items.map((it, i) => `<div class="row" style="gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.04)">
        <span class="tnum tiny" style="width:64px;color:${i === 0 ? "#67e8f9" : "#94a3b8"}" data-ts="${it.ts}">${fmtCountdown(it.ts - Date.now())}</span>
        <div class="grow"><div class="small clamp">${esc(it.sectionTitle)} <span class="muted">· ${it.rep}/${it.total}</span></div><div class="tiny muted clamp">“${esc(it.message)}”</div></div>
        <span class="tnum tiny muted">${fmtDateTime(it.ts, state.settings.timezone)}</span></div>`).join("") || `<div class="empty">No pending actions.</div>`}
    </div>
    ${pv.end ? `<p class="tiny muted mt">Estimated completion: <b style="color:#e2e8f0">${fmtDateTime(pv.end, state.settings.timezone)}</b> — includes quiet-hour holds; never exact.</p>` : ""}
    <div class="row mt" style="justify-content:flex-end"><button class="btn btn-sm" data-act="modal-close">Close</button></div>`, true);
}

function renderDeleteModal() {
  const c = findCmp(ui.deleteId);
  if (!c) return closeModal();
  openModal(`
    <span class="title">Delete campaign?</span>
    <p class="small muted mt"><b style="color:#e2e8f0">${esc(c.name)}</b> and its ${c.sections.length} sections will be permanently removed.</p>
    <div class="row mt-lg wrap" style="justify-content:flex-end;gap:6px">
      <button class="btn btn-sm" data-act="modal-close">Cancel</button>
      <button class="btn btn-sm btn-danger" data-act="delete-confirm" data-id="${c.id}">Delete</button>
    </div>`);
}

function renderStopModal() {
  const n = state.campaigns.filter((c) => c.status === "running" || c.status === "scheduled").length + state.confirmQueue.length;
  openModal(`
    <span class="title">Stop all activity?</span>
    <p class="small muted mt">This pauses <b style="color:#e2e8f0">${n}</b> active/scheduled item(s) and discards pending confirmations. Progress is preserved — resume anytime.</p>
    <div class="row mt-lg wrap" style="justify-content:flex-end;gap:6px">
      <button class="btn btn-sm" data-act="modal-close">Cancel</button>
      <button class="btn btn-sm btn-danger" data-act="stopall-confirm" ${n === 0 ? "disabled" : ""}>■ Stop everything</button>
    </div>`);
}

function renderScanUrlModal() {
  openModal(`
    <span class="title">Scan a URL for a chat / thread</span>
    <p class="tiny muted mt">Paste the URL of a Discord channel, Telegram Web chat, WhatsApp Web chat or Instagram DM thread.</p>
    <input class="input tnum mt" id="scanUrlInput" placeholder="https://discord.com/channels/…"/>
    <div class="row mt-lg wrap" style="justify-content:flex-end;gap:6px">
      <button class="btn btn-sm" data-act="modal-close">Cancel</button>
      <button class="btn btn-sm btn-primary" data-act="scan-url-go">Detect</button>
    </div>`);
}

function renderScanCandidatesModal() {
  const candidates = ui.scanCandidates || [];
  openModal(`
    <span class="title">Choose an open messaging thread</span>
    <p class="tiny muted mt">The dashboard tab itself is ignored. These supported chats were found in your current browser window.</p>
    <div class="grid mt" style="grid-template-columns:1fr;max-height:46vh;overflow-y:auto">
      ${candidates.map((c, i) => `<button class="scan-candidate" data-act="scan-candidate" data-i="${i}">
        <span class="plat-ic plat-${plat(c.result.platform).cls}" style="width:32px;height:32px">${plat(c.result.platform).letter}</span>
        <span class="meta"><b>${esc(c.result.label)}</b><span>${esc(c.title || c.url)}</span></span>
        <span class="tiny muted">Use →</span>
      </button>`).join("")}
    </div>
    <div class="row mt-lg wrap" style="justify-content:flex-end;gap:6px"><button class="btn btn-sm" data-act="modal-close">Cancel</button><button class="btn btn-sm" data-act="scan-url">Paste URL instead</button></div>`, true);
}

function refreshModal() {
  if (ui.startId) return renderStartModal();
  if (ui.previewId) return renderPreviewModal();
  if (ui.deleteId) return renderDeleteModal();
  if (ui.stopAsk) return renderStopModal();
  if (ui.scanAskUrl) return renderScanUrlModal();
  if (ui.scanCandidates?.length) return renderScanCandidatesModal();
}

/* ---------------------------- confirm bar -------------------------- */

function renderConfirmBar() {
  const bar = document.getElementById("confirmBar");
  const q = state.confirmQueue[0];
  if (!q) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML = `
    <div class="row between"><b class="tiny" style="color:#a5b4fc;text-transform:uppercase;letter-spacing:.12em">● Manual confirmation required</b>
    ${state.confirmQueue.length > 1 ? `<span class="tiny muted">Queue: ${state.confirmQueue.length}</span>` : ""}</div>
    <div class="row mt small muted wrap" style="gap:6px">${chip(q.platform)} <span class="clamp"><b style="color:#e2e8f0">${esc(q.campaignName)}</b> → ${esc(q.destination)} · rep ${q.rep}</span></div>
    <div class="card mt small" style="background:rgba(0,0,0,.35);padding:9px 11px">“${esc(q.message)}”</div>
    <div class="row mt wrap" style="justify-content:flex-end;gap:6px">
      <button class="btn btn-sm" data-act="confirm-copy" data-key="${q.key}">Copy</button>
      <button class="btn btn-sm" data-act="confirm-skip" data-key="${q.key}">Skip</button>
      <button class="btn btn-sm btn-success" data-act="confirm-approve" data-key="${q.key}">✓ Approve & send</button>
    </div>`;
}

/* ------------------------------- actions --------------------------- */

function doStart(id) {
  const c = findCmp(id);
  if (!c) return;
  const now = Date.now();
  if (c.status === "failed" || c.status === "completed") {
    for (const s of c.sections) { s.progress = 0; s.status = "pending"; s.lastSentAt = null; }
    c.attempts = {}; c.lastActionKey = null; c.inFlight = null;
  }
  const startNow = c.startAt <= now || c.status === "scheduled";
  if (!startNow) {
    c.status = "scheduled"; c.nextActionAt = c.startAt;
    pushLog(state, { level: "info", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Scheduled — starts ${fmtDateTime(c.startAt, state.settings.timezone)}` });
    note("Campaign scheduled");
  } else {
    c.status = "running"; c.nextActionAt = now + 800; c.qhLoggedAt = undefined;
    pushLog(state, { level: "info", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Campaign started${c.mode === "test" ? " (test mode — simulated sends)" : ""}` });
    ok(c.mode === "test" ? "Started in simulation mode" : "Live campaign started");
  }
  c.updatedAt = now; save(); rerender();
}

async function runScan(url) {
  const found = scanThreadUrl(url || "");
  state.scanResult = found ? { ...found, url } : null;
  if (!found) note("No chat/thread detected", "The URL didn't match Discord, Telegram, WhatsApp or Instagram patterns.");
  else {
    // In the sender, scanning is an action: fill the destination immediately.
    if (ui.page === "editor" && ui.draft) {
      ui.draft.destination = found.id;
      ui.draft.platform = found.platform;
      ok("Thread connected", `${found.label} is now the campaign destination.`);
    } else {
      ok("Detected: " + found.label, "Open a campaign editor to use this destination.");
    }
  }
  save(); rerender();
}

async function scanOpenMessagingTabs() {
  if (!hasTabs) { ui.scanAskUrl = true; renderScanUrlModal(); return; }
  try {
    // The dashboard is the active tab after the user switches here, so scan
    // every tab in the window and ignore extension pages instead of checking
    // only the active tab (which can never be the chat at this point).
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const candidates = tabs
      .map((tab) => ({
        url: tab.url || "",
        title: tab.title || "",
        active: Boolean(tab.active),
        lastAccessed: Number(tab.lastAccessed || 0),
        result: scanThreadUrl(tab.url || ""),
      }))
      .filter((x) => x.result)
      .sort((a, b) => {
        const preferred = ui.draft?.platform;
        const ap = a.result.platform === preferred ? 1 : 0;
        const bp = b.result.platform === preferred ? 1 : 0;
        return bp - ap || b.lastAccessed - a.lastAccessed;
      });
    if (candidates.length === 0) {
      note("No open messaging thread found", "Open a Discord, Telegram, WhatsApp or Instagram chat in this browser window, then scan again.");
      return;
    }
    if (candidates.length === 1) {
      await runScan(candidates[0].url);
      return;
    }
    ui.scanCandidates = candidates;
    renderScanCandidatesModal();
  } catch {
    bad("Thread scan failed", "Reload the extension and confirm the Tabs permission.");
  }
}

const DISCORD_WEBHOOK_RE = /^https:\/\/(canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/;

function saveIntegrationForm(platform, prefix, { quiet = false } = {}) {
  if (platform === "discord") {
    const value = (document.getElementById(`${prefix}-dc-wh`)?.value || "").trim();
    if (!value) { bad("Discord webhook required", "Paste the webhook URL for the destination channel."); return false; }
    if (!DISCORD_WEBHOOK_RE.test(value)) {
      bad("Invalid Discord webhook", "Expected https://discord.com/api/webhooks/{id}/{token}");
      return false;
    }
    state.integrations.discordWebhookUrl = value;
    state.integrations.discordVerifiedAt = null;
    pushLog(state, { level: "info", platform: "discord", text: `Discord webhook saved (${redactUrl(value)})` });
  } else if (platform === "telegram") {
    const token = (document.getElementById(`${prefix}-tg-token`)?.value || "").trim();
    const chatId = (document.getElementById(`${prefix}-tg-chat`)?.value || "").trim();
    if (!token || !chatId) { bad("Telegram connection incomplete", "Bot token and Chat ID are both required."); return false; }
    state.integrations.telegramBotToken = token;
    state.integrations.telegramChatId = chatId;
    state.integrations.telegramVerifiedAt = null;
    pushLog(state, { level: "info", platform: "telegram", text: "Telegram bot connection saved (token hidden)" });
  } else return false;
  save();
  if (!quiet) ok("Connection saved", "Stored only in this browser and never written to logs.");
  return true;
}

async function verifyIntegrationForm(platform, prefix) {
  // Save what is currently pasted first — users should not have to guess that
  // “test” only sees an older saved value.
  if (!saveIntegrationForm(platform, prefix, { quiet: true })) return;
  ui.verifying = platform;
  rerender();
  try {
    await verifyIntegration(platform, state.integrations);
    if (platform === "discord") state.integrations.discordVerifiedAt = Date.now();
    else state.integrations.telegramVerifiedAt = Date.now();
    pushLog(state, { level: "success", platform, text: "Integration verified — test message delivered" });
    ok("Connection verified", platform === "discord" ? "The test message reached your Discord webhook channel." : "The test message reached your Telegram chat.");
  } catch (err) {
    pushLog(state, { level: "error", platform, text: `Integration verification failed — ${String(err?.message || err)}` });
    bad("Verification failed", String(err?.message || err));
  }
  ui.verifying = null;
  save();
  rerender();
}

const actions = {
  nav: (el) => { ui.page = el.dataset.page; ui.draft = null; rerender(); },
  filter: (el) => { ui.filter = el.dataset.f; rerender(); },

  "edit-new": () => { ui.draft = blankCampaign(); ui.page = "editor"; rerender(); },
  edit: (el) => { const c = findCmp(el.dataset.id); if (!c) return; ui.draft = clone(c); ui.page = "editor"; rerender(); },
  mode: (el) => { if (ui.draft) { ui.draft.mode = el.dataset.m; rerender(); } },

  "sec-add": () => {
    if (!ui.draft) return;
    ui.draft.sections.push({ id: uid("sec"), title: `Section ${ui.draft.sections.length + 1}`, message: "", repetitions: 3, intervalSec: 30, delayAfterSec: 0, startAt: null, enabled: true, progress: 0, status: "pending", lastSentAt: null });
    rerender();
  },
  "sec-del": (el) => { if (!ui.draft) return; ui.draft.sections.splice(Number(el.dataset.i), 1); rerender(); },
  "sec-move": (el) => {
    if (!ui.draft) return;
    const i = Number(el.dataset.i), to = i + Number(el.dataset.d);
    if (to < 0 || to >= ui.draft.sections.length) return;
    const arr = ui.draft.sections; [arr[i], arr[to]] = [arr[to], arr[i]];
    rerender();
  },
  "save-editor": () => {
    const d = ui.draft;
    if (!d) return;
    const errs = validateCampaign(d);
    if (errs.length) { bad("Fix validation errors", errs[0]); return; }
    const now = Date.now();
    const i = state.campaigns.findIndex((x) => x.id === d.id);
    if (i === -1) {
      state.campaigns.unshift({ ...clone(d), createdAt: now, updatedAt: now, status: "draft" });
      pushLog(state, { level: "info", platform: d.platform, campaignId: d.id, campaignName: d.name, text: "Campaign created" });
    } else {
      const prev = state.campaigns[i];
      const next = clone(d);
      for (const s of next.sections) {
        const old = prev.sections.find((o) => o.id === s.id);
        if (old) { s.progress = Math.min(old.progress, s.repetitions); s.status = old.progress >= s.repetitions ? "done" : old.status === "done" ? "pending" : old.status; s.lastSentAt = old.lastSentAt; }
      }
      next.sentTotal = prev.sentTotal; next.failTotal = prev.failTotal; next.dayCount = prev.dayCount;
      next.createdAt = prev.createdAt; next.updatedAt = now;
      next.inFlight = null; next.inFlightAt = undefined; next.nextActionAt = null; next.attempts = {}; next.lastActionKey = prev.lastActionKey;
      if (["running", "scheduled", "paused"].includes(prev.status)) {
        next.status = "paused";
        pushLog(state, { level: "info", platform: next.platform, campaignId: next.id, campaignName: next.name, text: "Campaign edited — paused for review" });
      } else next.status = prev.status;
      state.campaigns[i] = next;
    }
    ui.draft = null; ui.page = "campaigns";
    save(); rerender();
    ok("Campaign saved");
  },
  "discard-editor": () => { ui.draft = null; ui.page = "campaigns"; rerender(); },

  "start-ask": (el) => {
    const c = findCmp(el.dataset.id);
    if (!c) return;
    const errs = validateCampaign(c);
    if (errs.length) { bad("Campaign is incomplete", errs[0]); ui.draft = clone(c); ui.page = "editor"; rerender(); return; }
    ui.startId = c.id; renderStartModal();
  },
  "start-confirm": (el) => {
    const c = findCmp(el.dataset.id);
    if (!c) return;
    if (c.mode === "live" && state.settings.requireConsent) {
      const ck = document.getElementById("consentCk");
      if (ck && !ck.checked) { bad("Consent declaration required"); return; }
    }
    closeModal(); doStart(c.id);
  },
  pause: (el) => { const c = findCmp(el.dataset.id); if (!c || !["running", "scheduled"].includes(c.status)) return; c.status = "paused"; c.nextActionAt = null; c.qhLoggedAt = undefined; pushLog(state, { level: "info", platform: c.platform, campaignId: c.id, campaignName: c.name, text: "Campaign paused" }); save(); rerender(); note("Campaign paused"); },
  resume: (el) => { const c = findCmp(el.dataset.id); if (!c || c.status !== "paused") return; c.status = "running"; c.nextActionAt = Date.now() + 800; c.qhLoggedAt = undefined; pushLog(state, { level: "info", platform: c.platform, campaignId: c.id, campaignName: c.name, text: "Campaign resumed" }); save(); rerender(); ok("Campaign resumed"); },
  reset: (el) => { const c = findCmp(el.dataset.id); if (!c) return; for (const s of c.sections) { s.progress = 0; s.status = "pending"; s.lastSentAt = null; } c.status = "draft"; c.nextActionAt = null; c.inFlight = null; c.lastActionKey = null; c.attempts = {}; pushLog(state, { level: "info", platform: c.platform, campaignId: c.id, campaignName: c.name, text: "Campaign reset to draft" }); save(); rerender(); },
  duplicate: (el) => {
    const c = findCmp(el.dataset.id); if (!c) return;
    const copy = clone(c);
    copy.id = uid("cmp"); copy.name = c.name + " (copy)";
    copy.sections = copy.sections.map((s) => ({ ...s, id: uid("sec"), progress: 0, status: "pending", lastSentAt: null }));
    copy.status = "draft"; copy.nextActionAt = null; copy.inFlight = null; copy.lastActionKey = null; copy.attempts = {};
    copy.sentTotal = 0; copy.failTotal = 0; copy.dayCount = { date: "", count: 0 }; copy.createdAt = Date.now(); copy.updatedAt = Date.now();
    state.campaigns.unshift(copy);
    pushLog(state, { level: "info", text: `Duplicated "${c.name}"` });
    save(); rerender(); ok("Campaign duplicated");
  },
  "delete-ask": (el) => { ui.deleteId = el.dataset.id; renderDeleteModal(); },
  "delete-confirm": (el) => {
    const c = findCmp(el.dataset.id);
    state.campaigns = state.campaigns.filter((x) => x.id !== el.dataset.id);
    state.confirmQueue = state.confirmQueue.filter((q) => q.campaignId !== el.dataset.id);
    if (c) pushLog(state, { level: "info", text: `Campaign "${c.name}" deleted` });
    closeModal(); save(); rerender(); note("Campaign deleted");
  },
  preview: (el) => { ui.previewId = el.dataset.id; renderPreviewModal(); },
  "modal-close": () => closeModal(),
  "goto-platforms": () => { closeModal(); ui.page = "platforms"; rerender(); },

  "stopall-ask": () => { ui.stopAsk = true; renderStopModal(); },
  "stopall-confirm": () => {
    let n = 0;
    for (const c of state.campaigns) if (["running", "scheduled"].includes(c.status)) { c.status = "paused"; c.nextActionAt = null; n++; }
    const queued = state.confirmQueue.length; state.confirmQueue = [];
    if (n || queued) pushLog(state, { level: "warn", text: `STOP ALL engaged — ${n} campaign(s) halted${queued ? `, ${queued} confirmation(s) discarded` : ""}` });
    closeModal(); save(); rerender(); note("Stop All engaged", `${n} campaign(s) paused.`);
  },

  "confirm-approve": (el) => resolveConfirm(el.dataset.key, true),
  "confirm-skip": (el) => resolveConfirm(el.dataset.key, false),
  "confirm-copy": async (el) => {
    const q = state.confirmQueue.find((x) => x.key === el.dataset.key);
    if (q) { try { await navigator.clipboard.writeText(q.message); ok("Copied to clipboard"); } catch { note("Copy failed"); } }
  },

  "int-save": (el) => { if (saveIntegrationForm(el.dataset.platform, "int")) rerender(); },
  "int-verify": async (el) => { await verifyIntegrationForm(el.dataset.platform, "int"); },
  "builder-int-save": (el) => { if (saveIntegrationForm(el.dataset.platform, "builder")) rerender(); },
  "builder-int-verify": async (el) => { await verifyIntegrationForm(el.dataset.platform, "builder"); },
  "toggle-secret": (el) => {
    const input = document.getElementById(el.dataset.target);
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
    el.textContent = input.type === "password" ? "Show" : "Hide";
  },

  scan: async () => { await scanOpenMessagingTabs(); },
  "scan-candidate": async (el) => {
    const candidate = ui.scanCandidates?.[Number(el.dataset.i)];
    closeModal();
    if (candidate) await runScan(candidate.url);
  },
  "scan-url": () => { ui.scanCandidates = null; ui.scanAskUrl = true; renderScanUrlModal(); },
  "scan-url-go": async () => { const v = document.getElementById("scanUrlInput")?.value || ""; ui.scanAskUrl = false; closeModal(); await runScan(v); },
  "use-scan": () => {
    if (!ui.draft || !state.scanResult) return;
    ui.draft.destination = state.scanResult.id;
    if (ui.draft.platform !== state.scanResult.platform) ui.draft.platform = state.scanResult.platform;
    const inp = document.getElementById("f-destination");
    if (inp) inp.value = state.scanResult.id;
    ok("Destination set", state.scanResult.label);
    rerender();
  },
  "copy-scan": async () => { if (state.scanResult) { try { await navigator.clipboard.writeText(state.scanResult.id); ok("Copied destination"); } catch { note("Copy failed"); } } },
  "clear-scan": () => { state.scanResult = null; save(); rerender(); },

  "log-level": (el) => { ui.logFilter.level = el.dataset.l; rerender(); },
  "clear-logs": () => { state.logs = []; pushLog(state, { level: "info", text: "Activity log cleared" }); save(); rerender(); },
  "export-logs": () => downloadJSON(state.logs, "messageflow-logs.json"),
  "export-data": () => downloadJSON(state, "messageflow-backup.json"),
  "import-data": () => document.getElementById("importFile").click(),
  "load-demo": () => { state = seedState(); save(); rerender(); ok("Demo data loaded"); },
  "wipe-ask": () => { if (confirm("Wipe ALL campaigns, logs, settings and credentials?")) { const demo = seedState(); demo.campaigns = []; demo.logs = []; pushLog(demo, { level: "info", text: "All data wiped" }); state = demo; save(); rerender(); note("Everything wiped"); } },
};

function resolveConfirm(key, approve) {
  const i = state.confirmQueue.findIndex((q) => q.key === key);
  if (i === -1) return;
  const p = state.confirmQueue.splice(i, 1)[0];
  const c = state.campaigns.find((x) => x.id === p.campaignId);
  if (!c) { save(); rerender(); return; }
  if (approve) {
    c.inFlight = p.key; c.inFlightAt = Date.now();
    save(); rerender();
    void (async () => {
      try {
        await deliver({ key: p.key, campaignId: p.campaignId, sectionId: p.sectionId, rep: p.rep, message: p.message, destination: p.destination, platform: p.platform, mode: c.mode }, state.integrations);
        applySendResult(state, { key: p.key, campaignId: p.campaignId, sectionId: p.sectionId, rep: p.rep, ok: true }, Date.now());
        ok("Message sent", p.destination);
      } catch (err) {
        applySendResult(state, { key: p.key, campaignId: p.campaignId, sectionId: p.sectionId, rep: p.rep, ok: false, error: String(err.message || err) }, Date.now());
      }
      save(); rerender();
    })();
  } else {
    const sec = c.sections.find((s) => s.id === p.sectionId);
    if (sec) {
      sec.progress = Math.max(sec.progress, p.rep);
      pushLog(state, { level: "skip", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Message skipped by user — rep ${p.rep}/${sec.repetitions} of "${sec.title}"` });
      advanceAfter(state, c, p.sectionId, p.rep, Date.now());
    }
    save(); rerender();
  }
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  ok("Exported", filename);
}

/* ------------------------------ inputs ----------------------------- */

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLSelectElement)) return;
  if (ui.draft && el.dataset.f !== undefined) {
    const f = el.dataset.f;
    const v = el.type === "number" ? Number(el.value) : el.value;
    if (f === "startAt" || f === "endAt") {
      // allow clearing the optional end date (empty input → null)
      ui.draft[f] = el.value ? fromLocalInput(el.value) : f === "endAt" ? null : ui.draft[f];
    } else ui.draft[f] = v;
    // Platform changes alter the connection form shown inside the sender.
    if (el instanceof HTMLSelectElement && f === "platform") rerender();
    return;
  }
  if (ui.draft && el.dataset.si !== undefined && el.dataset.sf) {
    const s = ui.draft.sections[Number(el.dataset.si)];
    if (!s) return;
    const f = el.dataset.sf;
    if (f === "enabled") s.enabled = el.checked;
    else if (f === "startAt") s.startAt = fromLocalInput(el.value);
    else if (el.type === "checkbox") s[f] = el.checked;
    else if (el.type === "number") s[f] = Number(el.value);
    else s[f] = el.value;
    return;
  }
  if (el.dataset.lf === "q") { ui.logFilter.q = el.value; renderLogList(); }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  const key = el.dataset.set;
  if (key) {
    state.settings[key] = el.type === "checkbox" ? el.checked : el.type === "number" ? Math.max(0, Number(el.value) || 0) : el.value;
    if (key === "timezone") {
      try { new Intl.DateTimeFormat("en-US", { timeZone: el.value }); } catch { bad("Invalid timezone"); return; }
    }
    pushLog(state, { level: "info", text: `Setting updated: ${key}` });
    save(); rerender();
    return;
  }
  if (el.dataset.lf === "platform") { ui.logFilter.platform = el.value; renderLogList(); }
});

document.getElementById("importFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.campaigns)) { bad("Invalid backup file"); return; }
    const base = seedState();
    state = { ...base, ...parsed, settings: { ...base.settings, ...parsed.settings }, integrations: { ...base.integrations, ...parsed.integrations }, confirmQueue: [] };
    save(); rerender();
    ok("Backup imported", `${parsed.campaigns.length} campaigns restored.`);
  } catch {
    bad("Import failed", "Could not parse the file.");
  }
});

/* ------------------------------ clock ------------------------------ */

function updateClock() {
  const el = document.getElementById("clock");
  if (!el || !state) return;
  try {
    el.textContent = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: state.settings.timezone }).format(Date.now());
  } catch {
    el.textContent = new Date().toLocaleTimeString();
  }
  document.querySelectorAll("[data-ts]").forEach((n) => {
    const ts = Number(n.getAttribute("data-ts"));
    if (Number.isFinite(ts)) n.textContent = fmtCountdown(ts - Date.now());
  });
}

/* -------------------------------- init ----------------------------- */

async function init() {
  state = await loadState(storage);
  if (!state.scanResult) state.scanResult = null;
  const params = new URLSearchParams(location.search);
  const requestedPage = params.get("page");
  if (requestedPage && PAGE_META[requestedPage]) ui.page = requestedPage;
  if (ui.page === "editor") {
    ui.draft = blankCampaign();
    if (params.get("useScan") === "1" && state.scanResult) {
      ui.draft.destination = state.scanResult.id;
      ui.draft.platform = state.scanResult.platform;
    }
  }
  renderNav(); renderTopbar(); renderPage(); updateClock();
  if (params.get("focus") === "discord") {
    setTimeout(() => document.getElementById("discordIntegration")?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
  }
  // Own the engine while this tab is open: the background worker skips its
  // alarm ticks, so exactly one context ever mutates/dispatches at a time.
  void markDashboardAlive();
  setInterval(() => void markDashboardAlive(), 2000);
  setInterval(() => { void heartbeat(); }, 1000);
  setInterval(updateClock, 1000);
  window.addEventListener("beforeunload", () => void saveState(storage, state));
}

void init();
