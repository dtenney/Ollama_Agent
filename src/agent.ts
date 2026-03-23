import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, execSync } from 'child_process';

import { streamChatRequest, OllamaMessage, OllamaToolCall, StreamResult, ToolsNotSupportedError } from './ollamaClient';
import { getConfig } from './config';
import { logInfo, logError, logWarn, toErrorMessage } from './logger';
import { buildWorkspaceSummary, clearWorkspaceSummaryCache, SKIP_DIRS, detectPythonEnvironment, formatPythonEnvironment, PythonEnvironment } from './workspace';
import { TieredMemoryManager } from './memoryCore';
import { isMCPTool, parseMCPToolName, callMCPTool, mcpToolsToOllamaFormat } from './mcpClient';
import { calculateContextStats, compactHistory, ContextLevel, resolveModelContextLimit } from './contextCalculator';
import { DiffViewManager } from './diffView';
import { CodeIndexer } from './codeIndex';
import { MultiFileRefactoringManager, RefactoringPlan } from './multiFileRefactor';
import { analyzeFile, executeSplit } from './fileSplitter';
import { findSimilarInDirectory, findFilesLike, formatSimilarityReport } from './similarityAnalyzer';
import { GARBAGE_PATTERNS } from './docScanner';
import type { ChildProcess } from 'child_process';

// ── Shell environment detection ───────────────────────────────────────────────

export interface ShellEnvironment {
    os: 'windows' | 'macos' | 'linux';
    shell: string;           // e.g. 'powershell', 'cmd', 'bash', 'zsh'
    /** Short label for prompts, e.g. "Windows (PowerShell)" */
    label: string;
    /** Find files by name */
    findCmd: string;
    /** Search text in files */
    grepCmd: string;
    /** List directory tree */
    treeCmd: string;
    /** Create directories */
    mkdirCmd: string;
    /** Move/rename files */
    moveCmd: string;
    /** View file contents */
    catCmd: string;
}

let _cachedShellEnv: ShellEnvironment | null = null;

/**
 * Strip PowerShell Select-String -Context output prefixes so the model
 * sees exact file content suitable for use in edit_file old_string.
 * - Match lines are prefixed with "> " → strip 2 chars
 * - Context lines get 2 extra spaces prepended by Select-String → strip 2 chars
 * - Blank lines have no prefix → leave as-is
 */
function stripSelectStringPrefixes(text: string): string {
    return text.split('\n').map(line => {
        if (line.startsWith('> ')) { return line.slice(2); }   // match line
        if (line.length >= 2 && line[0] === ' ' && line[1] === ' ') { return line.slice(2); } // context line
        return line; // blank or separator line
    }).join('\n');
}

export function detectShellEnvironment(): ShellEnvironment {
    if (_cachedShellEnv) { return _cachedShellEnv; }

    const platform = process.platform;
    const isWin = platform === 'win32';
    const isMac = platform === 'darwin';

    let shell = '';
    if (isWin) {
        // Check if PowerShell is available (preferred on Windows)
        try {
            execSync('powershell -Command "echo ok"', { stdio: 'pipe', timeout: 3000 });
            shell = 'powershell';
        } catch {
            shell = 'cmd';
        }
    } else {
        // Unix: check SHELL env var, fall back to detection
        const envShell = process.env.SHELL || '';
        if (envShell.includes('zsh')) { shell = 'zsh'; }
        else if (envShell.includes('fish')) { shell = 'fish'; }
        else { shell = 'bash'; }
    }

    const osName: ShellEnvironment['os'] = isWin ? 'windows' : isMac ? 'macos' : 'linux';

    if (isWin) {
        _cachedShellEnv = {
            os: 'windows',
            shell,
            label: `Windows (${shell === 'powershell' ? 'PowerShell' : 'cmd'})`,
            findCmd: 'dir /s /b *pattern*',
            grepCmd: 'findstr /S /N /I "text" *.py',
            treeCmd: 'tree /F folder',
            mkdirCmd: 'mkdir folder1 && mkdir folder2',
            moveCmd: 'move old\\path new\\path',
            catCmd: 'type file.txt',
        };
    } else {
        _cachedShellEnv = {
            os: osName,
            shell,
            label: `${isMac ? 'macOS' : 'Linux'} (${shell})`,
            findCmd: "find . -name '*pattern*' -not -path '*__pycache__*'",
            grepCmd: "grep -rn 'text' --include='*.py' .",
            treeCmd: 'find folder -type f | head -50',
            mkdirCmd: 'mkdir -p folder1 folder2',
            moveCmd: 'mv old/path new/path',
            catCmd: 'cat file.txt',
        };
    }

    logInfo(`[shell-env] Detected: ${_cachedShellEnv.label} (shell=${shell}, os=${osName})`);
    return _cachedShellEnv;
}

/** Build shell-first examples tailored to the detected OS/shell */
function buildShellExamples(env: ShellEnvironment, workspaceRoot?: string): string {
    const ws = workspaceRoot ? workspaceRoot.replace(/\\/g, '/') : '.';
    if (env.os === 'windows') {
        return `Your PRIMARY tools are shell_read and run_command. The host is **${env.label}**. Workspace: ${ws}
Use Windows-native PowerShell commands — NOT Unix commands (find, grep, cat, mv, mkdir -p are NOT available):
- Finding files: shell_read with "Get-ChildItem -Path '${ws}' -Recurse -Filter '*transaction*' | Select-Object FullName"
- Searching code: shell_read with "Get-ChildItem -Path '${ws}' -Recurse -Include *.py | Select-String 'def fetch_user'"
- Listing directories: shell_read with "Get-ChildItem '${ws}/app' -Recurse | Select-Object Name,DirectoryName"
- Viewing files: shell_read with "Get-Content 'C:/full/path/to/file.py'"
- Git operations: shell_read with "git status", "git log --oneline -20", "git diff"
ALWAYS use full paths from search results — never guess relative paths.`;
    } else {
        return `Your PRIMARY tools are shell_read and run_command. The host is **${env.label}**. Workspace: ${ws}
Use shell commands like a developer:
- Finding files: shell_read with "find '${ws}' -name '*transaction*' -not -path '*__pycache__*'"
- Searching code: shell_read with "grep -rn 'def fetch_user' --include='*.py' '${ws}'"
- Listing directories: shell_read with "find '${ws}/app' -type f -name '*.py' | head -50"
- Viewing files: shell_read with "cat '/full/path/to/file.py'"
- Git operations: shell_read with "git status", "git log --oneline -20", "git diff"
ALWAYS use full paths from search results — never guess relative paths.`;
    }
}

/** Build shell-first examples for text-mode instructions */
function buildTextModeShellExamples(env: ShellEnvironment, workspaceRoot?: string): string {
    const ws = workspaceRoot ? workspaceRoot.replace(/\\/g, '/') : '.';
    if (env.os === 'windows') {
        return `CRITICAL — Shell-First Approach:
The host is **${env.label}**. Workspace root: ${ws}
Use PowerShell commands for ALL file operations. Do NOT use Unix commands (find, grep, cat, mv, mkdir -p).

EXAMPLE - User says "find the payment service code":
<tool>{"name": "shell_read", "arguments": {"command": "Get-ChildItem -Path '${ws}' -Recurse -Filter '*payment*' | Select-Object FullName"}}</tool>

EXAMPLE - User says "search for where process_payment is defined":
<tool>{"name": "shell_read", "arguments": {"command": "Get-ChildItem -Path '${ws}' -Recurse -Include *.py | Select-String 'def process_payment'"}}</tool>

EXAMPLE - User says "read the checkout service":
Step 1 — find the file:
<tool>{"name": "shell_read", "arguments": {"command": "Get-ChildItem -Path '${ws}' -Recurse -Filter '*checkout_service*' | Select-Object FullName"}}</tool>
Step 2 — read it (use the EXACT path from step 1 result):
<tool>{"name": "shell_read", "arguments": {"command": "Get-Content 'C:\\path\\to\\checkout_service.py'"}}</tool>

EXAMPLE - User says "show me the files under app/routes":
<tool>{"name": "shell_read", "arguments": {"command": "Get-ChildItem '${ws}/app/routes' -Recurse | Select-Object Name,DirectoryName"}}</tool>

EXAMPLE - User says "create the admin directory and move admin.py into it":
<tool>{"name": "run_command", "arguments": {"command": "New-Item -ItemType Directory -Path '${ws}/app/routes/admin' -Force; Move-Item '${ws}/app/routes/admin.py' '${ws}/app/routes/admin/'"}}</tool>

CRITICAL: When file search returns a path, READ the full path in the next call. Do NOT guess paths.`;
    } else {
        return `CRITICAL — Shell-First Approach:
The host is **${env.label}**. Workspace root: ${ws}
Use shell commands for ALL file operations.

EXAMPLE - User says "find the payment service code":
<tool>{"name": "shell_read", "arguments": {"command": "find '${ws}' -type f -name '*payment*' -not -path '*__pycache__*'"}}</tool>

EXAMPLE - User says "search for where process_payment is defined":
<tool>{"name": "shell_read", "arguments": {"command": "grep -rn 'def process_payment' --include='*.py' '${ws}'"}}</tool>

EXAMPLE - User says "read the checkout service":
Step 1 — find the file:
<tool>{"name": "shell_read", "arguments": {"command": "find '${ws}' -name '*checkout_service*' -not -path '*__pycache__*'"}}</tool>
Step 2 — read it (use the EXACT path from step 1 result):
<tool>{"name": "shell_read", "arguments": {"command": "cat '/exact/path/from/step1/checkout_service.py'"}}</tool>

EXAMPLE - User says "show me the files under app/routes":
<tool>{"name": "shell_read", "arguments": {"command": "find '${ws}/app/routes' -type f -name '*.py' | sort"}}</tool>

CRITICAL: When file search returns a path, READ the full path in the next call. Do NOT guess paths.`;
    }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'workspace_summary',
            description: 'Get a full summary of the workspace: file tree, project type, key files (package.json, README), and recently modified files. Call this first to understand the project.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Make a targeted edit to an existing file by replacing old_string with new_string. Use shell_read with grep/cat to get the exact current content first. The old_string must match exactly (including whitespace/indentation).',
            parameters: {
                type: 'object',
                properties: {
                    path:       { type: 'string', description: 'Path relative to workspace root' },
                    old_string: { type: 'string', description: 'Exact string to replace. Must be unique in the file.' },
                    new_string: { type: 'string', description: 'Replacement string.' },
                },
                required: ['path', 'old_string', 'new_string'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file_at_line',
            description: 'Edit a file by line numbers. Use when file content with line numbers has been provided. Replaces lines start_line through end_line (inclusive, 1-based) with new_content. To insert without replacing, set end_line = start_line - 1. Never reproduce old content — just specify the line range.',
            parameters: {
                type: 'object',
                properties: {
                    path:        { type: 'string',  description: 'Path relative to workspace root' },
                    start_line:  { type: 'number',  description: 'First line to replace (1-based)' },
                    end_line:    { type: 'number',  description: 'Last line to replace (1-based, inclusive). Set to start_line - 1 to insert without replacing.' },
                    new_content: { type: 'string',  description: 'Replacement text. Preserve indentation style of surrounding code.' },
                },
                required: ['path', 'start_line', 'end_line', 'new_content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'shell_read',
            description: 'Run a read-only shell command that does NOT modify files or state. No confirmation required. Use for: git log, git status, git diff, ls, tree, cat, head, tail, wc, find, grep, env, which, node -v, python --version, etc. Do NOT use for commands that write, install, build, or delete.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Read-only shell command to execute' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Run a shell command that may MODIFY files or state. Requires user confirmation. Use for: running tests, linting, installing dependencies, building, running scripts, npm/pip install, make, etc. For read-only commands (git log, ls, cat, etc.) prefer shell_read instead.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_list',
            description: 'List all saved project memory notes for this workspace. ALWAYS call this tool when user asks "what do you know", "what have you learned", or asks about project knowledge — do not answer from conversation history alone.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_write',
            description: 'Save a note to persistent project memory. Use this to store important facts, architectural decisions, known issues, or any context that should persist across conversations.',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'Note content to save (max 4000 chars)' },
                    tag:     { type: 'string', description: 'Optional tag, e.g. "architecture", "bug", "todo", "decision"' },
                },
                required: ['content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_delete',
            description: 'Delete a saved project memory note by its id. IMPORTANT: You MUST call memory_list FIRST to get the actual entry IDs — do not guess or fabricate IDs.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Note id from memory_list output' },
                },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_search',
            description: 'Search past memories using semantic similarity. Use this to find relevant past solutions, decisions, or context without loading all memories.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to search for (e.g., "NFS mount fix", "database connection issue")' },
                    tier: { type: 'number', description: 'Optional: limit search to specific tier (4=references, 5=archive)' },
                    limit: { type: 'number', description: 'Maximum results to return (default: 5)' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_tier_write',
            description: 'Save ONE atomic piece of information to a specific memory tier. When user provides multiple pieces of information, call this tool MULTIPLE TIMES (once per concept). Use appropriate tier: 0=critical (IPs, URLs, ports, paths, credentials), 1=essential (frameworks, tools, deployment processes, hosting), 2=operational (current work, bugs), 3=collaboration (conventions, workflows), 4=references (past solutions).',
            parameters: {
                type: 'object',
                properties: {
                    tier: { type: 'number', description: 'Memory tier (0-5)', enum: [0, 1, 2, 3, 4, 5] },
                    content: { type: 'string', description: 'ONE focused piece of information to remember (max 4000 chars). Keep it atomic - one concept per entry.' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization (e.g., ["server", "infrastructure"])' },
                },
                required: ['tier', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_tier_list',
            description: 'List memories from specific tiers. ALWAYS call this tool when user asks to see specific tier memories — do not answer from conversation history alone. Use to view only relevant tier(s) instead of all memories.',
            parameters: {
                type: 'object',
                properties: {
                    tiers: { type: 'array', items: { type: 'number' }, description: 'Tier numbers to list (e.g., [0, 1] for critical + essential)' },
                },
                required: ['tiers'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'memory_stats',
            description: 'Get memory statistics showing entry count and token usage per tier.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_terminal',
            description: 'Read recent output from VS Code integrated terminals. Use this when the user mentions terminal output, errors in their terminal, or when you need to see what a previously-run command produced.',
            parameters: {
                type: 'object',
                properties: {
                    index: { type: 'number', description: 'Terminal index (0-based). Omit to read the active terminal.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_diagnostics',
            description: 'Get VS Code diagnostics (errors, warnings) for a file or the entire workspace. Use this after editing files to check if your changes introduced any problems, or when the user mentions errors in their code.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to workspace root. Omit to get diagnostics for all open files.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'refactor_multi_file',
            description: 'Propose coordinated changes across multiple files. Use this when a refactoring affects multiple files (e.g., renaming a function used in many places, restructuring modules). Shows a preview of all changes before applying.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Short title for the refactoring (e.g., "Rename getUserData to fetchUserData")' },
                    description: { type: 'string', description: 'Explanation of what changes are being made and why' },
                    changes: {
                        type: 'array',
                        description: 'Array of file changes',
                        items: {
                            type: 'object',
                            properties: {
                                path: { type: 'string', description: 'File path relative to workspace root' },
                                old_content: { type: 'string', description: 'Current file content (must match exactly)' },
                                new_content: { type: 'string', description: 'New file content after refactoring' },
                                description: { type: 'string', description: 'Optional: what changed in this file' },
                            },
                            required: ['path', 'old_content', 'new_content'],
                        },
                    },
                },
                required: ['title', 'description', 'changes'],
            },
        },
    },
];

function buildProjectTypeGuidance(workspaceRoot: string): string {
    // Use cached result from detectPythonEnvironment (populated during workspace_summary)
    // This is a sync wrapper that returns empty string if no cached result yet
    return _cachedProjectGuidance ?? '';
}

/** Cached project type guidance string, populated by async buildProjectTypeGuidanceAsync */
let _cachedProjectGuidance: string | null = null;

async function buildProjectTypeGuidanceAsync(workspaceRoot: string): Promise<string> {
    const pyEnv = await detectPythonEnvironment(workspaceRoot);
    if (!pyEnv) {
        _cachedProjectGuidance = '';
        return '';
    }

    const lines: string[] = ['\n## Python Project Environment', 'This is a Python project. Use run_command for these tasks:'];

    // Test command
    if (pyEnv.testFramework === 'pytest') {
        lines.push('- Run tests: `python -m pytest -v` (or `pytest -v`)');
    } else {
        lines.push('- Run tests: `python -m unittest discover`');
    }

    // Lint command
    if (pyEnv.linter) {
        const cmd = pyEnv.linter === 'ruff' ? 'ruff check .' : pyEnv.linter === 'flake8' ? 'flake8 .' : 'pylint .';
        lines.push(`- Lint code: \`${cmd}\``);
    }

    // Type checker
    if (pyEnv.typeChecker) {
        lines.push(`- Type check: \`${pyEnv.typeChecker} .\``);
    }

    // Formatter
    if (pyEnv.formatter) {
        lines.push(`- Format code: \`${pyEnv.formatter} .\``);
    }

    // Install deps
    const installCmd = {
        pip: 'pip install -r requirements.txt',
        poetry: 'poetry install',
        pipenv: 'pipenv install',
        uv: 'uv sync',
    }[pyEnv.packageManager] ?? 'pip install -r requirements.txt';
    lines.push(`- Install deps: \`${installCmd}\``);
    lines.push('- Run scripts: `python <script.py>`');
    lines.push('- Check syntax: `python -m py_compile <file.py>`');

    // Detected tools summary
    const tools: string[] = [pyEnv.packageManager];
    if (pyEnv.linter) { tools.push(pyEnv.linter); }
    if (pyEnv.typeChecker) { tools.push(pyEnv.typeChecker); }
    if (pyEnv.testFramework) { tools.push(pyEnv.testFramework); }
    if (pyEnv.formatter && pyEnv.formatter !== pyEnv.linter) { tools.push(pyEnv.formatter); }
    lines.push(`\nDetected tools: ${tools.join(', ')}`);
    if (pyEnv.venvPath) { lines.push(`Virtual env: ${pyEnv.venvPath}`); }

    _cachedProjectGuidance = lines.join('\n');
    return _cachedProjectGuidance;
}

async function buildSystemPromptAsync(autoSaveMemory: boolean, workspaceRoot?: string): Promise<string> {
    const guidance = workspaceRoot ? await buildProjectTypeGuidanceAsync(workspaceRoot) : '';
    return buildSystemPrompt(autoSaveMemory, workspaceRoot, guidance);
}

function buildSystemPrompt(autoSaveMemory: boolean, workspaceRoot?: string, projectGuidance?: string): string {
    // Inject current date/time and active file language for context awareness (Rec 2.3)
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const activeEditor = vscode.window.activeTextEditor;
    const activeLanguage = activeEditor?.document.languageId ?? '';
    const activeFile = activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri) : '';

    const memoryGuidelines = `- Use memory_tier_write to save information to the appropriate tier:
  * Tier 0: Critical infrastructure (IPs, paths, keys, credentials, URLs)
  * Tier 1: Essential capabilities (languages, frameworks, tools, deployment processes)
  * Tier 2: Operational context (current tasks, recent decisions, active bugs)
  * Tier 3: Collaboration (team conventions, standards, workflows)
  * Tier 4: References (past solutions, learned patterns, troubleshooting guides)
- When user provides MULTIPLE pieces of information, break them into SEPARATE memory entries by tier
- Each memory entry should be focused and atomic (one concept per entry)`;

    const autoSaveBlock = autoSaveMemory
        ? `
## CRITICAL: Auto-Save Memory Protocol
You MUST proactively save information to memory. After EVERY response, ask yourself:
"Did I learn anything new about this project that isn't already in my memory?"

Save immediately when you encounter ANY of these:
- IP addresses, URLs, ports, hostnames, file paths → Tier 0
- Frameworks, languages, libraries, tools, package managers → Tier 1
- Current tasks, bugs, errors, decisions made in this conversation → Tier 2
- Coding conventions, naming patterns, team preferences → Tier 3
- Solutions to problems, workarounds, debugging steps → Tier 4

Examples of when to auto-save:
- User says "the server is at 192.168.1.50" → save to Tier 0 immediately
- You discover the project uses TypeScript + Express → save each to Tier 1
- User mentions "we always use camelCase" → save to Tier 3
- You fix a tricky bug → save the solution to Tier 4
- User mentions a file path like /etc/nginx/conf.d → save to Tier 0
- You read package.json and see dependencies → save key frameworks to Tier 1

Rules:
- NEVER announce saves — just call memory_tier_write silently
- Do NOT duplicate information already in your loaded memory
- Break multi-part info into separate atomic entries
`
        : '';

    const workspaceInfo = workspaceRoot ? `Workspace: ${workspaceRoot}` : '';
    return `You are an expert AI coding assistant integrated into VS Code.
Current date: ${dateStr}, ${timeStr}.${activeLanguage ? ` Active file: ${activeFile} (${activeLanguage}).` : ''}${workspaceInfo ? `\n${workspaceInfo}` : ''}

CRITICAL — You are operating INSIDE A REAL PROJECT. When the user asks ANY question about code, features, or how something works, you MUST search the actual project files to answer — do NOT answer from general knowledge or training data.
- "show me how X works" → shell_read with grep to find X in the project, then cat the file
- "where is X configured" → shell_read with grep/find to locate it in the project
- "explain how X works" → shell_read with grep to find X, cat the relevant file, explain THAT code
- NEVER answer with generic NFC / payment / hardware explanations — find the ACTUAL code
${autoSaveBlock}
You have access to the following tools:

  workspace_summary  — understand the project structure (call this first on a new project)
  edit_file          — targeted code edit: replace old_string with new_string (use shell_read/grep to get exact strings first)
  shell_read         — ANY read-only shell command, NO confirmation: cat, grep, find, ls, git log/status/diff, head, tail, wc, etc.
  run_command        — shell commands that MODIFY state, requires confirmation: mv, cp, rm, mkdir, npm/pip install, tests, builds
  memory_list        — recall saved facts/decisions about this project
  memory_write       — persist important facts, decisions, or context across sessions
  memory_delete      — remove a stale memory note
  memory_search      — search past memories using semantic similarity
  memory_tier_write  — save to specific tier (0=critical, 1=essential, 2=operational, 3=collaboration, 4=references)
  memory_tier_list   — list memories from specific tiers
  memory_stats       — get memory statistics (entry count and tokens per tier)
  read_terminal      — read recent output from VS Code integrated terminals
  get_diagnostics    — get VS Code errors/warnings for a file or workspace

## Shell-First — Use These Patterns

${buildShellExamples(detectShellEnvironment(), workspaceRoot)}

Guidelines:
- ALWAYS CALL TOOLS DIRECTLY — never explain what tool to call, just call it immediately
- Use shell_read for ALL reading: cat file.py, grep -n pattern file.py, find . -name '*.py', ls dir/, git diff
- Use run_command for ALL writes/moves/deletes: mv, cp, rm, mkdir, touch, pip install, npm install, tests, builds
- Use edit_file ONLY for precise string replacements in source files (grep for exact strings first)
- CRITICAL: When user asks about errors or diagnostics, call get_diagnostics FIRST — do NOT run external linters unless asked
- After editing files, call get_diagnostics to check for new errors
- Prefer shell_read for ANY read-only operation — no confirmation required
- Your persistent memory is automatically loaded (Tiers 0-2) and shown above.
${memoryGuidelines}
- CRITICAL: When user asks "what do you know about this project", call memory_list — do not answer from conversation alone
- CRITICAL: When user asks "explain what this project does", call workspace_summary FIRST — memory alone is not enough
- CRITICAL: Before calling memory_delete, ALWAYS call memory_list first to get real IDs — never guess IDs
- Be concise and accurate. Format all code with markdown fenced code blocks.

CRITICAL — Action-Oriented Responses:
- NEVER ask "Would you like me to proceed?" — if the user asked you to DO something, DO IT immediately. Confirmation dialogs handle safety.
- When asked to review/fix/improve code: use shell_read to read the actual files first, then edit_file on the real code you found
- NEVER generate hypothetical examples or placeholder code — act on the user's ACTUAL code
- When you find an issue, fix it with edit_file immediately. Do not just describe the fix.

CRITICAL — Discover Before Acting:
- Before moving/renaming/reorganizing files, use shell_read to list the directory first — verify real filenames
- NEVER create placeholder files when moving fails — find the real files with shell_read instead
${projectGuidance ?? (workspaceRoot ? buildProjectTypeGuidance(workspaceRoot) : '')}`;
}

// ── Small-model tool set (read-then-act mode) ─────────────────────────────────

/**
 * Restricted tool set for small models (≤9B params).
 * When file context is pre-injected, small models only need edit_file and run_command.
 * Removing shell_read prevents them from looping on directory discovery.
 */
export const SMALL_MODEL_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(t =>
    ['edit_file', 'edit_file_at_line', 'run_command'].includes(t.function.name)
);

/**
 * Minimal system prompt for small models.
 * No shell-first examples — context is pre-injected by preProcessEditTask().
 */
function buildSmallModelSystemPrompt(workspaceRoot?: string): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri) : '';
    const workspaceInfo = workspaceRoot ? `Workspace: ${workspaceRoot}` : '';
    return `You are a precise code editing assistant inside VS Code.
Current date: ${dateStr}.${activeFile ? ` Active file: ${activeFile}.` : ''}${workspaceInfo ? `\n${workspaceInfo}` : ''}

You have three tools: edit_file_at_line, edit_file, and run_command.

## Your task
The file(s) you need to edit are in the [PRE-LOADED CONTEXT] section, shown with line numbers like:
  "  42: code here"
The number before the colon is the line number. Use it with edit_file_at_line.

## How to use edit_file_at_line (preferred)
1. Find the lines to change in [PRE-LOADED CONTEXT]
2. Note their line numbers
3. Call edit_file_at_line with:
   - path: the file path shown
   - start_line: first line to replace (the number shown)
   - end_line: last line to replace (inclusive). Use end_line = start_line - 1 to insert without replacing.
   - new_content: your replacement (match surrounding indentation)

## Rules
- PREFER edit_file_at_line over edit_file — it is more reliable
- Do NOT call shell_read — the file content is already provided
- Do NOT describe what you will do — call the tool immediately
- If the change is already present, say so and stop`;
}

// ── Text-mode tool calling (fallback for models without native tool support) ──

/**
 * Build text-mode tool instructions with optional auto-save guidance.
 * Appended to the system prompt when the model doesn't support native tools.
 */
function buildTextModeInstructions(autoSaveMemory: boolean, workspaceRoot?: string): string {
    const autoSaveGuidance = autoSaveMemory
        ? `

AUTO-SAVE MEMORY PROTOCOL:
When user provides complex information, BREAK IT DOWN into atomic entries:

1. IDENTIFY all distinct pieces of information
2. CLASSIFY each piece by tier:
   - Tier 0: IPs, URLs, ports, paths, credentials, server addresses
   - Tier 1: Frameworks, languages, tools, deployment scripts, hosting info
   - Tier 2: Current tasks, bugs, recent decisions
   - Tier 3: Team conventions, workflows, standards
   - Tier 4: Past solutions, troubleshooting guides
3. CALL memory_tier_write ONCE for EACH distinct piece
4. DO NOT combine multiple concepts into one entry
5. DO NOT output text about saving - JUST CALL THE TOOLS

EXAMPLE - User says "Add to memory: Dev server is 192.168.1.100, prod is 192.168.1.200, we use Flask, deploy with deploy.sh":
CORRECT approach:
<tool>{"name": "memory_tier_write", "tier": 0, "content": "Development server: 192.168.1.100", "tags": ["server", "infrastructure"]}</tool>
[wait for result]
<tool>{"name": "memory_tier_write", "tier": 0, "content": "Production server: 192.168.1.200", "tags": ["server", "infrastructure"]}</tool>
[wait for result]
<tool>{"name": "memory_tier_write", "tier": 1, "content": "Framework: Flask", "tags": ["framework"]}</tool>
[wait for result]
<tool>{"name": "memory_tier_write", "tier": 1, "content": "Deployment: deploy.sh script", "tags": ["deployment"]}</tool>

WRONG approach:
<tool>{"name": "memory_tier_write", "tier": 1, "content": "Dev server is 192.168.1.100, prod is 192.168.1.200, we use Flask, deploy with deploy.sh"}</tool>
(This combines multiple tiers and concepts into one entry)`
        : '';

    return `

=== TOOL USAGE ===
You MUST call workspace tools by outputting a tool call block in EXACTLY this format:

<tool>{"name": "TOOL_NAME", "arguments": {JSON_ARGS}}</tool>

*** MOST IMPORTANT RULES — READ THESE FIRST ***
- ALWAYS ACT, NEVER ASK. If the user says "do X", call the tool immediately. NEVER say "Would you like me to proceed?" or "Shall I continue?"
- Output ONE <tool> block per response. Do NOT plan ahead — after the tool runs, you will be called again to decide the next step.
- Do NOT output numbered plans, step lists, or code blocks showing commands. Just output the <tool> block.
- When user mentions a file path, use shell_read with cat/Get-Content to read it. Do NOT call list_files or read_file.
- When user says "yes", "go ahead", "do it", "sure", "proceed" — output a <tool> block for the next action IMMEDIATELY.

CRITICAL — TOOL FORMAT:
WRONG (backtick/code block — this does NOT call the tool):
\`\`\`shell
grep -rn "epson" .
\`\`\`
CORRECT (raw XML — this actually calls the tool):
<tool>{"name": "shell_read", "arguments": {"command": "grep -rn 'epson' ."}}</tool>

Backtick code blocks are NEVER executed. Only raw <tool>...</tool> XML blocks are executed.
*** END MOST IMPORTANT RULES ***

CRITICAL RULES:
- When user says "Add to memory:" or "Save to memory:" → IMMEDIATELY call memory_tier_write with the appropriate tier
- When user provides MULTIPLE pieces of information → call memory_tier_write MULTIPLE TIMES (once per concept)
- NEVER say "Saved to memory" or "I will save" - ACTUALLY CALL THE TOOL
- DO NOT explain what tool to call - JUST CALL IT by outputting the <tool> block
- DO NOT use markdown code blocks - use <tool> tags directly
- DO NOT say "you can call" or "here is how" - ACTUALLY CALL THE TOOL
- DO NOT call memory_list when user asks to ADD/SAVE - call memory_tier_write instead
- DO NOT combine multiple concepts into one memory entry - break them apart by tier
- Output the <tool>...</tool> block directly in your response
- CRITICAL: Output ONE <tool> block per response. After the tool runs, you will be called again and can decide the next step then.
- CRITICAL: Do NOT output a numbered plan with empty code blocks. Just output the <tool> block for the first action.
- After receiving [TOOL RESULT: ...], PRESENT THE RESULT TO THE USER unless you genuinely need more information to answer their question
- Do NOT chain extra tool calls after getting a successful result — the user wants to see the answer, not watch you call more tools
- Only call another tool if the user's question CANNOT be answered with the result you already have
- Do NOT call memory_tier_write or memory_write after answering a question — only save to memory when the USER explicitly asks you to remember something or when auto-save is enabled
- When user mentions a specific file path (e.g., "look at docs/file.md"), use shell_read with cat to read it — do NOT list the directory${autoSaveGuidance}

EXAMPLE - User says "Save to memory tier 0: test":
WRONG: "Saved to memory tier 0: test"
WRONG: "I will save that to memory"
CORRECT: <tool>{"name": "memory_tier_write", "arguments": {"tier": 0, "content": "test"}}</tool>

EXAMPLE - User says "Add to memory: server is at 192.168.1.100":
WRONG: Calling memory_list to show existing memory
WRONG: "I'll add that to memory"
CORRECT: <tool>{"name": "memory_tier_write", "tier": 0, "content": "Server IP: 192.168.1.100", "tags": ["server"]}</tool>

EXAMPLE - User says "Add to memory: We use PostgreSQL on port 5432 and deploy with deploy.sh":
WRONG: <tool>{"name": "memory_tier_write", "tier": 1, "content": "We use PostgreSQL on port 5432 and deploy with deploy.sh"}</tool>
CORRECT (call THREE times):
<tool>{"name": "memory_tier_write", "tier": 1, "content": "Database: PostgreSQL", "tags": ["database"]}</tool>
[wait for result]
<tool>{"name": "memory_tier_write", "tier": 0, "content": "PostgreSQL port: 5432", "tags": ["database", "port"]}</tool>
[wait for result]
<tool>{"name": "memory_tier_write", "tier": 1, "content": "Deployment script: deploy.sh", "tags": ["deployment"]}</tool>

EXAMPLE - User asks "find README":
WRONG: "You can call shell_read with command grep README"
WRONG: Showing JSON in a code block
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "find . -name 'README*' -not -path '*/node_modules/*'"}}</tool>

EXAMPLE - User says "what do you know about this project?":
WRONG: Answering from conversation history without calling a tool
CORRECT: <tool>{"name": "memory_list", "arguments": {}}</tool>

EXAMPLE - User says "explain what this project does" or "what is this project?":
WRONG: <tool>{"name": "memory_list", "arguments": {}}</tool> (memory notes are NOT a project explanation)
CORRECT: <tool>{"name": "workspace_summary", "arguments": {}}</tool>
[then use shell_read with cat on package.json, README.md, or main entry point to give a real answer]

EXAMPLE - User says "delete the memory about the old API endpoint":
WRONG: <tool>{"name": "memory_delete", "arguments": {"id": "SOME_GUESSED_ID"}}</tool>
CORRECT (call memory_list FIRST, then delete with the real ID):
<tool>{"name": "memory_list", "arguments": {}}</tool>
[wait for result — find the actual ID]
<tool>{"name": "memory_delete", "arguments": {"id": "t0_1234567890_abc1"}}</tool>

EXAMPLE - User says "run the tests":
CORRECT: <tool>{"name": "run_command", "arguments": {"command": "python -m pytest -v"}}</tool>

EXAMPLE - User says "check for lint errors":
CORRECT: <tool>{"name": "run_command", "arguments": {"command": "ruff check ."}}</tool>

EXAMPLE - User says "find all test files":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "find . -name '*.test.ts' -not -path '*/node_modules/*'"}}</tool>

EXAMPLE - User says "what branch am I on":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "git branch --show-current"}}</tool>

EXAMPLE - User says "show me the git log":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "git log --oneline -20"}}</tool>

Available tools and their argument schemas:
  workspace_summary   — {}
  edit_file           — {"path": "path", "old_string": "exact text to replace", "new_string": "replacement"}
  shell_read          — {"command": "read-only shell command (no confirmation required)"}
  run_command         — {"command": "shell command that modifies state (requires confirmation)"}
  memory_list         — {} — call when user asks "what do you know" or about project knowledge
  memory_write        — {"content": "note text", "tag": "optional tag"}
  memory_delete       — {"id": "note id from memory_list"} — MUST call memory_list FIRST to get real IDs
  memory_search       — {"query": "search text", "tier": "optional", "limit": "optional"}
  memory_tier_write   — {"tier": 0-5, "content": "note text", "tags": ["optional"]}
  memory_tier_list    — {"tiers": [0, 1, 2]} — ALWAYS call when user asks about specific tier memories
  memory_stats        — {}
  read_terminal       — {"index": "optional terminal index"}
  get_diagnostics     — {"path": "optional relative/path"} — ALWAYS use for error/warning checks, NOT external linters

EXAMPLE - User says "are there any errors in my code?" or "check for errors":
WRONG: <tool>{"name": "run_command", "arguments": {"command": "ruff check ."}}</tool>
CORRECT: <tool>{"name": "get_diagnostics", "arguments": {}}</tool>

EXAMPLE - User says "add a log statement to the ocr service when OCR fails":
Step 1: <tool>{"name": "shell_read", "arguments": {"command": "find app -name '*ocr*' -type f"}}</tool>
[get path, then:]
Step 2: <tool>{"name": "shell_read", "arguments": {"command": "grep -n 'except\\|fail\\|error' app/services/drivers_license_ocr_service.py"}}</tool>
[get the exact lines, then:]
Step 3: <tool>{"name": "edit_file", "arguments": {"path": "app/services/drivers_license_ocr_service.py", "old_string": "    except Exception as e:\n        return None", "new_string": "    except Exception as e:\n        logger.error(f'OCR failed: {e}')\n        return None"}}</tool>

EXAMPLE - User says "add a comment to the top of src/main.ts":
Step 1: <tool>{"name": "shell_read", "arguments": {"command": "head -5 src/main.ts"}}</tool>
[get exact first line, then:]
Step 2: <tool>{"name": "edit_file", "arguments": {"path": "src/main.ts", "old_string": "import * as vscode", "new_string": "// Main entry point\nimport * as vscode"}}</tool>

EXAMPLE - User says "create a new file called utils.py with a helper function":
<tool>{"name": "run_command", "arguments": {"command": "cat > src/utils.py << 'EOF'\ndef helper():\n    return True\nEOF"}}</tool>

EXAMPLE - User says "move app/routes/admin.py to app/routes/admin/":
<tool>{"name": "run_command", "arguments": {"command": "mkdir -p app/routes/admin && mv app/routes/admin.py app/routes/admin/"}}</tool>

EXAMPLE - User says "implement the folder organization" or "do the recommendations":
Step 1: Read the recommendations document using shell_read
Step 2: Discover actual filenames: <tool>{"name": "shell_read", "arguments": {"command": "ls app/routes/"}}</tool>
Step 3: Create dirs and move all files in one command:
<tool>{"name": "run_command", "arguments": {"command": "mkdir -p app/routes/admin app/routes/cashier && mv app/routes/admin_routes.py app/routes/admin/ && mv app/routes/cashier_routes.py app/routes/cashier/"}}</tool>

EXAMPLE - User says "update imports after reorganization":
Step 1: <tool>{"name": "shell_read", "arguments": {"command": "grep -rn 'from app.routes.admin' --include='*.py' ."}}</tool>
[find affected files, then for each:]
Step 2: <tool>{"name": "shell_read", "arguments": {"command": "grep -n 'from app.routes.admin' app/main.py"}}</tool>
Step 3: <tool>{"name": "edit_file", "arguments": {"path": "app/main.py", "old_string": "from app.routes.admin import", "new_string": "from app.routes.admin.admin import"}}</tool>

EXAMPLE - User says "do it", "go ahead", "yes", "sure", or "proceed" after you showed a plan:
WRONG: Repeating the plan as code blocks
CORRECT: Call the first tool immediately

${buildTextModeShellExamples(detectShellEnvironment(), workspaceRoot)}

CRITICAL — File Modifications:
- To READ a file: shell_read with cat, head, grep, etc.
- To EDIT a file: grep for the exact string first, then edit_file with that exact string
- To CREATE a file: run_command with cat/heredoc or echo redirect, OR write inline with run_command
- To MOVE/RENAME: run_command with mv/Move-Item
- To DELETE: run_command with rm/Remove-Item
- NEVER show shell commands in code blocks — CALL THE TOOL

CRITICAL — Actions and Commands:
- When user says "do it", "go ahead", "yes", "sure", "proceed" — CALL THE TOOLS IMMEDIATELY
- NEVER ask "Would you like me to proceed?" — just call the tools
- NEVER output a numbered plan. Call ONE tool, wait for result, call next tool.
===================`;
}

/**
 * Minimal text-mode instructions for small models in read-then-act mode.
 * The file content is already injected — the model only needs to call edit_file.
 */
function buildSmallModelTextModeInstructions(): string {
    return `

=== HOW TO CALL TOOLS ===
Output a tool call using EXACTLY this format (raw XML, NOT inside backticks):

<tool>{"name": "TOOL_NAME", "arguments": {JSON_ARGS}}</tool>

You have three tools:
  edit_file_at_line — {"path": "relative/path", "start_line": N, "end_line": M, "new_content": "replacement text"}
  edit_file         — {"path": "relative/path", "old_string": "exact text", "new_string": "replacement"}
  run_command       — {"command": "shell command (requires user confirmation)"}

RULES:
- ALWAYS use edit_file_at_line when line numbers are shown in [PRE-LOADED CONTEXT]
- The line numbers shown as "  42: code" mean start_line=42
- To replace lines 45-47: start_line=45, end_line=47
- To insert after line 42 without replacing: start_line=43, end_line=42
- Do NOT call shell_read — file content is already provided
- Call the tool immediately — do NOT explain first

EXAMPLE — user says "add logging when OCR fails", context shows:
  387:     except Exception as e:
  388:         return None
CORRECT:
<tool>{"name": "edit_file_at_line", "arguments": {"path": "app/services/ocr_service.py", "start_line": 387, "end_line": 388, "new_content": "    except Exception as e:\n        self.logger.error(f'OCR failed: {e}')\n        return None"}}</tool>
===================`;
}

/**
 * Attempt to repair malformed JSON from model output.
 * Common issue: model puts raw multi-line content (e.g. Python with triple-quotes)
 * inside a JSON string value without proper escaping.
 * Strategy: extract "name" and "path" via regex, then treat everything between
 * the content field's opening quote and the closing structure as the value.
 */
function repairToolJson(raw: string): string | null {
    // Extract tool name
    const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
    if (!nameMatch) return null;
    const toolName = nameMatch[1];

    // Extract path if present
    const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/);

    // Only repair edit_file (has complex old_string/new_string fields)
    if (toolName !== 'edit_file') return null;

    if (toolName === 'edit_file') {
        // edit_file has old_string and new_string — too complex to reliably repair
        // Try: extract path, then old_string and new_string by finding the field boundaries
        const oldStrMarker = raw.indexOf('"old_string"');
        const newStrMarker = raw.indexOf('"new_string"');
        if (oldStrMarker === -1 || newStrMarker === -1 || !pathMatch) return null;

        // Find the value start (after the colon and opening quote)
        const oldValStart = raw.indexOf('"', raw.indexOf(':', oldStrMarker) + 1) + 1;
        // The old_string value ends where new_string key begins (backtrack to find closing quote + comma)
        const oldValEnd = raw.lastIndexOf('"', newStrMarker - 1);
        const newValStart = raw.indexOf('"', raw.indexOf(':', newStrMarker) + 1) + 1;
        // new_string value ends at the last }} structure
        const newValEnd = raw.lastIndexOf('"');

        if (oldValStart <= 0 || oldValEnd <= oldValStart || newValStart <= 0 || newValEnd <= newValStart) return null;

        const oldStr = raw.slice(oldValStart, oldValEnd);
        const newStr = raw.slice(newValStart, newValEnd);

        const escOld = JSON.stringify(oldStr).slice(1, -1);
        const escNew = JSON.stringify(newStr).slice(1, -1);
        return `{"name":"edit_file","arguments":{"path":"${pathMatch[1]}","old_string":"${escOld}","new_string":"${escNew}"}}`;
    }

    return null;
}

