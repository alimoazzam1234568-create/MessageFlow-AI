/* ------------------------------------------------------------------ */
/* MessageFlow AI — MV3 background service worker                      */
/*                                                                     */
/* Uses chrome.alarms (~30s granularity, best-effort — never exact).   */
/* Progress lives in chrome.storage.local so it survives restarts.     */
/* Real sends go through the official adapters in js/adapters.js —     */
/* only for platforms the user connected with their own credentials.   */
/* ------------------------------------------------------------------ */

import {
  STATE_KEY, makeStorage, loadState, saveState, seedState, pushLog,
  tickEngine, applySendResult, withEngineLock, isDashboardAlive,
} from "../js/engine.js";
import { deliver } from "../js/adapters.js";

const ALARM_NAME = "mfai-tick";
const storage = makeStorage();

/**
 * One engine tick. While a dashboard tab owns the engine we skip (it ticks
 * at 1s precision and persists for us). All work happens inside the shared
 * exclusive lock and on a freshly loaded snapshot, so the worker never
 * double-dispatches an action the dashboard just emitted, and never
 * overwrites newer state.
 */
async function runTick({ force = false } = {}) {
  if (!force && (await isDashboardAlive())) return { skipped: true };
  return withEngineLock(async () => {
    const state = await loadState(storage);
    const out = [];
    let changed = tickEngine(state, Date.now(), out);
    for (const action of out) {
      try {
        await deliver(action, state.integrations);
        applySendResult(state, { ...action, ok: true }, Date.now());
      } catch (err) {
        applySendResult(state, { ...action, ok: false, error: err instanceof Error ? err.message : String(err) }, Date.now());
      }
      changed = true;
    }
    if (changed) {
      state.rev = (state.rev ?? 0) + 1;
      await saveState(storage, state);
    }
    return { changed };
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  const existing = await storage.get(STATE_KEY);
  if (!existing) {
    const seed = seedState();
    await saveState(storage, seed);
  }
  await runTick();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await runTick();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "MFAI_TICK": {
        const res = await runTick({ force: true });
        sendResponse({ ok: true, ...res });
        break;
      }
      case "MFAI_STOP_ALL": {
        await withEngineLock(async () => {
          const state = await loadState(storage); // fresh — respect dashboard edits
          let n = 0;
          for (const c of state.campaigns) {
            if (c.status === "running" || c.status === "scheduled") { c.status = "paused"; c.nextActionAt = null; n++; }
          }
          const queued = state.confirmQueue.length;
          state.confirmQueue = [];
          if (n > 0 || queued > 0) pushLog(state, { level: "warn", text: `STOP ALL engaged — ${n} campaign${n === 1 ? "" : "s"} halted${queued ? `, ${queued} pending confirmation(s) discarded` : ""}` });
          state.rev = (state.rev ?? 0) + 1;
          await saveState(storage, state);
        });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // async response
});
