/**
 * content.js — ContextCoach
 * Runs on claude.ai. Reads conversation text, estimates token count,
 * injects a status banner, and messages the background script to update the badge.
 */

// ─── Platform detection ───────────────────────────────────────────────────────

const PLATFORM = window.location.hostname.includes('chatgpt.com') ? 'chatgpt' : 'claude';

// ─── Platform config ──────────────────────────────────────────────────────────

const PLATFORM_CONFIG = {
  claude: {
    name: 'Claude',
    // System prompt overhead: ~15,000–20,000 tokens (tool schemas, memory, skills, safety rules)
    systemOverhead: 15000,
    // Selector pairs: [userSelector, assistantSelector]
    // .\\!font-user-message = user turn container (confirmed April 2026)
    // .font-claude-response = assistant content (multiple per turn — used for text, not turn count)
    userSelector: '.\\!font-user-message',
    assistantSelector: '.font-claude-response',
    imgSelectors: ['.\\!font-user-message img', '.font-claude-response img'],
  },
  chatgpt: {
    name: 'ChatGPT',
    // System overhead: ~2,500–6,000 tokens (per ChatGPT self-report, April 2026)
    systemOverhead: 4000,
    userSelector: '[data-message-author-role="user"]',
    assistantSelector: '[data-message-author-role="assistant"]',
    imgSelectors: ['[data-message-author-role="user"] img', '[data-message-author-role="assistant"] img'],
  },
};

const CONFIG = PLATFORM_CONFIG[PLATFORM];

// ─── Constants ───────────────────────────────────────────────────────────────

const PDF_TOKENS_PER_PAGE = 2000;
const IMAGE_TOKENS_PER_MEGAPIXEL = 1600;
const IMAGE_DEFAULT_MEGAPIXELS = 2.0;
const SYSTEM_OVERHEAD_TOKENS = CONFIG.systemOverhead;

// Thresholds are applied to CONTROLLABLE tokens (total minus system overhead
// and project knowledge). Green < 10K, Yellow 10K–20K, Red ≥ 20K.
const THRESHOLDS = [
  { limit: 10000,  color: "#22c55e", dot: "🟢", label: "Light",    message: "Context is light — keep going." },
  { limit: 20000,  color: "#f59e0b", dot: "🟡", label: "Moderate", message: "Context is growing — start fresh if the topic has shifted." },
  { limit: Infinity, color: "#ef4444", dot: "🔴", label: "Heavy",  message: "Chat is expensive & energy-heavy — start a new chat." },
];

// ─── Display helpers ─────────────────────────────────────────────────────────
// Round to nearest thousand for display — avoids false precision on estimates
function roundK(n) {
  if (n < 1000) return "< 1,000";
  return (Math.round(n / 1000) * 1000).toLocaleString();
}

// ─── Minimal BPE tokeniser (cl100k_base approximation) ───────────────────────
// tiktoken isn't available in the browser. This regex-based splitter closely
// approximates cl100k_base token counts (typically ±5% on English prose).

