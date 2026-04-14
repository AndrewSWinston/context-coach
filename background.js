/**
 * background.js — ContextCoach
 * Service worker. Receives token count from content.js and updates the badge.
 *
 * SUMMARY ROUTING:
 * When BACKEND_URL is set, all summarize calls route through your proxy endpoint.
 * The proxy holds the API key server-side, rate-limits per user, and enforces a
 * global spend cap. Set to null to fall back to user-supplied API key (BYOK mode).
 *
 * TODO: Set BACKEND_URL when backend is deployed (e.g. "https://your-app.railway.app/summarize")
 * TODO: Implement global spend cap on the backend — hard $ ceiling, not just per-user rate limit
 */

const BACKEND_URL = null;

// Free summaries per month when routing through your backend (your cost).
// BYOK mode (BACKEND_URL = null) uses the user's own key — no limit needed.
const FREE_LIMIT = 10;

const SYSTEM_PROMPT = `You are a conversation summariser. Given a chat transcript, produce a compact summary the user can paste at the start of a NEW chat to restore context efficiently.

Use exactly this format:

We've been working on: [1–2 sentences on the task and goal]

Key decisions and findings:
• [point]
• [point]
• [point]

Critical context: [constraints, requirements, or background the new chat must have]

Where we left off: [the specific next question or decision we were about to tackle — not just the topic, but the actionable next step]

Under 150 words. Do not add commentary before or after the summary block.`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Return usage count so popup can show "X of 10 used this month" ──────────
  if (message.type === "GET_SUMMARY_COUNT") {
    chrome.storage.local.get(["summarizeCount", "summarizeMonth"], (data) => {
      const thisMonth = new Date().toISOString().slice(0, 7); // "2026-04"
      const count = data.summarizeMonth === thisMonth ? (data.summarizeCount || 0) : 0;
      sendResponse({ count, limit: FREE_LIMIT, backendLive: !!BACKEND_URL });
    });
    return true;
  }

  // ── Summarise via Haiku ───────────────────────────────────────────────────────
  if (message.type === "GET_SUMMARY") {

    const maxChars = 40000; // ~10K tokens — well within Haiku's context
    const text = message.text.length > maxChars
      ? message.text.slice(-maxChars)
      : message.text;

    // ── Route through backend proxy ───────────────────────────────────────────
    if (BACKEND_URL) {
      chrome.storage.local.get(["summarizeCount", "summarizeMonth", "userId"], async (data) => {
        const thisMonth = new Date().toISOString().slice(0, 7);
        const count = data.summarizeMonth === thisMonth ? (data.summarizeCount || 0) : 0;
        if (count >= FREE_LIMIT) {
          sendResponse({ error: "limit_reached" });
          return;
        }
        // Generate a persistent userId if not yet created
        let userId = data.userId;
        if (!userId) {
          userId = crypto.randomUUID();
          chrome.storage.local.set({ userId });
        }
        try {
          const response = await fetch(BACKEND_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, transcript: text, platform: message.platform || "claude" }),
          });
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            sendResponse({ error: err.error || `Server error: ${response.status}` });
            return;
          }
          const data2 = await response.json();
          // Increment counter only on success, store current month
          chrome.storage.local.set({
            summarizeCount: count + 1,
            summarizeMonth: thisMonth,
            pendingSummary: data2.summary
          });
          sendResponse({ summary: data2.summary });
        } catch(e) {
          sendResponse({ error: `Request failed: ${e.message}` });
        }
      });
      return true;
    }

    // ── Fallback: user-supplied API key (BYOK) — no usage limit ──────────────
    chrome.storage.local.get("anthropicApiKey", async ({ anthropicApiKey }) => {
      if (!anthropicApiKey) {
        sendResponse({ error: "No API key — add it in the extension popup." });
        return;
      }
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicApiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 500,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: `Transcript:\n\n${text}` }],
          }),
        });
        if (!response.ok) {
          const err = await response.json();
          sendResponse({ error: `API error: ${err.error?.message || response.status}` });
          return;
        }
        const data = await response.json();
        const summary = data.content[0].text.trim();
        chrome.storage.local.set({ pendingSummary: summary });
        sendResponse({ summary });
      } catch(e) {
        sendResponse({ error: `Request failed: ${e.message}` });
      }
    });
    return true;
  }

  // ── Open new chat tab and inject summary ─────────────────────────────────────
  if (message.type === "OPEN_NEW_CHAT") {
    const newChatUrl = message.platform === "chatgpt"
      ? "https://chatgpt.com/"
      : "https://claude.ai/new";
    chrome.tabs.create({ url: newChatUrl }, (tab) => {
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { type: "INJECT_SUMMARY", summary: message.summary });
          }, 500);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    return;
  }

  // ── Badge update ─────────────────────────────────────────────────────────────
  if (message.type !== "UPDATE_BADGE") return;

  const tabId = sender.tab?.id;
  if (!tabId) return;

  const { tokens, color } = message;

  let badgeText;
  if (tokens >= 1000) {
    const k = tokens / 1000;
    badgeText = k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  } else {
    badgeText = String(tokens);
  }

  chrome.action.setBadgeText({ text: badgeText, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
});

// Clear badge when navigating away from supported platforms
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tab.url &&
      !tab.url.includes("claude.ai") && !tab.url.includes("chatgpt.com")) {
    chrome.action.setBadgeText({ text: "", tabId });
  }
});
