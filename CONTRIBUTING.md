# Contributing to Ollama Agent

Thank you for your interest in contributing! This document covers everything you need to know to get involved.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Adding New Tools](#adding-new-tools)

---

## Code of Conduct

Please be respectful and constructive in all interactions. We follow the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

---

## How to Contribute

There are many ways to help, regardless of experience level:

| Type | How |
|---|---|
| 🐛 Bug report | Open a GitHub Issue with steps to reproduce |
| 💡 Feature request | Open a GitHub Issue with the `enhancement` label |
| 🔧 Code change | Fork → branch → PR |
| 📖 Documentation | Edit README.md, add JSDoc comments, fix typos |
| 🧪 Testing | Try the extension on different models/platforms and report findings |
| ⭐ Spread the word | Star the repo, share with other developers |

---

## Development Setup

### 1. Prerequisites

- Node.js 18 or later
- npm 9 or later
- VS Code 1.80 or later
- Ollama installed and running locally (`ollama serve`)
- At least one model pulled (`ollama pull qwen2.5-coder:7b`)

### 2. Fork and clone

```bash
git clone https://github.com/YOUR-USERNAME/ollama-agent.git
cd ollama-agent
```

### 3. Install dependencies

```bash
npm install
```

### 4. Build

```bash
npm run build
```

This compiles TypeScript from `src/` to `dist/`.

### 5. Run in development mode

1. Open the `ollama-agent` folder in VS Code
2. Press `F5` to launch the **Extension Development Host** (a second VS Code window)
3. In the new window, open any project folder
4. Click the robot icon in the Activity Bar to open the chat panel

### 6. Rebuild after changes

The TypeScript compiler does not watch by default. After code changes:

```bash
npm run build
```

Then in the Extension Development Host: `Ctrl+R` / `Cmd+R` to reload.

### 7. Check for errors

```bash
npm run build 2>&1
```

All TypeScript errors must be resolved before a PR will be accepted.

### 8. Package for manual testing

```bash
npx vsce package --allow-missing-repository --skip-license
code --install-extension ollama-agent-*.vsix
```

---

## Project Structure

```
ollama-agent/
├── src/
│   ├── main.ts           Extension entry point — activate() / deactivate()
│   ├── provider.ts       WebviewViewProvider — message routing, session management
│   ├── agent.ts          Agent loop, tool definitions, tool executor
│   ├── ollamaClient.ts   HTTP client — streaming /api/chat, /api/tags
│   ├── chatStorage.ts    Session persistence via globalState
│   ├── config.ts         Settings reader (VS Code → typed OllamaConfig)
│   ├── context.ts        Active file / selection extraction
│   ├── workspace.ts      Project scanner (file tree, key files, recent files)
│   └── logger.ts         Shared OutputChannel
│
├── webview/
│   ├── webview.html      Chat UI — vanilla HTML/CSS, VS Code theme variables
│   └── webview.js        Frontend — streaming, markdown, history panel
│
├── images/
│   └── sidebar-icon.svg  Activity bar icon
│
├── package.json          Extension manifest + settings schema
├── tsconfig.json         TypeScript compiler config
├── .vscodeignore         Files excluded from .vsix
├── README.md
├── CONTRIBUTING.md
└── LICENSE
```

---

## Coding Standards

### TypeScript

- **Strict mode** is enabled — no implicit `any`
- Use `interface` for object shapes, `type` for unions and aliases
- Export types that cross module boundaries
- No unused imports or variables (compiler will catch these)
- Use `async/await` over raw Promises where possible

### File naming

- All source files: `camelCase.ts`
- One responsibility per file — keep files under ~300 lines where possible

### Comments

- Write comments to explain **why**, not **what**
- Use JSDoc for exported functions: `/** Description. @param x - purpose */`
- Avoid obvious comments like `// increment counter`

### Webview JS

- The webview runs plain ES2020 JavaScript (no TypeScript, no bundler)
- Add `// @ts-check` at the top of `webview.js`
- Use `/** @type {...} */` JSDoc annotations for type hints
- No `onclick="..."` attributes — use `addEventListener` (CSP compliance)
- No `eval()` or dynamic `import()`

### CSS (in webview.html)

- Use `var(--vscode-*)` tokens for all colors so the UI adapts to any VS Code theme
- Avoid hardcoded hex colors except for semantic states (error red, success green)

---

## Submitting a Pull Request

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/my-feature
   # or
   git checkout -b fix/bug-description
   ```

2. **Make your changes** following the coding standards above

3. **Build and verify** there are no TypeScript errors:
   ```bash
   npm run build
   ```

4. **Test manually** using the Extension Development Host (`F5`)

5. **Commit** with a clear message:
   ```bash
   git commit -m "feat: add @filename mention support in prompt"
   # or
   git commit -m "fix: handle empty model list gracefully"
   ```
   We loosely follow [Conventional Commits](https://www.conventionalcommits.org/):
   `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`

6. **Push** your branch:
   ```bash
   git push origin feature/my-feature
   ```

7. **Open a Pull Request** on GitHub with:
   - A clear title
   - Description of what changed and why
   - Any relevant issue numbers (`Closes #42`)
   - Notes on how to test the change

### PR checklist

- [ ] `npm run build` passes with zero errors
- [ ] Tested manually in the Extension Development Host
- [ ] New settings added to `package.json` `contributes.configuration`
- [ ] New tools documented in README Agent Tools table
- [ ] No hardcoded colors (use `var(--vscode-*)`)
- [ ] No `onclick` attributes in HTML/JS (use `addEventListener`)

---

## Reporting Bugs

When opening a bug report, please include:

1. **Extension version** — visible in VS Code Extensions panel
2. **VS Code version** — `Help → About`
3. **OS and version** — macOS 14, Ubuntu 22.04, Windows 11, etc.
4. **Ollama version** — `ollama --version`
5. **Model name** — e.g. `llama2`, `qwen2.5-coder:7b`
6. **Steps to reproduce** — exact steps, ideally minimal
7. **Expected behavior** — what should happen
8. **Actual behavior** — what actually happens
9. **Output channel logs** — `View → Output → Ollama Agent` — paste the relevant lines

---

## Suggesting Features

When suggesting a feature, please describe:

1. **The problem** — what frustrates you or what you can't do today
2. **Your proposed solution** — how you'd like it to work
3. **Alternatives considered** — other approaches you thought about
4. **Who benefits** — is this specific to your workflow, or broadly useful?

---

## Adding New Tools

The agent's capabilities are driven by the tool system in `src/agent.ts`. Here's how to add a new tool:

### Step 1 — Add the definition

In `TOOL_DEFINITIONS` (array in `src/agent.ts`):

```typescript
{
    type: 'function',
    function: {
        name: 'my_new_tool',
        description: 'Clear description of what this tool does and when to use it.',
        parameters: {
            type: 'object',
            properties: {
                param1: { type: 'string', description: 'What this parameter means' },
            },
            required: ['param1'],
        },
    },
},
```

### Step 2 — Add the executor

In `Agent.executeTool()` (`switch` statement):

```typescript
case 'my_new_tool': {
    const param1 = String(args.param1 ?? '');
    if (!param1) { throw new Error('param1 is required'); }
    // ... implementation ...
    return 'Result string that the model will read';
}
```

### Step 3 — Add the icon

In `webview/webview.js`, `TOOL_ICONS` object:

```javascript
const TOOL_ICONS = {
    // ...existing...
    my_new_tool: '🔧',
};
```

### Step 4 — Update text-mode instructions

In `TEXT_MODE_TOOL_INSTRUCTIONS` (string in `src/agent.ts`), add a line:

```
  my_new_tool(param1)  — brief description
```

### Step 5 — Update README

Add the tool to the Agent Tools table in `README.md`.

---

## Questions?

Open a [GitHub Discussion](https://github.com/kchikech/Ollama_Agent/discussions) or a GitHub Issue with the `question` label.

Thank you for contributing! 🙏
