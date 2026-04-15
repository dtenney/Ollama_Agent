# OllamaPilot — UX & Performance Recommendations

> Goal: Make the extension feel as fluid, responsive, and polished as Claude.ai or Amazon Q — smart streaming, instant feedback, natural conversation flow.

---

## Priority 1 — High Impact, Core Feel

### 1.1 Streaming Cursor / Typing Indicator
**Current:** Tokens render but there's no visible "still thinking" cue while the model is generating the first token (can take several seconds with large context).
**Recommendation:** Show an animated blinking cursor or pulsing ellipsis immediately after the user sends a message, before the first token arrives. Replace it with the actual streamed text as it flows in.
**Where:** `webview.js` — add a placeholder assistant bubble with CSS animation on `sendMessage`, remove it on first token receipt.
**Effort:** Small. CSS keyframe + one JS flag.

---

### 1.2 "Thinking" Phase Indication for Tool Calls
**Current:** When the agent is running tools (reading files, searching, running commands), the UI is silent — users have no idea what's happening.
**Recommendation:** Show a live tool-execution status strip below the message being built:
- "Reading `src/agent.ts`…"
- "Searching for `useState` in workspace…"
- "Running `npm test`…"

Each tool call should emit a structured `toolStart` event to the webview, updating the strip. On completion show a brief check-mark summary.
**Where:** `agent.ts` tool execution loop → `postMessage` events → `webview.js` status strip DOM.
**Effort:** Medium.

---

### 1.3 Abort / Stop Generation with Immediate Feedback
**Current:** A stop button exists, but there's a delay between clicking it and the stream actually halting. The partial response may continue rendering.
**Recommendation:**
1. Set a flag that causes the streaming loop in `ollamaClient.ts` to stop reading from the stream immediately.
2. The response already written should stay; append `[stopped]` or just end cleanly.
3. Make the stop button instantly go to a "Stopped" state so users know the click registered.
**Where:** `ollamaClient.ts` `streamChatRequest` → pass an `AbortController`, wire to the stop button in `provider.ts`.
**Effort:** Small. `AbortController` is already the right pattern for `fetch`-based streams.

---

### 1.4 Incremental Markdown Rendering
**Current:** Markdown is likely rendered in chunks or at the end of each streaming chunk, causing layout jumps as code blocks and headings appear suddenly.
**Recommendation:** Render plain text progressively during streaming (no markdown), then apply a single markdown pass once the stream completes. This matches Claude's behavior — text flows naturally and code blocks snap into place at the end, eliminating mid-stream layout thrash.
**Where:** `webview.js` streaming handler.
**Effort:** Small.

---

### 1.5 Context Window Visual Indicator
**Current:** Context percentage is computed in `contextCalculator.ts` and surfaced somewhere in the UI, but it's not prominent.
**Recommendation:** Add a slim colored progress bar directly under the input textarea — green (<60%), yellow (60-85%), orange (85-95%), red (>95%). Show an exact token count on hover. When auto-compact fires, show a brief toast: "Context compacted — kept last N messages."
**Where:** `webview.html` input area + `webview.js` + `contextCalculator.ts` events.
**Effort:** Small.

---

## Priority 2 — Conversation Quality

### 2.1 Conversation Branching / Retry at Point
**Current:** Retry only replays the last message from the end of the conversation.
**Recommendation:** Add a "Retry from here" button on any user message bubble. This truncates the history to that point and re-sends, enabling users to explore alternative responses without starting over.
**Where:** `webview.js` message bubble hover controls + `provider.ts` `retryLast` handler extended with a `fromIndex` param.
**Effort:** Medium.

---

### 2.2 Edit Last User Message
**Current:** No way to edit a sent message.
**Recommendation:** Add an "Edit" pencil icon on the most recent user bubble (on hover). Clicking it populates the textarea with the message content, removes the bubble, and allows re-submission. This is a core Claude/ChatGPT feature.
**Where:** `webview.js` + `provider.ts` — handle a new `editMessage` message type.
**Effort:** Medium.

---

### 2.3 Smarter System Prompt — Shell / OS Awareness Already Done, Extend It
**Current:** Shell environment is detected and injected into the system prompt (good!).
**Recommendation:** Also inject:
- Current date/time (prevents outdated suggestions)
- Active file language (so the model defaults to the right syntax)
- Whether a test runner / formatter is configured (from workspace detection)
**Where:** `agent.ts` system prompt builder.
**Effort:** Small.

---