function countTokens(text) {
  if (!text || text.length === 0) return 0;
  // Split on whitespace, punctuation boundaries — mirrors BPE chunking heuristic
  const tokens = text.match(/[\w']+|[^\s\w]/g);
  return tokens ? tokens.length : 0;
}

// ─── Attachment pattern matching (text-based fallback) ───────────────────────
// Catches uploads that DOM detection misses: PDF text extracted into the chat,
// references to attachments in tool output, and any platform (e.g. ChatGPT)
// where we don't have reliable DOM chip selectors. The Math.max merge in
// analyze() prevents double-counting against DOM detection.

const PDF_PATTERNS = [
  /(?<![\/\w])[\w\-]+\.pdf\b/gi,
  /\[PDF[^\]]*\]/gi,
  /I(?:'ve)?\s+uploaded\s+(?:a\s+)?pdf/gi,
  /I(?:'ve)?\s+attached\s+(?:a\s+)?pdf/gi,
];

const DOCX_PATTERNS = [
  /(?<![\/\w])[\w\-]+\.docx?\b/gi,
];

const PPTX_PATTERNS = [
  /(?<![\/\w])[\w\-]+\.pptx?\b/gi,
];

// Conservative minimums — actual load is likely higher
const DOCX_TOKENS_DEFAULT = 3000;
const PPTX_TOKENS_DEFAULT = 3200;

const IMAGE_PATTERNS = [
  /\b\w[\w\s\-]*\.(?:png|jpg|jpeg|gif|webp|bmp|tiff?)\b/gi,
  /uploaded\s+(?:a\s+)?(?:image|photo|screenshot|picture)/gi,
  /shared\s+(?:a\s+)?(?:image|photo|screenshot|picture)/gi,
  /attached\s+(?:a\s+)?(?:image|photo|screenshot|picture)/gi,
  /\[(?:Image|Screenshot|Photo)[^\]]*\]/gi,
  /screenshot\s+of/gi,
  /here'?s?\s+(?:a\s+)?screenshot/gi,
];

const PAGE_COUNT_RE = /(\d+)\s*[-–]?\s*page\s+pdf|pdf\s+(?:with\s+)?(\d+)\s+pages?/i;
const MEGAPIXEL_RE = /(\d+(?:\.\d+)?)\s*mp\b|(\d+)\s*x\s*(\d+)\s*(?:px|pixels?)?/i;

function countAttachmentTokens(text) {
  let pdfTokens = 0;
  let imageTokens = 0;
  let pdfCount = 0;
  let imageCount = 0;
  const seenSpans = [];

  function alreadySeen(start, end) {
    return seenSpans.some(([s, e]) => start < e && end > s);
  }

  for (const pattern of PDF_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (alreadySeen(m.index, m.index + m[0].length)) continue;
      seenSpans.push([m.index, m.index + m[0].length]);
      const ctx = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
      const pageMatch = PAGE_COUNT_RE.exec(ctx);
      const pages = pageMatch ? parseInt(pageMatch[1] || pageMatch[2]) : 5;
      pdfTokens += pages * PDF_TOKENS_PER_PAGE;
      pdfCount++;
    }
  }

  for (const pattern of IMAGE_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (alreadySeen(m.index, m.index + m[0].length)) continue;
      seenSpans.push([m.index, m.index + m[0].length]);
      const ctx = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
      const mpMatch = MEGAPIXEL_RE.exec(ctx);
      let mp = IMAGE_DEFAULT_MEGAPIXELS;
      if (mpMatch) {
        if (mpMatch[1]) mp = parseFloat(mpMatch[1]);
        else mp = (parseInt(mpMatch[2]) * parseInt(mpMatch[3])) / 1_000_000;
      }
      imageTokens += Math.round(mp * IMAGE_TOKENS_PER_MEGAPIXEL);
      imageCount++;
    }
  }

  let docxTokens = 0;
  let docxCount = 0;
  for (const pattern of DOCX_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (alreadySeen(m.index, m.index + m[0].length)) continue;
      seenSpans.push([m.index, m.index + m[0].length]);
      docxTokens += DOCX_TOKENS_DEFAULT;
      docxCount++;
    }
  }

  let pptxTokens = 0;
  let pptxCount = 0;
  for (const pattern of PPTX_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (alreadySeen(m.index, m.index + m[0].length)) continue;
      seenSpans.push([m.index, m.index + m[0].length]);
      pptxTokens += PPTX_TOKENS_DEFAULT;
      pptxCount++;
    }
  }

  return { pdfTokens, imageTokens, pdfCount, imageCount, docxTokens, docxCount, pptxTokens, pptxCount };
}

// ─── DOM scraping ─────────────────────────────────────────────────────────────

function getConversationText() {
  let text = "";
  const userEls = document.querySelectorAll(CONFIG.userSelector);
  const assistantEls = document.querySelectorAll(CONFIG.assistantSelector);
  userEls.forEach(el => { text += el.innerText + "\n"; });
  assistantEls.forEach(el => { text += el.innerText + "\n"; });
  return text;
}

function countConversationImages() {
  // Count <img> tags rendered inside the conversation, with token estimates
  // based on actual dimensions where available.
  const selectors = CONFIG.imgSelectors;
  const seen = new Set();
  let totalTokens = 0;
  let count = 0;

  function estimateImgTokens(img) {
    // Use natural dimensions if loaded, else display dimensions, else default
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    // Skip icons and tiny UI elements
    if (w > 0 && w <= 64) return 0;
    if (h > 0 && h <= 64) return 0;
    const mp = (w > 0 && h > 0)
      ? (w * h) / 1_000_000
      : IMAGE_DEFAULT_MEGAPIXELS;
    return Math.round(mp * IMAGE_TOKENS_PER_MEGAPIXEL);
  }

  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(img => {
      if (seen.has(img)) return;
      seen.add(img);
      const t = estimateImgTokens(img);
      if (t > 0) { totalTokens += t; count++; }
    });
  }

  // Fallback if no conversation container matched
  if (count === 0) {
    document.querySelectorAll('img').forEach(img => {
      if (seen.has(img)) return;
      seen.add(img);
      const t = estimateImgTokens(img);
      if (t > 0) { totalTokens += t; count++; }
    });
  }

  return { count, tokens: totalTokens };
}

