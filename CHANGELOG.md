# Changelog

All notable changes to OllamaPilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0-alpha] - 2026-03-13

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

## [0.3.0-alpha] - 2026-03-13

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

## [0.2.0] - 2026-03-12

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

## [0.1.0] - 2026-03-01

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
