# OllamaPilot — Project Status

**Date:** March 2026
**Version:** 0.4.0
**Repository:** [github.com/dtenney/Ollama_Agent](https://github.com/dtenney/Ollama_Agent)
**Branch:** main
**Latest commit:** `5558939`

---

## What Is OllamaPilot?

OllamaPilot is a VS Code extension that provides a fully local, offline AI coding assistant powered by [Ollama](https://ollama.com). It runs entirely on the user's machine — no cloud, no subscriptions, no telemetry. The AI can read files, write code, search the workspace, run shell commands, and maintain persistent project memory across sessions.

The extension is a fork of the original [OllamaPilot by Hamza Kchikech](https://github.com/kchikech), significantly expanded with agentic capabilities, a multi-tiered memory system, MCP support, and dozens of UX improvements.

---

## Current State

### By the Numbers

| Metric | Value |
|---|---|
| Source files | 32 TypeScript modules in `src/` |
| Test files | 23 unit test files |
| Tests passing | 308 (all green — 300 unit + 8 harness) |
| Agent tools | 23 workspace tools |
| VSIX size | 6.97 MB, 17 files |
| Total commits | 58 |
| Lines: `agent.ts` | 5,493 |
| Lines: `webview.js` | 2,380 |
| Lines: `webview.html` | 1,189 |
| Lines: `memoryCore.ts` | 995 |
| Lines: `provider.ts` | 911 |
| Lines: `main.ts` | 794 |

### Build & Test

```bash
npm run build          # TypeScript compile
npm run test:unit      # 300 unit tests, ~300ms
npm run test:harness   # 8 agent integration tests, ~500ms (headless, no VS Code needed)
npx vsce package       # produces ollamapilot-0.4.0.vsix
```

All 308 tests pass. TypeScript compiles clean with zero errors.

### Environment

- **Development:** Windows, VS Code
- **Ollama server:** `http://192.168.1.x:11434` (remote, high-VRAM GPU)
- **Qdrant:** `http://192.168.1.x:6333` (optional, for semantic memory search)
- **Primary test model:** `qwen3:14b-256k` (text-mode tool calling, thinking mode)
- **Also tested with:**
  - `qwen3:8b-256k` — lighter, faster, supports thinking mode
  - `qwen3:14b` — standard context window variant
  - `qwen3:8b` — standard context window variant
  - `qwen2.5-coder:7b-256k` — solid code-focused model, text-mode
  - `qwen2.5-coder:14b` — good balance of quality and speed
  - `qwen2.5-coder:32b` — highest quality coder, slower
  - `qwen2.5-coder:32b-fast` — quantized 32b, good throughput
  - `deepseek-r1:32b` — reasoning model, text-mode
- **Thinking mode compatible:** `qwen3:*` family (pass `options.think=true` to Ollama)
- **Embedding model:** `nomic-embed-text` (768d, for Qdrant semantic memory)

---

## Version History

| Version | Date | Highlights |
|---|---|---|
| 0.1.0 | Mar 2025 | Initial release — chat UI, 14 tools, @mentions, token estimation, chat history |
| 0.2.0 | Mar 2025 | 6-tier memory system, Qdrant semantic search, MCP support, auto-compact |
| 0.3.0-alpha | Mar 2025 | Code actions, prompt templates, smart context, search in chat, model presets |
| 0.4.0-alpha | Mar 2025 | Enhanced diff view, inline completions, multi-file refactoring, chat export |
| 0.3.1 | Jun 2025 | Python tooling, Code Lens, esbuild bundling (10.9 MB → 6.9 MB), 160 tests |
| 0.4.0 | Jun 2025 | Agent overhaul, 23 tools, shell-first philosophy, 300 tests, programmatic pipelines |

---

## What We've Been Doing

The bulk of recent work has been a deep, iterative cycle of **building the VSIX → testing with real prompts against a live Ollama model → identifying behavioral bugs → fixing them → rebuilding → retesting**. The issues we found were not traditional code bugs — they were emergent behaviors caused by small language models (7B–14B parameters) not following tool-calling instructions reliably. Fixing them required a combination of prompt engineering, programmatic enforcement, and architectural changes to the agent loop.

Below is a chronological account of every major issue found and resolved.

---

### Phase 1: Code Quality (Rounds 1–3)

Three rounds of systematic code review across all 33 source files found **53 total issues** — race conditions, resource leaks, blocking I/O, security gaps, and performance problems.

**Key fixes:**
- `provider.ts`: `_running` flag deadlock — `try/finally` guarantees reset on exception
- `workspace.ts`: `execSync` blocking the extension host — replaced with async + caching
- `agent.ts`: Windows path parsing in `search_files` — regex couldn't handle `C:\` drive letters
- `ollamaClient.ts`: `streamChatRequest` had no timeout — added 120s timeout + abort handler
- `provider.ts`: Webview message listener leak on sidebar hide/show — stored and disposed properly
- `mcpClient.ts`: Underscore parsing bug in MCP tool names — switched to double-underscore delimiter
- `memoryCore.ts`: `saveCore()` stored a live reference instead of a clone — added deep copy
- `chatStorage.ts`: Redundant sort on every `list()` call — moved to initial load only
- `agent.ts`: Compaction couldn't be cancelled by user — wired to `stopRef`

All 53 findings were fixed and verified. See `CODE_REVIEW.md` for the full audit trail.

---

### Phase 2: Test Coverage Expansion

Grew the test suite from **160 tests across 12 files** to **300 tests across 23 files**. New test coverage for:

- `codeActionsProvider`, `codeLensProvider`, `codeReview`
- `context`, `contextCalculator`, `diffView`
- `docScanner`, `mcpClient`, `provider`, `workspace`

Also migrated `chatStorage` from `globalState` to `workspaceState` (fixing GitHub issues #23 and #24) and converted `indexWorkspaceFiles` from synchronous to async.

---

### Phase 3: Text-Mode Tool Call Display Bug

**Problem:** When using models that don't support native Ollama tool calling (like `qwen2.5-coder`), the agent falls back to "text mode" where the model emits `<tool>{"name":"...","arguments":{...}}</tool>` XML blocks. These raw XML blocks were leaking into the chat UI during streaming.

**Root cause:** The streaming token handler was rendering tokens before the full `<tool>` block was complete, so users saw partial XML.

**Fix:** Implemented brace-counting in the streaming parser. When a `<tool>` tag is detected, tokens are buffered until the matching closing brace is found. The complete tool block is then stripped from the display output and executed silently.

---

### Phase 4: Runaway Agent Loop

**Problem:** The agent would sometimes call the same tool repeatedly in an infinite loop — for example, calling `read_file` on the same file 10+ times, or running the same shell command over and over.

**Fix:** Added `MAX_CONSECUTIVE_SAME_TOOL` breaker in `agent.ts`. The agent tracks consecutive calls to the same tool with the same arguments. After the limit is hit, the loop breaks and the agent is forced to respond to the user. Limits are tiered — read-only tools get more attempts than write tools.

---

### Phase 5: Post-Tool Chaining Bug

**Problem:** After executing a tool, the model would often stop and wait for the user instead of continuing its multi-step plan. For example: read a file, then stop — instead of reading the file and then editing it.

**Fix:** Implemented a context-aware **nudge system**. After every tool execution, the agent injects a short instruction into the conversation telling the model what to do next. Nudges are categorized by tool type:

- After `read_file`: "Now you have the content. Proceed with your task."
- After `rename_file`: "The file has been moved. Now update any imports that reference the old path."
- After a failed `edit_file`: "Call read_file FIRST to see the exact content before retrying."
- After an empty `search_files`: "No results. Try searching file CONTENTS instead of filenames."

---

### Phase 6: Auto-Save Memory Disabled

**Problem:** The `autoSaveMemory` feature was enabled by default, causing the model to save noisy, low-value memory entries on every conversation turn.

**Fix:** Changed the default from `true` to `false`. Users can opt in via settings.

---

### Phase 7: Text-Mode Model Persistence

**Problem:** When a model doesn't support native tool calling, the agent detects this on the first `HTTP 400` error and switches to text mode. But this detection happened on every new chat session, causing a wasted round-trip and a visible error flash.

**Fix:** Added a static `textModeModels` Set to the Agent class. Once a model is identified as text-mode, it's remembered for the lifetime of the VS Code session. All subsequent chats skip the native attempt entirely.

---

### Phase 8: File Write Operations Not Working (4 Rounds)

**Problem:** When asked to create or modify files, the model would dump code blocks into the chat instead of calling `write_file` or `edit_file` tools. This was the most persistent behavioral issue — it took 4 rounds of fixes.

**Root cause:** Small models (7B) default to "show the user what I'd do" behavior. They treat tool calling as optional and prefer to display code.

**Fixes applied across 4 rounds:**
1. Strengthened system prompt to explicitly say "NEVER show code blocks — ALWAYS use tools"
2. Added **code block plan dump detection** — if the model outputs a markdown code block but no tool call, the agent detects this and auto-retries with a stronger prompt
3. Added **placeholder blocker** on `write_file` — if the model writes content containing `// ... rest of file` or `# TODO: implement`, the write is rejected and the model is told to provide complete content
4. Added **turn-0 text-only auto-retry** — if the model gives a text-only response on the very first turn when the user clearly wants an action, the agent automatically retries

---

### Phase 9: Double-Spacing Bug

**Problem:** Extra blank lines appeared between tool output and the agent's response text in the chat.

**Root cause:** After stripping `<tool>` blocks from the response, leftover newlines weren't being collapsed.

**Fix:** Added `.replace(/\n{2,}/g, '\n')` to `stripToolBlocks()` and both content-cleaning paths in `provider.ts`.

---

### Phase 10: Tool Card Display

**Problem:** Tool execution results in the chat were truncated, making it hard to see what the agent actually found.

**Fix:** Tool cards now show full results in scrollable output areas with a max-height container.

---

### Phase 11: Search Pollution

**Problem:** `search_files` was returning matches from binary files (`.pyc`, `.whl`, `.egg`, images) and build directories (`node_modules`, `__pycache__`, `.git`), overwhelming the model with garbage results.

**Fixes:**
- Added `BINARY_EXTENSIONS` set (30+ extensions including `.log`) — binary files are excluded from search
- Added `SKIP_SEARCH_DIRS` set (25+ directories) — build/cache/test directories are skipped
- `find_files` got a substring fallback — when glob returns no results, it extracts keywords and does a broad search

---

### Phase 12: Shell-First Philosophy Overhaul

**Problem:** The agent was using specialized tools (`list_files`, `search_files`) for tasks that are faster and more flexible with shell commands. The tool descriptions didn't guide the model toward the most efficient approach.

**Fix:** Reframed the entire tool approach. `run_command` and a new `shell_read` concept became the PRIMARY discovery tools. Tool descriptions were rewritten to say "Use shell commands for discovery. Use specialized tools only for code editing." All examples in the system prompt and text-mode instructions were updated to show shell-first patterns.

---

### Phase 13: Shell Environment Auto-Detection

**Problem:** The system prompt showed Unix shell examples (`grep`, `find`, `ls`) on Windows, and vice versa. The model would then try to run the wrong commands.

**Fix:** Implemented `detectShellEnvironment()` which detects the OS, default shell (PowerShell, cmd, bash, zsh), and available tools. The system prompt dynamically generates all examples using the correct shell syntax. On Windows with PowerShell, examples use `Get-ChildItem`, `Select-String`, etc. On Linux/macOS, they use `find`, `grep`, etc.

---

### Phase 14: Model Asking Permission Instead of Acting

**Problem:** The model would respond with "I'll read the file for you" or "Would you like me to edit that?" instead of actually calling the tool. This was especially bad with `qwen2.5-coder:7b`.

**Fix:** Multi-round fix with programmatic enforcement at 4 levels:
1. **`userWantsAction` regex** — detects 30+ action verbs (create, edit, fix, refactor, move, rename, etc.)
2. **Auto-retry on permission-asking** — if the model's response matches patterns like "I'll", "Would you like", "Let me know if", the agent auto-retries with "DO NOT ASK. Execute the tool NOW."
3. **Turn-0 enforcement** — if the first response is text-only when the user wants action, auto-retry immediately
4. **Code block detection** — if the model shows code instead of calling a tool, auto-retry

---

### Phase 15: Batch Permission Requests ("Accept All")

**Problem:** When the agent needed to make many file changes (e.g., 40 import updates), the user had to click "Accept" on each one individually.

**Fix:** Added an "Accept All" button to confirmation cards in the webview. When clicked, it sends a `confirmResponseAll` message that auto-approves all pending confirmations for the current agent turn. The provider tracks pending confirmations and resolves them all at once.

---

### Phase 16: File Reorganization Bug Series (5 Rounds)

**Problem:** When asked to reorganize files (move files into subdirectories), the model would consistently fail in creative ways — moving files to wrong locations, forgetting to update imports, trying to edit files that had already been moved, or getting stuck in loops.

**Fixes across 5 rounds:**
1. Added move-success nudge: "File moved successfully. Now update imports in files that reference the old path."
2. Added failed move detection on Windows: checks for "cannot find", "not found", "exit 1" in command output
3. Fixed one-move-per-turn bug: the nudge was telling the model to do something else after each move instead of continuing with more moves
4. Added post-rename `read_file` loop detection: after renaming a file, the model would try to `read_file` on the old path repeatedly
5. Added specific rename-success nudge that tells the model the new path

---

### Phase 17: Chat Auto-Scroll Fix

**Problem:** During long agent responses, the chat would auto-scroll to the bottom even when the user had scrolled up to read earlier content.

**Fix:** Added an `agentActive` flag in `webview.js`. Auto-scroll only engages when the agent is actively streaming. If the user scrolls up, auto-scroll pauses. A "↓" button appears to jump back to the bottom.

---

### Phase 18: Windows Path Fixes

**Problem:** The agent's path auto-fix logic (converting forward slashes to backslashes on Windows) was breaking single-letter command flags. For example, `findstr /s /i` was being converted to `findstr \s \i`.

**Fix:** Smart replacement that only converts slashes in path-like segments (containing `.` or multiple path separators), preserving single-letter flags.

---

### Phase 19: "Explain what this project does" Bug

**Problem:** When the user asked "Explain what this project does", the agent called `memory_list` (which returns saved notes) instead of `workspace_summary` (which scans the actual project structure).

**Root cause:** The system prompt listed `memory_list` before `workspace_summary`, and the model picked the first relevant-sounding tool.

**Fix:** Reordered tool descriptions and added explicit guidance: "For questions about the project structure, ALWAYS use workspace_summary first."

---

### Phase 20: Programmatic Pre-Processing Pipeline (Rounds 1–12)

This was the largest single feature — a fully programmatic pipeline for updating import paths after file reorganization. It went through 12 rounds of development and debugging.

**The problem:** When files are moved to new locations (e.g., `app/routes/admin_routes.py` → `app/routes/admin/admin_routes.py`), all import statements across the codebase need to be updated. The model consistently failed at this task — it would move files instead of editing imports, skip files, use wrong paths, or get overwhelmed by the number of changes.

**The solution:** `preProcessPathUpdate()` — a function that does the entire job programmatically with zero model involvement:

1. **Discovery:** Reads the user's reorganization document to understand what moved where
2. **Module mapping:** Scans the filesystem to find relocated modules and builds an `oldImport → newImport` mapping
3. **Stale import scanning:** Reads all `.py` files directly (synchronous filesystem scan, no child processes) and finds lines containing stale imports
4. **Edit execution:** Calls `edit_file` programmatically for each stale import, with diff preview and confirmation dialogs

**Key issues resolved across 12 rounds:**

| Round | Issue | Fix |
|---|---|---|
| 1–8 | Model kept moving files instead of editing imports | Added nudge-based detection and redirection |
| 9 | Discovery work was too slow via model | Moved discovery to programmatic pre-processing |
| 10 | Model still involved in edits | Made edits fully programmatic — zero model involvement |
| 11 | 71 sequential `findstr` child processes froze VS Code (4.5 min) | Replaced with single synchronous filesystem scan (<1 sec) |
| 11 | Memory leak from child process accumulation | Eliminated all child processes |
| 11 | Scanning too deep / too many files | Added `MAX_SCAN_DEPTH=8`, `MAX_PY_FILES=500`, symlink protection |
| 12 | 5 edits failed — short import prefix matched multiple lines | Changed to full-line matching (`edit.oldLine` instead of prefix) |

The final pipeline executes ~40 edits in seconds, with "Accept All" for batch approval. All edits succeed.

---

## Architecture Overview

```
src/
├── agent.ts              (3,706 lines) Agent loop, 23 tools, auto-retry, nudges, pipelines
├── provider.ts           (911 lines)   Webview message router, session management
├── ollamaClient.ts       (434 lines)   HTTP client for Ollama API
├── memoryCore.ts         (995 lines)   6-tier memory system with semantic search
├── main.ts               (794 lines)   Extension activation, command registration
├── contextCalculator.ts  (318 lines)   Token estimation, context compaction
├── workspace.ts          (299 lines)   Project scanner, file tree, type detection
├── chatStorage.ts                      Session persistence (workspaceState)
├── config.ts                           Configuration reader
├── gitContext.ts                       Smart git diff injection
├── mentions.ts                         @file fuzzy search and indexing
├── smartContext.ts                      Auto-include related/imported files
├── inlineCompletionProvider.ts         FIM code completions
├── diffView.ts                         Enhanced diff view with accept/reject
├── multiFileRefactor.ts                Coordinated multi-file changes
├── chatExporter.ts                     Markdown/JSON chat export
├── symbolProvider.ts                   @symbol workspace indexing
├── multiWorkspace.ts                   Multi-workspace folder support
├── codeActionsProvider.ts              Right-click code actions
├── codeLensProvider.ts                 Explain/Document lenses
├── codeReview.ts                       Code review mode
├── promptTemplates.ts                  Built-in + custom prompt templates
├── mcpClient.ts                        Model Context Protocol client
├── mcpConfig.ts                        MCP server configuration
├── memoryViewProvider.ts               Memory tree view UI
├── embeddingService.ts                 Ollama embedding API
├── qdrantClient.ts                     Qdrant vector database client
├── docScanner.ts                       Project doc scanner for memory
├── markdownIngest.ts                   Markdown file ingestion
├── logger.ts                           Shared output channel logger
└── context.ts                          Active file/selection extraction

webview/
├── webview.html          (1,189 lines) Chat UI — HTML/CSS, VS Code theme integration
├── webview.js            (2,380 lines) Chat logic — streaming, tools, confirmations, @mentions
└── vendor/
    └── highlight.bundle.js             Offline syntax highlighting (30+ languages)

src/test/unit/
└── 23 test files                       300 unit tests (Mocha + Sinon)
```

### Agent Loop Design

The agent operates in a single-tool-per-turn loop:

1. User sends a message
2. Agent builds context (memory, smart context, git diff, pinned files, @mentions)
3. Agent sends conversation to Ollama via streaming `/api/chat`
4. Model responds with either text or a tool call
5. If tool call: agent executes it (with confirmation if destructive), injects result + nudge, loops back to step 3
6. If text: agent checks for auto-retry conditions, then delivers response to user
7. Loop runs up to `MAX_TURNS = 25`

### Tool Calling Modes

| Mode | When | How |
|---|---|---|
| Native | Models with Ollama tool support | JSON schema in API request |
| Text (fallback) | All other models | Instructions in system prompt, model emits `<tool>` XML, parsed client-side |

The switch happens automatically on first `HTTP 400` and is remembered for the session.

---

## Known Behavioral Patterns with Small Models

These are not bugs in the code — they're inherent limitations of 7B–14B parameter models that we've built workarounds for:

1. **Permission-asking:** Models say "I'll do X" instead of doing X. Mitigated by auto-retry detection.
2. **Code dumping:** Models show code blocks instead of calling write tools. Mitigated by plan dump detection.
3. **Tool avoidance:** Models prefer to explain what they'd do rather than use tools. Mitigated by turn-0 enforcement.
4. **Move-instead-of-edit:** When asked to update imports, models try to move files. Mitigated by programmatic pipeline.
5. **Overwhelm on large results:** 100+ search results cause the model to lose focus. Mitigated by result truncation and SKIP_SEARCH_DIRS.
6. **Skipping read_file:** Models try to edit files without reading them first. Mitigated by edit-failure nudge.

---

---

### Phase 21: Code Index + Semantic File Search

**Problem:** Pre-edit file selection used keyword-based scoring against filenames. When the user said "add error handling to the fleet route," it picked whichever file scored highest on keywords — not necessarily the right one.

**Fix:** Added `CodeIndexer` (`src/codeIndex.ts`) — a Qdrant-backed semantic index of all workspace files. On activation, the indexer embeds a one-line summary of every source file (extracted with regex, no model call) and stores vectors in Qdrant. `preProcessEditTask()` now queries the index with the full user message for semantic matching. Falls back to keyword search if the index isn't ready.

**Also added:** `similarityAnalyzer.ts` — finds clusters of semantically similar files in a directory using cosine similarity on stored vectors, with greedy complete-linkage clustering.

---

### Phase 22: Pre-Edit Research Pipeline

**Problem:** The model was editing files without understanding what was in them. It hallucinated model names (`FleetVehicle`), invented imports that didn't exist, duplicated routes, and generally wrote code without grounding in the actual codebase.

**Root cause:** The pre-edit context injection gave the model a file with line numbers and a validation checklist, but the checklist was aspirational — the model had no verified facts to check against.

**Fix:** Complete rewrite of `preProcessEditTask()` to run a **research phase** before the model call:

1. **Models inventory** — scans `app/models/` and extracts every class name using regex. Injected as a hard constraint: "You may ONLY import models from this list."
2. **Route/function inventory** — extracts all defined routes (`@bp.route(...)`) and function names from the target file. Model can verify duplicates before writing.
3. **Imported names** — extracts what's already imported in the file so the model knows what it can use without new imports.
4. **Pattern example** — finds a representative existing route in the file (preferring JSON-returning ones) and injects it as "copy this structure."
5. **Pre-validation warnings** — checks if the user's message mentions a capitalized name that isn't in the models inventory, warns before the model call.

The instruction framing was also changed: validation runs silently, output is either one stop-sentence or an immediate tool call — no narration.

**Result:** Model correctly identifies `/active-vehicles` already exists and stops with "Already exists: get_active_vehicles. No change needed." — one model call, 54 chars, ~1 second.

---

### Phase 23: `validateNewContent` — Import Safety Gate

**Problem:** Even with the models inventory, the model could still write broken imports if it ignored the constraint. Needed a hard enforcement at tool execution time.

**Fix:** Added `validateNewContent()` as a private method on the `Agent` class. Called in both `edit_file` and `edit_file_at_line` handlers before any file is touched. Parses `from app.X import Y` statements in the new content, resolves each module path against disk (`app/X.py` or `app/X/__init__.py`), and throws an error if any don't exist. The error message lists the missing modules and is returned to the model.

**Bug fixed:** Original implementation declared `validateNewContent` as a `const` inside the `switch` block — JavaScript's temporal dead zone caused "Cannot access before initialization" at runtime. Moved to a proper private class method.

---

### Phase 24: Sweep Task Detection + Programmatic Error Handler

**Problem:** "Add error handling to any route that's missing it" was being treated as a single-addition task. The model applied the duplicate-check template, got confused, and output a wrong "already exists" stop — or worse, rewrote 23 entire route bodies with wrong line numbers, corrupting the file.

**Fix — part 1:** Sweep task detection in `preProcessEditTask()`. When the message matches "all/every/each/any routes" or "missing/without", different instructions are injected: enumerate affected items, make multiple edits, no duplicate check, summarize at end.

**Fix — part 2:** `sweepAddErrorHandling()` — a fully programmatic implementation that replaces the model entirely for this task type:

- Parses the Python file directly to find every route function (preceded by `@*.route`)
- Detects function body extent (handles docstrings, blank lines, nested blocks)
- Checks if `try:` is already the first body line — skips those
- Processes **bottom-up** so line indices stay valid across multiple inserts
- Wraps each body: indents 4 spaces, adds `try:` before and `except Exception as e: return jsonify({'error': str(e)}), 500` after
- Writes the file once, posts visible tool cards for each change, returns a summary

Zero model involvement for the wrapping logic. Deterministic, no drift, no duplicate routes.

---

### Phase 25: Sweep Detection in `buildSmallModelSystemPrompt`

**Problem:** The system prompt said "make the change immediately without narrating it" but the context injection said "answer each check out loud." These conflicted — the model would narrate all four checks and then put the tool call in the same message, triggering a format retry.

**Fix:** Unified both to the same rule: checks run silently, output is either one stop-sentence or an immediate tool call. Updated both the system prompt and the context injection instructions.

---

### Phase 26: Path-Update Pipeline False Trigger

**Problem:** "Add proper error handling" was triggering the import-path update pipeline because the word `fix` matched `hasEditKeyword` and a broad path keyword regex. This caused the extension to scan for stale imports instead of handling the error-handling request.

**Fix:** Tightened `preProcessPathUpdate()` detection to require the message to specifically reference import paths, module paths, or reorganization — not generic code edits.

---

### Phase 27: v0.5 Features — Reasoning Card UI

**Problem:** The agent's research phase was collecting useful information (target file, models available, existing routes, pattern found) but none of it was visible to the user. The agent appeared to "just start writing" with no explanation of what it had verified.

**Fix:** Added a `reasoningCard` UI component. Before the model call, `preProcessEditTask()` posts a structured `{ type: 'reasoningCard', ... }` message containing:
- Target file resolved
- Models available (count from inventory)
- Existing routes/functions in file (duplicate check count)
- Pattern example found
- Task type (single-add vs sweep)
- Any pre-validation warnings

`webview.js` renders this as a collapsible blue-accented card above the response. The user can see exactly what the agent verified before it wrote code.

---

### Phase 28: v0.5 Features — Caller/Reference Impact Analysis

**Problem:** When modifying a function, the agent had no awareness of what else calls it. A signature change could silently break callers across the codebase.

**Fix:** Added caller analysis to `preProcessEditTask()`. After extracting the function inventory from the target file, the agent:
1. Identifies functions mentioned by name in the user's message
2. Greps the workspace for all callers (using `grep -rn` / `Select-String`)
3. Filters out the definition file and comment lines
4. Injects a "This function is called from: X, Y, Z — your change must be backward-compatible or update those callers" block into the model context

Only fires for named functions >3 chars mentioned explicitly in the request. Capped at 2 functions to avoid context bloat.

---

### Phase 29: v0.5 Features — Post-Edit Syntax Verification

**Problem:** After every edit, there was no automatic check that the resulting file was syntactically valid. Typos and indentation errors could be silently written to disk.

**Fix:** Added `syntaxCheck(absPath)` private method. Called after every successful `edit_file` and `edit_file_at_line` write. For Python files, runs `python -m py_compile` (with fallback between `py`, `python3`, `python`). If it fails, appends a `⚠ Syntax error detected after edit:` block to the tool result — the model sees this and is prompted to fix it in the next turn. TypeScript/JS skipped (VSCode diagnostics handle those).

---

### Phase 30: v0.5 Features — Multi-File Change Plans

**Problem:** When a user asks for something that clearly spans multiple files ("add a new model + migration + route + test"), the agent would dive into the first file and lose the thread after file 2–3. No plan, no confirmation, no coordination.

**Fix:** Added `isMultiFeatureRequest` detection in `run()` and `generateMultiFilePlan()` private method. When triggered:
1. The agent programmatically derives a structured plan: `FilePlan[]` with `{ path, action, description }` per file
2. Posts a `planCard` to the UI — a green-accented collapsible card listing every planned change
3. Waits for user confirmation before touching any file
4. On confirmation, executes the first step (subsequent steps require individual edit confirmations)

Plan generation is heuristic — detects Python vs TypeScript, infers typical file locations (models, routes, tests, migrations) from project structure. For Python Flask projects, a "new feature" plan generates: model file, route file, migration file, test file.

---

### Phase 31: v0.5 Features — Test Runner Integration + Headless Harness

**Two separate pieces of work:**

**A. Test Runner (`ollamaAgent.autoRunTests` setting, default: off)**

After a successful edit (no syntax errors), the agent now optionally runs the corresponding test file automatically. Three new private methods:
- `findTestFile(absPath)` — checks `test_<name>.py`, `<name>_test.py`, `tests/` at root, mirror paths. TypeScript: `<name>.test.ts`, `<name>.spec.ts`, `__tests__/`.
- `runTestFile(absPath)` — tries `pytest`, `python -m pytest`, `unittest` in order. Parses pass/fail from output. Returns `{ passed, output }`.
- `shouldRunTests()` — reads `ollamaAgent.autoRunTests` from VS Code settings.

Result appended to tool return: `✅ Tests (tests/test_fleet.py): 3 passed` or `❌ Tests (...): FAILED — <error>`.

**B. Headless test harness (`npm run test:harness`)**

Previously, validating agent behavior required: build VSIX → install → open VS Code → type a message → copy response → paste here. Now there's a proper automated test loop.

Key files:
- `node_modules/vscode/index.js` — minimal vscode stub (no `_resolveFilename` patching — just a real resolvable module)
- `src/test/vscode-mock.ts` — preload script that force-loads the stub before test files import agent.ts
- `src/test/unit/agentHarness.test.ts` — 8 integration tests that drive the real Agent loop
- `.vscode/tasks.json` — VSCode task so tests run from `Ctrl+Shift+P → Tasks: Run Test Task`

**8 tests, all passing, ~500ms:**

| Test | What it exercises |
|---|---|
| Plain text answer | Token messages flow through postFn |
| read_file tool | Result injected into model history |
| edit_file | File written to disk, fileChanged event |
| Tool pipeline | Tool result (even errors) injected into context |
| Reasoning card | `preProcessEditTask` posts card before model call |
| Validation stop | "Already exists" → no retry loop (1 model call) |
| validateNewContent | Bad import blocks edit, file unchanged |
| workspace_summary | Tool output captured in history |

To add a new scenario: script what the model "says" via `makeStreamStub()`, assert on posted messages and filesystem state. No VSIX, no VS Code, no copy-paste.

---

## What's Left

### v0.5 — Done ✅
All 5 planned v0.5 features are implemented:
- ✅ Reasoning card UI (Phase 27)
- ✅ Caller/reference impact analysis (Phase 28)
- ✅ Post-edit syntax verification (Phase 29)
- ✅ Multi-file change plans (Phase 30)
- ✅ Test runner integration (Phase 31)
- ✅ Headless agent test harness (Phase 31)

### v0.5.1 Candidates

**Quality of existing features:**
- [ ] Test `sweepAddErrorHandling` with live VSIX on clean fleet.py
- [ ] Extend sweep pattern to other uniform tasks: "add `login_required` to all routes missing it", "add type hints to all functions"
- [ ] Models inventory: extend to TypeScript projects (scan `src/types/`, exported interfaces, class definitions)
- [ ] Pattern example selection: score by structural similarity to request, not just "first JSON route"
- [ ] Multi-file plan: execute all steps in sequence, not just the first — currently requires manual follow-up per file

**Project understanding (the big gap):**
- [ ] Call graph index — understand which functions call which, so impact analysis covers transitive callers
- [ ] Data model map — relationships between models (foreign keys, associations) visible to the agent before schema changes
- [ ] Architecture briefing — auto-generated from code structure, injected on architecture questions
- [ ] Middleware/decorator awareness — knows which routes have `@login_required`, `@admin_only`, etc.

**Cross-language support:**
- [ ] TypeScript route sweep (Express/Next.js `router.get(...)` patterns)
- [ ] TypeScript models inventory (interfaces, enums in `types/`)
- [ ] `tsc --noEmit` syntax check in post-edit verification (currently skipped)

### Recommendations Backlog (see `RECOMMENDATIONS.md`)
- Streaming cursor / typing indicator
- Tool execution status strip
- Conversation branching / retry at point
- Edit last user message
- Friendly error messages (map Ollama errors to actionable text)
- Parallel context assembly via `Promise.all()`

### Design Philosophy

The core principle that emerged through all this work: **for complex multi-step tasks, do discovery and computation programmatically — only involve the model when it has ALL the context it needs, or not at all.** Small models are good at reasoning about code when given the right context. They are bad at multi-step planning, tool sequencing, and self-correction. The agent's job is to compensate for those weaknesses.

The evolution of this principle across sessions:
- v0.1–0.3: Model does everything, we fix when it fails
- v0.4 (early): Programmatic pipelines for known failure modes (import updates)
- v0.4 (current): Research phase before every edit — model gets verified facts, not just the file
- v0.5 (current): Model as writer, extension as thinker — reasoning card, caller analysis, syntax check, test runner, change plans
- v0.5.1 (next): Deepen project understanding — call graphs, data model maps, TS support, sequential plan execution

---

## File Reference

| Document | Purpose |
|---|---|
| `README.md` | User-facing documentation, features, installation, FAQ |
| `CHANGELOG.md` | Version-by-version change log |
| `CODE_REVIEW.md` | 3 rounds of code review — 53 findings, all fixed |
| `RECOMMENDATIONS.md` | 26 UX/performance improvement proposals |
| `CONTRIBUTING.md` | Contribution guidelines |
| `PROJECT_STATUS.md` | This document |
