# OllamaPilot — Development Plan

> **Purpose**: Living document that captures where the project is, what's in progress, and where it's going.
> Update this file at the start of each work session and whenever priorities shift.
>
> **Last updated**: 2026-04-27
> **Version**: 0.4.0
> **Branch**: main

---

## What This Is

OllamaPilot is a VSCode extension that brings a Cursor-like AI coding assistant experience entirely offline using local Ollama models. No cloud, no telemetry, no subscriptions. The agent can read files, edit code, run shell commands, search the web via SearXNG, and maintain long-term memory across sessions.

---

## Current State — What's Done

### Core Agent
- [x] Agentic tool execution loop with 20+ tools
- [x] Native tool call support + text-mode fallback for models that don't support JSON tool schemas (e.g. Qwen)
- [x] Multi-turn conversation with automatic retry on failures
- [x] Guard rails: schema validation, merge guard, undefined-function guard, syntax error detection, repeat protection, scope guard, import validation
- [x] Sweep task detection — "add X to all routes" style multi-file jobs
- [x] Verify-before-implement doctrine (checks if feature already exists before writing new code)
- [x] Resume detection — "continue where we left off" restores task state from memory

### Tools Available to the Agent
- [x] `workspace_summary` — project structure overview
- [x] `shell_read` — read-only shell commands (grep, ls, git, cat)
- [x] `run_command` — state-modifying shell commands (tests, builds, installs)
- [x] `edit_file` — targeted file replacement with fuzzy whitespace matching
- [x] `edit_file_at_line` — line-number-based editing
- [x] `memory_*` — full CRUD on the tiered memory system (list, write, delete, search, tier_write, tier_list, stats)
- [x] `read_terminal` — capture VSCode terminal output
- [x] `get_diagnostics` — read VSCode error/warning diagnostics
- [x] `web_search` / `web_fetch` — real-time info via SearXNG
- [x] `refactor_multi_file` — coordinated cross-file refactoring
- [x] MCP tool passthrough — any tools from connected MCP servers

### Memory System
- [x] 6-tier tiered memory (0=critical → 5=archive)
- [x] Semantic search via Qdrant vector DB + Ollama embeddings
- [x] Auto-promotion and demotion based on access frequency and age
- [x] Graceful fallback to local storage when Qdrant is unavailable
- [x] Warning notification + system prompt injection when Tiers 4-5 are offline
- [x] Memory UI tree view (browse, promote, demote, delete)
- [x] Project memory auto-seeded from ARCHITECTURE.md on startup
- [x] Staleness detection — re-seeds when ARCHITECTURE.md is newer than last seed

### Context Assembly
- [x] Smart context — auto-attach related files via import graph and recency
- [x] Git diff injection (optional, per setting)
- [x] Token estimation with model-aware limits (safe/warning/critical/overflow)
- [x] History compaction at 99% of context limit
- [x] Semantic code index — 685+ file embeddings for relevance search
- [x] @mention system — `@file` and `@symbol` to explicitly attach context
- [x] Hierarchical context files — `.ollamapilot.md`, `AGENTS.md`, `CLAUDE.md` per directory
- [x] ARCHITECTURE.md pipeline — auto-generated and consumed by context loader, workspace_summary tool, and Tier 1 memory

### Session & Persistence
- [x] Chat sessions saved to VSCode `workspaceState` (up to 50 per workspace)
- [x] `agentHistory` and `activeTask` persisted on every model turn (not just run end)
- [x] Session restore on VSCode reopen — full conversation history + task state
- [x] Sweep progress written to Tier 2 memory as crash-recovery backup
- [x] Session audit log (`.ollamapilot/sessions.jsonl`) — tool calls, guard events, outcomes per run
- [x] Chat export to Markdown or JSON

### Shell & Platform Support
- [x] Python-first cross-platform approach — `python3 -c "..."` as primary OS tool
- [x] Session recon at startup — probes python/pip/git/node/OS and injects into system prompt
- [x] Windows (PowerShell), macOS (zsh), Linux (bash) support
- [x] Newline injection prevention in shell commands
- [x] Per-file edit loop guard (warns after 5+ edits to same file in one run)
- [x] Python environment detection — venv, Poetry, pipenv, uv; pytest, ruff, flake8

### Code Intelligence
- [x] Inline completions (autocomplete-style, toggleable)
- [x] CodeLens — "Explain" and "Document" lenses above functions (toggleable)
- [x] Code actions — quick fixes from diagnostics
- [x] Multi-file refactoring with preview/apply workflow
- [x] AST-aware file chunking for large files (Python, JS, Go)
- [x] Offline syntax highlighting for 30+ languages

### Configuration & Integrations
- [x] Model presets (Fast: qwen2.5-coder:7b, Balanced/Quality: qwen3.6:35b-a3b-32k)
- [x] Multi-model routing — fast model for reads, main model for writes, optional critic model
- [x] MCP server support (Model Context Protocol)
- [x] OpenClaw gateway integration (WebSocket client for external agent dispatch)
- [x] 45+ configuration settings via VSCode settings UI

---

## In Progress

- [ ] **OpenClaw assessment** — Determine which patterns from OpenClaw's agent should be adapted for OllamaPilot. The WebSocket client exists (`openClawClient.ts`) but the integration depth is unclear. Questions: Should OllamaPilot delegate heavy tasks to OpenClaw? Should tool patterns be mirrored?

---

