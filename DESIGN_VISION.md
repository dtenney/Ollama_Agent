# OllamaPilot — Design Vision
# "Claude Code, but Local"

**Date:** March 2026
**Status:** Living document — updated after every major session

---

## What We're Building

OllamaPilot started as a chat UI for Ollama. It has evolved into a **local agentic coding assistant** — a tool that reads, understands, and modifies a real codebase without sending a single byte to the cloud.

The reference point is Claude Code: an agent that understands your project, reasons about changes before making them, validates its own work, and operates as a trustworthy collaborator. The constraint that shapes everything: **we are running 7B–32B parameter models locally.** These models are capable but not frontier. They hallucinate, lose context, skip steps, and need guardrails. The extension compensates by doing the thinking programmatically — leaving the model to do only what it's actually good at: **writing code that fits a shown pattern.**

---

## Core Architecture

```
User message
    │
    ▼
┌─────────────────────────────────────────────┐
│  Pre-processing pipeline                     │
│  (programmatic, zero model involvement)      │
│                                              │
│  1. Intent classification                    │
│     - Multi-file feature request?            │
│       → generateMultiFilePlan() + confirm    │
│     - Import path update?                    │
│       → preProcessPathUpdate()               │
│     - Error handling sweep?                  │
│       → sweepAddErrorHandling()              │
│     - Single-file edit?                      │
│       → preProcessEditTask()                 │
│                                              │
│  2. Research phase (for edit tasks)          │
│     - Semantic file resolution (Qdrant)      │
│     - Models inventory (app/models/ scan)    │
│     - Route/function inventory (target file) │
│     - Imported names (duplicate avoidance)   │
│     - Pattern example (copy this structure)  │
│     - Caller analysis (grep for callers)     │
│     - Pre-validation warnings                │
│     → Post reasoning card to UI             │
│                                              │
│  3. Programmatic execution (when possible)   │
│     - sweepAddErrorHandling() → no model     │
│     - preProcessPathUpdate()  → no model     │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Model call                                  │
│  (with full verified context)                │
│                                              │
│  System prompt: tool instructions,           │
│  validation rules (run silently)            │
│                                              │
│  User message + injected context:            │
│  - Target file (line-numbered)              │
│  - Models inventory (hard constraint)        │
│  - What's already defined (duplicate check) │
│  - Caller list (backward-compat warning)    │
│  - Pattern to follow (copy this)            │
│  - Task instructions (add vs sweep)         │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Tool execution layer                        │
│                                              │
│  edit_file / edit_file_at_line:              │
│    → validateNewContent() — blocks bad       │
│      imports at tool level                   │
│    → diff view + user confirmation           │
│    → syntaxCheck() — py_compile after write  │
│    → findTestFile() + runTestFile()          │
│      (if ollamaAgent.autoRunTests = true)    │
│                                              │
│  shell_read / run_command:                   │
│    → auto-retry nudges on failure           │
│    → focused grep injection on results      │
│                                              │
│  memory_save / memory_recall:               │
│    → Qdrant semantic search                 │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Auto-retry loop                             │
│                                              │
│  Detects and corrects:                       │
│  - Permission-asking instead of acting      │
│  - Code blocks instead of tool calls        │
│  - Verbose plan dumps without action        │
│  - Model answering from training data       │
│  - Valid validation stops (don't override)  │
└─────────────────────────────────────────────┘
```

---

## What's Working Well (v0.5 Status)

### The Research Pipeline (✅ Solid)
Before any model call for an edit task, the extension runs a programmatic research phase and gives the model **verified facts**:

- **Models inventory** — real class names from `app/models/`. Eliminated hallucinated class names entirely.
- **Route/function inventory** — what's already in the target file. Model can't add a duplicate.
- **Pattern example** — a working route to copy. Model writes code that fits the project structure.
- **Caller analysis** — what calls the function being modified. Model knows the impact radius before writing.
- **Reasoning card** — all of the above shown to the user before the model writes a line.

This pattern — **programmatic research → verified context → single focused model call** — is the right architecture for small models. No multi-turn tool sequencing, no hallucination during research, model focuses on writing not discovering.

