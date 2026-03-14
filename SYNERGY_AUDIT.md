# OllamaPilot Synergy Audit

**Date:** 2025-01-XX
**Scope:** Full review of all implemented features for symmetry and integration gaps.
**Status:** IN PROGRESS

---

## What's Working Well

- **Memory ↔ Agent loop** — Tiers 0-2 auto-loaded into system prompt, 7 memory tools, text-mode fallback includes memory instructions, concurrency lock prevents race conditions.
- **MCP ↔ Agent loop** — Tools merged into native tool list, `mcp_` prefix routing, non-blocking startup, clean shutdown in `deactivate()`.
- **Smart Context ↔ @mentions ↔ @symbols** — Provider deduplicates across all three sources before building full message.
- **Context Calculator ↔ Agent** — Auto-compact at 99%, warnings at 70%, model-aware limits for 20+ models.
- **Code Actions ↔ Provider ↔ Chat** — All 6 right-click actions + error quick fix route through `sendMessageFromCommand()`.
- **Diff View ↔ Agent** — `edit_file` opens native diff with accept/reject, temp files cleaned in `finally`.

---

## Issues Found

### Issue 1: Review prompt doesn't leverage memory
- **Severity:** Low | **Effort:** 5 min | **Status:** ✅
- **File:** `src/codeReview.ts`
- **Problem:** `buildReviewRequest()` and `buildCommitReviewRequest()` produce static prompts that don't ask the agent to check memory for relevant conventions.
- **Fix:** Add a line to both prompts: "Check project memory for relevant conventions before reviewing."

### Issue 2: MultiWorkspaceManager agents are orphaned
- **Severity:** Medium | **Effort:** 30 min | **Status:** ✅
- **Files:** `src/multiWorkspace.ts`, `src/provider.ts`
- **Problem:** `MultiWorkspaceManager` creates per-folder `Agent` instances stored in a `Map`, but `provider.ts` never calls `workspaceManager.getActiveWorkspace()`. Provider creates its own agent directly: `this._agent = new Agent(workspaceRoot, this.memory)`. The workspace manager's agents are created, never used, never cleaned up.
- **Fix:** Simplify `MultiWorkspaceManager` to track folders only — remove agent/memory creation from it. The provider already handles agent lifecycle correctly.

### Issue 3: Memory shared across multi-workspace folders
- **Severity:** Low | **Effort:** N/A
- **Problem:** Same `memoryManager` instance passed to every agent. `workspaceState` is already VS Code workspace-scoped, so this is fine for single-workspace (our primary use case). Noted for future multi-workspace improvements.
- **Fix:** None needed now.

### Issue 4: Inline completions lack project context
- **Severity:** Low | **Effort:** 20 min | **Status:** ⬜ (deferred to Phase 5)
- **File:** `src/inlineCompletionProvider.ts`
- **Problem:** Completion prompt uses only surrounding 50 lines. No memory, no smart context. Completions lack project awareness.
- **Fix:** Optionally inject tier 0-1 memory (critical/essential, ~100 tokens) into the completion prompt. Keep it lightweight to avoid hammering Ollama.

### Issue 5: Pin state not persisted
- **Severity:** Medium | **Effort:** 30 min | **Status:** ✅
- **Files:** `webview/webview.js`, `src/provider.ts`, `src/chatStorage.ts`
- **Problem:** Pin feature stores `pinnedIds` in a JS `Set` in webview.js. Pins lost on reload/session switch. The `updatePins` message is posted to extension but nothing handles it.
- **Fix:** Add `case 'updatePins'` handler in provider.ts that saves pin IDs to the session. Restore pins when loading a session via `sessionLoaded` message.

### Issue 6: Chat export uses raw agent history
- **Severity:** Low | **Effort:** 5 min | **Status:** ✅
- **File:** `src/provider.ts`
- **Problem:** `getCurrentChatMessages()` returns `this._agent.conversationHistory` which includes tool results and injected context. The session's `messages` array (clean user/assistant with timestamps) is more appropriate for export.
- **Fix:** Return `this.currentSession.messages` instead.

### Issue 7: README template variable syntax mismatch
- **Severity:** Low | **Effort:** 2 min | **Status:** ✅
- **File:** `README.md`
- **Problem:** README documents `{{selection}}`, `{{language}}`, `{{filename}}` but `promptTemplates.ts` uses single-brace `{selection}`, `{language}`. The regex is `\{(\w+)\}`.
- **Fix:** Update README to use `{selection}` syntax.

### Issue 8: Runtime require() in codeReview.ts
- **Severity:** Low | **Effort:** 2 min | **Status:** ✅
- **File:** `src/codeReview.ts`
- **Problem:** `buildCommitReviewRequest()` uses `const { exec } = require('child_process')` inside the function body instead of top-level import. Inconsistent with rest of codebase.
- **Fix:** Move to top-level import.

---

## Fix Order

1. Quick fixes: #1, #6, #7, #8
2. Medium fixes: #5 (pin persistence), #2 (orphaned agents)
3. Enhancement: #4 (inline completion context)