// ─── DOM-based file attachment detection ─────────────────────────────────────
// Claude renders uploaded files as thumbnail chips (div.group/thumbnail) with a
// type badge (p.uppercase.truncate). This catches files the text-regex misses —
// the attachment chips live outside the conversation turn selectors we scrape.
// Default token estimates per file type when page count is unknown.
// PDF default is deliberately high — underestimating file load is worse than
// overestimating, since the whole point is to warn users about hidden cost.
const PDF_TOKENS_DEFAULT = 30000;  // ~15 pages assumed; real PDFs vary enormously (a full book is 10x+)

// Token estimate for text-based project knowledge files (md, txt, csv, etc.)
// ~18 tokens per line is a reasonable average for natural language + markdown.
const TEXT_TOKENS_PER_LINE = 18;
const TEXT_TOKENS_FALLBACK = 2000;  // fallback when line count not available

// File types that are binary documents (get flat per-file estimates)
const BINARY_DOC_TYPES = new Set(['pdf', 'docx', 'doc', 'pptx', 'ppt']);
// File types that are text-based (can estimate from line count)
const TEXT_FILE_TYPES = new Set(['md', 'txt', 'csv', 'tsv', 'json', 'xml', 'html', 'py', 'js', 'ts', 'jsx', 'tsx', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'log', 'rst', 'tex']);

function countDOMAttachments() {
  // Claude renders each uploaded file as a thumbnail chip (div.group/thumbnail).
  // Each file appears ~2x in the DOM: once in the user turn area, once echoed
  // in the assistant response area. Chips are NOT inside .!font-user-message,
  // so we can't distinguish user vs assistant by selector. Instead, count
  // unique type:filename pairs and halve the occurrence count.
  //
  // SCOPE: Only count chips inside the conversation area, not project knowledge
  // panel chips. Conversation chips are inside [data-testid] containers that
  // are descendants of the main conversation thread.
  // Badge-first detection: Claude's chip wrapper class has changed over time
  // (was div.group/thumbnail). The badge p.uppercase.truncate is the most stable
  // marker for a file chip. Walk up from the badge to the nearest containing
  // button (the chip's clickable region) to identify the chip.
  const badges = document.querySelectorAll('p.uppercase.truncate');
  const uniqueFiles = new Map(); // "type:filename" → count

  badges.forEach(badge => {
    const type = badge.textContent.trim().toLowerCase();
    if (!BINARY_DOC_TYPES.has(type)) return;

    // Find the chip container: nearest ancestor button, or fallback to the
    // badge's grandparent (chip wrapper). Use whichever exists.
    const btn = badge.closest('button') || badge.parentElement?.parentElement;
    const t = btn || badge;

    // Skip project knowledge panel chips — they sit inside the project sidebar,
    // not inside conversation turn containers. Project panel chips are handled
    // separately by countProjectFiles().
    if (isProjectPanelChip(t)) return;

    // Extract filename from h3 inside the chip button (preferred) or from
    // button text minus the badge suffix.
    const h3 = btn?.querySelector('h3');
    let name = h3 ? h3.textContent.trim() : '';
    if (!name && btn) {
      const fullText = btn.textContent.trim();
      name = fullText.replace(new RegExp(type + '$', 'i'), '').trim();
    }
    const normalizedType = type.startsWith('doc') ? 'docx' : type.startsWith('ppt') ? 'pptx' : type;

    // Dedup by filename across the whole DOM. Same file echoed in user + assistant
    // turns collapses to one entry. Unnamed chips fall through to occurrence-counted
    // bucket and get halved at tally time.
    const key = normalizedType + ':' + (name ? name.toLowerCase() : '__unnamed__');
    uniqueFiles.set(key, (uniqueFiles.get(key) || 0) + 1);
  });

  // Named files count once each; unnamed bucket is halved (echo dedup).
  const files = { pdf: 0, docx: 0, pptx: 0 };
  for (const [key, count] of uniqueFiles) {
    const type = key.split(':')[0];
    if (files[type] === undefined) continue;
    if (key.endsWith(':__unnamed__')) {
      files[type] += Math.ceil(count / 2);
    } else {
      files[type] += 1;
    }
  }

  return {
    domPdfCount: files.pdf,
    domPdfTokens: files.pdf * PDF_TOKENS_DEFAULT,
    domDocxCount: files.docx,
    domDocxTokens: files.docx * DOCX_TOKENS_DEFAULT,
    domPptxCount: files.pptx,
    domPptxTokens: files.pptx * PPTX_TOKENS_DEFAULT,
  };
}

