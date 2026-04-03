# Changelog

All notable changes to OllamaPilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **SQLAlchemy model integrity check** — after any `models/*.py` edit, scans for multiple FK columns referencing the same table without `foreign_keys=` on relationships; blocks with a specific `AmbiguousForeignKeysError` warning before the model continues
- **Substantive analysis bypass** (`isSubstantiveAnalysis`) — responses >2000 chars with 2+ `##` headings and a closing question only in the final 300 chars are treated as complete analysis reports, not stalls; suppresses the `isSummaryWithQuestion` auto-retry that was looping on planning/discussion sessions
- **`isConfirmStop` expanded patterns** — now catches "Should I proceed?", "Should we proceed?", "Ready to implement?", "Want to proceed?" in addition to the existing "Shall I proceed?" variants; prevents `isAskingPermission` from firing on complete analysis reports with natural handoff questions
- **Structured auto-compact summarization** — 99% context auto-compaction now runs full LLM-based structured JSON extraction (same prompt as manual compact) instead of regex scraping; saves task, confirmed files, ruled-out files, decisions, edits made, and next steps to Tier 2 memory
- **`preProcessEditTask` returns `pendingSteps`** — completion checklist items from the pre-processor are now passed back to the agent and stored in `_activeTask.stepsPending`, giving the task state machine real content to track
- **Step completion cross-reference** — after a successful `edit_file`, matching steps in `stepsPending` are automatically moved to `stepsCompleted` based on the edited file's basename; compaction context note includes remaining steps
- **Memory access tracking** — `recordAccess(entryId, accessType)` now appends timestamped events to `accessHistory[]` (capped at 50); called at system prompt load (`passive_load`), `memory_search` return (`search_result`), and post-response snippet match (`search_hit`)
- **`_recentSearchResultIds`** — agent tracks entry IDs returned by `memory_search` each turn; checks if model response text contains a snippet from any of them and upgrades to `search_hit` access type
- **Tag-based TTL rules** in `demoteStaleEntries` — `auto-compact`/`session` tags expire after 7 days (delete), discovery/file-resolution tags after 30 days (demote), session-end/completed tags after 60 days (demote), untagged entries use the existing threshold
- **Tier 5 pruning** — entries older than 180 days with zero `search_hit` accesses are permanently deleted (including Qdrant cleanup)
- **`findById` on `TieredMemoryManager`** — searches all tiers by entry ID, used by the `search_hit` upgrade path
- **`edit_file` append fallback** — when `old_string` is not found AND `new_string` starts with a function/method definition AND `old_string` is ≤10 lines, immediately injects the last 30 lines of the file with line numbers on the first failure rather than requiring two failures
- **Qwen3.5 27B tested and confirmed** — validated on `qwen3.5:27b-49k` with 262k context; performs reliably on multi-file agentic tasks including planning, exploration, and code editing with thinking mode enabled

### Fixed
- `isSummaryWithQuestion` false-positive on complete analysis reports ending with "Should I proceed?" — was looping 4+ times on planning/discussion sessions
- Auto-compact at 99% was silently discarding all discovered facts; now preserves them in Tier 2 memory via structured extraction

## [0.4.0] - 2025-06-14

### Added
- **Diagnostics-aware agent** — new `get_diagnostics` tool checks VS Code errors/warnings after edits and self-corrects
- **Apply code from chat** — "Apply" button on every code block with diff preview before applying
- **Slash commands** — 7 built-in commands (`/test`, `/fix`, `/review`, `/doc`, `/explain`, `/refactor`, `/optimize`) with autocomplete dropdown
- **Chat input history** — ↑/↓ arrow keys in empty input to cycle through previous messages (last 50)
- **Terminal output reading** — new `read_terminal` tool reads recent output from VS Code integrated terminals (1.93+ shell integration with fallback)
- **Pinned files** — always-in-context files that persist across messages and VS Code restarts, with 📌+ button in context bar
- **Compact with summary** — dropped messages are summarized by the model before removal during context compaction
- **FIM inline completions** — switched from chat API to `/api/generate` with prefix/suffix for proper fill-in-the-middle completions

### Changed
- Agent tool count increased from 18 to 21 (added `get_diagnostics`, `read_terminal`, `refactor_multi_file`)
- Test suite updated to validate 21 tools
- README updated with all new features, tools table, keyboard shortcuts, and v0.5.0 roadmap section

### Fixed
- **Type safety** — `pinnedFiles` added to `MsgSendMessage` interface (was `any` cast)
- **Pinned files dedup** — now deduplicates against smart context files, not just @mentions
- **Pin button UX** — 📌+ now inserts `@` at cursor position instead of overwriting input text
- **Pin mode race condition** — `pinModeActive` flag properly reset when user breaks out of @mention flow
- **Stale workspace closure** — pinned files and git diff now use `this._currentWorkspaceRoot` instead of stale closure from `resolveWebviewView`
- **Dead import** — removed unused `import * as os` from agent.ts
- **.gitignore encoding** — rewrote in clean UTF-8 (was corrupted with UTF-16LE entries)
- **.vscodeignore encoding** — same fix

## [0.3.1] - 2025-06-13

