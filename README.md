# ContextCoach

A Chrome extension that estimates your token context load on Claude and ChatGPT — and tells you when to start a new chat.

## What it does

Every AI query re-sends your full conversation history. Long chats silently accumulate cost and degrade response quality. This extension surfaces that load in real time.

**Features:**
- **Context load badge** — token estimate on the extension icon, updated after every turn
- **Status banner** — persistent green/yellow/red health indicator injected into the chat UI
- **Session total** — cumulative tokens burned since you opened the tab (grows quadratically — this is the number that maps to your bill)
- **Project knowledge detection** — detects files loaded into Claude Projects (instructions, documents, books) and estimates their token cost. These are injected into every API call and can be the largest hidden cost in a conversation. No competitor extension currently detects these.
- **✏️ Summarize Prompt → 📋 Copy to New Chat** — when context gets heavy, click Summarize Prompt. The extension drops a structured summary prompt into your current chat and auto-submits it. The model summarizes itself using its full context — no API key, no cost, no backend. When the summary finishes, the button changes to Copy to New Chat: one click copies the summary and opens a fresh tab with it pre-loaded as your first message.
- **Breakdown** — popup shows split between conversation text, project knowledge files, PDFs, images, Word docs, and presentations
- **Multi-platform** — works on both [claude.ai](https://claude.ai) and [chatgpt.com](https://chatgpt.com)

### Context health thresholds

Every chat carries a baseline token load that the user can't control: the platform's system prompt (~15K on Claude, ~4K on ChatGPT) plus any project knowledge files loaded into a Claude Project. The extension detects this baseline and excludes it from threshold classification — the green/yellow/red status reflects only what you can influence: your conversation length and file attachments.

| Level | Conversation tokens above baseline | Guidance |
|-------|-------------------------------------|----------|
| 🟢 Light | < 10K | Keep going |
| 🟡 Moderate | 10K – 20K | Start fresh if the topic has shifted |
| 🔴 Heavy | > 20K | Start a new chat |

The total displayed in the badge and popup includes the full load (baseline + conversation). For example, a Claude Project with 20K of knowledge files would show ~35K total on a brand-new chat — but the status stays green because the conversation itself is at zero.

**Note on "New Chat":** The New Chat button opens a standard new chat on whichever platform you're using (`claude.ai/new` or `chatgpt.com`), not a new chat within the current Claude Project or ChatGPT GPTs. This means starting fresh drops both the conversation history and any project knowledge file load. The savings percentage shown on the red banner reflects this — it compares your current total against a plain new chat.

## How to install (developer mode)

The extension is not yet on the Chrome Web Store. Install manually:

1. Clone or download this repo
2. In Chrome, go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the extension folder
5. Open [claude.ai](https://claude.ai) or [chatgpt.com](https://chatgpt.com) — the badge and banner will appear

No API key required, no sign-in, no backend call. The banner, token counts, and ✏️ Summarize Prompt → 📋 Copy to New Chat flow all work out of the box.

**Note:** If you update `manifest.json` (e.g. adding permissions), you need to remove and re-add the extension — a simple reload won't pick up permission changes.

## How the Summarize workflow works

Click **✏️ Summarize Prompt** on the yellow or red banner. The extension drops a structured summary prompt into your chat's input box and auto-submits it. The model summarizes its own conversation using full context — no API key required, no cost, nothing sent to a third-party server.

The injected prompt asks the model to produce: what you were working on, key decisions and findings, critical context, and the specific next question or decision to tackle (not just the topic). The model ends its response with `[SUMMARY COMPLETE]` so the extension knows exactly when to capture it.

When the response finishes, the button changes to **📋 Copy to New Chat**. One click copies the summary and opens a fresh tab with it pre-loaded as your first message.

Note: if you were editing a document, copy the latest version manually before switching tabs — the summary covers the discussion, not the artifact. If you're working in a Claude or ChatGPT Project, open your new chat there to keep project knowledge loaded.

## How it works

Token counting is estimation, not exact measurement. The extension reads the chat DOM and builds an estimate from several components:

- **Conversation text** — word-level BPE approximation of user and assistant turns. This is the most accurate component.
- **Uploaded files** — PDFs, images, Word docs, and presentations are detected and assigned conservative token estimates. The extension can't read the files or determine page counts, so these are rough. **PDFs vary enormously**: the default assumes ~15 pages (~30K tokens). A short whitepaper may be a few thousand tokens; a full book can be 150K+. If you load large documents, real context load may be much higher than the badge shows.
- **Project knowledge files** — files loaded into Claude Projects are detected and estimated separately. These are injected into every API call within a project and can be the largest hidden cost in a conversation.
- **System overhead** — a fixed estimate for the platform's invisible server-side injection (tool schemas, safety rules, memory, etc.): ~15,000 tokens on Claude, ~4,000 on ChatGPT.

All counts are rounded to the nearest thousand and prefixed with `~` to be upfront about the estimation. File uploads and project knowledge files use conservative defaults, so real token load from large documents may be significantly higher than estimated. Session total is most accurate on new chats; existing chats accumulate from when the tab was opened.

## Roadmap

- [ ] Energy equivalencies — convert tokens to kWh with real-world context
- [ ] Web search detection — estimate tokens injected by search snippet results
- [ ] Claude Desktop / native app support (research in progress)
- [ ] Web Store publication

## FAQ

### Don't AI providers already cache context? Doesn't that solve the problem?

Yes — Anthropic, Google, and OpenAI all offer prompt caching, and it does reduce cost (up to 90% on cached tokens). But caching only helps with one half of the computation.

When you send a message, the model does two things: (1) process all your input tokens, and (2) generate a response while attending to every token in context. Caching speeds up step 1 by reusing previous computation. But step 2 — where the model actually reasons over your full conversation — still scales with context length, cached or not.

That means long conversations still degrade response quality and still consume significant energy during generation, even with caching active. ContextCoach addresses the part caching can't: telling you when context bloat is hurting your results and helping you start fresh.

## How is this different from other token counter extensions?

Several good token monitoring extensions exist — most focus on counting tokens or tracking rate-limit quota via character-based estimation. ContextCoach focuses on a different problem: not how many tokens you've used, but what you should do about it — behavioral guidance, a one-click workflow to start fresh, project knowledge file detection, and energy/efficiency framing.

The summarize workflow is also architecturally different: other extensions reconstruct context by extracting and scoring text fragments from the DOM (picking messages that look important based on keywords or bullet points). ContextCoach's "Summarize Prompt" asks the model to summarize itself — using its full context, not a fragment — producing a coherent handoff that captures decisions made, open questions, and the specific next step. For long, complex sessions (the cases that actually need a new chat), this difference is significant.

## License

MIT
