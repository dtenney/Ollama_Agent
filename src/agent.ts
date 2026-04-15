import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { spawn, execSync } from 'child_process';

import { streamChatRequest, OllamaMessage, OllamaToolCall, StreamResult, ToolsNotSupportedError } from './ollamaClient';
import { getConfig, getSearchConfig } from './config';
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
import { appendSessionLog, GuardEvent, ToolCallRecord } from './sessionLog';
import type { ActiveTaskState } from './chatStorage';

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

interface FilePlan {
    relPath: string;
    action: 'create' | 'modify';
    description: string;
}

let _cachedShellEnv: ShellEnvironment | null = null;

/**
 * Strip PowerShell Select-String -Context output prefixes so the model
 * sees exact file content suitable for use in edit_file old_string.
 * - Match lines are prefixed with "> " → strip 2 chars
 * - Context lines get 2 extra spaces prepended by Select-String → strip 2 chars
 * - Blank lines have no prefix → leave as-is
 */
/**
 * Extract verifiable claims from a documentation file's content.
 * Returns grep commands the model should run to cross-check each claim.
 */
function extractDocVerificationHints(docContent: string): string[] {
    const hints: string[] = [];

    // ── Numeric retention/period claims ─────────────────────────────────────
    // e.g. "3-year retention", "5 years minimum", "90-day hold", "15 days"
    const retentionMatches = docContent.matchAll(
        /(\d+)[\s-]*(year|month|day|hour)s?[\s-]*(?:minimum\s+)?(?:retention|hold|period|record|reporting|threshold)/gi
    );
    for (const m of retentionMatches) {
        hints.push(`- Retention/period claim: "${m[0].trim()}" — grep source for the actual value: grep -rn "${m[1]}" app/ --include="*.py" | grep -i "retention\\|days\\|year\\|threshold"`);
    }

    // Also catch "X-year" / "X year" standalone phrases near retention context
    const yearPhrases = docContent.matchAll(/\b(\d+)[\s-]year\b.*?(?:retention|records?|minimum)/gi);
    for (const m of yearPhrases) {
        const days = parseInt(m[1]) * 365;
        hints.push(`- Year-based claim: "${m[0].slice(0, 60).trim()}" — Python code often stores this as days in timedelta(). Run BOTH:\n  1. grep -rn "timedelta(days=" app/ --include="*.py" | grep -v "pycache"\n  2. grep -rn "${days}" app/ --include="*.py" | grep -v "pycache"\n  The actual days value in code is the source of truth — use that value, not the doc's year claim.`);
    }

    // ── Class/function name claims ───────────────────────────────────────────
    // Backtick or inline code references to class/function names
    const codeRefs = [...docContent.matchAll(/`([A-Z][a-zA-Z]+(?:Service|Manager|Encryption|Storage|Validator|Helper|Audit|Log)[a-zA-Z]*)`/g)];
    const uniqueRefs = [...new Set(codeRefs.map(m => m[1]))].slice(0, 6);
    for (const ref of uniqueRefs) {
        hints.push(`- Class/function "${ref}" — verify it exists: grep -r "class ${ref}\\|def ${ref}" app/ --include="*.py"`);
    }

    // ── Specific numeric config values ───────────────────────────────────────
    // e.g. "100,000 iterations", "$500", "15 days", "24-hour"
    const numericClaims = [...docContent.matchAll(/\b(\d{2,}(?:,\d{3})*)\s*(iterations?|days?|hours?|requests?)\b/gi)];
    for (const m of numericClaims.slice(0, 4)) {
        const rawNum = m[1].replace(/,/g, '');
        hints.push(`- Numeric claim: "${m[0].trim()}" — grep for ${rawNum} in source: grep -r "${rawNum}" app/ --include="*.py"`);
    }

    // ── File path claims ──────────────────────────────────────────────────────
    // e.g. references to specific file paths in backticks
    const filePaths = [...docContent.matchAll(/`(app\/[a-zA-Z0-9_\/\.]+\.py)`/g)];
    const uniquePaths = [...new Set(filePaths.map(m => m[1]))].slice(0, 4);
    for (const p of uniquePaths) {
        hints.push(`- File path "${p}" — verify it exists: shell_read Get-Item '${p}'`);
    }

    return hints;
}

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
            execSync('powershell -NoProfile -ExecutionPolicy Bypass -Command "echo ok"', { stdio: 'pipe', timeout: 3000 });
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
- Finding files by name: shell_read with "Get-ChildItem -Path '${ws}' -Recurse -Filter '*transaction*' | Select-Object FullName"
- Searching code for a symbol: shell_read with "Get-ChildItem -Path '${ws}/app' -Recurse -Filter '*.py' | Select-String -Pattern 'def fetch_user' | Select-Object Path,LineNumber,Line | Select-Object -First 20"
- Viewing files: shell_read with "Get-Content 'C:/full/path/to/file.py'"
- Git operations: shell_read with "git status", "git log --oneline -20", "git diff"
PREFER grep/Select-String over directory listing — it finds what you need in one step instead of two.
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
Step 1 — find by filename filter (fast):
<tool>{"name": "shell_read", "arguments": {"command": "Get-ChildItem -Path '${ws}' -Recurse -Filter '*payment*' | Select-Object FullName"}}</tool>
Step 2 — read it immediately using the path from step 1:
<tool>{"name": "shell_read", "arguments": {"command": "Get-Content 'C:\\path\\from\\step1\\payment_service.py'"}}</tool>

EXAMPLE - User says "search for where process_payment is defined":
<tool>{"name": "shell_read", "arguments": {"command": "Get-ChildItem -Path '${ws}/app' -Recurse -Filter '*.py' | Select-String -Pattern 'def process_payment' | Select-Object Path,LineNumber,Line | Select-Object -First 10"}}</tool>

EXAMPLE - User says "read the checkout service":
<tool>{"name": "shell_read", "arguments": {"command": "Get-Content '${ws}/app/services/checkout_service.py'"}}</tool>
If path is wrong, search: Get-ChildItem -Recurse -Filter '*checkout*' | Select-Object FullName

EXAMPLE - User says "show me the files under app/routes":
<tool>{"name": "shell_read", "arguments": {"command": "Get-ChildItem '${ws}/app/routes' | Select-Object Name"}}</tool>

CRITICAL: Prefer targeted reads over broad directory sweeps. If you know the likely path (e.g. app/services/email_service.py), read it directly — do NOT list the whole directory first.

EXAMPLE - User says "create the admin directory and move admin.py into it":
<tool>{"name": "run_command", "arguments": {"command": "New-Item -ItemType Directory -Path '${ws}/app/routes/admin' -Force; Move-Item '${ws}/app/routes/admin.py' '${ws}/app/routes/admin/'"}}</tool>

EXAMPLE - User says "create a new file new_service.py with this content":
Use edit_file with old_string="" (empty string) to create the file — NEVER use echo or shell redirection:
<tool>{"name": "edit_file", "arguments": {"path": "${ws}/app/services/new_service.py", "old_string": "", "new_string": "# full file content here"}}</tool>

