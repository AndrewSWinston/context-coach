/**
 * popup.js — ContextCoach
 * Reads stored token data and renders the popup UI.
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
          sessionTotal = 0, isExact = false,
          threshold, message, color, dot,
          timestamp,
        } = tokenData;

        function roundK(n) {
          if (n < 1000) return "< 1,000";
          return (Math.round(n / 1000) * 1000).toLocaleString();
        }
        const formatted = isExact ? total.toLocaleString() : "~" + roundK(total);
        const sessionFormatted = isExact ? sessionTotal.toLocaleString() : "~" + roundK(sessionTotal);
        const countLabel = isExact ? "actual" : "est.";
        const ago = timestamp ? timeAgo(timestamp) : "";
        const platformName = isChatGPT ? "ChatGPT" : "Claude";

        container.innerHTML = `
          <div class="status-block">
            <div style="font-size:11px;opacity:0.5;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">${platformName}</div>
            <div class="token-count">${formatted} <span style="font-size:12px;font-weight:400;opacity:0.6">tokens ${countLabel}</span></div>
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

// ─── API Key Management ───────────────────────────────────────────────────────

if (chrome.runtime?.id) {
  try {
    // Load saved key (show masked if present)
    chrome.storage.local.get("anthropicApiKey", ({ anthropicApiKey }) => {
      if (anthropicApiKey) {
        document.getElementById("api-key-input").value = anthropicApiKey;
        document.getElementById("api-key-status").textContent = "✓ Key saved";
      }
    });
  } catch(e) {}
}

document.getElementById("api-key-save").addEventListener("click", () => {
  const key = document.getElementById("api-key-input").value.trim();
  const status = document.getElementById("api-key-status");
  if (!key.startsWith("sk-ant-")) {
    status.style.color = "#ef4444";
    status.textContent = "Invalid key format";
    return;
  }
  if (chrome.runtime?.id) {
    try {
      chrome.storage.local.set({ anthropicApiKey: key }, () => {
        status.style.color = "#22c55e";
        status.textContent = "✓ Key saved";
      });
    } catch(e) {}
  }
});

// ─── Usage count display ─────────────────────────────────────────────────────

if (chrome.runtime?.id) {
  try {
    chrome.runtime.sendMessage({ type: "GET_SUMMARY_COUNT" }, ({ count = 0, limit = 10, backendLive = false } = {}) => {
      const el = document.getElementById("usage-count");
      const apiSection = document.getElementById("api-key-section");
      if (!el) return;

      if (!backendLive) {
        // Dev/BYOK mode — show API key field, hide upgrade section usage framing
        el.textContent = "Using your own API key (dev mode)";
      } else {
        // Backend live — hide API key section entirely, show usage count
        if (apiSection) apiSection.style.display = "none";
        if (count >= limit) {
          el.textContent = `${count} of ${limit} used this month — upgrade for unlimited`;
          el.style.color = "#ef4444";
          document.getElementById("upgrade-btn").classList.add("live");
        } else {
          el.textContent = `${count} of ${limit} free this month`;
          if (count >= limit - 2) el.style.color = "#f59e0b"; // warn on last 2
        }
      }
    });
  } catch(e) {}
}

// ─── Upgrade modal ───────────────────────────────────────────────────────────

document.getElementById("upgrade-btn").addEventListener("click", () => {
  document.getElementById("upgrade-modal").classList.add("visible");
});

document.getElementById("modal-close").addEventListener("click", () => {
  document.getElementById("upgrade-modal").classList.remove("visible");
});

// Click outside modal to dismiss
document.getElementById("upgrade-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove("visible");
  }
});

function timeAgo(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}
