/* ------------------------------------------------------------------ */
/* MessageFlow AI — shared engine (ES module, plain JS)                */
/* Used by the background service worker, the popup and the           */
/* dashboard. No dependencies.                                         */
/* ------------------------------------------------------------------ */

export const STATE_KEY = "mfai:ext:v1";
export const LOG_CAP = 400;

/* ------------------------------------------------------------------ */
/* Cross-context consistency                                           */
/*                                                                     */
/* The dashboard, popup and background worker share one storage state. */
/* Two writers ticking at once could dispatch the same action twice or */
/* clobber each other's progress. Two defences:                        */
/*  1. While a dashboard tab is alive it OWNS the engine — the worker  */
/*     skips its alarm ticks (heartbeat flag in storage.session).      */
/*  2. Every mutation+saveset runs inside an exclusive Web Lock, and   */
/*     state carries a `rev` counter so stale writers adopt fresh data */
/*     instead of overwriting it.                                      */
/* ------------------------------------------------------------------ */

export async function withEngineLock(fn) {
  try {
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      return await navigator.locks.request("mfai-engine-lock", { mode: "exclusive" }, fn);
    }
  } catch {
    /* lock unavailable or aborted — fall through to best-effort */
  }
  return fn();
}

const DASH_KEY = "mfai:dashAlive";
export async function markDashboardAlive() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) await chrome.storage.session.set({ [DASH_KEY]: Date.now() });
  } catch { /* preview context */ }
}
export async function isDashboardAlive(maxAgeMs = 8000) {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const d = await chrome.storage.session.get(DASH_KEY);
      const ts = d?.[DASH_KEY];
      return Number.isFinite(ts) && Date.now() - ts < maxAgeMs;
    }
  } catch { /* preview context */ }
  return false;
}

