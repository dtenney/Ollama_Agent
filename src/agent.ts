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
import { MultiFileRefactoringManager, RefactoringPlan } from './multiFileRefactor';
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
function buildShellExamples(env: ShellEnvironment): string {
    if (env.os === 'windows') {
        return `Your PRIMARY tools are shell_read and run_command. The host is **${env.label}**. Use Windows-native commands:
- Finding files: shell_read with "dir /s /b *transaction*" or "where /r . *transaction*"
- Searching code: shell_read with "findstr /S /N /I \"fetch_user\" *.py"
- Listing directories: shell_read with "tree /F app" or "dir /s /b app\\*.py"
- Moving files: run_command with "mkdir app\\routes\\admin && move app\\routes\\admin.py app\\routes\\admin\\"
- Creating directories: run_command with "mkdir app\\routes\\admin && mkdir app\\routes\\cashier"
- Viewing files: shell_read with "type src\\main.ts"
- Git operations: shell_read with "git status", "git log --oneline -20", "git diff"
IMPORTANT: Do NOT use Unix commands (find, grep, cat, mv, mkdir -p, head, tail, wc) — they are not available. Use dir, findstr, type, move, tree instead.`;
    } else {
        return `Your PRIMARY tools are shell_read and run_command. The host is **${env.label}**. Use shell commands like a developer:
- Finding files: shell_read with "find . -name '*transaction*' -not -path '*__pycache__*'"
- Searching code: shell_read with "grep -rn 'def fetch_user' --include='*.py' ."
- Listing directories: shell_read with "find app -type f -name '*.py' | head -50"
- Moving files: run_command with "mkdir -p app/routes/admin && mv app/routes/admin.py app/routes/admin/"
- Creating directories: run_command with "mkdir -p app/routes/admin app/routes/cashier"
- Git operations: shell_read with "git status", "git log --oneline -20", "git diff"`;
    }
}