### Programmatic Pipelines (✅ Solid)
Two entire task classes bypass the model completely:
- `sweepAddErrorHandling()` — wraps every Python route body in try/except. Deterministic, bottom-up, zero drift.
- `preProcessPathUpdate()` — updates all stale imports after file reorganization. ~40 edits in <1 second.

**The general principle:** if the "what to write" is fully determined by the existing code, write it programmatically. Only use the model when judgment is required.

### Defense in Depth on Edits (✅ Solid)
Three independent layers protect every file write:
1. **Model constraint** — models inventory and pattern example in context
2. **Prompt reinforcement** — validation rules in system prompt (run silently)
3. **Tool enforcement** — `validateNewContent()` throws if imports don't exist on disk, `syntaxCheck()` verifies the result

A broken edit has to get through all three to land.

### Test Infrastructure (✅ New)
`npm run test:harness` — 8 headless integration tests against the real agent loop. No VS Code, no VSIX install, no copy-paste. Stubs `streamChatRequest` to return scripted responses, drives `Agent.run()` with auto-confirmation, asserts on posted messages and filesystem state. New behavior can be verified in ~500ms.

---

## What's Still Missing: The Gap to Claude Code

### 1. Deep Project Understanding (❌ Shallow)

**What we have:** Workspace file tree, semantic file index (Qdrant), keyword-based search, memory system.

**What we lack:** Semantic understanding of the project's structure — how the pieces connect. When asked "how does authentication work?", the agent searches for keywords. It doesn't trace the middleware stack, understand request flow, or know which decorators guard which routes.

**What Claude Code does:** Has the whole codebase in context. Can trace a request from route to handler to service to database model in one pass.

**What we should do:**
- Build a **call graph index** — for each function, which functions call it and which it calls. Stored in Qdrant, updated on index. Pre-edit impact analysis becomes transitive, not just one-hop.
- Build a **data model map** — relationships between models (FK, associations). Before changing a model, the agent knows which migrations, serializers, and forms depend on it.
- Auto-generate an **architecture briefing** from code structure — request flow, middleware stack, key services — and inject on architecture questions.

### 2. Change Impact Beyond Direct Callers (⚠️ One-hop only)

**What we have:** Caller analysis greps for direct callers of a named function.

**What we lack:** Transitive impact. If `get_user()` is called by `check_permissions()` which is called by 15 routes, we only see `check_permissions` — not the 15 routes.

**What we should do:** Walk the call graph. For each direct caller found, check if it's also called by others. Cap at 2–3 hops to avoid context explosion. Flag: "This change may affect 18 routes through `check_permissions`."

### 3. Multi-File Execution (⚠️ First step only)

**What we have:** The agent generates a change plan (model + routes + migration + test) and shows a `planCard`. The user confirms. The first file gets a model call.

**What we lack:** Automated sequential execution of the full plan. After file 1, the agent doesn't automatically proceed to file 2 with the context of what it just wrote.

**What we should do:** After each plan step completes (edit confirmed), automatically advance to the next step — passing forward what was written in step 1 as context for step 2. A "executing step 2 of 4" progress indicator in the reasoning card.

### 4. TypeScript/Cross-Language Support (❌ Python-only)

**What we have:** Models inventory, sweep functions, and import validation all work for Python Flask only.

**What we lack:** The same capabilities for TypeScript (Express, Next.js, NestJS). When working in a TypeScript project:
- No models inventory (equivalent would be interfaces/enums in `src/types/`)
- No route inventory (Express `router.get(...)`, Next.js `export default function handler`)
- No sweep capability
- `syntaxCheck` skips TS/JS entirely

**What we should do:** Detect project language in the research phase. For TypeScript, scan `src/types/` for exported interfaces. Parse Express/Next router patterns for route inventory. Run `tsc --noEmit` as the post-edit syntax check.

### 5. Reasoning Transparency (⚠️ Inconsistent)

**What we have:** The reasoning card shows what was researched. The model is told to validate silently and output a stop-sentence or tool call only.

