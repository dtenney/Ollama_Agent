<div align="center">

# 🤖 OllamaPilot

### A fully local, offline AI coding assistant for VS Code — powered by Ollama

[![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)](https://github.com/kchikech/Ollama_Agent/releases)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.80.0-007ACC.svg)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Offline](https://img.shields.io/badge/works-100%25%20offline-success.svg)](#)

**No cloud. No subscriptions. No telemetry. Just you, your code, and a local AI.**

</div>

---

## ✨ What is Ollama Agent?

Ollama Agent is a free, open-source VS Code extension that brings a **Cursor-like AI coding assistant** experience directly into VS Code — running entirely on your machine using [Ollama](https://ollama.com).

- 🔒 **100% private** — your code never leaves your machine
- 🌐 **100% offline** — no internet connection required after setup
- 💸 **100% free** — no API keys, no subscriptions, no usage limits
- ⚡ **Streaming responses** — token-by-token output just like ChatGPT
- 🛠️ **Agentic tools** — the AI can read, write, search, and run commands in your workspace
- 🕐 **Chat history** — conversations are saved and restored across VS Code sessions
- 🎨 **Cursor-like UI** — modern sidebar chat panel that fits right into VS Code

---

## 📋 Table of Contents

- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
- [Getting Started](#-getting-started)
- [Features](#-features)
- [Agent Tools](#-agent-tools)
- [Chat History](#-chat-history)
- [Configuration / Settings](#-configuration--settings)
- [Keyboard Shortcuts](#-keyboard-shortcuts)
- [How It Works](#-how-it-works)
- [Supported Models](#-supported-models)
- [Contributing](#-contributing)
- [Development Setup](#-development-setup)
- [Roadmap](#-roadmap)
- [License](#-license)

---

## 📦 Prerequisites

Before installing the extension you need **Ollama** running on your machine.

### 1. Install Ollama

| Platform | Method |
|---|---|
| **macOS** | `brew install ollama` or download from [ollama.com](https://ollama.com/download) |
| **Linux** | `curl -fsSL https://ollama.com/install.sh \| sh` |
| **Windows** | Download the installer from [ollama.com/download](https://ollama.com/download) |

### 2. Pull a model

```bash
# Recommended: fast and code-aware (4 GB)
ollama pull qwen2.5-coder:7b

# Lightweight option (2 GB)
ollama pull phi3

# Large, high quality (8 GB)
ollama pull llama3.1:8b

# See all available models at https://ollama.com/library
ollama list
```

### 3. Start Ollama

```bash
ollama serve
```

> **Tip:** On macOS and Windows, Ollama starts automatically after installation. On Linux you may need to run `ollama serve` manually or set it up as a systemd service.

---

## 🚀 Installation

### Option A — Install from VS Code Marketplace *(coming soon)*

1. Open VS Code
2. Press `Ctrl+P` / `Cmd+P` and type:
   ```
   ext install local-dev.ollama-agent
   ```
3. Press Enter

### Option B — Install from `.vsix` file (current)

1. Download the latest `.vsix` from the [Releases page](https://github.com/kchikech/Ollama_Agent/releases)
2. Open VS Code
3. Press `Ctrl+Shift+P` / `Cmd+Shift+P` → type **"Install from VSIX"**
4. Select the downloaded `.vsix` file
5. Reload VS Code when prompted

### Option C — Install via command line

```bash
code --install-extension ollama-agent-0.6.0.vsix
```

---

## 🏁 Getting Started

1. **Open any folder** in VS Code (`File → Open Folder`)
2. **Start Ollama** if it isn't already running: `ollama serve`
3. **Click the robot icon** `🤖` in the Activity Bar (left sidebar)
4. **Select your model** from the dropdown in the chat header
5. **Type your first message** and press `Enter`

That's it. The agent will start responding immediately.

### First things to try

```
"Explain what this project does"
"List all files in this project"
"Find where the API routes are defined"
"Refactor the selected function to use async/await"
"Run npm install"
"What are the main dependencies?"
```

---

## 🌟 Features

### 🗨️ Chat Interface
- Cursor-style **sidebar chat panel** in the VS Code Activity Bar
- **Streaming responses** — see the AI's output token by token
- **Markdown rendering** — formatted text, headers, lists, and more
- **Syntax-highlighted code blocks** with one-click copy button
- **User and assistant message bubbles** clearly differentiated
- **Timestamps** on every message
- **Retry button** — regenerate any assistant response
- **Stop button** — cancel generation mid-stream
- **New chat button** — start a fresh conversation
- **Welcome screen** with quick-start hints
- **Smart scrolling** — auto-scrolls during generation, pauses when you scroll up with a ↓ button to return

### 🤖 AI Agent
- Multi-turn **agentic tool loop** — the AI can call tools, read results, then continue reasoning
- Supports **11 workspace tools** (see [Agent Tools](#-agent-tools) below)
- **Live command output** — terminal output streams directly into the chat
- **Diff preview** before applying file edits
- **Confirmation dialogs** for all destructive actions (write, delete, run command)
- **Automatic tool-mode fallback** — works with models that don't support native tool calling

### 📂 Workspace Awareness
- **Active file context** — attach the current file to any message with one click
- **Selection context** — attach selected code automatically
- **Auto-title** — chat sessions are named after your first message
- Context pills show what's attached before sending

### 🕐 Chat History
- Conversations **persist across VS Code restarts**
- **History panel** accessible via the 🕐 button
- Load, browse, and delete past sessions
- Full conversation context is restored (the model remembers prior exchanges)

### ⚙️ Settings
- Configurable **Ollama base URL** (supports remote Ollama instances)
- Per-session **model selection** via the header dropdown
- **Temperature** control
- **Custom system prompt** override
- All settings accessible via `Settings → Extensions → Ollama Agent`

---

## 🛠️ Agent Tools

The AI can autonomously call the following tools during a conversation:

| Tool | Description | Confirmation Required |
|---|---|---|
| `workspace_summary` | Full project tree, type detection, key files, recently modified | — |
| `read_file` | Read any file in the workspace | — |
| `list_files` | List directory contents | — |
| `search_files` | Search for text across all workspace files | — |
| `create_file` | Create a new file with content | — |
| `edit_file` | Targeted patch edit (old → new string) with VS Code diff preview | ✅ |
| `write_file` | Overwrite a file entirely | ✅ |
| `append_to_file` | Append text to an existing file | — |
| `rename_file` | Rename or move a file | ✅ |
| `delete_file` | Delete a file | ✅ |
| `run_command` | Execute shell commands with live output streaming | ✅ |

> **Safety:** All file modifications and command executions require explicit confirmation via a VS Code dialog. Paths are validated to stay within the workspace root. Dangerous command patterns (`rm -rf /`, `mkfs`, etc.) are blocked before the confirmation dialog even appears.

### Example agent workflow

```
User:  "Refactor the fetchUser function to handle errors properly"

Agent: → workspace_summary()           (understand the project)
       → read_file("src/api/user.ts")  (read the relevant file)
       → edit_file(...)                (show diff → user approves)
       ← "Done. I updated fetchUser to use try/catch and return a Result type..."
```

---

## 🕐 Chat History

Every conversation is automatically saved to VS Code's global storage after each assistant response.

| Action | How |
|---|---|
| **Open history** | Click the 🕐 button in the chat header |
| **Load a session** | Click any session in the list |
| **Delete a session** | Hover over a session → click 🗑 |
| **Delete all** | Open history → click "Delete all" |
| **New chat** | Click ＋ in the chat header, or use `Cmd+Shift+O` |

When you load a session, both the **visual chat** and the **conversation context** (the model's memory) are fully restored.

> Sessions are stored in VS Code's global state (not in your filesystem) so they are not committed to git.

---

## ⚙️ Configuration / Settings

Open `Settings` (`Ctrl+,` / `Cmd+,`) and search for **"Ollama"** to see all options.

| Setting | Default | Description |
|---|---|---|
| `ollamaAgent.baseUrl` | `""` | Full Ollama URL, e.g. `http://localhost:11434`. Overrides host + port when set. Useful for remote Ollama instances. |
| `ollamaAgent.host` | `localhost` | Ollama hostname (used only when `baseUrl` is empty) |
| `ollamaAgent.port` | `11434` | Ollama port (used only when `baseUrl` is empty) |
| `ollamaAgent.model` | `llama2` | Default model at startup. Overridable per session via the dropdown. |
| `ollamaAgent.temperature` | `0.7` | Sampling temperature. 0 = deterministic, 1 = balanced, 2 = creative |
| `ollamaAgent.systemPrompt` | `""` | Custom system prompt. Leave empty to use the built-in coding assistant prompt. |
| `ollamaAgent.autoIncludeFile` | `false` | Auto-attach the active file's full content to every message |
| `ollamaAgent.autoIncludeSelection` | `true` | Auto-attach selected code when a selection exists |
| `ollamaAgent.maxContextFiles` | `5` | Maximum number of workspace files to auto-load as context |

### Example: Using a remote Ollama instance

```json
// .vscode/settings.json
{
  "ollamaAgent.baseUrl": "http://192.168.1.100:11434",
  "ollamaAgent.model": "qwen2.5-coder:7b"
}
```

### Example: Custom system prompt

```json
{
  "ollamaAgent.systemPrompt": "You are a senior TypeScript engineer. Always write strict types. Prefer functional patterns. No any types allowed."
}
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+O` / `Ctrl+Shift+O` | Open the Ollama Agent chat panel |
| `Enter` | Send message |
| `Shift+Enter` | New line in the message input |

---

## 🔍 How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Extension                     │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────┐  │
│  │   Webview    │◄──►│   Provider   │◄──►│  Agent   │  │
│  │  (Chat UI)   │    │ (Msg Router) │    │  (Loop)  │  │
│  └──────────────┘    └──────────────┘    └──────────┘  │
│         │                   │                  │        │
│         │                   │            ┌─────▼──────┐│
│         │                   │            │   Tools    ││
│         │                   │            │ read_file  ││
│         │                   │            │ edit_file  ││
│         │                   │            │ run_cmd    ││
│         │                   │            └────────────┘│
│         │            ┌──────▼──────┐                   │
│         │            │  Storage    │                   │
│         │            │(globalState)│                   │
│         │            └─────────────┘                   │
└─────────┼───────────────────────────────────────────────┘
          │
          ▼ HTTP (localhost)
┌─────────────────────┐
│     Ollama Server   │
│  localhost:11434    │
│                     │
│  llama3 / qwen /    │
│  phi / mistral /    │
│  codellama / ...    │
└─────────────────────┘
```

### Architecture

The extension is built in clean TypeScript modules:

```
src/
├── main.ts           Entry point — activate() registers commands and the sidebar provider
├── provider.ts       WebviewViewProvider — routes messages, manages sessions, captures tokens
├── agent.ts          Agent loop — multi-turn tool calling, mode switching, history
├── ollamaClient.ts   HTTP client for Ollama API (/api/chat, /api/tags)
├── chatStorage.ts    Session persistence via vscode.ExtensionContext.globalState
├── config.ts         Configuration reader (maps VS Code settings → typed OllamaConfig)
├── context.ts        Active file / selection extraction from the editor
├── workspace.ts      Project scanner — file tree, project type, key files, recent files
└── logger.ts         Shared OutputChannel logger

webview/
├── webview.html      Chat panel UI — VS Code theme variables, no frameworks
└── webview.js        Frontend logic — streaming, markdown, history panel, tool cards
```

### Message flow

1. User types a message and presses Enter
2. Webview sends `{ command: 'sendMessage', text, model, includeFile, includeSelection }` to the extension
3. Provider builds context string (active file / selection if toggled), wraps `post()` to capture tokens
4. `Agent.run()` sends the conversation to Ollama via streaming `/api/chat`
5. Each token is forwarded to the webview as `{ type: 'token', text }`
6. When the model emits a tool call, the agent executes it (with confirmation if needed) and loops
7. On `streamEnd`, the provider saves the complete assistant message to the current session

### Tool calling — two modes

| Mode | When used | How |
|---|---|---|
| **Native** | Models that support Ollama tool calling (llama3-groq-tool-use, qwen2.5-coder, etc.) | Tools passed as JSON schema in the API request |
| **Text (fallback)** | All other models (llama2, phi, mistral, etc.) | Tool instructions injected into the system prompt; the model emits `<tool>{"name":...}</tool>` blocks which are parsed client-side |

The switch happens automatically on the first `HTTP 400 — does not support tools` error, with no interruption to the user experience.

---

## 📡 Supported Models

Any model available in Ollama works with this extension. Models known to work well:

| Model | Size | Notes |
|---|---|---|
| `qwen2.5-coder:7b` | ~4 GB | ⭐ Recommended — excellent at coding, native tools |
| `qwen2.5-coder:1.5b` | ~1 GB | Fastest, good for quick tasks |
| `llama3.1:8b` | ~5 GB | General purpose, high quality |
| `phi3:mini` | ~2 GB | Very fast, good for simple tasks |
| `codellama:7b` | ~4 GB | Specialized for code generation |
| `mistral:7b` | ~4 GB | Well-rounded, good reasoning |
| `deepseek-coder:6.7b` | ~4 GB | Strong at code tasks |
| `llama2` | ~4 GB | Classic, text-mode fallback activated automatically |

Pull any model with:
```bash
ollama pull <model-name>
```

---

## 🤝 Contributing

Contributions are warmly welcome! Whether it's a bug fix, a new feature, better documentation, or a UX improvement — all pull requests are reviewed.

### Ways to contribute

- 🐛 **Report bugs** — open an [Issue](https://github.com/kchikech/Ollama_Agent/issues) with reproduction steps
- 💡 **Suggest features** — open an Issue with the `enhancement` label
- 🔧 **Submit a PR** — see [Development Setup](#-development-setup) below
- 📖 **Improve docs** — typos, clarity, missing info
- 🌍 **Share** — star the repo, mention it to other developers

### Code of Conduct

Be kind, be constructive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

---

## 🛠️ Development Setup

### Requirements

- Node.js 18+
- npm 9+
- VS Code 1.80+
- Ollama running locally

### Clone and build

```bash
# 1. Clone the repo
git clone https://github.com/kchikech/Ollama_Agent.git
cd ollama-agent

# 2. Install dev dependencies
npm install

# 3. Compile TypeScript
npm run build

# 4. Package as .vsix for testing
npx vsce package --allow-missing-repository --skip-license
```

### Run in development mode

1. Open the `ollama-agent` folder in VS Code
2. Press `F5` — this opens a new **Extension Development Host** window with the extension loaded
3. Make changes → `npm run build` → reload the Extension Development Host (`Ctrl+R`)

### Project structure

| Path | Purpose |
|---|---|
| `src/` | All TypeScript source — compiled to `dist/` |
| `webview/` | Frontend HTML + vanilla JS — inlined into the webview at runtime |
| `images/` | Extension icons |
| `dist/` | Compiled output (gitignored) |
| `.vscodeignore` | Files excluded from the `.vsix` package |

### Adding a new tool

1. Add the tool definition to `TOOL_DEFINITIONS` in `src/agent.ts`
2. Add the execution case in `Agent.executeTool()`
3. Add an icon to `TOOL_ICONS` in `webview/webview.js`
4. Update `TEXT_MODE_TOOL_INSTRUCTIONS` in `src/agent.ts`
5. Add the tool to this README's [Agent Tools](#-agent-tools) table

### Running diagnostics

Use the built-in diagnostic command to verify your Ollama connection:

```
Ctrl+Shift+P → "Ollama: Run Diagnostics"
```

This tests HTTP connectivity, lists models, and runs a streaming test. Output appears in `Output → Ollama Agent`.

---

## 🗺️ Roadmap

### v0.7.0 — Enhanced Context
- [ ] `@filename` mention in the prompt to attach specific files
- [ ] Token count indicator showing context size before sending
- [ ] Multi-workspace folder support

### v0.8.0 — Code Intelligence
- [ ] Syntax highlighting in code blocks (offline highlight.js)
- [ ] Inline diff application directly in the editor
- [ ] `git diff` context injection

### v0.9.0 — UX Polish
- [ ] Export chat as Markdown
- [ ] Message search within a session
- [ ] Configurable keyboard shortcut

### v1.0.0 — Marketplace Release
- [ ] Official VS Code Marketplace listing
- [ ] Icon and banner assets
- [ ] Comprehensive test suite

> Have a feature idea? [Open an issue](https://github.com/kchikech/Ollama_Agent/issues/new?labels=enhancement) — community feedback drives the roadmap.

---

## ❓ FAQ

**Q: Does it work without internet?**  
A: Yes. Once Ollama is installed and a model is pulled, the extension works completely offline. No data is ever sent to any external server.

**Q: My model doesn't support tools — will agent features still work?**  
A: Yes. The extension automatically detects when a model doesn't support native tool calling and switches to a text-mode fallback where tool instructions are embedded in the system prompt. You'll see an amber notice in the chat when this happens.

**Q: Can I use a remote Ollama instance?**  
A: Yes. Set `ollamaAgent.baseUrl` to the remote URL (e.g. `http://192.168.1.100:11434`). HTTPS is also supported.

**Q: Where are my chats stored?**  
A: In VS Code's global extension storage (`globalState`). They are not stored in your filesystem or committed to git. Use `Settings → Ollama Agent → clearAllSessions` or the "Delete all" button in the history panel to remove them.

**Q: How do I change the default model?**  
A: Go to `Settings → ollamaAgent.model` and set your preferred model name. You can also switch models per session using the dropdown in the chat header.

**Q: The extension shows "Ollama not running". What do I do?**  
A: Run `ollama serve` in a terminal. On macOS you can also start it from the menu bar icon.

**Q: Can the AI modify my files without asking?**  
A: No. Every file write, edit, rename, and delete requires you to click **Apply** / **Write** / **Delete** in a confirmation dialog. Command execution (`run_command`) also requires explicit confirmation.

---

## 🔒 Privacy

This extension is designed with privacy as a first-class concern:

- ✅ All processing happens locally on your machine
- ✅ No analytics, telemetry, or usage tracking of any kind
- ✅ No network requests except to your local Ollama instance
- ✅ Chat history is stored only in VS Code's local extension storage
- ✅ No API keys or accounts required
- ✅ Open source — audit the code yourself

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

```
MIT License

Copyright (c) 2026 Ollama Agent Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
```

---

## 🙏 Acknowledgements

- [Ollama](https://ollama.com) — for making local LLMs accessible to everyone
- [VS Code Extension API](https://code.visualstudio.com/api) — for the powerful webview and workspace APIs
- All contributors and early adopters who helped shape this extension

---

<div align="center">

**Made with ❤️ by the open-source community**

[Report a Bug](https://github.com/kchikech/Ollama_Agent/issues) · [Request a Feature](https://github.com/kchikech/Ollama_Agent/issues) · [Contribute](CONTRIBUTING.md)

⭐ Star this repo if you find it useful!

</div>