### Added
- **Python tooling integration** — auto-detects Python environment (linter, formatter, test framework, type checker, package manager) and injects project-specific guidance into the system prompt
- **Code Lens provider** — "✨ Explain" and "📝 Document" lenses above functions/classes for 12 languages (opt-in via `ollamaAgent.codeLens.enabled`)
- **Undo last tool** — "↩ Undo" button on file operation toasts to revert create/edit/write/append/delete
- **Language-aware documentation** — docs code action uses correct doc style per language (JSDoc, docstrings, Javadoc, KDoc, Doxygen, YARD, PHPDoc, etc.)
- **Language-aware test generation** — tests code action uses correct framework per language (pytest, Jest, JUnit, xUnit, RSpec, PHPUnit, etc.)
- **Advanced prompt templates** — conditional blocks `{?var}...{/var}`, export/import templates as JSON
- **E2E tests** — 13 integration tests for workspace module (Python detection, file tree, etc.)
- **Code coverage** — `npm run test:coverage` via nyc/istanbul
- **esbuild bundling** — extension now ships as a single bundled file

### Changed
- **Package size reduced from 2,627 files (10.9 MB) to 14 files (6.9 MB)** via esbuild bundling
- Test suite expanded to 160 tests across 12 modules
- `run_command` tool description now mentions pytest, ruff, mypy, eslint, tsc
- Text-mode tool instructions include Python-specific examples

### Fixed
- Unreachable `break` statement in code action switch (dead code removed)

## [0.4.0-alpha] - 2025-03-13

### Added
- **Enhanced diff view** with accept/reject options and keyboard shortcuts (Alt+A/Alt+R)
- **Inline code completions** — automatic suggestions as you type, manual trigger with Alt+C
- **Multi-file refactoring** — coordinated changes across multiple files with preview UI
- **Export chat** — save conversations as Markdown or JSON
- **@symbol mentions** — attach workspace symbols (functions, classes) to messages
- **Multi-workspace folder support** — isolated agents per workspace folder
- **Comprehensive test suite** — 147 unit tests across 11 modules (Mocha + Sinon)
- **Marketplace banner** — 1280×640 dark-themed banner image
- `npm test` and `npm run test:unit` scripts

### Changed
- Cleaned up 17 intermediate session/status markdown files
- Updated roadmap to reflect all completed features

## [0.3.0-alpha] - 2025-03-13

### Added
- **Explain selection shortcut** — `Ctrl+Shift+E` / `Cmd+Shift+E` to instantly explain selected code
- **Model presets** — fast/balanced/quality presets with bidirectional sync
- **Code actions provider** — 6 right-click actions (Explain, Comment, Refactor, Bugs, Tests, Docs)
- **Error quick fixes** — click lightbulb on errors to get AI explanations with surrounding context
- **Prompt templates** — 6 built-in templates + custom template management with variable substitution
- **Smart context selection** — auto-include imported/related files with relevance scoring
- **Search in chat** — find, highlight, and navigate matches within conversations

### Fixed
- Memory leak in search highlight DOM manipulation
- Memory leak in Agent history (explicit disposal in 4 locations)
- Race condition in preset/model circular updates (dual-flag pattern)
- Race condition in workspace change detection (mutex)
- Race condition in file index rebuild (immediate indexing)
- Race condition in smart context file limit (uses config)
- Template variable substitution sorts keys by length to prevent partial replacements

## [0.2.0] - 2025-03-12

### Added
- **Multi-tiered memory system** with 6 tiers (Critical → Archive) for intelligent context management
- **Semantic search** via Qdrant vector database integration
- **Memory UI panel** in sidebar for browsing, promoting, demoting, and deleting memory entries
- **MCP (Model Context Protocol) support** for connecting to external tool servers
- **Auto-save memory** feature to proactively store important project information
- **Auto-compact context** to prevent hitting model context limits
- **Memory maintenance** command for automatic cleanup and optimization
- **Export/import memory** functionality for backup and sharing
- **Memory statistics** view showing usage across tiers
- Automatic Qdrant collection dimension validation and recreation
- Enhanced text-mode tool parser supporting multiple JSON formats

### Fixed
- Text-mode tool parser infinite loop with flat JSON format
- Tool call stripping inconsistency in display content
- Qdrant dimension mismatch errors (384D vs 768D)
- Memory system now properly breaks complex information into atomic entries

### Changed
- Improved system prompts with explicit memory-saving protocols
- Enhanced tool instructions for better multi-part information handling
- Memory entries now stored with proper tier-based organization

## [0.1.0] - 2025-03-01

### Added
- Initial release
- Cursor-like chat interface in VS Code sidebar
- Streaming responses from Ollama
- Agentic tool loop with 14 workspace tools
- @file mentions with fuzzy search autocomplete
- Token estimation with model-aware context windows
- Chat history persistence across sessions
- Git diff context injection (optional)
- Project memory with workspace-scoped notes
- Offline syntax highlighting for 30+ languages
- Configurable Ollama connection (local/remote)
- Keyboard shortcuts and command palette integration
- Safety confirmations for destructive operations

### Tools
- workspace_summary, read_file, list_files, search_files
- create_file, edit_file, write_file, append_to_file
- rename_file, delete_file, run_command
- memory_list, memory_write, memory_delete

---

## Upgrade Notes

### 0.1.0 → 0.2.0

**New Dependencies:**
- Qdrant vector database (optional, for semantic search)
- `@modelcontextprotocol/sdk` for MCP support

**Breaking Changes:**
- None - fully backward compatible

**Recommended Actions:**
1. Install Qdrant if you want semantic memory search: `docker run -p 6333:6333 qdrant/qdrant`
2. Pull embedding model: `ollama pull nomic-embed-text`
3. Review new memory settings in VS Code preferences
4. Consider enabling `ollamaAgent.memory.autoSave` for automatic context capture

**Migration:**
- Old project memory (from 0.1.0) is automatically migrated to Tier 2 (Essential)
- No manual migration required