// ─── Project knowledge file detection ────────────────────────────────────────
// Claude Projects inject all knowledge files into the system prompt on every
// API call. These are significant hidden token costs that no competitor detects.
// We scan ALL div.group/thumbnail chips and identify project panel files by
// their DOM location (outside conversation turns). The aria-label attribute
// contains filename, type, and line count — e.g. "AW_Challenge_Prompt.md, md, 61 lines"

function isProjectPanelChip(el) {
  // Project knowledge chips have an aria-label with line/word count metadata,
  // e.g. "AW_Challenge_Prompt.md, md, 61 lines". Conversation attachment chips
  // (PDF/DOCX uploads in the chat) have no aria-label or no line/word count.
  // This is more reliable than DOM-position heuristics, since Claude's
  // conversation container classes change over time.
  const btn = el.tagName === 'BUTTON' ? el : el.closest('button');
  if (!btn) return false;
  const aria = btn.getAttribute('aria-label') || '';
  return /\d+\s+(lines?|words?)/i.test(aria);
}

function countProjectFiles() {
  // Badge-first detection (see countDOMAttachments comment above).
  const badges = document.querySelectorAll('p.uppercase.truncate');
  const projectFiles = [];  // { name, type, lines, tokens }
  let totalTokens = 0;
  const seen = new Set();  // deduplicate by filename

  badges.forEach(badge => {
    const btn = badge.closest('button');
    if (!btn) return;
    const t = btn;
    // Only count project panel chips (not conversation attachments)
    if (!isProjectPanelChip(t)) return;
    const ariaLabel = btn.getAttribute('aria-label') || '';

    // Parse aria-label: "filename.ext, ext, N lines" or "filename.ext, ext, N words"
    const parts = ariaLabel.split(',').map(s => s.trim());
    const filename = parts[0] || '';
    if (!filename || seen.has(filename)) return;
    seen.add(filename);

    const type = badge.textContent.trim().toLowerCase();

    // Extract line/word count from aria-label
    let lineCount = 0;
    const lineMatch = ariaLabel.match(/(\d+)\s+lines?/i);
    const wordMatch = ariaLabel.match(/(\d+)\s+words?/i);
    if (lineMatch) {
      lineCount = parseInt(lineMatch[1]);
    } else if (wordMatch) {
      // ~7 words per line as rough conversion
      lineCount = Math.ceil(parseInt(wordMatch[1]) / 7);
    }

    let tokens;
    if (BINARY_DOC_TYPES.has(type)) {
      // Binary docs: use existing per-type defaults
      if (type === 'pdf') tokens = PDF_TOKENS_DEFAULT;
      else if (type === 'doc' || type === 'docx') tokens = DOCX_TOKENS_DEFAULT;
      else if (type === 'ppt' || type === 'pptx') tokens = PPTX_TOKENS_DEFAULT;
      else tokens = TEXT_TOKENS_FALLBACK;
    } else if (lineCount > 0) {
      // Text files with known line count
      tokens = lineCount * TEXT_TOKENS_PER_LINE;
    } else {
      // Unknown — conservative fallback
      tokens = TEXT_TOKENS_FALLBACK;
    }

    totalTokens += tokens;
    projectFiles.push({ name: filename, type, lines: lineCount, tokens });
  });

  return {
    projectFileCount: projectFiles.length,
    projectFileTokens: totalTokens,
    projectFiles,  // detailed list for potential future use in popup
  };
}

// ─── Threshold lookup ─────────────────────────────────────────────────────────

// Classify context health based on tokens the user can CONTROL — excludes fixed
// costs (system overhead + project knowledge files) that are baked in regardless
// of conversation length. The banner/badge still display the full real total.
function getThreshold(tokens, fixedOverhead) {
  const controllableTokens = Math.max(0, tokens - (fixedOverhead || SYSTEM_OVERHEAD_TOKENS));
  return THRESHOLDS.find(t => controllableTokens < t.limit);
}

// ─── Inject Summary Prompt ───────────────────────────────────────────────────
// [The direct-to-Haiku "AI Summary" path and BYOK API-key flow were removed
//  2026-04-14 for beta simplicity. See tag v0.1.0-pre-trim or session log 13
//  to restore when a paid backend tier goes live.]

