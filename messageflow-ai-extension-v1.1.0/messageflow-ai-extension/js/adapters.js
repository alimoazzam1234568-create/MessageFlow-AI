/* ------------------------------------------------------------------ */
/* MessageFlow AI — delivery adapters (ES module, plain JS)            */
/*                                                                     */
/* Mock:        simulated latency, no network.                         */
/* Discord:     official Incoming Webhooks (you create the webhook     */
/*              in your own channel; we POST the message to it).       */
/* Telegram:    official Bot API (token from @BotFather; the chat must */
/*              have started the bot or be a group where it is admin). */
/* WhatsApp / Instagram: NOT automated — assisted mode only.           */
/*                                                                     */
/* Credentials are read from local extension storage at send time and  */
/* are never written to logs. URLs/tokens are always redacted.         */
/* ------------------------------------------------------------------ */

import { isLiveAllowed, sleep } from "./engine.js";

export function redactUrl(url) {
  return String(url || "").replace(/(\/webhooks\/\d+\/)[^/?\s]+/, "$1••••••").replace(/(bot)\d+:[^/\s]+/, "$1•••:••••••");
}

export function connectionProblem(platform, integ) {
  if (platform === "mock") return null;
  if (platform === "discord" && !isLiveAllowed("discord", integ)) return "Discord webhook URL not configured (Platforms → Discord).";
  if (platform === "telegram" && !isLiveAllowed("telegram", integ)) return "Telegram bot token/chat ID not configured (Platforms → Telegram).";
  if (platform === "whatsapp") return "WhatsApp requires the approved Business Cloud API — use assisted copy mode.";
  if (platform === "instagram") return "Instagram requires Messenger API app review — use assisted copy mode.";
  return null;
}

async function postJSON(url, body) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Network request failed — check your connection");
  }
  return res;
}

/** Deliver one action. Throws on failure (retryable by the engine). */
export async function deliver(action, integ) {
  const msg = String(action.message ?? "").slice(0, 3800);

  if (action.mode === "test" || action.platform === "mock") {
    await sleep(200 + Math.random() * 500);
    if (msg.toLowerCase().includes("[fail]")) throw new Error("Simulated delivery failure");
    return;
  }

  if (action.platform === "discord") {
    const url = (integ.discordWebhookUrl || "").trim();
    if (!url) throw new Error("Discord webhook not configured");
    const res = await postJSON(url + (url.includes("?") ? "&" : "?") + "wait=true", { content: msg.slice(0, 1900) });
    if (res.status === 429) {
      let wait = 5;
      try { wait = Math.ceil((await res.json()).retry_after ?? 5); } catch { /* keep */ }
      throw new Error(`Discord rate limit — retry after ~${wait}s`);
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).message || ""; } catch { /* keep */ }
      throw new Error(`Discord rejected the message (${res.status})${detail ? `: ${detail}` : ""}`);
    }
    return;
  }

  if (action.platform === "telegram") {
    const token = (integ.telegramBotToken || "").trim();
    const chatId = (integ.telegramChatId || "").trim();
    if (!token || !chatId) throw new Error("Telegram credentials not configured");
    const res = await postJSON(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: msg });
    let json = null;
    try { json = await res.json(); } catch { /* keep */ }
    if (!res.ok || !json?.ok) throw new Error(`Telegram rejected the message${json?.description ? `: ${json.description}` : ` (${res.status})`}`);
    return;
  }

  throw new Error(`No authorized integration connected for ${action.platform}`);
}

/** Send a small verification message so the user can confirm wiring. */
export async function verifyIntegration(platform, integ) {
  await deliver(
    { platform, mode: "live", message: "✓ MessageFlow AI connection check — this integration is working.", destination: "integration-check" },
    integ
  );
}