### 2.4 Automatic Title Generation for Chat Sessions
**Current:** Sessions likely get a timestamp or generic title.
**Recommendation:** After the first assistant response, fire a lightweight, non-streaming Ollama call with: `"Summarize this conversation in 5 words or fewer for a chat title: …"`. Store the result as the session title. This matches Claude's behavior and makes the history sidebar much more useful.
**Where:** `provider.ts` after first complete response + `chatStorage.ts`.
**Effort:** Small.

---

### 2.5 Pinned Context Files — Visual Diff When File Changes
**Current:** Files can be pinned but the content is re-read each turn silently.
**Recommendation:** When a pinned file's content changes between turns, show a subtle badge on the file pill in the context bar: "Modified". This tells the user the agent is seeing the latest version.
**Where:** `webview.js` context bar + `provider.ts` pin logic.
**Effort:** Small.

---

## Priority 3 — Performance & Latency

### 3.1 Pre-warm Model on Extension Activate
**Current:** The first chat request cold-starts the model, which can take 5-30 seconds for large models.
**Recommendation:** On extension activate (after a short delay so VS Code doesn't lag), send a minimal keep-alive request to Ollama: `POST /api/generate {model, prompt: "", keep_alive: "5m"}`. This loads the model into memory proactively so the first real message responds instantly.
**Where:** `main.ts` activation + `ollamaClient.ts` new `keepAlive()` method.
**Effort:** Small.

---

### 3.2 Model List Caching — Refresh on Demand Only
**Current:** Models are fetched with a 60s cache, which means a stale list is possible.
**Recommendation:** Cache indefinitely in the session, but add a small refresh icon (↻) next to the model dropdown that triggers `fetchModels()` with cache bypass. This avoids unnecessary network calls while making a fresh pull possible.
**Where:** `ollamaClient.ts` + `webview.js` model dropdown.
**Effort:** Small.

---

### 3.3 Parallel Context Assembly
**Current:** Smart context, memory load, git diff, and mention file reads are likely assembled sequentially before the request is sent.
**Recommendation:** Run all context-gathering operations in parallel using `Promise.all()`. These are all I/O-bound and independent.
**Where:** `provider.ts` context assembly before calling the agent.
**Effort:** Small. Single refactor of the await chain.

---

### 3.4 Inline Completion — Smarter Debounce
**Current:** Inline completions use a fixed debounce (`inlineCompletions.debounceMs`).
**Recommendation:** Use an adaptive debounce: longer (500ms+) if the user is typing fast (character-per-second > threshold), shorter (150ms) if the user has paused. Also cancel in-flight FIM requests when a new one starts (via AbortController).
**Where:** `inlineCompletionProvider.ts`.
**Effort:** Small.

---

## Priority 4 — UI Polish

### 4.1 Code Block — "Apply to File" Smart Targeting
**Current:** Code blocks have an "Apply" button, but it's unclear where they apply to.
**Recommendation:**
1. If the code block's language matches the active editor's language and no file is mentioned, default to applying to the active editor at the cursor.
2. If a file was @mentioned in the conversation, offer it as the apply target.
3. Show a small dropdown on the Apply button: "Apply to: [active file] / [mentioned file] / Clipboard".
**Where:** `webview.js` code block click handler + `provider.ts` apply handler.
**Effort:** Medium.

---

### 4.2 Message Timestamps — Relative, on Hover
**Current:** Timestamps may be shown in raw ISO format or not at all.
**Recommendation:** Show relative timestamps ("2 minutes ago", "yesterday") in the bubble header. On hover, show absolute datetime in a tooltip. Update relative times every minute.
**Where:** `webview.js` — add a `setInterval` formatter using `Intl.RelativeTimeFormat`.
**Effort:** Small.

---

### 4.3 Keyboard Shortcuts
**Current:** Enter sends, Shift+Enter newlines.
**Recommendation:** Add:
- `Ctrl+/` — focus input from anywhere in the webview
- `Escape` — stop generation (when streaming)
- `Ctrl+K` — clear conversation (with confirm)
- `Up arrow` (when input is empty) — re-populate with last user message
**Where:** `webview.js` keydown handlers.
**Effort:** Small.

---

### 4.4 Error Messages — Actionable, Not Raw
**Current:** Errors may surface as raw JSON or stack traces from Ollama.
**Recommendation:** Map common Ollama errors to friendly messages with actions:
- Connection refused → "Ollama isn't running. [Start it] or check your host settings."
- Model not found → "Model `xyz` isn't installed. Run `ollama pull xyz`."
- Context length exceeded → "Message is too long for this model. [Auto-compact context]"
**Where:** `ollamaClient.ts` error handling + `provider.ts` error dispatch + `webview.js` error bubble renderer.
**Effort:** Medium.

---

### 4.5 Welcome Screen — Contextual Hints
**Current:** Welcome screen shows static hints.
**Recommendation:** Make hints dynamic based on workspace context:
- If a Python project: show "Ask me to explain this function" with a real function name from the open file.
- If git has uncommitted changes: "I can see you have changes in X files — want a review?"
- If memory has entries: "I remember your last session — ask me to continue where we left off."
**Where:** `webview.js` welcome screen + `provider.ts` sends workspace context on load.
**Effort:** Medium.

---

## Priority 5 — Agent Mode Improvements

### 5.1 Tool Result Collapsing
**Current:** Tool outputs (file reads, search results, shell output) are shown inline in the chat and can dominate the conversation.
**Recommendation:** Show tool results as collapsible cards with a summary line (e.g., "Read `agent.ts` — 1,247 lines" or "Found 3 matches in 2 files"). Expand on click to see full output.
**Where:** `webview.js` tool card renderer.
**Effort:** Small. The tool card structure already exists, just needs collapse behavior.

---

### 5.2 Agent Plan — Show Before Execution
**Current:** The agent starts executing immediately, which can be surprising for multi-step tasks.
**Recommendation:** For multi-step plans, have the agent output its plan as the first message before executing any tools. This matches Claude's "I'll do X, Y, Z" pattern and builds user trust. Could be enforced via system prompt instruction: "Before taking any actions involving file writes, describe your plan."
**Where:** `agent.ts` system prompt.
**Effort:** Tiny. Prompt engineering only.

---

### 5.3 File Edit — Inline Diff in Chat
**Current:** File edits likely open a separate diff view panel.
**Recommendation:** Show a compact inline diff directly in the chat bubble (similar to GitHub PR review), in addition to the external diff view. The inline version should have Accept/Reject buttons. This keeps the user in the chat flow.
**Where:** `webview.js` + `diffView.ts` + `provider.ts` edit flow.
**Effort:** Medium-Large.

---

### 5.4 Persistent Agent History Across Sessions
**Current:** Agent tool call history is stored per session, but unclear if it fully round-trips on session reload.
**Recommendation:** Ensure the full agent message history (including tool call/result pairs) is serialized and reloaded with the session so that context is never lost when switching sessions.
**Where:** `chatStorage.ts` + `provider.ts` session load.
**Effort:** Small. Verify serialization is complete; likely just a field inclusion fix.

---

## Priority 6 — Memory System UX

### 6.1 Memory Panel — Search & Filter
**Current:** Memory tree view shows tier groupings but is likely hard to navigate with many entries.
**Recommendation:** Add a search box to the memory tree view sidebar that filters entries by keyword in real time.
**Where:** `main.ts` memory tree provider + VS Code `TreeView` filter API.
**Effort:** Medium.

---

### 6.2 Memory Auto-Save Confirmation Toast
**Current:** When memory is auto-saved after a conversation, the user may not know it happened.
**Recommendation:** Show a non-intrusive status bar message: "✓ Memory updated (2 new entries)" that fades after 3 seconds.
**Where:** `memoryCore.ts` post-save callback → `main.ts` status bar.
**Effort:** Small.

---

## Quick Wins Summary

| Item | Effort | Impact |
|------|--------|--------|
| Streaming cursor / typing indicator | Small | High |
| AbortController for stop button | Small | High |
| Incremental markdown rendering | Small | High |
| Pre-warm model on activate | Small | High |
| Auto-generate chat titles | Small | High |
| Parallel context assembly | Small | Medium |
| Keyboard shortcuts | Small | Medium |
| Friendly error messages | Medium | High |
| Tool call status strip | Medium | High |
| Agent plan before execution | Tiny | Medium |
| Tool result collapsing | Small | Medium |
| Context bar token progress | Small | Medium |

---

## Implementation Order Suggestion

**Sprint 1 (Feel):** 1.1 cursor, 1.3 abort, 1.4 markdown rendering, 1.5 context bar
**Sprint 2 (Quality):** 2.4 auto-titles, 3.1 pre-warm, 3.3 parallel context, 4.3 keyboard shortcuts
**Sprint 3 (Agent UX):** 1.2 tool status, 4.4 error messages, 5.1 tool collapsing, 5.2 agent plan
**Sprint 4 (Polish):** 2.1 branching, 2.2 edit message, 4.1 smart apply, 4.5 dynamic hints