/** Parse <tool>...</tool> blocks, raw JSON, or JSON in markdown code blocks from text-mode model output. */
function parseTextToolCalls(text: string): OllamaToolCall[] {
    const calls: OllamaToolCall[] = [];
    const seenIds = new Set<string>(); // Prevent duplicates
    
    // Helper to add a parsed tool call
    const addCall = (parsed: { name?: string; arguments?: Record<string, unknown>; [key: string]: unknown }, source: string) => {
        if (!parsed.name || typeof parsed.name !== 'string') return;
        
        let args: Record<string, unknown>;
        if (parsed.arguments !== undefined) {
            args = parsed.arguments;
        } else {
            const { name, ...rest } = parsed;
            args = rest;
        }
        
        const callId = `${parsed.name}_${JSON.stringify(args)}`;
        if (!seenIds.has(callId)) {
            seenIds.add(callId);
            logInfo(`[parseTextToolCalls] Found ${source} tool call: ${parsed.name}`);
            calls.push({
                function: {
                    name: parsed.name,
                    arguments: args,
                },
            });
        }
    };
    
    // Try <tool>...</tool> format first (also handle malformed <tool>...<tool>)
    // Use bracket counting for robust JSON extraction
    let pos = 0;
    while (pos < text.length) {
        const toolStart = text.indexOf('<tool>', pos);
        if (toolStart === -1) break;
        
        const jsonStart = toolStart + 6; // Length of '<tool>'
        let jsonEnd = jsonStart;
        let braceCount = 0;
        let inString = false;
        let escapeNext = false;
        let foundJson = false;
        
        // Find matching closing brace using bracket counting
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\') {
                escapeNext = true;
                continue;
            }
            
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                    foundJson = true;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0 && foundJson) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }
        
        if (foundJson && braceCount === 0) {
            const jsonStr = text.slice(jsonStart, jsonEnd).trim();
            try {
                const parsed = JSON.parse(jsonStr);
                addCall(parsed, 'XML');
            } catch (e) {
                // Model may emit unescaped content (e.g. Python triple-quotes, raw newlines, Windows backslashes).
                // Try simple backslash-escape fix first (handles "dir /s /b services\*.py" type commands).
                let parsed: { name?: string; arguments?: Record<string, unknown> } | null = null;
                try {
                    // Replace unescaped backslashes inside string values: \ not followed by valid JSON escape char
                    const escaped = jsonStr.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
                    parsed = JSON.parse(escaped);
                    addCall(parsed!, 'XML (backslash-escaped)');
                } catch {
                    // Fall back to full repair for more complex cases
                    const repaired = repairToolJson(jsonStr);
                    if (repaired) {
                        try {
                            const reparsed = JSON.parse(repaired);
                            addCall(reparsed, 'XML (repaired)');
                        } catch {
                            logWarn(`[parseTextToolCalls] Failed to parse XML JSON (even after repair): ${jsonStr.slice(0, 100)}`);
                        }
                    } else {
                        logWarn(`[parseTextToolCalls] Failed to parse XML JSON: ${jsonStr.slice(0, 100)}`);
                    }
                }
            }
            pos = jsonEnd;
        } else {
            pos = toolStart + 6;
        }
    }
    
    // Try JSON inside markdown code blocks: ```json\n{...}\n```
    if (calls.length === 0) {
        const codeBlockRegex = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?```/gi;
        let match: RegExpExecArray | null;
        while ((match = codeBlockRegex.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(match[1]);
                addCall(parsed, 'markdown code block');
            } catch { /* not valid JSON */ }
        }
    }
    
    // Try raw JSON format: {"name": "...", "arguments": {...}} — may span multiple lines
    if (calls.length === 0) {
        // First try single-line JSON
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('{') && trimmed.includes('"name"')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    addCall(parsed, 'raw JSON (single line)');
                } catch { /* not valid JSON */ }
            }
        }
        
        // If no single-line JSON found, try to find multi-line JSON object
        if (calls.length === 0) {
            // Look for a JSON object that contains "name" field
            const jsonMatch = text.match(/\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?\}/g);
            if (jsonMatch) {
                for (const match of jsonMatch) {
                    try {
                        const parsed = JSON.parse(match);
                        addCall(parsed, 'raw JSON (multi-line)');
                    } catch { /* not valid JSON */ }
                }
            }
        }
        
        if (calls.length === 0) {
            logWarn(`[parseTextToolCalls] No tool calls found in text. First 200 chars: ${text.slice(0, 200)}`);
        }
    }
    
    // Last resort: detect bare "tool_name {json_args}" or "tool_name {"key": ...}" lines
    // This catches when the model writes e.g. `run_command {"command": "mkdir app/routes"}` as plain text
    if (calls.length === 0) {
        const KNOWN_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(t => (t as { function: { name: string } }).function.name));
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            // Match: tool_name {json...} or tool_name({json...})
            const bareMatch = trimmed.match(/^(\w+)\s*\(?\s*(\{.+\})\s*\)?$/);
            if (bareMatch) {
                const [, toolName, jsonStr] = bareMatch;
                if (KNOWN_TOOL_NAMES.has(toolName)) {
                    try {
                        const args = JSON.parse(jsonStr);
                        addCall({ name: toolName, arguments: args }, 'bare tool name');
                    } catch { /* not valid JSON */ }
                }
            }
        }
        if (calls.length > 0) {
            logInfo(`[parseTextToolCalls] Recovered ${calls.length} tool call(s) from bare tool_name format`);
        }
    }

    // Last-last resort: detect "tool_name\n```[lang]\ncommand\n```" pattern.
    // The model writes the tool name on one line, then a fenced block with a shell command.
    // e.g.:  shell_read\n```shell\ndir /s /b *thermal*\n```
    // e.g.:  find_files\n```\n*thermal*\n```
    if (calls.length === 0) {
        const KNOWN_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(t => (t as { function: { name: string } }).function.name));
        // Match: optional_text TOOL_NAME optional_text newline ``` optional_lang newline CONTENT newline ```
        const fencedCommandRegex = /\b(\w+)\b[^\n]*\n```[a-z]*\n([\s\S]*?)```/gi;
        let fm: RegExpExecArray | null;
        while ((fm = fencedCommandRegex.exec(text)) !== null) {
            const toolName = fm[1].trim();
            const commandContent = fm[2].trim();
            if (!KNOWN_TOOL_NAMES.has(toolName) || !commandContent) { continue; }

            // Map fenced content to the right argument based on tool name
            let args: Record<string, unknown>;
            if (toolName === 'shell_read' || toolName === 'run_command') {
                args = { command: commandContent };
            } else if (toolName === 'edit_file') {
                // edit_file fenced block isn't reliably parseable — skip, it needs old_string/new_string
                continue;
            } else {
                // Generic: try to parse as JSON, else use as first string arg
                try { args = JSON.parse(commandContent); }
                catch { args = { input: commandContent }; }
            }
            addCall({ name: toolName, arguments: args }, 'fenced-block tool call');
        }
        if (calls.length > 0) {
            logInfo(`[parseTextToolCalls] Recovered ${calls.length} tool call(s) from fenced-block tool_name format`);
        }
    }

    return calls;
}

/** Remove <tool>...</tool> blocks, raw JSON tool calls, and markdown code blocks with tool calls from content. */
function stripToolBlocks(text: string): string {
    let result = text;
    
    // Remove markdown code blocks containing tool calls first
    result = result.replace(/```(?:json)?\s*\n?\s*\{[\s\S]*?"name"[\s\S]*?\}\s*\n?```/gi, '');
    
    // Remove XML format using bracket counting (more robust than regex)
    let pos = 0;
    while (pos < result.length) {
        const toolStart = result.indexOf('<tool>', pos);
        if (toolStart === -1) break;
        
        const jsonStart = toolStart + 6;
        let jsonEnd = jsonStart;
        let braceCount = 0;
        let inString = false;
        let escapeNext = false;
        let foundJson = false;
        
        for (let i = jsonStart; i < result.length; i++) {
            const char = result[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\') {
                escapeNext = true;
                continue;
            }
            
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                    foundJson = true;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0 && foundJson) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }
        
        if (foundJson && braceCount === 0) {
            // Find closing </tool> tag; if not found, just remove the <tool>{...} portion
            let endPos = jsonEnd;
            const closeTag = result.indexOf('</tool>', jsonEnd);
            if (closeTag !== -1 && closeTag <= jsonEnd + 20) {
                // Only consume </tool> if it's immediately after the JSON (with optional whitespace)
                endPos = closeTag + 7;
            }
            result = result.slice(0, toolStart) + result.slice(endPos);
            pos = toolStart;
        } else {
            pos = toolStart + 6;
        }
    }
    
    // Remove raw JSON format and bare tool_name {json} format - line by line
    const lines = result.split('\n');
    const KNOWN_TOOL_NAMES_SET = new Set(TOOL_DEFINITIONS.map(t => (t as { function: { name: string } }).function.name));
    const filtered = lines.filter(line => {
        const trimmed = line.trim();
        // Remove raw JSON tool calls
        if (trimmed.startsWith('{') && trimmed.includes('"name"')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed.name && typeof parsed.name === 'string') {
                    const hasArguments = 'arguments' in parsed;
                    const hasOtherFields = Object.keys(parsed).filter(k => k !== 'name').length > 0;
                    if (hasArguments || hasOtherFields) {
                        return false;
                    }
                }
            } catch { /* not valid JSON, keep the line */ }
        }
        // Remove bare tool_name {json} lines
        const bareMatch = trimmed.match(/^(\w+)\s*\(?\s*(\{.+\})\s*\)?$/);
        if (bareMatch && KNOWN_TOOL_NAMES_SET.has(bareMatch[1])) {
            try {
                JSON.parse(bareMatch[2]);
                return false; // Valid tool call — strip it
            } catch { /* not valid JSON, keep */ }
        }
        return true;
    });
    
    return filtered.join('\n').replace(/\n{2,}/g, '\n').trim();
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export type PostFn = (msg: object) => void;

export class Agent {
    private history: OllamaMessage[] = [];
    private stopRef: { stop: boolean; destroy?: () => void } = { stop: false };
    /** Current post function — set at the start of each run() call */
    private postFn: PostFn = () => { /* noop until run() is called */ };
    /**
     * 'native' — use Ollama's tool-calling API (default).
     * 'text'   — model rejected native tools; fall back to <tool> XML in text.
     * This persists across turns so the mode-switch only happens once per session.
     */
    private toolMode: 'native' | 'text' = 'native';
    /** Track if we've detected the model outputting JSON instead of calling tools */
    private detectedFakeToolCalls = false;

    /** Models known to need text mode (persisted across sessions via static map) */
    private static textModeModels = new Set<string>();
    /** Track consecutive failed tool calls to prevent infinite loops */
    private consecutiveFailures = 0;
    private readonly MAX_CONSECUTIVE_FAILURES = 3;
    /** Track repeated failing run_command invocations (same command failing even with other tools in between) */
    private _failedCommandSignatures = new Map<string, number>();
    private readonly MAX_SAME_COMMAND_FAILURES = 2;
    /** Track repeated failing edit_file attempts on the same (path, old_string) — not reset by read_file */
    private _failedEditSignatures = new Map<string, number>();
    private readonly MAX_SAME_EDIT_FAILURES = 2;
    /** Track repeated identical tool calls to prevent infinite loops */
    private lastToolSignature = '';
    private consecutiveRepeats = 0;
    private readonly MAX_CONSECUTIVE_REPEATS = 1;
    /** Track consecutive calls to the same tool name (even with different args) */
    private lastToolName = '';
    private consecutiveSameToolCalls = 0;
    /** Higher limit for action tools (rename, run_command) during batch operations */
    private readonly MAX_CONSECUTIVE_SAME_TOOL_ACTION = 15;
    /** Lower limit for read/info tools (more likely to be loops) */
    private readonly MAX_CONSECUTIVE_SAME_TOOL_DEFAULT = 4;
    /** Track mode-switch retries to prevent infinite retry loops */
    private modeSwitchRetries = 0;
    private readonly MAX_MODE_SWITCH_RETRIES = 2;
    /** Maximum number of messages to keep in history to prevent memory leaks */
    private readonly MAX_HISTORY_MESSAGES = 100;
    /** Track last context warning level to avoid duplicate alerts */
    private lastContextLevel: ContextLevel = 'safe';
    /** Current model being used (for accurate context calculations) */
    private currentModel: string = '';
    /** Count user turns for periodic memory nudge */
    private userTurnCount: number = 0;
    /** Interval (in user turns) between memory nudge injections */
    private readonly MEMORY_NUDGE_INTERVAL = 3;

    /** Track auto-retries for permission-asking / plan-dumping to prevent infinite loops */
    private autoRetryCount = 0;
    private readonly MAX_AUTO_RETRIES = 3;

    private diffViewManager: DiffViewManager;
    private refactorManager: MultiFileRefactoringManager;
    /** Last file operation for undo support */
    private _lastFileOp: { path: string; originalContent: string | null; action: string } | null = null;
    /** Pending inline confirmation resolver */
    private _confirmResolver: ((accepted: boolean) => void) | null = null;
    /** Timeout for pending confirmation to prevent hanging forever */
    private _confirmTimeout: ReturnType<typeof setTimeout> | null = null;
    /** Track spawned child processes for cleanup on stop() */
    private _activeChildren: Set<ChildProcess> = new Set();
    /** Whether shell environment has been saved to memory for this workspace */
    private static shellEnvSaved = false;
    /** Tool names auto-approved for the current run() — "Accept All" skips confirmation */
    private _autoApprovedTools = new Set<string>();
    /** The original user task message for the current conversation turn — preserved across context compaction */
    private _currentTaskMessage: string = '';
    /** Whether a focused grep was already injected this turn (prevents double-injection within a turn) */
    private _focusedGrepInjectedThisTurn = false;
    /** File paths for which focused grep content was injected this run (prevents re-injection on loop-back) */
    private _filesAutoReadThisRun = new Set<string>();
    /** Whether the current model is a small model (≤9B params) — triggers read-then-act mode */
    private _isSmallModel: boolean = false;
    /** Whether preProcessEditTask() successfully injected file context this run */
    private _editContextInjected: boolean = false;

    constructor(
        private workspaceRoot: string,
        private readonly memory: TieredMemoryManager | null = null,
        private readonly codeIndex: CodeIndexer | null = null
    ) {
        this.diffViewManager = new DiffViewManager();
        this.refactorManager = new MultiFileRefactoringManager();
    }

    /** Dispose all resources: managers, pending confirmations, child processes. */
    dispose(): void {
        this.diffViewManager.dispose();
        this.refactorManager.dispose();
        this.rejectPendingConfirmation();
        this.killActiveChildren();
        this.history = [];
    }

    /** Kill all tracked child processes. */
    private killActiveChildren(): void {
        for (const child of this._activeChildren) {
            try { child.kill(); } catch { /* already dead */ }
        }
        this._activeChildren.clear();
    }

    /** Reject any pending confirmation promise so it doesn't hang forever. */
    private rejectPendingConfirmation(): void {
        if (this._confirmTimeout) {
            clearTimeout(this._confirmTimeout);
            this._confirmTimeout = null;
        }
        if (this._confirmResolver) {
            logWarn('[agent] Dismissing pending confirmation (agent stopped or new turn started)');
            this._confirmResolver(false);
            this._confirmResolver = null;
            // Tell the webview to hide any open confirmation card
            try { this.postFn({ type: 'dismissConfirmation' }); } catch { /* ignore if postFn is gone */ }
        }
    }

    /** Track a child process and auto-remove when it exits. */
    private trackChild(child: ChildProcess): void {
        this._activeChildren.add(child);
        child.on('close', () => this._activeChildren.delete(child));
        child.on('error', () => this._activeChildren.delete(child));
    }

    get historyLength(): number { return this.history.length; }

    reset(): void {
        this.history = [];
        this._currentTaskMessage = '';
        this.diffViewManager.dispose();
        this.diffViewManager = new DiffViewManager();
    }

    stop(): void {
        this.stopRef.stop = true;
        // Immediately destroy any in-flight HTTP request without waiting for the next chunk
        this.stopRef.destroy?.();
        this.rejectPendingConfirmation();
        this.killActiveChildren();
    }

    /** Full conversation history (no system message) — safe to serialize. */
    get conversationHistory(): OllamaMessage[] { return [...this.history]; }

    /** Restore a previously saved conversation (e.g. when loading a session). */
    restoreHistory(history: OllamaMessage[]): void {
        this.history = [...history];
        logInfo(`[agent] History restored — ${this.history.length} messages`);
    }

    get lastUserMessage(): string | undefined {
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (this.history[i].role === 'user') { return this.history[i].content; }
        }
        return undefined;
    }

    retryLast(): string | undefined {
        const last = this.lastUserMessage;
        if (!last) { return undefined; }
        // Pop back to (but not including) the last user message
        while (this.history.length && this.history[this.history.length - 1].role !== 'user') {
            this.history.pop();
        }
        if (this.history.length && this.history[this.history.length - 1].role === 'user') {
            this.history.pop();
        }
        return last;
    }

    /** Manually compact conversation history to reduce context usage */
    async compactContext(targetPercentage: number = 50): Promise<{ removed: number; newPercentage: number; summary?: string }> {
        const model = this.currentModel || getConfig().model;
        const stats = calculateContextStats(this.history, '', '', model);
        const oldCount = this.history.length;

        // Grab the messages that will be dropped for summarization
        const compacted = compactHistory(
            this.history,
            targetPercentage,
            stats.modelLimit,
            0,
            0
        );
        const removedCount = oldCount - compacted.length;

        // Summarize dropped messages if there are enough to be worth it
        if (removedCount >= 4) {
            const dropped = this.history.slice(0, removedCount);
            const summaryText = dropped
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
                .join('\n');

            if (summaryText.trim()) {
                try {
                    let summary = '';
                    await streamChatRequest(
                        model,
                        [
                            { role: 'system', content: 'Summarize this conversation in 2-3 sentences. Be concise. Output ONLY the summary.' },
                            { role: 'user', content: summaryText.slice(0, 4000) },
                        ],
                        [],
                        (token) => { summary += token; },
                        this.stopRef
                    );
                    if (summary.trim()) {
                        compacted.unshift({ role: 'assistant', content: `[Earlier conversation summary] ${summary.trim()}` });
                        logInfo(`[context] Compaction summary: ${summary.trim().slice(0, 120)}`);
                    }
                } catch (err) {
                    logWarn(`[context] Summary generation failed, compacting without summary: ${toErrorMessage(err)}`);
                }
            }
        }

        this.history = compacted;
        this.lastContextLevel = 'safe';

        logInfo(`[context] Manual compaction: removed ${removedCount} messages, ${this.history.length} remaining`);

        // Extract summary from history if one was prepended
        let summaryText: string | undefined;
        if (this.history.length > 0 && this.history[0].content.startsWith('[Earlier conversation summary]')) {
            summaryText = this.history[0].content.replace('[Earlier conversation summary] ', '');
        }

        return {
            removed: removedCount,
            newPercentage: targetPercentage,
            summary: summaryText,
        };
    }

    /** Undo the last file-modifying tool execution. Returns a description or null if nothing to undo. */
    undoLastTool(): string | null {
        if (!this._lastFileOp) { return null; }
        const op = this._lastFileOp;
        this._lastFileOp = null;
        const full = path.resolve(this.workspaceRoot, op.path);
        try {
            if (op.action === 'created') {
                if (fs.existsSync(full)) { fs.unlinkSync(full); }
                return `Undone: removed created file ${op.path}`;
            }
            if (op.action === 'deleted' && op.originalContent !== null) {
                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, op.originalContent, 'utf8');
                return `Undone: restored deleted file ${op.path}`;
            }
            if (op.originalContent !== null) {
                fs.writeFileSync(full, op.originalContent, 'utf8');
                return `Undone: reverted ${op.path} to previous content`;
            }
            return null;
        } catch (err) {
            logError(`[agent] Undo failed: ${toErrorMessage(err)}`);
            return null;
        }
    }

    /** Whether an undo operation is available */
    get canUndo(): boolean { return this._lastFileOp !== null; }

    /** Resolve a pending inline confirmation from the webview */
    resolveConfirmation(accepted: boolean): void {
        if (this._confirmResolver) {
            this._confirmResolver(accepted);
            this._confirmResolver = null;
        }
    }

    /** Resolve confirmation AND auto-approve all future calls to this tool name */
    resolveConfirmationAll(toolName: string): void {
        this._autoApprovedTools.add(toolName);
        logInfo(`[agent] Auto-approving all future "${toolName}" calls this run`);
        this.resolveConfirmation(true);
    }

    /** Request inline confirmation from the webview chat UI (with 120s timeout).
     *  @param toolName — the tool name, used for "Accept All" batch approval.
     */
    private requestConfirmation(action: string, detail: string, toolName?: string): Promise<boolean> {
        // If this tool was batch-approved via "Accept All", skip the UI prompt
        if (toolName && this._autoApprovedTools.has(toolName)) {
            logInfo(`[agent] Auto-approved: ${toolName} (batch mode)`);
            this.postFn({ type: 'autoApproved', action, detail });
            return Promise.resolve(true);
        }
        // Clear any stale pending confirmation
        this.rejectPendingConfirmation();
        return new Promise<boolean>((resolve) => {
            this._confirmResolver = (accepted: boolean) => {
                if (this._confirmTimeout) {
                    clearTimeout(this._confirmTimeout);
                    this._confirmTimeout = null;
                }
                this._confirmResolver = null;
                resolve(accepted);
            };
            this._confirmTimeout = setTimeout(() => {
                logWarn('[agent] Confirmation timed out after 120s, rejecting');
                if (this._confirmResolver) {
                    this._confirmResolver(false);
                }
            }, 120_000);
            const confirmId = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            this.postFn({ type: 'confirmAction', id: confirmId, action, detail, toolName: toolName ?? action });
        });
    }

    async run(userMessage: string, model: string, post: PostFn): Promise<void> {
        this.stopRef = { stop: false };
        this.postFn  = post;
        this.currentModel = model; // Store current model for accurate context calculations
        this._currentTaskMessage = userMessage; // Capture task for use in tool interception

        // If this model is known to need text mode, switch immediately
        if (this.toolMode === 'native' && Agent.textModeModels.has(model)) {
            this.toolMode = 'text';
            logInfo(`Model ${model} → using text-mode (known from previous session)`);
            post({ type: 'modeSwitch', mode: 'text', model });
        }
        
        // Trim history BEFORE adding new message to prevent exceeding limit
        if (this.history.length >= this.MAX_HISTORY_MESSAGES) {
            const removed = this.history.length - this.MAX_HISTORY_MESSAGES + 1;
            this.history = this.history.slice(-this.MAX_HISTORY_MESSAGES + 1);
            logInfo(`[agent] History trimmed: removed ${removed} old messages`);
        }
        
        // Detect if user message is a short confirmation ("yes", "go ahead", etc.)
        // and inject an action nudge so the model starts calling tools immediately
        const isConfirmation = /^\s*(yes|yeah|yep|yup|sure|ok|okay|go\s*ahead|do\s*it|proceed|confirmed|make\s*it\s*happen|run\s*(them|those|it)|execute\s*(them|those|that))\s*[.!]?\s*$/i.test(userMessage);
        if (isConfirmation && this.toolMode === 'text') {
            this.history.push({ role: 'user', content: `${userMessage}\n\n[SYSTEM: The user confirmed. Start calling tools NOW to execute the plan. Call run_command or edit_file immediately. Do NOT repeat the plan as code blocks — CALL THE TOOLS.]` });
        } else {
            // Detect file paths in user message and add a hint to read them
            const filePathMatch = userMessage.match(/(?:look at|read|open|check|see|review)\s+([\w./\\-]+\.\w{1,10})\b/i)
                || userMessage.match(/\b([\w./\\-]+\.(?:md|txt|py|ts|js|json|yaml|yml|toml|cfg|ini|html|css|sql|sh|bash|go|rs|java|rb|php|c|cpp|h))\b/i);
            if (filePathMatch && this.toolMode === 'text') {
                const filePath = filePathMatch[1].replace(/\\/g, '/');
                this.history.push({ role: 'user', content: `${userMessage}\n\n[SYSTEM: The user mentioned file "${filePath}". Use shell_read with command "cat ${filePath}" to read it immediately. Do NOT list the directory.]` });
            } else {
                this.history.push({ role: 'user', content: userMessage });
            }
        }
        this.userTurnCount++;
        this.autoRetryCount = 0; // Reset auto-retry counter for each new user message
        this.memoryWritesThisResponse = 0; // Reset rate limiter for this response
        this._autoApprovedTools.clear(); // Reset batch-approve for each new user message
        this._currentTaskMessage = userMessage; // Remember original task for post-compaction recovery
        this._failedCommandSignatures.clear(); // Reset failed command tracking
        this._failedEditSignatures.clear();    // Reset failed edit tracking
        this._focusedGrepInjectedThisTurn = false; // Reset focused-grep dedup flag
        this._filesAutoReadThisRun.clear();    // Reset per-run auto-read tracking
        this._editContextInjected = false;     // Reset read-then-act flag
        
        logInfo(`Agent run — model: ${model}, mode: ${this.toolMode}, history: ${this.history.length}`);

        // ── Programmatic pre-processing pipeline ─────────────────────────
        // For complex multi-step tasks (like updating imports after reorganization),
        // do all discovery work programmatically BEFORE the model gets involved.
        // This eliminates the multi-step tool-calling chain that small models fail at.
        const preProcessedContext = await this.preProcessPathUpdate(userMessage, post);
        if (preProcessedContext === '__NO_MOVES_DETECTED__') {
            // Files haven't been moved yet — tell the user directly without involving the model
            const msg = "The files don't appear to have been moved yet. The recommendations document describes a *proposed* structure — the files need to be moved into place first.\n\nWould you like me to move the files into the proposed folder structure now? If yes, say **\"do the reorganization\"** and I'll create the directories and move the files. Then you can re-run this command to update the imports.";
            post({ type: 'streamStart' });
            for (const char of msg) { post({ type: 'token', text: char }); }
            post({ type: 'streamEnd' });
            this.history.push({ role: 'assistant', content: msg });
            logInfo('[pre-process] No moves detected — posted direct message to user, skipping model call');
            return;
        } else if (preProcessedContext === '__IMPORTS_ALREADY_CORRECT__') {
            // Module map has moves but no stale imports found — imports already updated
            const msg = "All import paths already point to the correct locations — no changes are needed.\n\nIf you expected changes, check that the files were actually moved to their new locations and that the imports in your code still reference the old paths.";
            post({ type: 'streamStart' });
            for (const char of msg) { post({ type: 'token', text: char }); }
            post({ type: 'streamEnd' });
            this.history.push({ role: 'assistant', content: msg });
            logInfo('[pre-process] Imports already correct — posted direct message to user, skipping model call');
            return;
        } else if (preProcessedContext) {
            // Replace the user message in history with the enriched version
            // The last item in history is the user message we just pushed
            this.history[this.history.length - 1] = {
                role: 'user',
                content: `${userMessage}\n\n${preProcessedContext}`,
            };
            logInfo(`[pre-process] Injected ${preProcessedContext.length} chars of pre-processed context`);
        }

        // ── Pre-search for explain/how/show queries ───────────────────────
        // For questions like "explain how X works" or "show me how Y works",
        // run a search programmatically BEFORE the model responds so it has
        // real code to work with instead of hallucinating from training data.
        const isExplainQuery = /\b(explain|show me how|how does|how do|describe how|walk me through|what does.*do|how is.*implemented)\b/i.test(userMessage)
            && !/\b(import|path|move|rename|reorganize)\b/i.test(userMessage); // skip import-update queries
        if (isExplainQuery && !preProcessedContext) {
            const stopWords = new Set(['show','me','how','the','a','an','is','are','does','do','what','where','find','explain','describe','works','work','working','this','that','it','in','on','of','for','to','and','or','with','by','from','at','into','walk','through','implemented','tell','when','happens','happen','using','used','get','make','let','run','use','way','ways','give','want','need','have','has','can','will','would','should','could','been']);
            const kws = userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w));
            // Stemming: strip common suffixes to improve search hit rate
            // e.g. "voided" -> "void", "printing" -> "print", "calculated" -> "calculat"
            const stemmed = kws.map(w => {
                if (w.endsWith('ed') && w.length > 4) { return w.slice(0, -2); }
                if (w.endsWith('ing') && w.length > 5) { return w.slice(0, -3); }
                if (w.endsWith('tion') && w.length > 6) { return w.slice(0, -4); }
                if (w.endsWith('s') && w.length > 4 && !w.endsWith('ss')) { return w.slice(0, -1); }
                return w;
            });
            // Use stemmed keywords for search but limit to most distinctive terms
            const uniqueKws = [...new Set(stemmed)].slice(0, 3);
            const query = uniqueKws.join(' ') || userMessage.slice(0, 50);
            if (query.trim()) {
                // Run one search per keyword so each term gets its own 100-result budget.
                // This prevents a multi-word phrase from missing files that only contain
                // individual keywords (e.g. "void_refund_api.py" wouldn't match "transac void").
                const searchId = `t_pre_explain_${Date.now()}`;
                post({ type: 'toolCall', id: searchId, name: 'shell_read', args: { command: `grep -rn "${query}" .` } });
                let searchResult = '';
                const env = detectShellEnvironment();
                const isWin = env.os === 'windows';
                try {
                    // Search each keyword individually (content search) and also by filename
                    const individualResults: string[] = [];
                    for (const kw of uniqueKws) {
                        try {
                            // Content search: grep for keyword in all files
                            const grepCmd = isWin
                                ? `Get-ChildItem -Recurse -Filter "*.py" | Select-String -Pattern "${kw}" | Select-Object -First 50 | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line)" }`
                                : `grep -rn "${kw}" --include="*.py" -l 2>/dev/null | head -30`;
                            const r = await this.executeTool('shell_read', { command: grepCmd }, `${searchId}_${kw}`);
                            individualResults.push(r);
                        } catch { /* skip failed keyword */ }
                        // Also find files whose NAME contains this keyword
                        try {
                            const findCmd = isWin
                                ? `Get-ChildItem -Recurse -Filter "*${kw}*.py" | Select-Object -ExpandProperty FullName | Select-Object -First 20`
                                : `find . -name "*${kw}*.py" -not -path "*/node_modules/*" -not -path "*/__pycache__/*" 2>/dev/null | head -20`;
                            const found = await this.executeTool('shell_read', { command: findCmd }, `${searchId}_fn_${kw}`);
                            logInfo(`[pre-explain] find(*${kw}*.py): ${found.split('\n').filter(l => l.trim()).length} results — ${found.slice(0, 200)}`);
                            // Convert to search-result format
                            const syntheticLines = found.split('\n')
                                .map(l => l.trim().replace(/\\/g, '/'))
                                .filter(l => l.endsWith('.py'))
                                .map(l => `${l}:1: [filename match:${kw}]`)
                                .join('\n');
                            if (syntheticLines) { individualResults.push(syntheticLines); }
                        } catch (e) { logInfo(`[pre-explain] find(*${kw}*.py) failed: ${e}`); }
                    }
                    searchResult = individualResults.join('\n');
                } catch { searchResult = '(search unavailable)'; }
                post({ type: 'toolResult', id: searchId, name: 'shell_read', success: !!searchResult && searchResult !== '(search unavailable)', preview: searchResult.slice(0, 200) });
                logInfo(`[pre-explain] Pre-searched "${uniqueKws.join(', ')}" — ${searchResult.length} chars`);

                // Extract the most relevant file from search results and read it.
                // Search results contain lines like "app/services/foo.py:42: ..."
                // Prefer service/route files over models, avoid archive/test/migration dirs.
                // Normalize backslashes to forward slashes for cross-platform compatibility.
                // Track which files came from filename match (find_files) vs content search.
                // Filename-matched files get a strong bonus because if the filename directly
                // contains the action keyword (e.g. "void" in "void_refund_api.py"), it's
                // almost certainly the dedicated file for that feature.
                // We track the keyword that triggered the match so rarer keywords score higher.
                const filenameMatched = new Map<string, string>(); // path → keyword
                for (const m of searchResult.matchAll(/^([\w/\\.-]+\.py):1: \[filename match:(\w+)\]/gm)) {
                    filenameMatched.set(m[1].replace(/\\/g, '/'), m[2]);
                }
                const fileMatches = [...searchResult.matchAll(/^([\w/\\.-]+\.py):\d+:/gm)]
                    .map(m => m[1].replace(/\\/g, '/'));
                const seen = new Set<string>();
                const candidates = fileMatches.filter(f => {
                    if (seen.has(f)) { return false; }
                    seen.add(f);
                    return !/archive|test|migration|__pycache__|node_modules/i.test(f);
                });
                // Score: prefer files whose basename contains the most query keywords.
                // Use the basename (last path segment) for name scoring so deep paths
                // don't accumulate false keyword hits from parent dir names.
                const queryWords = query.toLowerCase().split(/\W+/).filter(Boolean);
                const scored = candidates.map(f => {
                    const base = f.toLowerCase();
                    const basename = base.split('/').pop() ?? base; // e.g. "void_refund_api.py"
                    const basenameNoExt = basename.replace(/\.py$/, '');
                    // Count how many query words appear in the basename
                    const nameMatchCount = queryWords.filter(w => basenameNoExt.includes(w)).length;
                    // Bonus if basename IS essentially a query keyword (dedicated file)
                    const isDedicatedFile = queryWords.some(w => w.length > 3 && basenameNoExt.startsWith(w));
                    // Extra bonus if the file name contains ALL query keywords (strongest signal)
                    const matchesAllKeywords = queryWords.every(w => basenameNoExt.includes(w));
                    // Strong bonus if this file was found by filename search — its name IS the feature
                    const filenameBonus = filenameMatched.has(f) ? 2 : 0;
                    const nameScore = nameMatchCount * 3 + (isDedicatedFile ? 2 : 0) + (matchesAllKeywords && queryWords.length > 1 ? 3 : 0) + filenameBonus;
                    // typeScore: only reward route/service bonus if the file also matches a query keyword.
                    // Routes score equal to services — a dedicated route file is just as authoritative.
                    const typeScore = nameMatchCount > 0
                        ? ((base.includes('route') || base.includes('/routes/')) ? 1.5 : base.includes('service') ? 1 : base.includes('model') ? 0.5 : 0)
                        : 0;
                    // Penalize very generic names and long model files unlikely to have the specific logic
                    const penalty = /(__init__|utils|helpers|base|common|permission|config)\.(py)$/.test(basename) ? -2
                        : /transaction\.py$/.test(basename) && !queryWords.some(w => 'transaction'.startsWith(w)) ? -1
                        : 0;
                    return { f, score: nameScore + typeScore + penalty };
                }).sort((a, b) => b.score - a.score);

                logInfo(`[pre-explain] File candidates (top 5): ${scored.slice(0, 5).map(x => `${x.f}(${x.score.toFixed(1)})`).join(', ')}`);

                // Read top candidates, then pick the one whose content has the most keyword hits.
                // This breaks ties when multiple files score equally — the file that actually
                // CONTAINS the queried logic (e.g. "void") wins over a file that just shares
                // a naming pattern (e.g. "transaction_validators.py").
                const readResults: Array<{ f: string; content: string; hits: number }> = [];
                for (const { f } of scored.slice(0, 3)) {
                    const readId = `t_pre_read_${Date.now()}`;
                    const catCmd = isWin ? `Get-Content "${f}"` : `cat "${f}"`;
                    post({ type: 'toolCall', id: readId, name: 'shell_read', args: { command: catCmd } });
                    try {
                        const content = await this.executeTool('shell_read', { command: catCmd }, readId);
                        post({ type: 'toolResult', id: readId, name: 'shell_read', success: true, preview: content.slice(0, 150) });
                        if (content.length > 200) {
                            const lower = content.toLowerCase();
                            // Count hits per keyword, then score by the MINIMUM hits across all keywords.
                            // This ensures we pick the file that contains ALL keywords (e.g. both "void"
                            // and "transact"), not a file that has 1000× "transact" but zero "void".
                            const hitsPerKw = queryWords.map(w => {
                                let count = 0, pos = 0;
                                while ((pos = lower.indexOf(w, pos)) !== -1) { count++; pos++; }
                                return count;
                            });
                            // Primary sort: minimum hits across keywords (file must contain all terms)
                            // Secondary sort: total hits (prefer more comprehensive coverage)
                            const minHits = Math.min(...hitsPerKw);
                            const totalHits = hitsPerKw.reduce((a, b) => a + b, 0);
                            readResults.push({ f, content, hits: minHits * 10000 + totalHits });
                            logInfo(`[pre-explain] Pre-read "${f}" — ${content.length} chars, hits/kw: [${hitsPerKw.join(', ')}] minHits=${minHits}`);
                        } else {
                            logInfo(`[pre-explain] Skipping "${f}" — only ${content.length} chars`);
                        }
                    } catch (e) {
                        post({ type: 'toolResult', id: readId, name: 'shell_read', success: false, preview: String(e) });
                    }
                }
                // Pick the file with the most keyword hits; fall back to first if all tied
                readResults.sort((a, b) => b.hits - a.hits);
                let fileContent = readResults[0]?.content ?? '';
                let readFilePath = readResults[0]?.f ?? '';
                if (readFilePath) { logInfo(`[pre-explain] Selected "${readFilePath}" (${readResults[0].hits} hits) over ${readResults.slice(1).map(r => `"${r.f}"(${r.hits})`).join(', ')}`); }

                // Extract the most relevant section of the file around query keywords.
                // Rather than blindly taking first N chars, find where the keywords appear
                // and extract a window around those lines.
                let fileSection = '';
                if (fileContent) {
                    const lines = fileContent.split('\n');
                    // Find lines that contain query keywords
                    const qws = queryWords.filter(w => w.length > 3);
                    const relevantLineIdxs = lines
                        .map((l, i) => ({ i, hit: qws.some(w => l.toLowerCase().includes(w)) }))
                        .filter(x => x.hit)
                        .map(x => x.i);
                    let extractedContent: string;
                    if (relevantLineIdxs.length > 0) {
                        // Window: 20 lines before first hit to 80 lines after last hit
                        const start = Math.max(0, relevantLineIdxs[0] - 20);
                        const end = Math.min(lines.length, (relevantLineIdxs[relevantLineIdxs.length - 1]) + 80);
                        extractedContent = lines.slice(start, end).join('\n');
                        logInfo(`[pre-explain] Extracted lines ${start}-${end} of ${readFilePath} (keyword window)`);
                    } else {
                        extractedContent = fileContent.slice(0, 4500);
                    }
                    fileSection = `\n\nRelevant section of ${readFilePath}:\n\`\`\`python\n${extractedContent.slice(0, 5000)}\n\`\`\``;
                }
                const injection = `\n\n[Codebase search results for "${query}" (${candidates.length} files matched):\n${searchResult.slice(0, 1000)}\n]${fileSection}\n\nAnswer the user's question using ONLY the real code shown above. Do NOT write hypothetical or example code. If you need to see another file, use shell_read with cat or grep.`;
                this.history[this.history.length - 1] = {
                    role: 'user',
                    content: userMessage + injection,
                };
                logInfo(`[pre-explain] Injected ${injection.length} chars of search+read context`);
            }
        }

        // Resolve actual context limit from Ollama (cached after first call)
        await resolveModelContextLimit(model);

        // ── Explicit "read FILE and tell me" pre-inject ───────────────────────
        // When the user names a specific file to read, pre-load it so the model
        // doesn't have to figure out the path or resort to grepping.
        if (!preProcessedContext && !this._editContextInjected) {
            const readFileMatch = userMessage.match(/\bread\s+([\w\\/.\-]+\.\w+)\b/i);
            if (readFileMatch) {
                const rawPath = readFileMatch[1].replace(/\\/g, path.sep);
                // Try workspace-relative first, then absolute
                const candidates = [
                    path.join(this.workspaceRoot, rawPath),
                    rawPath,
                ];
                for (const candidate of candidates) {
                    try {
                        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                            const content = fs.readFileSync(candidate, 'utf8');
                            const relPath = path.relative(this.workspaceRoot, candidate).replace(/\\/g, '/');
                            const injection = `\n\n[FILE: ${relPath}]\n\`\`\`\n${content.slice(0, 30000)}\n\`\`\``;
                            this.history[this.history.length - 1] = {
                                role: 'user',
                                content: userMessage + injection,
                            };
                            logInfo(`[pre-read] Injected ${content.length} chars from ${relPath}`);
                            break;
                        }
                    } catch { /* skip */ }
                }
            }
        }

        // ── Read-then-act pipeline for small models ───────────────────────────
        // For edit tasks on models ≤9B params: programmatically find, read, and
        // inject the relevant file(s) BEFORE calling the model.  This eliminates
        // the multi-turn shell exploration loop that small models consistently fail at.
        this._isSmallModel = await this.resolveIsSmallModel(model);
        // Multi-file restructure tasks (split/separate/break into files) need full shell access
        // to read + write multiple files — not suitable for single-file pre-inject mode.
        const isMultiFileRestructure = /\b(split|separate|break)\b.{0,40}\b(file|files|module|modules)\b/i.test(userMessage)
            || /\binto\s+(separate|multiple|different)\s+(file|files|module|modules)\b/i.test(userMessage);
        const isFindSimilar = this.codeIndex?.isReady
            && (/\b(find|show|list|are there)\b.{0,30}\b(similar|duplicate|overlap|redundant)\b/i.test(userMessage)
            || /\b(similar|duplicate|overlapping)\s+(files?|services?|modules?)\b/i.test(userMessage)
            || /what\s+files?\s+(overlap|duplicate|are similar)\b/i.test(userMessage)
            || /\bfiles?\s+(that\s+)?(do\s+)?(similar|the same|overlap)\b/i.test(userMessage));
        const isEditTask = /\b(add|insert|append|implement|fix|modify|update|change|remove|delete|refactor|rename|replace|wrap|extract|move|convert|migrate)\b/i.test(userMessage)
            && !/\b(import|path)\b/i.test(userMessage)
            && !isMultiFileRestructure
            && !isFindSimilar
            && !isExplainQuery
            && !preProcessedContext;  // already handled by preProcessPathUpdate
        if (this._isSmallModel && isEditTask) {
            const editContext = await this.preProcessEditTask(userMessage, post);
            if (editContext) {
                this.history[this.history.length - 1] = {
                    role: 'user',
                    content: `${userMessage}\n\n${editContext}`,
                };
                this._editContextInjected = true;
                logInfo(`[pre-edit] Injected ${editContext.length} chars of pre-loaded file context`);
            }
        } else if (isMultiFileRestructure) {
            // Programmatic split — no model needed.
            // Find the target file via code index or keyword search, analyze its structure,
            // and write the split files directly.
            let targetAbs: string | undefined;

            // Priority 1: explicit filename mentioned in message (most reliable)
            const fnMatch = userMessage.match(/\b([\w-]+\.(?:py|ts|js|go|java|rs))\b/i);
            if (fnMatch) {
                const targetName = fnMatch[1].toLowerCase();
                // Walk workspace to find exact filename match, preferring non-archive paths
                const findFile = (dir: string, depth: number): string | undefined => {
                    if (depth > 8) { return undefined; }
                    let entries: fs.Dirent[];
                    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
                    let archiveMatch: string | undefined;
                    for (const e of entries) {
                        if (SKIP_DIRS.has(e.name)) { continue; }
                        const full = path.join(dir, e.name);
                        if (e.isDirectory()) {
                            const found = findFile(full, depth + 1);
                            if (found) {
                                if (/[/\\](archive|backup|old[_-]?code)[/\\]/i.test(found)) {
                                    archiveMatch = archiveMatch ?? found;
                                } else {
                                    return found; // non-archive win — return immediately
                                }
                            }
                        } else if (e.name.toLowerCase() === targetName) {
                            const rel = path.relative(this.workspaceRoot, full);
                            if (/[/\\](archive|backup|old[_-]?code)[/\\]/i.test(rel)) {
                                archiveMatch = archiveMatch ?? full;
                            } else {
                                return full;
                            }
                        }
                    }
                    return archiveMatch;
                };
                targetAbs = findFile(this.workspaceRoot, 0);
                if (targetAbs) { logInfo(`[split] Found by filename: ${targetAbs}`); }
            }

            // Priority 2: semantic search via code index
            if (!targetAbs && this.codeIndex?.isReady) {
                const hits = await this.codeIndex.findRelevantFiles(userMessage, 5);
                const nonArchive = hits.filter(h => !/[/\\](archive|backup|old[_-]?code)[/\\]/i.test(h.absPath));
                targetAbs = (nonArchive[0] ?? hits[0])?.absPath;
                if (targetAbs) { logInfo(`[split] Found via code index: ${targetAbs}`); }
            }

            const emitAssistant = (text: string) => {
                post({ type: 'token', text });
                post({ type: 'streamEnd' });
            };

            if (targetAbs) {
                try {
                    logInfo(`[split] Target file: ${targetAbs}`);
                    const plan = analyzeFile(targetAbs, this.workspaceRoot);
                    if (plan.splits.length < 2) {
                        // Check if file is already a thin aggregator (previously split)
                        const firstLines = fs.readFileSync(targetAbs, 'utf8').split('\n').slice(0, 5).join('\n');
                        const alreadySplit = /auto.?split|re.?exports?\s+all\s+sub/i.test(firstLines);
                        logInfo(`[split] Only ${plan.splits.length} group(s) found — file may already be well-organized`);
                        if (alreadySplit) {
                            emitAssistant(`\`${plan.relPath}\` was already split in a previous session — it is now a thin aggregator that imports the sub-blueprints. Nothing to do.`);
                        } else {
                            emitAssistant(`Only ${plan.splits.length} logical group found in \`${plan.relPath}\` — nothing to split.`);
                        }
                    } else {
                        logInfo(`[split] Analyzed ${plan.relPath} → ${plan.splits.length} groups: ${plan.splits.map(s => s.name).join(', ')}`);
                        const summary = await executeSplit(plan, this.workspaceRoot, post);
                        emitAssistant(summary);
                    }
                } catch (err) {
                    logError(`[split] Failed: ${toErrorMessage(err as Error)}`);
                    emitAssistant(`Split failed: ${toErrorMessage(err as Error)}`);
                }
            } else {
                logInfo('[split] Could not locate target file — falling through to model');
                emitAssistant(`Could not find the target file in the workspace. Please check the filename and try again.`);
            }
            // Split is fully handled — don't run the model loop
            return;
        } else if (isFindSimilar && this.codeIndex) {
            // Similarity analysis — pure vector math, no model needed
            const emitAssistant = (text: string) => {
                post({ type: 'token', text });
                post({ type: 'streamEnd' });
            };
            try {
                // Resolve scope: directory mentioned in message, or anchor file
                let scopeDir: string | undefined;
                let anchorFile: string | undefined;

                // Look for explicit directory hint (e.g. "in services/", "in app/services")
                const dirMatch = userMessage.match(/\bin\s+([\w/\\.-]+\/?)\b/i);
                if (dirMatch) {
                    const hint = dirMatch[1].replace(/\\/g, '/').replace(/\/$/, '');
                    // Walk workspace looking for a directory whose name matches
                    const findDir = (base: string, target: string): string | undefined => {
                        try {
                            const entries = fs.readdirSync(base, { withFileTypes: true });
                            for (const e of entries) {
                                if (!e.isDirectory() || SKIP_DIRS.has(e.name)) { continue; }
                                const full = path.join(base, e.name);
                                const rel = path.relative(this.workspaceRoot, full).replace(/\\/g, '/');
                                if (rel === target || e.name === target || rel.endsWith('/' + target)) { return full; }
                                const found = findDir(full, target);
                                if (found) { return found; }
                            }
                        } catch { /* skip */ }
                        return undefined;
                    };
                    scopeDir = findDir(this.workspaceRoot, hint);
                }

                // Look for anchor file (e.g. "what overlaps with pricing_engine.py")
                if (!scopeDir) {
                    const fnMatch = userMessage.match(/\bwith\s+([\w-]+\.(?:py|ts|js|go|java|rs))\b/i)
                        ?? userMessage.match(/\blike\s+([\w-]+\.(?:py|ts|js|go|java|rs))\b/i);
                    if (fnMatch) {
                        const targetName = fnMatch[1].toLowerCase();
                        const walk = (dir: string, depth: number): string | undefined => {
                            if (depth > 8) { return undefined; }
                            try {
                                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                                    if (SKIP_DIRS.has(e.name)) { continue; }
                                    const full = path.join(dir, e.name);
                                    if (e.isDirectory()) {
                                        const found = walk(full, depth + 1);
                                        if (found) { return found; }
                                    } else if (e.name.toLowerCase() === targetName) { return full; }
                                }
                            } catch { /* skip */ }
                            return undefined;
                        };
                        const found = walk(this.workspaceRoot, 0);
                        if (found) {
                            anchorFile = path.relative(this.workspaceRoot, found).replace(/\\/g, '/');
                        }
                    }
                }

                // Default scope: services directory if mentioned, else workspace root
                if (!scopeDir && !anchorFile) {
                    if (/\bservices?\b/i.test(userMessage)) {
                        const findDir = (base: string): string | undefined => {
                            try {
                                for (const e of fs.readdirSync(base, { withFileTypes: true })) {
                                    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) { continue; }
                                    const full = path.join(base, e.name);
                                    if (e.name === 'services') { return full; }
                                    const found = findDir(full);
                                    if (found) { return found; }
                                }
                            } catch { /* skip */ }
                            return undefined;
                        };
                        scopeDir = findDir(this.workspaceRoot);
                    }
                    scopeDir = scopeDir ?? this.workspaceRoot;
                }

                if (anchorFile) {
                    logInfo(`[similarity] Anchor mode: ${anchorFile}`);
                    const report = await findFilesLike(anchorFile, this.workspaceRoot, this.codeIndex);
                    emitAssistant(formatSimilarityReport(report));
                } else {
                    logInfo(`[similarity] Directory mode: ${scopeDir}`);
                    const report = await findSimilarInDirectory(scopeDir!, this.workspaceRoot, this.codeIndex);
                    emitAssistant(formatSimilarityReport(report));
                }
            } catch (err) {
                logError(`[similarity] Failed: ${toErrorMessage(err as Error)}`);
                post({ type: 'token', text: `Similarity analysis failed: ${toErrorMessage(err as Error)}` });
                post({ type: 'streamEnd' });
            }
            return;
        }

        const cfg = getConfig();
        const baseSystemContent = cfg.systemPrompt.trim()
            || (this._isSmallModel
                ? buildSmallModelSystemPrompt(this.workspaceRoot)
                : await buildSystemPromptAsync(cfg.autoSaveMemory, this.workspaceRoot));

        // Inject periodic memory nudge as a separate system message (not mutating user message)
        let memoryNudgeMsg: OllamaMessage | null = null;
        if (cfg.autoSaveMemory) {
            const nudge = this.buildMemoryNudge();
            if (nudge) {
                memoryNudgeMsg = { role: 'system', content: nudge.trim() };
                logInfo(`[agent] Memory nudge prepared at turn ${this.userTurnCount}`);
            }
        }

        // Build memory context — use relevance-based loading when possible
        let memoryContext = '';
        if (this.memory) {
            try {
                const maxTokens = this.memory.config.maxContextTokens || 4000;
                memoryContext = await this.memory.buildRelevantContext(userMessage, maxTokens);
                if (memoryContext) {
                    logInfo(`[agent] Loaded relevant memory context: ${Math.ceil(memoryContext.length / 4)} tokens`);
                }
            } catch (error) {
                logError(`[agent] Failed to load memory context: ${toErrorMessage(error)}`);
            }

            // Auto-save shell environment to memory once per workspace
            if (!Agent.shellEnvSaved) {
                Agent.shellEnvSaved = true;
                const env = detectShellEnvironment();
                const envContent = `Host: ${env.label}, shell=${env.shell}, os=${env.os}`;
                const existing = this.memory.buildContext([0, 1], 4000).toLowerCase();
                if (!existing.includes(env.os) || !existing.includes(env.shell)) {
                    this.memory.addEntry(0, envContent, ['environment', 'shell']).then(() => {
                        logInfo(`[shell-env] Saved to memory: ${envContent}`);
                    }).catch(err => {
                        logWarn(`[shell-env] Failed to save to memory: ${toErrorMessage(err)}`);
                    });
                }
            }
        }

        const MAX_TURNS = this._isSmallModel ? 8 : 25;
        this.modeSwitchRetries = 0;
        let loopExhausted = true;

        // Pre-compute values that don't change within a single run()
        const memoryTokens = memoryContext ? Math.ceil(memoryContext.length / 4) : 0;

        // Build system content once (only text-mode suffix varies per iteration)
        let baseSystemWithMemory = baseSystemContent;
        if (memoryContext) {
            baseSystemWithMemory = `${baseSystemContent}

## Your Persistent Memory
${memoryContext}

IMPORTANT: Only critical infrastructure is shown above. You have MORE memories stored across tiers 1-5. Before answering questions about project setup, conventions, frameworks, past decisions, or known issues, call memory_search("<topic>") or memory_tier_list to retrieve relevant context. Do NOT assume you have no memory — check first.`;
        }

        // Cache system content per toolMode to avoid rebuilding every turn
        let lastToolMode: 'native' | 'text' | null = null;
        let systemContent = '';

        for (let turn = 0; turn < MAX_TURNS; turn++) {
            if (this.stopRef.stop) { break; }
            this._focusedGrepInjectedThisTurn = false; // Reset per-turn to prevent double-injection

            // Build system content only when toolMode changes
            const isTextMode = this.toolMode === 'text';
            if (this.toolMode !== lastToolMode) {
                if (isTextMode) {
                    // Small models in edit mode get a minimal prompt — no shell examples
                    const textSuffix = (this._isSmallModel && this._editContextInjected)
                        ? buildSmallModelTextModeInstructions()
                        : buildTextModeInstructions(cfg.autoSaveMemory, this.workspaceRoot);
                    systemContent = baseSystemWithMemory + textSuffix;
                } else {
                    systemContent = baseSystemWithMemory;
                }
                lastToolMode = this.toolMode;
            }
            
            // ── Context Monitoring ────────────────────────────────────────────
            const contextStats = calculateContextStats(
                this.history,
                systemContent,
                memoryContext,
                model
            );
            
            logInfo(`[context] Usage: ${contextStats.usagePercentage.toFixed(1)}% (${contextStats.totalTokens}/${contextStats.modelLimit} tokens, ${contextStats.messagesCount} messages)`);
            
            // Alert user at 70% and remind until 99%
            if (contextStats.level === 'critical' && this.lastContextLevel !== 'critical') {
                this.lastContextLevel = 'critical';
                post({
                    type: 'contextWarning',
                    level: 'critical',
                    percentage: contextStats.usagePercentage,
                    totalTokens: contextStats.totalTokens,
                    modelLimit: contextStats.modelLimit,
                    messagesCount: contextStats.messagesCount
                });
                logWarn(`[context] Context usage at ${contextStats.usagePercentage.toFixed(1)}% - consider compacting`);
            }
            
            // Auto-compact at 99% if enabled
            if (contextStats.level === 'overflow') {
                if (cfg.autoCompactContext) {
                    logWarn(`[context] Auto-compacting at ${contextStats.usagePercentage.toFixed(1)}%`);
                    
                    // Store old count BEFORE compaction
                    const oldMessageCount = this.history.length;
                    
                    this.history = compactHistory(
                        this.history,
                        50, // Target 50% usage after compaction
                        contextStats.modelLimit,
                        contextStats.systemPromptTokens,
                        contextStats.memoryTokens
                    );
                    
                    // Calculate removed count AFTER compaction
                    const messagesRemoved = oldMessageCount - this.history.length;

                    // After compaction, ensure the original task is still in history.
                    // compactHistory works backwards from the end, so the first user message
                    // (the actual task) is often the first thing dropped when context is full.
                    // Re-inject it at the start so the model stays on task.
                    if (this._currentTaskMessage) {
                        const taskStillPresent = this.history.some(
                            m => m.role === 'user' && m.content.includes(this._currentTaskMessage.slice(0, 50))
                        );
                        if (!taskStillPresent) {
                            const compactNote = `[CONTEXT NOTE: Earlier messages were removed to free up context. Your current task is: "${this._currentTaskMessage}". Continue working on this task. Do NOT start a new task or execute suggestions from any planning documents you may have read.]\n\n${this._currentTaskMessage}`;
                            this.history.unshift({ role: 'user', content: compactNote });
                            logInfo(`[context] Re-injected original task message after compaction`);
                        }
                    }

                    this.lastContextLevel = 'safe';
                    post({
                        type: 'contextCompacted',
                        messagesRemoved,
                        newPercentage: 50
                    });
                } else {
                    // Alert user that compaction is needed but disabled
                    post({
                        type: 'contextOverflow',
                        percentage: contextStats.usagePercentage,
                        totalTokens: contextStats.totalTokens,
                        modelLimit: contextStats.modelLimit
                    });
                    logError(`[context] Context overflow at ${contextStats.usagePercentage.toFixed(1)}% but auto-compact is disabled`);
                }
            }
            
            // Merge built-in tools with MCP tools
            // Small models in edit mode get a restricted set (edit_file + run_command only)
            // to prevent them from looping on shell exploration when context is pre-injected.
            const mcpTools = mcpToolsToOllamaFormat();
            const tools = isTextMode ? []
                : (this._isSmallModel && this._editContextInjected)
                    ? SMALL_MODEL_TOOL_DEFINITIONS
                    : [...TOOL_DEFINITIONS, ...mcpTools];
            
            if (mcpTools.length > 0) {
                logInfo(`[agent] Using ${TOOL_DEFINITIONS.length} built-in + ${mcpTools.length} MCP tools`);
            }

            post({ type: 'streamStart' });

            let result: StreamResult;
            try {
                result = await streamChatRequest(
                    model,
                    [{ role: 'system', content: systemContent }, ...this.history, ...(memoryNudgeMsg ? [memoryNudgeMsg] : [])],
                    tools,
                    (token) => post({ type: 'token', text: token }),
                    this.stopRef
                );
            } catch (err) {
                // ── Auto-switch to text-mode on first 400 ─────────────────────
                if (err instanceof ToolsNotSupportedError && this.toolMode === 'native') {
                    this.toolMode = 'text';
                    Agent.textModeModels.add(model);
                    logInfo(`Model ${model} → switching to text-mode tool calling (remembered for future sessions)`);
                    // Clean up the empty streaming bubble that was already opened
                    post({ type: 'streamEnd' });
                    post({ type: 'removeLastAssistant' });
                    post({ type: 'modeSwitch', mode: 'text', model });
                    if (++this.modeSwitchRetries <= this.MAX_MODE_SWITCH_RETRIES) {
                        turn--; // retry this turn in text mode
                    }
                    continue;
                }

                const msg = toErrorMessage(err);
                logError(`Agent stream error (turn ${turn}): ${msg}`);
                post({ type: 'error', text: this.friendlyError(msg) });
                loopExhausted = false;
                break;
            }

            post({ type: 'streamEnd' });

            // Log full content for debugging
            logInfo(`[agent] Full response content (${result.content.length} chars): ${result.content}`);

            // ── Extract tool calls depending on mode ──────────────────────────
            let toolCalls: OllamaToolCall[];
            let displayContent: string;

            if (isTextMode) {
                toolCalls    = parseTextToolCalls(result.content);
                displayContent = stripToolBlocks(result.content);
            } else {
                toolCalls    = result.toolCalls;
                displayContent = result.content;
                
                // Detect if model is outputting fake tool calls (JSON or XML) instead of using native API
                if (!this.detectedFakeToolCalls && toolCalls.length === 0) {
                    const content = result.content;
                    // Use same detection logic as parser for consistency
                    const hasXmlToolCall = content.includes('<tool>');
                    const hasCodeBlockToolCall = (() => {
                        const codeBlockRegex = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?```/gi;
                        let m: RegExpExecArray | null;
                        while ((m = codeBlockRegex.exec(content)) !== null) {
                            try {
                                const parsed = JSON.parse(m[1]);
                                if (parsed.name && typeof parsed.name === 'string') { return true; }
                            } catch { /* not valid JSON */ }
                        }
                        return false;
                    })();
                    const hasJsonToolCall = (() => {
                        // Check single-line JSON
                        const singleLine = content.split('\n').some(line => {
                            const trimmed = line.trim();
                            if (trimmed.startsWith('{') && trimmed.includes('"name"')) {
                                try {
                                    const parsed = JSON.parse(trimmed);
                                    return parsed.name && typeof parsed.name === 'string';
                                } catch {
                                    return false;
                                }
                            }
                            return false;
                        });
                        if (singleLine) return true;
                        // Check multi-line JSON with "name" field
                        const multiLine = content.match(/\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?\}/);
                        if (multiLine) {
                            try {
                                const parsed = JSON.parse(multiLine[0]);
                                return parsed.name && typeof parsed.name === 'string';
                            } catch { return false; }
                        }
                        return false;
                    })();
                    
                    if (hasJsonToolCall || hasXmlToolCall || hasCodeBlockToolCall) {
                        this.detectedFakeToolCalls = true;
                        this.toolMode = 'text';
                        Agent.textModeModels.add(model);
                        logInfo(`Model ${model} outputting fake tool calls instead of using native API → switching to text mode (remembered)`);
                        logInfo(`[agent] Content sample: ${content.slice(0, 300)}`);
                        post({ type: 'streamEnd' });
                        post({ type: 'removeLastAssistant' });
                        post({ type: 'modeSwitch', mode: 'text', model });
                        if (++this.modeSwitchRetries <= this.MAX_MODE_SWITCH_RETRIES) {
                            turn--;
                        }
                        continue;
                    }
                }
            }

            // Store clean content in history (no raw tool XML)
            this.history.push({
                role: 'assistant',
                content: displayContent || result.content,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            });

            if (!toolCalls.length) {
                // ── Auto-retry: detect "asking permission" or verbose plan without action ──
                if (turn < MAX_TURNS - 1 && this.autoRetryCount < this.MAX_AUTO_RETRIES) {
                    const resp = (displayContent || result.content).toLowerCase();
                    const lastMsg = (userMessage).toLowerCase();
                    const isAskingPermission = /would you like me to|shall i|do you want me to|want me to proceed|like me to continue|is there anything specific/i.test(resp);
                    // userWantsAction: message must be imperative (not a question) and use strong action verbs
                    // Exclude: questions (?), explain/describe/show/tell/what/why/how requests
                    const isQuestion = /\?/.test(userMessage) || /^\s*(what|why|how|can you|could you|would you|do you|is|are|explain|describe|show me|tell me|what is|what are)\b/i.test(userMessage);
                    const userWantsAction = !isQuestion && !isExplainQuery && /\b(find|search|look|locate|show|implement|apply|execute|move|rename|reorganize|restructure|create|build|migrate|edit|update|fix|modify|refactor|rewrite|convert|transform|add|remove|delete|deploy|install|split|separate|extract|merge|run the|do the|do it|make the)\b/.test(lastMsg);
                    const hasCodeBlockButNoTool = /```/.test(resp) && !toolCalls.length;
                    // Don't treat a correct answer to a read/explain task as a "verbose plan dump"
                    const isVerbosePlanDump = !toolCalls.length && userWantsAction && !isExplainQuery
                        && (resp.length > 400 || hasCodeBlockButNoTool);
                    // Model asked user to provide file/content instead of reading it itself
                    const isAskingUserToProvide = /please provide|provide the (contents|file|code|text)|share the (contents|file|code)|paste the|send me the|provide me with/i.test(resp);

                    if (isAskingPermission && userWantsAction) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model asked for permission instead of acting (turn ${turn})`);
                        // Replace the assistant's response with a nudge
                        this.history.pop(); // remove the assistant message we just pushed
                        this.history.push({
                            role: 'user',
                            content: '[SYSTEM: You asked for permission but the user already told you to do it. Do NOT ask — start calling tools NOW. Call the first tool immediately.]'
                        });
                        post({ type: 'removeLastAssistant' });
                        continue; // retry this turn
                    }

                    if (isVerbosePlanDump) {
                        this.autoRetryCount++;
                        const fencedToolInPlan = /```[\s\S]*?\b(edit_file|edit_file_at_line|shell_read|run_command)\b[\s\S]*?```/.test(resp);
                        const planNudge = fencedToolInPlan
                            ? '[SYSTEM: You wrote a tool call inside a markdown code block (```). That does NOT execute the tool. You must output a raw <tool>{"name":"...","arguments":{...}}</tool> XML block — no backticks, no code fences, no explanation. Output ONLY the <tool> block now.]'
                            : (this._isSmallModel && this._editContextInjected)
                                ? '[SYSTEM: Stop explaining. The file content is in [PRE-LOADED CONTEXT] above. Call edit_file_at_line NOW with the line numbers shown. Output ONLY the <tool> block — no text before or after it.]'
                                : '[SYSTEM: You output a plan as text instead of calling tools. Do NOT explain what you will do — CALL THE FIRST TOOL NOW. Output only a <tool> block, nothing else.]';
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model ${fencedToolInPlan ? 'used fenced code block for tool call' : 'dumped a verbose plan'} (${resp.length} chars) without calling tools (turn ${turn})`);
                        this.history.pop();
                        this.history.push({
                            role: 'user',
                            content: planNudge,
                        });
                        post({ type: 'removeLastAssistant' });
                        continue;
                    }

                    // Third path: model summarized tool results and asked what to do next / offered help
                    // instead of continuing to answer (applies regardless of userWantsAction — explain/show/how queries too)
                    const isOfferingHelp = /\b(is there anything (else|more)|anything else i can|feel free to ask|let me know if|how can i (further )?help|do you (have|want|need)|would you like|shall i|next steps?)\b/i.test(resp);
                    // Model described what it would do instead of doing it (planning dump after reading a file)
                    const isPlanningInsteadOfDoing = userWantsAction && turn > 0 && !toolCalls.length && resp.length > 300
                        && /\b(you would|you could|you can|you need to|would need to|to (split|refactor|separate|reorganize|restructure|move|create|migrate))\b/i.test(resp);
                    // Don't retry explain/read tasks that already received tool results and produced a substantive answer.
                    // "read X and tell me Y" tasks are done once the model answers after reading — no further tools needed.
                    const modelAlreadyAnswered = isExplainQuery && turn > 0 && toolCalls.length === 0
                        && resp.length > 400;
                    const isSummaryWithQuestion = !isAskingPermission && !toolCalls.length
                        && !modelAlreadyAnswered
                        && turn > 0 && resp.length > 100
                        && (isOfferingHelp || isPlanningInsteadOfDoing || (/\b(here are|the (?:search|results?|output|matches)|found \d+|instances?|occurrences?)\b/i.test(resp)
                        && /\b(would you|shall i|do you want|like me to|specific file|which file|what file|have another|next step)\b/i.test(resp)));
                    if (isSummaryWithQuestion) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model summarized results and asked/offered help instead of answering (turn ${turn})`);
                        this.history.pop();
                        this.history.push({
                            role: 'user',
                            content: `[SYSTEM: You summarized a tool result and asked the user a follow-up question or offered help. Do NOT ask — just answer. The user's original question was: "${userMessage}". Use what you already found to answer it directly. If you need more detail, use shell_read with cat/grep on the most relevant file. Do NOT ask the user anything.]`
                        });
                        post({ type: 'removeLastAssistant' });
                        continue;
                    }

                    // Fourth path: model gave a text-only response on the first turn when user wants action,
                    // OR gave a long generic answer (e.g., Windows steps) when the user asked a codebase question.
                    // Sub-cases:
                    //   a) Model asked user to provide file contents — always retry
                    //   b) Model emitted a fenced code block tool call — always retry
                    //   c) Model gave verbose response (>200 chars) with no tool calls on turn 0 — retry
                    //      (applies even for "where is X" style questions — model should search the codebase)
                    const respIsQuestion = /\?/.test(displayContent || result.content);
                    const isDeflecting = isAskingUserToProvide;
                    // Detect model emitting tool call in a fenced code block instead of <tool> XML
                    const hasFencedToolCall = hasCodeBlockButNoTool && /```[\s\S]*?\b(edit_file|shell_read|run_command)\b[\s\S]*?```/.test(resp);
                    // Detect model answering about OS/system instead of searching the codebase
                    const isOsAnswer = /device manager|control panel|program files|appdata|windows update|epson.*software|driver.*download|official website|troubleshoot.*printer/i.test(resp);
                    // Detect model asking user for clarification instead of searching the codebase
                    const isAskingForContext = turn === 0 && respIsQuestion
                        && /could you (please )?(specify|clarify|provide|tell me|let me know|give me)|which (aspect|part|type|kind|version)|more (context|information|detail)|what (type|kind|aspect|part|version|specific)|please (specify|clarify|provide more|let me know)/i.test(resp)
                        && !toolCalls.length;
                    // Verbose turn-0 no-tool: fire even for question-phrased messages (e.g., "where is X", "show me how")
                    // If the model gives a long generic answer with no file references, it answered from training
                    // data instead of searching the codebase — always retry in that case.
                    // hasCodebaseRef: true only if response references actual project paths/files,
                    // not just generic code snippets with def/class/import that the model hallucinated.
                    // Hypothetical code blocks ("Example:", "hypothetical example", fake URLs) don't count.
                    const hasHypotheticalMarker = /hypothetical|example scenario|your-auth-server|your_server|example\.com|placeholder|simplified example|import nfc\b|import requests\b.*verify|if you were to implement|example implementation|example route|would typically involve|might look something like|example of how.*might be implemented|logic might be implemented|how.*might look|you would need to implement|you would need to create/i.test(resp);
                    const hasCodebaseRef = !hasHypotheticalMarker && /app\/|routes\/|services\/|\.py"|\.ts"|\.js"/i.test(resp);
                    const isGenericLongAnswer = turn === 0 && !toolCalls.length && resp.length > 300 && !hasCodebaseRef;
                    const isVerboseTurn0 = turn === 0 && !toolCalls.length && resp.length > 200 && !respIsQuestion;
                    if (!toolCalls.length && turn === 0 && (isDeflecting || hasFencedToolCall || isOsAnswer || isAskingForContext || isGenericLongAnswer || (isVerboseTurn0 && userWantsAction))) {
                        this.autoRetryCount++;
                        const toolCallHint = isTextMode ? ' Output only a <tool> block, nothing else.' : ' Call the tool now — do not explain, just call it.';
                        const nudgeContent = isDeflecting
                            ? `[SYSTEM: You asked the user to provide file contents, but you have tools to read files yourself. Use shell_read with cat/Get-Content on the file path. Do NOT ask the user — call the tool NOW.${toolCallHint}]`
                            : hasFencedToolCall
                            ? '[SYSTEM: You wrote a tool call inside a code block. That is NOT how tools work here. You must output a raw <tool>{"name":"...","parameters":{...}}</tool> block — no markdown, no code fences, no explanation. Output ONLY the <tool> block now.]'
                            : isOsAnswer
                            ? `[SYSTEM: You gave a generic OS/Windows answer. You are a coding assistant with access to the user's codebase. Search the project files instead. Use shell_read with grep/Get-ChildItem to find the relevant code NOW.${toolCallHint}]`
                            : isAskingForContext
                            ? `[SYSTEM: You asked the user for clarification, but you have tools to search the codebase yourself. Use shell_read with grep to search for the relevant code NOW instead of asking.${toolCallHint}]`
                            : isGenericLongAnswer
                            ? await (async () => {
                                // Model answered from training data — run a grep search programmatically
                                const stopWords = new Set(['show','me','how','the','a','an','is','are','does','do','what','where','find','all','please','works','work','working','this','that','it','in','on','of','for','to','and','or','with','by','from','at','into']);
                                const keywords = lastMsg.split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
                                const query = keywords.slice(0, 3).join(' ') || lastMsg.slice(0, 40);
                                const isWin = process.platform === 'win32';
                                const grepCmd = isWin
                                    ? `Get-ChildItem -Recurse -Include *.py,*.ts,*.js | Select-String "${keywords[0] ?? query}" | Select-Object -First 20`
                                    : `grep -rn --include="*.py" --include="*.ts" --include="*.js" -l "${keywords[0] ?? query}" . 2>/dev/null | head -10`;
                                const searchId = `t_autosearch_${Date.now()}`;
                                post({ type: 'toolCall', id: searchId, name: 'shell_read', args: { command: grepCmd } });
                                let searchResult = '';
                                try {
                                    searchResult = await this.executeTool('shell_read', { command: grepCmd }, searchId);
                                } catch { searchResult = '(search failed)'; }
                                post({ type: 'toolResult', id: searchId, name: 'shell_read', success: true, preview: searchResult.slice(0, 200) });
                                const preview = searchResult.slice(0, 2000);
                                return `[SYSTEM: You answered from general knowledge instead of searching the codebase. Here are the ACTUAL project files containing "${keywords[0] ?? query}":\n\n${preview}\n\nAnswer the user's question using ONLY the real code from these files. Use shell_read with cat/grep to read the relevant file. Do NOT generate hypothetical code.]`;
                            })()
                            : '[SYSTEM: You responded with text instead of calling a tool. The user wants you to take ACTION on their codebase. Use shell_read to read or search files, or edit_file to make changes. Output only a <tool> block, nothing else.]';
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: ${isDeflecting ? 'model asked user to provide file' : hasFencedToolCall ? 'model used fenced code block for tool call' : isAskingForContext ? 'model asked user for clarification' : isOsAnswer ? 'model gave OS answer' : isGenericLongAnswer ? 'model answered from training data' : 'model gave verbose text-only response'} on first turn (${resp.length} chars, turn ${turn})`);
                        this.history.pop();
                        this.history.push({
                            role: 'user',
                            content: nudgeContent,
                        });
                        post({ type: 'removeLastAssistant' });
                        continue;
                    }
                }

                // Post final context stats so webview can show running %
                const finalStats = calculateContextStats(
                    this.history,
                    systemContent,
                    memoryContext,
                    model
                );
                post({
                    type: 'contextStats',
                    percentage: finalStats.usagePercentage,
                    totalTokens: finalStats.totalTokens,
                    modelLimit: finalStats.modelLimit
                });

                // ── Post-response auto-extract facts to memory ────────────
                if (cfg.autoSaveMemory && this.memory) {
                    this.autoExtractFacts(userMessage, displayContent || result.content).catch(err => {
                        logWarn(`[agent] Auto-extract facts failed: ${toErrorMessage(err)}`);
                    });
                }

                loopExhausted = false;
                break;
            }

            // ── Execute tool calls ────────────────────────────────────────────
            // In text mode, execute only the FIRST tool call per turn.
            // Remaining calls are saved and re-injected as a reminder after the first
            // result so the model continues in order without rediscovering its own plan.
            const callsToExecute = isTextMode && toolCalls.length > 1
                ? [toolCalls[0]]
                : toolCalls;
            const deferredCalls = isTextMode && toolCalls.length > 1
                ? toolCalls.slice(1)
                : [];
            if (deferredCalls.length > 0) {
                logInfo(`[agent] Text-mode: model emitted ${toolCalls.length} tool calls, executing first (${toolCalls[0].function.name}), deferring ${deferredCalls.length} remaining`);
            }
            for (const tc of callsToExecute) {
                if (this.stopRef.stop) { break; }

                const name = tc.function.name;
                let args: Record<string, unknown>;
                try {
                    args = typeof tc.function.arguments === 'string'
                        ? JSON.parse(tc.function.arguments as unknown as string)
                        : tc.function.arguments;
                } catch { args = {}; }

                const toolId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                logInfo(`Tool [${this.toolMode}]: ${name}  args=${JSON.stringify(args)}`);
                post({ type: 'toolCall', id: toolId, name, args });

                // Detect repeated identical tool calls
                const toolSig = `${name}_${JSON.stringify(args)}`;
                if (toolSig === this.lastToolSignature) {
                    this.consecutiveRepeats++;
                } else {
                    this.lastToolSignature = toolSig;
                    this.consecutiveRepeats = 0;
                }

                // Track consecutive calls to the same tool name (even with different args)
                if (name === this.lastToolName) {
                    this.consecutiveSameToolCalls++;
                } else {
                    this.lastToolName = name;
                    this.consecutiveSameToolCalls = 1;
                }

                // Break if identical call repeated
                if (this.consecutiveRepeats >= this.MAX_CONSECUTIVE_REPEATS) {
                    logWarn(`[agent] Breaking repeat loop: ${name} called ${this.consecutiveRepeats + 1} times with same args`);
                    // If the repeated command was a file-search that returned a path, guide the model to read it
                    const isFileSearch = /Get-ChildItem|find\s|ls\s|-name\s|dir\s/i.test(String(args.command ?? ''));
                    const hint = isFileSearch
                        ? `You already ran this file search and got the result. DO NOT run it again. Take the file path from the result and READ the file content now: use shell_read with "cat <path>" or "Get-Content <path>".`
                        : `You already called ${name} with the same arguments ${this.consecutiveRepeats + 1} times and got the same result. DO NOT call this tool again. Use the result you already have and respond to the user with a text answer now.`;
                    if (isTextMode) {
                        this.history.push({ role: 'user', content: `[SYSTEM: ${hint}]` });
                    } else {
                        this.history.push({ role: 'tool', content: hint });
                    }
                    post({ type: 'toolResult', id: toolId, name, success: true, preview: '(duplicate call skipped)' });
                    this.consecutiveRepeats = 0;
                    this.lastToolSignature = '';
                    this.consecutiveSameToolCalls = 0;
                    this.lastToolName = '';
                    break;
                }

                // Break if same tool called too many times in a row (even with different args)
                // Use higher limit for action tools (run_command, edit_file) which legitimately
                // need many consecutive calls during batch operations (e.g., reorganizing 20 files)
                const ACTION_BATCH_TOOLS = new Set(['run_command', 'shell_read', 'edit_file', 'memory_tier_write']);
                const sameToolLimit = ACTION_BATCH_TOOLS.has(name)
                    ? this.MAX_CONSECUTIVE_SAME_TOOL_ACTION
                    : this.MAX_CONSECUTIVE_SAME_TOOL_DEFAULT;
                if (this.consecutiveSameToolCalls >= sameToolLimit) {
                    logWarn(`[agent] Breaking same-tool loop: ${name} called ${this.consecutiveSameToolCalls} times consecutively (limit: ${sameToolLimit})`);
                    // Tell the model to try a different approach — not just summarize and give up
                    const hint = `You have called ${name} ${this.consecutiveSameToolCalls} times in a row. Try a different approach — use a different tool or different arguments.`;
                    if (isTextMode) {
                        this.history.push({ role: 'user', content: `[SYSTEM: ${hint}]` });
                    } else {
                        this.history.push({ role: 'tool', content: hint });
                    }
                    post({ type: 'toolResult', id: toolId, name, success: true, preview: '(paused — too many consecutive calls)' });
                    this.consecutiveSameToolCalls = 0;
                    this.lastToolName = '';
                    break;
                }


                // ── Small-model shell_read block ──────────────────────────────
                // When context was pre-injected by preProcessEditTask(), the model
                // already has the file content.  Prevent it from wasting turns on
                // shell exploration by short-circuiting shell_read calls.
                if (name === 'shell_read' && this._isSmallModel && this._editContextInjected) {
                    const blockedResult = '[SYSTEM: File content has already been provided in the [PRE-LOADED CONTEXT] section. Do NOT search again. Use edit_file with old_string copied verbatim from that content.]';
                    post({ type: 'toolCall', id: toolId, name, args });
                    post({ type: 'toolResult', id: toolId, name, success: true, preview: blockedResult });
                    if (isTextMode) {
                        this.history.push({ role: 'user', content: `Tool ${name} returned:\n${blockedResult}` });
                    } else {
                        this.history.push({ role: 'tool', content: blockedResult });
                    }
                    logInfo(`[pre-edit] Blocked shell_read for small model — context already injected`);
                    continue;
                }

                let toolResult: string;
                try {
                    toolResult = await this.executeTool(name, args, toolId);
                    logInfo(`Tool ${name} OK — ${toolResult.length} chars`);
                    // Intercept large file reads when user wants an edit: replace with focused grep
                    // so the model never sees 16000-char file content that floods context.
                    if (name === 'shell_read' && toolResult.length > 3000
                        && /Get-Content|cat\s/i.test(String(args.command ?? ''))
                        && /\b(apply|implement|update|edit|modify|fix|refactor|improve|change|add|append|write|create|replace)\b/i.test(this._currentTaskMessage)) {
                        const interceptCmd = String(args.command ?? '');
                        const interceptPathMatch = interceptCmd.match(/['"](.*?)['"]/);
                        const interceptPath = interceptPathMatch?.[1] ?? '';
                        if (interceptPath) {
                            const envI = detectShellEnvironment();
                            const absInterceptPath = path.isAbsolute(interceptPath)
                                ? interceptPath
                                : path.join(this.workspaceRoot, interceptPath.replace(/\//g, path.sep));
                            const interceptKw = this._currentTaskMessage
                                .toLowerCase()
                                .match(/\b(fail|timeout|retry|auth|login|upload|download|connect|validat)\w*\b/g)
                                ?.slice(0, 3)
                                .join('|');
                            const interceptPattern = interceptKw
                                ? `except|raise|\\.error\\(|\\.critical\\(|${interceptKw}`
                                : 'except|raise|\\.error\\(|\\.critical\\(';
                            const focusCmd = envI.os === 'windows'
                                ? `Get-Content "${absInterceptPath}" | Select-String -Pattern "${interceptPattern}" -Context 3,3`
                                : `grep -n -A 3 -B 3 -E "${interceptPattern}" "${absInterceptPath}" | head -200`;
                            logInfo(`[agent] Intercepting large Get-Content (${toolResult.length} chars) → focused grep: ${focusCmd}`);
                            try {
                                const focusResult = await this.runShellRead(focusCmd, this.workspaceRoot, toolId + '_focus');
                                if (focusResult && focusResult.trim().length > 50) {
                                    const relI = path.relative(this.workspaceRoot, absInterceptPath).replace(/\\/g, '/');
                                    // Strip PowerShell "> " prefixes and cap at 2000 chars
                                    const focusClean = stripSelectStringPrefixes(focusResult);
                                    const focusTrunc = focusClean.length > 2000 ? focusClean.slice(0, 2000) + '\n...(truncated)' : focusClean;
                                    toolResult = `[FOCUSED READ of ${relI} — exception/error blocks only]\n${focusTrunc}\n\n(Use EXACT strings from above in edit_file. If the change is ALREADY present, say so and stop.)`;
                                    logInfo(`[agent] Focused grep returned ${focusResult.length} chars — replaced large read`);
                                    this._focusedGrepInjectedThisTurn = true;
                                }
                            } catch { /* keep original if grep fails */ }
                        }
                    }
                    // Detect soft failures: run_command/shell_read that returned non-zero exit code
                    const isSoftFailure = (name === 'run_command' || name === 'shell_read')
                        && /exit (?:[1-9]|\-1)/.test(toolResult)
                        && !toolResult.includes('file(s) moved');
                    if (isSoftFailure) {
                        post({ type: 'toolResult', id: toolId, name, success: false, preview: toolResult.slice(0, 400), fullResult: toolResult.slice(0, 8000) });
                        this.consecutiveFailures++;
                        // Revoke auto-approval on soft failure too
                        if (this._autoApprovedTools.has(name)) {
                            this._autoApprovedTools.delete(name);
                            logInfo(`[agent] Revoked auto-approval for "${name}" after soft failure (non-zero exit)`);
                        }
                    } else {
                        post({ type: 'toolResult', id: toolId, name, success: true, preview: toolResult.slice(0, 400), fullResult: toolResult.slice(0, 8000) });
                        this.consecutiveFailures = 0; // Reset on success
                    }
                } catch (err) {
                    toolResult = `Error: ${toErrorMessage(err)}`;
                    logError(`Tool ${name} failed: ${toolResult}`);
                    post({ type: 'toolResult', id: toolId, name, success: false, preview: toolResult });
                    this.consecutiveFailures++;

                    // If this tool was auto-approved and it failed, revoke auto-approval
                    // so the user sees the next attempt and can intervene
                    if (this._autoApprovedTools.has(name)) {
                        this._autoApprovedTools.delete(name);
                        logInfo(`[agent] Revoked auto-approval for "${name}" after failure`);
                    }

                    // (ENOENT handlers for removed file tools removed — model now uses shell commands)

                    // Track edit_file failures per (path, old_string) to catch repeated identical failures.
                    if (name === 'edit_file') {
                        const editSig = `${String(args.path ?? '')}::${String(args.old_string ?? '').slice(0, 120)}`;
                        const editFailCount = (this._failedEditSignatures.get(editSig) ?? 0) + 1;
                        this._failedEditSignatures.set(editSig, editFailCount);
                        if (editFailCount >= this.MAX_SAME_EDIT_FAILURES) {
                            const editHint = `You have tried to edit "${args.path}" with old_string "${String(args.old_string ?? '').slice(0, 80)}..." ${editFailCount} times and it keeps failing. The old_string does NOT exist in the file as written. Either:\n1. The string is not in this file at all (wrong file — skip it and move to the next one)\n2. The exact text differs (whitespace, quotes, etc.) — use shell_read with grep -n to get the EXACT content first\nDo NOT retry the same edit_file again. Move on to the next file.`;
                            logWarn(`[agent] edit_file same-signature failure ${editFailCount}x on "${args.path}" — breaking loop`);
                            if (isTextMode) {
                                this.history.push({ role: 'user', content: `Tool ${name} returned:\n${toolResult}\n---\n[SYSTEM: ${editHint}]` });
                            } else {
                                this.history.push({ role: 'tool', content: `${toolResult}\n\n${editHint}` });
                            }
                            this.consecutiveFailures = 0;
                            break;
                        }
                    }

                    // On edit_file "old_string not found" failure: read the exact line range reported
                    // in the error ("First line found at line N") and inject with line numbers so the
                    // model can construct a precise old_string with correct indentation.
                    // Skip if focused grep was already injected this turn (auto-read pipeline already ran).
                    if (name === 'edit_file' && /old_string not found|matches \d+ locations/i.test(toolResult) && !this._focusedGrepInjectedThisTurn) {
                        const failedPath = String(args.path ?? '');
                        if (failedPath) {
                            const envFail = detectShellEnvironment();
                            // Resolve to absolute path for the read command
                            const absFailPath = path.isAbsolute(failedPath)
                                ? failedPath
                                : path.join(this.workspaceRoot, failedPath.replace(/\//g, path.sep));
                            // Extract the line number from the error message if available
                            const lineNumMatch = toolResult.match(/found at line (\d+)/i);
                            const lineNum = lineNumMatch ? parseInt(lineNumMatch[1], 10) : 0;
                            // Read 20 lines around the reported line (or grep for exception blocks if no line)
                            let grepFailCmd: string;
                            if (lineNum > 0) {
                                const startLine = Math.max(1, lineNum - 3);
                                const endLine = startLine + 19;
                                // Include line numbers so model sees exact indentation (leading spaces visible)
                                grepFailCmd = envFail.os === 'windows'
                                    ? `$lines = Get-Content "${absFailPath}"; $lines[${startLine - 1}..${endLine - 1}] | ForEach-Object -Begin {$n=${startLine}} -Process { "{0:D4}: {1}" -f $n,$_; $n++ }`
                                    : `awk 'NR>=${startLine} && NR<=${endLine} {printf "%04d: %s\\n", NR, $0}' "${absFailPath}"`;
                                logInfo(`[agent] edit_file failed at line ${lineNum} — reading lines ${startLine}-${endLine}`);
                            } else {
                                const failKeywords = this._currentTaskMessage
                                    .toLowerCase()
                                    .match(/\b(fail|timeout|retry|auth|login|upload|download|connect|validat)\w*\b/g)
                                    ?.slice(0, 3)
                                    .join('|');
                                const failPattern = failKeywords
                                    ? `except|raise|\\.error\\(|\\.critical\\(|${failKeywords}`
                                    : 'except|raise|\\.error\\(|\\.critical\\(';
                                grepFailCmd = envFail.os === 'windows'
                                    ? `Get-Content "${absFailPath}" | Select-String -Pattern "${failPattern}" -Context 2,2`
                                    : `grep -n -A 2 -B 2 -E "${failPattern}" "${absFailPath}" | head -100`;
                                logInfo(`[agent] edit_file old_string failed — running focused grep: ${grepFailCmd}`);
                            }
                            const failGrepId = `t_failgrep_${Date.now()}`;
                            post({ type: 'toolCall', id: failGrepId, name: 'shell_read', args: { command: grepFailCmd } });
                            let failGrepContent = '';
                            try {
                                failGrepContent = await this.runShellRead(grepFailCmd, this.workspaceRoot, failGrepId);
                                post({ type: 'toolResult', id: failGrepId, name: 'shell_read', success: true, preview: failGrepContent.slice(0, 150) });
                            } catch (e) {
                                post({ type: 'toolResult', id: failGrepId, name: 'shell_read', success: false, preview: String(e) });
                            }
                            if (failGrepContent && failGrepContent.trim().length > 50) {
                                const relFailPath = path.relative(this.workspaceRoot, absFailPath).replace(/\\/g, '/');
                                const failReason = /matches \d+ locations/i.test(toolResult)
                                    ? 'Your old_string is too short and matches multiple places — add MORE surrounding context lines to make it unique.'
                                    : `Your old_string did NOT match — wrong indentation or whitespace. The exact lines from line ${lineNum > 0 ? lineNum - 3 : '?'} are shown below.`;
                                // Strip PowerShell "> " prefixes if Select-String was used; plain Get-Content lines need no stripping
                                const failGrepClean = lineNum > 0 ? failGrepContent : stripSelectStringPrefixes(failGrepContent);
                                const lineNote = lineNum > 0
                                    ? `Lines are shown as "NNNN: content" — the "NNNN: " prefix is NOT part of the file. Use only the content after the colon+space in old_string.`
                                    : '';
                                const injectMsg = `[FILE CONTENT: ${relFailPath} lines ~${lineNum > 0 ? lineNum - 3 : '?'}-${lineNum > 0 ? lineNum + 16 : '?'}]\n${failGrepClean}\n\n${lineNote} ${failReason} Copy the EXACT content (preserving all leading spaces) into old_string and retry edit_file with path="${relFailPath}". If the logging is already present, say so and stop.`;
                                if (isTextMode) {
                                    this.history.push({ role: 'user', content: `Tool ${name} returned:\n${toolResult}\n---\n[SYSTEM: ${injectMsg}]` });
                                } else {
                                    this.history.push({ role: 'tool', content: `${toolResult}\n\n${injectMsg}` });
                                }
                                this.consecutiveFailures = 0;
                                continue; // Skip the normal history push below — we already added it
                            }
                        }
                    }

                    // Break loop if too many consecutive failures — give model a hint to try differently
                    if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
                        logWarn(`[agent] ${this.consecutiveFailures} consecutive tool failures — nudging model to try a different approach`);
                        const hint = name === 'edit_file'
                            ? `You have had ${this.consecutiveFailures} consecutive edit_file failures — your old_string does not match the file content. STOP guessing. Use shell_read with "grep -n 'pattern' file" or "cat -n file" to see the EXACT current content, then retry edit_file with the correct old_string copied exactly from the file.`
                            : `You have had ${this.consecutiveFailures} consecutive tool failures. Try a different approach or respond to the user explaining what went wrong.`;
                        if (isTextMode) {
                            this.history.push({ role: 'user', content: `[SYSTEM: ${hint}]` });
                        } else {
                            this.history.push({ role: 'tool', content: hint });
                        }
                        this.consecutiveFailures = 0; // Reset so the model gets another chance
                        break;
                    }
                }

                // In text mode, inject the result as a user turn so the model sees it
                if (isTextMode) {
                    let nudge: string;

                    if (name === 'run_command') {
                        const cmdStr = String(args.command ?? '');
                        const isMoveCmd = /\bmv\b|\bmove\b|\bMove-Item\b/i.test(cmdStr);
                        const isMkdirCmd = /\bmkdir\b|\bNew-Item\b/i.test(cmdStr);
                        const lastUserMsg = this._currentTaskMessage.toLowerCase();
                        const userWantsPathUpdate = /\b(point|location|path|import|reference)\b/i.test(lastUserMsg) && /\b(edit|update|change|fix|modify)\b/i.test(lastUserMsg);
                        const hasFailed = toolResult.includes('cannot find') || toolResult.includes('not found') || toolResult.includes('Error') || toolResult.includes('syntax') || toolResult.includes('incorrect') || (toolResult.includes('exit 1') && !toolResult.includes('file(s) moved'));
                        if (userWantsPathUpdate && (isMoveCmd || isMkdirCmd)) {
                            nudge = 'STOP — the user wants you to UPDATE CODE REFERENCES (import statements, paths in code), NOT move files. Use shell_read with grep/findstr to find where the OLD import paths are used, then use edit_file to update them.';
                        } else if (toolResult.includes('already exists')) {
                            nudge = 'The directory already exists — that is fine. Continue with the next step.';
                        } else if (hasFailed && isMoveCmd) {
                            const cmdSig = cmdStr.toLowerCase().trim();
                            const failCount = (this._failedCommandSignatures.get(cmdSig) ?? 0) + 1;
                            this._failedCommandSignatures.set(cmdSig, failCount);
                            if (failCount >= this.MAX_SAME_COMMAND_FAILURES) {
                                nudge = `STOP — you have tried this exact move command ${failCount} times and it keeps failing. The filenames do NOT match. Use shell_read with ls/dir to see the EXACT filenames on disk, then build a new command using those names.`;
                            } else {
                                nudge = `The move command FAILED. Use shell_read with ls/dir to see the REAL filenames on disk, then retry with the exact names.`;
                            }
                        } else if (hasFailed) {
                            nudge = `The command failed. Use shell_read to check what files/directories actually exist before retrying.`;
                        } else if (isMoveCmd) {
                            nudge = 'Files moved. If there are MORE files to move, batch them in ONE run_command call. Do NOT stop until ALL files are moved.';
                        } else if (isMkdirCmd) {
                            nudge = 'Directories created. Now move the files into them. Batch ALL moves into as few run_command calls as possible.';
                        } else {
                            nudge = 'Command completed. Continue with the next step.';
                        }
                    } else if (name === 'edit_file') {
                        nudge = 'If you have MORE edits to make, call the next edit_file NOW. Do NOT show changes as a code block — CALL THE TOOL. Only respond with text once ALL edits are complete.';
                    } else if (name === 'shell_read') {
                        const lastUserMsg = this._currentTaskMessage.toLowerCase();
                        const wantsPathUpdate = /\b(point|location|path|import|reference|reorganiz|moved|new folder|new director)\b/i.test(lastUserMsg)
                            && /\b(edit|update|change|fix|modify|point|adjust|rewrite)\b/i.test(lastUserMsg);
                        const wantsAction = /\b(move|rename|reorganize|restructure|migrate|run|execute|do\s+(it|them|that|those|this|the)|go\s+ahead|make\s+it|mkdir|delete|remove|copy)\b/.test(lastUserMsg)
                            || (/\b(implement|apply)\b/.test(lastUserMsg) && /\b(organiz|restructur|folder|director|migrat|move|layout|recommend)/.test(lastUserMsg));
                        const wantsEdit = /\b(apply|implement|rewrite|update|edit|modify|fix|refactor|improve|change|add|append|write|create|replace|overhaul|rework|redo|revise|optimize|clean\s*up)\b/.test(lastUserMsg);
                        // Detect PowerShell/shell errors that mean the path doesn't exist
                        const isShellError = /Cannot find path|does not exist|ItemNotFoundException|PathNotFound|No such file|not recognized as|is not recognized/i.test(toolResult);
                        // Detect empty file searches: explicit "not found" messages OR PowerShell
                        // table with only header/dashes and no actual file paths
                        const isEmptyFileSearch = /\b(dir|where|find|Get-ChildItem|ls)\b/i.test(String(args.command ?? ''))
                            && (/File Not Found|not found|No matches|0 File|no such file/i.test(toolResult)
                                || toolResult.trim() === ''
                                || isShellError
                                || /^[\s\r\n]*(FullName|Name|Path)[\s\r\n]*-+[\s\r\n]*(searched in:|$)/im.test(toolResult));
                        // Detect if the result is just a file path list (not file content):
                        // Handle both bare paths and PowerShell Select-Object table format (FullName header + dashes).
                        // Works even on truncated output — checks if ANY line looks like an absolute path.
                        // Exclude shell error output — it contains paths but they refer to missing files.
                        const resultLines = toolResult.trim().split('\n').map(l => l.trim()).filter(Boolean);
                        const contentLines = resultLines.filter(l => !/^-+$/.test(l) && l !== 'FullName' && l !== 'Name' && l !== 'Path');
                        // A line is a file path if it's an absolute path (C:\ or /) or ends with a known extension
                        const isAbsPath = (l: string) => /^[A-Za-z]:[\\\/]/.test(l) || l.startsWith('/');
                        const isFilePath = (l: string) => /\.(py|ts|js|json|yaml|yml|md|txt|sh|toml|cfg|ini|html|css|sql|go|rs|java|rb|php|c|cpp|h|pyc)$/i.test(l) || isAbsPath(l);
                        // Fire if at least one content line is a path (truncated output may only show 1)
                        // Do NOT fire on shell errors — the path in the error is the wrong/missing one.
                        // Raise the length limit to 4000 to handle multi-file search results.
                        const isFilePathList = !isShellError && contentLines.length > 0 && toolResult.length < 4000
                            && contentLines.some(isFilePath)
                            && contentLines.every(l => isFilePath(l) || /^searched in:/i.test(l));
                        if (wantsPathUpdate) {
                            nudge = 'STOP reading more files. The user wants you to UPDATE IMPORT PATHS. Use shell_read with grep to find OLD import paths, then edit_file to update them. Do NOT move files.';
                        } else if (wantsAction) {
                            nudge = 'You have the information. The user wants you to PERFORM ACTIONS. Use run_command with the EXACT filenames you found above. Do NOT show commands as code blocks — CALL run_command NOW.';
                        } else if (wantsEdit && isFilePathList) {
                            // Model found the file path but hasn't read the content yet.
                            // Programmatically read the most relevant file and inject content so
                            // the model doesn't loop trying to re-search.
                            // Pick the most relevant path: prefer .py service files, skip __pycache__
                            const relevantPath = contentLines
                                .filter(l => !/__pycache__|\.pyc$|htmlcov/.test(l))
                                .find(l => /service/i.test(l) && /\.py$/i.test(l))
                                ?? contentLines.filter(l => !/__pycache__|\.pyc$|htmlcov/.test(l)).find(l => /\.py$/i.test(l))
                                ?? contentLines.filter(l => !/__pycache__|\.pyc$|htmlcov/.test(l))[0]
                                ?? contentLines[0];
                            // Skip auto-read if we already injected content for this file this run
                            if (this._filesAutoReadThisRun.has(relevantPath)) {
                                nudge = `You already have the file content above. Use edit_file with EXACT strings from the [AUTO-READ] section. Do NOT search again.`;
                                // skip the grep/read block below by jumping to the else
                            } else {
                            const env2 = detectShellEnvironment();
                            // Keep backslashes as-is for Windows paths; convert forward slashes for Unix
                            const pathForCmd = env2.os === 'windows' ? relevantPath.replace(/\//g, '\\') : relevantPath;
                            // Build a focused grep/Select-String command to extract only relevant sections
                            // (exception/error handling + user-task keywords) with surrounding context lines.
                            // This prevents the full file (potentially thousands of lines) from flooding context.
                            // Only use specific, low-frequency task keywords (skip noisy terms like 'log', 'ocr', 'process').
                            const autoKeywords = lastUserMsg
                                .toLowerCase()
                                .match(/\b(fail|timeout|retry|auth|login|upload|download|connect|validat)\w*\b/g)
                                ?.slice(0, 3)
                                .join('|');
                            // Always anchor on exception/error handling constructs; add user keywords if specific enough
                            const grepPattern = autoKeywords
                                ? `except|raise|\\.error\\(|\\.critical\\(|${autoKeywords}`
                                : 'except|raise|\\.error\\(|\\.critical\\(';
                            const grepCmd = env2.os === 'windows'
                                ? `Get-Content "${pathForCmd}" | Select-String -Pattern "${grepPattern}" -Context 3,3`
                                : `grep -n -A 3 -B 3 -E "${grepPattern}" "${pathForCmd}" | head -200`;
                            const catCmd = env2.os === 'windows'
                                ? `Get-Content "${pathForCmd}"`
                                : `cat "${pathForCmd}"`;
                            logInfo(`[agent] Auto-reading file (focused grep) after path search: ${grepCmd}`);
                            const autoReadId = `t_autoread_${Date.now()}`;
                            post({ type: 'toolCall', id: autoReadId, name: 'shell_read', args: { command: grepCmd } });
                            let fileContent = '';
                            let usedFullRead = false;
                            try {
                                fileContent = await this.runShellRead(grepCmd, this.workspaceRoot, autoReadId);
                                // If grep returned almost nothing, fall back to full file read
                                if (fileContent.trim().length < 100) {
                                    logInfo(`[agent] Focused grep returned little (${fileContent.length} chars), falling back to full read`);
                                    post({ type: 'toolResult', id: autoReadId, name: 'shell_read', success: false, preview: 'grep returned little, falling back' });
                                    const autoReadId2 = `t_autoread2_${Date.now()}`;
                                    post({ type: 'toolCall', id: autoReadId2, name: 'shell_read', args: { command: catCmd } });
                                    try {
                                        fileContent = await this.runShellRead(catCmd, this.workspaceRoot, autoReadId2);
                                        post({ type: 'toolResult', id: autoReadId2, name: 'shell_read', success: true, preview: fileContent.slice(0, 150) });
                                        usedFullRead = true;
                                    } catch (e2) {
                                        post({ type: 'toolResult', id: autoReadId2, name: 'shell_read', success: false, preview: String(e2) });
                                    }
                                } else {
                                    post({ type: 'toolResult', id: autoReadId, name: 'shell_read', success: true, preview: fileContent.slice(0, 150) });
                                }
                            } catch (e) {
                                post({ type: 'toolResult', id: autoReadId, name: 'shell_read', success: false, preview: String(e) });
                            }
                            if (fileContent && fileContent.length > 100) {
                                const relPath = path.relative(this.workspaceRoot, relevantPath.replace(/\//g, path.sep)).replace(/\\/g, '/');
                                const readNote = usedFullRead
                                    ? 'The FULL file content is shown above.'
                                    : 'Relevant sections of the file are shown above (lines matching the task keywords + context).';
                                // Strip PowerShell "> " prefixes and cap at 2000 chars
                                const fileContentClean = usedFullRead ? fileContent : stripSelectStringPrefixes(fileContent);
                                const fileContentTrunc = fileContentClean.length > 2000 ? fileContentClean.slice(0, 2000) + '\n...(truncated)' : fileContentClean;
                                nudge = `[AUTO-READ: ${relPath}]\n${fileContentTrunc}\n\n${readNote} Now apply the user's requested change using edit_file with path="${relPath}" and EXACT strings copied from the content above. Do NOT use absolute paths. Do NOT search again. If the change is ALREADY present in the file, say so and stop.`;
                                this._focusedGrepInjectedThisTurn = true;
                                this._filesAutoReadThisRun.add(relevantPath);
                            } else {
                                nudge = `You found the file path. Now READ the file content before editing. Call shell_read with: ${catCmd}`;
                            }
                            } // close the else-block for "not already auto-read"
                        } else if (wantsEdit && /Get-Content|cat\s/i.test(String(args.command ?? '')) && toolResult.length < 300 && !/def |class |import |#/.test(toolResult)) {
                            // Get-Content returned too little to be real source code — wrong path.
                            // Search recursively using the filename from the command.
                            const cmdStr = String(args.command ?? '');
                            const fileNameMatch = cmdStr.match(/['\"]([^'"]*?([^'/\\]+\.py))['"]/i);
                            const fileName = fileNameMatch?.[2] ?? '';
                            const wsRoot2 = this.workspaceRoot.replace(/\\/g, '/');
                            const env2 = detectShellEnvironment();
                            const searchCmd = fileName
                                ? (env2.os === 'windows'
                                    ? `Get-ChildItem -Path '${wsRoot2}' -Recurse -Filter '${fileName}' | Where-Object { $_.FullName -notmatch '__pycache__|htmlcov' } | Select-Object FullName`
                                    : `find '${wsRoot2}' -name '${fileName}' -not -path '*__pycache__*' -not -path '*htmlcov*'`)
                                : '';
                            if (searchCmd) {
                                const autoSearchId = `t_autosearch_${Date.now()}`;
                                post({ type: 'toolCall', id: autoSearchId, name: 'shell_read', args: { command: searchCmd } });
                                let searchResult = '';
                                try {
                                    searchResult = await this.runShellRead(searchCmd, this.workspaceRoot, autoSearchId);
                                    post({ type: 'toolResult', id: autoSearchId, name: 'shell_read', success: true, preview: searchResult.slice(0, 200) });
                                } catch (e) {
                                    post({ type: 'toolResult', id: autoSearchId, name: 'shell_read', success: false, preview: String(e) });
                                }
                                // Extract the best path from the search result and auto-read it
                                const pathLines = searchResult.split('\n').map(l => l.trim()).filter(l => /\.py$/i.test(l) && isAbsPath(l));
                                const bestPath = pathLines.find(l => /service/i.test(l)) ?? pathLines[0];
                                if (bestPath) {
                                    const readCmd = env2.os === 'windows' ? `Get-Content "${bestPath.replace(/\//g, '\\')}"` : `cat "${bestPath}"`;
                                    const autoReadId2 = `t_autoread2_${Date.now()}`;
                                    post({ type: 'toolCall', id: autoReadId2, name: 'shell_read', args: { command: readCmd } });
                                    let fileContent2 = '';
                                    try {
                                        fileContent2 = await this.runShellRead(readCmd, this.workspaceRoot, autoReadId2);
                                        post({ type: 'toolResult', id: autoReadId2, name: 'shell_read', success: true, preview: fileContent2.slice(0, 150) });
                                    } catch (e) {
                                        post({ type: 'toolResult', id: autoReadId2, name: 'shell_read', success: false, preview: String(e) });
                                    }
                                    if (fileContent2 && fileContent2.length > 200) {
                                        const relPath2 = path.relative(this.workspaceRoot, bestPath.replace(/\//g, path.sep)).replace(/\\/g, '/');
                                        nudge = `[AUTO-READ: ${relPath2}]\n${fileContent2}\n\nThis is the REAL file. Now apply the user's requested change using edit_file with path="${relPath2}" and EXACT strings from the content above. Do NOT use absolute paths.`;
                                    } else {
                                        nudge = `The path "${bestPath}" was found but returned empty. The file at "${String(args.command ?? '').match(/['"][^'"]*['"]/)?.[0] ?? 'the path you tried'}" does not exist. Use the path from the search result: ${searchResult.slice(0, 200)}`;
                                    }
                                } else {
                                    nudge = `The file at the path you tried does not exist. Search result: ${searchResult.slice(0, 300)}. Use the EXACT full path from the search results above.`;
                                }
                            } else {
                                nudge = `The file you tried to read returned almost no content (${toolResult.length} chars) — it may be at the wrong path. Use shell_read with Get-ChildItem -Recurse -Filter to find the correct absolute path first.`;
                            }
                        } else if (wantsEdit && /Get-Content|cat\s/i.test(String(args.command ?? '')) && toolResult.length > 2000) {
                            // Model read a large file — extract focused section to help it find the right old_string.
                            const cmdStr2 = String(args.command ?? '');
                            const pathMatch2 = cmdStr2.match(/['"](.*?)['"]/);
                            const largePath = pathMatch2?.[1] ?? '';
                            const env3 = detectShellEnvironment();
                            if (largePath) {
                                const autoKeywords2 = lastUserMsg
                                    .toLowerCase()
                                    .match(/\b(fail|timeout|retry|auth|login|upload|download|connect|validat)\w*\b/g)
                                    ?.slice(0, 3)
                                    .join('|');
                                const grepPattern2 = autoKeywords2
                                    ? `except|raise|\\.error\\(|\\.critical\\(|${autoKeywords2}`
                                    : 'except|raise|\\.error\\(|\\.critical\\(';
                                const focusedCmd = env3.os === 'windows'
                                    ? `Get-Content "${largePath}" | Select-String -Pattern "${grepPattern2}" -Context 3,3`
                                    : `grep -n -A 3 -B 3 -E "${grepPattern2}" "${largePath}" | head -200`;
                                logInfo(`[agent] Large file read, running focused grep: ${focusedCmd}`);
                                const focusId = `t_focus_${Date.now()}`;
                                post({ type: 'toolCall', id: focusId, name: 'shell_read', args: { command: focusedCmd } });
                                let focusedContent = '';
                                try {
                                    focusedContent = await this.runShellRead(focusedCmd, this.workspaceRoot, focusId);
                                    post({ type: 'toolResult', id: focusId, name: 'shell_read', success: true, preview: focusedContent.slice(0, 150) });
                                } catch (e) {
                                    post({ type: 'toolResult', id: focusId, name: 'shell_read', success: false, preview: String(e) });
                                }
                                if (focusedContent && focusedContent.trim().length > 80) {
                                    const relPath3 = path.relative(this.workspaceRoot, largePath.replace(/\//g, path.sep)).replace(/\\/g, '/');
                                    nudge = `[FOCUSED-READ: ${relPath3}]\n${focusedContent}\n\nThese are the relevant lines (exception/error handling with context). Now call edit_file with path="${relPath3}" and EXACT strings from the lines above. Do NOT search again.`;
                                } else {
                                    nudge = 'You have the file content. The user wants you to MODIFY it. Use the EXACT strings from the output above as old_string in edit_file. Call edit_file NOW — do NOT show changes as a code block.';
                                }
                            } else {
                                nudge = 'You have the file content. The user wants you to MODIFY it. Use the EXACT strings from the output above as old_string in edit_file. Call edit_file NOW — do NOT show changes as a code block.';
                            }
                        } else if (wantsEdit) {
                            nudge = 'You have the file content. The user wants you to MODIFY it. Use the EXACT strings from the output above as old_string in edit_file. Call edit_file NOW — do NOT show changes as a code block.';
                        } else if (isEmptyFileSearch) {
                            const env2 = detectShellEnvironment();
                            const wsRoot = this.workspaceRoot;
                            // Extract filename from the failed command to build a recursive search hint
                            const failedCmd = String(args.command ?? '');
                            const failedFilenameMatch = failedCmd.match(/['"\/\\]([^'"\/\\]+\.[a-z]{2,4})['"]/i);
                            const failedFilename = failedFilenameMatch?.[1] ?? '';
                            const recursiveHint = env2.os === 'windows'
                                ? `Get-ChildItem -Path "${wsRoot}" -Recurse -Filter "${failedFilename || '*.py'}" | Select-Object FullName`
                                : `find "${wsRoot}" -name "${failedFilename || '*.py'}" 2>/dev/null`;
                            nudge = `The path you tried does not exist. The file is not at that location. Search RECURSIVELY to find the correct path:\nshell_read with: ${recursiveHint}\nWorkspace root: "${wsRoot}"`;

                        } else if (/\b(find|where|all|every|places?|used?|locate|show)\b/i.test(this.lastUserMessage ?? '')) {
                            nudge = 'You have the search results. The user asked to FIND something — these results ARE the answer. Summarize what you found. Do NOT read individual files. Answer the user NOW.';
                        } else {
                            nudge = 'The user can see the tool output above. Summarize the result and answer the question. If you need more detail, use shell_read with cat/grep to get specific lines. Do NOT call more tools unless necessary.';
                        }
                    } else if (name === 'workspace_summary') {
                        const stopWords = new Set(['show','me','how','the','a','an','is','are','does','do','what','where','find','explain','describe','works','work','working','this','that','it','in','on','of','for','to','and','or','with','by','from','at','into']);
                        const kws = (this.lastUserMessage ?? '').toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w));
                        const searchTerm = kws.slice(0, 3).join(' ') || (this.lastUserMessage ?? '').slice(0, 40);
                        if (/\b(explain|show|how|where|what|describe)\b/i.test(this.lastUserMessage ?? '')) {
                            nudge = `Good — you have the project overview. Now use shell_read with grep to find "${searchTerm}" in the codebase, then cat the relevant file and answer from the actual code.`;
                        } else {
                            nudge = 'You have the project structure. Now call the appropriate tool to complete the user\'s request.';
                        }
                    } else if ((name === 'memory_list' || name === 'memory_tier_list' || name === 'memory_stats') && /\b(explain|describe|what does|what is|overview|understand|about this project|how does|walk me through|summarize|summary)\b/i.test(this.lastUserMessage ?? '')) {
                        nudge = 'Memory alone does NOT answer the user\'s question — they want to understand the actual codebase. Call workspace_summary NOW to see the project structure, then use shell_read to read key files. Do NOT answer based only on memory notes.';
                    } else {
                        nudge = 'If this result answers the user\'s question, respond to the user NOW with the information. Do NOT call more tools unless absolutely necessary.';
                    }
                    // If the model emitted multiple tool calls, remind it of the remaining ones
                    // so it continues in order rather than rediscovering its own plan
                    let deferredReminder = '';
                    if (deferredCalls.length > 0) {
                        const deferredNames = deferredCalls.map(dc => dc.function.name).join(', ');
                        deferredReminder = `\n\nYou still have ${deferredCalls.length} more tool call(s) to execute in order: ${deferredNames}. Call the NEXT one now.`;
                    }
                    this.history.push({
                        role: 'user',
                        content: `Tool ${name} returned:\n${toolResult}\n---\n${nudge}${deferredReminder}`,
                    });
                } else {
                    this.history.push({ role: 'tool', content: toolResult });
                }
            }
        }

        // If we exhausted all turns without the model producing a final answer, tell the user
        if (loopExhausted && !this.stopRef.stop) {
            logWarn(`[agent] Loop exhausted after ${MAX_TURNS} turns without a final response`);
            post({ type: 'error', text: `Agent stopped after ${MAX_TURNS} tool rounds without a final answer. Try rephrasing your request or start a new chat.` });
        }
    }

    // ── Tool executor ─────────────────────────────────────────────────────────

    private async executeTool(
        name: string,
        args: Record<string, unknown>,
        _toolId: string
    ): Promise<string> {
        const root = this.workspaceRoot;
        if (!root) { return 'No workspace folder is open.'; }

        // Handle MCP tools first
        if (isMCPTool(name)) {
            const parsed = parseMCPToolName(name);
            if (!parsed) {
                throw new Error(`Invalid MCP tool name format: ${name}`);
            }
            logInfo(`[agent] Executing MCP tool: ${parsed.server}.${parsed.tool}`);
            return await callMCPTool(parsed.server, parsed.tool, args);
        }

        switch (name) {

            // ── workspace_summary ──────────────────────────────────────────
            case 'workspace_summary': {
                const summary = await buildWorkspaceSummary(root);
                const env = detectShellEnvironment();
                return `${summary}\n\nHost environment: ${env.label} (shell: ${env.shell}, os: ${env.os})`;
            }

            // ── search_files (legacy — redirects to shell_read hint) ──────
            case 'search_files':
            case 'read_file':
            case 'list_files':
            case 'find_files':
            case 'create_file':
            case 'write_file':
            case 'append_to_file':
            case 'rename_file':
            case 'delete_file': {
                // These tools have been removed. Use shell_read/run_command instead.
                const env2 = detectShellEnvironment();
                const isWin2 = env2.os === 'windows';
                return `The tool "${name}" is no longer available. Use shell commands instead:\n` +
                    `- Read a file: shell_read with ${isWin2 ? 'Get-Content path/to/file' : 'cat path/to/file'}\n` +
                    `- Find files: shell_read with ${isWin2 ? 'Get-ChildItem -Recurse -Filter "*name*"' : 'find . -name "*name*"'}\n` +
                    `- Search content: shell_read with ${isWin2 ? 'Select-String -Path "*.py" -Pattern "keyword"' : 'grep -rn "keyword" --include="*.py" .'}\n` +
                    `- Create/overwrite file: run_command with ${isWin2 ? 'Set-Content' : 'cat > file << EOF'}\n` +
                    `- Move/rename: run_command with ${isWin2 ? 'Move-Item old new' : 'mv old new'}\n` +
                    `- Delete: run_command with ${isWin2 ? 'Remove-Item path' : 'rm path'}`;
            }

            // ── edit_file ──────────────────────────────────────────────────
            case 'edit_file': {
                const rel       = String(args.path ?? '');
                const oldString = String(args.old_string ?? '');
                const newString = String(args.new_string ?? '');

                if (!rel)       { throw new Error('path is required'); }
                if (!oldString) { throw new Error('old_string is required'); }

                const full = this.safePath(root, rel);
                const original = fs.readFileSync(full, 'utf8');

                if (!original.includes(oldString)) {
                    // ── Fuzzy indentation recovery ─────────────────────────────
                    // Small models (7B) often drop leading spaces from the first line
                    // of multi-line old_string values. Try to auto-correct by detecting
                    // the indentation of the first line in the file and re-indenting
                    // every line in old_string by the same delta.
                    const oldLines = oldString.split('\n');
                    const firstLineOldTrimmed = oldLines[0].trim();
                    const fileLines = original.split('\n');
                    const nearLineIdx = fileLines.findIndex(
                        (l) => l.trim() === firstLineOldTrimmed
                    );
                    if (nearLineIdx >= 0) {
                        const fileIndent = fileLines[nearLineIdx].match(/^(\s*)/)?.[1] ?? '';
                        const modelIndent = oldLines[0].match(/^(\s*)/)?.[1] ?? '';
                        if (fileIndent !== modelIndent) {
                            // Re-indent every old_string line by (fileIndent - modelIndent) delta
                            const delta = fileIndent.length - modelIndent.length;
                            const reindented = oldLines.map((line, i) => {
                                if (i === 0) { return fileIndent + line.trimStart(); }
                                // For subsequent lines, shift by same delta, clamping at 0
                                const lineIndent = line.match(/^(\s*)/)?.[1] ?? '';
                                const newIndentLen = Math.max(0, lineIndent.length + delta);
                                return ' '.repeat(newIndentLen) + line.trimStart();
                            }).join('\n');
                            if (original.includes(reindented)) {
                                // Auto-corrected — apply silently
                                const newContent2 = original.replace(reindented, newString.split('\n').map((line, i) => {
                                    if (i === 0) { return fileIndent + line.trimStart(); }
                                    const lineIndent = line.match(/^(\s*)/)?.[1] ?? '';
                                    const newIndentLen = Math.max(0, lineIndent.length + delta);
                                    return ' '.repeat(newIndentLen) + line.trimStart();
                                }).join('\n'));
                                const occurrences2 = (original.split(reindented).length - 1);
                                if (occurrences2 === 1) {
                                    // Apply the auto-corrected edit
                                    const isAutoApproved2 = this._autoApprovedTools.has('edit_file');
                                    if (!isAutoApproved2) {
                                        await this.diffViewManager.showDiffPreview(full, original, newContent2);
                                    }
                                    const accepted2 = await this.requestConfirmation('edit', `Edit "${rel}" — ${oldLines.length} line(s) changed (auto-corrected indentation)`, 'edit_file');
                                    if (!isAutoApproved2) {
                                        this.diffViewManager.closeDiffPreview();
                                    }
                                    if (!accepted2) { return 'Edit cancelled by user.'; }
                                    fs.writeFileSync(full, newContent2, 'utf8');
                                    this._lastFileOp = { path: rel, originalContent: original, action: 'edited' };
                                    this.postFn({ type: 'fileChanged', path: rel, action: 'edited' });
                                    const editResult2 = `Edited: ${rel} — ${oldLines.length} line(s) replaced (indentation auto-corrected)`;
                                    const editDiags2 = this.getDiagnostics(root, rel);
                                    if (editDiags2 !== 'No errors or warnings found.') {
                                        return `${editResult2}\n\nDiagnostics after edit:\n${editDiags2}`;
                                    }
                                    return editResult2;
                                }
                            }
                        }
                        const hint = ` First line found at line ${nearLineIdx + 1}, but the full block didn't match — check indentation.`;
                        throw new Error(`edit_file: old_string not found in ${rel}.${hint} Re-read the file and try again.`);
                    }
                    throw new Error(`edit_file: old_string not found in ${rel}. The first line of old_string was not found in the file. Re-read the file and try again.`);
                }

                // Ensure the match is unique to avoid unintended replacements
                const occurrences = (original.split(oldString).length - 1);
                if (occurrences > 1) {
                    throw new Error(
                        `edit_file: old_string matches ${occurrences} locations in ${rel}. ` +
                        `Add more surrounding context to make it unique.`
                    );
                }

                const newContent = original.replace(oldString, newString);

                // Open diff view for review, then ask for confirmation in chat.
                // Skip the diff preview when auto-approved (e.g., "Accept All") — no point
                // flashing it open and immediately closed for every edit in a batch.
                const isAutoApproved = this._autoApprovedTools.has('edit_file');
                if (!isAutoApproved) {
                    await this.diffViewManager.showDiffPreview(full, original, newContent);
                }
                const accepted = await this.requestConfirmation('edit', `Edit "${rel}" — ${oldString.split('\n').length} line(s) changed`, 'edit_file');
                if (!isAutoApproved) {
                    this.diffViewManager.closeDiffPreview();
                }

                if (!accepted) { return 'Edit cancelled by user.'; }

                fs.writeFileSync(full, newContent, 'utf8');
                this._lastFileOp = { path: rel, originalContent: original, action: 'edited' };
                this.postFn({ type: 'fileChanged', path: rel, action: 'edited' });
                const editResult = `Edited: ${rel} — ${oldString.split('\n').length} line(s) replaced with ${newString.split('\n').length} line(s)`;
                // Auto-check diagnostics after edit
                const editDiags = this.getDiagnostics(root, rel);
                if (editDiags !== 'No errors or warnings found.') {
                    return `${editResult}\n\nDiagnostics after edit:\n${editDiags}`;
                }
                return editResult;
            }

            // ── edit_file_at_line ──────────────────────────────────────────
            case 'edit_file_at_line': {
                const rel2       = String(args.path ?? '');
                const startLine  = Math.round(Number(args.start_line ?? 0));
                const endLine    = Math.round(Number(args.end_line ?? 0));
                const newContent = String(args.new_content ?? '');

                if (!rel2)        { throw new Error('path is required'); }
                if (!startLine)   { throw new Error('start_line is required'); }
                if (endLine < startLine - 1) { throw new Error(`end_line (${endLine}) must be >= start_line - 1 (${startLine - 1})`); }

                const full2    = this.safePath(root, rel2);
                const original2 = fs.readFileSync(full2, 'utf8');
                const lines2   = original2.split('\n');
                const totalLines = lines2.length;

                if (startLine < 1 || startLine > totalLines + 1) {
                    throw new Error(`start_line ${startLine} is out of range (file has ${totalLines} lines)`);
                }

                // Build new file: lines before start, new_content, lines after end
                const before  = lines2.slice(0, startLine - 1);
                const after   = endLine >= startLine ? lines2.slice(endLine) : lines2.slice(startLine - 1);
                const newLines = newContent === '' ? [] : newContent.split('\n');
                const newFile  = [...before, ...newLines, ...after].join('\n');

                const replacedCount = endLine >= startLine ? endLine - startLine + 1 : 0;
                const action = replacedCount === 0 ? 'insert' : 'replace';

                const isAutoApproved3 = this._autoApprovedTools.has('edit_file_at_line');
                if (!isAutoApproved3) {
                    await this.diffViewManager.showDiffPreview(full2, original2, newFile);
                }
                const detail3 = action === 'insert'
                    ? `Insert ${newLines.length} line(s) at line ${startLine} in "${rel2}"`
                    : `Replace lines ${startLine}-${endLine} (${replacedCount} line(s)) in "${rel2}"`;
                const accepted3 = await this.requestConfirmation('edit', detail3, 'edit_file_at_line');
                if (!isAutoApproved3) { this.diffViewManager.closeDiffPreview(); }
                if (!accepted3) { return 'Edit cancelled by user.'; }

                fs.writeFileSync(full2, newFile, 'utf8');
                this._lastFileOp = { path: rel2, originalContent: original2, action: 'edited' };
                this.postFn({ type: 'fileChanged', path: rel2, action: 'edited' });
                const editResult3 = action === 'insert'
                    ? `Inserted ${newLines.length} line(s) at line ${startLine} in ${rel2}`
                    : `Replaced lines ${startLine}-${endLine} with ${newLines.length} line(s) in ${rel2}`;
                const editDiags3 = this.getDiagnostics(root, rel2);
                if (editDiags3 !== 'No errors or warnings found.') {
                    return `${editResult3}\n\nDiagnostics after edit:\n${editDiags3}`;
                }
                return editResult3;
            }

            // ── shell_read ─────────────────────────────────────────────────
            case 'shell_read': {
                let cmd = String(args.command ?? '');
                if (!cmd) { throw new Error('command is required'); }

                // Auto-fix forward slashes in Windows path arguments (not flags like /S /N /I)
                if (process.platform === 'win32') {
                    if (/\b(dir|tree|type|findstr|where)\b/i.test(cmd) && cmd.includes('/') && !cmd.includes('://')) {
                        // Only replace slashes that are part of file paths, not command flags.
                        // Flags look like: /S /N /I /R (single letter after /)
                        // Paths look like: app/routes/admin.py, src/main.ts
                        const fixed = cmd.replace(/\//g, (match, offset) => {
                            // Keep flag-style switches: space or start followed by /letter
                            const before = cmd[offset - 1];
                            const after = cmd[offset + 1];
                            if ((!before || before === ' ' || before === '\t') && after && /[A-Za-z]/.test(after)) {
                                // Check if it's a single-letter flag (next char after letter is space/end)
                                const afterLetter = cmd[offset + 2];
                                if (!afterLetter || afterLetter === ' ' || afterLetter === '\t') {
                                    return '/'; // Keep as flag
                                }
                            }
                            return '\\';
                        });
                        if (fixed !== cmd) {
                            logInfo(`[shell_read] Auto-fixed Windows paths: "${cmd}" → "${fixed}"`);
                            cmd = fixed;
                        }
                    }
                }

                // Block commands that modify state
                const WRITE_PATTERNS = [
                    /\brm\b/, /\bdel\b/, /\bmkdir\b/, /\brmdir\b/,
                    /\bmv\b/, /\bcp\b/, /\bmove\b/, /\bcopy\b/,
                    /\bnpm\s+(install|i|ci|uninstall|update|run|exec|start)\b/,
                    /\byarn\s+(add|remove|install|run|start)\b/,
                    /\bpip\s+(install|uninstall)\b/,
                    /\bpnpm\s+(add|remove|install|run|start)\b/,
                    /\bcargo\s+(build|run|install)\b/,
                    /\bmake\b/, /\bcmake\b/,
                    /\bgit\s+(push|commit|merge|rebase|reset|checkout\s+-b|branch\s+-[dD]|stash\s+drop|clean)\b/,
                    /\btee\b/, /\bsed\s+-i\b/,
                    /\bchmod\b/, /\bchown\b/,
                    /\bkill\b/, /\bpkill\b/,
                    /\bdocker\s+(run|build|push|rm|stop|kill)\b/,
                    /\bsudo\b/,
                    /(?:^|\s)>[^|]/, // redirect to file (not inside quotes)
                ];
                for (const pattern of WRITE_PATTERNS) {
                    if (pattern.test(cmd)) {
                        throw new Error(`shell_read blocked: "${cmd}" looks like a write/modify command. Use run_command instead.`);
                    }
                }

                return this.runShellRead(cmd, root, _toolId);
            }

            // ── run_command ────────────────────────────────────────────────
            case 'run_command': {
                let cmd = String(args.command ?? '');
                if (!cmd) { throw new Error('command is required'); }

                // Auto-fix forward slashes in path arguments on Windows (not flags like /S /N)
                if (process.platform === 'win32') {
                    if (/\b(mkdir|move|copy|del|rmdir|ren|rename|type|tree|dir)\b/i.test(cmd) && cmd.includes('/') && !cmd.includes('://')) {
                        const fixed = cmd.replace(/\//g, (match, offset) => {
                            const before = cmd[offset - 1];
                            const after = cmd[offset + 1];
                            if ((!before || before === ' ' || before === '\t') && after && /[A-Za-z]/.test(after)) {
                                const afterLetter = cmd[offset + 2];
                                if (!afterLetter || afterLetter === ' ' || afterLetter === '\t') {
                                    return '/'; // Keep as flag
                                }
                            }
                            return '\\';
                        });
                        if (fixed !== cmd) {
                            logInfo(`[run_command] Auto-fixed Windows paths: "${cmd}" → "${fixed}"`);
                            cmd = fixed;
                        }
                    }
                    // Auto-fix chained mkdir on Windows: "mkdir a && mkdir b" fails if a exists.
                    // Convert to individual mkdir calls that ignore "already exists" errors.
                    const mkdirChainMatch = cmd.match(/^\s*mkdir\s+.+&&\s*mkdir\s+/i);
                    if (mkdirChainMatch) {
                        const dirs = cmd.split(/\s*&&\s*/)
                            .map(c => c.trim())
                            .filter(c => /^mkdir\s+/i.test(c))
                            .map(c => c.replace(/^mkdir\s+/i, '').trim());
                        if (dirs.length > 1) {
                            // Use "(mkdir X 2>nul) & ... & echo done" to ignore errors and force exit 0
                            cmd = dirs.map(d => `(mkdir ${d} 2>nul)`).join(' & ') + ' & echo done';
                            logInfo(`[run_command] Auto-fixed chained mkdir: ${dirs.length} dirs, ignoring existing`);
                        }
                    }
                }

                // Safety: reject obviously dangerous patterns
                const DANGEROUS = [
                    /\brm\s+-rf\s+\//, /\bmkfs\b/, /\bdd\s+if=/,
                    /:\(\)\{.*\}/, /\bformat\s+c:/i,
                ];
                for (const pattern of DANGEROUS) {
                    if (pattern.test(cmd)) {
                        throw new Error(`Blocked: command matches dangerous pattern (${pattern.toString()})`);
                    }
                }

                const accepted = await this.requestConfirmation('run', cmd, 'run_command');
                if (!accepted) { return 'Command cancelled by user.'; }

                return this.runCommandStreaming(cmd, root, _toolId);
            }

            // ── memory_list ────────────────────────────────────────────────
            case 'memory_list': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                return `Project memory notes:\n\n${this.memory.formatTiers([0, 1, 2, 3, 4, 5])}`;
            }

            // ── memory_write (legacy — delegates to memory_tier_write with auto-classification) ──
            case 'memory_write': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                const content = String(args.content ?? '');
                const tag     = args.tag ? String(args.tag) : undefined;
                if (!content.trim()) { throw new Error('content is required'); }
                // Auto-classify tier based on content
                const hasInfra = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/.test(content)
                    || /https?:\/\//.test(content) || /\bport\s+\d{2,5}\b/i.test(content);
                const autoTier: 0|1|2 = hasInfra ? 0 : (tag === 'architecture' || tag === 'framework' || tag === 'tool') ? 1 : 2;
                const note = await this.memory.addEntry(autoTier, content, tag ? [tag] : undefined);
                const tierName = ['Critical', 'Essential', 'Operational'][autoTier];
                return `Note saved to Tier ${autoTier} (${tierName}, id: ${note.id}). Use memory_list to view all notes.`;
            }

            // ── memory_delete ──────────────────────────────────────────────
            case 'memory_delete': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                const id = String(args.id ?? '');
                if (!id) { throw new Error('id is required'); }
                const ok = await this.memory.deleteEntry(id);
                if (ok) { return `Deleted note ${id}.`; }
                // List actual IDs so the model can self-correct
                const idLines: string[] = [];
                for (let t = 0; t <= 5; t++) {
                    for (const e of this.memory.getTier(t as 0|1|2|3|4|5)) {
                        idLines.push(`  ${e.id} — Tier ${t}: ${e.content.slice(0, 60)}`);
                        if (idLines.length >= 30) { break; }
                    }
                    if (idLines.length >= 30) { break; }
                }
                return `Note ${id} not found. Available entries:\n${idLines.join('\n')}\n\nCall memory_delete again with the correct id from above.`;
            }

            // ── memory_search ───────────────────────────────────────────────
            case 'memory_search': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                const query = String(args.query ?? '');
                if (!query.trim()) { throw new Error('query is required'); }
                
                const tier = args.tier !== undefined ? Number(args.tier) : undefined;
                const limit = args.limit !== undefined ? Number(args.limit) : undefined;
                
                const results = await this.memory.searchMemory(query, tier, limit);
                
                if (results.length === 0) {
                    return `No relevant memories found for "${query}".`;
                }
                
                let output = `Semantic search results for "${query}" (${results.length} found):\n\n`;
                results.forEach((entry, i) => {
                    const score = entry.relevanceScore ? ` (relevance: ${(entry.relevanceScore * 100).toFixed(0)}%)` : '';
                    const tags = entry.tags && entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
                    output += `[${i + 1}] Tier ${entry.tier}${tags}${score}\n`;
                    output += `${entry.content}\n\n`;
                });
                
                return output.trim();
            }

            // ── memory_tier_write ──────────────────────────────────────────────
            case 'memory_tier_write': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                const tier = Number(args.tier ?? 2);
                const content = String(args.content ?? '');
                const tags = args.tags ? (args.tags as string[]) : undefined;
                
                if (tier < 0 || tier > 5) { throw new Error('tier must be 0-5'); }
                if (!content.trim()) { throw new Error('content is required'); }

                // Rate-limit: max 3 memory writes per agent response
                if (this.memoryWritesThisResponse >= Agent.MAX_MEMORY_WRITES_PER_RESPONSE) {
                    return `Rate limited: already saved ${this.memoryWritesThisResponse} entries this response. Try again in the next message.`;
                }

                // Tier 0 validation: must contain actual infrastructure data
                if (tier === 0) {
                    const hasIP = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d?)\.)(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){2}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/.test(content);
                    const hasURL = /https?:\/\/[^\s]+/.test(content);
                    const hasPath = /^[\/~]|[A-Z]:\\/.test(content);
                    const hasPort = /(?:port\s*[:=]?\s*\d{2,5}|:\d{2,5}\b)/.test(content);
                    const hasCredential = /(?:key|token|password|secret|credential)/i.test(content);
                    if (!hasIP && !hasURL && !hasPath && !hasPort && !hasCredential) {
                        return `Tier 0 is reserved for critical infrastructure (IPs, URLs, ports, paths, credentials). "${content.slice(0, 60)}" doesn't match. Use Tier 1 for frameworks/tools or Tier 2 for operational context.`;
                    }
                }

                // Content quality: reject very short or generic entries
                if (content.trim().length < 5) {
                    return `Content too short. Memory entries should be meaningful and specific.`;
                }

                // Garbage filter: reject entries matching known junk patterns
                if (GARBAGE_PATTERNS.some(p => p.test(content))) {
                    logInfo(`[memory] Garbage-filtered: "${content.slice(0, 60)}"`);
                    return `Filtered: content matches a known low-value pattern. Save only specific, actionable facts.`;
                }

                // Semantic dedup: reject if too similar to existing memory
                try {
                    const isDupe = await this.memory.isSemanticDuplicate(content, 0.80);
                    if (isDupe) {
                        logInfo(`[memory] Semantic-deduped: "${content.slice(0, 60)}"`);
                        return `Duplicate: a semantically similar entry already exists in memory.`;
                    }
                } catch {
                    // Qdrant unavailable — skip semantic check, allow save
                }
                
                const note = await this.memory.addEntry(tier as 0|1|2|3|4|5, content, tags);
                this.memoryWritesThisResponse++;
                const tierName = ['Critical', 'Essential', 'Operational', 'Collaboration', 'References', 'Archive'][tier];
                return `Note saved to Tier ${tier} (${tierName}) with id: ${note.id}.`;
            }

            // ── memory_tier_list ──────────────────────────────────────────────
            case 'memory_tier_list': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                // Accept both 'tiers' (correct) and 'tier' (common model mistake)
                let tiers: number[];
                if (args.tiers) {
                    tiers = args.tiers as number[];
                } else if (args.tier !== undefined) {
                    // Model passed singular 'tier' — convert to array
                    tiers = Array.isArray(args.tier) ? args.tier as number[] : [Number(args.tier)];
                } else {
                    tiers = [0, 1, 2, 3, 4, 5];
                }
                return `Memory from tiers ${tiers.join(', ')}:\n\n${this.memory.formatTiers(tiers)}`;
            }

            // ── memory_stats ────────────────────────────────────────────────
            case 'memory_stats': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                const stats = this.memory.getStats();
                const totalEntries = stats.reduce((sum, s) => sum + s.count, 0);
                const totalTokens = stats.reduce((sum, s) => sum + s.tokens, 0);
                
                let output = 'Memory Statistics:\n\n';
                stats.forEach(s => {
                    output += `Tier ${s.tier} (${s.name}): ${s.count} entries, ~${s.tokens} tokens\n`;
                });
                output += `\nTotal: ${totalEntries} entries, ~${totalTokens} tokens`;
                
                return output;
            }

            // ── read_terminal ──────────────────────────────────────────────────
            case 'read_terminal': {
                const idx = args.index !== undefined ? Number(args.index) : undefined;
                return this.readTerminal(idx);
            }

            // ── get_diagnostics ────────────────────────────────────────────────
            case 'get_diagnostics': {
                const rel = args.path ? String(args.path) : undefined;
                return this.getDiagnostics(root, rel);
            }

            // ── refactor_multi_file ────────────────────────────────────────────
            case 'refactor_multi_file': {
                const title = String(args.title ?? '');
                const description = String(args.description ?? '');
                const changes = args.changes as any[];

                if (!title || !description || !changes || !Array.isArray(changes)) {
                    throw new Error('title, description, and changes array are required');
                }

                if (changes.length === 0) {
                    throw new Error('changes array cannot be empty');
                }

                // Build refactoring plan
                const plan: RefactoringPlan = {
                    title,
                    description,
                    changes: changes.map(c => ({
                        path: String(c.path ?? ''),
                        oldContent: String(c.old_content ?? ''),
                        newContent: String(c.new_content ?? ''),
                        description: c.description ? String(c.description) : undefined,
                    })),
                };

                // Validate all paths
                for (const change of plan.changes) {
                    if (!change.path) {
                        throw new Error('Each change must have a path');
                    }
                    const fullPath = this.safePath(root, change.path);
                    if (!fs.existsSync(fullPath)) {
                        throw new Error(`File not found: ${change.path}`);
                    }
                }

                // Show preview and get approval
                const approved = await this.refactorManager.showRefactoringPlan(plan);

                if (!approved) {
                    return 'Multi-file refactoring cancelled by user.';
                }

                // Apply changes
                const result = await this.refactorManager.applyRefactoring(plan, root);

                if (result.failed > 0) {
                    return `Refactoring partially applied: ${result.success} succeeded, ${result.failed} failed. Check the output for details.`;
                }

                // Notify about file changes
                plan.changes.forEach(c => {
                    this.postFn({ type: 'fileChanged', path: c.path, action: 'refactored' });
                });

                return `Refactoring complete: ${result.success} file(s) modified successfully.`;
            }

            default:
                throw new Error(`Unknown tool: "${name}". Available tools: ${TOOL_DEFINITIONS.map((t) => (t as { function: { name: string } }).function.name).join(', ')}`);
        }
    }

    // ── Streaming command execution ───────────────────────────────────────────

    private runCommandStreaming(cmd: string, cwd: string, cmdId: string): Promise<string> {
        return new Promise((resolve) => {
            const post = this.postFn;
            post({ type: 'commandStart', id: cmdId, cmd });

            // On Windows, PowerShell cmdlets must run via powershell.exe, not cmd.exe.
            const isPSCmd = process.platform === 'win32'
                && /Get-ChildItem|Get-Content|Select-Object|Select-String|Where-Object|ForEach-Object|New-Item|Remove-Item|Move-Item|Copy-Item|Test-Path|Write-Host|\$_|\$PSItem/.test(cmd);
            const child = isPSCmd
                ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd, env: { ...process.env } })
                : spawn(cmd, { cwd, env: { ...process.env }, shell: true });
            this.trackChild(child);

            let output = '';
            let finished = false;
            const LIMIT = 8000;

            child.stdout?.on('data', (data: Buffer) => {
                const text = data.toString();
                output += text;
                if (output.length <= LIMIT) {
                    post({ type: 'commandChunk', id: cmdId, text, stream: 'stdout' });
                }
            });

            child.stderr?.on('data', (data: Buffer) => {
                const text = data.toString();
                output += text;
                if (output.length <= LIMIT) {
                    post({ type: 'commandChunk', id: cmdId, text, stream: 'stderr' });
                }
            });

            const finish = (code: number | null) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                const exitCode = code ?? 0;
                post({ type: 'commandEnd', id: cmdId, exitCode });
                logInfo(`Command exited ${exitCode}: ${cmd}`);
                const result = output.slice(0, LIMIT) || `(exited with code ${exitCode})`;
                resolve(result);
            };

            child.on('close', finish);
            child.on('error', (err) => {
                post({ type: 'commandChunk', id: cmdId, text: `\nError: ${err.message}`, stream: 'stderr' });
                finish(-1);
            });

            // Hard timeout: 60 s
            const timer = setTimeout(() => {
                if (!finished) {
                    child.kill();
                    post({ type: 'commandChunk', id: cmdId, text: '\n(timed out after 60s)', stream: 'stderr' });
                    finish(-1);
                }
            }, 60_000);
        });
    }

    // ── Read-only shell execution (no confirmation) ──────────────────────────

    private runShellRead(cmd: string, cwd: string, cmdId: string): Promise<string> {
        return new Promise((resolve) => {
            const post = this.postFn;
            post({ type: 'commandStart', id: cmdId, cmd });

            // On Windows, PowerShell cmdlets must run via powershell.exe, not cmd.exe.
            // Detect PowerShell commands and spawn accordingly.
            const isPowerShellCmd = process.platform === 'win32'
                && /Get-ChildItem|Get-Content|Select-Object|Select-String|Where-Object|ForEach-Object|New-Item|Remove-Item|Move-Item|Copy-Item|Test-Path|Write-Host|Out-Host|\$_|\$PSItem/.test(cmd);
            const spawnArgs: [string, string[], object] = isPowerShellCmd
                ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd, env: { ...process.env } }]
                : [cmd, [], { cwd, env: { ...process.env }, shell: true }];
            const child = spawn(...spawnArgs);
            this.trackChild(child);

            let output = '';
            let finished = false;
            const LIMIT = 16_000; // Higher limit for read-only — no risk

            child.stdout?.on('data', (data: Buffer) => {
                const text = data.toString();
                output += text;
                if (output.length <= LIMIT) {
                    post({ type: 'commandChunk', id: cmdId, text, stream: 'stdout' });
                }
            });

            child.stderr?.on('data', (data: Buffer) => {
                const text = data.toString();
                output += text;
                if (output.length <= LIMIT) {
                    post({ type: 'commandChunk', id: cmdId, text, stream: 'stderr' });
                }
            });

            const finish = (code: number | null) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                post({ type: 'commandEnd', id: cmdId, exitCode: code ?? 0 });
                let result = output.slice(0, LIMIT) || `(exited with code ${code ?? 0})`;
                // Append cwd to empty/near-empty file search results so the model
                // knows which directory was searched — helps diagnose workspace mismatches
                const isFileSearch = /Get-ChildItem|find\s|dir\s/i.test(cmd);
                const looksEmpty = result.length < 150 && !/error/i.test(result);
                if (isFileSearch && looksEmpty) {
                    result += `\n(searched in: ${cwd})`;
                }
                resolve(result);
            };

            child.on('close', finish);
            child.on('error', (err) => {
                post({ type: 'commandChunk', id: cmdId, text: `\nError: ${err.message}`, stream: 'stderr' });
                finish(-1);
            });

            const timer = setTimeout(() => {
                if (!finished) {
                    child.kill();
                    post({ type: 'commandChunk', id: cmdId, text: '\n(timed out after 30s)', stream: 'stderr' });
                    finish(-1);
                }
            }, 30_000);
        });
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    private readTerminal(index?: number): string {
        const terminals = vscode.window.terminals;
        if (!terminals.length) { return 'No terminals are open in VS Code.'; }

        const terminal = index !== undefined
            ? terminals[index]
            : vscode.window.activeTerminal ?? terminals[terminals.length - 1];

        if (!terminal) { return `Terminal index ${index} not found. ${terminals.length} terminal(s) open.`; }

        // shellIntegration (VS Code 1.93+) provides recent command output
        const si = (terminal as any).shellIntegration;
        if (si?.executedCommands) {
            try {
                const cmds = Array.from(si.executedCommands as Iterable<any>);
                const recent = cmds.slice(-5);
                const MAX = 8192;
                let output = `Terminal: ${terminal.name}\n`;
                for (const cmd of recent) {
                    const text = cmd.output?.trim() ?? '';
                    if (text) {
                        output += `\n$ ${cmd.command ?? '(unknown)'}\n${text}\n`;
                    }
                    if (output.length > MAX) { break; }
                }
                return output.slice(0, MAX) || `Terminal "${terminal.name}" — no recent output captured.`;
            } catch {
                // Fall through to fallback
            }
        }

        // Fallback: list terminals and suggest run_command
        const list = terminals.map((t, i) => `  [${i}] ${t.name}`).join('\n');
        return `Cannot read terminal output directly (requires VS Code 1.93+ shell integration).\n\nOpen terminals:\n${list}\n\nTip: Use run_command to execute a command and capture its output.`;
    }

    private getDiagnostics(root: string, relPath?: string): string {
        const lines: string[] = [];

        // When a specific file is requested, resolve its URI and query directly
        if (relPath) {
            const normalizedRel = relPath.replace(/\\/g, '/');
            const fullPath = path.resolve(root, normalizedRel);
            const uri = vscode.Uri.file(fullPath);
            const diags = vscode.languages.getDiagnostics(uri);
            for (const d of diags) {
                if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
                const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
                lines.push(`${normalizedRel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev} ${d.message}`);
            }
            return lines.length ? lines.join('\n') : 'No errors or warnings found.';
        }

        // No specific file — iterate all diagnostics in the workspace
        const allDiags = vscode.languages.getDiagnostics();
        for (const [uri, diags] of allDiags) {
            const filePath = uri.fsPath;
            if (!filePath.startsWith(root)) { continue; }
            const rel = path.relative(root, filePath).replace(/\\/g, '/');

            for (const d of diags) {
                if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
                const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
                lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev} ${d.message}`);
            }
            if (lines.length >= 100) { break; }
        }

        return lines.length ? lines.join('\n') : 'No errors or warnings found.';
    }

    private safePath(root: string, rel: string): string {
        const full = path.resolve(root, rel);
        // Use case-insensitive comparison on Windows (paths may differ in drive letter case)
        const fullNorm = process.platform === 'win32' ? full.toLowerCase() : full;
        const rootNorm = process.platform === 'win32' ? root.toLowerCase() : root;
        if (!fullNorm.startsWith(rootNorm)) {
            throw new Error(`Path "${rel}" is outside the workspace`);
        }
        // Resolve symlinks to prevent escaping workspace via symlink
        try {
            const real = fs.realpathSync(full);
            const realNorm = process.platform === 'win32' ? real.toLowerCase() : real;
            const rootReal = fs.realpathSync(root);
            const rootRealNorm = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
            if (!realNorm.startsWith(rootRealNorm)) {
                throw new Error(`Path "${rel}" resolves outside the workspace via symlink`);
            }
        } catch (err) {
            // realpathSync throws if file doesn't exist yet — that's OK
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }
        return full;
    }

    // ── Auto-extract facts from conversation for memory ─────────────────────

    // ── Auto-extract: patterns that require USER INTENT context ─────────────

    /** Phrases that indicate the user is stating a project fact (not just mentioning something) */
    private static readonly INTENT_PATTERNS: RegExp[] = [
        /\b(?:we|i|our project|this project|the project)\s+(?:use|uses|using|run|runs|running|deploy|deploys|host|hosts)\s+/i,
        /\b(?:built with|written in|powered by|running on|deployed (?:on|to|at|via)|hosted (?:on|at))\s+/i,
        /\b(?:the|our)\s+(?:server|database|db|api|app|service|backend|frontend)\s+(?:is|runs|lives)\s+(?:at|on)\s+/i,
        /\b(?:remember|save|note|store)\s*(?:that|:)?\s+/i,
        /\b(?:always|never|convention|standard|rule)\s*(?::|—)?\s+/i,
    ];

    /** Negative context — if these surround a keyword, skip it */
    private static readonly NEGATIVE_CONTEXT: RegExp[] = [
        /\b(?:don'?t|doesn'?t|not|never|no longer|instead of|unlike|without|avoid|removed|dropped|migrated (?:away|from))\s+/i,
        /\b(?:compared to|versus|vs\.?|alternative to|rather than)\s+/i,
    ];

    /** IP pattern that excludes version-like strings (X.Y.Z where all < 100) */
    private static readonly IP_WITH_CONTEXT = /\b(?:(?:server|host|address|ip|connect(?:ion)?|running|deployed|at|on)\s+(?:is\s+)?)?(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d?)\.)(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){2}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?::\d{2,5})?\b/gi;

    /** URL pattern that requires infrastructure context */
    private static readonly URL_WITH_CONTEXT = /\b(?:(?:server|api|endpoint|service|deployed|hosted|running|available|connect)\s+(?:at|on|is)\s+)?https?:\/\/[^\s"'<>)\]]+/gi;

    /** Port pattern that requires explicit "on port" / "port:" context */
    private static readonly PORT_WITH_CONTEXT = /\b(?:(?:on|listening|running|connect)\s+)?port\s+(\d{2,5})\b/gi;

    /** Known technology names (same set, used only with intent context now) */
    private static readonly KNOWN_TECHNOLOGIES = new Set([
        'react', 'vue', 'angular', 'svelte', 'next.js', 'nuxt', 'express', 'fastify', 'koa', 'hapi',
        'django', 'flask', 'fastapi', 'rails', 'spring', 'laravel', 'symfony', 'gin', 'echo', 'fiber',
        'typescript', 'javascript', 'python', 'rust', 'golang', 'java', 'kotlin', 'swift', 'ruby', 'php',
        'node.js', 'nodejs', 'deno', 'bun',
        'postgresql', 'postgres', 'mysql', 'mariadb', 'mongodb', 'redis', 'sqlite', 'dynamodb', 'cassandra',
        'docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'nginx', 'apache', 'caddy', 'traefik',
        'webpack', 'vite', 'esbuild', 'rollup', 'parcel', 'turbopack',
        'jest', 'mocha', 'pytest', 'vitest', 'cypress', 'playwright',
        'eslint', 'prettier', 'ruff', 'black', 'flake8', 'pylint', 'mypy',
        'prisma', 'sequelize', 'typeorm', 'drizzle', 'sqlalchemy', 'alembic',
        'graphql', 'grpc', 'rest', 'websocket',
        'tailwind', 'bootstrap', 'material-ui', 'chakra',
        'celery', 'rabbitmq', 'kafka', 'nats',
        'sentry', 'datadog', 'grafana', 'prometheus',
        'gunicorn', 'uvicorn', 'pm2', 'supervisor',
    ]);

    /** Track memory writes this response to enforce rate limit */
    private memoryWritesThisResponse = 0;
    private static readonly MAX_MEMORY_WRITES_PER_RESPONSE = 3;

    /**
     * Scan ONLY the user message for extractable facts.
     * Requires intent context ("we use X", "server is at X") — bare keyword mentions are ignored.
     * Skips negative context ("we don't use X", "instead of X").
     */
    private async autoExtractFacts(userMessage: string, _assistantResponse: string): Promise<void> {
        if (!this.memory) { return; }

        // Only extract from user message — assistant responses are too noisy
        const text = userMessage;
        if (text.length < 10) { return; } // Too short to contain meaningful facts

        // Quick pre-check: skip if no extractable patterns exist at all
        const hasAnyPattern = Agent.INTENT_PATTERNS.some(p => p.test(text))
            || Agent.IP_WITH_CONTEXT.test(text)
            || Agent.URL_WITH_CONTEXT.test(text)
            || Agent.PORT_WITH_CONTEXT.test(text);
        // Reset lastIndex after test() calls on global regexes
        Agent.IP_WITH_CONTEXT.lastIndex = 0;
        Agent.URL_WITH_CONTEXT.lastIndex = 0;
        Agent.PORT_WITH_CONTEXT.lastIndex = 0;
        if (!hasAnyPattern) { return; }

        const existingContext = this.memory.buildContext([0, 1, 2, 3, 4], 8000).toLowerCase();
        const saves: Array<{ tier: 0|1|2|3|4|5; content: string; tags: string[] }> = [];

        // Check if user message has any intent signals at all
        const hasIntent = Agent.INTENT_PATTERNS.some(p => p.test(text));
        // Check for negative context
        const hasNegative = (surrounding: string) =>
            Agent.NEGATIVE_CONTEXT.some(p => p.test(surrounding));

        // ── Extract IPs with context ──────────────────────────────────────
        Agent.IP_WITH_CONTEXT.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = Agent.IP_WITH_CONTEXT.exec(text)) !== null) {
            // Extract just the IP portion
            const ipMatch = match[0].match(/(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d?)\.)(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){2}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?::\d{2,5})?/);
            if (!ipMatch) { continue; }
            const ip = ipMatch[0];
            // Skip loopback, link-local, and version-like patterns
            if (ip.startsWith('127.') || ip.startsWith('0.') || ip.startsWith('169.254.')) { continue; }
            // Skip if it looks like a version number (all octets < 20)
            const octets = ip.split('.').map(Number);
            if (octets.every(o => o < 20)) { continue; }
            if (existingContext.includes(ip)) { continue; }
            // Check surrounding text for negative context
            const start = Math.max(0, match.index - 30);
            const surrounding = text.slice(start, match.index + match[0].length + 10);
            if (hasNegative(surrounding)) { continue; }
            saves.push({ tier: 0, content: `IP: ${ip}`, tags: ['ip', 'infrastructure'] });
        }

        // ── Extract URLs with context ─────────────────────────────────────
        Agent.URL_WITH_CONTEXT.lastIndex = 0;
        while ((match = Agent.URL_WITH_CONTEXT.exec(text)) !== null) {
            const url = match[0].replace(/^.*?(https?:)/, '$1'); // Strip leading context words
            if (url.length < 10 || url.length > 200) { continue; }
            // Skip Ollama default, localhost dev servers, github/docs links
            if (/localhost:11434/.test(url)) { continue; }
            if (/github\.com|stackoverflow\.com|docs\.|npmjs\.com|pypi\.org/.test(url)) { continue; }
            if (existingContext.includes(url.toLowerCase())) { continue; }
            const start = Math.max(0, match.index - 30);
            const surrounding = text.slice(start, match.index + match[0].length + 10);
            if (hasNegative(surrounding)) { continue; }
            saves.push({ tier: 0, content: `URL: ${url}`, tags: ['url', 'infrastructure'] });
        }

        // ── Extract ports with context ────────────────────────────────────
        Agent.PORT_WITH_CONTEXT.lastIndex = 0;
        while ((match = Agent.PORT_WITH_CONTEXT.exec(text)) !== null) {
            const port = match[1];
            if (!port || existingContext.includes(`port ${port}`) || existingContext.includes(`:${port}`)) { continue; }
            const start = Math.max(0, match.index - 30);
            const surrounding = text.slice(start, match.index + match[0].length + 10);
            if (hasNegative(surrounding)) { continue; }
            saves.push({ tier: 0, content: `Port: ${port}`, tags: ['port', 'infrastructure'] });
        }

        // ── Extract technologies ONLY if user states intent ───────────────
        if (hasIntent) {
            const wordsInMsg = text.toLowerCase().split(/[\s,;:()\[\]{}"'`]+/);
            for (const word of wordsInMsg) {
                if (!Agent.KNOWN_TECHNOLOGIES.has(word)) { continue; }
                if (existingContext.includes(word)) { continue; }
                // Find the word's position and check surrounding context
                const wordIdx = text.toLowerCase().indexOf(word);
                if (wordIdx === -1) { continue; }
                const surroundStart = Math.max(0, wordIdx - 40);
                const surrounding = text.slice(surroundStart, wordIdx + word.length + 20);
                if (hasNegative(surrounding)) { continue; }
                if (!saves.some(s => s.content.toLowerCase().includes(word))) {
                    saves.push({ tier: 1, content: `Technology: ${word}`, tags: ['technology'] });
                }
            }
        }

        // Cap at MAX_MEMORY_WRITES_PER_RESPONSE and filter through garbage patterns + semantic dedup
        const toSave = saves
            .filter(s => !GARBAGE_PATTERNS.some(p => p.test(s.content)))
            .slice(0, Agent.MAX_MEMORY_WRITES_PER_RESPONSE);
        for (const entry of toSave) {
            try {
                // Semantic dedup check before saving
                const isDupe = await this.memory.isSemanticDuplicate(entry.content, 0.80);
                if (isDupe) {
                    logInfo(`[auto-memory] Semantic-deduped: ${entry.content.slice(0, 80)}`);
                    continue;
                }
                await this.memory.addEntry(entry.tier, entry.content, entry.tags);
                logInfo(`[auto-memory] Saved to Tier ${entry.tier}: ${entry.content.slice(0, 80)}`);
            } catch (err) {
                logWarn(`[auto-memory] Failed to save: ${toErrorMessage(err)}`);
            }
        }
    }

    // ── Programmatic pre-processing pipelines ─────────────────────────────────

    /**
     * Detect "update imports/paths after reorganization" intent and programmatically
     * discover which modules moved, find all stale imports, compute the correct
     * replacements, and execute edit_file calls — all without involving the model.
     *
     * Returns a summary string for the model to report to the user, or empty string
     * if the intent was not detected or pre-processing failed.
     */
    private async preProcessPathUpdate(userMessage: string, post: PostFn): Promise<string> {
        const msg = userMessage.toLowerCase();
        const hasPathKeyword = /\b(point|location|path|import|reference|reorganiz|moved|new folder|new director)\b/i.test(msg);
        const hasEditKeyword = /\b(edit|update|change|fix|modify|point|adjust|rewrite)\b/i.test(msg);
        if (!hasPathKeyword || !hasEditKeyword) { return ''; }

        const root = this.workspaceRoot;
        if (!root) { return ''; }

        logInfo('[pre-process] Path-update intent detected — running programmatic edit pipeline');

        // Step 1: Find and read the recommendations doc
        const DOC_CANDIDATES = [
            'docs/ORGANIZATION_RECOMMENDATIONS.md',
            'docs/RECOMMENDATIONS.md',
            'docs/REORGANIZATION.md',
            'ORGANIZATION_RECOMMENDATIONS.md',
            'RECOMMENDATIONS.md',
        ];
        const docPathMatch = userMessage.match(/\b([\w./\\\\-]+\.md)\b/i);
        if (docPathMatch) {
            DOC_CANDIDATES.unshift(docPathMatch[1].replace(/\\\\/g, '/'));
        }

        let docContent = '';
        let docPath = '';
        for (const candidate of DOC_CANDIDATES) {
            try {
                const full = path.resolve(root, candidate);
                if (fs.existsSync(full)) {
                    docContent = fs.readFileSync(full, 'utf8');
                    docPath = candidate;
                    break;
                }
            } catch { /* skip */ }
        }

        if (!docContent) {
            logInfo('[pre-process] No recommendations doc found, skipping pipeline');
            return '';
        }

        const docToolId = `t_${Date.now()}_pre1`;
        post({ type: 'toolCall', id: docToolId, name: 'shell_read', args: { command: `cat "${docPath}"` } });
        post({ type: 'toolResult', id: docToolId, name: 'shell_read', success: true, preview: `Read ${docPath} (${docContent.split('\n').length} lines)` });

        // Step 2: Build a map of old_import → new_import by scanning the actual filesystem.
        //
        // A mapping is ONLY generated when ALL three conditions hold:
        //   a) The file exists at the NEW path (subdir/module.py) — the move already happened
        //   b) The OLD import path (parent.module) does NOT resolve to any file on disk —
        //      i.e., parent/module.py does not exist at the top-level anymore
        //   c) At least one source file in the project contains "from <old_import>" —
        //      i.e., there are actually stale imports to fix
        //
        // This prevents generating bogus double-nested paths like app.routes.admin.admin.X
        // when the file is already at app/routes/admin/X.py (old path still works as-is).
        const moduleMap = new Map<string, string>();

        // Extract parent directories mentioned in the doc (e.g., "routes/", "models/", "services/")
        const parentDirs = new Set<string>();
        const parentDirRegex = /\b((?:app[\/\\\\])?(?:routes|models|services|templates))[\/\\\\]/g;
        let m: RegExpExecArray | null;
        while ((m = parentDirRegex.exec(docContent)) !== null) {
            let dir = m[1].replace(/\\\\/g, '/');
            if (!dir.startsWith('app/')) { dir = 'app/' + dir; }
            parentDirs.add(dir);
        }
        if (parentDirs.size === 0) {
            for (const d of ['app/routes', 'app/models', 'app/services']) {
                if (fs.existsSync(path.resolve(root, d))) { parentDirs.add(d); }
            }
        }

        logInfo(`[pre-process] Scanning parent directories: ${[...parentDirs].join(', ')}`);

        for (const parentDir of parentDirs) {
            const parentFull = path.resolve(root, parentDir);
            if (!fs.existsSync(parentFull)) { continue; }
            try {
                const entries = fs.readdirSync(parentFull, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '__pycache__') { continue; }
                    const subDirFull = path.resolve(parentFull, entry.name);
                    try {
                        const subFiles = fs.readdirSync(subDirFull).filter((f: string) => f.endsWith('.py') && f !== '__init__.py');
                        for (const pyFile of subFiles) {
                            const moduleName = pyFile.replace(/\.py$/, '');
                            const parentDotted = parentDir.replace(/\//g, '.');
                            const oldImport = `${parentDotted}.${moduleName}`;
                            const newImport = `${parentDotted}.${entry.name}.${moduleName}`;

                            // Condition (a): new file exists on disk
                            const newFilePath = path.resolve(root, parentDir, entry.name, pyFile);
                            if (!fs.existsSync(newFilePath)) { continue; }

                            // Condition (b): old file does NOT exist at parent level anymore
                            // (if it still exists there, the old import still works — nothing to fix)
                            const oldFilePath = path.resolve(root, parentDir, pyFile);
                            if (fs.existsSync(oldFilePath)) { continue; }

                            moduleMap.set(oldImport, newImport);
                        }
                    } catch { /* skip unreadable subdirs */ }
                }
            } catch { /* skip */ }
        }

        if (moduleMap.size === 0) {
            logInfo('[pre-process] No module relocations detected (files may not have been moved yet, or imports are already correct)');
            return '__NO_MOVES_DETECTED__';
        }

        logInfo(`[pre-process] Built module map: ${moduleMap.size} relocated modules`);

        // Step 3: Scan .py files directly for stale imports (fast — no child processes)
        const searchToolId = `t_${Date.now()}_pre2`;
        interface ImportEdit { lineNum: number; oldLine: string; oldImport: string; newImport: string }
        const editsPerFile = new Map<string, ImportEdit[]>();

        post({ type: 'toolCall', id: searchToolId, name: 'shell_read', args: { command: `grep -rn "from ..." . (scanning .py files for ${moduleMap.size} old import patterns)` } });

        // Build a set of old import strings for fast lookup
        const oldImportStrings = new Map<string, string>(); // "from X" → newImport
        for (const [oldImport, newImport] of moduleMap) {
            oldImportStrings.set(`from ${oldImport}`, newImport);
        }

        // Recursively find all .py files, skipping irrelevant directories
        const SKIP_SCAN_DIRS = new Set([
            'node_modules', '.git', '__pycache__', 'dist', 'build', 'venv', '.venv',
            'env', '.env', '.tox', '.mypy_cache', '.pytest_cache', 'htmlcov',
            '.eggs', 'migrations', 'logs', '.cache', 'archive', 'tests', 'test',
        ]);
        const pyFiles: string[] = [];
        const MAX_SCAN_DEPTH = 8;
        const MAX_PY_FILES = 500;
        const collectPyFiles = (dir: string, depth: number) => {
            if (depth > MAX_SCAN_DEPTH || pyFiles.length >= MAX_PY_FILES) { return; }
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (pyFiles.length >= MAX_PY_FILES) { break; }
                    if (entry.isDirectory() && !entry.isSymbolicLink()) {
                        if (!SKIP_SCAN_DIRS.has(entry.name)) {
                            collectPyFiles(path.resolve(dir, entry.name), depth + 1);
                        }
                    } else if (entry.name.endsWith('.py')) {
                        pyFiles.push(path.resolve(dir, entry.name));
                    }
                }
            } catch { /* skip unreadable dirs */ }
        };
        collectPyFiles(root, 0);
        logInfo(`[pre-process] Scanning ${pyFiles.length} .py files for stale imports`);

        for (const fullPath of pyFiles) {
            if (this.stopRef.stop) { break; }
            try {
                const fileContent = fs.readFileSync(fullPath, 'utf8');
                const relPath = path.relative(root, fullPath).replace(/\\\\/g, '/');
                const fileLines = fileContent.split('\n');
                for (let i = 0; i < fileLines.length; i++) {
                    const line = fileLines[i];
                    for (const [oldStr, newImport] of oldImportStrings) {
                        if (!line.includes(oldStr)) { continue; }
                        // Skip if already points to new location
                        if (line.includes(`from ${newImport}`)) { continue; }
                        // Skip __init__.py in target subdirectories (they use relative imports)
                        const subDirName = newImport.split('.').slice(-2, -1)[0];
                        if (relPath.endsWith('__init__.py') && relPath.includes(`${subDirName}/`)) { continue; }
                        if (!editsPerFile.has(relPath)) { editsPerFile.set(relPath, []); }
                        editsPerFile.get(relPath)!.push({
                            lineNum: i + 1,
                            oldLine: line.trim(),
                            oldImport: oldStr.replace('from ', ''),
                            newImport,
                        });
                        break; // One match per line
                    }
                }
            } catch { /* skip unreadable files */ }
        }

        const totalEdits = [...editsPerFile.values()].reduce((sum, edits) => sum + edits.length, 0);
        post({ type: 'toolResult', id: searchToolId, name: 'shell_read', success: true, preview: `Found ${totalEdits} stale imports across ${editsPerFile.size} files` });

        if (editsPerFile.size === 0) {
            logInfo('[pre-process] No stale imports found — imports may already be up to date');
            return '__IMPORTS_ALREADY_CORRECT__';
        }

        logInfo(`[pre-process] Found ${totalEdits} stale imports in ${editsPerFile.size} files — executing edits`);

        // Step 4: Execute edits programmatically via edit_file (with diff preview + confirmation)
        let successCount = 0;
        let failCount = 0;
        const editSummary: string[] = [];

        for (const [filePath, edits] of editsPerFile) {
            if (this.stopRef.stop) { break; }
            try {
                const full = path.resolve(root, filePath);
                if (!fs.existsSync(full)) { continue; }
                let content = fs.readFileSync(full, 'utf8');

                const seen = new Set<string>();
                for (const edit of edits) {
                    // Use the FULL line as old_string to guarantee uniqueness.
                    // Using just the prefix (e.g., "from app.routes.admin") would match
                    // lines already updated to "from app.routes.admin.health" etc.
                    const oldStr = edit.oldLine;
                    const newStr = edit.oldLine.replace(`from ${edit.oldImport}`, `from ${edit.newImport}`);
                    if (seen.has(oldStr)) { continue; }
                    seen.add(oldStr);

                    if (!content.includes(oldStr)) {
                        logInfo(`[pre-process] Skipping ${filePath}: "${oldStr}" not found (may have been edited already)`);
                        continue;
                    }

                    const editToolId = `t_${Date.now()}_pre_e${successCount + failCount}`;
                    post({ type: 'toolCall', id: editToolId, name: 'edit_file', args: { path: filePath, old_string: oldStr, new_string: newStr } });

                    try {
                        const result = await this.executeTool('edit_file', {
                            path: filePath,
                            old_string: oldStr,
                            new_string: newStr,
                        }, editToolId);

                        if (result.includes('cancelled')) {
                            post({ type: 'toolResult', id: editToolId, name: 'edit_file', success: false, preview: result });
                            failCount++;
                        } else {
                            post({ type: 'toolResult', id: editToolId, name: 'edit_file', success: true, preview: result.slice(0, 200) });
                            successCount++;
                            editSummary.push(`✅ ${filePath}: ${oldStr} → ${newStr}`);
                            content = fs.readFileSync(full, 'utf8');
                        }
                    } catch (err) {
                        const errMsg = toErrorMessage(err);
                        post({ type: 'toolResult', id: editToolId, name: 'edit_file', success: false, preview: errMsg });
                        failCount++;
                        editSummary.push(`❌ ${filePath}: ${oldStr} — ${errMsg}`);
                    }
                }
            } catch (err) {
                logWarn(`[pre-process] Failed to process ${filePath}: ${toErrorMessage(err)}`);
                failCount++;
            }
        }

        logInfo(`[pre-process] Pipeline complete: ${successCount} edits applied, ${failCount} failed`);

        // Step 5: Validate that every new import path resolves to a real file on disk.
        // For any that don't, search the project for a file with the same name (renamed/moved elsewhere).
        const validationLines: string[] = [];
        const newImportsApplied = new Set<string>();
        for (const edits of editsPerFile.values()) {
            for (const edit of edits) { newImportsApplied.add(edit.newImport); }
        }

        if (newImportsApplied.size > 0) {
            // Helper: find all .py files under root matching a given base name
            const findByName = (baseName: string): string[] => {
                const results: string[] = [];
                const walk = (dir: string) => {
                    let entries: fs.Dirent[];
                    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                    for (const e of entries) {
                        if (e.name.startsWith('.') || e.name === '__pycache__') { continue; }
                        const full = path.join(dir, e.name);
                        if (e.isDirectory()) { walk(full); }
                        else if (e.isFile() && e.name === `${baseName}.py`) {
                            results.push(path.relative(root, full).replace(/\\/g, '/'));
                        }
                    }
                };
                walk(root);
                return results;
            };

            const broken: string[] = [];
            const renamed: string[] = [];

            for (const newImport of newImportsApplied) {
                const filePath = newImport.replace(/\./g, '/') + '.py';
                const fullPath = path.resolve(root, filePath);
                if (fs.existsSync(fullPath)) { continue; } // ✅ confirmed — skip

                // File not found at expected path — search by base name
                const baseName = newImport.split('.').pop() ?? '';
                const matches = findByName(baseName);

                if (matches.length > 0) {
                    // Found under a different path — likely renamed or in different subdir
                    const matchList = matches.map(m => `\`${m.replace(/\//g, '.')
                        .replace(/\.py$/, '')}\``).join(', ');
                    renamed.push(`⚠️  \`${newImport}\` — file not at expected path. Found as: ${matchList}`);
                } else {
                    broken.push(`❌  \`${newImport}\` — not found anywhere in project (may be deleted or not yet created)`);
                }
            }

            if (renamed.length > 0 || broken.length > 0) {
                validationLines.push(``, `## Import Validation Issues`, ``);
                validationLines.push(...renamed, ...broken);
                validationLines.push(``, `Note: The above imports were updated but the target files could not be confirmed on disk. They may have been renamed — check the paths above and correct the imports manually if needed.`);
            }
        }

        const summary = [
            `[SYSTEM: Import path update pipeline completed programmatically.]`,
            ``,
            `## Results`,
            `- **${successCount}** imports updated successfully`,
            failCount > 0 ? `- **${failCount}** edits failed or were cancelled` : '',
            `- **${editsPerFile.size}** files were affected`,
            ``,
            `## Changes Made`,
            ...editSummary,
            ...validationLines,
            ``,
            `Tell the user what was done. List the files that were updated and summarize the import path changes.`,
            validationLines.length > 0 ? `Also highlight the validation issues found — imports that point to missing files, with any close matches shown.` : '',
            failCount > 0 ? `Also mention the ${failCount} edit(s) that failed and suggest the user review them manually.` : '',
            `Do NOT call any more tools — the work is done.`,
        ].filter(Boolean).join('\n');

        return summary;
    }

    // ── Memory nudge injection ────────────────────────────────────────────────

    /**
     * Build a memory nudge message to inject periodically.
     * Returns the nudge string, or empty string if not due yet.
     */
    private buildMemoryNudge(): string {
        if (this.userTurnCount % this.MEMORY_NUDGE_INTERVAL !== 0) { return ''; }
        if (this.userTurnCount === 0) { return ''; }
        return '\n\n[SYSTEM REMINDER: Review this conversation for any new facts, decisions, URLs, tools, or patterns worth saving to memory. If you found anything new, call memory_tier_write now before responding. Do not mention this reminder to the user.]';
    }

    private friendlyError(raw: string): string {
        if (raw.includes('ECONNREFUSED')) { return 'Ollama is not running. Run: ollama serve'; }
        if (raw.includes('timed out'))    { return 'Request timed out. The model may be loading or overloaded.'; }
        if (raw.includes('404'))          { return 'Model not found. Run: ollama pull <model-name>'; }
        return raw;
    }

    // ── Small-model read-then-act pipeline ───────────────────────────────────

    /**
     * Determine if the current model is "small" (≤9B params).
     * Small models get pre-injected file context instead of shell exploration.
     */
    private async resolveIsSmallModel(model: string): Promise<boolean> {
        // Fast path: extract param count from model tag (e.g. "qwen2.5-coder:7b-256k" → 7B)
        const nameMatch = model.toLowerCase().match(/:(\d+\.?\d*)([bm])/);
        if (nameMatch) {
            const num = parseFloat(nameMatch[1]);
            const unit = nameMatch[2];
            const params = unit === 'b' ? num : num / 1000;
            if (params <= 9)  { return true; }
            if (params >= 13) { return false; }
            // 10-12B: fall through to API check
        }
        // Slow path: ask Ollama for model details
        try {
            const { fetchModelInfo } = await import('./ollamaClient');
            const info = await fetchModelInfo(model);
            if (info?.parameterSize) {
                const m = info.parameterSize.match(/(\d+\.?\d*)\s*([bBmM])/);
                if (m) {
                    const num = parseFloat(m[1]);
                    const unit = m[2].toLowerCase();
                    return (unit === 'b' ? num : num / 1000) <= 9;
                }
            }
        } catch { /* ignore */ }
        return false; // unknown → treat as large (conservative)
    }

    /**
     * Walk the workspace and find files whose names match the given keywords.
     * Returns candidates scored by filename relevance, sorted descending.
     */
    private findEditCandidates(
        filenameKeywords: string[],
        extensions: string[],
        fullServiceName?: string   // e.g. "thermal_receipt" — scores highest on exact basename match
    ): Array<{ relPath: string; absPath: string; score: number }> {
        const root = this.workspaceRoot;
        const results: Array<{ relPath: string; absPath: string; score: number }> = [];
        const extSet = new Set(extensions.map(e => e.toLowerCase()));

        const walk = (dir: string, depth: number) => {
            if (depth > 8) { return; }
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (SKIP_DIRS.has(entry.name)) { continue; }
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full, depth + 1);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (!extSet.has(ext)) { continue; }
                    const rel = path.relative(root, full).replace(/\\/g, '/');
                    const baseLower = entry.name.toLowerCase().replace(/\.\w+$/, '');
                    const relLower = rel.toLowerCase();
                    let score = 0;
                    // Highest priority: basename starts with or equals the full service name
                    if (fullServiceName) {
                        if (baseLower === fullServiceName || baseLower === fullServiceName + '_service') { score += 30; }
                        else if (baseLower.startsWith(fullServiceName)) { score += 20; }
                        else if (baseLower.includes(fullServiceName))   { score += 15; }
                    }
                    // Per-keyword scoring
                    for (const kw of filenameKeywords) {
                        if (baseLower === kw)             { score += 10; } // exact match
                        else if (baseLower.startsWith(kw + '_') || baseLower.endsWith('_' + kw)) { score += 8; } // word boundary
                        else if (baseLower.includes(kw))  { score += 5;  } // partial in name
                        else if (relLower.includes(kw))   { score += 2;  } // in path
                    }
                    // Penalise archive/backup/old dirs — never the right file
                    if (/archive|backup|old.code|\.bak/i.test(relLower)) { score = Math.max(0, score - 20); }
                    // Penalise test files — prefer source/service files for edit tasks
                    if (/(?:^|\/)(tests?|__tests?__|spec)\//i.test(relLower) || /[._](test|spec)\.\w+$/.test(relLower)) { score = Math.max(0, score - 6); }
                    if (score > 0) { results.push({ relPath: rel, absPath: full, score }); }
                }
            }
        };
        walk(root, 0);
        results.sort((a, b) => b.score - a.score);
        return results;
    }

    /**
     * Pre-processing pipeline for edit tasks on small models.
     * Finds the relevant file(s), reads them, and returns a formatted
     * context block to inject into the user message before calling the model.
     * Returns '' if no relevant file is found (fall through to normal loop).
     */
    private async preProcessEditTask(userMessage: string, post: PostFn): Promise<string> {
        const root = this.workspaceRoot;

        // ── 1. Extract keywords ──────────────────────────────────────────────
        // Priority: explicit service/module name > file path mention > content words
        const filenameKeywords: string[] = [];

        // "the thermal receipt service" → "thermal_receipt"
        // "the drivers_license_ocr service" → "drivers_license_ocr"
        // Captures multi-word names (spaces or underscores/hyphens) before the role word
        const serviceMatch = userMessage.match(
            /\b(?:the\s+)?(\w+(?:[\s_-]\w+)*?)\s+(?:service|module|handler|controller|view|model|util|helper|component|route|router|api)\b/i
        );
        if (serviceMatch) {
            // Normalise spaces to underscores: "thermal receipt" → "thermal_receipt"
            const svc = serviceMatch[1].toLowerCase().replace(/\s+/g, '_');
            filenameKeywords.push(svc);
            // Also push individual words for fallback scoring
            svc.split(/[_-]/).filter(w => w.length > 2).forEach(w => filenameKeywords.push(w));
        }

        // Explicit file path: "in auth.py", "look at routes/user.ts"
        const fileMatch = userMessage.match(/\b([\w./\\-]+\.(?:py|ts|js|go|java|rs|rb|php|c|cpp|cs))\b/i);
        if (fileMatch) { filenameKeywords.push(path.basename(fileMatch[1]).replace(/\.\w+$/, '').toLowerCase()); }

        // Content-keyword fallback
        const STOP = new Set(['add','insert','fix','update','change','modify','implement',
            'the','a','an','to','in','on','of','for','whenever','when','every','time',
            'that','this','so','and','or','with','by','from','at','into','should',
            'would','could','will','can','all','any','some','statement','log','logging',
            'make','sure','please','just','need','want','also']);
        const contentKws = userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !STOP.has(w)).slice(0, 5);
        if (filenameKeywords.length === 0) { filenameKeywords.push(...contentKws); }

        // ── 2. Detect file extensions from project type ──────────────────────
        // Default to common code extensions; prefer Python if workspace has .py files
        const hasTs = fs.existsSync(path.join(root, 'tsconfig.json')) || fs.existsSync(path.join(root, 'package.json'));
        const hasPy = fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'setup.py'));
        const extensions = hasPy ? ['.py'] : hasTs ? ['.ts', '.js', '.tsx', '.jsx'] : ['.py', '.ts', '.js', '.go', '.java', '.rs'];

        if (filenameKeywords.length === 0) { return ''; }

        // Full service name for exact-match boosting (e.g. "thermal_receipt" from "thermal receipt service")
        const fullServiceName = serviceMatch ? serviceMatch[1].toLowerCase() : undefined;

        logInfo(`[pre-edit] Searching for edit candidates — keywords: [${filenameKeywords.join(', ')}], fullService: ${fullServiceName ?? '(none)'}, exts: [${extensions.join(', ')}]`);

        // ── 3. Find candidate files — semantic search via code index, fallback to keyword ──
        let candidates: Array<{ relPath: string; absPath: string; score: number }>;
        if (this.codeIndex) {
            const indexResults = await this.codeIndex.findRelevantFiles(userMessage, 5);
            candidates = indexResults.map(r => ({ relPath: r.relPath, absPath: r.absPath, score: Math.round(r.score * 100) }));
            logInfo(`[pre-edit] Code index returned ${candidates.length} result(s) for: "${userMessage.slice(0, 60)}" (ready=${this.codeIndex.isReady})`);
            // Fall back to keyword search if index returned nothing (not ready yet, or no matches)
            if (candidates.length === 0) {
                candidates = this.findEditCandidates(filenameKeywords, extensions, fullServiceName);
                if (candidates.length > 0) {
                    logInfo(`[pre-edit] Code index empty — using keyword fallback: ${candidates.slice(0, 3).map(c => c.relPath).join(', ')}`);
                }
            }
        } else {
            candidates = this.findEditCandidates(filenameKeywords, extensions, fullServiceName);
        }

        if (candidates.length === 0) {
            logInfo('[pre-edit] No candidate files found — falling through to normal loop');
            return '';
        }

        logInfo(`[pre-edit] Found ${candidates.length} candidate(s): ${candidates.slice(0, 5).map(c => `${c.relPath}(${c.score})`).join(', ')}`);

        // ── 4. Read top candidates and score by content keyword hits ─────────
        const isMultiFile = /\b(all|every|each)\b.*\b(service|route|model|file|handler|view|controller)s?\b/i.test(userMessage);
        const maxFiles = isMultiFile ? 2 : 1;
        const top = candidates.slice(0, Math.min(3, candidates.length));

        interface ReadResult { relPath: string; absPath: string; content: string; lineCount: number; hits: number; }
        const readResults: ReadResult[] = [];

        for (const c of top) {
            try {
                const stat = fs.statSync(c.absPath);
                if (stat.size > 100_000) {
                    logInfo(`[pre-edit] Skipping ${c.relPath} — too large (${stat.size} bytes)`);
                    continue;
                }
                const content = fs.readFileSync(c.absPath, 'utf8');
                const lineCount = content.split('\n').length;
                const lower = content.toLowerCase();
                // Score by content keyword hits (minimum across all keywords for coverage)
                const hitsPerKw = contentKws.map(w => {
                    let count = 0, pos = 0;
                    while ((pos = lower.indexOf(w, pos)) !== -1) { count++; pos++; }
                    return count;
                });
                const minHits = contentKws.length > 0 ? Math.min(...hitsPerKw) : 1;
                const totalHits = hitsPerKw.reduce((a, b) => a + b, 0);
                readResults.push({ relPath: c.relPath, absPath: c.absPath, content, lineCount, hits: minHits * 10000 + totalHits + c.score * 100 });
                logInfo(`[pre-edit] Read ${c.relPath} (${lineCount} lines, score=${c.score}, hits=${minHits}/${totalHits})`);
            } catch (e) {
                logWarn(`[pre-edit] Failed to read ${c.relPath}: ${toErrorMessage(e as Error)}`);
            }
        }

        if (readResults.length === 0) { return ''; }
        readResults.sort((a, b) => b.hits - a.hits);
        const selected = readResults.slice(0, maxFiles);

        // ── 5. Build the context injection string ────────────────────────────
        const FILE_LINE_LIMIT = 600; // inject full file up to this length
        const contextBlocks: string[] = [];

        for (const r of selected) {
            // Post a visible tool call so the user sees what we're doing
            const preReadId = `pre_edit_read_${Date.now()}`;
            post({ type: 'toolCall', id: preReadId, name: 'shell_read', args: { command: `cat "${r.relPath}"` } });
            post({ type: 'toolResult', id: preReadId, name: 'shell_read', success: true, preview: `${r.lineCount} lines` });

            const lines = r.content.split('\n');
            let startIdx = 0;
            let endIdx   = lines.length;

            if (r.lineCount > FILE_LINE_LIMIT) {
                // Focused window around keyword-matching lines
                const kwsForWindow = [...filenameKeywords, ...contentKws].filter(w => w.length > 3);
                const relevantIdxs = lines
                    .map((l, i) => ({ i, hit: kwsForWindow.some(w => l.toLowerCase().includes(w)) }))
                    .filter(x => x.hit).map(x => x.i);
                if (relevantIdxs.length > 0) {
                    startIdx = Math.max(0, relevantIdxs[0] - 20);
                    endIdx   = Math.min(lines.length, relevantIdxs[relevantIdxs.length - 1] + 80);
                    logInfo(`[pre-edit] Focused window lines ${startIdx + 1}-${endIdx} of ${r.relPath}`);
                } else {
                    endIdx = Math.min(lines.length, FILE_LINE_LIMIT);
                }
            }

            // Line-numbered content — model reads line numbers, uses edit_file_at_line
            const numberedLines = lines.slice(startIdx, endIdx)
                .map((l, i) => `${String(startIdx + i + 1).padStart(4, ' ')}: ${l}`)
                .join('\n');

            const ext = path.extname(r.relPath).slice(1) || 'text';
            const windowNote = (startIdx > 0 || endIdx < lines.length)
                ? ` [showing lines ${startIdx + 1}-${endIdx} of ${r.lineCount}]`
                : ` [${r.lineCount} lines]`;
            contextBlocks.push(
                `[FILE: ${r.relPath}${windowNote}]\n` +
                `\`\`\`${ext}\n${numberedLines}\n\`\`\``
            );
        }

        const pathList = selected.map(r => `"${r.relPath}"`).join(', ');
        const injection = [
            `[PRE-LOADED CONTEXT for your task]`,
            `The file(s) below are shown with line numbers (format: "  42: code"). Line numbers are for edit_file_at_line only — they are NOT part of the file.`,
            ``,
            contextBlocks.join('\n\n---\n\n'),
            ``,
            `INSTRUCTIONS:`,
            `- Use edit_file_at_line with path=${pathList}`,
            `- Specify start_line and end_line from the numbers shown above`,
            `- Write new_content with the same indentation style as the surrounding code`,
            `- Do NOT call shell_read — the file content is already above`,
            `- If the change is already present, say so and stop`,
        ].join('\n');

        logInfo(`[pre-edit] Injected ${injection.length} chars of pre-loaded context for ${selected.map(r => r.relPath).join(', ')}`);
        return injection;
    }
}
