/**
 * popup.js — ContextCoach
 * Reads stored token data and renders the popup UI.
 *
 * [API-key input, usage-count display, and upgrade-modal handlers were
 *  removed 2026-04-14 along with the Haiku summarize path. See tag
 *  v0.1.0-pre-trim or session log 13 to restore if needed.]
 */

if (chrome.runtime?.id) {
  try {
    // Request live data from the active tab's content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      const container = document.getElementById("main-content");

      const isClaude = tab?.url?.includes("claude.ai");
      const isChatGPT = tab?.url?.includes("chatgpt.com");
      if (!tab || (!isClaude && !isChatGPT)) {
        container.innerHTML = `<div style="padding:12px;opacity:0.6;font-size:13px;">Open a Claude or ChatGPT chat to see token data.</div>`;
        return;
      }

      container.innerHTML = `<div style="padding:12px;opacity:0.6;font-size:13px;">Calculating…</div>`;

      chrome.tabs.sendMessage(tab.id, { type: "GET_TOKEN_DATA" }, (tokenData) => {
        if (chrome.runtime.lastError || !tokenData) {
          container.innerHTML = `<div style="padding:12px;opacity:0.6;font-size:13px;">Reload the claude.ai tab to activate the monitor.</div>`;
          return;
        }

        const {
          total, textTokens, pdfTokens, imageTokens,
          pdfCount, imageCount,
          docxTokens = 0, docxCount = 0,
          pptxTokens = 0, pptxCount = 0,
          projectFileTokens = 0, projectFileCount = 0,
          sessionTotal = 0,
          threshold, message, color, dot,
          timestamp,
        } = tokenData;

        function roundK(n) {
          if (n < 1000) return "< 1,000";
          return (Math.round(n / 1000) * 1000).toLocaleString();
        }
        const formatted = "~" + roundK(total);
        const sessionFormatted = "~" + roundK(sessionTotal);
        const ago = timestamp ? timeAgo(timestamp) : "";
        const platformName = isChatGPT ? "ChatGPT" : "Claude";

        container.innerHTML = `
          <div class="status-block">
            <div style="font-size:11px;opacity:0.5;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">${platformName}</div>
            <div class="token-count">${formatted} <span style="font-size:12px;font-weight:400;opacity:0.6">tokens est.</span></div>
            <div class="token-label">context load — next query</div>
            <div class="token-count" style="font-size:18px;margin-top:6px">${sessionFormatted}</div>
            <div class="token-label">session total (since opened)</div>
            <div class="status-badge" style="background: ${color}22; color: ${color}; border: 1px solid ${color}44;">
              ${dot} ${threshold}
            </div>
            <div class="message">${message}</div>
          </div>

          <div class="breakdown">
            <div class="breakdown-title">Breakdown</div>
            <div class="breakdown-row">
              <span>Conversation text</span>
              <span class="value">${textTokens.toLocaleString()}</span>
            </div>
            ${pdfCount > 0 ? `
            <div class="breakdown-row">
              <span>PDFs (${pdfCount} detected)</span>
              <span class="value">~${pdfTokens.toLocaleString()}</span>
            </div>` : ""}
            ${imageCount > 0 ? `
            <div class="breakdown-row">
              <span>Images (${imageCount} detected)</span>
              <span class="value">~${imageTokens.toLocaleString()}</span>
            </div>` : ""}
            ${docxCount > 0 ? `
            <div class="breakdown-row">
              <span>Word docs (${docxCount}) <span style="font-size:10px;opacity:0.7">min estimate</span></span>
              <span class="value">~${docxTokens.toLocaleString()}</span>
            </div>` : ""}
            ${pptxCount > 0 ? `
            <div class="breakdown-row">
              <span>Presentations (${pptxCount}) <span style="font-size:10px;opacity:0.7">min estimate</span></span>
              <span class="value">~${pptxTokens.toLocaleString()}</span>
            </div>` : ""}
            ${projectFileCount > 0 ? `
            <div class="breakdown-row">
              <span>Project knowledge (${projectFileCount}) <span style="font-size:10px;opacity:0.7">loaded every turn</span></span>
              <span class="value">~${projectFileTokens.toLocaleString()}</span>
            </div>` : ""}
          </div>

          <div class="footer" style="line-height:1.5;">
            <span style="color:#999;">File uploads may not be fully reflected in estimates.</span><br>
            Updated ${ago}
          </div>
        `;
      });
    });
  } catch (e) { /* extension context invalidated — silently skip */ }
}

function timeAgo(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}