**What we lack:** The model still sometimes narrates anyway — especially on complex requests where it's uncertain. The reasoning card shows pre-call research but not post-call decisions ("I chose `FleetTruck` because there's no `FleetVehicle` — closest match in models inventory").

**What we should do:** After each tool execution, the extension knows exactly what was changed. Build a **post-execution summary** in the reasoning card — not from the model's narration but from the tool result itself: "Wrote 12 lines to `fleet.py`, added route `/fleet/<id>`, pattern copied from `get_active_vehicles`."

---

## The Model Question

Current primary model: `qwen2.5-coder:7b-256k`.

- Doesn't support native Ollama tool calling — falls back to `<tool>` XML parsing
- 256k context is the key advantage — large files fit without windowing
- Reasoning depth is limited at 7B — follows instructions well but doesn't generalize

All tested qwen2.5-coder models (7b, 14b, 32b) fall back to text mode. Native tool calling isn't available for this family via Ollama.

**The right question isn't "which model is bigger?" — it's "how do we reduce what the model has to do?"**

Every programmatic step in the pre-processing pipeline reduces the model's job. The model doesn't search for files, inventory models, check for duplicates, figure out line numbers, or trace callers. It just writes code that fits a shown pattern, with a verified list of what exists and what's already there. A 7B model can do that reliably.

**The long-term architecture: the extension does all the thinking, the model does all the writing.**

---

## Capability Status Table

| Capability | Status | Approach |
|---|---|---|
| Find the right file | ✅ | Semantic index (Qdrant) + explicit path detection |
| Know what models/types exist | ✅ | Programmatic scan of app/models/ |
| Know what's already defined | ✅ | Route/function inventory (regex parse) |
| Follow existing patterns | ✅ | Pattern example injection |
| Avoid duplicate additions | ✅ | Duplicate check in context |
| Block invalid imports | ✅ | validateNewContent gate at tool level |
| Verify syntax after edit | ✅ | py_compile post-edit check |
| Add error handling to all routes | ✅ | sweepAddErrorHandling (zero model) |
| Update stale imports | ✅ | preProcessPathUpdate (zero model) |
| Show reasoning before acting | ✅ | Reasoning card UI |
| Know direct callers | ✅ | Grep-based caller analysis |
| Run tests after edit | ✅ | findTestFile + runTestFile (opt-in) |
| Plan multi-file changes | ✅ | planCard + confirmation gate |
| Test agent without VS Code | ✅ | Headless test harness |
| Know transitive callers | ❌ | Needs call graph index |
| Understand project architecture | ❌ | Needs richer index + briefing |
| Multi-file sequential execution | ⚠️ | Plan generated, execution manual |
| TypeScript project support | ❌ | Python-only today |
| Post-execution change summary | ⚠️ | Inconsistent — model-driven |

---

## Behavioral Hardening — Session Log (March 2026)

This section documents the defensive behaviors added to `agent.ts` to compensate for small-model failure patterns observed during real use in `scrapyard_new_ai`.

### Problem: Stub File Editing
**Symptom:** Agent created `cashier/transaction_form.html` (6-line placeholder) in a prior session. On subsequent tasks like "add a note field to the transaction form", it found the stub via `Get-ChildItem`, read it, and edited it — instead of finding the real form in `cashier_dashboard.html` (~271KB, the actual inline template).

**Fixes applied (layered defense):**
1. **Read-time warning** — when `shell_read` reads an HTML file under 15 lines with no `<!DOCTYPE`/`<html`/`{% extends`/`{% block` markers, the result is augmented with `[SYSTEM WARNING] This file is a STUB` + auto-search result pointing to the real file.
2. **`edit_file` hard block** — if the target `.html` file is under 15 lines with no real HTML markers, `edit_file` throws an error entirely: `BLOCKED — "path" is a stub file`. Includes the search command to find the real template. The model cannot proceed until it finds the correct file.

**Key insight:** Warnings in tool results are ignored when the model has already decided what to do. Only a hard `throw` that stops the tool from executing changes behavior.

