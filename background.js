/**
 * background.js — ContextCoach
 * Service worker. Receives token count from content.js and updates the badge.
 * Also opens a new chat tab when the user clicks "Copy to New Chat" in the banner.
 *
 * [The direct-to-Haiku summarize path and BYOK API-key flow were removed
 *  2026-04-14 for beta simplicity. See tag v0.1.0-pre-trim or session log 13
 *  to restore when a paid backend tier goes live. Prior code included:
 *  GET_SUMMARY / GET_SUMMARY_COUNT handlers, BACKEND_URL proxy routing,
 *  anthropicApiKey storage, and the api.anthropic.com fetch.]
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

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