const SUMMARY_PROMPT = `Summarize this conversation so I can continue in a new chat without losing context. I'll paste your response as my first message there. Use exactly this format:

We've been working on: [1–2 sentences on the task and goal]

Key decisions and findings:
• [point]
• [point]
• [point]

Critical context: [constraints, requirements, or background the new chat must have]

Where we left off: [the specific next question or decision we were about to tackle — not just the topic, but the actionable next step]

Under 150 words. Do not add commentary before or after the summary block. End your response with the exact text: [SUMMARY COMPLETE]`;

function injectPromptIntoChat(resultEl) {
  const input = document.querySelector('div[contenteditable="true"]')
    || document.querySelector('textarea[placeholder]')
    || document.querySelector('div[role="textbox"]');

  if (!input) {
    if (resultEl) resultEl.textContent = "⚠ Couldn't find the input box — click in the chat first.";
    return;
  }

  input.focus();
  if (input.tagName === "TEXTAREA") {
    input.value = SUMMARY_PROMPT;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    input.innerHTML = "";
    document.execCommand("insertText", false, SUMMARY_PROMPT);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Auto-submit after a short delay so React can register the input
  setTimeout(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
  }, 150);

  if (resultEl) resultEl.textContent = "✅ Summary prompt sent — copy the response and paste into a new chat.";
}

// ─── Banner ───────────────────────────────────────────────────────────────────

const BANNER_ID = "context-coach-banner";

function removeBanner() {
  const existing = document.getElementById(BANNER_ID);
  if (existing) existing.remove();
}

