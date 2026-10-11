/* MessageFlow AI — popup controller (MV3 module). */

import { esc, makeStorage, loadState, saveState, scanThreadUrl } from "../js/engine.js";

const storage = makeStorage();
const hasChrome = typeof chrome !== "undefined" && !!chrome.runtime?.id;

async function render() {
  const state = await loadState(storage);
  const campaigns = state.campaigns;

  const running = campaigns.filter((c) => c.status === "running").length;
  const scheduled = campaigns.filter((c) => c.status === "scheduled").length;
  const processed = campaigns.reduce((acc, c) => acc + c.sections.reduce((a, s) => a + Math.min(s.progress, s.repetitions), 0), 0);

  document.getElementById("statRunning").textContent = String(running);
  document.getElementById("statScheduled").textContent = String(scheduled);
  document.getElementById("statSent").textContent = String(processed);

  const list = document.getElementById("list");
  if (campaigns.length === 0) {
    list.innerHTML = `<p class="empty">No campaigns yet.<br/>Open the dashboard to create one.</p>`;
    return;
  }
  list.innerHTML = campaigns
    .slice(0, 10)
    .map((c) => {
      const done = c.sections.reduce((a, s) => a + Math.min(s.progress, s.repetitions), 0);
      const total = c.sections.reduce((a, s) => a + (s.enabled ? s.repetitions : 0), 0);
      return `<div class="row">
        <span class="name">${esc(c.name)}</span>
        <span class="meta">${done}/${total}</span>
        <span class="pill ${esc(c.status)}">${esc(c.status)}</span>
      </div>`;
    })
    .join("");
}

document.getElementById("openDash").addEventListener("click", () => {
  if (hasChrome) chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  else window.open("../dashboard/dashboard.html", "_blank");
});

document.getElementById("connectDiscord").addEventListener("click", () => {
  if (hasChrome) chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html?page=platforms&focus=discord") });
  else window.open("../dashboard/dashboard.html?page=platforms&focus=discord", "_blank");
});

document.getElementById("scanChat").addEventListener("click", async () => {
  const status = document.getElementById("scanStatus");
  if (!hasChrome) {
    status.textContent = "Thread scanning only works in the installed extension.";
    return;
  }
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    const found = scanThreadUrl(tab?.url || "");
    if (!found) {
      status.textContent = "No supported chat was detected in this tab. Open the actual chat page, then try again.";
      return;
    }
    const state = await loadState(storage);
    state.scanResult = { ...found, url: tab.url || "", tabTitle: tab.title || "" };
    state.rev = (state.rev ?? 0) + 1;
    await saveState(storage, state);
    await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html?page=editor&useScan=1") });
    window.close();
  } catch {
    status.textContent = "Could not read the active tab. Reload the extension and confirm the Tabs permission.";
  }
});

document.getElementById("stop").addEventListener("click", async () => {
  if (!confirm("Stop ALL running and scheduled campaigns?")) return;
  if (hasChrome) await chrome.runtime.sendMessage({ type: "MFAI_STOP_ALL" });
  await render();
});

void render();