/** Build shell-first examples for text-mode instructions */
function buildTextModeShellExamples(env: ShellEnvironment): string {
    if (env.os === 'windows') {
        return `CRITICAL — Shell-First Approach:
The host is **${env.label}**. Use Windows-native commands. Do NOT use Unix commands (find, grep, cat, mv, mkdir -p).
Prefer shell commands over specialized tools when they are more natural or powerful:

EXAMPLE - User says "find the transaction page code":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "dir /s /b *transaction*"}}</tool>
ALSO OK: <tool>{"name": "find_files", "arguments": {"pattern": "*transaction*", "path": "app"}}</tool>

EXAMPLE - User says "search for where fetch_user is defined":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "findstr /S /N /I \"def fetch_user\" *.py"}}</tool>

EXAMPLE - User says "show me the project structure under app/":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "tree /F app"}}</tool>

EXAMPLE - User says "create the admin and cashier directories and move the files":
Step 1: <tool>{"name": "list_files", "arguments": {"path": "app\\routes"}}</tool>
[wait for result — now you know the REAL filenames]
Step 2: <tool>{"name": "run_command", "arguments": {"command": "mkdir app\\routes\\admin && mkdir app\\routes\\cashier"}}</tool>
[wait for result]
Step 3 (BATCH ALL moves in ONE command — do NOT call list_files between moves): <tool>{"name": "run_command", "arguments": {"command": "move app\\routes\\admin.py app\\routes\\admin\\ && move app\\routes\\audit.py app\\routes\\admin\\ && move app\\routes\\cashier.py app\\routes\\cashier\\"}}</tool>
IMPORTANT: Do NOT call list_files after each move. Batch as many moves as possible into each run_command call.`;
    } else {
        return `CRITICAL — Shell-First Approach:
The host is **${env.label}**. Use shell commands like a developer.
Prefer shell commands over specialized tools when they are more natural or powerful:

EXAMPLE - User says "find the transaction page code":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "find app -type f -name '*transaction*' -not -path '*__pycache__*'"}}</tool>
ALSO OK: <tool>{"name": "find_files", "arguments": {"pattern": "*transaction*", "path": "app"}}</tool>

EXAMPLE - User says "search for where fetch_user is defined":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "grep -rn 'def fetch_user' --include='*.py' ."}}</tool>

EXAMPLE - User says "show me the project structure under app/":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "find app -type f -name '*.py' | head -50"}}</tool>

EXAMPLE - User says "create the admin and cashier directories and move the files":
Step 1: <tool>{"name": "list_files", "arguments": {"path": "app/routes"}}</tool>
[wait for result — now you know the REAL filenames]
Step 2: <tool>{"name": "run_command", "arguments": {"command": "mkdir -p app/routes/admin app/routes/cashier"}}</tool>
[wait for result]
Step 3 (BATCH ALL moves in ONE command — do NOT call list_files between moves): <tool>{"name": "run_command", "arguments": {"command": "mv app/routes/admin.py app/routes/admin/ && mv app/routes/audit.py app/routes/admin/ && mv app/routes/cashier.py app/routes/cashier/"}}</tool>
IMPORTANT: Do NOT call list_files after each move. Batch as many moves as possible into each run_command call.`;
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
            name: 'read_file',
            description: 'Read the full contents of a file in the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path relative to workspace root' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_files',
            description: 'List files and directories at a given path in the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative directory path (default ".")' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_files',
            description: 'Search for TEXT CONTENT (not filenames) across all files in the workspace. Use this to find where specific code, strings, or text appears in files. To list files by name, use list_files instead.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text string to search for in file contents (e.g., "function main", "import React", "TODO"). Do NOT use wildcards like *.md - this searches file contents, not names.' },
                    path:  { type: 'string', description: 'Directory to search (default ".")' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_file',
            description: 'Create a new file with given content. Fails if the file already exists.',
            parameters: {
                type: 'object',
                properties: {
                    path:    { type: 'string', description: 'Path relative to workspace root' },
                    content: { type: 'string', description: 'Initial file content' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Make a targeted edit to an existing file by replacing old_string with new_string. Always read_file first to get the exact current content. The old_string must match exactly (including whitespace/indentation). Opens a diff view for review before applying.',
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
            name: 'write_file',
            description: 'Overwrite an existing file with completely new content. Prefer edit_file for targeted changes. Requires user confirmation.',
            parameters: {
                type: 'object',
                properties: {
                    path:    { type: 'string', description: 'Path relative to workspace root' },
                    content: { type: 'string', description: 'Full file content to write' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'append_to_file',
            description: 'Append text to the end of an existing file.',
            parameters: {
                type: 'object',
                properties: {
                    path:    { type: 'string', description: 'Path relative to workspace root' },
                    content: { type: 'string', description: 'Text to append' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'rename_file',
            description: 'Rename or move a file within the workspace. Requires user confirmation.',
            parameters: {
                type: 'object',
                properties: {
                    old_path: { type: 'string', description: 'Current path relative to workspace root' },
                    new_path: { type: 'string', description: 'New path relative to workspace root' },
                },
                required: ['old_path', 'new_path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_file',
            description: 'Delete a file from the workspace. Requires user confirmation. Use with care.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path relative to workspace root' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'find_files',
            description: 'Find files by name, partial name, or glob pattern in the workspace. Supports substring matching — e.g., "single_transaction" will find "single_transaction_dashboard.html". Use this to locate files. For searching TEXT CONTENT inside files, use search_files instead.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Filename, partial name, or glob pattern (e.g., "*.ts", "README*", "single_transaction*", "Dockerfile"). Partial names are matched as substrings.' },
                    path: { type: 'string', description: 'Directory to search in (default ".")' },
                },
                required: ['pattern'],
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

    return `You are an expert AI coding assistant integrated into VS Code.
Current date: ${dateStr}, ${timeStr}.${activeLanguage ? ` Active file: ${activeFile} (${activeLanguage}).` : ''}
${autoSaveBlock}
You have access to the user's workspace through the following tools:

  workspace_summary  — understand the project structure (call this first)
  read_file          — read any file
  list_files         — list a directory
  find_files         — find files by name, partial name, or glob pattern (e.g., "*.ts", "single_transaction*", "Dockerfile")
  search_files       — search for TEXT CONTENT across files (NOT filenames - use find_files for that)
  create_file        — create a new file
  edit_file          — make targeted edits (old_string → new_string). Preferred for code changes.
  write_file         — overwrite a file entirely (use only when necessary)
  append_to_file     — append text to a file
  rename_file        — rename or move a file
  delete_file        — delete a file (destructive, use carefully)
  shell_read         — run read-only shell commands WITHOUT confirmation (git log, git status, git diff, ls, cat, head, wc, find, grep, env, which, etc.)
  run_command        — run shell commands that MODIFY state WITH confirmation (tests, installs, builds, scripts)
  memory_list        — recall saved facts/decisions about this project
  memory_write       — persist important facts, decisions, or context across sessions
  memory_delete      — remove a stale memory note
  memory_search      — search past memories using semantic similarity
  memory_tier_write  — save to specific tier (0=critical, 1=essential, 2=operational, 3=collaboration, 4=references)
  memory_tier_list   — list memories from specific tiers
  memory_stats       — get memory statistics (entry count and tokens per tier)
  read_terminal      — read recent output from VS Code integrated terminals
  get_diagnostics    — get VS Code errors/warnings for a file or workspace. ALWAYS use this when user asks about errors/warnings — do NOT use external linters instead.

## Shell-First Approach
${buildShellExamples(detectShellEnvironment())}
The specialized tools (list_files, search_files, find_files) are convenience wrappers — use shell commands when they would be more natural or powerful.

Guidelines:
- ALWAYS CALL TOOLS DIRECTLY - never explain what tool to call, just call it immediately
- Always call workspace_summary or read_file before proposing code changes.
- Prefer edit_file over write_file for targeted modifications.
- CRITICAL: When user asks about errors, warnings, or diagnostics in their code, ALWAYS call get_diagnostics FIRST — do NOT run external linters (ruff, eslint, tsc, etc.) unless the user specifically asks for a linter.
- After editing or creating files, call get_diagnostics to check for errors introduced by your changes. If errors exist, fix them.
- Prefer shell_read for ANY read-only operation — it requires no user confirmation and is faster than run_command.
- Use run_command for operations that modify state (mkdir, mv, cp, npm install, pip install, tests, builds, etc.).
- Your persistent memory is automatically loaded (Tiers 0-2) and shown above.
${memoryGuidelines}
- Use memory_search to find relevant past solutions without loading all memories.
- CRITICAL: When user asks "what do you know about this project" or "what have you learned", ALWAYS call memory_list or memory_tier_list — do not answer from conversation history alone.
- CRITICAL: When user asks "explain what this project does", "what is this project", or wants to UNDERSTAND the codebase, call workspace_summary FIRST (then read key files like package.json, README.md). Memory alone is NOT enough — the user wants to understand the actual code.
- CRITICAL: Before calling memory_delete, ALWAYS call memory_list first to get the actual entry ID — never guess or fabricate IDs.
- Be concise and accurate. Format all code with markdown fenced code blocks.

CRITICAL — Action-Oriented Responses:
- NEVER ask "Would you like me to proceed?", "Shall I continue?", or "Do you want me to do this?" — if the user asked you to DO something, DO IT immediately by calling tools. The built-in confirmation dialogs handle safety.
- When asked to review, analyze, audit, fix, or improve code: ALWAYS use read_file/list_files to read the ACTUAL source files first, then propose REAL edits using edit_file on the actual code you read.
- NEVER generate hypothetical examples, placeholder code, or generic "Example:" blocks. The user wants you to act on THEIR code, not see textbook examples.
- If the user says "look at src/" or "check this file" — call list_files and read_file immediately. Do not describe what you would do.
- When you find an issue, fix it with edit_file right away (or explain why you can't). Do not just list the issue with a generic code sample.

CRITICAL — Discover Before Acting:
- Before MOVING, RENAMING, REORGANIZING, or RESTRUCTURING files, ALWAYS list the current directory first to see what files actually exist. Do NOT assume filenames from a document — verify them.
- If rename_file fails with "no such file", call list_files or shell_read to discover the actual filenames, then retry with the correct paths.
- NEVER create placeholder/dummy files (e.g., "# Placeholder for admin routes") when the real files already exist elsewhere — find and move the real files instead.
${projectGuidance ?? (workspaceRoot ? buildProjectTypeGuidance(workspaceRoot) : '')}`;
}

// ── Text-mode tool calling (fallback for models without native tool support) ──

/**
 * Build text-mode tool instructions with optional auto-save guidance.
 * Appended to the system prompt when the model doesn't support native tools.
 */
function buildTextModeInstructions(autoSaveMemory: boolean): string {
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
- When user mentions a file path, call read_file on it. Do NOT call list_files on the directory.
- When user says "yes", "go ahead", "do it", "sure", "proceed" — output a <tool> block for the next action IMMEDIATELY.
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
- When user mentions a specific file path (e.g., "look at docs/file.md"), call read_file with that exact path — do NOT call list_files on the directory instead${autoSaveGuidance}

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
WRONG: "You can call search_files with query README"
WRONG: Showing JSON in a code block
CORRECT: <tool>{"name": "search_files", "arguments": {"query": "README"}}</tool>

EXAMPLE - User says "what do you know about this project?":
WRONG: Answering from conversation history without calling a tool
CORRECT: <tool>{"name": "memory_list", "arguments": {}}</tool>

EXAMPLE - User says "explain what this project does" or "what is this project?":
WRONG: <tool>{"name": "memory_list", "arguments": {}}</tool> (memory notes are NOT a project explanation)
CORRECT: <tool>{"name": "workspace_summary", "arguments": {}}</tool>
[then read_file on package.json, README.md, or main entry point to give a real answer]

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
CORRECT: <tool>{"name": "find_files", "arguments": {"pattern": "*.test.ts"}}</tool>

EXAMPLE - User says "what branch am I on":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "git branch --show-current"}}</tool>

EXAMPLE - User says "show me the git log":
CORRECT: <tool>{"name": "shell_read", "arguments": {"command": "git log --oneline -20"}}</tool>

Available tools and their argument schemas:
  workspace_summary   — {}
  read_file           — {"path": "relative/path/to/file"}
  list_files          — {"path": "relative/dir (optional)"}
  search_files        — {"query": "text content to find (NOT filenames)", "path": "optional dir"}
  create_file         — {"path": "path", "content": "full content"}
  edit_file           — {"path": "path", "old_string": "exact text", "new_string": "replacement"}
  write_file          — {"path": "path", "content": "full content"}
  append_to_file      — {"path": "path", "content": "text to append"}
  rename_file         — {"old_path": "current", "new_path": "new name"}
  delete_file         — {"path": "path"}
  find_files          — {"pattern": "name or glob (supports partial names)", "path": "optional dir"}
  shell_read          — {"command": "read-only shell command (no confirmation)"}
  run_command         — {"command": "shell command (requires confirmation)"}
  memory_list         — {} — call when user asks "what do you know" or about project knowledge (NOT for "explain this project" — use workspace_summary for that)
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

EXAMPLE - User says "add a comment to the top of src/main.ts":
Step 1: <tool>{"name": "read_file", "arguments": {"path": "src/main.ts"}}</tool>
[wait for result]
Step 2: <tool>{"name": "edit_file", "arguments": {"path": "src/main.ts", "old_string": "import * as vscode", "new_string": "// Main entry point\nimport * as vscode"}}</tool>

EXAMPLE - User says "append these notes to MANUAL_TESTS.md":
CORRECT: <tool>{"name": "append_to_file", "arguments": {"path": "MANUAL_TESTS.md", "content": "\n## New Section\n\n1. Test step one\n2. Test step two\n"}}</tool>
WRONG: Showing the content in a markdown code block without calling a tool

EXAMPLE - User says "create a new file called utils.ts":
CORRECT: <tool>{"name": "create_file", "arguments": {"path": "src/utils.ts", "content": "export function helper() {\n  return true;\n}\n"}}</tool>

EXAMPLE - User says "rewrite generate-banner.py with the improvements" or "implement the changes":
Step 1: <tool>{"name": "read_file", "arguments": {"path": "scripts/generate-banner.py"}}</tool>
[wait for result]
Step 2: <tool>{"name": "write_file", "arguments": {"path": "scripts/generate-banner.py", "content": "...full updated file content..."}}</tool>
WRONG: Showing the updated file in a markdown code block without calling write_file

${buildTextModeShellExamples(detectShellEnvironment())}

CRITICAL — File Modifications:
- When user asks to UPDATE, EDIT, ADD TO, APPEND, MODIFY, WRITE, IMPLEMENT, REWRITE, APPLY, or FIX a file, you MUST call edit_file, append_to_file, write_file, or create_file
- Do NOT just show the content in a code block — ACTUALLY CALL THE TOOL to make the change
- If you have a full rewritten version of a file, call write_file with the complete content
- Always read_file FIRST before calling edit_file so you have the exact current content

CRITICAL — Actions and Commands:
- When user asks to MOVE, RENAME, REORGANIZE, RESTRUCTURE, MIGRATE, DELETE, or COPY files, you MUST call rename_file, delete_file, or run_command — do NOT just show shell commands in a code block
- When user asks to IMPLEMENT folder organization, restructuring, or recommendations from a document, you MUST call run_command (for mkdir) and rename_file (for moving files) — do NOT list the commands as code blocks
- When user asks to RUN, EXECUTE, DO, or PERFORM commands, you MUST call run_command or shell_read — do NOT just show the commands
- When user says "do it", "go ahead", "yes", "sure", "proceed", "confirmed", "yep", "yeah", "ok", "do them", "run those", "execute that", "make it happen" — they want you to CALL THE TOOLS IMMEDIATELY, not repeat the plan as code blocks
- NEVER ask "Would you like me to proceed?" or "Shall I continue?" — just call the tools. The built-in confirmation dialogs handle safety for destructive operations.
- NEVER output a numbered plan with empty code blocks. Call ONE tool, wait for the result, then call the next tool.
- To create directories, call run_command with "mkdir" — do NOT show the mkdir command in a code block
- To move files into new directories, call rename_file for each file — do NOT show mv/move commands in a code block

EXAMPLE - User says "move app/routes/admin.py to app/routes/admin/admin.py":
Step 1: <tool>{"name": "run_command", "arguments": {"command": "mkdir app\\routes\\admin"}}</tool>
[wait for result]
Step 2: <tool>{"name": "rename_file", "arguments": {"old_path": "app/routes/admin.py", "new_path": "app/routes/admin/admin.py"}}</tool>

EXAMPLE - User says "implement the folder organization changes" or "implement the recommendations":
Step 1: Read the document to understand the changes needed
Step 2: DISCOVER what files actually exist (MANDATORY before moving/renaming):
<tool>{"name": "list_files", "arguments": {"path": "app/routes"}}</tool>
[wait for result — now you know the REAL filenames]
Step 3: <tool>{"name": "run_command", "arguments": {"command": "mkdir app\\routes\\admin && mkdir app\\routes\\cashier"}}</tool>
[wait for result]
Step 4: BATCH ALL moves into as few run_command calls as possible using the REAL filenames from Step 2:
<tool>{"name": "run_command", "arguments": {"command": "move app\\routes\\admin_routes.py app\\routes\\admin\\ && move app\\routes\\audit.py app\\routes\\admin\\ && move app\\routes\\cashier_routes.py app\\routes\\cashier\\"}}</tool>
[if more files remain, batch them in the next run_command call]
WRONG: Calling list_files after every single move — you already know the filenames
WRONG: Moving one file per run_command call — batch them
WRONG: Skipping Step 2 and assuming filenames from the document
WRONG: Creating placeholder files when rename_file fails with ENOENT
WRONG: Listing the mkdir/move commands as code blocks for the user to run manually

EXAMPLE - User says "do it", "go ahead", "yes", "sure", or "proceed" after you showed a plan:
WRONG: Repeating the plan as code blocks
WRONG: Asking "Would you like me to proceed?"
CORRECT: Start calling the tools immediately (run_command, rename_file, write_file, etc.)

EXAMPLE - User says "look at docs/RECOMMENDATIONS.md and do the recommendations":
Step 1: <tool>{"name": "read_file", "arguments": {"path": "docs/RECOMMENDATIONS.md"}}</tool>
[wait for result — understand the changes needed]
Step 2: DISCOVER what files actually exist BEFORE moving anything:
<tool>{"name": "list_files", "arguments": {"path": "app/routes"}}</tool>
[wait for result — now you know the REAL filenames]
Step 3: Create directories and move files using the REAL filenames you discovered:
<tool>{"name": "run_command", "arguments": {"command": "mkdir app\\routes\\admin && mkdir app\\routes\\cashier"}}</tool>
[wait for result]
Step 4: BATCH ALL moves into as few run_command calls as possible:
<tool>{"name": "run_command", "arguments": {"command": "move app\\routes\\admin_routes.py app\\routes\\admin\\ && move app\\routes\\audit.py app\\routes\\admin\\ && move app\\routes\\cashier_routes.py app\\routes\\cashier\\"}}</tool>
WRONG: Calling list_files after every single move — you already know the filenames
WRONG: Moving one file per run_command call — batch them
WRONG: Assuming filenames from the document without checking — they may not match
WRONG: Creating placeholder files when rename_file fails — discover the real files instead
WRONG: Summarizing the document and asking for permission

EXAMPLE - User says "edit the code to point to the new file locations" or "update imports after reorganization":
This means UPDATE IMPORT STATEMENTS in source code, NOT move files. The files are already moved.
Step 1: Read the recommendations to understand old-to-new path mappings:
<tool>{"name": "read_file", "arguments": {"path": "docs/ORGANIZATION_RECOMMENDATIONS.md"}}</tool>
[wait for result - note which files moved where]
Step 2: Search for old import paths in the codebase:
<tool>{"name": "search_files", "arguments": {"query": "from app.routes.admin"}}</tool>
[wait for result - find all files that import from the old path]
Step 3: Read each affected file, then edit the import:
<tool>{"name": "read_file", "arguments": {"path": "app/main.py"}}</tool>
[wait for result]
Step 4: <tool>{"name": "edit_file", "arguments": {"path": "app/main.py", "old_string": "from app.routes.admin import", "new_string": "from app.routes.admin.admin import"}}</tool>
WRONG: Calling workspace_summary - you don't need the project structure, you need to find old imports
WRONG: Calling list_files - you don't need directory listings, you need to search file CONTENTS
WRONG: Calling run_command with mkdir or move - the files are ALREADY in their new locations
WRONG: Calling memory_list or memory_tier_write - focus on the code changes
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

    // For tools with a "content" field, extract it as everything between markers
    const contentTools = ['write_file', 'create_file', 'append_to_file', 'edit_file'];
    if (!contentTools.includes(toolName)) return null;

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

    // For write_file / create_file / append_to_file: extract the content field value
    const contentField = '"content"';
    const contentIdx = raw.indexOf(contentField);
    if (contentIdx === -1 || !pathMatch) return null;

    // Find the opening quote of the content value
    const colonAfterContent = raw.indexOf(':', contentIdx + contentField.length);
    if (colonAfterContent === -1) return null;

    // Skip whitespace and find opening quote
    let valStart = colonAfterContent + 1;
    while (valStart < raw.length && /\s/.test(raw[valStart])) valStart++;

    if (raw[valStart] === '"') {
        valStart++; // skip opening quote
        // Find the closing: look for "}} or "}  at the end
        // Work backwards from the end of the raw string
        let valEnd = raw.length - 1;
        while (valEnd > valStart && /[\s}]/.test(raw[valEnd])) valEnd--;
        if (raw[valEnd] === '"') valEnd--; // skip closing quote
        // But also handle triple-quote: the model may use """ which means the real content
        // starts after the triple-quote and ends before the closing triple-quote
        const afterColon = raw.slice(colonAfterContent + 1).trimStart();
        if (afterColon.startsWith('"""')) {
            // Triple-quoted content
            const tripleStart = raw.indexOf('"""', colonAfterContent) + 3;
            const tripleEnd = raw.lastIndexOf('"""');
            if (tripleEnd > tripleStart) {
                const content = raw.slice(tripleStart, tripleEnd);
                const escaped = JSON.stringify(content).slice(1, -1);
                return `{"name":"${toolName}","arguments":{"path":"${pathMatch[1]}","content":"${escaped}"}}`;
            }
        }

        const content = raw.slice(valStart, valEnd + 1);
        const escaped = JSON.stringify(content).slice(1, -1);
        return `{"name":"${toolName}","arguments":{"path":"${pathMatch[1]}","content":"${escaped}"}}`;
    }

    // Content might start with triple-quote without a regular quote
    const afterColonTrimmed = raw.slice(colonAfterContent + 1).trimStart();
    if (afterColonTrimmed.startsWith('"""')) {
        const tripleStart = raw.indexOf('"""', colonAfterContent) + 3;
        const tripleEnd = raw.lastIndexOf('"""');
        if (tripleEnd > tripleStart) {
            const content = raw.slice(tripleStart, tripleEnd);
            const escaped = JSON.stringify(content).slice(1, -1);
            return `{"name":"${toolName}","arguments":{"path":"${pathMatch[1]}","content":"${escaped}"}}`;
        }
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
                // Model may emit unescaped content (e.g. Python triple-quotes, raw newlines).
                // Try to repair by re-escaping string values between the outermost quotes.
                const repaired = repairToolJson(jsonStr);
                if (repaired) {
                    try {
                        const parsed = JSON.parse(repaired);
                        addCall(parsed, 'XML (repaired)');
                    } catch {
                        logWarn(`[parseTextToolCalls] Failed to parse XML JSON (even after repair): ${jsonStr.slice(0, 100)}`);
                    }
                } else {
                    logWarn(`[parseTextToolCalls] Failed to parse XML JSON: ${jsonStr.slice(0, 100)}`);
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
    private readonly MAX_AUTO_RETRIES = 2;

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

    constructor(
        private workspaceRoot: string,
        private readonly memory: TieredMemoryManager | null = null
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
            this._confirmResolver(false);
            this._confirmResolver = null;
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
    async compactContext(targetPercentage: number = 50): Promise<{ removed: number; newPercentage: number }> {
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

        return {
            removed: removedCount,
            newPercentage: targetPercentage
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
            this.history.push({ role: 'user', content: `${userMessage}\n\n[SYSTEM: The user confirmed. Start calling tools NOW to execute the plan. Call run_command, rename_file, write_file, or the appropriate tool immediately. Do NOT repeat the plan as code blocks — CALL THE TOOLS.]` });
        } else {
            // Detect file paths in user message and add a hint to read them
            const filePathMatch = userMessage.match(/(?:look at|read|open|check|see|review)\s+([\w./\\-]+\.\w{1,10})\b/i)
                || userMessage.match(/\b([\w./\\-]+\.(?:md|txt|py|ts|js|json|yaml|yml|toml|cfg|ini|html|css|sql|sh|bash|go|rs|java|rb|php|c|cpp|h))\b/i);
            if (filePathMatch && this.toolMode === 'text') {
                const filePath = filePathMatch[1].replace(/\\/g, '/');
                this.history.push({ role: 'user', content: `${userMessage}\n\n[SYSTEM: The user mentioned file "${filePath}". Call read_file with path="${filePath}" immediately. Do NOT call list_files on the directory.]` });
            } else {
                this.history.push({ role: 'user', content: userMessage });
            }
        }
        this.userTurnCount++;
        this.autoRetryCount = 0; // Reset auto-retry counter for each new user message
        this.memoryWritesThisResponse = 0; // Reset rate limiter for this response
        this._autoApprovedTools.clear(); // Reset batch-approve for each new user message
        this._failedCommandSignatures.clear(); // Reset failed command tracking
        
        logInfo(`Agent run — model: ${model}, mode: ${this.toolMode}, history: ${this.history.length}`);

        // ── Programmatic pre-processing pipeline ─────────────────────────
        // For complex multi-step tasks (like updating imports after reorganization),
        // do all discovery work programmatically BEFORE the model gets involved.
        // This eliminates the multi-step tool-calling chain that small models fail at.
        const preProcessedContext = await this.preProcessPathUpdate(userMessage, post);
        if (preProcessedContext) {
            // Replace the user message in history with the enriched version
            // The last item in history is the user message we just pushed
            this.history[this.history.length - 1] = {
                role: 'user',
                content: `${userMessage}\n\n${preProcessedContext}`,
            };
            logInfo(`[pre-process] Injected ${preProcessedContext.length} chars of pre-processed context`);
        }

        // Resolve actual context limit from Ollama (cached after first call)
        await resolveModelContextLimit(model);

        const cfg = getConfig();
        const baseSystemContent = cfg.systemPrompt.trim() || await buildSystemPromptAsync(cfg.autoSaveMemory, this.workspaceRoot);

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

        const MAX_TURNS = 25;
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

            // Build system content only when toolMode changes
            const isTextMode = this.toolMode === 'text';
            if (this.toolMode !== lastToolMode) {
                systemContent = isTextMode
                    ? baseSystemWithMemory + buildTextModeInstructions(cfg.autoSaveMemory)
                    : baseSystemWithMemory;
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
            const mcpTools = mcpToolsToOllamaFormat();
            const tools = isTextMode ? [] : [...TOOL_DEFINITIONS, ...mcpTools];
            
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
                if (isTextMode && turn < MAX_TURNS - 1 && this.autoRetryCount < this.MAX_AUTO_RETRIES) {
                    const resp = (displayContent || result.content).toLowerCase();
                    const lastMsg = (userMessage).toLowerCase();
                    const isAskingPermission = /would you like me to|shall i|do you want me to|want me to proceed|like me to continue|is there anything specific/i.test(resp);
                    const userWantsAction = /\b(do|implement|apply|execute|run|move|rename|reorganize|restructure|create|make|build|set up|migrate|edit|update|change|fix|modify|refactor|point|adjust|rewrite|convert|transform)\b/.test(lastMsg);
                    const hasCodeBlockButNoTool = /```/.test(resp) && !toolCalls.length;
                    const isVerbosePlanDump = !toolCalls.length && userWantsAction && (resp.length > 400 || hasCodeBlockButNoTool);

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
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model dumped a verbose plan (${resp.length} chars) without calling tools (turn ${turn})`);
                        this.history.pop();
                        this.history.push({
                            role: 'user',
                            content: '[SYSTEM: You output a plan as text instead of calling tools. Do NOT explain what you will do — CALL THE FIRST TOOL NOW. Output only a <tool> block, nothing else.]'
                        });
                        post({ type: 'removeLastAssistant' });
                        continue;
                    }

                    // Third path: model summarized tool results and asked what to do next
                    // instead of continuing to act (e.g., "Here are the results... Would you like me to proceed?")
                    const isSummaryWithQuestion = !isAskingPermission && userWantsAction && !toolCalls.length
                        && turn > 0 && resp.length > 100
                        && /\b(here are|the (?:search|results?|output|matches)|found \d+|instances?|occurrences?)\b/i.test(resp)
                        && /\b(would you|shall i|do you want|like me to|specific file|which file|what file|have another|next step)\b/i.test(resp);
                    if (isSummaryWithQuestion) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model summarized results and asked instead of acting (turn ${turn})`);
                        this.history.pop();
                        this.history.push({
                            role: 'user',
                            content: '[SYSTEM: You summarized the results and asked for permission. STOP ASKING. The user already told you to do it. Pick the FIRST affected file from the search results, call read_file on it, then call edit_file to update the import. Do NOT summarize or ask — ACT NOW.]'
                        });
                        post({ type: 'removeLastAssistant' });
                        continue;
                    }

                    // Fourth path: model gave a text-only response on the first turn when user wants action
                    // This catches cases where the model gives generic advice instead of calling tools
                    if (turn === 0 && userWantsAction && !toolCalls.length && resp.length > 20) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model gave text-only response on first turn when user wants action (${resp.length} chars, turn ${turn})`);
                        this.history.pop();
                        this.history.push({
                            role: 'user',
                            content: '[SYSTEM: You responded with text instead of calling a tool. The user wants you to take ACTION on their codebase. Start by reading the relevant file or searching the codebase. Call read_file, search_files, shell_read, or list_files NOW. Output only a <tool> block, nothing else.]'
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
            // In text mode, execute only the FIRST tool call.
            // The model often dumps all planned calls in one response;
            // executing only the first aligns with the "one tool per response" loop.
            const callsToExecute = isTextMode && toolCalls.length > 1
                ? [toolCalls[0]]
                : toolCalls;
            if (isTextMode && toolCalls.length > 1) {
                logInfo(`[agent] Text-mode: model emitted ${toolCalls.length} tool calls, executing only the first (${toolCalls[0].function.name})`);
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
                    const hint = `You already called ${name} with the same arguments ${this.consecutiveRepeats + 1} times and got the same result. DO NOT call this tool again. Use the result you already have and respond to the user with a text answer now.`;
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
                // Use higher limit for action tools (rename_file, run_command) which legitimately
                // need many consecutive calls during batch operations (e.g., reorganizing 20 files)
                const ACTION_BATCH_TOOLS = new Set(['rename_file', 'run_command', 'shell_read', 'edit_file', 'write_file', 'create_file', 'delete_file', 'memory_tier_write']);
                const sameToolLimit = ACTION_BATCH_TOOLS.has(name)
                    ? this.MAX_CONSECUTIVE_SAME_TOOL_ACTION
                    : this.MAX_CONSECUTIVE_SAME_TOOL_DEFAULT;
                if (this.consecutiveSameToolCalls >= sameToolLimit) {
                    logWarn(`[agent] Breaking same-tool loop: ${name} called ${this.consecutiveSameToolCalls} times consecutively (limit: ${sameToolLimit})`);
                    // Tell the model to summarize progress and continue — don't tell it to stop entirely
                    const hint = `You have called ${name} ${this.consecutiveSameToolCalls} times in a row. Summarize what you have done so far and what remains. If there are more steps, the user will ask you to continue.`;
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

                let toolResult: string;
                try {
                    toolResult = await this.executeTool(name, args, toolId);
                    logInfo(`Tool ${name} OK — ${toolResult.length} chars`);
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

                    // When rename_file fails with ENOENT, nudge model to discover actual files
                    if (name === 'rename_file' && toolResult.includes('ENOENT')) {
                        const oldPath = String(args.old_path ?? '');
                        const parentDir = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : '.';
                        const enoentHint = `The file "${oldPath}" does not exist. Call list_files with path="${parentDir}" to see what files actually exist, then use the correct filename. Do NOT create placeholder files.`;
                        if (isTextMode) {
                            this.history.push({ role: 'user', content: `Tool ${name} returned:\n${toolResult}\n---\n${enoentHint}` });
                        } else {
                            this.history.push({ role: 'tool', content: `${toolResult}\n\n${enoentHint}` });
                        }
                        continue;
                    }
                    
                    // Break loop if too many consecutive failures — give model a hint to try differently
                    if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
                        logWarn(`[agent] ${this.consecutiveFailures} consecutive tool failures — nudging model to try a different approach`);
                        const hint = name === 'edit_file'
                            ? `You have had ${this.consecutiveFailures} consecutive edit_file failures — your old_string does not match the file content. STOP guessing. Call read_file on the file FIRST to see the EXACT current content, then retry edit_file with the correct old_string copied exactly from the file. If the file structure is very different from what you expected, use write_file instead.`
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
                    const FILE_WRITE_TOOLS = new Set(['edit_file', 'write_file', 'append_to_file', 'create_file']);
                    const FILE_READ_TOOLS = new Set(['read_file', 'workspace_summary', 'list_files', 'search_files', 'find_files']);
                    const ACTION_TOOLS = new Set(['run_command', 'rename_file', 'delete_file']);
                    let nudge: string;

                    // Special case: if the model jumped to mkdir/move without discovering first,
                    // and the command failed, nudge it to list_files first
                    if (name === 'run_command' && /\b(mkdir|move|ren)\b/i.test(String(args.command ?? ''))) {
                        const cmdStr = String(args.command ?? '');
                        const isMoveCmd = /\bmove\b/i.test(cmdStr);
                        const isMkdirCmd = /\bmkdir\b/i.test(cmdStr);
                        const lastUserMsg = (this.lastUserMessage ?? '').toLowerCase();
                        const userWantsPathUpdate = /\b(point|location|path|import|reference)\b/i.test(lastUserMsg) && /\b(edit|update|change|fix|modify)\b/i.test(lastUserMsg);
                        const hasFailed = toolResult.includes('cannot find') || toolResult.includes('not found') || toolResult.includes('Error') || toolResult.includes('syntax') || toolResult.includes('incorrect') || (toolResult.includes('exit 1') && !toolResult.includes('file(s) moved'));
                        // If user explicitly wants to update code references, block mkdir/move entirely
                        if (userWantsPathUpdate && (isMoveCmd || isMkdirCmd)) {
                            nudge = 'STOP — the user wants you to UPDATE CODE REFERENCES (import statements, paths in code), NOT move files. The files are already in their new locations. Use search_files or shell_read with findstr/grep to find where the OLD import paths are used, then use edit_file to update them. Do NOT use mkdir or move.';
                        } else if (toolResult.includes('already exists')) {
                            nudge = 'The directory already exists — that is fine, no need to retry. Continue with the next step (e.g., moving files into the directory).';
                        } else if (hasFailed && isMoveCmd) {
                            // Track this specific failing command
                            const cmdSig = String(args.command ?? '').toLowerCase().trim();
                            const failCount = (this._failedCommandSignatures.get(cmdSig) ?? 0) + 1;
                            this._failedCommandSignatures.set(cmdSig, failCount);
                            if (failCount >= this.MAX_SAME_COMMAND_FAILURES) {
                                nudge = `STOP — you have tried this exact move command ${failCount} times and it keeps failing. The files do NOT exist at those paths. They were ALREADY MOVED previously. The user wants you to UPDATE IMPORT STATEMENTS and code references to point to the new file locations — NOT move files again. Use search_files or shell_read with findstr/grep to find where the OLD import paths are used in the codebase, then use edit_file to update them to the NEW paths.`;
                            } else {
                                nudge = 'The move command FAILED — one or more source files do not exist at those paths. You MUST call list_files NOW on the source directory to see the ACTUAL filenames, then retry with the correct names. Do NOT guess filenames from a document — verify them first.';
                            }
                        } else if (hasFailed) {
                            nudge = 'The command failed. Before creating directories or moving files, you MUST call list_files first to see what files and directories actually exist. Call list_files NOW on the relevant directory. On Windows, use backslashes in paths (e.g., app\\routes\\admin).';
                        } else if (isMoveCmd) {
                            nudge = 'Good — files moved. If there are MORE files to move, batch as many as possible into ONE run_command call (e.g., "move a.py admin\\ && move b.py admin\\ && move c.py cashier\\"). Do NOT call list_files between moves — you already know the filenames. Do NOT stop until ALL files have been moved.';
                        } else if (isMkdirCmd) {
                            nudge = 'Directories created. Now move the files into them. Batch ALL moves into as few run_command calls as possible (e.g., "move a.py admin\\ && move b.py admin\\ && move c.py cashier\\"). Do NOT call list_files between moves — you already know the filenames from your earlier discovery.';
                        } else {
                            nudge = 'Command completed. Continue with the next step.';
                        }
                    } else if (FILE_WRITE_TOOLS.has(name)) {
                        nudge = 'If you have MORE edits to make for the user\'s request, call the next edit_file or write_file tool NOW. Do NOT show remaining changes as a code block — CALL THE TOOL. Only respond with text once ALL file changes are complete.';
                    } else if (ACTION_TOOLS.has(name)) {
                        // Specific nudge for successful rename_file: do NOT read the moved file
                        if (name === 'rename_file') {
                            nudge = 'File moved successfully. Do NOT call read_file on the moved file — it is already done. Proceed to the NEXT rename_file call immediately. Only respond with text once ALL files have been moved.';
                        } else {
                            nudge = 'If you have MORE actions to perform for the user\'s request (more files to move, more commands to run, more directories to create), call the next tool NOW. Do NOT show remaining commands as code blocks — CALL THE TOOL. Only respond with text once ALL actions are complete.';
                        }
                    } else if (FILE_READ_TOOLS.has(name) || name === 'shell_read') {
                        // Check if the user's request implies file modifications or actions are needed
                        const lastUserMsg = (this.lastUserMessage ?? '').toLowerCase();
                        // FIRST: detect path-update intent — this takes priority over everything else
                        const wantsPathUpdate = /\b(point|location|path|import|reference|reorganiz|moved|new folder|new director)\b/i.test(lastUserMsg)
                            && /\b(edit|update|change|fix|modify|point|adjust|rewrite)\b/i.test(lastUserMsg);
                        const wantsAction = /\b(move|rename|reorganize|restructure|migrate|run|execute|do\s+(it|them|that|those|this|the)|go\s+ahead|make\s+it|mkdir|delete|remove|copy)\b/.test(lastUserMsg)
                            || (/\b(implement|apply)\b/.test(lastUserMsg) && /\b(organiz|restructur|folder|director|migrat|move|layout|recommend)/.test(lastUserMsg))
                            || (/\b(do)\b/.test(lastUserMsg) && /\b(recommend|suggestion|change|reorganiz|restructur|organiz)/.test(lastUserMsg));
                        const wantsEdit = /\b(apply|implement|rewrite|update|edit|modify|fix|refactor|improve|change|add|append|write|create|replace|overhaul|rework|redo|revise|optimize|clean\s*up)\b/.test(lastUserMsg);
                        // Detect empty filename search results from shell_read (dir, where, find)
                        const isEmptyFileSearch = name === 'shell_read'
                            && /\b(dir|where|find)\b/i.test(String(args.command ?? ''))
                            && (/File Not Found|not found|No matches|0 File/i.test(toolResult) || toolResult.trim().split('\n').every(l => /^\s*(Volume|Directory|File Not Found|$)/i.test(l.trim())));
                        if (wantsPathUpdate) {
                            // Path-update intent detected — redirect to the correct workflow
                            // The workflow depends on which tool just ran:
                            // - After search_files: we have the list of affected files, now read_file the first one
                            // - After read_file: we have the file content, now edit_file to update the import
                            // - After other tools: redirect to search_files first
                            if (name === 'search_files') {
                                // We have search results — pick the first affected file and READ it
                                nudge = 'Good — you found files with old import paths. Now pick the FIRST file from the search results and call read_file on it to see the EXACT current content. Do NOT call edit_file yet — you must read_file FIRST to get the exact old_string. After reading, you will call edit_file with the precise import line.';
                            } else if (name === 'read_file') {
                                // We have file content — now edit it
                                nudge = 'You have now read the file. Find the import statement that needs updating (e.g., "from app.routes.admin import ...") and call edit_file with the EXACT old_string from the file content above. Replace it with the new import path. Do NOT guess — copy the exact line from the file.';
                            } else {
                                // Other tools (workspace_summary, list_files, etc.) — redirect to search_files
                                nudge = 'STOP reading more files. The user wants you to UPDATE IMPORT PATHS. Your NEXT STEP must be: use search_files to find where the OLD import paths are referenced (e.g., search for "from app.routes.admin"). Do NOT call workspace_summary, list_files, or read more docs. Do NOT move files — they are already in their new locations.';
                            }
                        } else if (wantsAction) {
                            nudge = 'You have the information you need. The user wants you to PERFORM ACTIONS (move files, run commands, create directories, etc.). Call run_command, rename_file, or the appropriate tool NOW. Do NOT show commands as code blocks — ACTUALLY CALL THE TOOL.';
                        } else if (wantsEdit) {
                            nudge = 'You have now read the file. The user wants you to MODIFY it. Call write_file or edit_file NOW with the updated content. Do NOT show the changes as a code block — ACTUALLY CALL THE TOOL.';
                        } else if (isEmptyFileSearch) {
                            const env = detectShellEnvironment();
                            const searchHint = env.os === 'windows'
                                ? 'findstr /S /N /I "keyword" *.py *.html *.js *.ts *.json'
                                : 'grep -rn "keyword" --include="*.py" --include="*.html" .';
                            nudge = `The filename search returned no results. The code you are looking for is probably INSIDE files, not in the filename. Try searching FILE CONTENTS instead using shell_read with: ${searchHint} — replace "keyword" with the most distinctive word from the user\'s query. You can also try search_files or find_files with a simpler/shorter pattern.`;
                        } else {
                            nudge = 'The user can already see the tool output above. Do NOT repeat or reformat the raw output. Summarize the result and answer the user\'s question. If the result is INCOMPLETE (e.g., you found JS dependencies but the project is Python, or you only checked one config file), call the appropriate tool to check additional sources. Otherwise, do NOT call more tools.';
                        }
                    } else if ((name === 'memory_list' || name === 'memory_tier_list' || name === 'memory_stats') && /\b(explain|describe|what does|what is|overview|understand|about this project|how does|walk me through|summarize|summary)\b/i.test(this.lastUserMessage ?? '')) {
                        nudge = 'Memory alone does NOT answer the user\'s question — they want to understand the actual codebase. Call workspace_summary NOW to see the project structure, then read_file on key files (package.json, README.md, etc.) to give a real answer. Do NOT answer based only on memory notes.';
                    } else {
                        nudge = 'If this result answers the user\'s question, respond to the user NOW with the information. Do NOT call more tools unless absolutely necessary.';
                    }
                    this.history.push({
                        role: 'user',
                        content: `Tool ${name} returned:\n${toolResult}\n---\n${nudge}`,
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

            // ── read_file ──────────────────────────────────────────────────
            case 'read_file': {
                const rel = String(args.path ?? '');
                if (!rel) { throw new Error('path is required'); }
                const full = this.safePath(root, rel);
                const content = fs.readFileSync(full, 'utf8');
                const lineCount = content.split('\n').length;
                return `File: ${rel} (${lineCount} lines)\n${'─'.repeat(50)}\n${content}`;
            }

            // ── list_files ─────────────────────────────────────────────────
            case 'list_files': {
                const rel = String(args.path ?? '.');
                const dir = this.safePath(root, rel);
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                const lines = entries
                    .filter((e) => !SKIP_DIRS.has(e.name))
                    .sort((a, b) => {
                        if (a.isDirectory() !== b.isDirectory()) { return a.isDirectory() ? -1 : 1; }
                        return a.name.localeCompare(b.name);
                    })
                    .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
                    .join('\n');
                return `${rel}:\n${lines || '(empty)'}`;
            }

            // ── search_files ───────────────────────────────────────────────
            case 'search_files': {
                const query = String(args.query ?? '');
                if (!query) { throw new Error('query is required'); }
                const searchDir = args.path ? this.safePath(root, String(args.path)) : root;
                logInfo(`[search_files] Searching for "${query}" in: ${searchDir}`);
                
                // Use native OS tools for efficient searching
                const isWindows = process.platform === 'win32';
                const MAX_RESULTS = 100;
                
                // Binary/generated file extensions to exclude from search results
                const BINARY_EXTENSIONS = new Set([
                    '.pyc', '.pyo', '.pyd', '.class', '.jar', '.war', '.ear',
                    '.dll', '.exe', '.obj', '.o', '.so', '.dylib', '.a', '.lib',
                    '.wasm', '.node',
                    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff',
                    '.woff', '.woff2', '.ttf', '.eot', '.otf',
                    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
                    '.zip', '.gz', '.tar', '.bz2', '.7z', '.rar', '.xz',
                    '.db', '.sqlite', '.sqlite3', '.mdb',
                    '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg',
                    '.bin', '.dat', '.pak', '.cache', '.log',
                    '.min.js', '.min.css', '.map',
                ]);
                
                return new Promise<string>((resolve) => {
                    let searchCommand: string;
                    let searchArgs: string[];
                    
                    // Directories to exclude from search results
                    const SKIP_SEARCH_DIRS = new Set([
                        'node_modules', '.git', '.vscode-test', '__pycache__',
                        'dist', 'coverage', '.nyc_output', '.next', '.nuxt',
                        'build', 'out', '.tox', '.mypy_cache', '.pytest_cache',
                        'venv', '.venv', 'env', '.env', 'htmlcov', 'vendor',
                        '.svn', '.hg', 'bower_components', '.cache', 'archive',
                        'logs', 'tests', 'test', '.eggs', 'migrations',
                    ]);

                    if (isWindows) {
                        // Windows: use findstr with recursive search
                        // /S = recursive, /N = line numbers, /I = case insensitive
                        searchCommand = 'findstr';
                        searchArgs = ['/S', '/N', '/I', query, '*.*'];
                    } else {
                        // Unix/Linux/macOS: use grep with --exclude-dir
                        // -r = recursive, -n = line numbers, -i = case insensitive, -I = skip binary files
                        searchCommand = 'grep';
                        const excludeDirs = [...SKIP_SEARCH_DIRS].map(d => `--exclude-dir=${d}`);
                        searchArgs = ['-r', '-n', '-i', '-I', ...excludeDirs, '--', query, '.'];
                    }
                    
                    const child = spawn(searchCommand, searchArgs, {
                        cwd: searchDir,
                        shell: false,
                        env: { ...process.env }
                    });
                    this.trackChild(child);
                    
                    let output = '';
                    let lineCount = 0;
                    const results: string[] = [];
                    
                    child.stdout?.on('data', (data: Buffer) => {
                        output += data.toString();
                    });
                    
                    child.stderr?.on('data', (data: Buffer) => {
                        // Log stderr but don't fail (grep returns 1 if no matches)
                        const err = data.toString();
                        if (err.trim()) {
                            logInfo(`[search_files] stderr: ${err.trim()}`);
                        }
                    });
                    
                    child.on('close', (code) => {
                        // grep/findstr exit codes:
                        // 0 = matches found
                        // 1 = no matches (not an error)
                        // 2+ = actual error
                        
                        if (code !== null && code > 1) {
                            logError(`[search_files] Command failed with code ${code}`);
                            resolve(`Search failed. Make sure ${searchCommand} is available on your system.`);
                            return;
                        }
                        
                        if (!output.trim()) {
                            resolve(`No matches found for "${query}"`);
                            return;
                        }
                        
                        // Parse output and format results
                        const lines = output.split('\n');
                        for (const line of lines) {
                            if (!line.trim() || lineCount >= MAX_RESULTS) break;
                            
                            // Format: filepath:linenum:content (grep)
                            // Format: filepath:linenum:content (findstr)
                            const match = line.match(/^(?:[A-Za-z]:)?([^:]+):(\d+):(.*)$/);
                            if (match) {
                                const [, filepath, linenum, content] = match;
                                // Make path relative to workspace root
                                // On Windows, findstr returns paths relative to cwd already
                                let relPath: string;
                                const fullFilepath = line.slice(0, line.length - content.length - linenum.length - 2);
                                if (path.isAbsolute(fullFilepath)) {
                                    relPath = path.relative(root, fullFilepath);
                                } else if (searchDir === root) {
                                    relPath = filepath;
                                } else {
                                    relPath = path.relative(root, path.join(searchDir, filepath));
                                }
                                
                                // Skip binary/generated files (especially important on Windows where findstr doesn't skip them)
                                const ext = path.extname(relPath).toLowerCase();
                                if (BINARY_EXTENSIONS.has(ext)) { continue; }
                                // Skip excluded directories (critical on Windows where findstr has no --exclude-dir)
                                const pathParts = relPath.split(/[\\/]/);
                                if (pathParts.some(part => SKIP_SEARCH_DIRS.has(part))) { continue; }
                                
                                results.push(`${relPath}:${linenum}: ${content.trim()}`);
                                lineCount++;
                            }
                        }
                        
                        if (results.length === 0) {
                            resolve(`No matches found for "${query}"`);
                        } else {
                            const truncated = lineCount >= MAX_RESULTS ? ` (showing first ${MAX_RESULTS})` : '';
                            resolve(`Results for "${query}" (${results.length})${truncated}:\n${results.join('\n')}`);
                        }
                    });
                    
                    child.on('error', (err) => {
                        logError(`[search_files] Failed to spawn ${searchCommand}: ${err.message}`);
                        resolve(`Search failed: ${searchCommand} not available. Error: ${err.message}`);
                    });
                    
                    // Timeout after 30 seconds
                    setTimeout(() => {
                        child.kill();
                        resolve(`Search timed out after 30 seconds. Try narrowing the search path.`);
                    }, 30000);
                });
            }

            // ── create_file ────────────────────────────────────────────────
            case 'create_file': {
                const rel     = String(args.path ?? '');
                const content = String(args.content ?? '');
                if (!rel) { throw new Error('path is required'); }
                const full = this.safePath(root, rel);
                if (fs.existsSync(full)) {
                    throw new Error(`File already exists: ${rel}. Use write_file to overwrite or edit_file to modify.`);
                }
                // Block placeholder/dummy file creation — model should find and move real files
                const isPlaceholder = /^#\s*(placeholder|empty|stub|todo)/im.test(content.trim())
                    || (content.trim().split('\n').length <= 3 && /def\s+\w+\(\):\s*pass/m.test(content));
                if (isPlaceholder) {
                    throw new Error(`Blocked: "${rel}" looks like a placeholder file. Do NOT create dummy files. Use list_files to find the real source files and rename_file to move them.`);
                }
                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, content, 'utf8');
                this._lastFileOp = { path: rel, originalContent: null, action: 'created' };
                this.postFn({ type: 'fileChanged', path: rel, action: 'created' });
                clearWorkspaceSummaryCache();
                return `Created: ${rel} (${content.split('\n').length} lines)`;
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
                    // Provide helpful context so the model can self-correct
                    const firstLineOld = oldString.split('\n')[0].trim();
                    const nearLine = original.split('\n').findIndex(
                        (l) => l.trim() === firstLineOld
                    );
                    const hint = nearLine >= 0
                        ? ` First line found at line ${nearLine + 1}, but the full block didn't match — check indentation.`
                        : ' The first line of old_string was not found in the file.';
                    throw new Error(`edit_file: old_string not found in ${rel}.${hint} Re-read the file and try again.`);
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

                // Open diff view for review, then ask for confirmation in chat
                await this.diffViewManager.showDiffPreview(full, original, newContent);
                const accepted = await this.requestConfirmation('edit', `Edit "${rel}" — ${oldString.split('\n').length} line(s) changed`, 'edit_file');
                this.diffViewManager.closeDiffPreview();

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

            // ── write_file ─────────────────────────────────────────────────
            case 'write_file': {
                const rel     = String(args.path ?? '');
                const content = String(args.content ?? '');
                if (!rel) { throw new Error('path is required'); }
                const full = this.safePath(root, rel);
                // Block placeholder/dummy file creation via write_file too
                if (!fs.existsSync(full)) {
                    const isPlaceholder = /^#\s*(placeholder|empty|stub|todo)/im.test(content.trim())
                        || (content.trim().split('\n').length <= 3 && /def\s+\w+\(\):\s*pass/m.test(content))
                        || (content.trim().split('\n').length <= 2 && /^#\s*placeholder/im.test(content.trim()));
                    if (isPlaceholder) {
                        throw new Error(`Blocked: "${rel}" looks like a placeholder file. Do NOT create dummy files. The file was already moved to its new location. Use search_files to find where the old path is referenced, then edit_file to update the import paths.`);
                    }
                }
                const originalContent = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;

                const accepted = await this.requestConfirmation('write', `Overwrite "${rel}" (${content.split('\n').length} lines)`, 'write_file');
                if (!accepted) { return 'Write cancelled by user.'; }

                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, content, 'utf8');
                this._lastFileOp = { path: rel, originalContent, action: 'written' };
                this.postFn({ type: 'fileChanged', path: rel, action: 'written' });
                clearWorkspaceSummaryCache();
                const writeResult = `Written: ${rel} (${content.split('\n').length} lines)`;
                // Auto-check diagnostics after write
                const writeDiags = this.getDiagnostics(root, rel);
                if (writeDiags !== 'No errors or warnings found.') {
                    return `${writeResult}\n\nDiagnostics after write:\n${writeDiags}`;
                }
                return writeResult;
            }

            // ── append_to_file ─────────────────────────────────────────────
            case 'append_to_file': {
                const rel     = String(args.path ?? '');
                const content = String(args.content ?? '');
                if (!rel) { throw new Error('path is required'); }
                const full = this.safePath(root, rel);
                if (!fs.existsSync(full)) {
                    throw new Error(`File not found: ${rel}. Use create_file instead.`);
                }
                const beforeAppend = fs.readFileSync(full, 'utf8');
                fs.appendFileSync(full, content, 'utf8');
                this._lastFileOp = { path: rel, originalContent: beforeAppend, action: 'appended' };
                this.postFn({ type: 'fileChanged', path: rel, action: 'appended' });
                return `Appended ${content.length} chars to ${rel}`;
            }

            // ── rename_file ────────────────────────────────────────────────
            case 'rename_file': {
                const oldRel = String(args.old_path ?? '');
                const newRel = String(args.new_path ?? '');
                if (!oldRel || !newRel) { throw new Error('old_path and new_path are required'); }
                const oldFull = this.safePath(root, oldRel);
                const newFull = this.safePath(root, newRel);

                const accepted = await this.requestConfirmation('rename', `Rename "${oldRel}" → "${newRel}"`, 'rename_file');
                if (!accepted) { return 'Rename cancelled by user.'; }

                fs.mkdirSync(path.dirname(newFull), { recursive: true });
                fs.renameSync(oldFull, newFull);
                this.postFn({ type: 'fileChanged', path: newRel, action: 'renamed' });
                clearWorkspaceSummaryCache();
                return `Renamed: ${oldRel} → ${newRel}`;
            }

            // ── delete_file ────────────────────────────────────────────────
            case 'delete_file': {
                const rel = String(args.path ?? '');
                if (!rel) { throw new Error('path is required'); }
                const full = this.safePath(root, rel);
                if (!fs.existsSync(full)) {
                    throw new Error(`File not found: ${rel}`);
                }
                const originalContent = fs.readFileSync(full, 'utf8');

                const accepted = await this.requestConfirmation('delete', `Delete "${rel}" — this cannot be undone`, 'delete_file');
                if (!accepted) { return 'Delete cancelled by user.'; }

                fs.unlinkSync(full);
                this._lastFileOp = { path: rel, originalContent, action: 'deleted' };
                this.postFn({ type: 'fileChanged', path: rel, action: 'deleted' });
                clearWorkspaceSummaryCache();
                return `Deleted: ${rel}`;
            }

            // ── find_files ─────────────────────────────────────────────────
            case 'find_files': {
                const pattern = String(args.pattern ?? '');
                if (!pattern) { throw new Error('pattern is required'); }
                const searchDir = args.path ? String(args.path) : '';
                const MAX_RESULTS = 200;
                const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/__pycache__/**,**/.nyc_output/**,**/coverage/**}';

                try {
                    // First try exact glob match
                    const globPattern = searchDir ? `${searchDir}/${pattern}` : `**/${pattern}`;
                    let uris = await vscode.workspace.findFiles(globPattern, excludePattern, MAX_RESULTS + 1);

                    // If no results, try substring/keyword fallback:
                    // Extract the base name without glob chars and search for files containing those keywords
                    if (uris.length === 0) {
                        const baseName = pattern.replace(/^\*+/, '').replace(/\*+$/, '').replace(/\.[^.]*$/, '').replace(/[*?\[\]{}]/g, '');
                        if (baseName.length >= 3) {
                            const keywords = baseName.split(/[_\-]+/).filter(k => k.length >= 3);
                            if (keywords.length > 0) {
                                // Search for files containing the first keyword in the name
                                const broadGlob = searchDir ? `${searchDir}/**/*${keywords[0]}*` : `**/*${keywords[0]}*`;
                                const broadUris = await vscode.workspace.findFiles(broadGlob, excludePattern, MAX_RESULTS * 2);
                                // Filter to files that contain ALL keywords (case-insensitive)
                                const lowerKeywords = keywords.map(k => k.toLowerCase());
                                uris = broadUris.filter(uri => {
                                    const name = path.basename(uri.fsPath).toLowerCase();
                                    return lowerKeywords.every(kw => name.includes(kw));
                                }).slice(0, MAX_RESULTS + 1);
                                if (uris.length > 0) {
                                    logInfo(`[find_files] Glob "${pattern}" had no results; substring fallback on keywords [${keywords.join(', ')}] found ${uris.length}`);
                                }
                            }
                        }
                    }

                    if (uris.length === 0) {
                        return `No files matching "${pattern}". Try a broader pattern or use search_files to search file contents.`;
                    }

                    const results = uris.slice(0, MAX_RESULTS).map(uri => {
                        return path.relative(root, uri.fsPath).replace(/\\/g, '/');
                    }).filter(l => !l.startsWith('..'));

                    const truncated = uris.length > MAX_RESULTS;
                    const suffix = truncated ? `\n(showing first ${MAX_RESULTS} of ${uris.length}+)` : '';
                    return `Files matching "${pattern}" (${results.length}):${suffix}\n${results.join('\n')}`;
                } catch (err) {
                    return `find_files failed: ${toErrorMessage(err)}`;
                }
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

            // Use shell: true for cross-platform compatibility (Windows/Unix)
            const child = spawn(cmd, {
                cwd,
                env: { ...process.env },
                shell: true,
            });
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

            const child = spawn(cmd, {
                cwd,
                env: { ...process.env },
                shell: true,
            });
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
                resolve(output.slice(0, LIMIT) || `(exited with code ${code ?? 0})`);
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
        if (!full.startsWith(root)) {
            throw new Error(`Path "${rel}" is outside the workspace`);
        }
        // Resolve symlinks to prevent escaping workspace via symlink
        try {
            const real = fs.realpathSync(full);
            if (!real.startsWith(fs.realpathSync(root))) {
                throw new Error(`Path "${rel}" resolves outside the workspace via symlink`);
            }
        } catch (err) {
            // realpathSync throws if file doesn't exist yet (create_file) — that's OK
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
        post({ type: 'toolCall', id: docToolId, name: 'read_file', args: { path: docPath } });
        post({ type: 'toolResult', id: docToolId, name: 'read_file', success: true, preview: `Read ${docPath} (${docContent.split('\n').length} lines)` });

        // Step 2: Build a map of module_name → new_subdir by scanning the actual filesystem.
        // E.g., if routes/admin/dashboard.py exists, then "app.routes.dashboard" → "app.routes.admin.dashboard"
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
                            moduleMap.set(oldImport, newImport);
                        }
                    } catch { /* skip unreadable subdirs */ }
                }
            } catch { /* skip */ }
        }

        if (moduleMap.size === 0) {
            logInfo('[pre-process] No module relocations detected, skipping pipeline');
            return '';
        }

        logInfo(`[pre-process] Built module map: ${moduleMap.size} relocated modules`);

        // Step 3: Scan .py files directly for stale imports (fast — no child processes)
        const searchToolId = `t_${Date.now()}_pre2`;
        interface ImportEdit { lineNum: number; oldLine: string; oldImport: string; newImport: string }
        const editsPerFile = new Map<string, ImportEdit[]>();

        post({ type: 'toolCall', id: searchToolId, name: 'search_files', args: { query: `(scanning .py files for ${moduleMap.size} old import patterns)` } });

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
        post({ type: 'toolResult', id: searchToolId, name: 'search_files', success: true, preview: `Found ${totalEdits} stale imports across ${editsPerFile.size} files` });

        if (editsPerFile.size === 0) {
            logInfo('[pre-process] No stale imports found — imports may already be up to date');
            return '[SYSTEM: Pre-processing complete. Searched for stale imports based on the recommendations doc but found none — all imports appear to already point to the correct locations. Tell the user that no import changes are needed.]';
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
            ``,
            `Tell the user what was done. List the files that were updated and summarize the import path changes.`,
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
}