function injectBanner(tokens, threshold, conversationText, textTokens, imageTokens) {
  removeBanner();

  const contextFormatted = roundK(tokens);
  const sessionFormatted = roundK(sessionTotalTokens);
  // Show "New Chat" button on yellow and red banners. On yellow, the conversation
  // may be short but project knowledge or attachments are driving the load — users
  // should still have the option to start fresh. Only gate summarization (the API
  // call) on having enough text, not the button itself.
  const showNewChatButton = threshold.label === "Moderate" || threshold.label === "Heavy";

  // Override message when images dominate the load
  const imageHeavy = imageTokens > 0 && imageTokens > (tokens * 0.5);
  const bannerMessage = imageHeavy
    ? "Images are driving the load — normal for image chats. Start a new chat for new topics."
    : threshold.message;

  // Savings estimate: how much processing a fresh chat would avoid
  // Fresh chat = system overhead + ~1,000 tokens for one query/response pair
  const FRESH_CHAT_TOKENS = SYSTEM_OVERHEAD_TOKENS + 1000;
  const savingsPercent = tokens > FRESH_CHAT_TOKENS
    ? Math.round((1 - FRESH_CHAT_TOKENS / tokens) * 100)
    : 0;
  const showSavings = threshold.label === "Heavy" && savingsPercent > 10;

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 999999;
    background: ${threshold.color};
    color: white;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    font-weight: 600;
    padding: 8px 16px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;

  banner.innerHTML = `
    <div style="display:flex; align-items:flex-start; justify-content:space-between;">
      <span style="white-space:nowrap;">${threshold.dot} <strong>~${contextFormatted} tokens</strong> &nbsp;·&nbsp; session: <strong>~${sessionFormatted}</strong></span>
      <div style="display:flex; align-items:center; gap:10px;">
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
          <span style="font-size:12px;opacity:0.95;">${bannerMessage}</span>
          ${showSavings ? `<span style="font-size:12px;opacity:0.9;">Starting fresh would cut processing and energy use by ~${savingsPercent}%</span>` : ""}
        </div>
        ${showNewChatButton ? `
        <button id="context-coach-inject-prompt" style="
          background: rgba(255,255,255,0.25);
          border: none;
          color: white;
          font-size: 12px;
          cursor: pointer;
          padding: 2px 10px;
          border-radius: 4px;
          white-space: nowrap;
        ">✏️ Summarize Prompt</button>` : ""}
        <button id="context-coach-dismiss" style="
          background: rgba(255,255,255,0.25);
          border: none;
          color: white;
          font-size: 13px;
          cursor: pointer;
          padding: 2px 8px;
          border-radius: 4px;
          font-weight: bold;
        ">✕</button>
      </div>
    </div>
    <div id="context-coach-result" style="
      font-size: 12px;
      margin-top: 4px;
      min-height: 0;
      opacity: 0.95;
    "></div>
  `;

  document.body.prepend(banner);

  document.getElementById("context-coach-dismiss").addEventListener("click", () => {
    removeBanner();
    lastDismissedAtTier = threshold.label;
  });

  if (showNewChatButton) {
    const injectBtn = document.getElementById("context-coach-inject-prompt");
    const result = document.getElementById("context-coach-result");

    // Restore button state if poll is already running or complete
    if (summaryPollResult === "waiting") {
      injectBtn.disabled = true;
      injectBtn.textContent = "⏳ Waiting…";
      result.textContent = "✅ Summary prompt sent — waiting for response…";
    } else if (summaryPollResult === "ready") {
      injectBtn.textContent = "📋 Copy to New Chat";
      result.textContent = "✅ Summary ready. If you were editing a document, copy the latest version too. If you're in a Claude or ChatGPT Project, open your new chat there instead.";
    }

    injectBtn.addEventListener("click", () => {
      // If summary is ready, do the copy+open
      if (summaryPollResult === "ready" && summaryText) {
        navigator.clipboard.writeText(summaryText).catch(() => {});
        if (chrome.runtime?.id) {
          try { chrome.runtime.sendMessage({ type: "OPEN_NEW_CHAT", summary: summaryText, platform: PLATFORM }); } catch(e) {}
        }
        summaryPollResult = null;
        summaryText = null;
        return;
      }

      // Otherwise start the inject + poll flow
      const userTurnsBefore = document.querySelectorAll(CONFIG.userSelector).length;
      injectPromptIntoChat(document.getElementById("context-coach-result"));
      summaryPollResult = "waiting";
      injectBtn.disabled = true;
      injectBtn.textContent = "⏳ Waiting…";
      document.getElementById("context-coach-result").textContent = "✅ Summary prompt sent — waiting for response…";

      if (summaryPoll) clearInterval(summaryPoll);

      const SENTINEL = "[SUMMARY COMPLETE]";
      summaryPoll = setInterval(() => {
        const userTurns = document.querySelectorAll(CONFIG.userSelector);
        if (userTurns.length <= userTurnsBefore) return;

        const assistantBlocks = document.querySelectorAll(CONFIG.assistantSelector);
        if (assistantBlocks.length === 0) return;
        // Search all blocks for sentinel — last block may be a UI element, not response text
        const matchingBlock = [...assistantBlocks].reverse().find(b => b.innerText.includes(SENTINEL));
        if (!matchingBlock) return;
        const currentText = matchingBlock.innerText || "";

        if (currentText.includes(SENTINEL)) {
          clearInterval(summaryPoll);
          summaryPoll = null;
          // Wait 1.5s after sentinel appears to let streaming finish
          setTimeout(() => {
            const finalBlock = [...document.querySelectorAll(CONFIG.assistantSelector)]
              .reverse().find(b => b.innerText.includes(SENTINEL));
            summaryText = finalBlock ? finalBlock.innerText.replace(SENTINEL, "").trim() : currentText.replace(SENTINEL, "").trim();
            summaryPollResult = "ready";

            // Update button — find it fresh in case banner redrawed
            const btn = document.getElementById("context-coach-inject-prompt");
            const res = document.getElementById("context-coach-result");
            if (btn) { btn.disabled = false; btn.textContent = "📋 Copy to New Chat"; }
            if (res) res.textContent = "✅ Summary ready. If you were editing a document, copy the latest version too. If you're in a Claude or ChatGPT Project, open your new chat there instead.";
          }, 5000);
        }
      }, 800);

      // Timeout after 90 seconds
      setTimeout(() => {
        if (summaryPollResult === "waiting") {
          clearInterval(summaryPoll);
          summaryPoll = null;
          summaryPollResult = null;
          const btn = document.getElementById("context-coach-inject-prompt");
          const res = document.getElementById("context-coach-result");
          if (btn) { btn.disabled = false; btn.textContent = "✏️ Summarize Prompt"; }
          if (res) res.textContent = "⚠ Timed out — copy the summary manually, then open a new chat.";
        }
      }, 90000);
    });

  }
}

// ─── Main analysis ────────────────────────────────────────────────────────────

let lastTokenCount = 0;
let lastDismissedAtTier = null;
let summaryPoll = null; // active sentinel poll — survives banner redraws
let summaryPollResult = null; // "waiting" | "ready" | null — drives button state on redraw
let summaryText = null; // captured summary text once sentinel fires
let sessionTotalTokens = 0;  // running sum of context load per turn, since page load
let lastAssistantTurnCount = 0; // tracks # of assistant messages to detect new turns

function analyze() {
  const text = getConversationText();
  if (!text.trim()) return;

  const textTokens = countTokens(text);

  // Text-pattern detection (catches PDF text extractions, attachment mentions
  // in tool output, and uploads on platforms without reliable DOM chip selectors)
  const textAttach = countAttachmentTokens(text);

  // DOM-based detection (catches file chips the text-regex misses)
  const domAttach = countDOMAttachments();

  // Project knowledge file detection (files in Claude Projects — injected every turn)
  const projectData = countProjectFiles();

  // DOM image detection (uses actual image dimensions where available)
  const { count: domImageCount, tokens: domImageTokens } = countConversationImages();

  // Use whichever detection method found more for each type (Math.max prevents double-count)
  const imageCount = Math.max(domImageCount, textAttach.imageCount);
  const imageTokens = domImageCount > textAttach.imageCount ? domImageTokens : textAttach.imageTokens;
  const pdfCount = Math.max(textAttach.pdfCount, domAttach.domPdfCount);
  const pdfTokens = domAttach.domPdfCount > textAttach.pdfCount ? domAttach.domPdfTokens : textAttach.pdfTokens;
  const docxCount = Math.max(textAttach.docxCount, domAttach.domDocxCount);
  const docxTokens = domAttach.domDocxCount > textAttach.docxCount ? domAttach.domDocxTokens : textAttach.docxTokens;
  const pptxCount = Math.max(textAttach.pptxCount, domAttach.domPptxCount);
  const pptxTokens = domAttach.domPptxCount > textAttach.pptxCount ? domAttach.domPptxTokens : textAttach.pptxTokens;

  const total = textTokens + pdfTokens + imageTokens + docxTokens + pptxTokens + projectData.projectFileTokens + SYSTEM_OVERHEAD_TOKENS;

  // Fixed overhead = sunk cost the user can't control (system prompt + project knowledge).
  // Thresholds are based only on what the user CAN influence (conversation + attachments).
  const fixedOverhead = SYSTEM_OVERHEAD_TOKENS + projectData.projectFileTokens;
  const threshold = getThreshold(total, fixedOverhead);

  // Accumulate session total by counting USER messages (one atomic element per turn,
  // no paragraph nesting). When user turn count increases, the previous assistant
  // response just completed — add that context load to the session total.
  // .\\!font-user-message is the confirmed selector for user turn containers.
  const userEls = document.querySelectorAll(CONFIG.userSelector);
  const currentTurnCount = userEls.length;
  if (currentTurnCount > lastAssistantTurnCount && lastAssistantTurnCount > 0) {
    sessionTotalTokens += total;
    lastDismissedAtTier = null; // new turn — reset dismiss so banner returns
  }
  lastAssistantTurnCount = currentTurnCount;

  // Update badge via background script
  // Guard against extension context invalidation (common during dev reloads)
  if (chrome.runtime?.id) {
    try {
      chrome.runtime.sendMessage({
        type: "UPDATE_BADGE",
        tokens: total,
        color: threshold.color,
        label: threshold.label,
      });
    } catch (e) { /* context invalidated — silently skip */ }
  }

  // Show/update banner if threshold tier changed or count jumped significantly
  const tierChanged = threshold.label !== getThreshold(lastTokenCount, fixedOverhead)?.label;
  if (tierChanged) lastDismissedAtTier = null; // reset dismiss on tier change

  if (lastDismissedAtTier !== threshold.label) {
    injectBanner(total, threshold, text, textTokens, imageTokens);
  }

  lastTokenCount = total;

  // Store for popup
  if (chrome.runtime?.id) {
    try {
      chrome.storage.local.set({
        tokenData: {
          total,
          textTokens,
          pdfTokens,
          imageTokens,
          pdfCount,
          imageCount,
          docxTokens,
          docxCount,
          pptxTokens,
          pptxCount,
          projectFileTokens: projectData.projectFileTokens,
          projectFileCount: projectData.projectFileCount,
          sessionTotal: sessionTotalTokens,
          threshold: threshold.label,
          message: threshold.message,
          color: threshold.color,
          dot: threshold.dot,
          timestamp: Date.now(),
        }
      });
    } catch (e) { /* context invalidated — silently skip */ }
  }
}

// ─── Observe DOM for new messages ────────────────────────────────────────────

function startObserver() {
  const observer = new MutationObserver((mutations) => {
    // Ignore mutations caused by our own banner to avoid re-injection loop
    const onlyBanner = mutations.every(m =>
      m.target.id === BANNER_ID ||
      m.target.closest?.(`#${BANNER_ID}`)
    );
    if (onlyBanner) return;

    clearTimeout(window._analyzeDebounce);
    window._analyzeDebounce = setTimeout(analyze, 800);
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── Inject summary into input (called when new tab loads) ───────────────────