### Problem: Multi-Word Grep Expanding to N Separate Searches
**Symptom:** Auto-search path injected `"transac sav trace"` as a grep pattern. On Windows this was converted to `Select-String -Pattern "transac"` (correct), but the model then ran two more separate searches for `sav` and `trace`.

**Fix:** When a multi-word grep is detected, the result now includes: `[NOTE] Your original pattern "X Y Z" was a multi-word phrase that cannot match a contiguous string. The search above used the most specific word. Do NOT repeat this search with the other words separately.`

### Problem: `edit_file` Failure Recovery Used Irrelevant Pattern
**Symptom:** When `old_string` failed to match, the fallback grep searched for `except|raise|.error(` — useful for debugging but not for most edit tasks.

**Fix:** Fallback now greps for the first line of the failed `old_string`, giving the model context around the actual code it was trying to edit.

### Problem: File-Not-Found Gave Raw ENOENT
**Fix:** `shell_read` and `edit_file` both now emit structured `[FILE NOT FOUND]` messages that explicitly say "Do NOT create this file" and provide a broad `Get-ChildItem` search command to find where the feature actually lives.

### Problem: `New-Item -ItemType File` Creating Source Files
**Fix:** `run_command` guards against `New-Item -ItemType File` calls for source file extensions (`.py`, `.ts`, `.js`, `.html`, etc.) and returns `[BLOCKED]` with a search command instead.

### Problem: Auto-Recovery Path Filter Only Matched `.py`
**Fix:** Changed `filter(l => /\.py$/i.test(l))` to `filter(l => /\.\w+$/.test(l))` so `.html`, `.ts`, and other file paths are recognized in search results.

---

## Path to v0.5.1: "Know the Project"

The theme of v0.5 was **grounding** — give the model verified facts before it writes. Every capability added was about making the model's input more reliable.

The theme of v0.5.1 should be **graph** — building a model of how the project's pieces connect, so the agent understands consequences, not just contents.

**Proposed v0.5.1 additions:**

**A. Call graph index**
When indexing a file, extract function definitions and their callees (regex-based for Python: `def foo():` + calls to other known functions). Store in Qdrant as graph edges. Pre-edit impact analysis walks the graph: direct callers → callers of callers → stop at 3 hops or 20 nodes. Inject: "Changing `get_user()` affects: `check_permissions()` → 15 routes."

**B. Data model relationship map**
Scan `app/models/` for foreign keys and relationships (`db.relationship`, `ForeignKey`). Build an adjacency map. Before any model edit, inject: "User has: Profile (1:1), Orders (1:many), Addresses (1:many). Changing `User` may require migration."

**C. TypeScript research phase**
Detect TS project via `tsconfig.json`. Scan `src/types/*.ts` for exported interfaces/enums as the "models inventory" equivalent. Parse Express/Next router files for route inventory. Run `tsc --noEmit` post-edit.

**D. Sequential multi-file execution**
After a plan step is confirmed and completes, automatically queue the next step. Pass the content of what was just written as `{{ previous_step_output }}` context for the next model call. Progress shown in the reasoning card.

**E. Architecture briefing document**
On workspace index, auto-generate `ARCHITECTURE.md` — a structured document listing: project type, entry points, middleware stack, key models, route prefixes, service layers. Injected on architecture questions and multi-file tasks. User can edit it to correct anything the scanner missed.

---

## Path Forward: Standalone Agent

### Why a Standalone Agent?

The VS Code extension constraint is increasingly artificial. The core value is in `agent.ts` — the pre-processing pipeline, the behavioral guards, the tool layer — not in the webview or the VS Code API. The extension wrapper:

- Requires VS Code to be running
- Requires an VSIX install or symlinked extension directory
- Makes the agent hard to test, hard to share, and impossible to run headless
- Ties distribution to the VS Code Marketplace model

A standalone CLI agent would run anywhere: a terminal, a CI pipeline, a Docker container, a server. Same logic, same tools, same model — just without the IDE host.

### What the Standalone Agent Looks Like