let seq = 0;
export const uid = (p = "id") => {
  seq = (seq + 1) % 46656;
  return `${p}_${Date.now().toString(36)}${seq.toString(36).padStart(3, "0")}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
};
export const clone = (v) => JSON.parse(JSON.stringify(v));
export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const trunc = (s, n = 64) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || "");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");

/* ------------------------------ formatting ------------------------ */

export function fmtDateTime(ts, tz) {
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(ts);
  } catch {
    return new Date(ts).toLocaleString();
  }
}
export function fmtCountdown(ms) {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${pad(m)}:${pad(sec)}`;
}
export function fmtSecs(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(sec % 3600 === 0 ? 0 : 1)}h`;
}
export function toLocalInput(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/* ------------------------------ timezones ------------------------- */

function tzParts(ts, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ts);
    const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour") % 24, mm: get("minute") };
  } catch {
    const d = new Date(ts);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hh: d.getHours(), mm: d.getMinutes() };
  }
}
export const localDayKey = (ts, tz) => {
  const p = tzParts(ts, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};
const parseHHMM = (v) => {
  const [h, m] = String(v || "0:0").split(":").map((n) => parseInt(n, 10));
  return ((isNaN(h) ? 0 : h) % 24) * 60 + (isNaN(m) ? 0 : m % 60);
};
export function isQuiet(now, s) {
  if (!s.quietEnabled) return false;
  const start = parseHHMM(s.quietStart);
  const end = parseHHMM(s.quietEnd);
  if (start === end) return false;
  const p = tzParts(now, s.timezone);
  const cur = p.hh * 60 + p.mm;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
export function msUntilQuietEnd(now, s) {
  for (let i = 1; i <= 1441; i++) if (!isQuiet(now + i * 60000, s)) return i * 60000;
  return 60000;
}
export function skipQuiet(ts, s) {
  let t = ts;
  let guard = 0;
  while (isQuiet(t, s) && guard++ < 8) t += msUntilQuietEnd(t, s);
  return t;
}

/* --------------------------- campaign logic ----------------------- */

export const currentSection = (c) => c.sections.find((s) => s.enabled && s.progress < s.repetitions) ?? null;
export function campaignTotals(c) {
  let total = 0, done = 0;
  for (const s of c.sections) {
    if (!s.enabled) continue;
    total += s.repetitions;
    done += Math.min(s.progress, s.repetitions);
  }
  return { total, done };
}
export const actionKey = (cid, sid, rep) => `${cid}:${sid}:${rep}`;

export function isLiveAllowed(platform, integ) {
  if (platform === "mock") return true;
  if (platform === "discord") return /^https:\/\/(canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/.test((integ.discordWebhookUrl || "").trim());
  if (platform === "telegram") return Boolean((integ.telegramBotToken || "").trim() && (integ.telegramChatId || "").trim());
  return false;
}

export function validateCampaign(c) {
  const errors = [];
  if (!c.name || c.name.trim().length < 2) errors.push("Campaign name must be at least 2 characters.");
  if (!c.destination || String(c.destination).trim().length < 2) errors.push("Destination is required.");
  if (!Number.isFinite(c.startAt) || c.startAt <= 0) errors.push("Start date/time is invalid.");
  if (c.endAt !== null && c.endAt <= c.startAt) errors.push("End date must be after the start date.");
  const enabled = c.sections.filter((s) => s.enabled);
  if (enabled.length === 0) errors.push("At least one enabled message section is required.");
  let reps = 0;
  enabled.forEach((s, i) => {
    const label = s.title?.trim() || `Section ${i + 1}`;
    if (!s.message || !s.message.trim()) errors.push(`"${label}" has an empty message.`);
    if (s.repetitions < 1 || s.repetitions > 500) errors.push(`"${label}" repetitions must be 1–500.`);
    if (s.intervalSec < 2 || s.intervalSec > 86400) errors.push(`"${label}" interval must be 2s–24h.`);
    if (s.delayAfterSec < 0) errors.push(`"${label}" delay must be ≥ 0.`);
    reps += s.repetitions;
  });
  if (reps > 1000) errors.push("Total repetitions exceed 1000.");
  return errors;
}

export function buildPreview(c, settings, now, limit = 80) {
  const items = [];
  let totalActions = 0;
  const anchor =
    c.status === "draft" || c.status === "scheduled"
      ? c.startAt
      : c.status === "running" && c.nextActionAt !== null
        ? c.nextActionAt
        : now;
  let t = skipQuiet(Math.max(now, anchor), settings);
  let truncated = false;
  const secs = c.sections.filter((s) => s.enabled && s.progress < s.repetitions);
  for (let i = 0; i < secs.length; i++) {
    const sec = secs[i];
    if (sec.startAt && sec.startAt > t) t = skipQuiet(sec.startAt, settings);
    for (let r = sec.progress + 1; r <= sec.repetitions; r++) {
      totalActions++;
      if (items.length < limit) items.push({ ts: t, sectionTitle: sec.title, rep: r, total: sec.repetitions, message: sec.message });
      else truncated = true;
      t = skipQuiet(t + sec.intervalSec * 1000, settings);
    }
    if (i < secs.length - 1) t = skipQuiet(t - sec.intervalSec * 1000 + (sec.delayAfterSec || 0) * 1000, settings);
  }
  let end = null;
  if (secs.length > 0 && totalActions > 0) end = t - secs[secs.length - 1].intervalSec * 1000;
  return { items, truncated, end, totalActions };
}

/* --------------------------- thread scanner ----------------------- */

export function scanThreadUrl(url) {
  if (!url) return null;
  let m;
  if ((m = url.match(/discord\.com\/channels\/(@me|\d+)\/(\d+)/))) {
    return { platform: "discord", kind: m[1] === "@me" ? "DM channel" : "server channel", id: m[2], label: `Discord ${m[1] === "@me" ? "DM" : "channel"} ${m[2]}` };
  }
  if ((m = url.match(/web\.telegram\.org\/(?:[akzw]\/)?#(-?\d{5,}|@?[\w.]{3,})/))) {
    const id = m[1].startsWith("@") ? m[1] : m[1];
    return { platform: "telegram", kind: "chat", id, label: `Telegram chat ${id}` };
  }
  if ((m = url.match(/whatsapp.*?phone=(\d+)/)) || (m = url.match(/web\.whatsapp\.com\/.*?(\d{7,15})/))) {
    return { platform: "whatsapp", kind: "chat", id: m[1], label: `WhatsApp chat ${m[1]} (assisted mode)` };
  }
  if (url.includes("web.whatsapp.com")) return { platform: "whatsapp", kind: "chat", id: "current chat", label: "WhatsApp Web — current chat (assisted mode)" };
  if ((m = url.match(/instagram\.com\/direct\/t\/(\d+)/))) {
    return { platform: "instagram", kind: "thread", id: m[1], label: `Instagram DM thread ${m[1]} (assisted mode)` };
  }
  return null;
}

/* ------------------------------ storage --------------------------- */

export function makeStorage() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return {
      get: (key) => chrome.storage.local.get(key).then((d) => d[key]),
      set: (key, val) => chrome.storage.local.set({ [key]: val }),
    };
  }
  return {
    get: async (key) => {
      try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
    },
    set: async (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* full */ } },
  };
}

export function defaultSettings() {
  return {
    timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    quietEnabled: false,
    quietStart: "22:00",
    quietEnd: "07:00",
    maxPerDay: 200,
    manualConfirm: false,
    requireConsent: true,
  };
}
export function defaultIntegrations() {
  return { discordWebhookUrl: "", telegramBotToken: "", telegramChatId: "", discordVerifiedAt: null, telegramVerifiedAt: null };
}

function blankSection(n) {
  return { id: uid("sec"), title: `Section ${n}`, message: "", repetitions: 3, intervalSec: 30, delayAfterSec: 0, startAt: null, enabled: true, progress: 0, status: "pending", lastSentAt: null };
}
export function blankCampaign() {
  const now = Date.now();
  return {
    id: uid("cmp"), name: "", platform: "mock", destination: "", mode: "test",
    scheduleType: "once", startAt: now + 60000, endAt: null, status: "draft",
    retryLimit: 2, maxPerDay: 120, nextActionAt: null, inFlight: null, inFlightAt: undefined,
    lastActionKey: null, attempts: {}, dayCount: { date: "", count: 0 }, sentTotal: 0, failTotal: 0,
    createdAt: now, updatedAt: now, sections: [blankSection(1)],
  };
}

export function seedState() {
  const now = Date.now();
  const demo = blankCampaign();
  demo.name = "Welcome Flow (demo)";
  demo.platform = "mock";
  demo.destination = "#demo-room (sandbox)";
  demo.mode = "test";
  demo.status = "running";
  demo.startAt = now - 60000;
  demo.nextActionAt = now + 3000;
  demo.sections = [
    { ...blankSection(1), title: "Intro", message: "Hello! Simulated welcome from MessageFlow AI.", repetitions: 2, intervalSec: 10, delayAfterSec: 5 },
    { ...blankSection(1), title: "Follow-up", message: "This is section 2 — nothing here was really sent.", repetitions: 1, intervalSec: 15, startAt: null },
  ];
  demo.sections[1].title = "Follow-up";
  return {
    version: 1,
    rev: 1,
    campaigns: [demo],
    logs: [{ id: uid("log"), ts: now, level: "info", platform: "system", campaignId: null, campaignName: null, text: "MessageFlow AI initialized — mock adapter active" }],
    settings: defaultSettings(),
    integrations: defaultIntegrations(),
    confirmQueue: [],
    daily: { date: "", count: 0 },
  };
}

export async function loadState(storage) {
  const raw = await storage.get(STATE_KEY);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.campaigns)) return seedState();
  const base = seedState();
  const now = Date.now();
  const state = {
    ...base,
    ...raw,
    settings: { ...base.settings, ...raw.settings },
    integrations: { ...base.integrations, ...raw.integrations },
    confirmQueue: [],
  };
  for (const c of state.campaigns) {
    c.inFlight = null;
    c.inFlightAt = undefined;
    if (c.status === "running" && c.nextActionAt === null) c.nextActionAt = now + 2000;
  }
  return state;
}
export const saveState = (storage, state) => {
  const { confirmQueue, ...rest } = state; // never persist the ephemeral queue
  return storage.set(STATE_KEY, { ...rest, confirmQueue: [] });
};

/* ------------------------------- logs ----------------------------- */

export function pushLog(state, e) {
  state.logs.unshift({ id: uid("log"), ts: e.ts ?? Date.now(), level: e.level, platform: e.platform ?? "system", campaignId: e.campaignId ?? null, campaignName: e.campaignName ?? null, text: e.text });
  if (state.logs.length > LOG_CAP) state.logs.length = LOG_CAP;
}

/* --------------------------- runtime ops -------------------------- */

function resetRuntime(c) {
  for (const s of c.sections) { s.progress = 0; s.status = "pending"; s.lastSentAt = null; }
  c.nextActionAt = null; c.inFlight = null; c.inFlightAt = undefined; c.lastActionKey = null; c.attempts = {}; c.qhLoggedAt = undefined;
}

export function completeCampaign(state, c, now) {
  c.nextActionAt = null;
  if (c.scheduleType === "daily") {
    resetRuntime(c);
    let t = c.startAt;
    while (t <= now) t += 86400000;
    c.startAt = t; c.nextActionAt = t; c.status = "scheduled";
    pushLog(state, { level: "info", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Daily schedule re-armed — next run ${fmtDateTime(t, state.settings.timezone)}` });
  } else {
    c.status = "completed";
    const { done } = campaignTotals(c);
    pushLog(state, { level: "success", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Campaign completed — ${done} message${done === 1 ? "" : "s"} processed` });
  }
}

export function advanceAfter(state, c, secId, rep, now) {
  const sec = c.sections.find((s) => s.id === secId);
  if (!sec) { c.nextActionAt = now + 2000; return; }
  if (rep < sec.repetitions) { c.nextActionAt = skipQuiet(now + sec.intervalSec * 1000, state.settings); return; }
  sec.status = "done";
  const idx = c.sections.findIndex((s) => s.id === secId);
  const next = c.sections.slice(idx + 1).find((s) => s.enabled && s.progress < s.repetitions);
  if (next) {
    let t = now + (sec.delayAfterSec || 0) * 1000;
    if (next.startAt && next.startAt > t) t = next.startAt;
    c.nextActionAt = skipQuiet(t, state.settings);
    pushLog(state, { level: "info", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Section "${sec.title}" complete — next: "${next.title}"` });
  } else {
    completeCampaign(state, c, now);
  }
}