function injectSummaryIntoInput(summary) {
  // Try to find Claude's composer input
  const selectors = [
    'div[contenteditable="true"]',
    'textarea[placeholder]',
    'div[data-testid="chat-input"]',
    'div[role="textbox"]',
  ];

  let input = null;
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) { input = el; break; }
  }

  if (!input) {
    alert("Couldn't find the chat input — your summary is in the clipboard, just paste it (Cmd+V).");
    return;
  }

  // Focus and inject text, firing React's synthetic input event
  input.focus();
  if (input.tagName === "TEXTAREA") {
    input.value = summary;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // contenteditable div — use execCommand to insert full text without truncation
    // Clear existing content first
    input.innerHTML = "";
    input.focus();
    const success = document.execCommand("insertText", false, summary);
    if (!success) {
      // execCommand fallback — set innerText and fire React synthetic event
      input.innerText = summary;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: summary }));
    }
  }

  // Verify text actually landed
  const landed = input.value || input.innerText || "";
  if (!landed.trim()) {
    alert("Couldn't inject into chat input — your summary is in the clipboard, just paste it (Cmd+V).");
  }
}

// Listen for messages from popup or background
if (chrome.runtime?.id) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Popup requesting fresh live data from this tab
    if (message.type === "GET_TOKEN_DATA") {
      const text = getConversationText();
      const textTokens = countTokens(text);
      const textAttach = countAttachmentTokens(text);
      const domAttach = countDOMAttachments();
      const projectData = countProjectFiles();
      const { count: domImgCount, tokens: domImgTokens } = countConversationImages();
      const imageCount = Math.max(domImgCount, textAttach.imageCount);
      const imageTokens = domImgCount > textAttach.imageCount ? domImgTokens : textAttach.imageTokens;
      const pdfCount = Math.max(textAttach.pdfCount, domAttach.domPdfCount);
      const pdfTokens = domAttach.domPdfCount > textAttach.pdfCount ? domAttach.domPdfTokens : textAttach.pdfTokens;
      const docxCount = Math.max(textAttach.docxCount, domAttach.domDocxCount);
      const docxTokens = domAttach.domDocxCount > textAttach.docxCount ? domAttach.domDocxTokens : textAttach.docxTokens;
      const pptxCount = Math.max(textAttach.pptxCount, domAttach.domPptxCount);
      const pptxTokens = domAttach.domPptxCount > textAttach.pptxCount ? domAttach.domPptxTokens : textAttach.pptxTokens;
      const total = textTokens + pdfTokens + imageTokens + docxTokens + pptxTokens + projectData.projectFileTokens + SYSTEM_OVERHEAD_TOKENS;
      const fixedOverhead = SYSTEM_OVERHEAD_TOKENS + projectData.projectFileTokens;
      const threshold = getThreshold(total, fixedOverhead);
      sendResponse({
        total, textTokens, pdfTokens, imageTokens, pdfCount, imageCount,
        docxTokens, docxCount, pptxTokens, pptxCount,
        projectFileTokens: projectData.projectFileTokens,
        projectFileCount: projectData.projectFileCount,
        sessionTotal: sessionTotalTokens,
        threshold: threshold.label, message: threshold.message,
        color: threshold.color, dot: threshold.dot,
        timestamp: Date.now(),
      });
      return true;
    }
  });
}

// Listen for inject message from background (sent when this tab was opened for summary)
if (chrome.runtime?.id) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "INJECT_SUMMARY") {
      // If no summary (e.g. short conversation — just opened a blank new chat), skip injection
      if (!message.summary) return;
      // Wait for DOM to settle before injecting
      const tryInject = (attemptsLeft) => {
        const input = document.querySelector('div[contenteditable="true"], textarea[placeholder], div[role="textbox"]');
        if (input) {
          injectSummaryIntoInput(message.summary);
        } else if (attemptsLeft > 0) {
          setTimeout(() => tryInject(attemptsLeft - 1), 500);
        } else {
          alert("Couldn't find the chat input — your summary is in the clipboard, just paste it (Cmd+V).");
        }
      };
      setTimeout(() => tryInject(6), 1000); // wait 1s then retry up to 6× (4s total)
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

analyze();
startObserver();