```
ollamapilot <task>
  │
  ▼
Agent.run(task, workspaceRoot)
  │
  ├── Pre-processing pipeline (unchanged)
  ├── Model call (Ollama HTTP, unchanged)
  ├── Tool execution (unchanged)
  └── Output: colored terminal diff + confirmation prompt
```

The agent loop, pre-processors, and all tool handlers are already model-agnostic. The only VS Code–specific surface is:

| What | VS Code API | Standalone replacement |
|---|---|---|
| Show diff to user | `vscode.diff` command | Terminal colored diff (chalk) |
| User confirmation | `vscode.window.showQuickPick` | readline `y/n` prompt |
| Post message to webview | `panel.webview.postMessage` | `console.log` / structured JSON |
| Workspace root | `vscode.workspace.workspaceFolders` | `process.argv` / `--workspace` flag |
| Configuration | `vscode.workspace.getConfiguration` | `.ollamapilot.json` config file |
| File system | `vscode.workspace.fs` (unused — uses `fs` directly) | Already Node.js `fs`, no change needed |

### Migration Path

**Phase 1 — Extract the agent core (low risk)**

Create `src/agentCore.ts` that exports `Agent` with no VS Code imports. Move all logic there. Keep `src/agent.ts` as a thin VS Code adapter that wraps `agentCore.ts` with the VS Code-specific UI layer (diff view, quick pick, webview messages).

This lets both the extension and the CLI share the exact same agent logic with zero duplication.

**Phase 2 — Build the CLI entry point**

Create `src/cli.ts`:
```typescript
import { Agent } from './agentCore';
import * as readline from 'readline';

const task = process.argv.slice(2).join(' ');
const workspaceRoot = process.cwd();

const agent = new Agent({
  workspaceRoot,
  confirm: async (diff) => {
    // show colored diff, prompt y/n
  },
  postMessage: (msg) => console.log(JSON.stringify(msg))
});

agent.run(task);
```

Compile to `dist/cli.js`, expose as `npx ollamapilot` or a global `ollamapilot` binary via `bin` in `package.json`.

**Phase 3 — Config file**

`.ollamapilot.json` at workspace root:
```json
{
  "ollamaBaseUrl": "http://192.168.0.29:11434",
  "model": "qwen2.5-coder:7b-256k",
  "qdrantUrl": "http://192.168.0.29:6333",
  "autoRunTests": false,
  "maxTurns": 20
}
```

Falls back to environment variables. This replaces `vscode.workspace.getConfiguration('ollamaAgent')`.

**Phase 4 — Headless CI use**

With `--json` flag, all output is newline-delimited JSON events:
```
{"type":"thinking","message":"Found 3 callers of get_user()"}
{"type":"diff","file":"app/models/user.py","added":5,"removed":1}
{"type":"confirm","prompt":"Apply this change?"}
{"type":"done","edits":1,"syntaxOk":true}
```

Makes it scriptable from CI pipelines without screen-scraping.

### What This Enables

- **Use from any terminal** — `cd myproject && ollamapilot "add error handling to all routes"`
- **CI integration** — run as a step in a GitHub Actions workflow
- **Remote server use** — SSH into a dev server and run the agent there, where Ollama is local to the GPU
- **Agent-to-agent** — another agent (or Claude Code) can spawn `ollamapilot` as a subprocess for specialized local-model tasks
- **Easier testing** — the headless harness is already 90% of the way there; CLI makes it fully scriptable

### What Stays in the Extension

The VS Code extension remains valuable for the interactive editing experience:
- Real-time diff view in the editor
- Reasoning card UI in the webview
- File explorer integration (right-click → "Ask OllamaPilot")
- Status bar indicator

But it becomes a thin UI layer over the shared agent core — not the only way to run it.

### Key Invariant

**The agent core must never import from `vscode`.** Every VS Code–specific call should be behind an interface (`IConfirmationProvider`, `IMessageBus`) injected at construction time. The extension injects real VS Code implementations; the CLI injects terminal implementations; the test harness injects stubs. This is the architecture the headless test harness already implies — just made explicit.