/* The heartbeat. Mutates state; appends due send actions to `out`.
   Returns true only when something actually changed (snapshot diff), so
   idle engines don't thrash storage or force re-renders every second. */
export function tickEngine(state, now, out) {
  const before = JSON.stringify([state.campaigns, state.confirmQueue.length, state.logs.length, state.daily]);

  for (const c of state.campaigns) {
    if (c.status === "scheduled" && c.nextActionAt !== null && now >= c.nextActionAt) {
      c.status = "running"; c.nextActionAt = now + 800; c.qhLoggedAt = undefined;
      pushLog(state, { level: "info", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Campaign started${c.mode === "test" ? " (test mode)" : ""}` });
    }
  }
  for (const c of state.campaigns) {
    if (c.status !== "running") continue;

    if (c.inFlight) {
      if (now - (c.inFlightAt ?? 0) > 30000) {
        pushLog(state, { level: "warn", platform: c.platform, campaignId: c.id, campaignName: c.name, text: "Send timed out — lock released" });
        c.inFlight = null; c.inFlightAt = undefined; c.nextActionAt = now + 1500;
      }
      continue;
    }
    if (c.endAt !== null && now > c.endAt) { c.status = "paused"; c.nextActionAt = null; pushLog(state, { level: "warn", platform: c.platform, campaignId: c.id, campaignName: c.name, text: "End date reached — paused" }); continue; }
    if (state.confirmQueue.some((q) => q.campaignId === c.id)) continue;

    if (isQuiet(now, state.settings)) {
      const target = skipQuiet(now, state.settings);
      const merged = c.nextActionAt !== null && c.nextActionAt > target ? c.nextActionAt : target;
      if (c.nextActionAt !== merged) {
        if (c.qhLoggedAt !== merged) { c.qhLoggedAt = merged; pushLog(state, { level: "skip", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Quiet hours — next action held until ${fmtDateTime(merged, state.settings.timezone)}` }); }
        c.nextActionAt = merged;
      }
      continue;
    }
    if (c.nextActionAt === null || now < c.nextActionAt) continue;

    const sec = currentSection(c);
    if (!sec) { completeCampaign(state, c, now); continue; }
    if (sec.status === "pending" && sec.startAt && sec.startAt > now) { c.nextActionAt = sec.startAt; continue; }

    const today = localDayKey(now, state.settings.timezone);
    if (state.daily.date !== today) state.daily = { date: today, count: 0 };
    if (c.dayCount.date !== today) c.dayCount = { date: today, count: 0 };
    if ((state.settings.maxPerDay > 0 && state.daily.count >= state.settings.maxPerDay) || (c.maxPerDay > 0 && c.dayCount.count >= c.maxPerDay)) {
      if (!c.attempts[`cap:${today}`]) { c.attempts[`cap:${today}`] = 1; pushLog(state, { level: "warn", platform: c.platform, campaignId: c.id, campaignName: c.name, text: "Daily send limit reached — paused for safety" }); }
      c.status = "paused"; c.nextActionAt = null; continue;
    }

    const rep = sec.progress + 1;
    const key = actionKey(c.id, sec.id, rep);
    if (c.lastActionKey === key) {
      if (!c.attempts[`dup:${key}`]) { c.attempts[`dup:${key}`] = 1; pushLog(state, { level: "error", platform: c.platform, campaignId: c.id, campaignName: c.name, text: "Duplicate send blocked by safety guard" }); }
      c.nextActionAt = now + 60000; continue;
    }

    if (state.settings.manualConfirm && c.mode === "live") {
      state.confirmQueue.push({ key, campaignId: c.id, campaignName: c.name, sectionId: sec.id, rep, message: sec.message, destination: c.destination, platform: c.platform });
      c.nextActionAt = null;
      pushLog(state, { level: "info", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Awaiting manual confirmation — rep ${rep}/${sec.repetitions} of "${sec.title}"` });
      continue;
    }

    if (sec.status === "pending") {
      sec.status = "active";
      pushLog(state, { level: "info", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Section "${sec.title}" started — ${sec.repetitions}× every ${fmtSecs(sec.intervalSec)}` });
    }
    c.inFlight = key; c.inFlightAt = now; c.nextActionAt = null;
    out.push({ key, campaignId: c.id, sectionId: sec.id, rep, message: sec.message, destination: c.destination, platform: c.platform, mode: c.mode });
  }
  return JSON.stringify([state.campaigns, state.confirmQueue.length, state.logs.length, state.daily]) !== before;
}