CRITICAL: NEVER use echo, Add-Content, or shell redirection (>, >>) to write source code files. echo collapses newlines and produces broken code. Always use edit_file to create or modify source files.
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
            description: 'Make a targeted edit to an existing file by replacing old_string with new_string. ONLY use this when you do NOT have line numbers. If you have line numbers from a previous shell_read, use edit_file_at_line instead — it is more reliable. The old_string must match exactly (including whitespace/indentation). For complete file rewrites (e.g. replacing an entire HTML template) OR corrupted files (containing literal \\n characters), set force_overwrite=true and old_string="" to replace the entire file with new_string.',
            parameters: {
                type: 'object',
                properties: {
                    path:            { type: 'string', description: 'Path relative to workspace root' },
                    old_string:      { type: 'string', description: 'Exact string to replace. Must be unique in the file. Use empty string with force_overwrite=true to replace the entire file.' },
                    new_string:      { type: 'string', description: 'Replacement string.' },
                    force_overwrite: { type: 'boolean', description: 'If true, overwrite the entire file with new_string, ignoring old_string. Use for: (1) corrupted files containing literal \\n characters, or (2) complete rewrites of template/HTML/CSS files where you intend to replace the entire contents.' },
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
            name: 'web_search',
            description: 'Search the web using SearXNG. Use this to find examples, documentation, libraries, tutorials, or current information relevant to a task. Returns titles, URLs, and snippets. Requires SearXNG to be configured in settings (ollamaAgent.search.url).',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query (be specific — e.g. "flask chartjs analytics dashboard example" not just "analytics")' },
                    limit: { type: 'number', description: 'Max results to return (default: 5, max: 20)' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch a web page and return its content as plain text. Use this to read documentation, GitHub READMEs, or any URL the user provides. Strips HTML tags and returns readable text capped at 8000 chars.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Full URL to fetch (must start with http:// or https://)' },
                },
                required: ['url'],
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

// ── Hierarchical context file scanning ───────────────────────────────────────
// Scans the workspace for AGENTS.md, CLAUDE.md, or .ollamapilot.md files at
// the root and up to 2 directory levels deep. Content is injected into the
// system prompt so the model has per-directory conventions without manual ingestion.
//
// File priority (highest wins on conflict): .ollamapilot.md > AGENTS.md > CLAUDE.md
// Only files ≤ 8000 chars are included to prevent context bloat.
const CONTEXT_FILE_NAMES = ['.ollamapilot.md', 'AGENTS.md', 'CLAUDE.md'];
const MAX_CONTEXT_FILE_BYTES = 8000;

async function loadHierarchicalContext(workspaceRoot: string): Promise<string> {
    const sections: string[] = [];
    try {
        // Scan: root + each immediate subdirectory (depth 1 only — avoids node_modules noise)
        const candidates: string[] = [workspaceRoot];
        try {
            const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
            for (const e of entries) {
                if (!e.isDirectory()) { continue; }
                if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) { continue; }
                candidates.push(path.join(workspaceRoot, e.name));
            }
        } catch { /* can't list root — just use root */ }

        const seen = new Set<string>(); // deduplicate by canonical path
        for (const dir of candidates) {
            for (const fname of CONTEXT_FILE_NAMES) {
                const fpath = path.join(dir, fname);
                if (seen.has(fpath)) { continue; }
                try {
                    const stat = fs.statSync(fpath);
                    if (!stat.isFile()) { continue; }
                    const content = fs.readFileSync(fpath, 'utf8').slice(0, MAX_CONTEXT_FILE_BYTES);
                    const rel = path.relative(workspaceRoot, fpath).replace(/\\/g, '/');
                    sections.push(`### ${rel}\n${content.trim()}`);
                    seen.add(fpath);
                    logInfo(`[context-files] Loaded ${rel} (${content.length} chars)`);
                    break; // highest-priority file wins for this directory
                } catch { /* file doesn't exist or can't be read — skip */ }
            }
        }
    } catch { /* never let context scanning break agent startup */ }

    if (sections.length === 0) { return ''; }
    return `## Project Context Files\nThe following files define project conventions, architecture, and guidelines:\n\n${sections.join('\n\n')}`;
}

async function buildSystemPromptAsync(autoSaveMemory: boolean, workspaceRoot?: string): Promise<string> {
    const [guidance, hierarchicalCtx] = await Promise.all([
        workspaceRoot ? buildProjectTypeGuidanceAsync(workspaceRoot) : Promise.resolve(''),
        workspaceRoot ? loadHierarchicalContext(workspaceRoot) : Promise.resolve(''),
    ]);
    return buildSystemPrompt(autoSaveMemory, workspaceRoot, guidance, hierarchicalCtx);
}

function buildSystemPrompt(autoSaveMemory: boolean, workspaceRoot?: string, projectGuidance?: string, hierarchicalCtx?: string): string {
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
    const searchCfg = getSearchConfig();
    const webSearchLine = searchCfg.url
        ? `  web_search         — search the web via SearXNG (${searchCfg.url}); use for examples, docs, libraries\n  web_fetch          — fetch and read a web page by URL`
        : '';
    return `You are an expert AI coding assistant integrated into VS Code.
Current date: ${dateStr}, ${timeStr}.${activeLanguage ? ` Active file: ${activeFile} (${activeLanguage}).` : ''}${workspaceInfo ? `\n${workspaceInfo}` : ''}

You are operating INSIDE A REAL PROJECT. Always search actual project files — never answer from training data.

Memory-first sequence (mandatory for any feature/change/question):
  1. memory_search("<topic>") — check what you already know
  2. shell_read / grep — find the specific files
  3. edit_file — make the change
${autoSaveBlock}
Tools:
  workspace_summary  — project structure (call first on a new project)
  edit_file          — replace old_string with new_string in a file
  shell_read         — any read-only command (no confirmation): cat, grep, find, ls, git diff, head, wc
  run_command        — state-changing commands (confirmation required): mv, cp, rm, mkdir, pip/npm install
  memory_search      — semantic search over saved project knowledge
  memory_list        — list all saved memory notes
  memory_write       — save a fact or decision
  memory_tier_write  — save to specific tier (0=infra, 1=frameworks, 2=current work, 3=conventions, 4=solutions)
  memory_delete      — remove a stale note (call memory_list first to get real IDs)
  read_terminal      — read VS Code terminal output
  get_diagnostics    — VS Code errors/warnings for a file${webSearchLine ? `\n${webSearchLine}` : ''}

## Shell patterns
${buildShellExamples(detectShellEnvironment(), workspaceRoot)}

## Rules
- Call tools directly — never narrate what you're about to do, just do it
- edit_file: old_string must be copied verbatim from the file (use shell_read first). On failure: re-read, fix, retry once. Stop after second failure.
- Never create source files with New-Item/touch — use edit_file with old_string=""
- get_diagnostics: call after every edit. Also call first when user asks about errors.
- Bug fix is complete when edit_file succeeds, not when you've described the fix
- Never end with a list of things to verify — do the verification yourself with shell_read
- Docs: cross-check specific claims (numbers, class names, config values) against actual code
- Performance: when writing queries or loops, consider scale — a query that works on 100 rows may break on 100k. Prefer indexed columns in WHERE clauses, avoid N+1 queries, flag anything that scans a full table without a limit.
- Git safety: before overwriting, moving, or deleting anything — run shell_read to check git status first. Never clobber uncommitted work.
${memoryGuidelines}
## Action vs Confirm
- Specific narrow tasks (fix bug, rename, add route): DO IT immediately. No asking.
- Schema changes (db.Column, new model, FK change): EXPLORE → CONFIRM plan → WAIT for reply → BUILD
- Vague/high-level requests (merge X, add reporting, track Y): EXPLORE → CONFIRM → WAIT → BUILD
- CONFIRM message format: what you found | what you'll change | what you won't touch | one question. SHORT.
- "go ahead" is a valid trigger to build IF you already presented a plan. If not, present the plan first.
- Scope: write code files only. Do NOT run migrations, pip install, or start servers — tell the user the exact commands to run.

## Deploy / apply / run tasks — environment-first protocol
When the user asks you to apply, run, deploy, execute, or migrate something (not write code — actually *run* it):
DO NOT explore the codebase. Instead, immediately do this in order:

1. memory_search("<topic> host connection deploy") — check what you already know
2. Read .env, deploy.sh, Makefile, or docs/DEPLOYMENT*.md if memory has nothing
3. Determine: is the target local or remote? Do you know the host, user, and method?
4. If YES — give the user the exact commands for that environment (SSH first if remote)
5. If NO — ask ONE question: "Where does this run — local machine or a remote server? If remote, what's the SSH host/user?"

Never assume localhost. Never assume the database or server is local just because the code is local.
Never start exploring models, docs, or SQL files — that is the wrong direction for an "apply" task.

## Unknown environment — always investigate, never assume
Anything that depends on WHERE or HOW something runs requires verification before you give commands.

- **Database host:** Before giving any migration, psql, or flask db command — check if you know the DB host. If the .env shows localhost but a deploy script or docs reference a remote host, the remote wins. Ask if still unclear.
- **Deployment target:** Before giving deploy/restart/reload commands — find deploy.sh or ask.
- **Services/ports:** Before giving start/stop commands for web server, queue, or cache — verify local vs remote.
- **Credentials/paths:** If a path, user, or key isn't visible in the codebase — ask, never invent.

When you find the answer from memory, .env, deploy scripts, or docs — use it directly. Only ask if you genuinely cannot determine it.

## Creative / discovery mode
Triggered by: "brainstorm", "what could we build", "find examples", "let's build X", "suggest ideas", "what if we", "get creative", "explore options".

In this mode your job is to be a product-minded engineer, not just a code executor. You should:

1. **Explore first** — read the actual models, routes, and templates to understand what data already exists. Use shell_read freely. Do NOT skip this step and answer from assumptions.
2. **Propose concrete options grounded in the real project** — not generic ideas. Name actual fields, models, and routes. Example: "We could add a transaction volume chart using Transaction.created_at and total_amount — the data is already there."
3. **Give 3-5 distinct options** ranked by value and effort. For each: what it does, what data/code it uses, rough complexity (small/medium/large).
4. **State your recommendation** — pick one and say why. Be opinionated.
5. **Offer to start immediately** — end with "Want me to start with [recommended option]?" not a generic "let me know."

After the user says yes/go ahead/start/pick one — build it directly. No second confirmation needed.

Format your proposals clearly with a header per option, not a wall of text. Be enthusiastic but specific — vague ideas are useless.

## Explore before implementing (vague requests)
When the request lacks technical detail, in this order:
  1. Read relevant models (real field names — do not assume)
  2. grep for existing services (email, scheduler, notification) before proposing new ones
  3. grep for the template/form if task involves a UI field
  4. Confirm plan with user before writing anything

Prefer existing data over new columns. Never add a column without user confirmation and migration warning.

## Code quality awareness

### Self-review after large changes
After completing any significant change (multiple files, new endpoints, new UI, new feature), pause and cross-check your own work before presenting it to the user:
1. **Route/contract consistency** — every URL called in the frontend has a matching registered backend route that returns the expected field names
2. **Logic consistency** — if the same calculation (date range, status filter, permission check) appears in multiple places, verify they all produce identical results
3. **Dead code** — any file, function, or blueprint not wired into the app is a liability; flag it
4. **Type safety** — before calling string methods on a field, confirm the column type from the model definition
5. **Filter completeness** — if similar queries in the same file filter by status/permission/date, a new query that omits those filters is probably a bug

Report what you found to the user. If something looks wrong that is outside the scope of the current task, say so — don't silently skip it.

### Flag things in passing
You will often notice issues while working on something unrelated. Always mention them briefly:
- Dead code or unreachable routes
- Inconsistent logic between similar functions
- A query that looks like it's missing a filter
- A type mismatch that would cause a runtime error

Format: one line, at the end of your response — "⚠️ Noticed: [brief description]". Don't fix it unless asked. Just make sure the developer sees it.

## Communication tone
Default: be terse. Skip preamble, don't restate the request, lead with the action or answer.

Switch to a more expressive tone when:
- Delivering a creative proposal — enthusiasm is appropriate, make it feel like a collaborator pitching an idea
- Explaining a design decision with real tradeoffs — be clear and direct, not clipped
- Delivering bad news (can't be done, found a serious bug, risky change) — be direct but human, not robotic

Never switch tone mid-task. If you're in the middle of making edits, stay terse. Save the expressive response for the summary at the end.

## Session continuity
At the start of any conversation on a known project:
1. Call memory_search("current work in progress") to check for prior context
2. If found, briefly orient: "Last time we were working on X — want to continue or start something new?"
3. Don't ask if memory is empty — just proceed normally

At the end of a session where significant work was done, save a Tier 2 memory note capturing: what was built, what was left unfinished, and any decisions made. This lets the next session pick up without the developer having to re-explain.

## Design decisions — show your reasoning
When you make a non-obvious technical choice, say so in one line. Not a lecture — just enough that the developer understands the tradeoff and can push back if they disagree.

Examples:
- "Using a JOIN here instead of a subquery — performs better on large datasets with an index on transaction_id."
- "Adding this to the existing blueprint rather than a new file — the domain is the same and doesn't justify splitting."
- "Storing as UTC and converting on display — avoids DST bugs in reporting."

Skip this for obvious choices. Use it when you picked one reasonable approach over another.

## Test awareness
After building or modifying a feature:
1. grep for existing tests in the same domain (e.g. tests/test_analytics*, *.test.ts)
2. If tests exist — check if any need updating for your changes. If so, update them.
3. If no tests exist — mention it once: "No tests found for this module. Want me to add some?"
4. Never delete or skip existing tests to make a feature work.

Don't write tests unless asked or unless they already exist and your change broke them.

## When you're stuck — stop and surface it
If you've failed at the same problem twice (two edit_file failures, two approaches that didn't work, two tool calls with bad results):
- Stop immediately. Do not try a third variation.
- Tell the developer: what you tried, what happened, what you think the blocker is.
- Ask one focused question that would unblock you.

Burning turns on variations the developer can't see is the worst outcome. Surfacing the problem early keeps them in control.

## UX awareness — think about the end user
When building any UI feature, before finishing ask yourself:
- **Empty state**: what does the user see if there's no data yet? Don't leave a blank chart or empty table with no message.
- **Error state**: if the API call fails, does the UI show something useful or just silently break?
- **Loading state**: is there a spinner or indicator while data loads?
- **Labels and copy**: are field names and button labels clear to a non-technical user, or do they reflect internal variable names?

You don't need to gold-plate every interaction — but the basics (empty state, error message) should always be there. Flag missing ones if you notice them even when working on something else.

## Compliance/security questions
When asked about PII, encryption, retention, or security: read the docs file first (docs/*.md), then cross-check against actual source code. Report mismatches with ⚠️.
${projectGuidance ?? (workspaceRoot ? buildProjectTypeGuidance(workspaceRoot) : '')}${hierarchicalCtx ? `\n\n${hierarchicalCtx}` : ''}`;
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

## Before making any change — VALIDATE silently first
Read the [PRE-LOADED CONTEXT] and check internally (do NOT narrate the checks):
1. **Duplicate**: Is there already a route or function that does the same thing? If yes → output only: "Already exists: [name]. No change needed."
2. **Model**: Does my change need a database model? If yes → it MUST be in the "RULE" list in [PRE-LOADED CONTEXT]. If missing → output only: "Cannot proceed: [ModelName] is not a known model. Available: ..."
3. **Pattern**: Use the same blueprint name, decorators, and import style shown in the file.
4. **Fit**: Does this change belong in this file?

**If any check fails → output one short sentence explaining why, then stop.**
**If all checks pass → call edit_file_at_line immediately. Output ONLY the tool call — no explanation, no narration.**

## Rules
- PREFER edit_file_at_line over edit_file — it is more reliable
- Do NOT call shell_read — the file content is already provided
- Never use placeholder logic like \`pass\` or \`# TODO\` — implement the actual logic based on the patterns in the file`;
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
- To CREATE a new file: use edit_file with old_string="" and new_string=<full file content> — it will create the file automatically
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

    // For shell_read and run_command: extract the command field robustly
    if (toolName === 'shell_read' || toolName === 'run_command') {
        // Try strict match first (well-formed JSON with closing })
        const strictMatch = raw.match(/"command"\s*:\s*"([\s\S]*?)"\s*\}/);
        // Fallback: grab everything after "command": " to end of string (malformed JSON)
        const looseMatch = raw.match(/"command"\s*:\s*"([\s\S]*)/);
        const cmdRaw = strictMatch ? strictMatch[1] : looseMatch ? looseMatch[1] : null;
        if (!cmdRaw) return null;
        // Unescape standard JSON escapes, then re-encode cleanly
        const cmdStr = cmdRaw
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            // Strip any trailing JSON structure noise (closing quotes/braces)
            .replace(/"\s*\}\s*\}?\s*$/, '');
        return `{"name":"${toolName}","arguments":{"command":${JSON.stringify(cmdStr)}}}`;
    }

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

/**
 * Fix raw (unescaped) newlines/tabs inside JSON string values.
 * Walks character by character to avoid regex catastrophe on large payloads.
 * Only escapes characters that appear inside JSON string values (between unescaped quotes).
 */
function fixRawNewlinesInJson(s: string): string {
    const out: string[] = [];
    let inString = false;
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === '\\' && inString) {
            // Pass escape sequence through unchanged
            out.push(ch);
            i++;
            if (i < s.length) { out.push(s[i]); i++; }
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            out.push(ch);
            i++;
            continue;
        }
        if (inString) {
            if (ch === '\n') { out.push('\\n'); i++; continue; }
            if (ch === '\r') { out.push('\\r'); i++; continue; }
            if (ch === '\t') { out.push('\\t'); i++; continue; }
        }
        out.push(ch);
        i++;
    }
    return out.join('');
}

/**
 * Direct field extraction for edit_file tool calls that fail JSON.parse.
 * Extracts name, path, old_string, new_string by finding field boundaries,
 * handling the case where new_string contains raw code with unescapable characters.
 */
function extractEditFileArgs(jsonStr: string): { name: string; arguments: Record<string, unknown> } | null {
    try {
        // Extract tool name
        const nameMatch = jsonStr.match(/"name"\s*:\s*"(edit_file(?:_at_line)?)"/);
        if (!nameMatch) return null;
        const toolName = nameMatch[1];

        // Extract path
        const pathMatch = jsonStr.match(/"path"\s*:\s*"([^"\\]*)"/);
        if (!pathMatch) return null;
        const filePath = pathMatch[1];

        // Extract old_string: find the value between "old_string": " and the next unescaped "
        // For new-file creation old_string is always empty, handle that fast path
        const oldStringEmptyMatch = jsonStr.match(/"old_string"\s*:\s*""/);
        const oldString = oldStringEmptyMatch ? '' : extractJsonStringValue(jsonStr, 'old_string');

        // Extract new_string: the large content block
        // Find "new_string": " then take everything up to the end of the JSON object
        const newString = extractJsonStringValue(jsonStr, 'new_string');
        if (newString === null) return null;

        return {
            name: toolName,
            arguments: { path: filePath, old_string: oldString ?? '', new_string: newString }
        };
    } catch {
        return null;
    }
}

/** Extract a JSON string value by key, handling escape sequences. Returns raw (unescaped) string. */
function extractJsonStringValue(jsonStr: string, key: string): string | null {
    const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`);
    const keyMatch = keyPattern.exec(jsonStr);
    if (!keyMatch) return null;

    let i = keyMatch.index + keyMatch[0].length;
    const chars: string[] = [];
    while (i < jsonStr.length) {
        const ch = jsonStr[i];
        if (ch === '\\' && i + 1 < jsonStr.length) {
            const next = jsonStr[i + 1];
            switch (next) {
                case '"': chars.push('"'); break;
                case '\\': chars.push('\\'); break;
                case '/': chars.push('/'); break;
                case 'n': chars.push('\n'); break;
                case 'r': chars.push('\r'); break;
                case 't': chars.push('\t'); break;
                case 'b': chars.push('\b'); break;
                case 'f': chars.push('\f'); break;
                default: chars.push('\\', next); break;
            }
            i += 2;
            continue;
        }
        if (ch === '"') break; // end of string value
        chars.push(ch);
        i++;
    }
    return chars.join('');
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
                    // Try escaping raw newlines/tabs inside JSON string values (common when model writes
                    // large new_string values containing code with literal newlines).
                    // Use character-by-character fix to avoid regex catastrophe on 40KB payloads.
                    try {
                        const fixedStr = fixRawNewlinesInJson(jsonStr);
                        parsed = JSON.parse(fixedStr);
                        addCall(parsed!, 'XML (newline-escaped)');
                    } catch {
                        // Last resort for large edit_file calls: extract fields directly without full JSON parse.
                        // Handles cases where new_string contains code with truly unescapable content.
                        if (jsonStr.includes('"edit_file"') || jsonStr.includes('"edit_file_at_line"')) {
                            const directExtract = extractEditFileArgs(jsonStr);
                            if (directExtract) {
                                addCall(directExtract, 'XML (direct-extract)');
                            } else {
                                logWarn(`[parseTextToolCalls] Failed to extract edit_file args: ${jsonStr.slice(0, 100)}`);
                            }
                        } else {
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
    
    let out = filtered.join('\n').replace(/\n{2,}/g, '\n').trim();
    // Remove code fences whose body is empty or only whitespace/punctuation after stripping tool blocks
    out = out.replace(/```\w*\s*\n[\s})\]]*\n```/g, '').trim();
    return out;
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

    /**
     * Model families that never support native tool calling.
     * Matched as case-insensitive prefix/substring of the model name.
     * No detection round-trip needed — go straight to text-mode silently.
     */
    private static readonly KNOWN_TEXT_MODE_FAMILIES = [
        'qwen',
        'deepseek-coder',
        'deepseek-r',
        'codellama',
        'starcoder',
        'wizardcoder',
        'phind-codellama',
        'magicoder',
        'codegemma',
        'yi-coder',
    ];

    private static isKnownTextModeModel(model: string): boolean {
        const lower = model.toLowerCase();
        return Agent.KNOWN_TEXT_MODE_FAMILIES.some(family => lower.startsWith(family) || lower.includes(':' + family));
    }
    /** Track consecutive failed tool calls to prevent infinite loops */
    private consecutiveFailures = 0;
    private readonly MAX_CONSECUTIVE_FAILURES = 4;
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
    /** Total shell_read calls this run — used to cap plan-task exploration regardless of interleaving */
    /** Higher limit for action tools (rename, run_command) during batch operations */
    private readonly MAX_CONSECUTIVE_SAME_TOOL_ACTION = 20;
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
    private readonly MAX_AUTO_RETRIES = 5;

    private diffViewManager: DiffViewManager;
    private refactorManager: MultiFileRefactoringManager;
    /** Last file operation for undo support */
    private _lastFileOp: { path: string; originalContent: string | null; action: string } | null = null;
    private _editsThisRun = 0; // count of successful file edits in current agent run
    private _lastEditedFilePath: string = ''; // path of last successfully edited file
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
    private _isSweepTask: boolean = false;
    private _isEditTask: boolean = false;
    /** Last system prompt content — used by compactContext for accurate token counting */
    private _lastSystemContent: string = '';
    /** Last memory context — used by compactContext for accurate token counting */
    private _lastMemoryContext: string = '';
    /** Whether preProcessEditTask() successfully injected file context this run */
    private _editContextInjected: boolean = false;
    /** When true, enforce edit_file-before-delete rule (set during merge operations) */
    private _mergeMode: boolean = false;
    /** When true, allow schema-changing edits (db.Column additions) to model files — set after user confirms */
    private _schemaChangeConfirmed: boolean = false;
    /** shell_read calls this run when userWantsAction and no edit attempted yet — cap exploration */
    private _exploreShellReadCount: number = 0;
    /** Average log-probability of the most recent model response (null if model didn't return logprobs) */
    private _lastResponseAvgLogprob: number | null = null;
    /** Accumulates every tool call made during the current run — reset at run start */
    private _toolCallsThisRun: ToolCallRecord[] = [];
    /** Accumulates every guardrail event that fired during the current run — reset at run start */
    private _guardEvents: GuardEvent[] = [];
    /** Relative paths of files successfully written during the current run — reset at run start */
    private _filesChangedThisRun: string[] = [];
    /** Number of model turns completed in the current run */
    private _runTurnCount: number = 0;
    /** How the current run ended — set by stop() or error path, reset at run start */
    private _runOutcome: 'done' | 'error' | 'stopped' = 'done';
    /** Critic model for the current run (resolved from routing config at run start) */
    private _routedCriticModel: string = '';
    /** Base model for the current run (passed into run()) */
    private _currentRunModel: string = '';
    /** Tracks whether edit_file was called since the last delete in merge mode */
    private _mergeEditedSinceLastDelete: boolean = false;
    /** Consecutive edit_file failures in merge mode — triggers append hint */
    private _mergeConsecutiveEditFailures: number = 0;
    /** Entry IDs returned by memory_search this turn — checked post-response for search_hit upgrade */
    private _recentSearchResultIds = new Set<string>();
    /** Per-file read counts in merge mode — resets on successful edit_file */
    private _mergeFileReadCounts: Map<string, number> = new Map();
    /** Active multi-file plan steps remaining (for sequential execution) */
    private _pendingPlanSteps: FilePlan[] = [];
    /** Output summary from the last completed plan step — passed as context to the next */
    private _lastPlanStepOutput: string = '';

    // Fix 5a: Task state machine — survives context compaction, drives completion tracking
    private _activeTask: {
        message: string;
        type: 'add_field' | 'fix_bug' | 'add_route' | 'refactor' | 'query' | 'other';
        filesConfirmed: string[];   // real paths proven correct this session
        filesRuledOut: string[];    // stubs/wrong paths to avoid
        stepsCompleted: string[];   // what's been verified done
        stepsPending: string[];     // what still needs doing
    } | null = null;

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

    /** Current active task state — safe to serialize into ChatSession. */
    get activeTask(): ActiveTaskState | null { return this._activeTask; }

    /** Restore active task state from a previously saved session. */
    restoreActiveTask(task: ActiveTaskState | null): void {
        this._activeTask = task;
        logInfo(`[agent] Active task restored — type: ${task?.type ?? 'none'}, confirmed: ${task?.filesConfirmed.length ?? 0} files`);
    }

    /** Per-run stats for the session log — call after run() completes. */
    get runStats(): {
        turns: number;
        toolCalls: ToolCallRecord[];
        guardEvents: GuardEvent[];
        filesChanged: string[];
        avgLogprob: number | null;
        outcome: 'done' | 'error' | 'stopped';
    } {
        return {
            turns:       this._runTurnCount,
            toolCalls:   [...this._toolCallsThisRun],
            guardEvents: [...this._guardEvents],
            filesChanged: [...this._filesChangedThisRun],
            avgLogprob:  this._lastResponseAvgLogprob,
            outcome:     this._runOutcome,
        };
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
    async compactContext(targetPercentage: number = 50, onToken?: (token: string) => void): Promise<{ removed: number; newPercentage: number; summary?: string }> {
        const model = this.currentModel || getConfig().model;
        const stats = calculateContextStats(this.history, this._lastSystemContent, this._lastMemoryContext, model);
        const oldCount = this.history.length;

        // Grab the messages that will be dropped for summarization
        let compacted = compactHistory(
            this.history,
            targetPercentage,
            stats.modelLimit,
            stats.systemPromptTokens,
            stats.memoryTokens
        );

        // Guarantee at least 25% of messages are removed — compactHistory may remove
        // nothing if we're already under the target percentage.
        const minRemove = Math.max(Math.floor(oldCount * 0.4), 4);
        if (oldCount - compacted.length < minRemove && oldCount > minRemove) {
            compacted = this.history.slice(minRemove);
        }
        const removedCount = oldCount - compacted.length;

        logInfo(`[context] compactContext: oldCount=${oldCount} removed=${removedCount} minRemove=${Math.max(Math.floor(oldCount * 0.4), 4)}`);

        // Summarize dropped messages — structured extraction instead of vague 2-sentence summary
        if (removedCount >= 2) {
            const dropped = this.history.slice(0, removedCount);
            const summaryText = dropped
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
                .join('\n');

            if (summaryText.trim()) {
                try {
                    let rawSummary = '';
                    await streamChatRequest(
                        model,
                        [
                            {
                                role: 'system',
                                content: [
                                    'You are a context extractor. Extract structured facts from this conversation.',
                                    'Output ONLY a JSON object with these keys (omit any key with an empty value):',
                                    '  task: string — one sentence describing what was being worked on',
                                    '  files_confirmed: string[] — real file paths that were found and confirmed correct',
                                    '  files_ruled_out: string[] — stub files, wrong paths, files that do not exist',
                                    '  decisions: string[] — key decisions made (e.g. "column already exists, skip adding it")',
                                    '  edits_made: string[] — describe each successful file edit',
                                    '  blockers: string[] — anything that failed or was unclear',
                                    '  next_step: string — what should happen next if the task is not done',
                                    'Output ONLY the JSON. No explanation, no markdown fences.',
                                ].join('\n'),
                            },
                            { role: 'user', content: summaryText.slice(0, 6000) },
                        ],
                        [],
                        (token) => { rawSummary += token; onToken?.(token); },
                        this.stopRef
                    );
                    // Parse and format as a readable context note
                    let structured: Record<string, unknown> = {};
                    try {
                        const jsonMatch = rawSummary.match(/\{[\s\S]*\}/);
                        if (jsonMatch) { structured = JSON.parse(jsonMatch[0]); }
                    } catch { /* fall through to plain summary */ }

                    const lines: string[] = ['[Earlier conversation summary]'];
                    if (structured.task) { lines.push(`Task: ${structured.task}`); }
                    if (Array.isArray(structured.files_confirmed) && structured.files_confirmed.length) {
                        lines.push(`Files confirmed: ${(structured.files_confirmed as string[]).join(', ')}`);
                    }
                    if (Array.isArray(structured.files_ruled_out) && structured.files_ruled_out.length) {
                        lines.push(`Files ruled out (do NOT edit): ${(structured.files_ruled_out as string[]).join(', ')}`);
                    }
                    if (Array.isArray(structured.decisions) && structured.decisions.length) {
                        lines.push(`Decisions: ${(structured.decisions as string[]).join(' | ')}`);
                    }
                    if (Array.isArray(structured.edits_made) && structured.edits_made.length) {
                        lines.push(`Edits made: ${(structured.edits_made as string[]).join(' | ')}`);
                    }
                    if (structured.next_step) { lines.push(`Next step: ${structured.next_step}`); }
                    if (Array.isArray(structured.blockers) && structured.blockers.length) {
                        lines.push(`Blockers: ${(structured.blockers as string[]).join(' | ')}`);
                    }

                    const summaryContent = lines.length > 1 ? lines.join('\n') : `[Earlier conversation summary] ${rawSummary.trim()}`;
                    compacted.unshift({ role: 'assistant', content: summaryContent });
                    logInfo(`[context] Structured compaction summary: ${summaryContent.slice(0, 200)}`);

                    // Save to Tier 2 memory so facts survive across sessions
                    if (this.memory && lines.length > 1) {
                        const memContent = lines.slice(1).join('\n'); // skip header line
                        this.memory.addEntry(2, memContent, ['compaction', 'session']).catch(() => {});
                        logInfo(`[context] Saved compaction summary to Tier 2 memory`);
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
                logWarn('[agent] Confirmation timed out after 10 minutes, rejecting');
                if (this._confirmResolver) {
                    this._confirmResolver(false);
                }
            }, 600_000);
            const confirmId = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            this.postFn({ type: 'confirmAction', id: confirmId, action, detail, toolName: toolName ?? action });
        });
    }

    async run(userMessage: string, model: string, post: PostFn): Promise<void> {
        this.stopRef = { stop: false };
        this.postFn  = post;
        this.currentModel = model; // Store current model for accurate context calculations
        this._currentTaskMessage = userMessage; // Capture task for use in tool interception

        // Pre-classify model: known text-mode families skip detection entirely (no toast, no wasted turn)
        if (this.toolMode === 'native') {
            if (Agent.isKnownTextModeModel(model)) {
                this.toolMode = 'text';
                Agent.textModeModels.add(model);
                logInfo(`Model ${model} → text-mode (known family, no detection needed)`);
                // No modeSwitch notification — user doesn't need to see this
            } else if (Agent.textModeModels.has(model)) {
                this.toolMode = 'text';
                logInfo(`Model ${model} → text-mode (learned from previous session)`);
                // No notification — already established, no surprise
            }
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

        // Fix 5a: Initialize task state machine for this run
        {
            const msgLower = userMessage.toLowerCase();
            const taskType: typeof this._activeTask extends null ? never : NonNullable<typeof this._activeTask>['type'] =
                /\badd\b.{0,40}\b(field|column|input)\b/i.test(userMessage) || /\b(form|template)\b/i.test(userMessage) ? 'add_field'
                : /\bfix\b/i.test(userMessage) && !/\ball\b/.test(msgLower) ? 'fix_bug'
                : /\badd\b.{0,30}\broute\b/i.test(userMessage) ? 'add_route'
                : /\b(refactor|rename|reorganize|restructure)\b/i.test(userMessage) ? 'refactor'
                : /\b(what|how|where|why|explain|show|list|find)\b/i.test(userMessage) ? 'query'
                : 'other';
            // Preserve filesConfirmed/filesRuledOut across turns in same session; reset steps
            const prev = this._activeTask;
            this._activeTask = {
                message: userMessage,
                type: taskType,
                filesConfirmed: prev?.filesConfirmed ?? [],
                filesRuledOut: prev?.filesRuledOut ?? [],
                stepsCompleted: [],
                stepsPending: [],
            };
        }

        this._failedCommandSignatures.clear(); // Reset failed command tracking
        // NOTE: _failedEditSignatures intentionally NOT cleared between turns — persistent across
        // the session so the same broken old_string doesn't retry indefinitely across user replies.
        this._focusedGrepInjectedThisTurn = false; // Reset focused-grep dedup flag
        this._filesAutoReadThisRun.clear();    // Reset per-run auto-read tracking
        this._editContextInjected = false;     // Reset read-then-act flag
        this._editsThisRun = 0;                // Reset edit counter
        // Set schema-change confirmed if user's message looks like approval of a previously blocked schema change
        const lowerMsg = userMessage.toLowerCase();
        if (/\b(yes|yeah|yep|go ahead|proceed|looks good|that'?s? (right|correct|fine|good)|do it|confirm|ok|okay|sure)\b/.test(lowerMsg)) {
            this._schemaChangeConfirmed = true;
        } else {
            this._schemaChangeConfirmed = false;
        }
        this._exploreShellReadCount = 0;
        this._lastEditedFilePath = '';
        // Per-run session log accumulators
        this._toolCallsThisRun = [];
        this._guardEvents = [];
        this._filesChangedThisRun = [];
        this._runTurnCount = 0;
        this._runOutcome = 'done';
        this._currentRunModel = model;
        { const rc = getConfig(); this._routedCriticModel = rc.modelRoutingEnabled ? (rc.criticModel || model) : model; }

        logInfo(`Agent run — model: ${model}, mode: ${this.toolMode}, history: ${this.history.length}`);

        // ── Deploy/apply/run preflight — environment verification ─────────
        // When the user asks to apply, run, deploy, or execute something (not write code),
        // inject a preflight instruction so the model's FIRST action is to check where the
        // target runs — not to explore models, docs, or SQL files.
        const isDeployRunTask = /\b(apply|run|execute|deploy|migrate|upgrade|start|restart|reload|push)\b/i.test(userMessage)
            && !/\b(add|write|create|implement|build|fix|update|modify|refactor)\b/i.test(userMessage);
        if (isDeployRunTask) {
            // Only inject if this isn't already a follow-up to an environment answer
            const recentHistory = this.history.slice(-4);
            const alreadyHasEnvAnswer = recentHistory.some(m =>
                m.role === 'user' && /\b(ssh|host|server|remote|local|postgres|localhost|10\.\d+\.\d+\.\d+|192\.\d+)\b/i.test(String(m.content))
            );
            if (!alreadyHasEnvAnswer) {
                this.history.push({
                    role: 'user',
                    content: `[PREFLIGHT] Before doing anything else: this task requires knowing WHERE to run the command. Do NOT explore code files, SQL files, or docs. Instead:\n1. Call memory_search("database host deploy server connection") immediately\n2. If memory has the answer, give the user the exact commands for that environment\n3. If memory has nothing, read .env and deploy.sh (shell_read only — no other files)\n4. If the target is still unclear, ask: "Is this running locally or on a remote server? If remote, what is the SSH host and user?"\nDo not assume localhost. Do not suggest 'flask db upgrade' without knowing if the DB is local or remote.`
                });
            }
        }

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
                // Matches both Unix paths (/foo/bar.py) and Windows absolute paths (C:/foo/bar.py or C:\foo\bar.py)
                for (const m of searchResult.matchAll(/^([A-Za-z]:[/\\][\w/\\.-]+\.py|[\w/\\.-]+\.py):1: \[filename match:(\w+)\]/gm)) {
                    filenameMatched.set(m[1].replace(/\\/g, '/'), m[2]);
                }
                const fileMatches = [...searchResult.matchAll(/^([A-Za-z]:[/\\][\w/\\.-]+\.py|[\w/\\.-]+\.py):\d+:/gm)]
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
                    // Strong bonus if this file was found by filename search — its name IS the feature.
                    // Use a large bonus (10) so a dedicated filename match always outranks generic files
                    // with high content-hit counts (e.g. void_refund_api.py vs transactions.py for "void").
                    const filenameBonus = filenameMatched.has(f) ? 10 : 0;
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
                // Build effective search terms: query words + the filename-match keywords (e.g. "void")
                // so that void_refund_api.py scores high for "voided transaction" even though the
                // query word is "voided" not "void".
                const filenameKeywordSet = new Set([...filenameMatched.values()]);
                const effectiveSearchTerms = [...new Set([...queryWords, ...filenameKeywordSet])];
                const readResults: Array<{ f: string; content: string; hits: number }> = [];
                for (const { f } of scored.slice(0, 4)) {
                    const readId = `t_pre_read_${Date.now()}`;
                    const catCmd = isWin ? `Get-Content "${f}"` : `cat "${f}"`;
                    post({ type: 'toolCall', id: readId, name: 'shell_read', args: { command: catCmd } });
                    try {
                        const content = await this.executeTool('shell_read', { command: catCmd }, readId);
                        post({ type: 'toolResult', id: readId, name: 'shell_read', success: true, preview: content.slice(0, 150) });
                        if (content.length > 200) {
                            const lower = content.toLowerCase();
                            // Count hits using effectiveSearchTerms (includes filename-search keywords like "void")
                            // Primary sort: minimum hits across terms (file must contain all terms)
                            // Secondary sort: total hits (prefer more comprehensive coverage)
                            const hitsPerKw = effectiveSearchTerms.map(w => {
                                let count = 0, pos = 0;
                                while ((pos = lower.indexOf(w, pos)) !== -1) { count++; pos++; }
                                return count;
                            });
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
                this._editContextInjected = true; // suppress isGenericLongAnswer false positive
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
            || /\bfiles?\s+(that\s+)?(do\s+)?(similar|the same|overlap)\b/i.test(userMessage)
            || /\b(could be|should be|and)\s+merged?\b/i.test(userMessage)
            || /\bdoing\s+similar\s+things\b/i.test(userMessage));
        const isMergeIntent = isFindSimilar
            && /\b(merge[d]?|consolidate[d]?|combine[d]?|could be merged|should be merged)\b/i.test(userMessage);
        const isNewFileTask = /\b(create|add|make|generate|scaffold)\b.{0,50}\bnew\s+(route\s+file|file|module|blueprint)\b/i.test(userMessage)
            || /\b(create|generate|scaffold)\b.{0,50}\b(route\s+file|module|blueprint)\b/i.test(userMessage)
            || /\bnew\s+(route\s+file|module|blueprint)\b/i.test(userMessage);
        // Planning/discussion tasks: model should explore freely without action guardrails.
        // Suppress explore-cap, same-tool limit exemptions, and planning-instead-of-doing retries.
        const isPlanTask = /\b(plan|design|discuss|proposal|is it possible|can we|could we|would it be possible|create a (plan|doc|file|proposal)|how (can|could|would) (we|this)|let'?s discuss|think about|possibilities|options|approach|strategy)\b/i.test(userMessage)
            && !/\b(implement now|do it now|build it|go ahead|proceed)\b/i.test(userMessage);
        // Review/audit tasks produce a written report — not action-oriented, suppress action guardrails.
        const isReviewTask = /\b(review|audit|check|analyse|analyze|look for|find (bugs?|issues?|problems?|errors?|race conditions?|inconsistencies)|code review|spot|identify (bugs?|issues?|problems?))\b/i.test(userMessage)
            && !/\b(and fix|then fix|fix them|fix (all|it|those)|also fix|apply (the )?fix)\b/i.test(userMessage);
        // Creative/discovery tasks: brainstorm, find examples, suggest ideas, let's build X.
        // Agent explores the project, generates grounded proposals, then offers to build.
        const isCreativeTask = /\b(brainstorm|creative|ideate|suggest|what (could|can|should) we (build|add|create|do)|let'?s (build|create|design|explore|think about)|find (examples?|inspiration|ideas?)|what (ideas?|options?|possibilities)|how (might|could) we|what (would|if we)|explore (ideas?|options?|possibilities)|pitch|envision|imagine|what (features?|things?) (could|can|should)|get (creative|building|started))\b/i.test(userMessage)
            && !/\b(implement now|do it now|go ahead|proceed|fix|rename|delete|remove)\b/i.test(userMessage);

        const isEditTask = /\b(add|insert|append|implement|fix|modify|update|change|remove|delete|refactor|rename|replace|wrap|extract|move|convert|migrate)\b/i.test(userMessage)
            && !/\b(import\s+\w+|from\s+\w+\s+import|path)\b/i.test(userMessage)
            && !isMultiFileRestructure
            && !isFindSimilar
            && !isExplainQuery
            && !isPlanTask && !isReviewTask && !isCreativeTask
            && !isNewFileTask
            && !preProcessedContext;  // already handled by preProcessPathUpdate

        // Multi-file feature request: "add a new model with routes and tests"
        const isMultiFeatureRequest = !isMultiFileRestructure && !isNewFileTask
            && /\b(add|create|implement|build|scaffold)\b.{0,80}\b(model|feature|endpoint|blueprint)\b.{0,80}\b(with|and|including|plus)\b.{0,80}\b(test|route|migration|service|schema)\b/i.test(userMessage)
            && !/\b(error.handl|try.except)\b/i.test(userMessage); // don't trigger for sweep tasks

        // ── Pre-inject sibling template for new-file tasks ─────────────────────
        // When a small model is asked to create a new file, inject a sibling file
        // from the target directory as a structural template. This lets the model
        // produce correct code on turn 1 instead of spending turns exploring.
        if (this._isSmallModel && isNewFileTask && !preProcessedContext) {
            try {
                // Detect target directory from message hints (e.g. "under fleet routes" → routes/fleet)
                const dirHintMatch = userMessage.match(/\bunder\s+(?:the\s+)?(\w+)\s+(?:route|routes?|directory|folder|dir)\b/i)
                    ?? userMessage.match(/\bin\s+(?:the\s+)?(\w+)\s+(?:route|routes?|directory|folder|dir)\b/i);
                const dirHint = dirHintMatch?.[1]?.toLowerCase() ?? '';

                // Walk routes directories to find best match
                const wsRoot = this.workspaceRoot;
                const routesRoot = path.join(wsRoot, 'app', 'routes');
                let siblingDir = routesRoot;
                if (dirHint && fs.existsSync(path.join(routesRoot, dirHint))) {
                    siblingDir = path.join(routesRoot, dirHint);
                }

                // Pick first .py sibling that isn't __init__
                let siblingFile: string | undefined;
                if (fs.existsSync(siblingDir)) {
                    const entries = fs.readdirSync(siblingDir);
                    siblingFile = entries
                        .filter(e => e.endsWith('.py') && !e.startsWith('__'))
                        .map(e => path.join(siblingDir, e))
                        .find(f => {
                            try { return fs.statSync(f).size < 30_000; } catch { return false; }
                        });
                }

                if (siblingFile) {
                    const siblingContent = fs.readFileSync(siblingFile, 'utf8').slice(0, 6000);
                    const siblingRel = path.relative(wsRoot, siblingFile).replace(/\\/g, '/');
                    const targetDir = path.relative(wsRoot, siblingDir).replace(/\\/g, '/');
                    const template = `\n\n[TEMPLATE — existing file in target directory (${targetDir}/): ${siblingRel}]\n\`\`\`python\n${siblingContent}\n\`\`\`\n\nCreate the new file using edit_file with path="${targetDir}/<new_filename>.py", old_string="" (empty string), and new_string=<full file content based on template above>. Do NOT use run_command or New-Item.`;
                    this.history[this.history.length - 1] = {
                        role: 'user',
                        content: `${userMessage}${template}`,
                    };
                    logInfo(`[pre-new-file] Injected template from ${siblingRel} (${siblingContent.length} chars)`);
                }
            } catch (e) {
                logInfo(`[pre-new-file] Template injection failed: ${e}`);
            }
        }

        // ── Programmatic error-handler sweep ──────────────────────────────────
        // "add error handling to any route that's missing it" — detect, execute directly,
        // skip the model entirely for the wrapping work.
        const isErrorHandlerSweep = isEditTask
            && /\berror[\s_-]?handl|\btry[\s_-]?except|\bexception[\s_-]?handl/i.test(userMessage)
            && /\b(all|every|each|any|missing|without)\b/i.test(userMessage);

        this._isEditTask = isEditTask;
        logInfo(`[error-sweep] isEditTask=${isEditTask} isErrorHandlerSweep=${isErrorHandlerSweep}`);
        if (isErrorHandlerSweep) {
            const swept = await this.sweepAddErrorHandling(userMessage, post);
            if (swept) { return; } // handled — skip model call entirely
        }

        if (this._isSmallModel && isEditTask && !isErrorHandlerSweep) {
            const preResult = await this.preProcessEditTask(userMessage, post);
            if (preResult.blocked) {
                // Programmatic duplicate detected — skip model entirely
                post({ type: 'chunk', content: preResult.blocked });
                post({ type: 'done' });
                this._editContextInjected = false;
                return;
            }
            if (preResult.injection) {
                this.history[this.history.length - 1] = {
                    role: 'user',
                    content: `${userMessage}\n\n${preResult.injection}`,
                };
                this._editContextInjected = true;
                logInfo(`[pre-edit] Injected ${preResult.injection.length} chars of pre-loaded file context`);
                // Populate task state machine with programmatically-derived pending steps
                if (this._activeTask && preResult.pendingSteps.length > 0) {
                    this._activeTask.stepsPending = preResult.pendingSteps.map(s => s.replace(/^\[ \]\s*/, ''));
                    logInfo(`[task-state] Pending steps: ${this._activeTask.stepsPending.join(' | ')}`);
                }
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
                            // List only related sibling files (same name stem) so the user can see what it was split into
                            const dir = path.dirname(targetAbs);
                            const stem = path.basename(targetAbs, '.py').replace(/_api$/, '').replace(/_/g, '_?');
                            const stemRe = new RegExp(`^${stem}`, 'i');
                            let siblings = '';
                            try {
                                const related = fs.readdirSync(dir)
                                    .filter(f => f.endsWith('.py') && f !== path.basename(targetAbs) && stemRe.test(f));
                                siblings = related
                                    .map(f => `  - \`${path.join(path.relative(this.workspaceRoot, dir), f).replace(/\\/g, '/')}\``)
                                    .join('\n');
                            } catch { /* ignore */ }
                            // Also show the imports from the aggregator file itself
                            let importLines = '';
                            try {
                                const content = fs.readFileSync(targetAbs, 'utf8');
                                importLines = content.split('\n')
                                    .filter(l => /^\s*(from|import)\s/.test(l))
                                    .slice(0, 20)
                                    .map(l => `  ${l.trim()}`)
                                    .join('\n');
                            } catch { /* ignore */ }
                            const detail = importLines
                                ? `\n\nImports in the aggregator:\n${importLines}`
                                : (siblings ? `\n\nRelated files from the split:\n${siblings}` : '');
                            emitAssistant(`\`${plan.relPath}\` was already split in a previous session — it is now a thin aggregator that imports the sub-blueprints.${detail}`);
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
                    const report = await findSimilarInDirectory(scopeDir!, this.workspaceRoot, this.codeIndex, 0.75);
                    const reportText = formatSimilarityReport(report);
                    const mergeableClusters = (report.clusters ?? []).filter(c =>
                        !c.label.includes('no common tokens') &&
                        !(c.files.length > 6 && c.label.includes('review'))
                    );
                    if (isMergeIntent && mergeableClusters.length > 0) {
                        // User wants to actually merge — show the report, then hand off to the model
                        logInfo(`[similarity] Merge intent detected — ${mergeableClusters.length} actionable clusters (${report.clusters.length} total), handing to model`);
                        post({ type: 'token', text: reportText + '\n\n---\n' });
                        post({ type: 'streamEnd' });
                        // Clusters are already sorted by avgSimilarity descending
                        const relDir = path.relative(this.workspaceRoot, scopeDir!).replace(/\\/g, '/');
                        const allClusters = mergeableClusters;
                        const clusterList = allClusters.map((c, i) => {
                            const files = c.files.map(f => `\`${f.relPath}\``).join(', ');
                            return `  ${i + 1}. ${files} (similarity ${c.avgSimilarity.toFixed(2)})`;
                        }).join('\n');
                        const mergeInstruction = `The similarity analysis found ${allClusters.length} clusters in \`${relDir}\`:\n${clusterList}\n\n` +
                            `Work through them in order. For each cluster, merge all files into the LARGEST one (most lines), then delete the smaller ones.\n\n` +
                            `WORKFLOW per cluster:\n` +
                            `1. Get method lists: run shell_read with "Select-String -Pattern '^\\s*(def |class )' <file>" on EACH file to see all method/class names.\n` +
                            `2. Identify unique methods in the smaller files that do NOT appear in the largest file. Assume they are unique unless you see the same name in the largest file's Select-String output.\n` +
                            `3. For each unique method: read its full implementation from the source file with "Get-Content <file> | Out-String". Copy the REAL code verbatim — do NOT summarize or abbreviate.\n` +
                            `4. Append unique methods to the END of the largest file using run_command with Add-Content.\n` +
                            `   IMPORTANT: Use SINGLE-QUOTE here-strings only — @' ... '@ — NEVER use double-quote here-strings (@" ... "@):\n` +
                            `   run_command: Add-Content -Path 'C:/full/path/to/file.py' -Value @'\n\ndef my_method(self):\n    pass\n'@\n` +
                            `   This is REQUIRED — do NOT use edit_file for appending.\n` +
                            `5. After the Add-Content succeeds (exit 0), delete that smaller file with run_command Remove-Item.\n` +
                            `6. Repeat for all files in the cluster until only the largest remains.\n\n` +
                            `RULES:\n` +
                            `- If a smaller file has NO unique methods (all duplicates), just delete it.\n` +
                            `- If a smaller file is empty or only stubs (pass/return None), just delete it.\n` +
                            `- NEVER delete a file before its unique content is merged.\n` +
                            `- Do NOT read the first N lines only — use Select-String to get method names from the full file.\n` +
                            `- Do NOT ask permission or summarize — start with cluster 1 immediately.`;
                        this._isEditTask = true;
                        this._mergeMode = true;
                        this._mergeEditedSinceLastDelete = false;
                        this._mergeConsecutiveEditFailures = 0;
                        await this.run(mergeInstruction, model, post);
                        this._mergeMode = false;
                    } else {
                        emitAssistant(reportText);
                    }
                }
            } catch (err) {
                logError(`[similarity] Failed: ${toErrorMessage(err as Error)}`);
                post({ type: 'token', text: `Similarity analysis failed: ${toErrorMessage(err as Error)}` });
                post({ type: 'streamEnd' });
            }
            return;
        }

        // ── Multi-file plan gate ───────────────────────────────────────────────────
        // If there are pending plan steps from a prior run (sequential execution),
        // advance to the next step rather than re-generating the plan.
        if (this._pendingPlanSteps.length > 0) {
            const nextStep = this._pendingPlanSteps.shift()!;
            const remaining = this._pendingPlanSteps.length;
            const stepContext = [
                `[MULTI-FILE PLAN — step in progress]`,
                `Now implement: \`${nextStep.relPath}\` — ${nextStep.description}`,
                nextStep.action === 'modify'
                    ? `This file already exists. Modify it as described.`
                    : `This file does not exist yet. Create it.`,
                '',
                this._lastPlanStepOutput
                    ? `Context from previous step:\n${this._lastPlanStepOutput}`
                    : '',
                '',
                remaining > 0
                    ? `After this step, ${remaining} more step(s) remain in the plan.`
                    : `This is the final step in the plan.`,
                `Follow the patterns in the existing codebase. Use only models from app/models/.`,
            ].filter(Boolean).join('\n');
            this.history[this.history.length - 1] = {
                role: 'user',
                content: `Continue multi-file plan — implement ${nextStep.relPath}\n\n${stepContext}`,
            };
            post({ type: 'planProgress', step: nextStep, remaining });
            logInfo(`[multi-plan] Advancing to step: ${nextStep.relPath}, ${remaining} remaining`);
        } else if (isMultiFeatureRequest) {
            const plan = this.generateMultiFilePlan(userMessage);
            if (plan.length >= 2) {
                const planText = plan.map((p, i) =>
                    `${i + 1}. ${p.action === 'create' ? '✚' : '~'} \`${p.relPath}\` — ${p.description}`
                ).join('\n');
                post({ type: 'planCard', plan, planText });
                const confirmed = await this.requestConfirmation(
                    'multi_file_plan',
                    `Proceed with creating/modifying ${plan.length} files?`,
                    `multi_plan_${Date.now()}`
                );
                if (!confirmed) {
                    post({ type: 'streamStart' });
                    const msg = 'Plan cancelled. Let me know what you\'d like to change.';
                    for (const ch of msg) { post({ type: 'token', text: ch }); }
                    post({ type: 'streamEnd' });
                    this.history.push({ role: 'assistant', content: msg });
                    return;
                }
                // Queue all steps except the first (which runs now)
                const [firstStep, ...rest] = plan;
                this._pendingPlanSteps = rest;
                this._lastPlanStepOutput = '';
                const planContext = [
                    `[MULTI-FILE PLAN — confirmed by user, step 1 of ${plan.length}]`,
                    `Implement these files in order. Start with the first file only.`,
                    planText,
                    ``,
                    `Now implement step 1: \`${firstStep.relPath}\` — ${firstStep.description}`,
                    `Follow the patterns in the existing codebase. Use only models from app/models/.`,
                ].join('\n');
                this.history[this.history.length - 1] = {
                    role: 'user',
                    content: `${userMessage}\n\n${planContext}`,
                };
                logInfo(`[multi-plan] Confirmed — step 1/${plan.length}: ${firstStep.relPath}, queued ${rest.length} more`);
            }
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
                this._lastMemoryContext = memoryContext;
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

        const isSweepTask = /\b(all|every|each|any)\b.{0,40}\b(route|function|endpoint|def)\b/i.test(userMessage)
            || /\b(missing|without|lacks?)\b.{0,50}\b(error|exception|try|handl)/i.test(userMessage)
            || /\b(no\s+error|no\s+try)\b/i.test(userMessage)
            || /\b(add|fix).{0,30}\b(all|every|each|any)\b/i.test(userMessage);
        this._isSweepTask = isSweepTask;
        // Sweep tasks need a clean slate — prior history from failed/partial sweeps confuses the model
        // into thinking the work is already done (hallucinating completion) or repeating bad strategies.
        if (isSweepTask && !this._mergeMode && this.history.length > 2) {
            logInfo(`[agent] Sweep task with ${this.history.length} prior messages — clearing history for a fresh start`);
            this.history = [];
        }
        const configuredMax = getConfig().maxTurnsPerSession;
        const MAX_TURNS = configuredMax > 0 ? configuredMax
            : isSweepTask ? 50 : this._mergeMode ? 60 : (this._isSmallModel ? 8 : (isPlanTask || isCreativeTask) ? 50 : 40);
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

IMPORTANT: Only critical infrastructure is shown above. You have MORE memories stored across tiers 1-5.
- Before answering questions about project setup, conventions, frameworks, past decisions, or known issues → call memory_search("<topic>")
- Before implementing ANY feature request or code change → call memory_search("<feature area>") to check existing patterns
- When given a vague business requirement (e.g. "allow decimals for X on the Y page") → call memory_search("<X>") and memory_search("<Y page>") FIRST before looking at files
Do NOT assume you have no memory — check first.`;
        }

        // Fix M5: Recent-work briefing on session start
        // Inject the last 3 Tier 2+3 entries so the model knows what was done recently
        // without having to search memory first.
        if (this.memory) {
            try {
                const tier3 = this.memory.getTier(3)
                    .filter(e => e.tags?.includes('session-end') || e.tags?.includes('completed'))
                    .slice(0, 2);
                const tier2disc = this.memory.getTier(2)
                    .filter(e => e.tags?.includes('auto-discovery') || e.tags?.includes('stub') || e.tags?.includes('template'))
                    .slice(0, 3);
                const recentEntries = [...tier3, ...tier2disc].slice(0, 4);
                if (recentEntries.length > 0) {
                    const briefing = recentEntries.map(e => `- ${e.content.slice(0, 120)}`).join('\n');
                    baseSystemWithMemory += `\n\n## Recent work (from memory)\n${briefing}\nUse this to avoid re-discovering facts already known.`;
                    logInfo(`[memory] Injected recent-work briefing: ${recentEntries.length} entries`);
                }
            } catch { /* skip if memory unavailable */ }
        }

        // ── Prior-work existence check ────────────────────────────────────────
        // For implement/create/add tasks: search memory for matching completed-feature
        // entries BEFORE the model starts exploring. If found, inject a prominent
        // [PRIOR WORK DETECTED] block so the model verifies first instead of re-doing.
        const isImplementTask = /\b(implement|create|add|build|make|set up|write)\b/i.test(userMessage)
            && !/\b(plan|discuss|design|proposal)\b/i.test(userMessage);
        if (this.memory && isImplementTask) {
            try {
                // Extract 2-4 keywords from the task to drive the search
                const kwMatch = userMessage.match(/\b([a-z][a-z0-9_]{3,})\b/gi) ?? [];
                const stopWords = new Set(['the','this','that','with','from','into','for','and','create','make','build','add','implement','write','should','would','could','please','just','need','want']);
                const searchKws = kwMatch.filter(w => !stopWords.has(w.toLowerCase())).slice(0, 5);
                if (searchKws.length >= 2) {
                    const searchQuery = searchKws.join(' ');
                    const priorHits = await this.memory.searchMemory(searchQuery, undefined, 5);
                    const completedHits = priorHits.filter(h =>
                        h.tags?.includes('completed-feature') || h.tags?.includes('session-end') || h.tags?.includes('completed')
                    );
                    if (completedHits.length > 0) {
                        const hitLines = completedHits.map(h => `  - ${h.content.slice(0, 150)}`).join('\n');
                        baseSystemWithMemory += `\n\n## [PRIOR WORK DETECTED]\nMemory contains entries suggesting this feature may already be implemented:\n${hitLines}\n\nBEFORE writing any code:\n1. Call memory_search("${searchKws.slice(0,3).join(' ')}") to review the full details\n2. Check the relevant file(s) to confirm whether the feature exists\n3. If it already exists, tell the user what was found and ask if they want changes\n4. Only proceed with new code if the feature is genuinely missing`;
                        logInfo(`[prior-work] Injected existence check: ${completedHits.length} hit(s) for "${searchQuery}"`);
                    }
                }
            } catch { /* skip if memory unavailable */ }
        }

        // ── File-system existence scan (all models) ───────────────────────────
        // For add/implement/create tasks: scan app/routes, app/services, app/views
        // programmatically for routes and functions matching the task keywords.
        // Runs BEFORE the model is called so it never wastes turns discovering this.
        // This is the same logic as preProcessEditTask's fs-scan but runs for ALL models.
        if (isImplementTask) {
            try {
                const hasPyFs = fs.existsSync(path.join(this.workspaceRoot, 'requirements.txt'))
                    || fs.existsSync(path.join(this.workspaceRoot, 'pyproject.toml'))
                    || fs.existsSync(path.join(this.workspaceRoot, 'setup.py'));
                const STOP_FS = new Set(['add','insert','fix','update','change','modify','implement',
                    'the','a','an','to','in','on','of','for','that','this','and','or','with',
                    'from','into','should','would','could','will','can','all','returns',
                    'return','json','please','just','need']);
                const fsKws = userMessage.toLowerCase().split(/\W+/)
                    .filter(w => w.length > 3 && !STOP_FS.has(w)).slice(0, 6);

                logInfo(`[fs-scan] hasPyFs=${hasPyFs} fsKws=${JSON.stringify(fsKws)} isImplementTask=${isImplementTask}`);
                if (hasPyFs && fsKws.length >= 1) {
                    const scanDirs = ['app/routes', 'app/services', 'app/views', 'app/blueprints']
                        .map(d => path.join(this.workspaceRoot, d))
                        .filter(d => fs.existsSync(d));

                    interface FsScanHit { relPath: string; matchedRoutes: string[]; matchedFunctions: string[] }
                    const fsHits: FsScanHit[] = [];

                    for (const scanDir of scanDirs) {
                        let pyFiles: string[];
                        try { pyFiles = fs.readdirSync(scanDir).filter(f => f.endsWith('.py') && f !== '__init__.py'); }
                        catch { continue; }

                        for (const pf of pyFiles) {
                            const pfAbs = path.join(scanDir, pf);
                            let pfContent: string;
                            try { pfContent = fs.readFileSync(pfAbs, 'utf8'); }
                            catch { continue; }

                            const pfLower = pfContent.toLowerCase();
                            if (fsKws.filter(kw => pfLower.includes(kw)).length < 2) { continue; }

                            const matchedRoutes: string[] = [];
                            const matchedFunctions: string[] = [];
                            for (const line of pfContent.split('\n')) {
                                const rm = line.match(/^\s*@\w+\.route\(['"]([^'"]+)['"]/);
                                if (rm) { matchedRoutes.push(rm[1]); }
                                const fm = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
                                if (fm && !fm[1].startsWith('_')) { matchedFunctions.push(fm[1]); }
                            }

                            const relevantRoutes = matchedRoutes.filter(r => fsKws.some(kw => r.toLowerCase().includes(kw)));
                            const relevantFns = matchedFunctions.filter(fn => fsKws.some(kw => fn.toLowerCase().includes(kw)));

                            if (relevantRoutes.length > 0 || relevantFns.length > 0) {
                                const rel = path.relative(this.workspaceRoot, pfAbs).replace(/\\/g, '/');
                                fsHits.push({ relPath: rel, matchedRoutes: relevantRoutes, matchedFunctions: relevantFns });
                                logInfo(`[fs-scan] Hit: ${rel} (routes: ${relevantRoutes.join(', ')}, fns: ${relevantFns.join(', ')})`);
                            }
                        }
                    }

                    // If the user named an explicit target file that doesn't exist on disk,
                    // hits in OTHER files are not "already done" — they're related code elsewhere.
                    // Only warn when hits are in the same file the user targeted (or no explicit target).
                    const explicitFileMatch = userMessage.match(/\b([\w./\\-]+\.(?:py|ts|js|go|java|rs|rb|php))\b/i);
                    const explicitRelPath = explicitFileMatch ? explicitFileMatch[1].replace(/\\/g, '/') : null;
                    const explicitAbsPath = explicitRelPath ? path.resolve(this.workspaceRoot, explicitRelPath) : null;
                    const explicitFileIsMissing = explicitAbsPath ? !fs.existsSync(explicitAbsPath) : false;
                    const filteredHits = explicitFileIsMissing
                        ? fsHits.filter(h => h.relPath.replace(/\\/g, '/') === explicitRelPath)
                        : fsHits;

                    if (filteredHits.length > 0) {
                        const hitLines = filteredHits.map(h => {
                            const parts = [`  File: \`${h.relPath}\``];
                            if (h.matchedRoutes.length > 0) { parts.push(`  Routes: ${h.matchedRoutes.map(r => `\`${r}\``).join(', ')}`); }
                            if (h.matchedFunctions.length > 0) { parts.push(`  Functions: ${h.matchedFunctions.map(f => `\`${f}\``).join(', ')}`); }
                            return parts.join('\n');
                        }).join('\n\n');
                        baseSystemWithMemory += `\n\n## [FEATURE ALREADY EXISTS — FILE SYSTEM SCAN]\n\nBefore writing any code, a programmatic scan of the project found existing code matching this task:\n\n${hitLines}\n\nYou MUST:\n1. Read the file(s) listed above\n2. Tell the user exactly what already exists\n3. Only write NEW code if the requested feature is genuinely absent from those files\n4. Do NOT re-implement anything that already exists`;
                        logInfo(`[fs-scan] Injected existence warning: ${filteredHits.length} hit(s) for [${fsKws.join(', ')}]`);
                    } else if (explicitFileIsMissing && fsHits.length > 0) {
                        // Hits exist in other files — inform the model but don't block creation.
                        // Also inject a sibling file as a structural template so the model
                        // writes correct imports on the first try instead of guessing.
                        const targetDirAbs = explicitAbsPath ? path.dirname(explicitAbsPath) : null;
                        let siblingTemplate = '';
                        if (targetDirAbs && fs.existsSync(targetDirAbs)) {
                            try {
                                const siblingEntry = fs.readdirSync(targetDirAbs)
                                    .filter(e => e.endsWith('.py') && !e.startsWith('__'))
                                    .map(e => path.join(targetDirAbs, e))
                                    .find(f => { try { return fs.statSync(f).size < 30_000; } catch { return false; } });
                                if (siblingEntry) {
                                    const sibContent = fs.readFileSync(siblingEntry, 'utf8').slice(0, 3000);
                                    const sibRel = path.relative(this.workspaceRoot, siblingEntry).replace(/\\/g, '/');
                                    siblingTemplate = `\n\n[SIBLING TEMPLATE — copy these imports/structure for the new file]\nFile: ${sibRel}\n\`\`\`python\n${sibContent}\n\`\`\``;
                                    logInfo(`[fs-scan] Injected sibling template from ${sibRel}`);
                                }
                            } catch { /* non-fatal */ }
                        }
                        baseSystemWithMemory += `\n\n## [NEW FILE REQUIRED]\n\nThe target file \`${explicitRelPath}\` does not exist yet — CREATE it.\n\nRelated routes in other files (reference only — do not modify them):\n${fsHits.map(h => `  \`${h.relPath}\`: ${h.matchedRoutes.join(', ')}`).join('\n')}${siblingTemplate}\n\nUse edit_file with:\n- path="${explicitRelPath}"\n- old_string="" (empty — creates new file)\n- new_string=<complete Python module content>\n\nCopy the import style from the sibling template above. Do NOT use run_command or New-Item.`;
                        logInfo(`[fs-scan] New-file task: suppressed existence block, ${fsHits.length} related hit(s) noted as reference`);
                    } else if (explicitFileIsMissing) {
                        // No related hits at all — pure new file
                        const targetDirAbs2 = explicitAbsPath ? path.dirname(explicitAbsPath) : null;
                        let siblingTemplate2 = '';
                        if (targetDirAbs2 && fs.existsSync(targetDirAbs2)) {
                            try {
                                const siblingEntry2 = fs.readdirSync(targetDirAbs2)
                                    .filter(e => e.endsWith('.py') && !e.startsWith('__'))
                                    .map(e => path.join(targetDirAbs2, e))
                                    .find(f => { try { return fs.statSync(f).size < 30_000; } catch { return false; } });
                                if (siblingEntry2) {
                                    const sibContent2 = fs.readFileSync(siblingEntry2, 'utf8').slice(0, 3000);
                                    const sibRel2 = path.relative(this.workspaceRoot, siblingEntry2).replace(/\\/g, '/');
                                    siblingTemplate2 = `\n\n[SIBLING TEMPLATE]\nFile: ${sibRel2}\n\`\`\`python\n${sibContent2}\n\`\`\``;
                                    logInfo(`[fs-scan] Injected sibling template (no hits) from ${sibRel2}`);
                                }
                            } catch { /* non-fatal */ }
                        }
                        if (siblingTemplate2) {
                            baseSystemWithMemory += `\n\n## [NEW FILE REQUIRED]\n\nThe target file \`${explicitRelPath}\` does not exist yet — CREATE it.${siblingTemplate2}\n\nUse edit_file with old_string="" (empty) and new_string=<complete file content based on sibling template>.`;
                        }
                    }
                }
            } catch { /* non-fatal */ }
        }

        // Fix 6a: Task-type-specific system prompt suffix
        // Small, focused instructions beat long generic ones for 7B models.
        // Only appended when we know the task type (edit task with pre-loaded context).
        if (this._isEditTask && this._editContextInjected) {
            const isFormTaskMsg = /\b(form|template|inline|frontend|html)\b/i.test(userMessage)
                || /\badd\b.{0,40}\b(field|column|input)\b/i.test(userMessage);
            const isBugFixMsg = /\bfix\b/i.test(userMessage) && !/\ball\b|\bevery\b/.test(userMessage);
            const isAddRouteMsg = /\badd\b.{0,30}\broute\b/i.test(userMessage);
            if (isFormTaskMsg) {
                baseSystemWithMemory += `\n\n## TASK TYPE: Add field to form\nThis task requires changes to MULTIPLE files — the HTML template, the JS submit handler, and possibly the backend route. The pre-loaded context above identifies all three. You MUST edit all of them. Do not stop after one file. The task is complete only when every file in the "TASK COMPLETE WHEN" checklist above has been edited.`;
            } else if (isBugFixMsg) {
                baseSystemWithMemory += `\n\n## TASK TYPE: Bug fix\nRead the error, find the exact line, fix it with edit_file. Do not describe the fix — apply it. Do not suggest the user verify anything — you verify by reading the file after the edit. One sentence response after the fix: what was wrong and what was changed.`;
            } else if (isAddRouteMsg) {
                baseSystemWithMemory += `\n\n## TASK TYPE: Add route\nCopy the pattern shown in the pre-loaded context exactly — same blueprint variable, same decorator style, same return format. Do not invent a different structure. Call edit_file_at_line once. If the route already exists in "Already defined", stop immediately.`;
            }
        }

        // Cache system content per toolMode to avoid rebuilding every turn
        let lastToolMode: 'native' | 'text' | null = null;
        let systemContent = '';

        // ── Multi-model routing ────────────────────────────────────────────────
        // Track whether the previous turn was purely read-only (shell_read, memory_*)
        // so we can downshift to the fast model when no writes have happened yet.
        const READ_ONLY_TOOLS = new Set(['shell_read', 'memory_search', 'memory_list', 'memory_tier_list', 'memory_stats']);
        let prevTurnWasReadOnly = isPlanTask || isCreativeTask; // plan/creative tasks start in read mode
        const routedFastModel = cfg.modelRoutingEnabled ? (cfg.fastModel || model) : model;
        const routedCriticModel = cfg.modelRoutingEnabled ? (cfg.criticModel || model) : model;

        for (let turn = 0; turn < MAX_TURNS; turn++) {
            if (this.stopRef.stop) { this._runOutcome = 'stopped'; break; }
            this._runTurnCount = turn + 1;
            this._focusedGrepInjectedThisTurn = false; // Reset per-turn to prevent double-injection
            this._recentSearchResultIds.clear();        // Reset per-turn search_hit tracking

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
                this._lastSystemContent = systemContent;
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

                    // Save structured facts from dropped messages to Tier 2 memory so discoveries
                    // survive even silent auto-compaction. Use the same LLM-based structured
                    // extraction as manual compact — run async so it doesn't block this turn.
                    if (this.memory && messagesRemoved > 0) {
                        const droppedForSave = this.history.slice(0, messagesRemoved);
                        const droppedText = droppedForSave
                            .filter(m => m.role === 'user' || m.role === 'assistant')
                            .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
                            .join('\n');
                        const currentModel2 = this.currentModel || getConfig().model;
                        const taskMsgSnap = this._currentTaskMessage;
                        // Fire-and-forget: run LLM extraction in background, save to memory when done
                        (async () => {
                            try {
                                let rawSummary = '';
                                if (droppedText.trim()) {
                                    await streamChatRequest(
                                        currentModel2,
                                        [
                                            {
                                                role: 'system',
                                                content: [
                                                    'You are a context extractor. Extract structured facts from this conversation.',
                                                    'Output ONLY a JSON object with these keys (omit any key with an empty value):',
                                                    '  task: string — one sentence describing what was being worked on',
                                                    '  files_confirmed: string[] — real file paths that were found and confirmed correct',
                                                    '  files_ruled_out: string[] — stub files, wrong paths, files that do not exist',
                                                    '  decisions: string[] — key decisions made',
                                                    '  edits_made: string[] — describe each successful file edit',
                                                    '  blockers: string[] — anything that failed or was unclear',
                                                    '  next_step: string — what should happen next if the task is not done',
                                                    'Output ONLY the JSON. No explanation, no markdown fences.',
                                                ].join('\n'),
                                            },
                                            { role: 'user', content: droppedText.slice(0, 6000) },
                                        ],
                                        [],
                                        (token) => { rawSummary += token; },
                                        { stop: false }
                                    );
                                }
                                let structured: Record<string, unknown> = {};
                                try {
                                    const jsonMatch = rawSummary.match(/\{[\s\S]*\}/);
                                    if (jsonMatch) { structured = JSON.parse(jsonMatch[0]); }
                                } catch { /* fall through */ }
                                const lines: string[] = [];
                                if (taskMsgSnap) { lines.push(`Task: ${taskMsgSnap.slice(0, 80)}`); }
                                if (structured.task) { lines.push(`Summary: ${structured.task}`); }
                                if (Array.isArray(structured.files_confirmed) && structured.files_confirmed.length) {
                                    lines.push(`Files confirmed: ${(structured.files_confirmed as string[]).join(', ')}`);
                                }
                                if (Array.isArray(structured.files_ruled_out) && structured.files_ruled_out.length) {
                                    lines.push(`Files ruled out: ${(structured.files_ruled_out as string[]).join(', ')}`);
                                }
                                if (Array.isArray(structured.decisions) && structured.decisions.length) {
                                    lines.push(`Decisions: ${(structured.decisions as string[]).join(' | ')}`);
                                }
                                if (Array.isArray(structured.edits_made) && structured.edits_made.length) {
                                    lines.push(`Edits made: ${(structured.edits_made as string[]).join(' | ')}`);
                                }
                                if (structured.next_step) { lines.push(`Next step: ${structured.next_step}`); }
                                if (Array.isArray(structured.blockers) && structured.blockers.length) {
                                    lines.push(`Blockers: ${(structured.blockers as string[]).join(' | ')}`);
                                }
                                lines.push(`(auto-compact ${new Date().toLocaleTimeString()})`);
                                const memNote = lines.join('\n');
                                this.memory!.addEntry(2, memNote, ['auto-compact', 'session']).catch(() => {});
                                logInfo(`[context] Auto-compact: saved structured snapshot to Tier 2 memory (${lines.length} facts)`);
                            } catch (err) {
                                logWarn(`[context] Auto-compact: structured extraction failed, falling back to regex: ${toErrorMessage(err)}`);
                                // Fallback: plain regex scrape
                                const editFacts = droppedForSave
                                    .filter(m => m.role === 'assistant')
                                    .flatMap(m => {
                                        const edits = [...m.content.matchAll(/Edited:\s*([^\s—]+)/g)].map(x => `edited ${x[1]}`);
                                        const paths = [...m.content.matchAll(/['"](app\/[^'"]+\.[a-z]+)['"]/g)].map(x => x[1]);
                                        return [...edits, ...paths];
                                    })
                                    .filter((v, i, a) => a.indexOf(v) === i)
                                    .slice(0, 8);
                                if (editFacts.length > 0 || taskMsgSnap) {
                                    const fallbackNote = [
                                        taskMsgSnap ? `Task: ${taskMsgSnap.slice(0, 80)}` : '',
                                        editFacts.length ? `Progress: ${editFacts.join(', ')}` : '',
                                        `(auto-compact fallback ${new Date().toLocaleTimeString()})`,
                                    ].filter(Boolean).join('\n');
                                    this.memory!.addEntry(2, fallbackNote, ['auto-compact', 'session']).catch(() => {});
                                }
                            }
                        })();
                    }

                    // After compaction, ensure the original task is still in history.
                    // compactHistory works backwards from the end, so the first user message
                    // (the actual task) is often the first thing dropped when context is full.
                    // Re-inject it at the start so the model stays on task.
                    if (this._currentTaskMessage) {
                        const taskStillPresent = this.history.some(
                            m => m.role === 'user' && m.content.includes(this._currentTaskMessage.slice(0, 50))
                        );
                        if (!taskStillPresent) {
                            // Load any recent Tier 2 memory to give the model the structured facts
                            let recentMemFacts = '';
                            if (this.memory) {
                                try {
                                    const tier2 = this.memory.getTier(2).slice(0, 3);
                                    if (tier2.length) {
                                        recentMemFacts = '\n\nRecent memory:\n' + tier2.map(e => `- ${e.content.slice(0, 120)}`).join('\n');
                                    }
                                } catch { /* skip */ }
                            }
                            // Fix 5c: Include task state in compaction note
                            const taskStateLines: string[] = [];
                            if (this._activeTask) {
                                if (this._activeTask.stepsCompleted.length) {
                                    taskStateLines.push(`Done so far: ${this._activeTask.stepsCompleted.join(', ')}`);
                                }
                                if (this._activeTask.stepsPending.length) {
                                    taskStateLines.push(`Still to do: ${this._activeTask.stepsPending.join(', ')}`);
                                }
                                if (this._activeTask.filesConfirmed.length) {
                                    taskStateLines.push(`Files confirmed correct: ${this._activeTask.filesConfirmed.join(', ')}`);
                                }
                                if (this._activeTask.filesRuledOut.length) {
                                    taskStateLines.push(`Files to avoid (stubs/wrong): ${this._activeTask.filesRuledOut.join(', ')}`);
                                }
                            }
                            const taskStateBlock = taskStateLines.length
                                ? `\n\nTask state:\n${taskStateLines.join('\n')}`
                                : '';
                            const compactNote = `[CONTEXT NOTE: Earlier messages were removed to free up context. Your current task is: "${this._currentTaskMessage}". Continue working on this task. Do NOT start a new task or execute suggestions from any planning documents you may have read.]${taskStateBlock}${recentMemFacts}\n\n${this._currentTaskMessage}`;
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

            // Route to fast model when the previous turn was purely reads and no edits yet
            const effectiveModel = (prevTurnWasReadOnly && this._editsThisRun === 0)
                ? routedFastModel : model;
            if (effectiveModel !== model) {
                logInfo(`[routing] Using fast model "${effectiveModel}" for read-only turn`);
            }

            let result: StreamResult;
            try {
                result = await streamChatRequest(
                    effectiveModel,
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
                    logInfo(`Model ${model} → switching to text-mode (will be remembered)`);
                    post({ type: 'streamEnd' });
                    post({ type: 'removeLastAssistant' });
                    // Only show notice on first discovery — future sessions skip detection entirely
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

            // Store logprob confidence for use in tool handlers (e.g. edit_file warning)
            this._lastResponseAvgLogprob = result.avgLogprob;

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
                // ── Think-stall guard: model produced thinking but no content and no tool calls ──
                // qwen3 "thinking" models sometimes complete the <think> block but then emit nothing —
                // no content, no tool calls. The stream resolves with content='' toolCalls=[].
                // Detect this and retry with a nudge to continue from where thinking left off.
                const isThinkStall = !result.content && !displayContent && turn > 0 && this.autoRetryCount < this.MAX_AUTO_RETRIES;
                if (isThinkStall) {
                    this.autoRetryCount++;
                    logInfo(`[agent] Auto-retry ${this.autoRetryCount}: think-stall — model completed thinking but emitted no content or tool calls (turn ${turn})`);
                    this.history.pop(); // remove the empty assistant message
                    this.history.push({
                        role: 'user',
                        content: `[SYSTEM: Your response was empty. You were in the middle of exploring the codebase. Continue where you left off — call the next tool now. Do NOT explain or summarize. Just call the tool.]`
                    });
                    post({ type: 'removeLastAssistant' });
                    continue;
                }

                // ── Auto-retry: detect "asking permission" or verbose plan without action ──
                if (turn < MAX_TURNS - 1 && this.autoRetryCount < this.MAX_AUTO_RETRIES) {
                    const resp = (displayContent || result.content).toLowerCase();
                    const lastMsg = (userMessage).toLowerCase();
                    // Detect a correct EXPLORE→CONFIRM stop: model explored with tools (turn > 0),
                    // produced a structured plan (has ## headers or numbered list), and asked a
                    // single closing question. This is intentional — do NOT retry it.
                    // userWantsAction: message must be imperative (not a question) and use strong action verbs
                    // Exclude: questions (?), explain/describe/show/tell/what/why/how requests
                    const isQuestion = /\?/.test(userMessage) || /^\s*(what|why|how|can you|could you|would you|do you|is|are|explain|describe|show me|tell me|what is|what are)\b/i.test(userMessage);
                    const userWantsAction = !isQuestion && !isExplainQuery && /\b(find|search|look|locate|show|implement|apply|execute|move|rename|reorganize|restructure|create|build|migrate|edit|update|fix|modify|refactor|rewrite|convert|transform|add|remove|delete|deploy|install|split|separate|extract|merge|track|store|record|save|run the|do the|do it|make the|need to|we need|want to)\b/.test(lastMsg);
                    // isConfirmStop: model explored with tools, built a plan, and asked a single closing question.
                    // Only valid as a stop if: (a) model has actually done edits (not just reads), OR
                    // (b) the task is not a pure action task (e.g. it's a review/explain).
                    // Prevents the pattern: read 3 files → output plan + questions → wait for user.
                    const hasEditsThisSession = this._lastEditedFilePath !== '';
                    const isConfirmStop = turn > 0
                        && /(?:##|\n\d+\.\s|\*\*).{20,}/i.test(resp)   // has plan structure
                        && /does this match|sound right|shall i proceed|should i proceed|want me to proceed|like me to proceed|would you like me to (start|begin|implement|proceed)|ready to (implement|proceed|start|begin)|should we proceed|want to proceed/i.test(resp)
                        && (!userWantsAction || hasEditsThisSession || isReviewTask);
                    const isAskingPermission = !isConfirmStop
                        && /would you like me to|shall i|do you want me to|want me to proceed|like me to continue|is there anything specific|does this match what you|one question:|should (the endpoint|i include|we include|i proceed|i register|i add|i update)|which fields should|should i proceed|shall i proceed|will you handle|handle that separately|or will you|do you want me|want me to also/i.test(resp);
                    const hasCodeBlockButNoTool = /```/.test(resp) && !toolCalls.length;
                    // Detect validation stops: model reviewed the code and decided not to act
                    const isValidationStop = this._editContextInjected && !toolCalls.length
                        && /already (exists?|present|there|defined|implemented)|redundant|duplicate|doesn't exist|does not exist|no mention|unresolved|missing model|can't find|cannot find|stop here|won't (proceed|make|add)|will stop|should stop|no need to add|there is no need|provide more details/i.test(resp);
                    // Don't treat a correct answer to a read/explain task as a "verbose plan dump".
                    // Only fire on turn 0 — after the model has called tools and is giving a final answer,
                    // a text-only response is the conclusion, not a plan dump.
                    const isVerbosePlanDump = !toolCalls.length && userWantsAction && !isExplainQuery && !isValidationStop
                        && turn === 0
                        && (resp.length > 400 || hasCodeBlockButNoTool);
                    // Model asked user to provide file/content instead of reading it itself
                    // But NOT when it's a validation stop asking for clarification on what to change
                    const isAskingUserToProvide = !isValidationStop && /please provide|provide the (contents|file|code|text)|share the (contents|file|code)|paste the|send me the|provide me with/i.test(resp);

                    // Sweep task: model gave a no-tool completion summary (hallucinated from history)
                    // Detect: sweep task + no tools called + response looks like a prior-session summary
                    const isSweepHallucination = isSweepTask && !toolCalls.length && turn === 0
                        && /updated\s+\d+\s+routes?|added\s+error\s+handling|routes?:\s*\[/i.test(resp);
                    if (isSweepHallucination) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: sweep task hallucinated completion from history — forcing fresh file read`);
                        this.history.pop();
                        this.history.push({
                            role: 'user',
                            content: `[SYSTEM: You reported completing the task but you have NOT called any tools in this session. You must actually READ the file and make the edits. Start by calling shell_read to read the current state of the file NOW. Do not rely on prior conversation history — the file may have changed.]`
                        });
                        post({ type: 'removeLastAssistant' });
                        continue;
                    }

                    // Fire on: (1) action query asking permission, or (2) model already called tools (turn>0) and now stalls with a question
                    if (isAskingPermission && (userWantsAction || turn > 0)) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model asked for permission instead of acting (turn ${turn})`);
                        // Replace the assistant's response with a nudge
                        this.history.pop(); // remove the assistant message we just pushed
                        this.history.push({
                            role: 'user',
                            content: turn > 0
                                ? `[SYSTEM: You already read the file(s). Do NOT ask the user a follow-up question — just answer using the information you already have. If you need to check more files, call shell_read now. Original question: "${userMessage}"]`
                                : '[SYSTEM: You asked for permission but the user already told you to do it. Do NOT ask — start calling tools NOW. Call the first tool immediately.]'
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
                    // Does NOT require userWantsAction — even for "which X has Y?" queries, planning instead of checking is wrong
                    // Don't treat a response as "planning instead of doing" if:
                    // (a) the response contains a <tool> block that failed to parse (parser failure, not model failure)
                    // (b) the user explicitly asked for a plan/document/summary
                    const userAskedForPlan = /\b(plan|design|document|write.*doc|create.*file|save.*plan|discuss|proposal|how.*can|is it possible)\b/i.test(this._currentTaskMessage);
                    const responseHasToolBlock = result.content.includes('<tool>');
                    // Detect task-completion responses — model correctly concluded nothing more needed
                    // Also detect completion when edits were already made this run and model produces a summary (even with code blocks or "fix" language)
                    const editsAlreadyMade = this._editsThisRun > 0 && !toolCalls.length && turn > 0;
                    const isTaskCompletion = editsAlreadyMade
                        || /\b(no (further |more |additional |other )?changes? (are |is )?(needed|required|necessary)|no (further |more )?edits? (are |is )?(needed|required)|already (implemented|fully implemented|in place|connected|wired up|present|exists?|correct)|implementation (is |looks )?(complete|correct|already|done)|task (is |appears )?(complete|done|finished)|nothing (else |more |further |additional )?(is |are |was )?(needed|required|to do)|fully (connected|wired|implemented|functional)|no (action|update|change|edit) (is |are )?(needed|required|necessary))\b/i.test(resp)
                        || /✅|task complete|no errors or warnings found|following (our |the )?project conventions?/i.test(resp);
                    const isPlanningInsteadOfDoing = turn > 0 && !toolCalls.length && resp.length > 300
                        && !userAskedForPlan && !responseHasToolBlock && !isTaskCompletion
                        && /\b(you would|you could|you can|you need to|would need to|we would need to|this (would|will|change will|change would)|to (split|refactor|separate|reorganize|restructure|move|create|migrate)|to (find|check|inspect|verify|look at) (which|each|every|all))\b/i.test(resp)
                        || (turn > 0 && !toolCalls.length && userWantsAction && !isTaskCompletion
                            && /what i('ll| will) (create|do|add|make|build|write)|here'?s? (my plan|what i('ll| will)|the plan)|what i found:/i.test(resp)
                            && /\?/.test(resp.slice(-300)));
                    // Detect: model read a file, found a bug, but output a code snippet instead of calling edit_file
                    // Pattern: turn > 0 (file was already read), no tool calls, uses advisory language about a fix
                    // Does NOT require a fenced code block — inline code or plain text advisories also count
                    // Bug reports (NameError, AttributeError, etc.) implicitly want a fix even without action verbs
                    const isBugReport = /\b(NameError|AttributeError|TypeError|ValueError|ImportError|KeyError|IndexError|SyntaxError|RuntimeError|500 error|traceback|line \d+)\b/i.test(lastMsg);
                    // Also catches schema dump: response describes a db.Column addition with a code block but doesn't call edit_file
                    const isSchemaCodeDump = turn > 0 && !toolCalls.length && userWantsAction
                        && /```[\s\S]*?db\.Column[\s\S]*?```/.test(resp);
                    // Only trigger isSuggestedFixDump when no edits have been made yet this run.
                    // If _editsThisRun > 0, the model already applied its fixes — a code-containing summary is a completion, not a stall.
                    const isSuggestedFixDump = turn > 0 && !toolCalls.length && (userWantsAction || isBugReport)
                        && this._editsThisRun === 0
                        && (/\b(suggested fix|immediate fix|for example[,:]|fix:|here'?s? (the|a|my) fix|apply (this|the) fix|example fix|proposed fix|recommended fix|to fix this|the fix is|corrected line|specific line to fix|add (a )?null check|add (a )?guard|wrap.*in.*try|replace.*with|update (the|this) (log|line|code|statement) to use|change .* to )\b/i.test(resp)
                        || isSchemaCodeDump);
                    // Don't retry explain/read tasks that already received tool results and produced a substantive answer.
                    // "read X and tell me Y" tasks are done once the model answers after reading — no further tools needed.
                    // Exception: if the answer admits it didn't read the key implementation file, it's not truly done.
                    const admitsIncomplete = /\b(not visible in this file|would reside in|is not visible|logic.*not.*visible|not.*shown here|implementation.*not.*available|actual.*logic.*in)\b/i.test(resp);
                    const modelAlreadyAnswered = isExplainQuery && turn > 0 && toolCalls.length === 0
                        && resp.length > 400
                        && !admitsIncomplete;
                    // Detect hedging answers that reference files without reading them
                    const isHedgingWithoutReading = !toolCalls.length && !modelAlreadyAnswered
                        && turn > 0 && turn < 4
                        && /\b(likely (contains?|defines?|handles?|has|includes?)|probably (defines?|contains?|handles?)|may (contain|exist|include|define)|likely defined in|implied by|details aren't visible|schema details|exact.*not visible|check the code in|would reside in|not visible in this file|is not visible|logic.*not.*visible)\b/i.test(resp)
                        && /`[^`]+\.(py|ts|js|rb|go|java)`/.test(resp); // mentions a source file in backticks
                    // Detect "wrong file" responses: model read a file but it didn't contain the requested logic,
                    // and the response is short/dismissive. Force it to read the correct file from prior search results.
                    const isWrongFileResponse = !toolCalls.length && !modelAlreadyAnswered
                        && turn > 0 && turn < 4 && resp.length < 1200
                        && /\b(does not (show|contain|include|have)|no (specific|direct|explicit)|not (shown|visible|found|included|present)|snippet does not|code (does|did) not (show|include|contain)|no implementation)\b/i.test(resp)
                        && isExplainQuery;
                    // A substantive analysis report: long (>2000 chars), has multiple ## headings or code blocks,
                    // and any closing question appears only in the last 300 chars. Model completed its work — don't retry.
                    const headingCount = (resp.match(/^##\s/gm) || []).length;
                    const hasCodeBlocks = /```[\s\S]{20,}```/.test(resp);
                    const isSubstantiveAnalysis = resp.length > 2000
                        && (headingCount >= 2 || (headingCount >= 1 && hasCodeBlocks))
                        && !/\b(would you|shall i|do you want|like me to|which file|what file|next step)\b/i.test(resp.slice(0, resp.length - 300));
                    const isSummaryWithQuestion = !toolCalls.length
                        && !modelAlreadyAnswered
                        && !isHedgingWithoutReading
                        && !isPlanTask && !isReviewTask && !isCreativeTask
                        && !isTaskCompletion
                        && !isConfirmStop
                        && !isSubstantiveAnalysis
                        && turn > 0 && resp.length > 100
                        && (isOfferingHelp || isPlanningInsteadOfDoing || (/\b(here are|the (?:search|results?|output|matches)|found \d+|instances?|occurrences?)\b/i.test(resp)
                        && /\b(would you|shall i|do you want|like me to|specific file|which file|what file|have another|next step)\b/i.test(resp)));
                    if (isHedgingWithoutReading) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model gave hedged answer without reading referenced files (turn ${turn})`);
                        this.history.pop();
                        this.history.push({
                            role: 'user',
                            content: `[SYSTEM: Your answer referenced implementation details in files you haven't fully read yet (e.g. "would reside in", "not visible in this file", "likely", "probably"). You MUST read those source files now to give a complete, definitive answer. Use shell_read to read the specific files you mentioned. Call the tool NOW — do not summarize what you haven't read.]`
                        });
                        post({ type: 'removeLastAssistant' });
                        continue;
                    }
                    if (isWrongFileResponse) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model read wrong file and gave dismissive response (turn ${turn}, ${resp.length} chars)`);
                        this.history.pop();
                        this.history.push({
                            role: 'user',
                            content: `[SYSTEM: The file you just read did not contain the requested logic. Your prior search results showed other files that likely contain it. Look at the search results above and read the correct file — e.g. a file whose name matches the topic (like "void_refund_api.py" for void operations). Use shell_read with Get-Content on that file NOW. Do not explain — just call the tool.]`
                        });
                        post({ type: 'removeLastAssistant' });
                        continue;
                    }
                    if (isSummaryWithQuestion) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model summarized results and asked/offered help instead of answering (turn ${turn})`);
                        this.history.pop();
                        // On repeated stalls, give a concrete grep command to unblock the model
                        const retryNudge = this.autoRetryCount >= 2
                            ? `[SYSTEM: STOP describing what you would do. You MUST call shell_read RIGHT NOW with a grep command. Example: shell_read with command="Get-ChildItem -Path 'c:/Users/david/Documents/source/scrapyard_new_ai/app/routes' -Recurse -Filter '*.py' | ForEach-Object { $f=$_.FullName; $m=Select-String -Path $f -Pattern 'try:' -Quiet; if (-not $m) { $f } }". This will list files with no try: blocks. Call it NOW — do not explain, do not ask, just call the tool.]`
                            : `[SYSTEM: You summarized a tool result and asked the user a follow-up question or offered help. Do NOT ask — just answer. The user's original question was: "${userMessage}". Use what you already found to answer it directly. If you need more detail, use shell_read to read the relevant files NOW. Do NOT ask the user anything — call a tool immediately.]`;
                        this.history.push({
                            role: 'user',
                            content: retryNudge
                        });
                        post({ type: 'removeLastAssistant' });
                        continue;
                    }

                    // Bug-fix pattern: model read the file, described the fix with a code snippet, but didn't call edit_file
                    if (isSuggestedFixDump) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: model output a "Suggested Fix" code block instead of calling edit_file (turn ${turn})`);
                        this.history.pop();
                        const fixNudge = isTextMode
                            ? `[SYSTEM: You described the fix but did NOT apply it. Output ONLY this tool call — replace the values in angle brackets with the real strings from the file:\n<tool>{"name":"edit_file","arguments":{"path":"<full file path>","old_string":"<exact current line>","new_string":"<corrected line>"}}</tool>\nNo explanation. No code blocks. Just the <tool> XML above with real values filled in.]`
                            : `[SYSTEM: You described the fix but did NOT apply it. Call edit_file RIGHT NOW. Set path to the file you just read, old_string to the exact buggy line (copy it character-for-character from the file content above), and new_string to the corrected version. Do NOT output a code block — invoke the tool directly.]`;
                        this.history.push({
                            role: 'user',
                            content: fixNudge
                        });
                        post({ type: 'removeLastAssistant' });
                        continue;
                    }

                    // Sweep task: model declared completion mid-sweep without having edited all items.
                    // Detect: sweep task + turn > 0 + no tools + "all routes ... done / no further" language
                    // Only treat as premature-done if model hasn't made any edits yet this run.
                    // If edits were made and model says done, trust it — don't force re-reads.
                    const isSweepPrematureDone = isSweepTask && !toolCalls.length && turn > 0
                        && this._editsThisRun === 0
                        && /\b(all routes?|no further|already (have|has)|complete[d]?|nothing (else|more)|no (more|additional)|updated all)\b/i.test(resp);
                    if (isSweepPrematureDone) {
                        this.autoRetryCount++;
                        logInfo(`[agent] Auto-retry ${this.autoRetryCount}: sweep task declared completion with 0 edits (turn ${turn}) — forcing re-read to verify`);
                        this.history.pop();
                        this.history.push({
                            role: 'user',
                            content: `[SYSTEM: You said all routes are done, but you have not made any edits yet this session. Please verify by re-reading the file with shell_read and check EVERY function. If any are missing try/except, edit them now.]`
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
                    const isGenericLongAnswer = turn === 0 && !toolCalls.length && resp.length > 300 && !hasCodebaseRef && !this._editContextInjected;
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
                                const stopWords = new Set(['show','me','how','the','a','an','is','are','does','do','what','where','find','all','please','works','work','working','this','that','it','in','on','of','for','to','and','or','with','by','from','at','into','save','saved','saving','get','set','use','used','make','made','take','taken','run','new','old','add','added','create','created','update','updated','delete','deleted']);
                                const keywords = lastMsg.split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w.toLowerCase()));
                                // Prefer longer, more specific keywords — pick the longest one from first 5
                                const bestKeyword = keywords.slice(0, 5).sort((a, b) => b.length - a.length)[0] ?? lastMsg.slice(0, 40);
                                const isWin = process.platform === 'win32';
                                const wsRoot = this.workspaceRoot ? this.workspaceRoot.replace(/\\/g, '/') : '.';
                                const grepCmd = isWin
                                    ? `Get-ChildItem -Path '${wsRoot}' -Recurse -Include '*.py','*.ts','*.js' | Select-String -Pattern '${bestKeyword}' | Select-Object Path,LineNumber,Line | Select-Object -First 20`
                                    : `grep -rn --include="*.py" --include="*.ts" --include="*.js" -l "${bestKeyword}" "${wsRoot}" 2>/dev/null | head -10`;
                                const query = bestKeyword;
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

                // ── Session-end save to Tier 3 ───────────────────────────
                // When a session completes successfully (model gave final answer after ≥1 edit),
                // save a structured "completed feature" entry to Tier 3 so future sessions
                // can detect it via the prior-work existence check above.
                if (this.memory && this._editsThisRun > 0) {
                    const sessionFacts: string[] = [];
                    const taskMsg = this._currentTaskMessage ?? '';
                    if (taskMsg) { sessionFacts.push(`Task: ${taskMsg.slice(0, 100)}`); }

                    // Collect all files touched this session from fileChanged events
                    // (_filesAutoReadThisRun tracks reads; collect edited paths from tool history)
                    const editedPaths: string[] = [];
                    if (this._lastEditedFilePath) { editedPaths.push(this._lastEditedFilePath); }
                    // Walk history for edit_file tool calls that succeeded
                    for (const msg of this.history) {
                        if (msg.role !== 'assistant') { continue; }
                        const toolBlocks = [...(msg.content?.matchAll(/"name"\s*:\s*"edit_file"[\s\S]{0,200}"path"\s*:\s*"([^"]+)"/g) ?? [])];
                        for (const m of toolBlocks) {
                            const p = m[1];
                            if (p && !editedPaths.includes(p)) { editedPaths.push(p); }
                        }
                    }
                    if (editedPaths.length > 0) {
                        sessionFacts.push(`Files modified: ${editedPaths.slice(0, 6).join(', ')}`);
                    }

                    sessionFacts.push(`Edits: ${this._editsThisRun}`);
                    sessionFacts.push(`Date: ${new Date().toLocaleDateString()}`);

                    // Extract feature keywords from the task message for future searchability
                    const stopWords = new Set(['the','this','that','with','from','into','for','and','create','make','build','add','implement','write','should','would','could','please','just','need','want','a','an','to','in','on','of','is','are','was','were','be','been','being','have','has','had','do','does','did','will','can']);
                    const featureKws = (taskMsg.match(/\b([a-z][a-z0-9_]{3,})\b/gi) ?? [])
                        .filter(w => !stopWords.has(w.toLowerCase()))
                        .slice(0, 8);
                    if (featureKws.length > 0) {
                        sessionFacts.push(`Keywords: ${featureKws.join(', ')}`);
                    }

                    // Include Tier 2 auto-discoveries from this session
                    try {
                        const tier2Recent = this.memory.getTier(2)
                            .filter(e => e.tags?.includes('auto-discovery') || e.tags?.includes('file-resolution'))
                            .slice(0, 3)
                            .map(e => e.content.slice(0, 100));
                        if (tier2Recent.length) { sessionFacts.push(`Discoveries: ${tier2Recent.join(' | ')}`); }
                    } catch { /* skip */ }

                    const sessionNote = sessionFacts.join('\n');
                    // Write unconditionally — skip isSemanticDuplicate to avoid blocking
                    // on an embedding call while Ollama is busy unloading the main model.
                    // Tier 3 duplicates are harmless and get evicted naturally.
                    this.memory!.addEntry(3, sessionNote, ['session-end', 'completed', 'completed-feature']).catch(() => {});
                    logInfo(`[memory] Session-end: saved completed-feature to Tier 3 (${editedPaths.length} files, ${featureKws.length} keywords)`);
                }

                // ── search_hit upgrade ───────────────────────────────────
                // If the model's final response references content from a
                // recently searched memory entry (by quoting ≥10 chars of it),
                // upgrade that entry's last access to search_hit — the strongest
                // signal that the fact was genuinely useful.
                if (this.memory && this._recentSearchResultIds.size > 0) {
                    const respText = (displayContent || result.content).toLowerCase();
                    for (const entryId of this._recentSearchResultIds) {
                        try {
                            const entry = this.memory.findById(entryId);
                            if (entry) {
                                const snippet = entry.content.slice(0, 60).toLowerCase();
                                if (snippet.length >= 10 && respText.includes(snippet)) {
                                    this.memory.recordAccess(entryId, 'search_hit');
                                    logInfo(`[memory] search_hit: model used entry ${entryId}`);
                                }
                            }
                        } catch { /* skip */ }
                    }
                    this._recentSearchResultIds.clear();
                }

                loopExhausted = false;
                break;
            }

            // ── Execute tool calls ────────────────────────────────────────────
            // In text mode, execute only the FIRST tool call per turn.
            // Remaining calls are saved and re-injected as a reminder after the first
            // result so the model continues in order without rediscovering its own plan.
            // In text-mode, execute only the first tool call per turn — EXCEPT for sweep tasks where
            // the model may emit all edits in one batch. For sweeps, execute all at once to avoid
            // the model losing track of deferred calls and generating no-op verify edits.
            // Always batch read-only tool calls (shell_read, memory_search) — deferral only needed for edit tools
            const allReadOnly = toolCalls.every(tc => ['shell_read', 'memory_search', 'code_search'].includes(tc.function.name));
            const executeBatch = this._isSweepTask || allReadOnly || !(isTextMode && toolCalls.length > 1);
            const callsToExecute = executeBatch ? toolCalls : [toolCalls[0]];
            const deferredCalls = executeBatch ? [] : toolCalls.slice(1);
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

                // Record tool call for session log
                const tcPath = String(args.path ?? args.file_path ?? args.command ?? '') || undefined;
                this._toolCallsThisRun.push({ name, path: tcPath });

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

                    // Merge mode + edit_file repeat: inject tail and continue (don't break)
                    if (this._mergeMode && name === 'edit_file') {
                        const targetPath = String(args.path ?? '');
                        const absPath = path.isAbsolute(targetPath) ? targetPath : path.join(this.workspaceRoot, targetPath);
                        const envRepeat = detectShellEnvironment();
                        let tailNote = '';
                        try {
                            const tailCmd = envRepeat.os === 'windows'
                                ? `$lines = Get-Content "${absPath}"; $total = $lines.Count; $start = [Math]::Max(0,$total-20); $lines[$start..($total-1)] | ForEach-Object -Begin {$n=$start+1} -Process { "{0:D4}: {1}" -f $n,$_; $n++ }`
                                : `awk 'END{s=NR-20; if(s<1)s=1} NR>=s{printf "%04d: %s\\n", NR, $0}' "${absPath}"`;
                            const tailContent = await this.runShellRead(tailCmd, this.workspaceRoot, `t_tail_repeat_${Date.now()}`);
                            if (tailContent.trim()) {
                                tailNote = `\n\n[LAST 20 LINES OF FILE]\n${tailContent}\nThe file is too large to match via old_string. Use the LAST NON-BLANK line above as old_string (without the NNNN: prefix), and set new_string to that same line PLUS a blank line PLUS all new methods/functions you want to add.`;
                            }
                        } catch { /* ignore */ }
                        const hint = `Your edit_file old_string did not match — the file is likely too large and was truncated. DO NOT retry the same old_string. Instead, append to the END of the file.${tailNote}`;
                        post({ type: 'toolResult', id: toolId, name, success: false, preview: '(repeated edit blocked — tail injected)' });
                        if (isTextMode) {
                            this.history.push({ role: 'user', content: `Tool ${name} returned:\n[BLOCKED — same edit repeated]\n---\n[SYSTEM: ${hint}]` });
                        } else {
                            this.history.push({ role: 'tool', content: hint });
                        }
                        this.consecutiveRepeats = 0;
                        this.lastToolSignature = '';
                        this.consecutiveSameToolCalls = 0;
                        this.lastToolName = '';
                        continue;
                    }

                    // If the repeated command was a file-search that returned a path, guide the model to read it
                    const isFileSearch = /Get-ChildItem|find\s|ls\s|-name\s|dir\s/i.test(String(args.command ?? ''));
                    const isEditFile = name === 'edit_file' || name === 'edit_file_at_line';
                    const hint = isEditFile
                        ? `[BLOCKED — edit NOT applied] Your edit_file call was identical to a previous attempt that already failed (old_string did not match). The file has NOT been changed.\n\nYou MUST:\n1. Call shell_read with Get-Content to re-read the current file\n2. Find the exact lines you want to change\n3. Copy the old_string character-for-character from that output\n4. Retry edit_file with the corrected old_string\n\nDo NOT use the same old_string again.`
                        : isFileSearch
                        ? `You already ran this file search and got the result. DO NOT run it again. Take the file path from the result and READ the file content now: use shell_read with "cat <path>" or "Get-Content <path>".`
                        : `You already called ${name} with the same arguments ${this.consecutiveRepeats + 1} times and got the same result. DO NOT call this tool again. Use the result you already have and respond to the user with a text answer now.`;
                    if (isTextMode) {
                        this.history.push({ role: 'user', content: `[SYSTEM: ${hint}]` });
                    } else {
                        this.history.push({ role: 'tool', content: hint });
                    }
                    post({ type: 'toolResult', id: toolId, name, success: isEditFile ? false : true, preview: isEditFile ? '(edit NOT applied — re-read file and fix old_string)' : '(duplicate call skipped)' });
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
                // Sweep tasks legitimately call edit_file many times in a row (once per route/function).
                // Plan tasks legitimately call shell_read many times while exploring the codebase.
                // Skip the same-tool consecutive limit in both cases to avoid breaking mid-exploration.
                const skipSameToolLimit = (this._isSweepTask && (name === 'edit_file' || name === 'shell_read'))
                    || ((isPlanTask || isCreativeTask) && name === 'shell_read');
                if (!skipSameToolLimit && this.consecutiveSameToolCalls >= sameToolLimit) {
                    logWarn(`[agent] Breaking same-tool loop: ${name} called ${this.consecutiveSameToolCalls} times consecutively (limit: ${sameToolLimit})`);
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
                if (name === 'shell_read' && this._isSmallModel && this._editContextInjected && !isSweepTask) {
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

                // ── Feature-exploration cap: stop directory-listing loop before CONFIRM ──
                // When userWantsAction and no edit_file has been called yet, cap directory listings.
                // Get-ChildItem/ls/find calls are "listing" reads — limit to 3 before warning.
                // Get-Content/cat calls are "content" reads — these are valuable, don't count them.
                const exploreTaskWantsAction = /\b(implement|apply|add|build|create|track|store|record|save|need to|we need|want to|should get|should send|should have)\b/i.test(this._currentTaskMessage);
                if (name === 'shell_read' && exploreTaskWantsAction && !isPlanTask && !isReviewTask && !isCreativeTask && !this._schemaChangeConfirmed && this._editsThisRun === 0 && !isSweepTask) {
                    // A "listing" command is one whose PRIMARY purpose is to list files/dirs.
                // Get-ChildItem piped into Select-String is a GREP (content search) — don't count it.
                const cmdStr2 = String(args.command ?? '');
                const isGrepPipe = /Select-String\s+-Pattern|Select-String\s+'|grep\s+-[rn]/i.test(cmdStr2);
                const isListingCmd = !isGrepPipe && /Get-ChildItem|Select-Object\s+FullName|\bls\b|\bfind\b/i.test(cmdStr2);
                    if (isListingCmd) {
                        this._exploreShellReadCount++;
                        // On follow-up turns (history has prior exchanges), only allow 1 listing before redirecting
                        const priorTurns = this.history.filter(h => h.role === 'assistant').length;
                        const listingCap = priorTurns > 1 ? 1 : 3;
                        if (this._exploreShellReadCount >= listingCap) {
                            const exploreCapMsg = `[SYSTEM: You have listed directories ${this._exploreShellReadCount} time(s). Stop listing files. You already know the codebase structure from prior turns. Read the specific files you need to make this change using Get-Content, then present your CONFIRM plan or make the edit. Do NOT list more directories.]`;
                            if (isTextMode) {
                                this.history.push({ role: 'user', content: exploreCapMsg });
                            } else {
                                this.history.push({ role: 'tool', content: exploreCapMsg });
                            }
                            post({ type: 'toolResult', id: toolId, name, success: false, preview: '(listing cap reached — read key files now)' });
                            logWarn(`[explore-cap] ${this._exploreShellReadCount} directory listings — injecting redirect`);
                            continue; // don't break — let it read actual files
                        }
                    }
                }

                const isSweepMessage = /\b(all|every|each|any)\b.{0,40}\b(route|function|endpoint|def)\b/i.test(this._currentTaskMessage)
                    || /\b(missing|without|lacks?)\b.{0,50}\b(error|exception|try|handl)/i.test(this._currentTaskMessage)
                    || /\b(no\s+error|no\s+try)\b/i.test(this._currentTaskMessage)
                    || /\b(add|fix).{0,30}\b(all|every|each|any)\b/i.test(this._currentTaskMessage);
                // ── Merge-mode re-read loop detector ─────────────────────────
                // If the model reads the same file >3 times without an edit_file, block
                // further reads and inject the tail so it can append and move on.
                if (this._mergeMode && name === 'shell_read') {
                    const cmdStr = String(args.command ?? '');
                    // Extract filename from powershell Get-Content or cat commands
                    const fileMatch = cmdStr.match(/(?:Get-Content|cat)\s+(?:-Path\s+)?['"]?([^\s'"]+\.py)['"]?/i);
                    if (fileMatch) {
                        const fname = fileMatch[1].replace(/\\/g, '/').split('/').pop() ?? fileMatch[1];
                        const count = (this._mergeFileReadCounts.get(fname) ?? 0) + 1;
                        this._mergeFileReadCounts.set(fname, count);
                        if (count > 2) {
                            // Inject tail and block the read
                            const absP = path.isAbsolute(fileMatch[1]) ? fileMatch[1] : path.join(this.workspaceRoot, fileMatch[1]);
                            let tailNote = '';
                            try {
                                const tailCmd = `$lines = Get-Content "${absP}"; $total = $lines.Count; $start = [Math]::Max(0,$total-40); $lines[$start..($total-1)] | ForEach-Object -Begin {$n=$start+1} -Process { "{0:D4}: {1}" -f $n,$_; $n++ }`;
                                const tailContent = await this.runShellRead(tailCmd, this.workspaceRoot, `t_tail_reread_${Date.now()}`);
                                if (tailContent.trim()) {
                                    tailNote = `\n\n[LAST 40 LINES OF ${fname}]\n${tailContent}\n`;
                                }
                            } catch { /* ignore */ }
                            const absTarget = absP.replace(/\\/g, '/');
                            const forceMsg = `[BLOCKED] You have read "${fname}" ${count} times already. STOP re-reading it.\n\nYou have enough information. You MUST now append any unique methods to the surviving (larger) file using Add-Content, then delete "${fname}".\n\nUse this exact pattern:\n  run_command: Add-Content -Path '<surviving_file_path>' -Value @'\n<paste method code here>\n'@\n\nThen delete with:\n  run_command: Remove-Item -Path '${absTarget}' -Force\n\nIf you believe "${fname}" has no unique methods (all duplicates), skip the Add-Content and just delete it.${tailNote}\nDo NOT call shell_read again. Act NOW.`;
                            logWarn(`[merge-guard] Blocked re-read of ${fname} (count=${count})`);
                            if (isTextMode) {
                                this.history.push({ role: 'user', content: `Tool ${name} returned:\n${forceMsg}` });
                            } else {
                                this.history.push({ role: 'tool', content: forceMsg });
                            }
                            post({ type: 'toolResult', id: toolId, name, success: false, preview: `(re-read blocked — count=${count})` });
                            continue;
                        }
                    }
                }

                // ── Scope-boundary guard: block migration/install commands ──────
                // After adding a model column, the agent must STOP and tell the user to migrate.
                // It must NOT run flask db migrate/upgrade, pip install, or fix unrelated import errors.
                if (name === 'run_command') {
                    const cmdStr0 = String(args.command ?? '');
                    logInfo(`[merge-guard] run_command intercepted, _mergeMode=${this._mergeMode}, cmd=${cmdStr0.slice(0, 60)}`);
                    const isMigrationCmd = /flask\s+db\s+(migrate|upgrade|downgrade|init|stamp)\b/i.test(cmdStr0)
                        || /alembic\s+(upgrade|downgrade|revision|migrate)\b/i.test(cmdStr0);
                    const isPipInstall = /\bpip\s+install\b/i.test(cmdStr0)
                        || /\bpip3\s+install\b/i.test(cmdStr0);
                    if (isMigrationCmd || isPipInstall) {
                        const scopeMsg = isMigrationCmd
                            ? `[BLOCKED: Scope boundary] You must NOT run database migrations directly. Your job is to write code only. Before telling the user how to apply the migration, you must first determine WHERE the database runs: check memory_search("database host server"), read .env, or read deploy.sh. If the DB is on a remote server, give the user SSH-based commands. If local, give local commands. If you don't know, ask: "Is the database local or on a remote server?" — then STOP. Do not run any commands.`
                            : `[BLOCKED: Scope boundary] You must NOT run pip install. Your job is to write code only. Report the missing module to the user and stop. Do not attempt to install packages.`;
                        if (isTextMode) {
                            this.history.push({ role: 'user', content: `[tool:run_command] ${scopeMsg}` });
                        } else {
                            this.history.push({ role: 'tool', content: scopeMsg });
                        }
                        post({ type: 'toolResult', id: toolId, name, success: false, preview: `(scope boundary — migration/install blocked)` });
                        logInfo(`[scope-guard] Blocked ${isMigrationCmd ? 'migration' : 'pip install'} command: ${cmdStr0.slice(0, 80)}`);
                        continue;
                    }
                }
                if (this._mergeMode && name === 'run_command') {
                    // Clear any stale pending confirmation dialog so it doesn't fire 120s later
                    this.rejectPendingConfirmation();
                    const cmdStr = String(args.command ?? '');
                    // Block Add-Content stubs (same check as edit_file stub guard)
                    if (/\bAdd-Content\b/i.test(cmdStr)) {
                        const hasAddContentStub = /\#\s*Implementation details\.\.\./i.test(cmdStr)
                            || /\.\.\.\s*[\[\(]?(full|complete|actual|real|method|implementation|remaining)/i.test(cmdStr)
                            || /pass\s*#\s*(placeholder|stub|todo|implement)/i.test(cmdStr)
                            || /\[full method implementation here\]|\[implementation here\]/i.test(cmdStr)
                            || /\#\s*Implementation from\s+\w+\.py/i.test(cmdStr)
                            || (/\bpass\b/.test(cmdStr) && /\#.*from\s+\w+\.py/i.test(cmdStr));
                        if (hasAddContentStub) {
                            logWarn(`[merge-guard] Blocked stub Add-Content — contains placeholder comments`);
                            this._guardEvents.push({ type: 'merge-guard', reason: 'Add-Content contains stub/placeholder code' });
                            const stubMsg = `[BLOCKED] Your Add-Content contains placeholder/stub comments like "# Implementation details..." or "pass". You MUST paste the REAL, VERBATIM code from the source file.\n\n1. Use shell_read with "Get-Content '<source_file>' | Out-String" to read the FULL source file\n2. Copy the ACTUAL method implementation exactly as it appears\n3. Use Add-Content with the real code — no summaries, no stubs, no placeholders`;
                            if (isTextMode) {
                                this.history.push({ role: 'user', content: `[tool:run_command] ${stubMsg}` });
                            } else {
                                this.history.push({ role: 'tool', content: stubMsg });
                            }
                            post({ type: 'toolResult', id: toolId, name, success: false, preview: '(stub Add-Content blocked)' });
                            continue;
                        }
                    }
                    const isDeleteCmd = /\bRemove-Item\b|\brm\s+|\bdel\s+|\bdelete\s+/i.test(cmdStr);
                    if (isDeleteCmd) {
                        if (!this._mergeEditedSinceLastDelete) {
                            // Allow delete if we've exhausted edit attempts (file too large to patch)
                            const editExhausted = (this._mergeConsecutiveEditFailures ?? 0) >= 4;
                            // Check stub-only file — allow delete without edit
                            const pathMatch = cmdStr.match(/['"]?([^\s'"]+\.py)['"]?/);
                            let isStubFile = false;
                            if (pathMatch) {
                                try {
                                    const content = fs.readFileSync(pathMatch[1], 'utf8');
                                    const nonEmptyLines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
                                    // Empty or near-empty files (≤5 non-blank lines) have nothing to merge
                                    if (nonEmptyLines.length <= 5) {
                                        isStubFile = true;
                                    } else {
                                        const methodLines = nonEmptyLines.filter(l => l.trim().startsWith('def '));
                                        const stubBodyLines = nonEmptyLines.filter(l => /^\s+(return\s+(True|False|\[\]|\{\}|None|0|0\.0|''|""|pass)|pass\s*$)/.test(l));
                                        const substantiveLines = nonEmptyLines.filter(l => !l.trim().startsWith('import ') && !l.trim().startsWith('from ') && !l.trim().startsWith('class ') && !l.trim().startsWith('def ') && !l.trim().startsWith('@') && !l.trim().startsWith('"""') && !l.trim().startsWith("'''") && !l.trim().startsWith('#'));
                                        if (methodLines.length > 0 && substantiveLines.length > 0) {
                                            const stubRatio = stubBodyLines.length / substantiveLines.length;
                                            isStubFile = stubRatio >= 0.7;
                                        }
                                    }
                                } catch (readErr: unknown) {
                                    // If file doesn't exist, it's already been deleted — allow Remove-Item to no-op
                                    if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
                                        isStubFile = true;
                                    }
                                }
                            }
                            if (!isStubFile && !editExhausted) {
                                logWarn(`[merge-guard] Blocked delete without edit_file: ${cmdStr.slice(0, 80)}`);
                                this._guardEvents.push({ type: 'merge-guard', reason: 'delete blocked — must merge content first' });
                                const deletingFile = pathMatch?.[1] ?? 'the file';
                                const blockedResult = `[BLOCKED] You tried to delete "${deletingFile}" without merging its content first.\n\nYou MUST:\n1. Read "${deletingFile}" with shell_read\n2. Identify any methods/functions in it that do NOT exist in the surviving (larger) file\n3. Use edit_file to append those methods to the END of the surviving file\n4. ONLY THEN delete "${deletingFile}"\n\nDo NOT try to delete again until step 3 succeeds. Start by reading "${deletingFile}" now.`;
                                this.history.push({ role: 'user', content: `[tool:run_command] ${blockedResult}` });
                                post({ type: 'token', text: '' });
                                continue;
                            }
                            if (editExhausted) {
                                logWarn(`[merge-guard] Allowing delete after ${this._mergeConsecutiveEditFailures} edit failures (file too large to patch): ${cmdStr.slice(0, 80)}`);
                            }
                        }
                        // Reset state after delete proceeds
                        this._mergeEditedSinceLastDelete = false;
                        this._mergeConsecutiveEditFailures = 0;
                    }
                }
                // _mergeEditedSinceLastDelete is set after a SUCCESSFUL edit_file (see below)

                // ── Write-before-explore guard: block writes on vague requests before any real reads ──
                // When a high-level/vague request (matching EXPLORE→CONFIRM pattern) results in an
                // edit_file or memory_tier_write before the model has read any real source files,
                // the model is inventing file paths from training data rather than exploring the codebase.
                // Intercept and redirect to exploration first.
                const isWriteBeforeExploreVulnerable = (name === 'edit_file' || name === 'edit_file_at_line' || name === 'memory_tier_write')
                    && this._editsThisRun === 0
                    && this._filesAutoReadThisRun.size === 0
                    && turn <= 1
                    && !this._schemaChangeConfirmed
                    && !isSweepTask;
                if (isWriteBeforeExploreVulnerable) {
                    const isVagueRequest = /\b(shorten|simplify|streamline|improve|integrate|workflow|process|feature|business|could we|can we|would it be|is it possible|reduce|fewer|less clicks?|less steps?)\b/i.test(this._currentTaskMessage);
                    if (isVagueRequest) {
                        const explorationRedirect = `[EXPLORE FIRST] You are attempting to write a file before reading the actual codebase. For this type of request you MUST explore the real project files first.\n\nDo NOT write files or save plans until you have:\n1. Listed relevant directories: Get-ChildItem app/templates -Recurse -Filter *.html | Select FullName\n2. Read the actual source files that are relevant to this task\n3. Identified the real file paths (not guessed ones)\n\nStart now by exploring the real codebase structure.`;
                        post({ type: 'toolCall', id: toolId, name, args });
                        post({ type: 'toolResult', id: toolId, name, success: false, preview: explorationRedirect });
                        if (isTextMode) {
                            this.history.push({ role: 'user', content: `Tool ${name} returned:\n${explorationRedirect}` });
                        } else {
                            this.history.push({ role: 'tool', content: explorationRedirect });
                        }
                        logInfo(`[write-before-explore] Blocked ${name} — vague request with no prior reads`);
                        continue;
                    }
                }

                // ── Schema-change guard: require confirmation before adding db.Column to a model file ──
                if ((name === 'edit_file' || name === 'edit_file_at_line') && !this._schemaChangeConfirmed) {
                    const targetPath = String(args.path ?? args.file_path ?? '');
                    const newStr = String(args.new_string ?? '');
                    const normPath = targetPath.replace(/\\/g, '/');
                    const isModelFile = normPath.includes('/models/') && normPath.endsWith('.py');
                    const addsColumn = /db\.Column\s*\(/.test(newStr);
                    if (isModelFile && addsColumn) {
                        // Extract the column definition for the confirmation message
                        const colMatch = newStr.match(/(\w+)\s*=\s*db\.Column\s*\([^)]+\)/);
                        const colDesc = colMatch ? colMatch[0].trim() : newStr.trim().slice(0, 120);
                        const modelName = targetPath.replace(/\\/g, '/').split('/').pop() ?? targetPath;
                        const blockedMsg = `[BLOCKED: Schema change requires confirmation]\n\nYou are about to add a new column to ${modelName}:\n  ${colDesc}\n\nThis is a database schema change that requires a migration. Before proceeding, confirm with the user:\n- Column name and type are correct\n- A migration will be needed\n- No existing field already serves this purpose\n\nRespond to the user: "I'm going to add [column] to ${modelName}. This requires a migration. Does this match what you want?" — then STOP and wait for their reply. Do NOT call edit_file again until you receive confirmation.`;
                        if (isTextMode) {
                            this.history.push({ role: 'user', content: `[tool:edit_file] ${blockedMsg}` });
                        } else {
                            this.history.push({ role: 'tool', content: blockedMsg });
                        }
                        post({ type: 'toolResult', id: toolId, name, success: false, preview: `(schema change blocked — awaiting confirmation)` });
                        logInfo(`[schema-guard] Blocked db.Column addition to model file: ${targetPath}`);
                        this._guardEvents.push({ type: 'schema-guard', reason: 'db.Column addition requires migration confirmation', file: targetPath });
                        continue;
                    }
                }

                // ── Undefined-function call guard: catch calls to functions that don't exist yet ──
                // Fires when new_string calls a function (e.g. _check_currency(...)) that is not
                // defined anywhere in the target file. Prevents wiring up a dispatch to a missing impl.
                if ((name === 'edit_file' || name === 'edit_file_at_line') && !this._schemaChangeConfirmed) {
                    const ufPath = String(args.path ?? args.file_path ?? '');
                    const ufNewStr = String(args.new_string ?? '');
                    // Only check Python/TS/JS source files
                    if (/\.(py|ts|js)$/.test(ufPath)) {
                        // Find all function calls in new_string that look like internal helpers (_foo, _bar)
                        const calledFns = [...ufNewStr.matchAll(/\b(_\w+)\s*\(/g)].map(m => m[1]);
                        if (calledFns.length > 0) {
                            try {
                                const absUfPath = path.isAbsolute(ufPath) ? ufPath : path.join(this.workspaceRoot, ufPath);
                                const fileContent = fs.existsSync(absUfPath) ? fs.readFileSync(absUfPath, 'utf8') : '';
                                const missing = calledFns.filter(fn => {
                                    // Check if it's defined in the file (def _fn / function _fn / const _fn =)
                                    return !new RegExp(`(?:def|function|const)\\s+${fn}\\s*[\\(=]`).test(fileContent);
                                });
                                if (missing.length > 0) {
                                    const ufMsg = `[BLOCKED: Calling undefined function(s)]\n\nYour edit calls ${missing.map(f => `${f}()`).join(', ')} but ${missing.length === 1 ? 'this function is' : 'these functions are'} not defined in ${path.basename(ufPath)}.\n\nYou must implement ${missing.length === 1 ? 'it' : 'them'} before or in the same edit. Either:\n1. Add the implementation to your edit (include the full function definition in new_string), OR\n2. Make a separate edit_file call to add the implementation first\n\nDo NOT wire up a call to a function that doesn't exist yet.`;
                                    if (isTextMode) {
                                        this.history.push({ role: 'user', content: `[tool:edit_file] ${ufMsg}` });
                                    } else {
                                        this.history.push({ role: 'tool', content: ufMsg });
                                    }
                                    post({ type: 'toolResult', id: toolId, name, success: false, preview: `(blocked — ${missing.join(', ')} not defined)` });
                                    logWarn(`[undef-guard] Blocked call to undefined: ${missing.join(', ')} in ${ufPath}`);
                                    this._guardEvents.push({ type: 'undef-guard', reason: `undefined references: ${missing.join(', ')}`, file: ufPath });
                                    continue;
                                }
                            } catch { /* file read failed — skip guard */ }
                        }
                    }
                }

                // ── Merge-mode stub guard: block edit_file if new_string contains placeholder comments ──
                if (this._mergeMode && name === 'edit_file') {
                    const newStr = String(args.new_string ?? '');
                    const hasStub = /\.\.\.\s*[\[\(]?(full|complete|actual|real|method|implementation|remaining|all other|content here)/i.test(newStr)
                        || /\#\s*\.\.\.\s*(full|complete|actual|real|method|implementation|remaining)/i.test(newStr)
                        || /pass\s*#\s*(placeholder|stub|todo|implement)/i.test(newStr)
                        || /\[full method implementation here\]|\[all other.*methods\]|\[implementation here\]/i.test(newStr)
                        || /\#\s*Implementation from\s+\w+\.py/i.test(newStr)
                        || /\#\s*Additional methods from\s+\w+\.py/i.test(newStr)
                        || /\#\s*(methods?|functions?|classes?|code|logic|content)\s+(from|would be|here|below|above|follows)/i.test(newStr)
                        || (/\bpass\b/.test(newStr) && /\#.*from\s+\w+\.py/i.test(newStr));
                    if (hasStub) {
                        logWarn(`[merge-guard] Blocked stub edit_file — new_string contains placeholder comments`);
                        this._guardEvents.push({ type: 'merge-guard', reason: 'edit_file new_string contains stub/placeholder code', file: String(args.path ?? '') });
                        const stubMsg = `[BLOCKED] Your new_string contains stub/placeholder code like "# Implementation from X.py\\npass" or "# Additional methods would be inserted here" instead of real code.\n\nYou MUST copy the ACTUAL method bodies verbatim from the source file.\n\nStep 1: Run shell_read with: Get-Content '<source_file>' | Out-String\nStep 2: Find the specific method in the output\nStep 3: Copy the ENTIRE method body — every line, verbatim, with correct indentation\nStep 4: Use that copied code as the new_string in edit_file\n\nDo NOT write placeholder comments or pass statements. Do NOT summarize. Copy real code only.`;
                        if (isTextMode) {
                            this.history.push({ role: 'user', content: `[tool:edit_file] ${stubMsg}` });
                        } else {
                            this.history.push({ role: 'tool', content: stubMsg });
                        }
                        post({ type: 'token', text: '' });
                        continue;
                    }
                }

                let toolResult: string;
                try {
                    toolResult = await this.executeTool(name, args, toolId);
                    logInfo(`Tool ${name} OK — ${toolResult.length} chars`);
                    // Auto-fix: if model used `cat` on Windows and got "not recognized" error,
                    // silently retry with Get-Content so the model gets real file content.
                    if (name === 'shell_read'
                        && /is not recognized|Cannot find path|is not a valid/i.test(toolResult)
                        && /^\s*cat\s/i.test(String(args.command ?? ''))) {
                        const catCmd = String(args.command ?? '');
                        // Replace leading `cat ` with `Get-Content `, preserve the path argument
                        const gcCmd = catCmd.replace(/^\s*cat\s+/i, 'Get-Content ');
                        logInfo(`[agent] cat failed on Windows — retrying with Get-Content: ${gcCmd}`);
                        const retryId = `t_gc_${Date.now()}`;
                        post({ type: 'toolCall', id: retryId, name: 'shell_read', args: { command: gcCmd } });
                        try {
                            const gcResult = await this.runShellRead(gcCmd, this.workspaceRoot, retryId);
                            post({ type: 'toolResult', id: retryId, name: 'shell_read', success: true, preview: gcResult.slice(0, 150) });
                            if (gcResult && gcResult.length > toolResult.length) {
                                logInfo(`[agent] Get-Content retry succeeded — ${gcResult.length} chars`);
                                toolResult = gcResult;
                                // Update args so downstream interceptors see the corrected command
                                (args as Record<string, unknown>).command = gcCmd;
                            }
                        } catch (e) {
                            post({ type: 'toolResult', id: retryId, name: 'shell_read', success: false, preview: String(e) });
                        }
                    }
                    // Intercept large file reads when user wants an edit: replace with focused grep
                    // For sweep edit tasks: if Get-Content hit the 16K limit, re-read with a higher cap (32K)
                    // Only applies to edit tasks — read-only analysis queries don't need the full file content
                    if (name === 'shell_read' && isSweepMessage && this._isEditTask && toolResult.length >= 15_900
                        && /Get-Content|cat\s/i.test(String(args.command ?? ''))) {
                        logInfo(`[agent] Sweep task — toolResult hit 16K limit, re-reading with 32K limit`);
                        try {
                            const sweepCmd = String(args.command ?? '');
                            const fuller = await this.runShellRead(sweepCmd, this.workspaceRoot, toolId + '_sweep', 32_000);
                            if (fuller.length > toolResult.length) {
                                toolResult = fuller;
                                logInfo(`[agent] Sweep re-read: ${toolResult.length} chars`);
                            }
                        } catch { /* keep original */ }
                        if (toolResult.length >= 31_900) {
                            toolResult += `\n\n[FILE TRUNCATED] More content follows. After editing routes visible above, call shell_read with: Get-Content "<path>" | Select-Object -Skip 400 to see the rest.`;
                        }
                    }
                    // Detect corrupted files (literal \n in content OR UTF-16 encoding) and warn model.
                    // Fires on any shell_read that returns file content — Get-Content, cat, or Select-String.
                    let fileIsCorrupted = false;
                    if (name === 'shell_read') {
                        const cmdStr = String(args.command ?? '');
                        // UTF-16 detection: every character separated by space (e.g. "f r o m   f l a s k")
                        // This pattern looks for 4+ consecutive single-char tokens separated by spaces
                        const isUtf16Wide = /(?:\b\w\b ?){6,}/.test(toolResult.split('\n')[0] ?? '');
                        if (/\\n[ \t]+\w/.test(toolResult) || isUtf16Wide) {
                            fileIsCorrupted = true;
                            // Extract path from common command patterns
                            const corruptPath =
                                cmdStr.match(/Get-Content\s+(?:-Raw\s+)?['"]?([^\s'"]+)['"]?/i)?.[1] ??
                                cmdStr.match(/cat\s+['"]?([^\s'"]+)['"]?/i)?.[1] ??
                                cmdStr.match(/['"]([^'"]+\.\w+)['"]/)?.[1] ??
                                'the file';
                            const corruptType = isUtf16Wide
                                ? 'UTF-16 encoded (each character has a null byte, showing as "f r o m   f l a s k"). edit_file cannot match strings in UTF-16 files.'
                                : 'contains literal \\n characters instead of real newlines';
                            toolResult += `\n\n[SYSTEM WARNING] This file is CORRUPTED — it is ${corruptType}.\n\nYou MUST rewrite it using edit_file with force_overwrite=true:\n  path: "${corruptPath}"\n  old_string: ""\n  new_string: <the full correctly-formatted file content>\n  force_overwrite: true\n\nDo NOT attempt any other edit_file calls on this file — they will all fail until it is rewritten as proper UTF-8.`;
                        }
                    }
                    // Detect stub/placeholder HTML files: suspiciously small HTML that lacks the
                    // standard markers of a real template. These are often agent-created placeholders
                    // from a previous session. Warn the model not to edit them as if they were real.
                    if (!fileIsCorrupted && name === 'shell_read') {
                        const stubCmdStr = String(args.command ?? '');
                        const isHtmlRead = /Get-Content|cat\s/i.test(stubCmdStr) && /\.html['"]/i.test(stubCmdStr);
                        if (isHtmlRead) {
                            const lineCount = toolResult.split('\n').length;
                            const hasRealHtmlMarkers = /<!DOCTYPE|<html|{%\s*extends|{%\s*block/i.test(toolResult);
                            if (lineCount < 15 && !hasRealHtmlMarkers) {
                                const wsRootStub = this.workspaceRoot.replace(/\\/g, '/');
                                // Auto-search: extract keywords from the stub content to find the real file
                                const stubKeywords = toolResult
                                    .match(/\{\{\s*form\.(\w+)\s*[\.(]|id=["']([^"']+)["']|name=["']([^"']+)["']/g)
                                    ?.map(m => m.match(/form\.(\w+)|id=["']([^"']+)["']|name=["']([^"']+)["']/)?.[1] ?? m.match(/form\.(\w+)|id=["']([^"']+)["']|name=["']([^"']+)["']/)?.[2] ?? '')
                                    .filter(k => k.length > 3)
                                    .slice(0, 3) ?? [];
                                const searchPattern = stubKeywords.length > 0 ? stubKeywords[0] : path.basename(stubCmdStr.match(/['"](.*?)['"]/)?.[1] ?? '').replace(/\.\w+$/, '');
                                let realFileHint = '';
                                if (searchPattern) {
                                    try {
                                        const envStub2 = detectShellEnvironment();
                                        const realSearchCmd = envStub2.os === 'windows'
                                            ? `Get-ChildItem -Path '${wsRootStub}/app/templates' -Recurse -Include '*.html' | Where-Object { $_.FullName -notmatch '__pycache__' } | Select-String -Pattern '${searchPattern}' | Select-Object Path,LineNumber,Line | Select-Object -First 10`
                                            : `grep -rn '${searchPattern}' '${wsRootStub}/app/templates' --include='*.html' | head -10`;
                                        const realSearchId = `t_stubsearch_${Date.now()}`;
                                        post({ type: 'toolCall', id: realSearchId, name: 'shell_read', args: { command: realSearchCmd } });
                                        const realSearchResult = await this.runShellRead(realSearchCmd, this.workspaceRoot, realSearchId);
                                        post({ type: 'toolResult', id: realSearchId, name: 'shell_read', success: true, preview: realSearchResult.slice(0, 200) });
                                        if (realSearchResult.trim()) {
                                            realFileHint = `\n\nAuto-search found these real templates containing "${searchPattern}":\n${realSearchResult.slice(0, 1000)}\n\nRead the most relevant file above and edit it instead.`;
                                        }
                                    } catch { /* ignore */ }
                                }
                                toolResult += `\n\n[SYSTEM WARNING] This file is a STUB — it has only ${lineCount} lines and no real HTML structure. It was created as a placeholder and does NOT contain the real feature implementation. Do NOT edit this stub.${realFileHint}`;
                            }
                        }
                    }

                    // When the task is about adding a field to a form/template and the model just read
                    // a Python model file, nudge it to search the templates next rather than exploring
                    // the model file further (error patterns, etc.).
                    if (!fileIsCorrupted && name === 'shell_read') {
                        const formTaskHint = /\b(form|template|inline|frontend|html)\b/i.test(this._currentTaskMessage)
                            && /\b(add|insert|append)\b/i.test(this._currentTaskMessage)
                            && /Get-Content|cat\s/i.test(String(args.command ?? ''))
                            && /models[/\\].*\.py['"]/i.test(String(args.command ?? ''));
                        if (formTaskHint) {
                            const wsRootForm = this.workspaceRoot.replace(/\\/g, '/');
                            toolResult += `\n\n[NEXT STEP] You've confirmed the model schema. Now find the HTML form. Search templates:\nshell_read: Get-ChildItem -Path '${wsRootForm}/app/templates' -Recurse -Include '*.html' | Select-Object FullName\nThen search for where the inline form renders this input, and look for the JS submit handler that sends this data.`;
                        }
                    }

                    if (!fileIsCorrupted && name === 'shell_read' && toolResult.length > 3000
                        && !this._mergeMode
                        && /Get-Content|cat\s/i.test(String(args.command ?? ''))
                        && /\b(apply|implement|update|edit|modify|fix|refactor|improve|change|add|append|write|replace)\b/i.test(this._currentTaskMessage)
                        && !/\b(create|new file|new route|scaffold|suggest|calculate|review|analyse|analyze|look for|find|check|how|what|which|show me|tell me)\b/i.test(this._currentTaskMessage)
                        && !isSweepMessage
                        && !this._isEditTask
                        && !isReviewTask
                        && !isPlanTask
                        && !isCreativeTask) {
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
                        // Normalize whitespace before hashing so whitespace-variant retries still count
                        const rawOldStr = String(args.old_string ?? '');
                        const normalizedOld = rawOldStr.split('\n').map(l => l.trim()).join('\n').slice(0, 240);
                        const editSig = `${String(args.path ?? '')}::${normalizedOld}`;
                        const editFailCount = (this._failedEditSignatures.get(editSig) ?? 0) + 1;
                        this._failedEditSignatures.set(editSig, editFailCount);
                        if (editFailCount >= this.MAX_SAME_EDIT_FAILURES) {
                            const sweepHint = this._isSweepTask
                                ? ` This is a sweep task — some blocks you are trying to edit may ALREADY have been updated in a previous turn. Use shell_read with Select-String to find lines that are STILL missing the change (e.g. "Select-String -NotMatch 'logger.error'" or search for the original text), rather than retrying blocks you may have already edited.`
                                : '';
                            const editHint = `You have tried to edit "${args.path}" with the same old_string ${editFailCount} times and it keeps failing. STOP using edit_file on this file.\n\nUse shell_read to read the ENTIRE file first: Get-Content '${args.path}'\n\nIf line 8 (or any line) contains literal \\n characters like "def foo():\\n    data = ...", the file is CORRUPTED — edit_file cannot fix it because old_string with real newlines will never match a line containing literal \\n text.\n\nFor a corrupted file, you MUST use edit_file with old_string set to the ENTIRE current single-line content (copy it exactly, literal \\n and all) and new_string containing the correct multi-line version.\n\nDo NOT use run_command or Set-Content — newlines get escaped in transit and the here-string terminator will never be found. edit_file is the only tool that can write real newlines.${sweepHint}`;
                            logWarn(`[agent] edit_file same-signature failure ${editFailCount}x on "${args.path}" — forcing re-read`);
                            if (isTextMode) {
                                this.history.push({ role: 'user', content: `Tool ${name} returned:\n${toolResult}\n---\n[SYSTEM: ${editHint}]` });
                            } else {
                                this.history.push({ role: 'tool', content: `${toolResult}\n\n${editHint}` });
                            }
                            this.consecutiveFailures = 0;
                            continue; // Give model a chance to re-read, but stop the grep recovery below
                        }
                    }

                    // On edit_file "old_string not found" failure: read the exact line range reported
                    // in the error ("First line found at line N") and inject with line numbers so the
                    // model can construct a precise old_string with correct indentation.
                    // Skip if focused grep was already injected this turn (auto-read pipeline already ran).
                    // In merge mode, "matches N locations" means the old_string is ambiguous — skip grep recovery
                    // and immediately inject the file tail so the model can append unambiguously.
                    if (name === 'edit_file' && this._mergeMode && /matches \d+ locations/i.test(toolResult)) {
                        const failedPath = String(args.path ?? '');
                        const absFailPath = path.isAbsolute(failedPath) ? failedPath : path.join(this.workspaceRoot, failedPath.replace(/\//g, path.sep));
                        const envFail = detectShellEnvironment();
                        let tailNote = '';
                        try {
                            const tailCmd = envFail.os === 'windows'
                                ? `$lines = Get-Content "${absFailPath}"; $total = $lines.Count; $start = [Math]::Max(0,$total-20); $lines[$start..($total-1)] | ForEach-Object -Begin {$n=$start+1} -Process { "{0:D4}: {1}" -f $n,$_; $n++ }`
                                : `awk 'END{s=NR-20; if(s<1)s=1} NR>=s{printf "%04d: %s\\n", NR, $0}' "${absFailPath}"`;
                            const tailContent = await this.runShellRead(tailCmd, this.workspaceRoot, `t_tail_ambig_${Date.now()}`);
                            if (tailContent.trim()) {
                                tailNote = `\n\n[LAST 20 LINES OF FILE]\n${tailContent}\nThe NNNN: prefix is NOT part of the file. Use the last non-blank line as old_string and append your new methods after it.`;
                            }
                        } catch { /* ignore */ }
                        const absFailPathFwd = absFailPath.replace(/\\/g, '/');
                        const ambigMsg = `[BLOCKED] Your old_string matches multiple locations — edit_file cannot be used here.\n\nTo append to the END of the file, use run_command with Add-Content instead:\n\n  run_command: Add-Content -Path '${absFailPathFwd}' -Value @'\n<your new function code here>\n'@\n\nDo NOT use edit_file again for this append. Use Add-Content with a here-string to write the new function to the end of the file.${tailNote}`;
                        if (isTextMode) {
                            this.history.push({ role: 'user', content: `Tool ${name} returned:\n${toolResult}\n---\n[SYSTEM: ${ambigMsg}]` });
                        } else {
                            this.history.push({ role: 'tool', content: `${toolResult}\n\n${ambigMsg}` });
                        }
                        this._mergeConsecutiveEditFailures = (this._mergeConsecutiveEditFailures ?? 0) + 1;
                        this.consecutiveFailures = 0;
                        continue;
                    }

                    if (name === 'edit_file' && /old_string not found|matches \d+ locations/i.test(toolResult) && !this._focusedGrepInjectedThisTurn
                        && !String(args.path ?? '').endsWith('.ollamapilot-plan.md')) {
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
                                // No line number in error — read the full file with Get-Content so the model
                                // gets exact raw bytes (no Select-String prefix mangling, no encoding issues).
                                // This is critical for files with non-ASCII or corrupted bytes in strings.
                                grepFailCmd = envFail.os === 'windows'
                                    ? `Get-Content "${absFailPath}"`
                                    : `cat "${absFailPath}"`;
                                logInfo(`[agent] edit_file old_string failed (no line hint) — injecting full file for exact byte matching`);
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

                                // In merge mode: also inject the tail of the file so the model can append
                                let tailNote = '';
                                if (this._mergeMode) {
                                    try {
                                        const tailCmd = envFail.os === 'windows'
                                            ? `$lines = Get-Content "${absFailPath}"; $total = $lines.Count; $start = [Math]::Max(0,$total-20); $lines[$start..($total-1)] | ForEach-Object -Begin {$n=$start+1} -Process { "{0:D4}: {1}" -f $n,$_; $n++ }`
                                            : `awk 'END{s=NR-20; if(s<1)s=1} NR>=s{printf "%04d: %s\\n", NR, $0}' "${absFailPath}"`;
                                        const tailContent = await this.runShellRead(tailCmd, this.workspaceRoot, `t_tail_${Date.now()}`);
                                        if (tailContent.trim()) {
                                            tailNote = `\n\n[LAST 20 LINES OF FILE for appending]\n${tailContent}\nTo append new methods, use old_string=the last non-blank line above (NNNN: prefix excluded), new_string=that same line + newlines + new methods.`;
                                        }
                                    } catch { /* ignore */ }
                                }

                                const injectMsg = `[FILE CONTENT: ${relFailPath} lines ~${lineNum > 0 ? lineNum - 3 : '?'}-${lineNum > 0 ? lineNum + 16 : '?'}]\n${failGrepClean}\n\n${lineNote} ${failReason} Copy the EXACT content (preserving all leading spaces) into old_string and retry edit_file with path="${relFailPath}". If the content is already correct, say so and stop.${tailNote}`;
                                if (isTextMode) {
                                    this.history.push({ role: 'user', content: `Tool ${name} returned:\n${toolResult}\n---\n${injectMsg}` });
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
                            if (this._mergeMode && /\bAdd-Content\b/i.test(cmdStr)) {
                                this._mergeConsecutiveEditFailures = (this._mergeConsecutiveEditFailures ?? 0) + 1;
                                nudge = `Add-Content failed (exit 1). The here-string likely has quoting issues. Try wrapping the content differently, or use a temp file approach. Do NOT delete the source file yet — the content was NOT appended.`;
                            } else {
                                nudge = `The command failed. Use shell_read to check what files/directories actually exist before retrying.`;
                            }
                        } else if (isMoveCmd) {
                            nudge = 'Files moved. If there are MORE files to move, batch them in ONE run_command call. Do NOT stop until ALL files are moved.';
                        } else if (isMkdirCmd) {
                            nudge = 'Directories created. Now move the files into them. Batch ALL moves into as few run_command calls as possible.';
                        } else if (this._mergeMode && /\bAdd-Content\b/i.test(cmdStr) && !hasFailed) {
                            // Successful Add-Content in merge mode counts as a merge
                            this._mergeEditedSinceLastDelete = true;
                            this._mergeConsecutiveEditFailures = 0;
                            this._mergeFileReadCounts.clear();
                            nudge = 'Content appended successfully. Now delete the redundant file with run_command Remove-Item.';
                        } else if (this._mergeMode && /\bRemove-Item\b|\brm\s+|\bdel\s+|\bdelete\s+/i.test(cmdStr)) {
                            // After a successful delete in merge mode, reset state and tell the model to advance
                            this._mergeEditedSinceLastDelete = false;
                            this._mergeConsecutiveEditFailures = 0;
                            this._mergeFileReadCounts.clear();
                            nudge = 'File deleted successfully. Move on to the NEXT cluster or file pair to merge. Do NOT re-read files you already handled. Read the NEXT source file to identify unique methods, then append them to the surviving file and delete it.';
                        } else {
                            nudge = 'Command completed. Continue with the next step.';
                        }
                    } else if (name === 'edit_file') {
                        const editFailed = toolResult.toLowerCase().includes('not found') || toolResult.toLowerCase().includes('error') || toolResult.toLowerCase().includes('failed');
                        if (this._mergeMode) {
                            if (!editFailed) {
                                this._mergeEditedSinceLastDelete = true;
                                this._mergeConsecutiveEditFailures = 0;
                                this._mergeFileReadCounts.clear();
                                nudge = 'Edit succeeded. Now delete the redundant file with run_command Remove-Item.';
                            } else {
                                this._mergeConsecutiveEditFailures = (this._mergeConsecutiveEditFailures ?? 0) + 1;
                                if (this._mergeConsecutiveEditFailures >= 2) {
                                    nudge = 'The edit_file has failed multiple times. The file is likely too large to match exactly. Instead, use edit_file with old_string set to the LAST LINE of the file (read it first to get the exact last line), and new_string set to that same last line PLUS the new methods you want to append. This appends to the end of the file reliably.';
                                } else {
                                    nudge = 'The edit_file FAILED — old_string did not match exactly. Re-read the file with shell_read to get the exact text including whitespace, then retry. Do NOT delete the file until the edit succeeds.';
                                }
                            }
                        } else if (!editFailed) {
                            const editedPath = String(args.path ?? args.file_path ?? '');
                            if (editedPath && editedPath === this._lastEditedFilePath) {
                                // Consecutive edit to the same file — require re-read first
                                nudge = `Edit succeeded. Before making another edit to this file, you MUST re-read it first: use shell_read with Get-Content on "${editedPath}" to see the current state. Your mental model of the file may be out of date after the last edit.`;
                            } else {
                                this._lastEditedFilePath = editedPath;
                                nudge = 'Edit applied. Check for other issues in the same file (e.g. similar bugs, related functions that need the same fix). If you see another issue, call edit_file again. If the task is complete, say so.';
                            }
                        } else {
                            nudge = 'The edit_file FAILED — old_string did not match. Re-read the file with shell_read to get the exact current content, then retry with the correct old_string.';
                        }
                    } else if (name === 'shell_read') {
                        const lastUserMsg = this._currentTaskMessage.toLowerCase();
                        const wantsPathUpdate = /\b(point|location|path|import|reference|reorganiz|moved|new folder|new director)\b/i.test(lastUserMsg)
                            && /\b(edit|update|change|fix|modify|point|adjust|rewrite)\b/i.test(lastUserMsg);
                        const wantsAction = /\b(move|rename|reorganize|restructure|migrate|run|execute|do\s+(it|them|that|those|this|the)|go\s+ahead|make\s+it|mkdir|delete|remove|copy)\b/.test(lastUserMsg)
                            || (/\b(implement|apply)\b/.test(lastUserMsg) && /\b(organiz|restructur|folder|director|migrat|move|layout|recommend)/.test(lastUserMsg));
                        const wantsEdit = /\b(apply|implement|rewrite|update|edit|modify|fix|refactor|improve|change|add|append|write|create|replace|overhaul|rework|redo|revise|optimize|clean\s*up)\b/.test(lastUserMsg)
                            && !/\b(create|new file|new route|scaffold)\b/i.test(lastUserMsg);
                        // Detect PowerShell/shell errors that mean the path doesn't exist
                        const isShellError = /Cannot find path|does not exist|ItemNotFoundException|PathNotFound|No such file|not recognized as|is not recognized/i.test(toolResult);
                        // Detect empty file searches: explicit "not found" messages OR PowerShell
                        // table with only header/dashes and no actual file paths
                        const isEmptyFileSearch = /\b(dir|where|find|Get-ChildItem|ls)\b/i.test(String(args.command ?? ''))
                            && (/File Not Found|not found|No matches|0 File|no such file/i.test(toolResult)
                                || toolResult.trim() === ''
                                || isShellError
                                || /^[\s\r\n]*(FullName|Name|Path)[\s\r\n]*-+[\s\r\n]*(searched in:|$)/im.test(toolResult));
                        // Detect empty Select-String / grep results — model may hallucinate answers when search returns nothing
                        const isEmptySearch = !isShellError && toolResult.trim() === ''
                            && /\b(Select-String|grep)\b/i.test(String(args.command ?? ''));
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
                            const cleanPaths = contentLines.filter(l => !/__pycache__|\.pyc$|htmlcov/.test(l));
                            // Extract the filename the user mentioned (e.g. "fleet.py" from "in fleet.py")
                            const mentionedFile = (lastUserMsg.match(/\b([\w.-]+\.py)\b/i) ?? [])[1]?.toLowerCase() ?? '';
                            // Prefer: path whose parent folder matches the mentioned filename (e.g. fleet/fleet.py)
                            const stem = mentionedFile.replace(/\.py$/i, '');
                            const relevantPath = cleanPaths.find(l => new RegExp(`[/\\\\]${stem}[/\\\\]${stem}\\.py$`, 'i').test(l))
                                ?? cleanPaths.find(l => /service/i.test(l) && /\.py$/i.test(l))
                                ?? cleanPaths.find(l => /\.py$/i.test(l))
                                ?? cleanPaths[0]
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
                            const autoReadId = `t_autoread_${Date.now()}`;
                            let fileContent = '';
                            let usedFullRead = false;
                            // Sweep tasks need the full file — skip focused grep entirely
                            if (isSweepMessage) {
                                logInfo(`[agent] Sweep task auto-read — using full file read: ${catCmd}`);
                                post({ type: 'toolCall', id: autoReadId, name: 'shell_read', args: { command: catCmd } });
                                try {
                                    fileContent = await this.runShellRead(catCmd, this.workspaceRoot, autoReadId, 32_000);
                                    post({ type: 'toolResult', id: autoReadId, name: 'shell_read', success: true, preview: fileContent.slice(0, 150) });
                                    usedFullRead = true;
                                } catch (e) {
                                    post({ type: 'toolResult', id: autoReadId, name: 'shell_read', success: false, preview: String(e) });
                                }
                            } else {
                            logInfo(`[agent] Auto-reading file (focused grep) after path search: ${grepCmd}`);
                            post({ type: 'toolCall', id: autoReadId, name: 'shell_read', args: { command: grepCmd } });
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
                            } // end non-sweep branch
                            if (fileContent && fileContent.length > 100) {
                                const relPath = path.relative(this.workspaceRoot, relevantPath.replace(/\//g, path.sep)).replace(/\\/g, '/');
                                const readNote = usedFullRead
                                    ? 'The FULL file content is shown above.'
                                    : 'Relevant sections of the file are shown above (lines matching the task keywords + context).';
                                // Strip PowerShell "> " prefixes and cap at 2000 chars
                                let fileContentClean = usedFullRead ? fileContent : stripSelectStringPrefixes(fileContent);
                                // For full reads, add line numbers so model can use edit_file_at_line
                                if (usedFullRead) {
                                    const numbered = fileContentClean.split('\n')
                                        .map((l, i) => `${String(i + 1).padStart(4, ' ')}: ${l}`)
                                        .join('\n');
                                    fileContentClean = numbered;
                                }
                                // Sweep tasks get a larger window but not unbounded
                                const truncLimit = isSweepMessage ? 16000 : 8000;
                                const fileContentTrunc = fileContentClean.length > truncLimit ? fileContentClean.slice(0, truncLimit) + '\n...(truncated)' : fileContentClean;
                                const planPath = relPath.replace(/[^/]+$/, '.ollamapilot-plan.md');
                                const editInstruction = usedFullRead && isSweepMessage
                                    ? `[SWEEP TASK]\nReview every function/route in the file above. For each one MISSING the requested change, call edit_file with:\n- path="${relPath}"\n- old_string: the EXACT current function body copied verbatim from the file above\n- new_string: the updated function body with the change applied\nDo NOT use edit_file_at_line — line numbers shift after each edit and will cause corruption. Use edit_file with exact string matching only. Edit one function per call, then continue to the next.`
                                    : usedFullRead
                                    ? `Use edit_file with path="${relPath}" and EXACT strings copied from the content above.`
                                    : `Use edit_file with path="${relPath}" and EXACT strings copied from the content above.`;
                                nudge = `[AUTO-READ: ${relPath}]\n${fileContentTrunc}\n\n${readNote} ${editInstruction} Do NOT use absolute paths. Do NOT search again. If the change is ALREADY present in the file, say so and stop.`;
                                this._focusedGrepInjectedThisTurn = true;
                                this._filesAutoReadThisRun.add(relevantPath);
                            } else {
                                nudge = `You found the file path. Now READ the file content before editing. Call shell_read with: ${catCmd}`;
                            }
                            } // close the else-block for "not already auto-read"
                        } else if (/Get-Content|cat\s/i.test(String(args.command ?? ''))
                            && (isShellError || (toolResult.length < 300 && !/def |class |import |#/.test(toolResult)))) {
                            // Get-Content failed (path not found) OR returned too little to be real source code.
                            // Auto-recover: search for the file by name recursively.
                            const cmdStr = String(args.command ?? '');
                            // Match any file extension, not just .py
                            const fileNameMatch = cmdStr.match(/['\"]([^'"]*?([^'/\\]+\.\w+))['"]/i);
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
                                const pathLines = searchResult.split('\n').map(l => l.trim()).filter(l => /\.\w+$/.test(l) && isAbsPath(l));
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
                                    // File not found by exact name.
                                    // If the user explicitly named this file in their task, they want it CREATED.
                                    // Otherwise, tell the agent to search for the feature in existing files.
                                    const taskMsg = this._currentTaskMessage;
                                    const userNamedThisFile = fileName && (
                                        taskMsg.includes(fileName) ||
                                        // also match path fragments like "app/routes/customers.py"
                                        (fileNameMatch?.[1] && taskMsg.replace(/\\/g, '/').includes(fileNameMatch[1].replace(/\\/g, '/')))
                                    );
                                    if (userNamedThisFile && /\.py|\.ts|\.js/.test(fileName)) {
                                        // User wants to create this file — guide the model to use edit_file with old_string=""
                                        const relFromCmd = fileNameMatch?.[1]?.replace(/\\/g, '/') ?? fileName;
                                        nudge = `[NEW FILE] "${relFromCmd}" does not exist yet — you need to CREATE it.\n\nUse edit_file with:\n- path="${relFromCmd}"\n- old_string="" (empty string — this creates a new file)\n- new_string=<complete file content>\n\nWrite a complete Python module with the proper Flask Blueprint setup and the requested route. Use a sibling file from the same directory as a template for imports and structure.`;
                                    } else {
                                        const wsRoot3 = this.workspaceRoot.replace(/\\/g, '/');
                                        const env3b = detectShellEnvironment();
                                        const broadSearchCmd = env3b.os === 'windows'
                                            ? `Get-ChildItem -Path '${wsRoot3}' -Recurse -Include '*.html','*.py','*.ts','*.js' | Where-Object { $_.FullName -notmatch '__pycache__|htmlcov' } | Select-Object FullName | Select-Object -First 30`
                                            : `find '${wsRoot3}' -type f \\( -name '*.html' -o -name '*.py' \\) -not -path '*__pycache__*' | head -30`;
                                        nudge = `[FILE NOT FOUND] "${fileName}" does not exist at that path and was not found anywhere in the project.\n\nDo NOT create this file. The feature you are looking for is likely implemented inline in an existing file.\n\nSearch for it by content — run this to list all templates and routes:\n${broadSearchCmd}\n\nThen look for the form/section that handles this feature inside those existing files using Select-String.`;
                                    }
                                }
                            } else {
                                nudge = `The file you tried to read returned almost no content (${toolResult.length} chars) — it may be at the wrong path. Use shell_read with Get-ChildItem -Recurse -Filter to find the correct absolute path first.`;
                            }
                        } else if (wantsEdit && !isReviewTask && !isPlanTask && /Get-Content|cat\s/i.test(String(args.command ?? '')) && toolResult.length > 2000 && !isSweepMessage) {
                            // Model read a large file — extract focused section to help it find the right old_string.
                            // (Skipped for sweep tasks — they need the full numbered file content)
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
                        } else if (isEmptySearch) {
                            // Select-String / grep returned nothing — force the model to try a broader search
                            // rather than hallucinating an answer from training data.
                            const emptyCmd = String(args.command ?? '');
                            const patternMatch = emptyCmd.match(/-Pattern\s+['"]([^'"]+)['"]/i) ?? emptyCmd.match(/grep\s+['""]?([^\s'"]+)/i);
                            const pattern = patternMatch?.[1] ?? '';
                            const wsRoot = this.workspaceRoot.replace(/\\/g, '/');
                            const broadenHint = process.platform === 'win32'
                                ? `Get-ChildItem -Path '${wsRoot}' -Recurse -Filter '*.html' | Select-String -Pattern '${pattern || 'customer'}' | Select-Object Path,LineNumber,Line | Select-Object -First 20`
                                : `grep -rn "${pattern || 'customer'}" "${wsRoot}" --include="*.html" | head -20`;
                            nudge = `[SEARCH RETURNED NO RESULTS] The pattern was not found with that command. Do NOT guess or invent file paths — the search found nothing.\n\nTry a broader search:\nshell_read with: ${broadenHint}\n\nIf that also returns nothing, tell the user the feature was not found rather than fabricating an answer.`;
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
                    // In merge mode, cap large shell_read results to prevent context overflow.
                    // Reading both files in a cluster can easily consume 20k+ tokens, leaving
                    // too little room for the model to reason and output a full edit_file call.
                    let toolResultForHistory = toolResult;
                    if (this._mergeMode && name === 'shell_read' && toolResult.length > 6000) {
                        const lines = toolResult.split('\n');
                        const MAX_LINES = 120;
                        if (lines.length > MAX_LINES) {
                            const kept = lines.slice(0, MAX_LINES).join('\n');
                            toolResultForHistory = kept + `\n\n[TRUNCATED — file has ${lines.length} lines, showing first ${MAX_LINES}. Use Get-Content -Tail N or Select-String to read specific sections if needed.]`;
                            logInfo(`[merge-guard] Truncated shell_read result from ${lines.length} to ${MAX_LINES} lines to preserve context`);
                        }
                    }
                    this.history.push({
                        role: 'user',
                        content: `Tool ${name} returned:\n${toolResultForHistory}\n---\n${nudge}${deferredReminder}`,
                    });
                } else {
                    // In merge mode, also cap large results in native tool mode
                    let toolResultForHistory = toolResult;
                    if (this._mergeMode && name === 'shell_read' && toolResult.length > 6000) {
                        const lines = toolResult.split('\n');
                        const MAX_LINES = 120;
                        if (lines.length > MAX_LINES) {
                            const kept = lines.slice(0, MAX_LINES).join('\n');
                            toolResultForHistory = kept + `\n\n[TRUNCATED — file has ${lines.length} lines, showing first ${MAX_LINES}.]`;
                        }
                    }
                    this.history.push({ role: 'tool', content: toolResultForHistory });
                }
            }
            // Update routing hint for next turn: was this turn purely read-only?
            prevTurnWasReadOnly = allReadOnly && READ_ONLY_TOOLS.has(callsToExecute[0]?.function?.name ?? '');
        }

        // If we exhausted all turns without the model producing a final answer, tell the user
        if (loopExhausted && !this.stopRef.stop) {
            logWarn(`[agent] Loop exhausted after ${MAX_TURNS} turns without a final response`);
            post({ type: 'error', text: `Agent stopped after ${MAX_TURNS} tool rounds without a final answer. Try rephrasing your request or start a new chat.` });
        }

        // ── Sequential multi-file plan: auto-advance to next step ────────────────
        // If there are pending plan steps and this run completed cleanly, kick off the
        // next step immediately. Capture the last assistant message as step output
        // so the next step can see what was just written.
        if (!this.stopRef.stop && !loopExhausted && this._pendingPlanSteps.length > 0) {
            // Capture the final assistant message as context for the next step
            const lastMsg = [...this.history].reverse().find(m => m.role === 'assistant');
            if (lastMsg) {
                this._lastPlanStepOutput = typeof lastMsg.content === 'string'
                    ? lastMsg.content.slice(0, 600)
                    : '';
            }
            const nextStep = this._pendingPlanSteps[0];
            const remaining = this._pendingPlanSteps.length;
            logInfo(`[multi-plan] Step complete — auto-advancing to next: ${nextStep.relPath} (${remaining} remaining)`);
            post({ type: 'planProgress', step: nextStep, remaining });
            // Enqueue the next run as a microtask so the current call stack unwinds first
            const stepMessage = `Continue multi-file plan — implement ${nextStep.relPath}`;
            const stepModel = getConfig().model;
            setImmediate(() => {
                this.run(stepMessage, stepModel, post).catch(e => {
                    logWarn(`[multi-plan] Step failed: ${toErrorMessage(e)}`);
                });
            });
        } else if (!this.stopRef.stop && !loopExhausted && this._pendingPlanSteps.length === 0 && this._lastPlanStepOutput) {
            // All plan steps done — reset state and notify
            this._lastPlanStepOutput = '';
            post({ type: 'planComplete' });
            logInfo('[multi-plan] All steps complete');
        }
    }

    // ── Critic pass ───────────────────────────────────────────────────────────

    /**
     * Run a lightweight second-pass review of a completed edit.
     * Only fires when routing is enabled AND a distinct critic model is configured.
     * Returns a non-empty string with issues found, or empty string if clean.
     *
     * The critic sees only the diff (removed/added lines), not the whole file,
     * to keep the call fast and focused.
     */
    private async runCriticPass(
        criticModel: string,
        baseModel: string,
        rel: string,
        original: string,
        newContent: string
    ): Promise<string> {
        // Skip if routing is disabled, no critic model configured, or same model as base
        if (criticModel === baseModel) { return ''; }
        try {
            // Build a minimal unified diff (changed lines only, ±3 context lines)
            const origLines = original.split('\n');
            const newLines  = newContent.split('\n');
            const diffLines: string[] = [];
            const windowSize = 3;
            const changed = new Set<number>();
            const maxLen = Math.max(origLines.length, newLines.length);
            for (let i = 0; i < maxLen; i++) {
                if (origLines[i] !== newLines[i]) { changed.add(i); }
            }
            if (changed.size === 0) { return ''; }
            const shown = new Set<number>();
            for (const idx of changed) {
                for (let k = Math.max(0, idx - windowSize); k <= Math.min(maxLen - 1, idx + windowSize); k++) {
                    shown.add(k);
                }
            }
            for (const i of [...shown].sort((a, b) => a - b)) {
                if (i < origLines.length && origLines[i] !== (newLines[i] ?? '')) {
                    diffLines.push(`- ${origLines[i]}`);
                }
                if (i < newLines.length && newLines[i] !== (origLines[i] ?? '')) {
                    diffLines.push(`+ ${newLines[i]}`);
                }
                if (origLines[i] === newLines[i]) {
                    diffLines.push(`  ${origLines[i]}`);
                }
            }
            const diff = diffLines.slice(0, 120).join('\n'); // cap at 120 lines

            const prompt = `You are a code reviewer. A coding agent just edited \`${rel}\`. Review ONLY the diff below for these specific issues:
1. Hallucinated identifiers — variable/function names in added lines (+) that don't exist in the context lines
2. Missing imports — new symbols used that aren't imported
3. Syntax problems — obviously broken syntax in added lines

Diff (- removed, + added, context lines unprefixed):
\`\`\`
${diff}
\`\`\`

If you find real issues, respond with a SHORT bulleted list (max 3 bullets, 1 line each).
If the code looks correct, respond with exactly: OK`;

            let response = '';
            await streamChatRequest(
                criticModel,
                [{ role: 'user', content: prompt }],
                [],
                (token) => { response += token; },
                this.stopRef
            );
            response = response.trim();
            logInfo(`[critic] ${rel}: ${response.slice(0, 100)}`);
            if (response === 'OK' || response.toLowerCase().startsWith('ok')) { return ''; }
            return response;
        } catch (err) {
            logWarn(`[critic] Skipped — ${toErrorMessage(err)}`);
            return '';
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
                    `- Search content: shell_read with ${isWin2 ? 'Get-ChildItem -Recurse -Filter "*.py" | Select-String -Pattern "keyword"' : 'grep -rn "keyword" --include="*.py" .'}\n` +
                    `- Create/overwrite file: run_command with ${isWin2 ? 'Set-Content' : 'cat > file << EOF'}\n` +
                    `- Move/rename: run_command with ${isWin2 ? 'Move-Item old new' : 'mv old new'}\n` +
                    `- Delete: run_command with ${isWin2 ? 'Remove-Item path' : 'rm path'}`;
            }

            // ── edit_file ──────────────────────────────────────────────────
            case 'edit_file': {
                const rel            = String(args.path ?? '');
                const oldString      = String(args.old_string ?? '');
                const newString      = String(args.new_string ?? '');
                const forceOverwrite = Boolean(args.force_overwrite);

                if (!rel)       { throw new Error('path is required'); }

                // Guard: block accidental deletions — new_string empty with non-empty old_string almost
                // always means the model hallucinated a "remove this block" intent. Real deletions are rare.
                if (oldString && !newString.trim()) {
                    throw new Error(`edit_file: new_string is empty — this would delete the matched block entirely. If you intend to delete code, explicitly include a comment explaining why, or use a minimal replacement. If this is a mistake, re-read the file and try again.`);
                }

                const full = this.safePath(root, rel);

                // Validate imports before writing anything
                const importErr = this.validateNewContent(newString);
                if (importErr) { throw new Error(importErr); }

                // Force-overwrite mode: used for corrupted files that cannot be edited normally.
                // Skips old_string matching and whole-file-rewrite guards.
                if (forceOverwrite) {
                    if (!newString.trim()) {
                        throw new Error('edit_file: new_string is empty. Provide the full corrected file content.');
                    }
                    const originalForOverwrite = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
                    const isAutoApprovedOvr = this._autoApprovedTools.has('edit_file');
                    if (!isAutoApprovedOvr) {
                        await this.diffViewManager.showDiffPreview(full, originalForOverwrite, newString);
                    }
                    const acceptedOvr = await this.requestConfirmation('edit', `Overwrite "${rel}" entirely (force_overwrite)`, 'edit_file');
                    if (!isAutoApprovedOvr) { this.diffViewManager.closeDiffPreview(); }
                    if (!acceptedOvr) { return 'Edit cancelled by user.'; }
                    fs.mkdirSync(path.dirname(full), { recursive: true });
                    fs.writeFileSync(full, newString, 'utf8');
                    this._lastFileOp = { path: rel, originalContent: originalForOverwrite, action: 'edited' };
                    this._editsThisRun++;
                    this.postFn({ type: 'fileChanged', path: rel, action: 'edited' });
                    if (!this._filesChangedThisRun.includes(rel)) { this._filesChangedThisRun.push(rel); }
                    return `Overwrote: ${rel} (${newString.split('\n').length} lines written, corrupted file fixed)`;
                }

                // Auto-create: if old_string is empty and the file doesn't exist (or is empty), write it
                if (!oldString) {
                    const isEmpty = !fs.existsSync(full) || fs.statSync(full).size === 0;
                    if (isEmpty) {
                        fs.mkdirSync(path.dirname(full), { recursive: true });
                        fs.writeFileSync(full, newString, 'utf8');
                        return `Created new file: ${rel} (${newString.split('\n').length} lines)`;
                    }
                    throw new Error(`File "${rel}" already exists. Use get_file to read it first, then call edit_file with old_string set to the exact text you want to replace. To completely replace the file (e.g. full HTML template rewrite), use force_overwrite=true with old_string="" and new_string=<full new content>.`);
                }

                // Guard: if the file doesn't exist, give a clear actionable error instead of a raw ENOENT.
                // This prevents the agent from falling back to New-Item/Set-Content to "create" a file
                // that should already exist — the real problem is it has the wrong path.
                // Exception: if the user explicitly named this file in their task, allow creation via old_string="".
                if (!fs.existsSync(full)) {
                    const taskMsg4 = this._currentTaskMessage;
                    const fileName4 = path.basename(rel);
                    const userNamedThisFile4 = taskMsg4.replace(/\\/g, '/').includes(rel.replace(/\\/g, '/'))
                        || taskMsg4.includes(fileName4);
                    if (userNamedThisFile4) {
                        throw new Error(`edit_file: "${rel}" does not exist yet. To CREATE a new file, call edit_file with old_string="" (empty string) and new_string=<complete file content>. Do not use New-Item or Set-Content.`);
                    }
                    const wsRoot4 = this.workspaceRoot.replace(/\\/g, '/');
                    const env4 = detectShellEnvironment();
                    const searchCmd4 = env4.os === 'windows'
                        ? `Get-ChildItem -Path '${wsRoot4}' -Recurse -Filter '${fileName4}' | Where-Object { $_.FullName -notmatch '__pycache__|htmlcov' } | Select-Object FullName`
                        : `find '${wsRoot4}' -name '${fileName4}' -not -path '*__pycache__*'`;
                    throw new Error(`edit_file: "${rel}" does not exist on disk. Do NOT create it — the file you want to edit is at a different path.\n\nSearch for it: shell_read with command="${searchCmd4}"\n\nThen re-read the correct file and retry edit_file with the actual path.`);
                }

                // Guard: block edits to stub HTML files — they have no real HTML structure
                // and were created as agent placeholders. Editing them is never the right action.
                if (/\.html$/i.test(rel) && fs.existsSync(full)) {
                    const stubCheck = fs.readFileSync(full, 'utf8');
                    const stubLineCount = stubCheck.split('\n').length;
                    const hasRealHtmlMarkers = /<!DOCTYPE|<html|{%\s*extends|{%\s*block/i.test(stubCheck);
                    if (stubLineCount < 15 && !hasRealHtmlMarkers) {
                        const wsRootStub2 = this.workspaceRoot.replace(/\\/g, '/');
                        const fileName6 = path.basename(rel);
                        const envStub3 = detectShellEnvironment();
                        // Extract a keyword from the stub to find the real file
                        const stubKw = stubCheck.match(/\{\{\s*form\.(\w+)|id=["'](\w+)["']|name=["'](\w+)["']/)?.[1] ?? fileName6.replace(/\.\w+$/, '');
                        const realSearchCmd2 = envStub3.os === 'windows'
                            ? `Get-ChildItem -Path '${wsRootStub2}/app/templates' -Recurse -Include '*.html' | Where-Object { $_.FullName -notmatch '__pycache__' } | Select-String -Pattern '${stubKw}' | Select-Object Path,LineNumber,Line | Select-Object -First 10`
                            : `grep -rn '${stubKw}' '${wsRootStub2}/app/templates' --include='*.html' | head -10`;
                        throw new Error(`edit_file: BLOCKED — "${rel}" is a stub file (${stubLineCount} lines, no HTML structure). It is a placeholder, not the real template.\n\nDo NOT edit this stub. Find the real template:\nshell_read with command="${realSearchCmd2}"\n\nThen edit the real file instead.`);
                    }
                }

                // Read file, auto-converting UTF-16 LE/BE to UTF-8 if BOM is detected.
                // PowerShell Get-Content transparently decodes UTF-16, so the model sees clean text,
                // but a raw utf8 readFileSync returns garbage. Detect and convert here so old_string matching works.
                let original: string;
                {
                    const rawBuf = fs.readFileSync(full);
                    if (rawBuf[0] === 0xFF && rawBuf[1] === 0xFE) {
                        // UTF-16 LE BOM — convert to UTF-8
                        original = rawBuf.toString('utf16le').replace(/^\uFEFF/, '');
                        logInfo(`[edit_file] Detected UTF-16 LE file, converting to UTF-8: ${rel}`);
                        // Auto-fix: rewrite the file as UTF-8 so future edits work normally
                        fs.writeFileSync(full, original, 'utf8');
                        logInfo(`[edit_file] Rewrote ${rel} as UTF-8`);
                    } else if (rawBuf[0] === 0xFE && rawBuf[1] === 0xFF) {
                        // UTF-16 BE BOM
                        original = rawBuf.swap16().toString('utf16le').replace(/^\uFEFF/, '');
                        logInfo(`[edit_file] Detected UTF-16 BE file, converting to UTF-8: ${rel}`);
                        fs.writeFileSync(full, original, 'utf8');
                    } else {
                        original = rawBuf.toString('utf8');
                    }
                }

                // Guard: block whole-file rewrites disguised as edit_file.
                // If new_string is much larger than old_string AND the resulting file would be
                // roughly the same size as the original (i.e. old content was replaced, not inserted),
                // the model is hallucinating the file contents rather than making a targeted edit.
                const oldLineCount = oldString.split('\n').length;
                const newLineCount = newString.split('\n').length;
                const fileLineCount = original.split('\n').length;
                const resultLineCount = fileLineCount - oldLineCount + newLineCount;
                // An insertion (resultLineCount >> fileLineCount) is always legitimate.
                // Only block when the result stays near the original size (i.e. a replacement).
                // Skip guard for tiny files (≤10 lines) — replacing a stub/placeholder is legitimate.
                const isInsertion = resultLineCount > fileLineCount * 1.3;
                if (fileLineCount > 10 && !isInsertion && newLineCount > oldLineCount * 3 && newLineCount > fileLineCount * 0.5 && oldLineCount < 15) {
                    throw new Error(
                        `edit_file: new_string (${newLineCount} lines) is much larger than old_string (${oldLineCount} lines) ` +
                        `and would replace most of the file. This looks like a whole-file rewrite attempt, which is not allowed. ` +
                        `Make targeted edits — use old_string with the exact current function body and new_string with just that function updated.`
                    );
                }

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
                                    this._editsThisRun++;
                                    this.postFn({ type: 'fileChanged', path: rel, action: 'edited' });
                                    if (!this._filesChangedThisRun.includes(rel)) { this._filesChangedThisRun.push(rel); }
                                    const editResult2 = `Edited: ${rel} — ${oldLines.length} line(s) replaced (indentation auto-corrected)`;
                                    const editDiags2 = this.getDiagnostics(root, rel);
                                    if (editDiags2 !== 'No errors or warnings found.') {
                                        return `${editResult2}\n\nDiagnostics after edit:\n${editDiags2}`;
                                    }
                                    return editResult2;
                                }
                            }
                        }
                        // ── Trailing-whitespace strip recovery ─────────────────
                        // Python files edited by various tools often have trailing
                        // spaces on otherwise-blank lines (e.g. "    \n" instead
                        // of "\n"). The model's old_string uses bare \n for blank
                        // lines, so it never matches. Try matching after stripping
                        // trailing whitespace from every file line.
                        const strippedOriginal = fileLines.map(l => l.trimEnd()).join('\n');
                        const strippedOldString = oldLines.map(l => l.trimEnd()).join('\n');
                        if (strippedOriginal.includes(strippedOldString)) {
                            // Find the exact region in the original (with trailing spaces) to replace
                            const strippedIdx = strippedOriginal.indexOf(strippedOldString);
                            // Count chars before that point in the stripped version to find line index
                            const linesBefore = strippedOriginal.slice(0, strippedIdx).split('\n').length - 1;
                            const linesInMatch = strippedOldString.split('\n').length;
                            const originalLines = original.split('\n');
                            const exactOriginalBlock = originalLines.slice(linesBefore, linesBefore + linesInMatch).join('\n');
                            const occurrencesStripped = (original.split(exactOriginalBlock).length - 1);
                            if (occurrencesStripped === 1) {
                                const newContent3 = original.replace(exactOriginalBlock, newString);
                                const isAutoApproved3 = this._autoApprovedTools.has('edit_file');
                                if (!isAutoApproved3) {
                                    await this.diffViewManager.showDiffPreview(full, original, newContent3);
                                }
                                const accepted3 = await this.requestConfirmation('edit', `Edit "${rel}" — ${oldLines.length} line(s) changed (auto-corrected trailing whitespace)`, 'edit_file');
                                if (!isAutoApproved3) { this.diffViewManager.closeDiffPreview(); }
                                if (!accepted3) { return 'Edit cancelled by user.'; }
                                fs.writeFileSync(full, newContent3, 'utf8');
                                this._lastFileOp = { path: rel, originalContent: original, action: 'edited' };
                                this._editsThisRun++;
                                this.postFn({ type: 'fileChanged', path: rel, action: 'edited' });
                                if (!this._filesChangedThisRun.includes(rel)) { this._filesChangedThisRun.push(rel); }
                                const editResult3 = `Edited: ${rel} — ${oldLines.length} line(s) replaced (trailing whitespace auto-corrected)`;
                                const editDiags3 = this.getDiagnostics(root, rel);
                                if (editDiags3 !== 'No errors or warnings found.') {
                                    return `${editResult3}\n\nDiagnostics after edit:\n${editDiags3}`;
                                }
                                return editResult3;
                            }
                        }

                        // Inject surrounding context so the model can build a correct old_string
                        // without a wasted re-read round-trip.
                        const ctxStart = Math.max(0, nearLineIdx - 2);
                        const ctxEnd = Math.min(fileLines.length - 1, nearLineIdx + oldLines.length + 4);
                        const ctxBlock = fileLines.slice(ctxStart, ctxEnd + 1)
                            .map((l, i) => `${String(ctxStart + i + 1).padStart(4, ' ')}: ${l}`)
                            .join('\n');
                        throw new Error(
                            `edit_file: old_string not found in ${rel}. ` +
                            `First line matched at line ${nearLineIdx + 1}, but the full block didn't match.\n\n` +
                            `ACTUAL FILE LINES AROUND THAT LOCATION:\n${ctxBlock}\n\n` +
                            `Set old_string to the EXACT lines from the file above (without the NNNN: prefix). ` +
                            `Do NOT re-read the file — use the lines shown here.`
                        );
                    }

                    // ── Append-intent detection ─────────────────────────────────
                    // If old_string not found AND new_string starts with a new class/method/function
                    // definition AND old_string looks like it came from the end of the file,
                    // this is almost certainly an "append new method" operation where the model
                    // used stale/truncated content as the anchor. Instead of a generic error,
                    // immediately inject the real last 30 lines of the file so the model can
                    // use the correct anchor on the very next attempt — no wasted re-read turn.
                    const newStringIsMethod = /^\s*(?:@\w+|\s*(?:def |async def |function |const |class |@classmethod|@staticmethod))/m.test(newString);
                    const oldStringLooksLikeTail = oldLines.length <= 10;  // short anchor = likely last-lines pattern
                    if (newStringIsMethod && oldStringLooksLikeTail) {
                        const tail30 = fileLines.slice(-30);
                        const tail30Numbered = tail30
                            .map((l, i) => `${String(fileLines.length - 30 + i + 1).padStart(4, ' ')}: ${l}`)
                            .join('\n');
                        throw new Error(
                            `edit_file: old_string not found in ${rel}. ` +
                            `This looks like an append operation but the anchor text didn't match.\n\n` +
                            `LAST 30 LINES OF FILE (use the final non-blank line as old_string):\n${tail30Numbered}\n\n` +
                            `Set old_string to the EXACT last non-blank line shown above (no line-number prefix), ` +
                            `and new_string to that same line PLUS a blank line PLUS your new method. ` +
                            `Do NOT re-read the file — use the lines shown here.`
                        );
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
                this._editsThisRun++;
                this.postFn({ type: 'fileChanged', path: rel, action: 'edited' });
                if (!this._filesChangedThisRun.includes(rel)) { this._filesChangedThisRun.push(rel); }

                // Auto-save a project memory note when a new named function or route is added
                if (this.memory) {
                    const fnMatch = newString.match(/(?:def|function|async function|const)\s+(\w+)\s*[\(\=]/);
                    const routeMatch = newString.match(/@\w+_bp\.route\(['"]([^'"]+)['"]/);
                    if (fnMatch || routeMatch) {
                        const what = routeMatch
                            ? `Route ${routeMatch[1]} added to ${rel}`
                            : `Function ${fnMatch![1]}() added to ${rel}`;
                        // Write unconditionally — skip isSemanticDuplicate to avoid
                        // contending with Ollama while it's mid-generation.
                        this.memory!.addEntry(2, what, ['auto-edit', 'structure']).catch(() => {});
                        logInfo(`[memory] Auto-saved edit fact: ${what}`);
                    }
                }
                // Fix 5b: Record completed step in task state machine
                if (this._activeTask) {
                    const stepDesc = `Edited ${rel}`;
                    if (!this._activeTask.stepsCompleted.includes(stepDesc)) {
                        this._activeTask.stepsCompleted.push(stepDesc);
                    }
                    if (!this._activeTask.filesConfirmed.includes(rel)) {
                        this._activeTask.filesConfirmed.push(rel);
                    }
                    // Mark matching pending steps as done (e.g. "HTML input ... added to cashier_dashboard.html")
                    const relBase = path.basename(rel);
                    this._activeTask.stepsPending = this._activeTask.stepsPending.filter(step => {
                        const done = step.toLowerCase().includes(relBase.toLowerCase());
                        if (done) { this._activeTask!.stepsCompleted.push(step); }
                        return !done;
                    });
                }

                // Low-confidence warning: if the model's average token logprob for this response
                // was below the threshold, the model was statistically uncertain about what it wrote.
                // Append a nudge so it double-checks names/signatures in new_string.
                // Threshold: avg logprob < -1.5 ≈ avg per-token perplexity > 4.5 (meaningfully uncertain).
                // Only fires when logprobs were actually returned (not null) and new_string is non-trivial.
                const LOW_LOGPROB_THRESHOLD = -1.5;
                const avgLp = this._lastResponseAvgLogprob;
                let logprobWarning = '';
                if (avgLp !== null && avgLp < LOW_LOGPROB_THRESHOLD && newString.length > 50) {
                    const pct = Math.round(Math.exp(avgLp) * 100);
                    logWarn(`[logprob] Low confidence edit: avg logprob=${avgLp.toFixed(3)} (≈${pct}% avg token prob)`);
                    this._guardEvents.push({ type: 'logprob', reason: `avg token prob ≈${pct}% — verify identifiers`, file: rel });
                    logprobWarning = `\n\n⚠ Low-confidence edit (avg token probability ≈${pct}%): verify that all identifiers, field names, and function signatures in the new code were read from the file rather than guessed.`;
                }

                const editResult = `Edited: ${rel} — ${oldString.split('\n').length} line(s) replaced with ${newString.split('\n').length} line(s)${logprobWarning}`;
                // Auto-check: use py_compile for Python (Pylance diagnostics are stale/unreliable post-edit),
                // use VSCode diagnostics for TypeScript/JS only
                const isPyFile = path.extname(full).toLowerCase() === '.py';
                if (!isPyFile) {
                    const editDiags = this.getDiagnostics(root, rel);
                    if (editDiags !== 'No errors or warnings found.') {
                        return `${editResult}\n\nDiagnostics after edit:\n${editDiags}`;
                    }
                }
                const syntaxErr = this.syntaxCheck(full);
                if (syntaxErr) {
                    logWarn(`[syntax-check] ${rel}: ${syntaxErr.slice(0, 100)}`);
                    this._guardEvents.push({ type: 'syntax-error', reason: syntaxErr.slice(0, 120), file: rel });
                    return `${editResult}\n\n⚠ Syntax error detected after edit:\n${syntaxErr}\n\nFix this by calling edit_file again with corrected code.`;
                }
                if (this.shouldRunTests()) {
                    const testFile = this.findTestFile(full);
                    if (testFile) {
                        const relTest = path.relative(root, testFile).replace(/\\/g, '/');
                        logInfo(`[test-runner] Running ${relTest}`);
                        const { passed, output } = this.runTestFile(testFile);
                        const icon = passed ? '✅' : '❌';
                        return `${editResult}\n\n${icon} Tests (${relTest}):\n${output}`;
                    }
                }

                // SQLAlchemy model integrity check — fires when a models/*.py file is edited
                // Catches: new FK with no relationship, ambiguous FK (2+ FKs to same table without foreign_keys=)
                const isModelFile = /[\\/]models[\\/][^\\/]+\.py$/i.test(full);
                if (isModelFile && isPyFile) {
                    const modelSource = (() => { try { return fs.readFileSync(full, 'utf8'); } catch { return ''; } })();
                    if (modelSource) {
                        const modelIssues: string[] = [];

                        // Check 1: every db.ForeignKey has a matching db.relationship or is referenced by one
                        const fkMatches = [...modelSource.matchAll(/(\w+)\s*=\s*db\.Column\([^)]*db\.ForeignKey\(['"]([^'"]+)['"]\)/g)];
                        const relMatches = [...modelSource.matchAll(/db\.relationship\s*\([^)]*foreign_keys\s*=\s*\[([^\]]+)\]/g)];
                        const relFkCols = new Set(relMatches.flatMap(m => m[1].split(',').map(s => s.trim())));
                        // Also count plain relationships (no foreign_keys arg) — OK when only one FK to that table

                        // Build map: table → [col names with FK to it]
                        const fkToTable = new Map<string, string[]>();
                        for (const m of fkMatches) {
                            const colName = m[1];
                            const fkTarget = m[2].split('.')[0]; // e.g. 'transactions' from 'transactions.id'
                            if (!fkToTable.has(fkTarget)) { fkToTable.set(fkTarget, []); }
                            fkToTable.get(fkTarget)!.push(colName);
                        }

                        // Flag: multiple FKs to the same table without foreign_keys= on relationships
                        for (const [table, cols] of fkToTable) {
                            if (cols.length >= 2) {
                                const hasForeignKeysArg = cols.some(c => relFkCols.has(c));
                                if (!hasForeignKeysArg) {
                                    modelIssues.push(
                                        `⚠ Ambiguous FK: ${cols.length} columns reference '${table}' (${cols.join(', ')}) but no db.relationship uses foreign_keys=[]. SQLAlchemy will raise AmbiguousForeignKeysError. Add foreign_keys=[<col>] to each relationship that joins to '${table}'.`
                                    );
                                }
                            }
                        }



                        if (modelIssues.length > 0) {
                            return `${editResult}\n\n${modelIssues.join('\n')}\n\nFix these before continuing.`;
                        }
                    }
                }

                // Fix 3a+b: Post-edit verification — check if task-specific completion criteria are met
                // Only fires for form field tasks where we know the full-stack surface.
                const taskMsg = this._currentTaskMessage || '';
                const isFormFieldEdit = /\badd\b.{0,40}\b(field|column|input)\b/i.test(taskMsg)
                    || /\b(form|template|inline)\b/i.test(taskMsg);
                if (isFormFieldEdit && /\.html$/i.test(rel)) {
                    // Extract field name from the edit to verify across the full stack
                    const addedInputMatch = newString.match(/name=["']([a-z_][a-z0-9_]*)["']/i)
                        ?? newString.match(/id=["']([a-z_][a-z0-9_]*)["']/i);
                    if (addedInputMatch) {
                        const fieldName = addedInputMatch[1];
                        const gaps: string[] = [];
                        // Check JS submit handler contains this field
                        const staticDir = path.join(root, 'app', 'static');
                        if (fs.existsSync(staticDir)) {
                            const jsFiles: string[] = [];
                            const walkJs2 = (d: string) => {
                                try { for (const f of fs.readdirSync(d)) {
                                    const a = path.join(d, f);
                                    try { if (fs.statSync(a).isDirectory()) { walkJs2(a); } else if (/\.js$/.test(f) && !/\.min\./.test(f)) { jsFiles.push(a); } } catch { /**/ }
                                } } catch { /**/ }
                            };
                            walkJs2(staticDir);
                            const jsHasField = jsFiles.some(jf => {
                                try { return fs.readFileSync(jf, 'utf8').includes(fieldName); } catch { return false; }
                            });
                            if (!jsHasField) {
                                gaps.push(`JS submit handler does not yet include \`${fieldName}\` — update the JS fetch/FormData block`);
                            }
                        }
                        // Check backend route reads this field
                        const routesDir2 = path.join(root, 'app', 'routes');
                        if (fs.existsSync(routesDir2)) {
                            const pyHasField = fs.readdirSync(routesDir2).filter(f => f.endsWith('.py')).some(rf => {
                                try { return fs.readFileSync(path.join(routesDir2, rf), 'utf8').includes(fieldName); } catch { return false; }
                            });
                            if (!pyHasField) {
                                gaps.push(`Backend route does not yet read \`request.form.get('${fieldName}')\` — update the POST handler`);
                            }
                        }
                        if (gaps.length > 0) {
                            return `${editResult}\n\n⚠ Verification: HTML field \`${fieldName}\` added, but task is NOT complete:\n${gaps.map(g => `- ${g}`).join('\n')}\n\nContinue with the remaining files now.`;
                        } else {
                            return `${editResult}\n\n✅ Verified: \`${fieldName}\` present in HTML, JS handler, and backend route.`;
                        }
                    }
                }

                // ── Critic pass ───────────────────────────────────────────────
                // If routing is enabled and a critic model is configured, run a quick
                // second-pass review of the diff before returning the result.
                // The critic only looks at the changed lines — it does not re-read the whole file.
                const criticResult = await this.runCriticPass(
                    this._routedCriticModel, this._currentRunModel, rel, original, newContent
                );
                if (criticResult) {
                    this._guardEvents.push({ type: 'scope-guard', reason: `critic: ${criticResult.slice(0, 80)}`, file: rel });
                    return `${editResult}\n\n🔍 Critic review:\n${criticResult}`;
                }

                return editResult;
            }

            // ── edit_file_at_line ──────────────────────────────────────────
            case 'edit_file_at_line': {
                // Sweep tasks must use edit_file (exact string matching) — line numbers shift after each edit
                // and cause corruption. Redirect to a helpful error so the model falls back to edit_file.
                if (this._isSweepTask) {
                    // If edit_file_at_line was auto-approved, carry that approval over to edit_file
                    // so the user doesn't have to re-approve every edit when they clicked "Accept All"
                    if (this._autoApprovedTools.has('edit_file_at_line')) {
                        this._autoApprovedTools.add('edit_file');
                    }
                    return `edit_file_at_line is disabled for sweep tasks because line numbers shift after each edit and cause file corruption. Use edit_file with old_string/new_string instead — copy the exact current function body from the file as old_string.`;
                }

                const rel2       = String(args.path ?? '');
                const startLine  = Math.round(Number(args.start_line ?? 0));
                const endLine    = Math.round(Number(args.end_line ?? 0));
                // Accept new_string as an alias for new_content (models sometimes confuse the param name)
                const newContent = String(args.new_content ?? args.new_string ?? '');

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

                // Validate imports in new content before touching the file
                const importErr2 = this.validateNewContent(newContent);
                if (importErr2) { throw new Error(importErr2); }

                // Build new file: lines before start, new_content, lines after end
                const before  = lines2.slice(0, startLine - 1);
                const after   = endLine >= startLine ? lines2.slice(endLine) : lines2.slice(startLine - 1);
                let newLines = newContent === '' ? [] : newContent.split('\n');
                // Auto-dedent: if every non-empty line in new_content has leading spaces but the
                // start_line in the file is at col 0 (top-level def/decorator), strip the common indent.
                // This prevents models from nesting functions by accidentally adding 4-space padding.
                if (newLines.length > 0) {
                    const targetLineIndent = (lines2[startLine - 1] ?? '').match(/^(\s*)/)?.[1]?.length ?? 0;
                    const nonEmpty = newLines.filter(l => l.trim().length > 0);
                    if (nonEmpty.length > 0) {
                        const minIndent = Math.min(...nonEmpty.map(l => l.match(/^(\s*)/)?.[1]?.length ?? 0));
                        if (minIndent > targetLineIndent) {
                            const strip = minIndent - targetLineIndent;
                            newLines = newLines.map(l => l.length >= strip && l.slice(0, strip).trim() === '' ? l.slice(strip) : l);
                        }
                    }
                }
                const newFile  = [...before, ...newLines, ...after].join('\n');

                // If the file wouldn't change, the edit is already done — skip and say so
                if (newFile === original2) {
                    return `Already done: lines ${startLine}-${endLine} in ${rel2} already contain the requested content. Mark this item [x] in your plan and move to the next unchecked item.`;
                }

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
                if (!this._filesChangedThisRun.includes(rel2)) { this._filesChangedThisRun.push(rel2); }
                const editResult3 = action === 'insert'
                    ? `Inserted ${newLines.length} line(s) at line ${startLine} in ${rel2}`
                    : `Replaced lines ${startLine}-${endLine} with ${newLines.length} line(s) in ${rel2}`;
                const isPyFile3 = path.extname(full2).toLowerCase() === '.py';
                if (!isPyFile3) {
                    const editDiags3 = this.getDiagnostics(root, rel2);
                    if (editDiags3 !== 'No errors or warnings found.') {
                        return `${editResult3}\n\nDiagnostics after edit:\n${editDiags3}`;
                    }
                }
                const syntaxErr3 = this.syntaxCheck(full2);
                if (syntaxErr3) {
                    logWarn(`[syntax-check] ${rel2}: ${syntaxErr3.slice(0, 100)}`);
                    this._guardEvents.push({ type: 'syntax-error', reason: syntaxErr3.slice(0, 120), file: rel2 });
                    return `${editResult3}\n\n⚠ Syntax error detected after edit:\n${syntaxErr3}\n\nFix this by calling edit_file again with corrected code.`;
                }
                if (this.shouldRunTests()) {
                    const testFile2 = this.findTestFile(full2);
                    if (testFile2) {
                        const relTest2 = path.relative(root, testFile2).replace(/\\/g, '/');
                        logInfo(`[test-runner] Running ${relTest2}`);
                        const { passed: passed2, output: output2 } = this.runTestFile(testFile2);
                        const icon2 = passed2 ? '✅' : '❌';
                        return `${editResult3}\n\n${icon2} Tests (${relTest2}):\n${output2}`;
                    }
                }
                // For sweep tasks: append fresh numbered file content so model has
                // current line numbers for the next edit without needing to re-read.
                if (this._currentTaskMessage && (
                    /\b(all|every|each|any)\b.{0,40}\b(route|function|endpoint|def)\b/i.test(this._currentTaskMessage)
                    || /\b(missing|without|lacks?|no\s+error|no\s+try)\b/i.test(this._currentTaskMessage)
                    || /\b(add|fix).{0,30}\b(all|every|each|any)\b/i.test(this._currentTaskMessage)
                )) {
                    const updatedContent = fs.readFileSync(full2, 'utf8');
                    const numberedLines = updatedContent.split('\n')
                        .map((l, i) => `${String(i + 1).padStart(4, ' ')}: ${l}`)
                        .join('\n');
                    const planPath2 = rel2.replace(/[^/]+$/, '.ollamapilot-plan.md');
                    return `${editResult3}\n\n[UPDATED FILE - fresh line numbers]\n${numberedLines}\n\n[SWEEP TASK] Next steps:\n1. Update the plan file "${planPath2}": mark the item you just finished as done (change "- [ ]" to "- [x]").\n2. Look at the updated file above. Find the NEXT unchecked route/function from your plan that is missing the change.\n3. Call edit_file_at_line for that function — use start_line (the def line) through end_line (last line of function). Replace the ENTIRE function. Keep indentation at top level (no leading spaces on def/decorators).\n4. Repeat until all items in the plan are checked off.`;
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

                // Auto-fix: Select-String does NOT support -Recurse on PowerShell.
                // Only applies when -Recurse appears AFTER the pipe (i.e., as an argument to Select-String).
                // Valid: "Get-ChildItem -Recurse | Select-String" — -Recurse belongs to Get-ChildItem, leave it alone.
                // Invalid: "Select-String -Path '...' -Recurse -Pattern '...'" — rewrite to GCI | SS form.
                {
                    const pipeIdx = cmd.indexOf('|');
                    const afterPipe = pipeIdx >= 0 ? cmd.slice(pipeIdx) : '';
                    const selectStringIsFirstCmd = /^\s*Select-String\b/i.test(cmd);
                    const recurseAfterPipe = afterPipe && /-Recurse\b/i.test(afterPipe);
                    if (recurseAfterPipe || selectStringIsFirstCmd && /-Recurse\b/i.test(cmd)) {
                        const ssPathMatch = cmd.match(/-Path\s+['"]([^'"]+)['"]/i);
                        const ssPatternMatch = cmd.match(/-Pattern\s+['"]([^'"]+)['"]/i);
                        if (ssPathMatch && ssPatternMatch) {
                            const rawPath = ssPathMatch[1];
                            const ssPattern = ssPatternMatch[1];
                            const extMatch = rawPath.match(/\*\.(\w+)$/);
                            const filterArg = extMatch ? ` -Filter '*.${extMatch[1]}'` : '';
                            const baseDir = rawPath.replace(/[\\/]\*\*[\\/]\*\.\w+$/, '').replace(/[\\/]\*\.\w+$/, '') || rawPath;
                            const trailingPipeMatch = cmd.match(/\|\s*(Select-Object.+)$/i);
                            const trailingPipe = trailingPipeMatch ? ` | ${trailingPipeMatch[1]}` : ' | Select-Object Path,LineNumber,Line | Select-Object -First 30';
                            cmd = `Get-ChildItem -Path '${baseDir}' -Recurse${filterArg} | Select-String -Pattern '${ssPattern}'${trailingPipe}`;
                            logInfo(`[shell_read] Auto-fixed Select-String -Recurse → ${cmd}`);
                        } else if (recurseAfterPipe) {
                            // Strip -Recurse from the Select-String portion only
                            const beforePipe = cmd.slice(0, pipeIdx);
                            const fixedAfterPipe = afterPipe.replace(/\s+-Recurse\b/gi, '');
                            cmd = beforePipe + fixedAfterPipe;
                            logInfo(`[shell_read] Stripped -Recurse from Select-String portion: ${cmd}`);
                        }
                    }
                }

                // Auto-fix: Unix grep on Windows — convert to PowerShell Select-String.
                // Also handles multi-word patterns like grep -rn "foo bar baz" which would never match
                // any real file — extract the best single keyword instead.
                if (process.platform === 'win32' && /\bgrep\b/i.test(cmd)) {
                    const grepPatternMatch = cmd.match(/grep\s+(?:-[\w]+\s+)*["']([^"']+)["']/i);
                    if (grepPatternMatch) {
                        const rawPattern = grepPatternMatch[1];
                        const isMultiWord = /\s/.test(rawPattern.trim());
                        // If multi-word, pick the longest word > 3 chars as the actual search term.
                        // Prefer domain-specific terms over generic verbs.
                        const genericWords = new Set(['save','saved','trace','find','show','list','get','set','use','make','take','call','send','read','load','init','test','data','file','code','path','name','type','form','view','page','item','user','node','base','core','main','util','help','info','work','done']);
                        const words = rawPattern.split(/\s+/).filter(w => w.length > 3 && !genericWords.has(w.toLowerCase()));
                        const allWords = rawPattern.split(/\s+/).filter(w => w.length > 3);
                        const bestWord = (words.sort((a, b) => b.length - a.length)[0] ?? allWords.sort((a, b) => b.length - a.length)[0]) ?? rawPattern;
                        const includeMatch = cmd.match(/--include=['"*]?\*\.(\w+)/i);
                        const includeExt = includeMatch ? includeMatch[1] : 'py';
                        const wsRootGrep = this.workspaceRoot.replace(/\\/g, '/');
                        const fixedCmd = `Get-ChildItem -Path '${wsRootGrep}' -Recurse -Filter '*.${includeExt}' | Where-Object { $_.FullName -notmatch '__pycache__|htmlcov|venv' } | Select-String -Pattern '${bestWord}' | Select-Object Path,LineNumber,Line | Select-Object -First 20`;
                        logInfo(`[shell_read] Auto-converted Unix grep to PowerShell (pattern: "${rawPattern}" → keyword: "${bestWord}"): ${fixedCmd}`);
                        cmd = fixedCmd;
                        if (isMultiWord) {
                            // Append a note to the result so the model doesn't split and re-search each word
                            const origResult = await this.runShellRead(cmd, root, _toolId);
                            return origResult + `\n\n[NOTE] Your original pattern "${rawPattern}" was a multi-word phrase — no file contains that exact string. Searched for "${bestWord}" instead. Do NOT repeat this search with the other words separately. If these results aren't what you need, search for a more specific identifier (e.g. a function name, class name, or API endpoint).`;
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

                const shellResult = await this.runShellRead(cmd, root, _toolId);

                // ── Doc verification: when reading a .md file, extract verifiable
                // claims and append grep commands the model should run to cross-check them.
                const isMarkdownRead = /\.(md|rst|txt)\b/i.test(cmd) &&
                    /\bGet-Content\b|\bcat\b|\btype\b/i.test(cmd);
                if (isMarkdownRead && typeof shellResult === 'string') {
                    // Detect truncated reads (piped through Select-Object, head, etc.)
                    const isTruncated = /Select-Object\s+-First|\bhead\s+-n|\bhead\s+-\d+|\|\s*head\b/i.test(cmd);
                    if (isTruncated) {
                        // Force full read — the model must not answer from a partial doc
                        const fullCmd = cmd.replace(/\s*\|\s*Select-Object\s+-First\s+\d+/i, '')
                                          .replace(/\s*\|\s*head\s+(-n\s+)?\d+/i, '');
                        return shellResult + '\n\n---\n' +
                            '[WARNING: TRUNCATED DOC READ] You only read part of this documentation file. ' +
                            `You MUST read the full file before cross-checking claims. Run: shell_read Get-Content '${fullCmd.match(/'([^']+\.md[^']*)'|"([^"]+\.md[^"]*)"/i)?.[1] ?? 'the file'}'`;
                    }

                    const hints = extractDocVerificationHints(shellResult);
                    if (hints.length > 0) {
                        return shellResult + '\n\n---\n' +
                            '[DOC VERIFICATION REQUIRED] This documentation file makes specific claims that may be out of date. ' +
                            'You MUST verify the following claims against the actual source code using shell_read/grep BEFORE presenting this information. ' +
                            'For each discrepancy found, flag it with ⚠️ and ask the user if they want you to update the doc.\n\n' +
                            'Claims to verify:\n' + hints.join('\n');
                    } else if (shellResult.length > 100) {
                        // Even if no specific claims extracted, still remind to cross-check
                        return shellResult + '\n\n---\n' +
                            '[DOC NOTE] This is documentation — verify any specific claims (numbers, class names, file paths) ' +
                            'against the actual source code before presenting as fact.';
                    }
                }

                return shellResult;
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

                // Auto-fix: Select-String does NOT support -Recurse.
                // Only applies when -Recurse is an argument to Select-String, not when it's on a piped Get-ChildItem.
                {
                    const pipeIdx2 = cmd.indexOf('|');
                    const afterPipe2 = pipeIdx2 >= 0 ? cmd.slice(pipeIdx2) : '';
                    const ssIsFirst = /^\s*Select-String\b/i.test(cmd);
                    const recurseAfterPipe2 = afterPipe2 && /-Recurse\b/i.test(afterPipe2);
                    if (recurseAfterPipe2 || ssIsFirst && /-Recurse\b/i.test(cmd)) {
                        const pathMatch = cmd.match(/-Path\s+['"]([^'"]+)['"]/i);
                        const patternMatch = cmd.match(/-Pattern\s+['"]([^'"]+)['"]/i);
                        if (pathMatch && patternMatch) {
                            const rawPath = pathMatch[1];
                            const pattern = patternMatch[1];
                            const extMatch = rawPath.match(/\*\.(\w+)$/);
                            const filterArg = extMatch ? ` -Filter '*.${extMatch[1]}'` : '';
                            const baseDir = rawPath.replace(/[\\/]\*\*[\\/]\*\.\w+$/, '').replace(/[\\/]\*\.\w+$/, '') || rawPath;
                            const trailingPipeMatch2 = cmd.match(/\|\s*(Select-Object.+)$/i);
                            const trailingPipe2 = trailingPipeMatch2 ? ` | ${trailingPipeMatch2[1]}` : ' | Select-Object Path,LineNumber,Line | Select-Object -First 30';
                            const fixed = `Get-ChildItem -Path '${baseDir}' -Recurse${filterArg} | Select-String -Pattern '${pattern}'${trailingPipe2}`;
                            logInfo(`[run_command] Auto-fixed Select-String -Recurse → ${fixed}`);
                            cmd = fixed;
                        } else if (recurseAfterPipe2) {
                            const beforePipe2 = cmd.slice(0, pipeIdx2);
                            const fixedAfterPipe2 = afterPipe2.replace(/\s+-Recurse\b/gi, '');
                            cmd = beforePipe2 + fixedAfterPipe2;
                            logInfo(`[run_command] Stripped -Recurse from Select-String portion: ${cmd}`);
                        }
                    }
                }

                // Auto-fix: Set-Content and Out-File default to UTF-16 on Windows PowerShell 5.
                // Inject -Encoding UTF8 if not already present to prevent creating UTF-16 source files.
                if (/\b(Set-Content|Out-File|Add-Content)\b/i.test(cmd) && !/\-Encoding\b/i.test(cmd)) {
                    cmd = cmd.replace(/\b(Set-Content|Out-File|Add-Content)\b/gi, '$1 -Encoding UTF8');
                    logInfo(`[run_command] Auto-added -Encoding UTF8 to Set-Content/Out-File/Add-Content: ${cmd}`);
                }

                // Block large Set-Content/Out-File writes on plan/doc files — large generations
                // cause Ollama to timeout before completing. Redirect to incremental edit_file writes.
                const largeWriteDocMatch = cmd.match(/['"]([^'"]+\.(?:md|txt|rst))['"]/i);
                const largeWriteIsFileWrite = /\b(Set-Content|Out-File)\b/i.test(cmd);
                if (largeWriteDocMatch && largeWriteIsFileWrite && cmd.length > 1000) {
                    const relDocFile = largeWriteDocMatch[1].replace(/\\/g, '/');
                    return `[BLOCKED: Large file write via Set-Content will timeout]\n\nWriting large documents in a single Set-Content call causes the model to timeout before generating all the content.\n\nInstead, write the file in sections using edit_file:\n1. First section — create the file:\n   edit_file path="${relDocFile}" old_string="" new_string="# Title\\n\\n## Section 1\\n...first ~50 lines..."\n2. Append next section:\n   edit_file path="${relDocFile}" old_string="...last line of section 1..." new_string="...last line...\\n\\n## Section 2\\n...next ~50 lines..."\n3. Continue until complete.\n\nKeep each new_string under 60 lines. Do NOT use Set-Content or Out-File for documents longer than ~30 lines.`;
                }

                // Block New-Item -ItemType File on source files — the agent should use edit_file instead.
                // When a file "doesn't exist", the real problem is usually a wrong path, not a missing file.
                const newItemFileMatch = cmd.match(/New-Item\b.*-ItemType\s+File\b.*['"]([^'"]+\.(py|ts|js|html|css|rb|go|java|cs|php|json|yaml|yml))['"]/i)
                    ?? cmd.match(/New-Item\b.*['"]([^'"]+\.(py|ts|js|html|css|rb|go|java|cs|php|json|yaml|yml))['"].*-ItemType\s+File\b/i);
                if (newItemFileMatch) {
                    const targetFile4 = newItemFileMatch[1];
                    const wsRoot5 = this.workspaceRoot.replace(/\\/g, '/');
                    const fileName5 = path.basename(targetFile4);
                    return `[BLOCKED: New-Item cannot create source files]\n\nDo NOT create "${targetFile4}" with New-Item. The file you want to edit already exists somewhere in the project — you have the wrong path.\n\nSearch for it first:\nshell_read with command="Get-ChildItem -Path '${wsRoot5}' -Recurse -Filter '${fileName5}' | Where-Object { \\$_.FullName -notmatch '__pycache__|htmlcov' } | Select-Object FullName"\n\nIf the file genuinely needs to be created (e.g. a brand new feature file), use edit_file with old_string="" and new_string=<full content> instead.`;
                }

                // Block echo >> / echo > on source files — newlines are collapsed, producing broken code.
                // Redirect to edit_file which handles multi-line content correctly.
                const echoRedirectMatch = cmd.match(/\becho\b.+?(>>?)\s*['"]?([^\s'"]+\.(py|ts|js|html|css|rb|go|java|cs|php|json|yaml|yml))/i);
                if (echoRedirectMatch) {
                    const targetFile = echoRedirectMatch[2];
                    const echoBlockMsg = `[BLOCKED: echo cannot write multi-line code]\n\nUsing echo to write source code to "${targetFile}" collapses all newlines into a single line, producing broken/unparseable code.\n\nTo create or append to this file, use edit_file instead:\n- To create a new file: edit_file with path="${targetFile}", old_string="" (empty), new_string=<full file content>\n- To append a function: edit_file with path="${targetFile}", old_string=<last line of file>, new_string=<last line + new function>\n\nDo NOT use echo, Add-Content, or any shell redirect to write source code files.`;
                    return echoBlockMsg;
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

                // In merge mode, Add-Content and Remove-Item are auto-approved (no user prompt needed)
                const isMergeAutoApprove = this._mergeMode && (
                    /\bAdd-Content\b/i.test(cmd) || /\bRemove-Item\b/i.test(cmd)
                );
                const accepted = isMergeAutoApprove || await this.requestConfirmation('run', cmd, 'run_command');
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
                
                // Accept single tier number; ignore comma-separated strings (search all tiers)
                const tierRaw = args.tier !== undefined ? Number(args.tier) : undefined;
                const tier = (tierRaw !== undefined && !isNaN(tierRaw)) ? tierRaw : undefined;
                const limit = args.limit !== undefined ? Number(args.limit) : undefined;
                
                const results = await this.memory.searchMemory(query, tier, limit);

                if (results.length === 0) {
                    return `No relevant memories found for "${query}".`;
                }

                // Record search_result access for every returned entry
                for (const entry of results) {
                    this.memory.recordAccess(entry.id, 'search_result');
                }

                // Track which entries were surfaced this turn so we can upgrade
                // to search_hit if the model references their content in its response
                for (const entry of results) {
                    this._recentSearchResultIds.add(entry.id);
                }

                let output = `Semantic search results for "${query}" (${results.length} found):\n\n`;
                results.forEach((entry, i) => {
                    const score = entry.relevanceScore ? ` (relevance: ${(entry.relevanceScore * 100).toFixed(0)}%)` : '';
                    const tags = entry.tags && entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
                    output += `[${i + 1}] id=${entry.id} Tier ${entry.tier}${tags}${score}\n`;
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

                // Semantic dedup: reject if too similar to existing memory.
                // If the full content is a dupe, try once with a truncated version — the model
                // often retries with identical content on rejection, so truncating breaks the loop.
                try {
                    const isDupe = await this.memory.isSemanticDuplicate(content, 0.80);
                    if (isDupe) {
                        // Try truncated version before giving up
                        if (content.length > 300) {
                            const truncated = content.slice(0, 300).trimEnd() + '…';
                            const isDupeTrunc = await this.memory.isSemanticDuplicate(truncated, 0.80).catch(() => true);
                            if (!isDupeTrunc) {
                                const note = await this.memory.addEntry(tier as 0|1|2|3|4|5, truncated, tags);
                                this.memoryWritesThisResponse++;
                                const tierName2 = ['Critical', 'Essential', 'Operational', 'Collaboration', 'References', 'Archive'][tier];
                                logInfo(`[memory] Saved truncated (full was duplicate): "${truncated.slice(0, 60)}"`);
                                return `Note saved (truncated to avoid duplicate) to Tier ${tier} (${tierName2}) with id: ${note.id}.`;
                            }
                        }
                        logInfo(`[memory] Semantic-deduped: "${content.slice(0, 60)}"`);
                        return `Duplicate: a semantically similar entry already exists in memory. Entry not saved — this is not an error.`;
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

            // ── web_search ─────────────────────────────────────────────────────
            case 'web_search': {
                const searchCfg = getSearchConfig();
                if (!searchCfg.url) {
                    return '(web_search unavailable: no SearXNG URL configured. Set ollamaAgent.search.url in VS Code settings, e.g. "http://192.168.1.100:8888")';
                }
                const query = String(args.query ?? '').trim();
                if (!query) { throw new Error('query is required'); }
                const limit = Math.min(Math.max(1, Number(args.limit ?? searchCfg.resultsLimit)), 20);
                const encodedQuery = encodeURIComponent(query);
                const searchUrl = `${searchCfg.url}/search?q=${encodedQuery}&format=json`;

                return new Promise<string>((resolve) => {
                    const parsed = new URL(searchUrl);
                    const httpMod = parsed.protocol === 'https:' ? https : http;
                    const reqOpts = {
                        hostname: parsed.hostname,
                        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                        path: parsed.pathname + parsed.search,
                        method: 'GET',
                        headers: { 'Accept': 'application/json', 'User-Agent': 'OllamaPilot/1.0' },
                        timeout: 15000,
                    };
                    const req = httpMod.request(reqOpts, (res: any) => {
                        let raw = '';
                        res.on('data', (chunk: any) => { raw += chunk; });
                        res.on('end', () => {
                            try {
                                const data = JSON.parse(raw);
                                const results = (data.results ?? []).slice(0, limit);
                                if (results.length === 0) {
                                    resolve(`No results found for "${query}".`);
                                    return;
                                }
                                let out = `Web search results for "${query}" (${results.length} of ${data.results?.length ?? 0} total):\n\n`;
                                results.forEach((r: any, i: number) => {
                                    out += `[${i + 1}] ${r.title ?? '(no title)'}\n`;
                                    out += `    URL: ${r.url ?? ''}\n`;
                                    if (r.content) { out += `    ${r.content.slice(0, 200).replace(/\n/g, ' ')}\n`; }
                                    out += '\n';
                                });
                                resolve(out.trim());
                            } catch (e) {
                                resolve(`web_search: failed to parse SearXNG response — ${toErrorMessage(e)}`);
                            }
                        });
                    });
                    req.on('error', (e: any) => resolve(`web_search: request failed — ${toErrorMessage(e)}`));
                    req.on('timeout', () => { req.destroy(); resolve('web_search: request timed out after 15s'); });
                    req.end();
                });
            }

            // ── web_fetch ──────────────────────────────────────────────────────
            case 'web_fetch': {
                const fetchUrl = String(args.url ?? '').trim();
                if (!fetchUrl) { throw new Error('url is required'); }
                if (!/^https?:\/\//i.test(fetchUrl)) { throw new Error('url must start with http:// or https://'); }

                return new Promise<string>((resolve) => {
                    const parsed = new URL(fetchUrl);
                    const httpMod = parsed.protocol === 'https:' ? https : http;
                    const reqOpts = {
                        hostname: parsed.hostname,
                        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                        path: parsed.pathname + parsed.search,
                        method: 'GET',
                        headers: { 'Accept': 'text/html,application/xhtml+xml,text/plain', 'User-Agent': 'OllamaPilot/1.0' },
                        timeout: 20000,
                    };
                    const req = httpMod.request(reqOpts, (res: any) => {
                        // Follow single redirect
                        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                            resolve(`(redirect to ${res.headers.location} — call web_fetch again with the new URL)`);
                            return;
                        }
                        let raw = '';
                        res.on('data', (chunk: any) => { if (raw.length < 300_000) { raw += chunk; } });
                        res.on('end', () => {
                            // Strip HTML tags → readable text
                            let text = raw
                                .replace(/<script[\s\S]*?<\/script>/gi, '')
                                .replace(/<style[\s\S]*?<\/style>/gi, '')
                                .replace(/<[^>]+>/g, ' ')
                                .replace(/&nbsp;/g, ' ')
                                .replace(/&amp;/g, '&')
                                .replace(/&lt;/g, '<')
                                .replace(/&gt;/g, '>')
                                .replace(/&quot;/g, '"')
                                .replace(/&#39;/g, "'")
                                .replace(/\s{3,}/g, '\n\n')
                                .trim();
                            const cap = 8000;
                            if (text.length > cap) { text = text.slice(0, cap) + '\n\n...(truncated — page has more content)'; }
                            resolve(text || '(page returned no readable text)');
                        });
                    });
                    req.on('error', (e: any) => resolve(`web_fetch: request failed — ${toErrorMessage(e)}`));
                    req.on('timeout', () => { req.destroy(); resolve('web_fetch: request timed out after 20s'); });
                    req.end();
                });
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
                    if (!this._filesChangedThisRun.includes(c.path)) { this._filesChangedThisRun.push(c.path); }
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
                && /Get-ChildItem|Get-Content|Set-Content|Out-File|Add-Content|Select-Object|Select-String|Where-Object|ForEach-Object|New-Item|Remove-Item|Move-Item|Copy-Item|Test-Path|Write-Host|Measure-Object|Sort-Object|\$_|\$PSItem/.test(cmd);
            const child = isPSCmd
                ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { cwd, env: { ...process.env } })
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

    private runShellRead(cmd: string, cwd: string, cmdId: string, limit?: number): Promise<string> {
        return new Promise((resolve) => {
            const post = this.postFn;
            post({ type: 'commandStart', id: cmdId, cmd });

            // On Windows, PowerShell cmdlets must run via powershell.exe, not cmd.exe.
            // Detect PowerShell commands and spawn accordingly.
            const isPowerShellCmd = process.platform === 'win32'
                && /Get-ChildItem|Get-Content|Set-Content|Out-File|Add-Content|Select-Object|Select-String|Where-Object|ForEach-Object|New-Item|Remove-Item|Move-Item|Copy-Item|Test-Path|Write-Host|Out-Host|Measure-Object|Sort-Object|\$_|\$PSItem/.test(cmd);
            const spawnArgs: [string, string[], object] = isPowerShellCmd
                ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { cwd, env: { ...process.env } }]
                : [cmd, [], { cwd, env: { ...process.env }, shell: true }];
            const child = spawn(...spawnArgs);
            this.trackChild(child);

            let output = '';
            let finished = false;
            const LIMIT = limit ?? 16_000; // Higher limit for read-only — no risk

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

    /**
     * For Python edits: check that any "from app.X import Y" references resolve to
     * actual files on disk. Returns an error string if any module is missing, null otherwise.
     */
    /**
     * Generate a structured file plan for multi-component requests.
     * Purely heuristic — no model call. Returns empty array if plan is too uncertain.
     */
    private generateMultiFilePlan(userMessage: string): FilePlan[] {
        const plan: FilePlan[] = [];
        const msg = userMessage.toLowerCase();

        // Extract the primary name (the thing being created)
        // e.g. "add a Vehicle model" → "vehicle", "create a payment feature" → "payment"
        const nameMatch = userMessage.match(
            /\b(?:add|create|implement|build|scaffold)\b\s+(?:a\s+)?(?:new\s+)?(\w+)\s+(?:model|feature|blueprint|endpoint|module|service)/i
        ) ?? userMessage.match(/\bnew\s+(\w+)\s+(?:model|feature|blueprint|endpoint|module|service)/i);

        if (!nameMatch) { return []; }
        const name = nameMatch[1].toLowerCase();
        if (name.length < 3 || /^(the|new|my|our|this|that|some|any)$/.test(name)) { return []; }

        const root = this.workspaceRoot;
        if (!root) { return []; }

        // Detect project type
        const hasPy = fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'pyproject.toml'));
        const hasTs = fs.existsSync(path.join(root, 'package.json')) || fs.existsSync(path.join(root, 'tsconfig.json'));

        if (hasPy) {
            // Python/Flask patterns
            if (/\bmodel\b/.test(msg)) {
                plan.push({ relPath: `app/models/${name}.py`, action: 'create', description: `SQLAlchemy model class for ${name}` });
            }
            if (/\b(route|endpoint|blueprint|api)\b/.test(msg)) {
                // Try to detect target routes directory
                const routesDir = fs.existsSync(path.join(root, 'app', 'routes')) ? 'app/routes' : 'app';
                plan.push({ relPath: `${routesDir}/${name}.py`, action: 'create', description: `Blueprint with CRUD routes for ${name}` });
            }
            if (/\bservice\b/.test(msg)) {
                plan.push({ relPath: `app/services/${name}_service.py`, action: 'create', description: `Service layer for ${name} business logic` });
            }
            if (/\b(test|spec)\b/.test(msg)) {
                const testsDir = fs.existsSync(path.join(root, 'tests')) ? 'tests' : 'test';
                plan.push({ relPath: `${testsDir}/test_${name}.py`, action: 'create', description: `pytest test suite for ${name}` });
            }
            if (/\bmigration\b/.test(msg)) {
                const ts = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
                plan.push({ relPath: `migrations/versions/${ts}_add_${name}.py`, action: 'create', description: `Alembic migration for ${name} table` });
            }
            // Always flag __init__.py if registering a new blueprint
            if (/\b(blueprint|route)\b/.test(msg) && fs.existsSync(path.join(root, 'app', '__init__.py'))) {
                plan.push({ relPath: 'app/__init__.py', action: 'modify', description: `Register new ${name} blueprint` });
            }
        } else if (hasTs) {
            if (/\b(type|interface|model|schema)\b/.test(msg)) {
                plan.push({ relPath: `src/types/${name}.ts`, action: 'create', description: `TypeScript interface/type for ${name}` });
            }
            if (/\b(route|endpoint|controller|handler)\b/.test(msg)) {
                plan.push({ relPath: `src/routes/${name}.ts`, action: 'create', description: `Route handler for ${name}` });
            }
            if (/\b(service|util)\b/.test(msg)) {
                plan.push({ relPath: `src/services/${name}Service.ts`, action: 'create', description: `Service for ${name}` });
            }
            if (/\b(test|spec)\b/.test(msg)) {
                plan.push({ relPath: `src/test/${name}.test.ts`, action: 'create', description: `Test suite for ${name}` });
            }
        }

        return plan;
    }

    /**
     * Quick syntax check after a file edit.
     * Python: runs py_compile. Returns error string or null.
     * TypeScript/JS: skipped (VSCode diagnostics handle it).
     */
    private syntaxCheck(absPath: string): string | null {
        const ext = path.extname(absPath).toLowerCase();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { execSync: execSyncFn } = require('child_process') as typeof import('child_process');

        if (ext === '.py') {
            try {
                const pythonCmd = process.platform === 'win32' ? 'py' : 'python3';
                try {
                    execSyncFn(`${pythonCmd} -m py_compile "${absPath}"`, {
                        timeout: 5000, stdio: 'pipe', encoding: 'utf8'
                    });
                } catch (e1) {
                    try {
                        execSyncFn(`python -m py_compile "${absPath}"`, {
                            timeout: 5000, stdio: 'pipe', encoding: 'utf8'
                        });
                    } catch (e2: any) {
                        const stderr = (e2.stderr as string | undefined) ?? String(e2);
                        const lines = stderr.split('\n').filter((l: string) => l.trim() && !l.startsWith('Traceback'));
                        return lines.slice(0, 4).join('\n');
                    }
                }
                return null;
            } catch {
                return null;
            }
        }

        if (ext === '.ts' || ext === '.tsx') {
            // Run tsc --noEmit scoped to just this file using the project tsconfig if present
            const root = this.workspaceRoot;
            if (!root) { return null; }
            const tsconfigPath = path.join(root, 'tsconfig.json');
            if (!fs.existsSync(tsconfigPath)) { return null; }
            try {
                execSyncFn(`npx tsc --noEmit --skipLibCheck 2>&1`, {
                    cwd: root, timeout: 15000, stdio: 'pipe', encoding: 'utf8'
                });
                return null;
            } catch (e: any) {
                const out = ((e.stdout ?? '') + (e.stderr ?? '')).trim();
                if (!out) { return null; }
                // Filter to only errors that mention this specific file
                const relFile = path.relative(root, absPath).replace(/\\/g, '/');
                const relevantLines = out.split('\n')
                    .filter((l: string) => l.includes(relFile) || l.match(/error TS/))
                    .slice(0, 5);
                return relevantLines.length > 0 ? relevantLines.join('\n') : null;
            }
        }

        return null;
    }

    /**
     * Find the test file corresponding to a source file.
     * Checks common test naming conventions and test directories.
     * Returns absolute path if found, null otherwise.
     */
    private findTestFile(absSourcePath: string): string | null {
        const root = this.workspaceRoot;
        if (!root) { return null; }

        const ext = path.extname(absSourcePath);
        const base = path.basename(absSourcePath, ext);
        const dir  = path.dirname(absSourcePath);
        const relDir = path.relative(root, dir).replace(/\\/g, '/');

        const candidates: string[] = [];

        if (ext === '.py') {
            // Same directory: test_<name>.py or <name>_test.py
            candidates.push(path.join(dir, `test_${base}.py`));
            candidates.push(path.join(dir, `${base}_test.py`));

            // tests/ sibling at project root
            const rootTests = path.join(root, 'tests', `test_${base}.py`);
            candidates.push(rootTests);
            candidates.push(path.join(root, 'tests', `${base}_test.py`));

            // tests/ sibling relative to file's directory
            const siblingTests = path.join(dir, '..', 'tests', `test_${base}.py`);
            candidates.push(siblingTests);

            // Mirror path under tests/ at project root
            const mirrorPath = path.join(root, 'tests', relDir, `test_${base}.py`);
            candidates.push(mirrorPath);
        } else if (ext === '.ts' || ext === '.js') {
            // <name>.test.ts / <name>.spec.ts in same dir
            candidates.push(path.join(dir, `${base}.test${ext}`));
            candidates.push(path.join(dir, `${base}.spec${ext}`));
            // __tests__ sibling
            candidates.push(path.join(dir, '__tests__', `${base}.test${ext}`));
            candidates.push(path.join(dir, '__tests__', `${base}.spec${ext}`));
        }

        for (const c of candidates) {
            try {
                if (fs.existsSync(c)) { return c; }
            } catch { /* skip */ }
        }
        return null;
    }

    /**
     * Run a test file and return {passed, output}.
     * Python: pytest or unittest. JS/TS: npm test (scoped).
     */
    private runTestFile(absTestPath: string): { passed: boolean; output: string } {
        const root = this.workspaceRoot ?? path.dirname(absTestPath);
        const ext  = path.extname(absTestPath).toLowerCase();
        const relTest = path.relative(root, absTestPath).replace(/\\/g, '/');

        try {
            const { execSync: execSyncFn } = require('child_process') as typeof import('child_process');

            if (ext === '.py') {
                // Try pytest first, fall back to unittest
                const pythonCmd = process.platform === 'win32' ? 'py' : 'python3';
                const cmds = [
                    `pytest "${absTestPath}" -q --tb=short 2>&1`,
                    `${pythonCmd} -m pytest "${absTestPath}" -q --tb=short 2>&1`,
                    `python -m pytest "${absTestPath}" -q --tb=short 2>&1`,
                    `${pythonCmd} -m unittest "${relTest.replace(/\//g, '.').replace(/\.py$/, '')}" 2>&1`,
                ];
                for (const cmd of cmds) {
                    try {
                        const out = execSyncFn(cmd, { cwd: root, timeout: 30000, encoding: 'utf8' }) as string;
                        return { passed: true, output: out.trim().slice(0, 800) };
                    } catch (e: any) {
                        const out = ((e.stdout ?? '') + (e.stderr ?? '')).trim();
                        if (out && (out.includes('passed') || out.includes('failed') || out.includes('error'))) {
                            const passed = /\d+ passed/.test(out) && !/\d+ failed/.test(out) && !/\d+ error/.test(out);
                            return { passed, output: out.slice(0, 800) };
                        }
                        // If it's a "command not found" style error, try next
                        if (out.includes('not found') || out.includes('No such file') || out.includes('is not recognized')) {
                            continue;
                        }
                        return { passed: false, output: out.slice(0, 800) };
                    }
                }
                return { passed: false, output: 'Could not find pytest or python to run tests.' };
            }

            // JS/TS: not auto-run (expensive, project-specific setup)
            return { passed: false, output: 'JS/TS test auto-run not supported. Run manually.' };
        } catch {
            return { passed: false, output: 'Test runner failed to execute.' };
        }
    }

    /** Returns true if autoRunTests is enabled in settings. */
    private shouldRunTests(): boolean {
        try {
            const vscode = require('vscode') as typeof import('vscode');
            return vscode.workspace.getConfiguration('ollamaAgent').get<boolean>('autoRunTests', false);
        } catch {
            return false;
        }
    }

    /**
     * Scan app/models/ for SQLAlchemy ForeignKey and relationship() declarations.
     * Returns a map of className → human-readable relation strings.
     * e.g. User → ["Profile (1:1 via profile)", "Orders (1:many via orders)"]
     */
    private buildModelRelationshipMap(root: string): Array<{ className: string; relations: string[] }> {
        const result: Array<{ className: string; relations: string[] }> = [];
        const modelsDir = path.join(root, 'app', 'models');
        if (!fs.existsSync(modelsDir)) { return result; }

        try {
            const files = fs.readdirSync(modelsDir).filter(f => f.endsWith('.py') && f !== '__init__.py');
            for (const f of files) {
                const content = fs.readFileSync(path.join(modelsDir, f), 'utf8');
                const lines = content.split('\n');

                let currentClass = '';
                const classRelations = new Map<string, string[]>();

                for (const line of lines) {
                    // Track current class
                    const classMatch = line.match(/^class\s+(\w+)\s*[\(:]/);
                    if (classMatch) {
                        currentClass = classMatch[1];
                        if (!classRelations.has(currentClass)) { classRelations.set(currentClass, []); }
                        continue;
                    }
                    if (!currentClass) { continue; }

                    const rels = classRelations.get(currentClass)!;

                    // db.relationship('OtherModel', ...) or relationship('OtherModel', ...)
                    const relMatch = line.match(/(?:db\.)?relationship\(\s*['"](\w+)['"]/);
                    if (relMatch) {
                        const target = relMatch[1];
                        const attrMatch = line.match(/^\s+(\w+)\s*=/);
                        const attr = attrMatch ? attrMatch[1] : '';
                        const uselist = /uselist\s*=\s*False/i.test(line) ? '1:1' : '1:many';
                        rels.push(`${target} (${uselist}${attr ? ' via ' + attr : ''})`);
                        continue;
                    }

                    // db.ForeignKey('table.col') — infer the referenced table
                    const fkMatch = line.match(/(?:db\.)?ForeignKey\(\s*['"](\w+)\./);
                    if (fkMatch) {
                        const table = fkMatch[1];
                        const attrMatch = line.match(/^\s+(\w+)\s*=/);
                        const attr = attrMatch ? attrMatch[1] : '';
                        rels.push(`→ ${table}${attr ? ' (' + attr + ')' : ''} [FK]`);
                    }
                }

                for (const [cls, rels] of classRelations) {
                    if (rels.length > 0) { result.push({ className: cls, relations: rels }); }
                }
            }
        } catch { /* skip */ }

        return result;
    }

    /**
     * Walk the call graph outward from `seedFn` up to `maxHops` hops.
     * At each hop, greps for callers of each function found in the previous hop.
     * Returns deduplicated reference lines and the deepest hop reached.
     *
     * Example: get_user → check_permissions (hop 1) → 15 routes (hop 2)
     * Inject: "get_user affects 16 locations across 2 hops"
     */
    private walkCallGraph(
        seedFn: string,
        excludeRelPath: string,
        root: string,
        maxHops: number,
        maxNodes: number
    ): { lines: string[]; maxHop: number } {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { execSync } = require('child_process') as typeof import('child_process');
        const isWin = process.platform === 'win32';
        const rootNorm = root.replace(/\\/g, '/');
        const excludeNorm = excludeRelPath.replace(/\\/g, '/');

        // Map from function name → calling locations (relPath:line)
        const allLines = new Set<string>();
        // Functions found at the current frontier
        let frontier = new Set<string>([seedFn]);
        let maxHop = 0;

        for (let hop = 1; hop <= maxHops && frontier.size > 0 && allLines.size < maxNodes; hop++) {
            const nextFrontier = new Set<string>();

            for (const fn of frontier) {
                if (allLines.size >= maxNodes) { break; }
                try {
                    const searchDir = fs.existsSync(path.join(root, 'app'))
                        ? path.join(root, 'app')
                        : root;
                    const grepCmd = isWin
                        ? `findstr /s /n "${fn}" "${searchDir}\\*.py" 2>nul`
                        : `grep -rn --include="*.py" "\\b${fn}\\b" "${searchDir}" 2>/dev/null`;
                    const raw = execSync(grepCmd, { timeout: 3000, encoding: 'utf8' }).toString();

                    const callerLines = raw.split('\n')
                        .filter(l => l.trim())
                        .filter(l => !l.includes(`def ${fn}`))
                        .filter(l => !l.replace(/\\/g, '/').includes(excludeNorm))
                        .slice(0, Math.min(8, maxNodes - allLines.size));

                    for (const l of callerLines) {
                        const parts = l.split(':');
                        if (parts.length < 2) { continue; }
                        const filePart = parts[0].replace(/\\/g, '/').replace(rootNorm + '/', '');
                        const normalized = `  ${filePart}:${parts[1].trim()}  (via \`${fn}\`)`;
                        if (!allLines.has(normalized)) {
                            allLines.add(normalized);
                            // Extract the enclosing function name from this caller line
                            // so we can continue the graph walk at the next hop
                            const callerFnMatch = l.match(/def\s+(\w+)\s*\(/) ?? l.match(/function\s+(\w+)\s*\(/);
                            if (callerFnMatch && callerFnMatch[1] !== fn && callerFnMatch[1].length > 3) {
                                nextFrontier.add(callerFnMatch[1]);
                            }
                        }
                    }
                    if (callerLines.length > 0) { maxHop = hop; }
                } catch { /* grep unavailable or timed out — stop this branch */ }
            }

            frontier = nextFrontier;
        }

        return { lines: [...allLines], maxHop };
    }

    private validateNewContent(newContent: string): string | null {
        const root = this.workspaceRoot;
        if (!root) { return null; }
        const importRe = /from\s+(app\.[\w.]+)\s+import\s+([\w,\s]+)/g;
        const missing: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = importRe.exec(newContent)) !== null) {
            const modPath = match[1].replace(/\./g, '/');
            const candidates = [
                path.join(root, modPath + '.py'),
                path.join(root, modPath, '__init__.py'),
            ];
            if (!candidates.some(c => fs.existsSync(c))) {
                missing.push(match[1]);
            }
        }
        if (missing.length === 0) { return null; }
        // Try to suggest the correct module for each missing one
        const suggestions: string[] = [];
        for (const m of missing) {
            const lastName = m.split('.').pop() ?? '';
            // Search for the name in known utility files
            const searchDirs = ['app/utils', 'app'];
            let found = '';
            for (const sd of searchDirs) {
                const sdAbs = path.join(root, sd);
                try {
                    for (const f of fs.readdirSync(sdAbs)) {
                        if (!f.endsWith('.py')) { continue; }
                        const fContent = fs.readFileSync(path.join(sdAbs, f), 'utf8');
                        if (fContent.includes(`def ${lastName}`) || fContent.includes(`class ${lastName}`)) {
                            const rel2 = sd.replace(/\//g, '.') + '.' + f.replace('.py', '');
                            found = `  - Use \`from ${rel2} import ${lastName}\` instead`;
                            break;
                        }
                    }
                } catch { /* skip */ }
                if (found) { break; }
            }
            suggestions.push(`  - ${m}${found ? '\n' + found : ''}`);
        }
        return `Edit blocked: the following module(s) do not exist on disk:\n${suggestions.join('\n')}\nFix the import path and retry edit_file immediately — do NOT ask the user.`;
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
        // Must specifically be about import paths / file locations — not general code edits
        const hasPathKeyword = /\b(import path|import location|module path|reorganiz|moved|new folder|new director)\b/i.test(msg)
            || (/\b(path|import|reference)\b/i.test(msg) && /\b(update|fix|point|adjust|rewrite)\b/i.test(msg));
        if (!hasPathKeyword) { return ''; }

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

    /** Find first file in the workspace whose basename matches the given filename exactly. */
    private findFileByName(filename: string, root: string): string | null {
        const target = filename.toLowerCase();
        const walk = (dir: string): string | null => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
            for (const e of entries) {
                if (SKIP_DIRS.has(e.name)) { continue; }
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    const found = walk(full);
                    if (found) { return found; }
                } else if (e.name.toLowerCase() === target) {
                    return full;
                }
            }
            return null;
        };
        return walk(root);
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

    /**
     * Programmatically wrap Python route functions that lack try/except error handling.
     * Operates directly on the file — no model involvement for the wrapping logic.
     * Returns true if it handled the task (caller should skip the model loop).
     */
    private async sweepAddErrorHandling(userMessage: string, post: PostFn): Promise<boolean> {
        const root = this.workspaceRoot;
        if (!root) { logInfo('[error-sweep] no workspaceRoot — skipping'); return false; }

        // Resolve target file from explicit path in message
        const fileMatch = userMessage.match(/\b([\w./\\-]+\.py)\b/i);
        if (!fileMatch) { logInfo('[error-sweep] no .py file found in message — skipping'); return false; }

        const relPath = fileMatch[1].replace(/\\/g, '/');
        const absPath = path.resolve(root, relPath);
        logInfo(`[error-sweep] target: ${relPath} → ${absPath} (exists: ${fs.existsSync(absPath)})`);
        if (!fs.existsSync(absPath)) { return false; }

        const originalContent = fs.readFileSync(absPath, 'utf8');
        const lines = originalContent.split('\n');

        // ── Parse route functions ────────────────────────────────────────────
        // Find each def that is part of a route (has @*.route decorator above it).
        // For each, find its body extent and check if already wrapped in try/except.
        interface RouteFunc {
            defLine: number;       // 0-based index of "def ..." line
            bodyStart: number;     // 0-based index of first body line
            bodyEnd: number;       // 0-based index of last body line (inclusive)
            indent: string;        // indentation of the def line
            hasErrorHandling: boolean;
        }

        const routeFuncs: RouteFunc[] = [];

        for (let i = 0; i < lines.length; i++) {
            const defMatch = lines[i].match(/^(\s*)def\s+\w+\s*\(/);
            if (!defMatch) { continue; }

            // Check if preceded by a @*.route decorator (within 5 lines)
            let isRoute = false;
            for (let k = Math.max(0, i - 5); k < i; k++) {
                if (/^\s*@\w+\.route\(/.test(lines[k])) { isRoute = true; break; }
            }
            if (!isRoute) { continue; }

            const indent = defMatch[1];
            const bodyIndent = indent + '    ';

            // Find body start — first non-blank, non-docstring line after def
            let bodyStart = i + 1;
            // Skip docstring if present
            if (lines[bodyStart]?.trim().startsWith('"""') || lines[bodyStart]?.trim().startsWith("'''")) {
                const quote = lines[bodyStart].trim().startsWith('"""') ? '"""' : "'''";
                if ((lines[bodyStart].match(new RegExp(quote, 'g')) ?? []).length >= 2) {
                    bodyStart++; // single-line docstring
                } else {
                    bodyStart++;
                    while (bodyStart < lines.length && !lines[bodyStart].includes(quote)) { bodyStart++; }
                    bodyStart++; // past closing triple-quote
                }
            }

            // Find body end — last line before next def/decorator at same or lesser indent
            let bodyEnd = bodyStart;
            for (let j = bodyStart; j < lines.length; j++) {
                const trimmed = lines[j].trim();
                if (trimmed === '') { continue; }
                // Next function/class at same indent level = end of this function
                if (/^(@|\bdef\b|\bclass\b)/.test(trimmed) && !lines[j].startsWith(bodyIndent)) { break; }
                bodyEnd = j;
            }

            // Check if body is already wrapped in try/except
            const hasErrorHandling = /^\s*try\s*:/.test(lines[bodyStart] ?? '');

            routeFuncs.push({ defLine: i, bodyStart, bodyEnd, indent, hasErrorHandling });
        }

        const toWrap = routeFuncs.filter(f => !f.hasErrorHandling);
        if (toWrap.length === 0) {
            // All routes already have error handling — tell the user
            post({ type: 'streamStart' });
            const msg = `All ${routeFuncs.length} route(s) in \`${relPath}\` already have error handling. No changes needed.`;
            for (const ch of msg) { post({ type: 'token', text: ch }); }
            post({ type: 'streamEnd' });
            this.history.push({ role: 'assistant', content: msg });
            return true;
        }

        logInfo(`[error-sweep] ${relPath}: ${routeFuncs.length} routes, ${toWrap.length} need wrapping`);

        // Post a visible context read
        const readId = `sweep_read_${Date.now()}`;
        post({ type: 'toolCall', id: readId, name: 'shell_read', args: { command: `cat "${relPath}"` } });
        post({ type: 'toolResult', id: readId, name: 'shell_read', success: true, preview: `${lines.length} lines, ${toWrap.length} routes need error handling` });

        // ── Apply wraps bottom-up (so line indices stay valid) ───────────────
        const newLines = [...lines];
        const wrapped: string[] = [];

        for (const fn of [...toWrap].reverse()) {
            const bodyIndent = fn.indent + '    ';
            const bodyLines = newLines.slice(fn.bodyStart, fn.bodyEnd + 1);

            // Indent each body line by 4 more spaces
            const indentedBody = bodyLines.map(l => l === '' ? l : '    ' + l);

            // Build replacement: try: + indented body + except clause
            const tryBlock = [
                `${bodyIndent}try:`,
                ...indentedBody,
                `${bodyIndent}except Exception as e:`,
                `${bodyIndent}    return jsonify({'error': str(e)}), 500`,
            ];

            // Get the function name for reporting
            const fnName = newLines[fn.defLine].match(/def\s+(\w+)/)?.[1] ?? '?';
            wrapped.unshift(fnName); // unshift because we're iterating reversed

            // Replace body lines with wrapped version
            newLines.splice(fn.bodyStart, fn.bodyEnd - fn.bodyStart + 1, ...tryBlock);

            // Post each edit as a visible tool call
            const editId = `sweep_edit_${Date.now()}_${fnName}`;
            post({
                type: 'toolCall', id: editId, name: 'edit_file_at_line',
                args: { path: relPath, start_line: fn.bodyStart + 1, end_line: fn.bodyEnd + 1 }
            });
            post({ type: 'toolResult', id: editId, name: 'edit_file_at_line', success: true, preview: `Wrapped ${fnName} in try/except` });
        }

        // Write the modified file
        fs.writeFileSync(absPath, newLines.join('\n'), 'utf8');
        logInfo(`[error-sweep] Wrote ${newLines.length} lines to ${relPath}`);

        // Summary message
        const summary = `Added error handling to **${wrapped.length}** route(s) in \`${relPath}\`:\n${wrapped.map(n => `- \`${n}\``).join('\n')}\n\n${routeFuncs.length - toWrap.length > 0 ? `${routeFuncs.length - toWrap.length} route(s) already had try/except and were left unchanged.` : ''}`.trim();
        post({ type: 'streamStart' });
        for (const ch of summary) { post({ type: 'token', text: ch }); }
        post({ type: 'streamEnd' });
        this.history.push({ role: 'assistant', content: summary });
        return true;
    }

    private async preProcessEditTask(userMessage: string, post: PostFn): Promise<{ injection: string; blocked: string | null; pendingSteps: string[] }> {
        const root = this.workspaceRoot;

        // ── 1. Extract keywords ──────────────────────────────────────────────
        const filenameKeywords: string[] = [];

        const serviceMatch = userMessage.match(
            /\b(?:the\s+)?(\w+(?:[\s_-]\w+)*?)\s+(?:service|module|handler|controller|view|model|util|helper|component|route|router|api)\b/i
        );
        if (serviceMatch) {
            const svc = serviceMatch[1].toLowerCase().replace(/\s+/g, '_');
            filenameKeywords.push(svc);
            svc.split(/[_-]/).filter(w => w.length > 2).forEach(w => filenameKeywords.push(w));
        }

        const fileMatch = userMessage.match(/\b([\w./\\-]+\.(?:py|ts|js|go|java|rs|rb|php|c|cpp|cs))\b/i);
        if (fileMatch) {
            filenameKeywords.push(path.basename(fileMatch[1]).replace(/\.\w+$/, '').toLowerCase());
        }

        const STOP = new Set(['add','insert','fix','update','change','modify','implement',
            'the','a','an','to','in','on','of','for','whenever','when','every','time',
            'that','this','so','and','or','with','by','from','at','into','should',
            'would','could','will','can','all','any','some','statement','log','logging',
            'make','sure','please','just','need','want','also','returns','return',
            'list','json','endpoint','function','method']);
        const contentKws = userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !STOP.has(w)).slice(0, 5);
        if (filenameKeywords.length === 0) { filenameKeywords.push(...contentKws); }

        // ── 2. Detect project type ───────────────────────────────────────────
        const hasTs = fs.existsSync(path.join(root, 'tsconfig.json')) || fs.existsSync(path.join(root, 'package.json'));
        const hasPy = fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'setup.py'));
        const extensions = hasPy ? ['.py'] : hasTs ? ['.ts', '.js', '.tsx', '.jsx'] : ['.py', '.ts', '.js', '.go', '.java', '.rs'];

        if (filenameKeywords.length === 0) { return { injection: '', blocked: null, pendingSteps: [] }; }

        const fullServiceName = serviceMatch ? serviceMatch[1].toLowerCase() : undefined;

        // ── 3. Resolve target file ───────────────────────────────────────────
        // Explicit path beats everything — resolve directly and skip semantic search
        let targetRelPath: string | null = null;
        let targetContent: string | null = null;

        if (fileMatch) {
            const explicitRel = fileMatch[1].replace(/\\/g, '/');
            const explicitAbs = path.resolve(root, explicitRel);
            if (fs.existsSync(explicitAbs) && fs.statSync(explicitAbs).size <= 150_000) {
                targetRelPath = explicitRel;
                targetContent = fs.readFileSync(explicitAbs, 'utf8');
                logInfo(`[pre-edit] Explicit file: ${explicitRel} (${targetContent.split('\n').length} lines)`);
            } else if (!explicitRel.includes('/') && !explicitRel.includes('\\')) {
                // Bare filename (e.g. "user.py") — search the workspace for it
                const found = this.findFileByName(explicitRel, root);
                if (found) {
                    try {
                        const stat = fs.statSync(found);
                        if (stat.size <= 150_000) {
                            targetContent = fs.readFileSync(found, 'utf8');
                            targetRelPath = path.relative(root, found).replace(/\\/g, '/');
                            logInfo(`[pre-edit] Bare filename resolved: ${targetRelPath}`);
                        }
                    } catch { /* skip */ }
                }
            }
        }

        if (!targetRelPath) {
            // Semantic/keyword search
            logInfo(`[pre-edit] Searching — keywords: [${filenameKeywords.join(', ')}], exts: [${extensions.join(', ')}]`);
            let candidates: Array<{ relPath: string; absPath: string; score: number }>;
            if (this.codeIndex) {
                const indexResults = await this.codeIndex.findRelevantFiles(userMessage, 5);
                candidates = indexResults.map(r => ({ relPath: r.relPath, absPath: r.absPath, score: Math.round(r.score * 100) }));
                if (candidates.length === 0) {
                    candidates = this.findEditCandidates(filenameKeywords, extensions, fullServiceName);
                }
            } else {
                candidates = this.findEditCandidates(filenameKeywords, extensions, fullServiceName);
            }

            if (candidates.length === 0) {
                logInfo('[pre-edit] No candidates found — falling through');
                return { injection: '', blocked: null, pendingSteps: [] };
            }

            // Re-rank: if any candidate's basename exactly matches a filename keyword,
            // always prefer it — semantic index may rank semantically similar files higher
            // than the exact filename match (e.g. device.py ranked above user.py for "User model")
            const exactMatch = candidates.find(c => {
                const base = path.basename(c.relPath, path.extname(c.relPath)).toLowerCase();
                return filenameKeywords.some(kw => base === kw);
            });
            if (exactMatch) {
                candidates = [exactMatch, ...candidates.filter(c => c !== exactMatch)];
            }

            // Read top candidates, pick highest content-keyword score
            for (const c of candidates.slice(0, 3)) {
                try {
                    const stat = fs.statSync(c.absPath);
                    if (stat.size > 150_000) { continue; }
                    const content = fs.readFileSync(c.absPath, 'utf8');
                    const lower = content.toLowerCase();
                    const hits = contentKws.reduce((acc, w) => {
                        let n = 0, pos = 0;
                        while ((pos = lower.indexOf(w, pos)) !== -1) { n++; pos++; }
                        return acc + n;
                    }, 0);
                    if (!targetRelPath || hits > 0) {
                        targetRelPath = c.relPath;
                        targetContent = content;
                        if (hits > 0) { break; } // good enough
                    }
                } catch { /* skip */ }
            }
        }

        if (!targetRelPath || !targetContent) {
            logInfo('[pre-edit] Could not read target file — falling through');
            return { injection: '', blocked: null, pendingSteps: [] };
        }

        // ── 3b. Proactive stub detection ──────────────────────────────────────
        // If the resolved file is a stub (< 15 lines, no real HTML markers), find the real file
        // and redirect the model BEFORE it ever sees the stub content.
        const isHtmlTarget = /\.html$/i.test(targetRelPath);
        let stubWarning = '';
        let stubRealFile: { relPath: string; content: string } | null = null;
        if (isHtmlTarget) {
            const stubLineCount = targetContent.split('\n').length;
            const hasRealMarkers = /<!DOCTYPE|<html|{%\s*extends|{%\s*block/i.test(targetContent);
            if (stubLineCount < 15 && !hasRealMarkers) {
                logInfo(`[pre-edit] Stub detected: ${targetRelPath} (${stubLineCount} lines, no HTML markers) — searching for real template`);
                // Extract a keyword from the stub to drive the search
                const stubKw = targetContent.match(/\{\{\s*form\.(\w+)|id=["'](\w+)["']|name=["'](\w+)["']/)?.[1]
                    ?? path.basename(targetRelPath, '.html').replace(/[_-]/g, ' ');
                // Walk app/templates recursively for large HTML files containing the keyword
                const templatesDir = path.join(root, 'app', 'templates');
                if (fs.existsSync(templatesDir)) {
                    const walkHtml = (dir: string): string[] => {
                        const results: string[] = [];
                        try {
                            for (const f of fs.readdirSync(dir)) {
                                const abs = path.join(dir, f);
                                try {
                                    const st = fs.statSync(abs);
                                    if (st.isDirectory()) { results.push(...walkHtml(abs)); }
                                    else if (f.endsWith('.html') && st.size > 5_000) { results.push(abs); }
                                } catch { /* skip */ }
                            }
                        } catch { /* skip */ }
                        return results;
                    };
                    const htmlFiles = walkHtml(templatesDir);
                    for (const absHtml of htmlFiles) {
                        try {
                            const c = fs.readFileSync(absHtml, 'utf8');
                            if (/<!DOCTYPE|<html|{%\s*extends|{%\s*block/i.test(c) && c.toLowerCase().includes(stubKw.toLowerCase())) {
                                const rel = path.relative(root, absHtml).replace(/\\/g, '/');
                                stubRealFile = { relPath: rel, content: c };
                                logInfo(`[pre-edit] Real template found: ${rel}`);
                                break;
                            }
                        } catch { /* skip */ }
                    }
                }
                if (stubRealFile) {
                    const stubOrigPath = targetRelPath;
                    stubWarning = `⚠ STUB REDIRECT: "${stubOrigPath}" is a stub placeholder (${stubLineCount} lines, no HTML structure). ` +
                        `The real template is "${stubRealFile.relPath}". ` +
                        `Do NOT edit the stub — all edits must go to the real file shown below.`;
                    // Swap target to the real file
                    targetRelPath = stubRealFile.relPath;
                    targetContent = stubRealFile.content;
                    logInfo(`[pre-edit] Redirected target from stub to: ${targetRelPath}`);
                    // Update task state machine
                    if (this._activeTask) {
                        if (!this._activeTask.filesRuledOut.includes(stubOrigPath)) {
                            this._activeTask.filesRuledOut.push(stubOrigPath);
                        }
                        if (!this._activeTask.filesConfirmed.includes(targetRelPath)) {
                            this._activeTask.filesConfirmed.push(targetRelPath);
                        }
                    }
                    // Save discovery to memory
                    if (this.memory) {
                        const memNote = `Stub redirect: stub at "${stubOrigPath}" → real template: "${stubRealFile.relPath}" (${stubRealFile.content.split('\n').length} lines).`;
                        this.memory.addEntry(2, memNote, ['stub', 'template', 'auto-discovery']).catch(() => {});
                    }
                } else {
                    stubWarning = `⚠ STUB WARNING: "${targetRelPath}" appears to be a stub placeholder (${stubLineCount} lines, no HTML structure). ` +
                        `Search app/templates/ for the real template before editing.`;
                }
            }
        }

        // ── 4. Research phase — gather grounded context ──────────────────────
        // 4a. Models inventory (Python only): scan app/models/ for real class names
        const modelsInventory: Array<{ className: string; relPath: string }> = [];
        if (hasPy) {
            const modelsDir = path.join(root, 'app', 'models');
            if (fs.existsSync(modelsDir)) {
                try {
                    const modelFiles = fs.readdirSync(modelsDir)
                        .filter(f => f.endsWith('.py') && f !== '__init__.py');
                    for (const mf of modelFiles) {
                        try {
                            const mContent = fs.readFileSync(path.join(modelsDir, mf), 'utf8');
                            const classMatches = [...mContent.matchAll(/^class\s+(\w+)\s*[\(:]/gm)];
                            for (const cm of classMatches) {
                                modelsInventory.push({
                                    className: cm[1],
                                    relPath: `app/models/${mf}`,
                                });
                            }
                        } catch { /* skip unreadable */ }
                    }
                } catch { /* skip unreadable dir */ }
                logInfo(`[pre-edit] Models inventory: ${modelsInventory.length} classes from app/models/`);
            }
        } else if (hasTs) {
            // TypeScript inventory: scan src/types/, src/models/, src/interfaces/ for exported interfaces/enums/classes
            const tsDirs = ['src/types', 'src/models', 'src/interfaces', 'types', 'models'].map(d => path.join(root, d));
            for (const tsDir of tsDirs) {
                if (!fs.existsSync(tsDir)) { continue; }
                try {
                    const tsFiles = fs.readdirSync(tsDir).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'));
                    for (const tf of tsFiles) {
                        try {
                            const tContent = fs.readFileSync(path.join(tsDir, tf), 'utf8');
                            const re = /^export\s+(?:interface|type|enum|class)\s+(\w+)/gm;
                            const tRelPath = path.relative(root, path.join(tsDir, tf)).replace(/\\/g, '/');
                            for (const m of tContent.matchAll(re)) {
                                modelsInventory.push({ className: m[1], relPath: tRelPath });
                            }
                        } catch { /* skip */ }
                    }
                } catch { /* skip */ }
            }
            logInfo(`[pre-edit] TS types inventory: ${modelsInventory.length} exported types`);
        }

        // 4a-ii. Data model relationship map (Python only, when editing a models file)
        // Scans app/models/ for SQLAlchemy relationships and ForeignKeys.
        // Injected when the target file is inside app/models/ or the user message
        // references a model that has relationships.
        let modelRelMap: Array<{ className: string; relations: string[] }> = [];
        const isModelEdit = targetRelPath.includes('models/') || /\b(model|schema|migration|foreign.?key|relationship)\b/i.test(userMessage);
        if (hasPy && isModelEdit && modelsInventory.length > 0) {
            modelRelMap = this.buildModelRelationshipMap(root);
            logInfo(`[pre-edit] Model relationship map: ${modelRelMap.length} models with relations`);
        }

        // 4b. Route/function/field inventory from the target file itself
        const targetLines = targetContent.split('\n');
        const definedRoutes: string[] = [];   // "@bp.route('/path', ...)"
        const definedFunctions: string[] = []; // "def func_name"
        const definedFields: string[] = [];    // "field = db.Column(...)" / "field: Type"
        const importedNames: string[] = [];    // "from X import Y, Z" → Y, Z

        for (const line of targetLines) {
            // Python Flask route
            const routeMatch = line.match(/^\s*@\w+\.route\(['"]([^'"]+)['"]/);
            if (routeMatch) { definedRoutes.push(routeMatch[1]); }

            // Express: router.get('/path', ...) / app.post('/path', ...)
            const expressMatch = line.match(/(?:router|app)\.\s*(?:get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/);
            if (expressMatch) { definedRoutes.push(expressMatch[1]); }

            // Next.js App Router: export async function GET / POST / PUT / DELETE / PATCH
            const nextMatch = line.match(/^export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD)\s*\(/);
            if (nextMatch) { definedRoutes.push(`[${nextMatch[1]}] (Next.js handler)`); }

            const defMatch = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
            if (defMatch && !defMatch[1].startsWith('_')) { definedFunctions.push(defMatch[1]); }

            // TypeScript: export function / export const foo = / class Foo
            const tsFnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/);
            if (tsFnMatch) { definedFunctions.push(tsFnMatch[1] || tsFnMatch[2]); }

            // Python SQLAlchemy column: "    field_name = db.Column(...)"
            const pyColMatch = line.match(/^\s{4,}(\w+)\s*=\s*(?:db\.|sa\.)?Column\s*\(/);
            if (pyColMatch) { definedFields.push(pyColMatch[1]); }

            // Python SQLAlchemy relationship: "    field_name = db.relationship(...)"
            const pyRelMatch = line.match(/^\s{4,}(\w+)\s*=\s*(?:db\.|sa\.)?relationship\s*\(/);
            if (pyRelMatch) { definedFields.push(pyRelMatch[1]); }

            // TypeScript class property: "  fieldName: Type" or "  fieldName = value"
            const tsPropMatch = line.match(/^\s{2,4}(\w+)\s*[=:]/);
            if (tsPropMatch && !tsFnMatch && !line.trim().startsWith('//')) {
                definedFields.push(tsPropMatch[1]);
            }

            const importMatch = line.match(/^(?:from\s+\S+\s+import\s+(.+)|import\s+\{([^}]+)\})/);
            if (importMatch) {
                const names = (importMatch[1] || importMatch[2] || '')
                    .split(',').map(s => s.trim().replace(/\s+as\s+\w+/, '').trim()).filter(Boolean);
                importedNames.push(...names);
            }
        }

        // ── 4c. Column/field existence check (Fix 1c) ────────────────────────
        // When task is "add X field/column to form/template", check whether the column
        // already exists in the model file. If it does, redirect: model job is form+JS only.
        let columnExistsNote = '';
        const isAddFieldTask = /\badd\b.{0,40}\b(field|column|input|attribute)\b/i.test(userMessage)
            || /\b(field|column)\b.{0,40}\b(form|template|inline)\b/i.test(userMessage);
        if (isAddFieldTask && hasPy) {
            // Extract the field name from the user message
            const fieldMatch = userMessage.match(
                /\badd\s+(?:a\s+|an\s+)?(?:new\s+)?[`"']?([a-z][a-z0-9_]*(?:[\s_][a-z0-9_]+){0,3})[`"']?\s+(?:field|column|input|attribute)/i
            ) ?? userMessage.match(/[`"']([a-z][a-z0-9_]+)[`"']/i);
            const rawFieldName = fieldMatch?.[1]?.trim().toLowerCase().replace(/\s+/g, '_') ?? '';
            if (rawFieldName.length > 2) {
                // Look in every model file for this column
                const modelsDir = path.join(root, 'app', 'models');
                if (fs.existsSync(modelsDir)) {
                    for (const mf of fs.readdirSync(modelsDir).filter(f => f.endsWith('.py'))) {
                        try {
                            const mc = fs.readFileSync(path.join(modelsDir, mf), 'utf8');
                            // Match: field_name = db.Column(... or field_name = Column(...
                            const colRe = new RegExp(`^\\s{4,}(${rawFieldName})\\s*=\\s*(?:db\\.|sa\\.)?Column\\s*\\(`, 'im');
                            const colMatch = mc.match(colRe);
                            if (colMatch) {
                                columnExistsNote = `✓ Column \`${colMatch[1]}\` already exists in \`app/models/${mf}\`. ` +
                                    `Do NOT add it to the model again. Your task is to add the form field to the HTML template and the JS submit handler only.`;
                                logInfo(`[pre-edit] Column exists: ${colMatch[1]} in ${mf}`);
                                // Save to memory
                                if (this.memory) {
                                    const memNote = `Column \`${colMatch[1]}\` confirmed in app/models/${mf} (checked ${new Date().toLocaleDateString()}).`;
                                    this.memory.addEntry(2, memNote, ['schema', 'auto-discovery']).catch(() => {});
                                }
                                break;
                            }
                        } catch { /* skip */ }
                    }
                }
            }
        }

        // ── 4d. Full-stack breadcrumb for form tasks (Fix 1a) ─────────────────
        // When task involves a form field (add/update field in form/template),
        // proactively find the JS submit handler and the backend route that processes the POST.
        // Inject all three file locations so the model knows the full surface area.
        interface FormFile { relPath: string; lineHint: number; snippet: string }
        let formJsHandler: FormFile | null = null;
        let formBackendRoute: FormFile | null = null;
        const isFormTask = /\b(form|template|inline|frontend|html)\b/i.test(userMessage)
            || /\badd\b.{0,40}\b(field|column|input)\b/i.test(userMessage);
        if (isFormTask && hasPy) {
            // Extract entity keyword (e.g. "transaction", "customer") from user message
            const entityKw = userMessage.toLowerCase().match(
                /\b(transaction|customer|cashier|product|inventory|order|invoice|sale|item|vehicle|employee|staff)\b/
            )?.[1] ?? contentKws[0] ?? '';

            // Search JS files for a submit/fetch/ajax call referencing this entity
            const staticDir = path.join(root, 'app', 'static');
            const walkJs = (dir: string): string[] => {
                const out: string[] = [];
                try {
                    for (const f of fs.readdirSync(dir)) {
                        const abs = path.join(dir, f);
                        try {
                            if (fs.statSync(abs).isDirectory()) { out.push(...walkJs(abs)); }
                            else if (/\.(js|ts)$/.test(f) && !/\.min\.js$/.test(f)) { out.push(abs); }
                        } catch { /* skip */ }
                    }
                } catch { /* skip */ }
                return out;
            };
            const jsFiles = fs.existsSync(staticDir) ? walkJs(staticDir) : [];
            for (const jsAbs of jsFiles) {
                try {
                    const jsContent = fs.readFileSync(jsAbs, 'utf8');
                    const jsLines = jsContent.split('\n');
                    // Look for fetch/XMLHttpRequest/$.ajax referencing the entity AND form data
                    const submitIdx = jsLines.findIndex((l, i) => {
                        const lower = l.toLowerCase();
                        return (lower.includes('fetch(') || lower.includes('xmlhttprequest') || lower.includes('$.ajax') || lower.includes('formdata'))
                            && (entityKw ? jsContent.toLowerCase().includes(entityKw) : true)
                            && (jsLines.slice(Math.max(0, i - 5), i + 10).some(ll => /append|formdata|body.*json|submit/i.test(ll)));
                    });
                    if (submitIdx >= 0) {
                        const snippet = jsLines.slice(Math.max(0, submitIdx - 2), Math.min(jsLines.length, submitIdx + 8)).join('\n');
                        formJsHandler = {
                            relPath: path.relative(root, jsAbs).replace(/\\/g, '/'),
                            lineHint: submitIdx + 1,
                            snippet,
                        };
                        logInfo(`[pre-edit] JS submit handler: ${formJsHandler.relPath} ~line ${submitIdx + 1}`);
                        if (this.memory) {
                            this.memory.addEntry(2,
                                `JS submit handler for ${entityKw || 'form'}: ${formJsHandler.relPath} ~line ${submitIdx + 1}`,
                                ['js-handler', 'form', 'auto-discovery']
                            ).catch(() => {});
                        }
                        break;
                    }
                } catch { /* skip */ }
            }

            // Search Python routes for a POST handler referencing the entity
            const routesDir = path.join(root, 'app', 'routes');
            const routesDirAlt = path.join(root, 'app', 'views');
            const routesSearch = [routesDir, routesDirAlt].filter(d => fs.existsSync(d));
            outer: for (const rDir of routesSearch) {
                for (const rf of fs.readdirSync(rDir).filter(f => f.endsWith('.py'))) {
                    try {
                        const rc = fs.readFileSync(path.join(rDir, rf), 'utf8');
                        const rcLines = rc.split('\n');
                        const postIdx = rcLines.findIndex((l, i) => {
                            return /['"]POST['"]/i.test(l)
                                && (entityKw ? rc.toLowerCase().includes(entityKw) : true)
                                && rcLines.slice(Math.max(0, i - 1), i + 3).some(ll => /@\w+\.route/.test(ll));
                        });
                        if (postIdx >= 0) {
                            const snippet = rcLines.slice(Math.max(0, postIdx - 1), Math.min(rcLines.length, postIdx + 8)).join('\n');
                            formBackendRoute = {
                                relPath: path.relative(root, path.join(rDir, rf)).replace(/\\/g, '/'),
                                lineHint: postIdx + 1,
                                snippet,
                            };
                            logInfo(`[pre-edit] Backend POST route: ${formBackendRoute.relPath} ~line ${postIdx + 1}`);
                            if (this.memory) {
                                this.memory.addEntry(2,
                                    `Backend POST route for ${entityKw || 'form'}: ${formBackendRoute.relPath} ~line ${postIdx + 1}`,
                                    ['route', 'form', 'auto-discovery']
                                ).catch(() => {});
                            }
                            break outer;
                        }
                    } catch { /* skip */ }
                }
            }
        }

        // ── 4e. Caller/reference impact analysis (transitive, up to 3 hops) ────────
        // Check if user is modifying a specific named function that already exists.
        // Walk the call graph outward: direct callers → callers of callers → one more hop.
        // Cap at 3 hops, 20 total nodes to avoid context explosion.
        const callerReport: Array<{ funcName: string; callers: string[]; hopCount: number }> = [];

        if (definedFunctions.length > 0 && root) {
            const isModifyTask = /\b(modify|update|change|refactor|rename|fix|edit|improve|rewrite)\b/i.test(userMessage);
            if (isModifyTask) {
                const mentionedFuncs = definedFunctions.filter(fn =>
                    fn.length > 3 && userMessage.toLowerCase().includes(fn.toLowerCase())
                ).slice(0, 2);

                for (const fn of mentionedFuncs) {
                    const transitiveCallers = this.walkCallGraph(fn, targetRelPath, root, 3, 20);
                    if (transitiveCallers.lines.length > 0) {
                        callerReport.push({
                            funcName: fn,
                            callers: transitiveCallers.lines,
                            hopCount: transitiveCallers.maxHop,
                        });
                        logInfo(`[pre-edit] Caller graph: ${fn} → ${transitiveCallers.lines.length} refs across ${transitiveCallers.maxHop} hop(s)`);
                    }
                }
            }
        }

        // 4c. Pattern example — find a short representative route/function from the target file
        // Look for a route that returns JSON or a list — closest to what the user likely wants
        let patternExample = '';
        const patternKws = userMessage.toLowerCase();
        const isJsonTask = /json|api|list|return/.test(patternKws);

        if (hasPy && definedRoutes.length > 0) {
            // Find a route block: from @bp.route to the end of that function
            let bestStart = -1;
            for (let i = 0; i < targetLines.length; i++) {
                const l = targetLines[i];
                if (!l.match(/^\s*@\w+\.route\(/)) { continue; }
                // Prefer JSON-returning routes when user wants JSON
                if (isJsonTask) {
                    const block = targetLines.slice(i, Math.min(i + 30, targetLines.length)).join('\n');
                    if (/jsonify|\.json\(|json\.dumps/.test(block)) { bestStart = i; break; }
                }
                if (bestStart === -1) { bestStart = i; } // fallback: first route
            }
            if (bestStart >= 0) {
                // Capture from @decorator to end of function (next blank line after def + indent reset)
                const blockLines: string[] = [];
                let inFunc = false;
                let funcIndent = '';
                for (let i = bestStart; i < Math.min(bestStart + 40, targetLines.length); i++) {
                    const l = targetLines[i];
                    blockLines.push(l);
                    if (!inFunc && l.match(/^\s*def\s+/)) {
                        inFunc = true;
                        funcIndent = l.match(/^(\s*)/)?.[1] ?? '';
                        continue;
                    }
                    if (inFunc && i > bestStart + 2) {
                        // End when we're back at function indentation level with content (next def or decorator)
                        if (l.trim() && !l.startsWith(funcIndent + ' ') && l.startsWith(funcIndent) && l !== funcIndent) {
                            blockLines.pop(); break;
                        }
                    }
                }
                patternExample = blockLines.join('\n');
            }
        }

        // 4d. Pre-validate: does the user's request reference a model name that doesn't exist?
        const preValidationWarnings: string[] = [];
        if (modelsInventory.length > 0) {
            // Extract capitalised words from the user message (likely model names)
            const mentionedModels = [...userMessage.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g)].map(m => m[1]);
            for (const name of mentionedModels) {
                // Skip common non-model words
                if (/^(GET|POST|PUT|DELETE|JSON|HTTP|API|URL|SQL|UUID|ID|True|False|None|Flask|Blueprint|Login|User|Admin|Error|Exception|Response|Request|Session)$/.test(name)) { continue; }
                const exists = modelsInventory.some(m => m.className === name);
                if (!exists) {
                    preValidationWarnings.push(
                        `⚠ "${name}" is not a known model in app/models/. ` +
                        `Available models: ${modelsInventory.slice(0, 8).map(m => m.className).join(', ')}${modelsInventory.length > 8 ? '…' : ''}.`
                    );
                }
            }
        }

        // ── 5. Build numbered file content with window ───────────────────────
        const FILE_LINE_LIMIT = 600;
        let startIdx = 0;
        let endIdx = targetLines.length;

        if (targetLines.length > FILE_LINE_LIMIT) {
            const kwsForWindow = [...filenameKeywords, ...contentKws].filter(w => w.length > 3);
            const relevantIdxs = targetLines
                .map((l, i) => ({ i, hit: kwsForWindow.some(w => l.toLowerCase().includes(w)) }))
                .filter(x => x.hit).map(x => x.i);
            if (relevantIdxs.length > 0) {
                startIdx = Math.max(0, relevantIdxs[0] - 20);
                endIdx   = Math.min(targetLines.length, relevantIdxs[relevantIdxs.length - 1] + 80);
            } else {
                endIdx = Math.min(targetLines.length, FILE_LINE_LIMIT);
            }
        }

        const numberedLines = targetLines.slice(startIdx, endIdx)
            .map((l, i) => `${String(startIdx + i + 1).padStart(4, ' ')}: ${l}`)
            .join('\n');

        const ext = path.extname(targetRelPath).slice(1) || 'text';
        const windowNote = (startIdx > 0 || endIdx < targetLines.length)
            ? ` [showing lines ${startIdx + 1}–${endIdx} of ${targetLines.length}]`
            : ` [${targetLines.length} lines]`;

        // Post visible tool call for the user
        const preReadId = `pre_edit_read_${Date.now()}`;
        post({ type: 'toolCall', id: preReadId, name: 'shell_read', args: { command: `cat "${targetRelPath}"` } });
        post({ type: 'toolResult', id: preReadId, name: 'shell_read', success: true, preview: `${targetLines.length} lines` });

        // ── 5b. Programmatic duplicate pre-check (fires before model is called) ─
        // Extract the "thing being added" from the user message and check it against
        // already-defined fields/functions/routes.  If found, block immediately —
        // don't rely on the model to self-police.
        const isAddTask = /\badd\b/i.test(userMessage) && !/\b(update|modify|change|refactor|rename|fix|edit|improve|rewrite|extend|remove.*from)\b/i.test(userMessage);
        if (isAddTask && (definedFields.length > 0 || definedFunctions.length > 0 || definedRoutes.length > 0)) {
            // Pull candidate "thing name" from the message:
            // "add a phone_number field" → ["phone_number", "phone", "number"]
            // "add phone number column" → ["phone", "number"]
            const addMatch = userMessage.match(/\badd\s+(?:a\s+|an\s+)?(?:new\s+)?([a-z_][a-z0-9_]*(?:\s+[a-z_][a-z0-9_]*){0,3})/i);
            if (addMatch) {
                const rawTokens = addMatch[1].toLowerCase()
                    .replace(/\s+(field|column|property|attribute|relationship|method|function|route|endpoint)\b/gi, '')
                    .trim()
                    .split(/[\s_]+/)
                    .filter(t => t.length > 1);

                // Build candidate names: snake_case joined, and individual tokens
                const snakeJoined = rawTokens.join('_');
                const candidates = [snakeJoined, ...rawTokens];

                const allDefined = [...definedFields, ...definedFunctions, ...definedRoutes];
                const hit = candidates.find(c => allDefined.some(d => d.toLowerCase() === c.toLowerCase()
                    || d.toLowerCase().replace(/_/g, '') === c.toLowerCase().replace(/_/g, '')));

                if (hit) {
                    const matchedDef = allDefined.find(d => d.toLowerCase() === hit.toLowerCase()
                        || d.toLowerCase().replace(/_/g, '') === hit.toLowerCase().replace(/_/g, ''));
                    const msg = `Already exists: \`${matchedDef ?? hit}\` is already defined in \`${targetRelPath}\`. No change needed.`;
                    logInfo(`[pre-edit] Programmatic duplicate block: ${msg}`);
                    return { injection: '', blocked: msg, pendingSteps: [] };
                }
            }
        }

        // ── 4f. Auto-save target file resolution to memory (Fix 4a) ─────────────
        if (this.memory && targetRelPath) {
            const lineCount = targetContent.split('\n').length;
            const memNote = `Target file for "${userMessage.slice(0, 60)}": ${targetRelPath} (${lineCount} lines, resolved ${new Date().toLocaleDateString()})`;
            this.memory.isSemanticDuplicate(targetRelPath, 0.9).then(isDupe => {
                if (!isDupe) {
                    this.memory!.addEntry(2, memNote, ['file-resolution', 'auto-discovery']).catch(() => {});
                }
            }).catch(() => {});
        }

        // ── 5c. Static bug scan on target file ───────────────────────────────
        // Scan the loaded file for common obvious bugs before the model ever sees it.
        // These are injected as pre-warnings so the model fixes them instead of
        // propagating them or asking the user to clarify.
        const staticBugWarnings: string[] = [];
        if (hasPy) {
            const lines = targetContent.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lineNo = i + 1;

                // Pattern: `for x in some_dict_var:` where `some_dict_var` is initialized
                // as an empty dict `{}` earlier in the same function. Classic "iterate empty dict" bug.
                const forInMatch = line.match(/^\s*for\s+(\w+)\s+in\s+(\w+)\s*:/);
                if (forInMatch) {
                    const iterVar = forInMatch[2];
                    // Look back up to 60 lines for the variable being assigned an empty dict/list
                    for (let j = Math.max(0, i - 60); j < i; j++) {
                        const prevLine = lines[j];
                        // e.g. `field_changes = {}` or `field_changes = []`
                        if (new RegExp(`^\\s*${iterVar}\\s*=\\s*(?:\\{\\}|\\[\\])\\s*$`).test(prevLine)) {
                            const listVar = lines.slice(Math.max(0, i - 80), i)
                                .map(l => l.match(/^\s*(\w+)\s*=\s*\[/)?.[1])
                                .filter(Boolean)
                                .pop();
                            staticBugWarnings.push(
                                `⚠ BUG at line ${lineNo}: \`for ${forInMatch[1]} in ${iterVar}:\` — ` +
                                `\`${iterVar}\` is initialized as empty (${prevLine.trim()}) at line ${j + 1}, ` +
                                `so this loop body NEVER executes. Did you mean to iterate a different variable?` +
                                (listVar ? ` Nearby list variable: \`${listVar}\`.` : '')
                            );
                            break;
                        }
                    }
                }
            }
        }

        // ── 5d. File-system existence scan ───────────────────────────────────
        // For create/implement/add tasks: scan app/routes/ and app/services/ for files
        // and function definitions that match the task keywords. If found, block immediately
        // with a [FEATURE ALREADY EXISTS] message. This is purely programmatic — no model call.
        const isCreateTask = /\b(implement|create|add|build|make|set up|write)\b/i.test(userMessage)
            && !/\b(plan|discuss|design|proposal|update|modify|change|fix|remove|delete)\b/i.test(userMessage);
        if (isCreateTask && hasPy && contentKws.length >= 2) {
            interface FsHit { relPath: string; matchedRoutes: string[]; matchedFunctions: string[] }
            const fsHits: FsHit[] = [];

            // Directories to scan
            const scanDirs = ['app/routes', 'app/services', 'app/views', 'app/blueprints']
                .map(d => path.join(root, d))
                .filter(d => fs.existsSync(d));

            for (const scanDir of scanDirs) {
                let pyFiles: string[];
                try { pyFiles = fs.readdirSync(scanDir).filter(f => f.endsWith('.py') && f !== '__init__.py'); }
                catch { continue; }

                for (const pf of pyFiles) {
                    const pfAbs = path.join(scanDir, pf);
                    let pfContent: string;
                    try { pfContent = fs.readFileSync(pfAbs, 'utf8'); }
                    catch { continue; }

                    // Check if this file is relevant: at least 2 content keywords present
                    const pfLower = pfContent.toLowerCase();
                    const kwHits = contentKws.filter(kw => pfLower.includes(kw));
                    if (kwHits.length < 2) { continue; }

                    const pfLines = pfContent.split('\n');
                    const matchedRoutes: string[] = [];
                    const matchedFunctions: string[] = [];

                    for (const line of pfLines) {
                        const rm = line.match(/^\s*@\w+\.route\(['"]([^'"]+)['"]/);
                        if (rm) { matchedRoutes.push(rm[1]); }
                        const fm = line.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
                        if (fm && !fm[1].startsWith('_')) { matchedFunctions.push(fm[1]); }
                    }

                    // Only flag if at least one route or function name contains a content keyword
                    const relevantFns = matchedFunctions.filter(fn =>
                        contentKws.some(kw => fn.toLowerCase().includes(kw))
                    );
                    const relevantRoutes = matchedRoutes.filter(r =>
                        contentKws.some(kw => r.toLowerCase().includes(kw))
                    );

                    if (relevantFns.length > 0 || relevantRoutes.length > 0) {
                        const rel = path.relative(root, pfAbs).replace(/\\/g, '/');
                        fsHits.push({ relPath: rel, matchedRoutes: relevantRoutes, matchedFunctions: relevantFns });
                        logInfo(`[fs-scan] Feature match: ${rel} (routes: ${relevantRoutes.join(', ')}, fns: ${relevantFns.join(', ')})`);
                    }
                }
            }

            if (fsHits.length > 0) {
                const hitLines = fsHits.map(h => {
                    const parts: string[] = [`  File: \`${h.relPath}\``];
                    if (h.matchedRoutes.length > 0) { parts.push(`  Routes: ${h.matchedRoutes.map(r => `\`${r}\``).join(', ')}`); }
                    if (h.matchedFunctions.length > 0) { parts.push(`  Functions: ${h.matchedFunctions.map(f => `\`${f}\``).join(', ')}`); }
                    return parts.join('\n');
                }).join('\n\n');

                const msg = `[FEATURE ALREADY EXISTS]\n\nA file-system scan found existing code matching this task:\n\n${hitLines}\n\nBefore writing any new code:\n1. Read the file(s) listed above to confirm what is already implemented\n2. Tell the user what exists and what (if anything) is missing\n3. Only write new code if something is genuinely absent`;
                logInfo(`[fs-scan] Blocking: ${fsHits.length} hit(s) for keywords [${contentKws.join(', ')}]`);
                // Don't return blocked — inject as warning instead so model can still act if needed
                // (user may want to extend, not re-implement). Inject prominently at top of sections.
                return { injection: `[PRE-LOADED CONTEXT for your task]\n\n## ⚠ ${msg}\n`, blocked: null, pendingSteps: [] };
            }
        }

        // ── 6. Assemble the injection ────────────────────────────────────────
        const sections: string[] = [];

        sections.push(`[PRE-LOADED CONTEXT for your task]`);
        sections.push(`Line numbers are for edit_file_at_line only — they are NOT part of the file.\n`);

        // Stub redirect warning — shown first so model cannot miss it
        if (stubWarning) {
            sections.push(`## ⚠ ${stubWarning}\n`);
        }

        // Column existence note — shown before file content so model knows the job scope upfront
        if (columnExistsNote) {
            sections.push(`## ✓ Schema check\n${columnExistsNote}\n`);
        }

        // Full-stack form breadcrumb — all surfaces the model needs to touch
        if (formJsHandler || formBackendRoute) {
            sections.push(`## Full-stack form surface — you must update ALL of these`);
            sections.push(`The task requires changes across multiple files. Do NOT stop after editing one.`);
            if (formJsHandler) {
                sections.push(`**JS submit handler:** \`${formJsHandler.relPath}\` ~line ${formJsHandler.lineHint}`);
                sections.push(`\`\`\`js\n${formJsHandler.snippet}\n\`\`\``);
            }
            if (formBackendRoute) {
                sections.push(`**Backend POST route:** \`${formBackendRoute.relPath}\` ~line ${formBackendRoute.lineHint}`);
                sections.push(`\`\`\`python\n${formBackendRoute.snippet}\n\`\`\``);
            }
            sections.push('');
        }

        // Models inventory FIRST — model must see what's available before reading the file
        if (modelsInventory.length > 0) {
            sections.push(`## RULE: You may only import models from this list (scanned from app/models/ on disk)`);
            sections.push(`Do NOT invent or guess model names. If no model here fits the task, stop and explain.`);
            sections.push(modelsInventory.map(m => `  ${m.className}  (${m.relPath})`).join('\n'));
            sections.push('');
        }

        // What already exists in the file
        if (definedRoutes.length > 0 || definedFunctions.length > 0 || definedFields.length > 0) {
            sections.push(`## Already defined in this file — check for duplicates before adding`);
            if (definedRoutes.length > 0) {
                sections.push(`Routes: ${definedRoutes.map(r => `\`${r}\``).join(', ')}`);
            }
            if (definedFunctions.length > 0) {
                sections.push(`Functions: ${definedFunctions.map(f => `\`${f}\``).join(', ')}`);
            }
            if (definedFields.length > 0) {
                sections.push(`Fields/columns: ${definedFields.map(f => `\`${f}\``).join(', ')}`);
            }
            if (importedNames.length > 0) {
                sections.push(`Currently imported: ${importedNames.slice(0, 20).map(n => `\`${n}\``).join(', ')}`);
            }
            sections.push('');
        }

        // Data model relationship map (when editing models)
        if (modelRelMap.length > 0) {
            sections.push(`\n## Model relationships (from app/models/ scan)`);
            sections.push(`Review before changing model fields — downstream associations may require migrations or form updates.`);
            for (const { className, relations } of modelRelMap) {
                sections.push(`  ${className}: ${relations.join(' | ')}`);
            }
            sections.push('');
        }

        // Caller impact analysis (transitive)
        if (callerReport.length > 0) {
            sections.push(`\n## Caller impact — backward compatibility required`);
            for (const { funcName, callers, hopCount } of callerReport) {
                const hopNote = hopCount > 1 ? ` (${hopCount}-hop transitive graph)` : '';
                sections.push(`\`${funcName}\` is referenced from ${callers.length} location(s)${hopNote}:`);
                sections.push(callers.join('\n'));
                sections.push(`Your change must remain compatible with these call sites, or update them in the same session.`);
            }
        }

        // Pattern example
        if (patternExample) {
            sections.push(`## Pattern to follow exactly (copy this structure)`);
            sections.push(`\`\`\`${ext}\n${patternExample}\n\`\`\``);
            sections.push('');
        }

        // Target file
        sections.push(`## Target file: ${targetRelPath}${windowNote}`);
        sections.push(`\`\`\`${ext}\n${numberedLines}\n\`\`\``);

        // Static bug scan warnings — shown prominently so model fixes them
        if (staticBugWarnings.length > 0) {
            sections.push(`\n## ⚠ STATIC BUG SCAN — fix these FIRST before implementing any new code`);
            sections.push(staticBugWarnings.join('\n'));
        }

        // Pre-validation warnings
        if (preValidationWarnings.length > 0) {
            sections.push(`\n## ⚠ Pre-validation warnings — resolve before writing code`);
            sections.push(preValidationWarnings.join('\n'));
        }

        // Detect sweep tasks — "add error handling to all routes", "fix all X missing Y"
        const isSweepTask = /\b(all|every|each|any)\b.{0,40}\b(route|function|endpoint|def)\b/i.test(userMessage)
            || /\b(missing|without|lacks?)\b.{0,50}\b(error|exception|try|handl)/i.test(userMessage)
            || /\b(no\s+error|no\s+try)\b/i.test(userMessage)
            || /\b(add|fix).{0,30}\b(all|every|each|any)\b/i.test(userMessage);

        // ── Fix 6b: Task-specific completion checklist ───────────────────────
        // Build a concrete "done when" checklist based on what we discovered.
        // The model must check every item before declaring the task complete.
        const completionChecks: string[] = [];
        if (isFormTask && !isSweepTask) {
            // Extract the specific field name if we found it
            const fieldNameForChecklist = columnExistsNote.match(/`([a-z_]+)`/)?.[1] ?? contentKws[0] ?? 'the field';
            completionChecks.push(`[ ] HTML input for \`${fieldNameForChecklist}\` added to \`${targetRelPath}\``);
            if (formJsHandler) {
                completionChecks.push(`[ ] JS submit handler in \`${formJsHandler.relPath}\` includes \`${fieldNameForChecklist}\` key`);
            }
            if (formBackendRoute) {
                completionChecks.push(`[ ] Backend route in \`${formBackendRoute.relPath}\` reads \`request.form.get('${fieldNameForChecklist}')\``);
            }
            if (!columnExistsNote) {
                // Column doesn't exist yet — migration needed
                completionChecks.push(`[ ] Column \`${fieldNameForChecklist}\` added to model file`);
                completionChecks.push(`[ ] User informed: "Run flask db migrate && flask db upgrade"`);
            }
        } else if (/\badd\b.{0,30}\broute\b/i.test(userMessage) && !isSweepTask) {
            completionChecks.push(`[ ] Route function added to \`${targetRelPath}\``);
            completionChecks.push(`[ ] Route is registered on the correct blueprint (not a duplicate path)`);
            completionChecks.push(`[ ] Syntax check passes (no import errors, no undefined names)`);
        } else if (/\bfix\b/i.test(userMessage) && !isSweepTask) {
            completionChecks.push(`[ ] edit_file called and confirmed`);
            completionChecks.push(`[ ] Error pattern no longer present in file`);
            completionChecks.push(`[ ] Syntax check passes`);
        }

        // Instructions
        sections.push(`\n## Your task`);
        if (isSweepTask) {
            sections.push([
                `This is a SWEEP task — you need to update every route/function in the file that is missing the requested change.`,
                ``,
                `Strategy (IMPORTANT — follow this exactly):`,
                `1. Read the file with shell_read to get the current content.`,
                `2. Find the FIRST route/function that still needs the change (not already updated).`,
                `3. Call edit_file ONCE for that route, using EXACT text copied from the current file (correct indentation).`,
                `4. After it succeeds, go back to step 2 and find the next one.`,
                `5. When no more remain, output a brief summary: "Updated N routes: [list of function names]."`,
                ``,
                `Rules:`,
                `- Use edit_file (NOT edit_file_at_line) — line numbers shift after each edit.`,
                `- Copy old_string VERBATIM from the file — preserve ALL leading spaces/indentation.`,
                `- Do NOT batch all edits from the initial read — the file changes after each edit.`,
                `- Do NOT stop after the first edit — keep going until all are updated.`,
                `- No \`pass\` or \`# TODO\` — complete working code only.`,
                `- Match the style already present in the file.`,
            ].join('\n'));
        } else {
            const isModifyTask = /\b(update|modify|change|refactor|rename|fix|edit|improve|rewrite|extend|add.*to|remove.*from)\b/i.test(userMessage);
            if (isModifyTask) {
                sections.push([
                    `This is a MODIFY task — you are changing existing code, not adding new code.`,
                    ``,
                    `Run these checks silently, then act:`,
                    `- If the thing to modify does NOT exist in the file → "Cannot find [name] in ${targetRelPath}. No change made."`,
                    `- If all checks pass → call edit_file_at_line with path="${targetRelPath}" immediately. No explanation needed.`,
                    ``,
                    `Rules:`,
                    `- Do NOT use the duplicate check — the item already exists by definition.`,
                    `- MODEL: If adding a new field that references another model, it must be in the RULE list above.`,
                    `- Use start_line/end_line from the line numbers shown.`,
                    `- Match surrounding indentation exactly.`,
                    `- No shell_read — all context is above.`,
                    `- No \`pass\` or \`# TODO\` — complete working code only.`,
                ].join('\n'));
            } else {
                sections.push([
                    `Run all validation checks silently (do not narrate them), then:`,
                    `- If a check fails → output one sentence explaining why, then stop.`,
                    `- If all pass → call edit_file_at_line with path="${targetRelPath}" immediately. No explanation needed.`,
                    ``,
                    `Checks (run silently):`,
                    `1. DUPLICATE: Is what the user asked already in "Already defined"? If yes → "Already exists: [name]. No change needed."`,
                    `2. MODEL: Need a DB model? Must be in the RULE list above. If missing → "Cannot proceed: [Name] not found in app/models/."`,
                    `3. PATTERN: Use same blueprint, decorators, imports as the pattern example.`,
                    `4. FIT: Does this belong in ${targetRelPath}?`,
                    ``,
                    `When editing:`,
                    `  - Use start_line/end_line from the line numbers shown`,
                    `  - Match surrounding indentation`,
                    `  - No shell_read — all context is above`,
                    `  - No \`pass\` or \`# TODO\` — complete working code only`,
                ].join('\n'));
            }
        }

        // Fix 6b: Completion checklist appended after task instructions
        if (completionChecks.length > 0) {
            sections.push(`\n## TASK COMPLETE WHEN ALL ARE DONE`);
            sections.push(`Do not declare the task complete until every item is checked:`);
            sections.push(completionChecks.join('\n'));
            if (formJsHandler || formBackendRoute) {
                sections.push(`\nThis task touches multiple files. Edit ALL of them before responding to the user.`);
            }
        }

        // Post reasoning card to UI
        post({
            type: 'reasoningCard',
            targetFile: targetRelPath,
            routes: definedRoutes,
            functions: definedFunctions,
            fields: definedFields,
            modelCount: modelsInventory.length,
            warnings: [...preValidationWarnings, ...(stubWarning ? [stubWarning] : []), ...(columnExistsNote ? [columnExistsNote] : [])],
            hasPattern: !!patternExample,
            isSweep: isSweepTask,
        });

        const injection = sections.join('\n');
        logInfo(`[pre-edit] Injected ${injection.length} chars — file: ${targetRelPath}, models: ${modelsInventory.length}, routes: ${definedRoutes.length}, callers: ${callerReport.reduce((a, c) => a + c.callers.length, 0)} (${callerReport.reduce((a, c) => Math.max(a, c.hopCount), 0)} hops), warnings: ${preValidationWarnings.length}, stub: ${!!stubWarning}, colExists: ${!!columnExistsNote}, jsHandler: ${!!formJsHandler}, backendRoute: ${!!formBackendRoute}`);
        return { injection, blocked: null, pendingSteps: completionChecks };
    }
}