## Backlog — Prioritized

### High Priority (reliability / daily-driver gaps)

1. **Full `spawn(shell:true)` hardening** — Replace remaining `shell:true` spawns with explicit shell paths (`/bin/sh -c` on Unix, `powershell.exe -Command` on Windows) to eliminate injection surface. Newline stripping is done; explicit path routing is partially done for Python commands only.

2. **Qdrant reconnect on failure** — If Qdrant goes offline mid-session, the extension warns once but never retries. Add periodic health check with auto-reconnect so Tiers 4-5 come back online without a VSCode restart.

3. **Context file auto-update** — `ollamaAgent.contextFileAutoUpdateDays` setting exists but the trigger logic needs validation. Confirm staleness check fires correctly when `.ollamapilot.md` / `AGENTS.md` are older than the configured days.

4. **Model availability check on startup** — The keep-alive 404 (when configured model isn't pulled in Ollama) only surfaces in the log. Show a visible warning in the UI with a hint to run `ollama pull <model>`.

5. **MCP server error surfacing** — MCP servers that fail to start are silently swallowed. Expose failures in the output channel and optionally in the chat UI.

### Medium Priority (quality of life)

6. **Past chat search** — No way to search across saved sessions by keyword. Add a search box to the session list panel.

7. **Pin messages to context** — UI for pinning exists (`pinnedMsgIds`) but confirm the agent actually re-injects pinned messages into every system prompt turn (verify the wiring).

8. **Critic model pass** — The `routing.criticModel` setting and `resolveModelForOperation('critic')` exist, but confirm the critic is actually called after edits in the agent loop. If not, wire it in.

9. **Inline diff preview** — `diffView.ts` exists but verify it's wired to all `edit_file` calls. Users should always see a diff before changes are applied when they want to.

10. **Memory export/import** — No way to back up or transfer memory between machines. Add export-to-JSON and import commands.

### Lower Priority (features)

11. **Voice input** — Use VSCode's speech API or a local whisper model for hands-free prompting.

12. **Notebook support** — `.ipynb` files are not handled by `edit_file` or the code indexer. Add Jupyter notebook awareness.

13. **OpenClaw deep integration** — If OpenClaw's agent is superior for certain task types (long-horizon planning, web research), add a routing layer that delegates to it automatically rather than requiring the user to invoke it manually.

14. **Test generation** — Dedicated `generate_tests` tool that reads a function and writes matching tests in the project's test framework.

15. **Changelog auto-generation** — After a sweep or multi-file edit, auto-write a `CHANGELOG.md` entry summarizing what changed.

---

## Architecture at a Glance

```
VSCode Extension Shell
  main.ts              — activation, command registration, MCP startup
  provider.ts          — webview bridge, session management, message routing

Agent Core
  agent.ts             — tool loop, parsing, guards, sweep detection, memory integration
  ollamaClient.ts      — Ollama HTTP API (streaming chat, keep-alive, embeddings)

Context Pipeline
  codeIndex.ts         — semantic file index (auto-generates ARCHITECTURE.md)
  workspace.ts         — project detection, Python env, file tree
  smartContext.ts      — import-graph related-file detection
  gitContext.ts        — git diff injection
  contextCalculator.ts — token estimation, history compaction
  mentions.ts          — @file/@symbol context building

Memory Stack
  memoryCore.ts        — 6-tier TieredMemoryManager, promotion/demotion
  qdrantClient.ts      — vector DB client
  embeddingService.ts  — Ollama embedding generation
  chatStorage.ts       — session persistence (workspaceState)
  sessionLog.ts        — audit log (.ollamapilot/sessions.jsonl)

Code Intelligence
  inlineCompletionProvider.ts
  codeLensProvider.ts
  codeActionsProvider.ts
  symbolProvider.ts
  multiFileRefactor.ts
  fileSplitter.ts

Integrations
  mcpClient.ts         — MCP server lifecycle + tool passthrough
  openClawClient.ts    — OpenClaw WebSocket gateway
  config.ts            — all settings, model presets, routing
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| **Local-only (Ollama)** | Privacy, no API costs, works offline |
| **Python-first shell** | Identical behavior on Windows/macOS/Linux without shell quoting differences |
| **Text-mode fallback** | Qwen and other models often ignore JSON tool schemas; `<tool>{}</tool>` XML fallback keeps the agent working |
| **6-tier memory** | Tier 0-1 always in context, 2-3 session-scoped, 4-5 semantic search only — balances context budget vs. recall |
| **Per-turn persistence** | `agentHistory` saved every model turn, not just run end — survives crashes |
| **Guard rails over autonomy** | Prefer blocking bad actions (scope guard, merge guard) over letting the model self-correct |
| **workspaceState for sessions** | Each workspace gets its own isolated session history — no cross-project leakage |

---

## How to Work With This Plan

- **Starting a session**: Read this file first. Check "In Progress" to pick up where things left off.
- **Finishing a task**: Move it from Backlog → done checkbox in "Current State". Update "In Progress".
- **New ideas**: Add to Backlog with a priority assessment. Don't add to "In Progress" until actually started.
- **After a significant change**: Update the "Last updated" date at the top.
- **Stuck or context lost**: The agent can reconstruct state from `ARCHITECTURE.md` (auto-generated), `.ollamapilot/sessions.jsonl` (audit log), and Tier 2-3 memory entries tagged `sweep-progress` or `session-end`.