export function applySendResult(state, res, now) {
  const c = state.campaigns.find((x) => x.id === res.campaignId);
  if (!c || c.inFlight !== res.key) return false;
  const sec = c.sections.find((s) => s.id === res.sectionId);
  c.inFlight = null; c.inFlightAt = undefined;
  if (!sec) { c.nextActionAt = now + 2000; return true; }
  if (res.ok) {
    delete c.attempts[res.key];
    sec.progress = Math.max(sec.progress, res.rep);
    sec.lastSentAt = now;
    c.sentTotal++; c.lastActionKey = res.key;
    const today = localDayKey(now, state.settings.timezone);
    if (state.daily.date !== today) state.daily = { date: today, count: 0 };
    if (c.dayCount.date !== today) c.dayCount = { date: today, count: 0 };
    state.daily.count++; c.dayCount.count++;
    pushLog(state, { level: c.mode === "test" ? "test" : "success", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `${c.mode === "test" ? "Simulated send" : "Delivered"} → ${c.platform} · ${c.destination} · "${trunc(sec.message)}" (${res.rep}/${sec.repetitions})` });
    advanceAfter(state, c, sec.id, res.rep, now);
  } else {
    const n = (c.attempts[res.key] ?? 0) + 1;
    c.attempts[res.key] = n;
    if (n <= c.retryLimit) {
      const backoff = Math.min(15000, 4000 * n);
      c.nextActionAt = now + backoff;
      pushLog(state, { level: "warn", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Send failed (${trunc(res.error, 90)}) — retry ${n}/${c.retryLimit}` });
    } else {
      c.status = "failed"; c.nextActionAt = null; c.failTotal++;
      pushLog(state, { level: "error", platform: c.platform, campaignId: c.id, campaignName: c.name, text: `Campaign failed at "${sec.title}" — ${trunc(res.error, 120)}` });
    }
  }
  c.updatedAt = now;
  return true;
}
