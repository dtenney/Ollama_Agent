import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

import { streamChatRequest, OllamaMessage, OllamaToolCall, StreamResult, ToolsNotSupportedError } from './ollamaClient';
import { getConfig } from './config';
import { logInfo, logError, logWarn } from './logger';
import { buildWorkspaceSummary, SKIP_DIRS, detectPythonEnvironment, formatPythonEnvironment, PythonEnvironment } from './workspace';
import { ProjectMemory } from './projectMemory';
import { TieredMemoryManager } from './memoryCore';
import { isMCPTool, parseMCPToolName, callMCPTool, mcpToolsToOllamaFormat } from './mcpClient';
import { calculateContextStats, compactHistory, ContextLevel, resolveModelContextLimit } from './contextCalculator';
import { DiffViewManager } from './diffView';
import { MultiFileRefactoringManager, RefactoringPlan } from './multiFileRefactor';
import { GARBAGE_PATTERNS } from './docScanner';

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
            description: 'Find files by name or glob pattern in the workspace. Use this to locate files (e.g., "*.test.ts", "Dockerfile", "*.py"). For searching TEXT CONTENT inside files, use search_files instead.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Filename or glob pattern (e.g., "*.ts", "README*", "Dockerfile", "*.test.js")' },
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
    const pyEnv = detectPythonEnvironment(workspaceRoot);
    if (!pyEnv) { return ''; }

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

    return lines.join('\n');
}

function buildSystemPrompt(autoSaveMemory: boolean, workspaceRoot?: string): string {
    const memoryGuidelines = autoSaveMemory
        ? `- Use memory_tier_write to save information to the appropriate tier:
  * Tier 0: Critical infrastructure (IPs, paths, keys, credentials, URLs)
  * Tier 1: Essential capabilities (languages, frameworks, tools, deployment processes)
  * Tier 2: Operational context (current tasks, recent decisions, active bugs)
  * Tier 3: Collaboration (team conventions, standards, workflows)
  * Tier 4: References (past solutions, learned patterns, troubleshooting guides)
- When user provides MULTIPLE pieces of information, break them into SEPARATE memory entries by tier
- Each memory entry should be focused and atomic (one concept per entry)`
        : `- Use memory_tier_write to save information to the appropriate tier:
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
${autoSaveBlock}
You have access to the user's workspace through the following tools:

  workspace_summary  — understand the project structure (call this first)
  read_file          — read any file
  list_files         — list a directory
  find_files         — find files by name/glob pattern (e.g., "*.ts", "Dockerfile")
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

Guidelines:
- ALWAYS CALL TOOLS DIRECTLY - never explain what tool to call, just call it immediately
- Always call workspace_summary or read_file before proposing code changes.
- Prefer edit_file over write_file for targeted modifications.
- CRITICAL: When user asks about errors, warnings, or diagnostics in their code, ALWAYS call get_diagnostics FIRST — do NOT run external linters (ruff, eslint, tsc, etc.) unless the user specifically asks for a linter.
- After editing or creating files, call get_diagnostics to check for errors introduced by your changes. If errors exist, fix them.
- Prefer shell_read over run_command for read-only operations (git log, git status, git diff, ls, cat, head, wc, find, grep, etc.) — it requires no user confirmation and is faster.
- Use find_files to locate files by name or pattern instead of multiple list_files calls.
- Your persistent memory is automatically loaded (Tiers 0-2) and shown above.
${memoryGuidelines}
- Use memory_search to find relevant past solutions without loading all memories.
- CRITICAL: When user asks "what do you know about this project" or similar, ALWAYS call memory_list or memory_tier_list — do not answer from conversation history alone.
- CRITICAL: Before calling memory_delete, ALWAYS call memory_list first to get the actual entry ID — never guess or fabricate IDs.
- Be concise and accurate. Format all code with markdown fenced code blocks.

CRITICAL — Action-Oriented Responses:
- When asked to review, analyze, audit, fix, or improve code: ALWAYS use read_file/list_files to read the ACTUAL source files first, then propose REAL edits using edit_file on the actual code you read.
- NEVER generate hypothetical examples, placeholder code, or generic "Example:" blocks. The user wants you to act on THEIR code, not see textbook examples.
- If the user says "look at src/" or "check this file" — call list_files and read_file immediately. Do not describe what you would do.
- When you find an issue, fix it with edit_file right away (or explain why you can't). Do not just list the issue with a generic code sample.
${workspaceRoot ? buildProjectTypeGuidance(workspaceRoot) : ''}`;
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
- After receiving [TOOL RESULT: ...], continue with the NEXT tool call if there are more items
- Call one tool at a time and wait for its result${autoSaveGuidance}

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
  find_files          — {"pattern": "glob pattern", "path": "optional dir"}
  shell_read          — {"command": "read-only shell command (no confirmation)"}
  run_command         — {"command": "shell command (requires confirmation)"}
  memory_list         — {} — ALWAYS call when user asks "what do you know" or about project knowledge
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
WRONG: <tool>{"name": "run_command", "arguments": {"command": "eslint ."}}</tool>
CORRECT: <tool>{"name": "get_diagnostics", "arguments": {}}</tool>

EXAMPLE - User says "check for errors in src/agent.ts":
CORRECT: <tool>{"name": "get_diagnostics", "arguments": {"path": "src/agent.ts"}}</tool>
===================`;
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
                logWarn(`[parseTextToolCalls] Failed to parse XML JSON: ${jsonStr.slice(0, 100)}`);
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
            // Find closing tag (either </tool> or <tool>)
            let tagEnd = result.indexOf('</tool>', jsonEnd);
            if (tagEnd === -1) {
                tagEnd = result.indexOf('<tool>', jsonEnd);
            }
            if (tagEnd !== -1) {
                const endPos = tagEnd + (result[tagEnd + 1] === '/' ? 7 : 6);
                result = result.slice(0, toolStart) + result.slice(endPos);
                pos = toolStart;
            } else {
                pos = jsonEnd;
            }
        } else {
            pos = toolStart + 6;
        }
    }
    
    // Remove raw JSON format - line by line
    const lines = result.split('\n');
    const filtered = lines.filter(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.includes('"name"')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed.name && typeof parsed.name === 'string') {
                    // Remove if it has 'arguments' field OR other fields besides 'name'
                    const hasArguments = 'arguments' in parsed;
                    const hasOtherFields = Object.keys(parsed).filter(k => k !== 'name').length > 0;
                    if (hasArguments || hasOtherFields) {
                        return false; // Remove tool call
                    }
                }
            } catch { /* not valid JSON, keep the line */ }
        }
        return true;
    });
    
    return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export type PostFn = (msg: object) => void;

export class Agent {
    private history: OllamaMessage[] = [];
    private stopRef = { stop: false };
    /** Current post function — set at the start of each run() call */
    private postFn: PostFn = () => { /* noop until run() is called */ };
    /**
     * 'native' — use Ollama's tool-calling API (default).
     * 'text'   — model rejected native tools; fall back to <tool> XML in text.
     * This persists across turns so the mode-switch only happens once per session.
     */
    private toolMode: 'native' | 'text' = 'text';
    /** Track if we've detected the model outputting JSON instead of calling tools */
    private detectedFakeToolCalls = false;
    /** Track consecutive failed tool calls to prevent infinite loops */
    private consecutiveFailures = 0;
    private readonly MAX_CONSECUTIVE_FAILURES = 3;
    /** Track repeated identical tool calls to prevent infinite loops */
    private lastToolSignature = '';
    private consecutiveRepeats = 0;
    private readonly MAX_CONSECUTIVE_REPEATS = 2;
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

    private diffViewManager: DiffViewManager;
    private refactorManager: MultiFileRefactoringManager;
    /** Last file operation for undo support */
    private _lastFileOp: { path: string; originalContent: string | null; action: string } | null = null;
    /** Pending inline confirmation resolver */
    private _confirmResolver: ((accepted: boolean) => void) | null = null;

    constructor(
        private workspaceRoot: string,
        private readonly memory: ProjectMemory | TieredMemoryManager | null = null
    ) {
        this.diffViewManager = new DiffViewManager();
        this.refactorManager = new MultiFileRefactoringManager();
    }

    get historyLength(): number { return this.history.length; }

    reset(): void { 
        this.history = [];
        this.diffViewManager.dispose();
        this.diffViewManager = new DiffViewManager();
    }

    stop(): void { this.stopRef.stop = true; }

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
                        { stop: false }
                    );
                    if (summary.trim()) {
                        compacted.unshift({ role: 'assistant', content: `[Earlier conversation summary] ${summary.trim()}` });
                        logInfo(`[context] Compaction summary: ${summary.trim().slice(0, 120)}`);
                    }
                } catch (err) {
                    logWarn(`[context] Summary generation failed, compacting without summary: ${(err as Error).message}`);
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
            logError(`[agent] Undo failed: ${(err as Error).message}`);
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

    /** Request inline confirmation from the webview chat UI */
    private requestConfirmation(action: string, detail: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this._confirmResolver = resolve;
            const confirmId = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            this.postFn({ type: 'confirmAction', id: confirmId, action, detail });
        });
    }

    async run(userMessage: string, model: string, post: PostFn): Promise<void> {
        this.stopRef = { stop: false };
        this.postFn  = post;
        this.currentModel = model; // Store current model for accurate context calculations
        
        // Trim history BEFORE adding new message to prevent exceeding limit
        if (this.history.length >= this.MAX_HISTORY_MESSAGES) {
            const removed = this.history.length - this.MAX_HISTORY_MESSAGES + 1;
            this.history = this.history.slice(-this.MAX_HISTORY_MESSAGES + 1);
            logInfo(`[agent] History trimmed: removed ${removed} old messages`);
        }
        
        this.history.push({ role: 'user', content: userMessage });
        this.userTurnCount++;
        this.memoryWritesThisResponse = 0; // Reset rate limiter for this response
        
        logInfo(`Agent run — model: ${model}, mode: ${this.toolMode}, history: ${this.history.length}`);

        // Resolve actual context limit from Ollama (cached after first call)
        await resolveModelContextLimit(model);

        const cfg = getConfig();
        const baseSystemContent = cfg.systemPrompt.trim() || buildSystemPrompt(cfg.autoSaveMemory, this.workspaceRoot);

        // Inject periodic memory nudge into the user message in history
        if (cfg.autoSaveMemory) {
            const nudge = this.buildMemoryNudge();
            if (nudge) {
                // Append nudge to the last user message in history
                const lastIdx = this.history.length - 1;
                if (lastIdx >= 0 && this.history[lastIdx].role === 'user') {
                    this.history[lastIdx] = {
                        ...this.history[lastIdx],
                        content: this.history[lastIdx].content + nudge,
                    };
                    logInfo(`[agent] Memory nudge injected at turn ${this.userTurnCount}`);
                }
            }
        }

        // Build memory context — use relevance-based loading when possible
        let memoryContext = '';
        if (this.memory && this.memory instanceof TieredMemoryManager) {
            try {
                const memoryConfig = (this.memory as any).config;
                const maxTokens = memoryConfig?.maxContextTokens || 4000;
                // Use semantic search to pull only relevant memories
                memoryContext = await this.memory.buildRelevantContext(userMessage, maxTokens);
                if (memoryContext) {
                    logInfo(`[agent] Loaded relevant memory context: ${Math.ceil(memoryContext.length / 4)} tokens`);
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                logError(`[agent] Failed to load memory context: ${errorMsg}`);
            }
        }

        const MAX_TURNS = 15;
        this.modeSwitchRetries = 0;
        let loopExhausted = true;
        for (let turn = 0; turn < MAX_TURNS; turn++) {
            if (this.stopRef.stop) { break; }

            // Build system content and tool list based on current mode
            const isTextMode = this.toolMode === 'text';
            
            // Inject memory context into system prompt
            let systemContent = baseSystemContent;
            if (memoryContext) {
                systemContent = `${baseSystemContent}

## Your Persistent Memory
${memoryContext}

IMPORTANT: Only critical infrastructure is shown above. You have MORE memories stored across tiers 1-5. Before answering questions about project setup, conventions, frameworks, past decisions, or known issues, call memory_search("<topic>") or memory_tier_list to retrieve relevant context. Do NOT assume you have no memory — check first.`;
            }
            
            if (isTextMode) {
                systemContent = systemContent + buildTextModeInstructions(cfg.autoSaveMemory);
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
                    [{ role: 'system', content: systemContent }, ...this.history],
                    tools,
                    (token) => post({ type: 'token', text: token }),
                    this.stopRef
                );
            } catch (err) {
                // ── Auto-switch to text-mode on first 400 ─────────────────────
                if (err instanceof ToolsNotSupportedError && this.toolMode === 'native') {
                    this.toolMode = 'text';
                    logInfo(`Model ${model} → switching to text-mode tool calling`);
                    // Clean up the empty streaming bubble that was already opened
                    post({ type: 'streamEnd' });
                    post({ type: 'removeLastAssistant' });
                    post({ type: 'modeSwitch', mode: 'text', model });
                    if (++this.modeSwitchRetries <= this.MAX_MODE_SWITCH_RETRIES) {
                        turn--; // retry this turn in text mode
                    }
                    continue;
                }

                const msg = (err as Error).message;
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
                        logInfo(`Model ${model} outputting fake tool calls instead of using native API → switching to text mode`);
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
                if (cfg.autoSaveMemory && this.memory instanceof TieredMemoryManager) {
                    this.autoExtractFacts(userMessage, displayContent || result.content).catch(err => {
                        logWarn(`[agent] Auto-extract facts failed: ${(err as Error).message}`);
                    });
                }

                loopExhausted = false;
                break;
            }

            // ── Execute tool calls ────────────────────────────────────────────
            for (const tc of toolCalls) {
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
                    break;
                }

                let toolResult: string;
                try {
                    toolResult = await this.executeTool(name, args, toolId);
                    logInfo(`Tool ${name} OK — ${toolResult.length} chars`);
                    post({ type: 'toolResult', id: toolId, name, success: true, preview: toolResult.slice(0, 400) });
                    this.consecutiveFailures = 0; // Reset on success
                } catch (err) {
                    toolResult = `Error: ${(err as Error).message}`;
                    logError(`Tool ${name} failed: ${toolResult}`);
                    post({ type: 'toolResult', id: toolId, name, success: false, preview: toolResult });
                    this.consecutiveFailures++;
                    
                    // Break loop if too many consecutive failures
                    if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
                        logError(`[agent] Breaking loop: ${this.consecutiveFailures} consecutive tool failures`);
                        post({ type: 'error', text: `Stopped after ${this.consecutiveFailures} consecutive tool failures. Please try rephrasing your request or start a new chat.` });
                        return;
                    }
                }

                // In text mode, inject the result as a user turn so the model sees it
                if (isTextMode) {
                    this.history.push({
                        role: 'user',
                        content: `[TOOL RESULT: ${name}]\n${toolResult}\n[END TOOL RESULT]`,
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
                return buildWorkspaceSummary(root);
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
                
                return new Promise<string>((resolve) => {
                    let searchCommand: string;
                    let searchArgs: string[];
                    
                    if (isWindows) {
                        // Windows: use findstr with recursive search
                        // /S = recursive, /N = line numbers, /I = case insensitive
                        searchCommand = 'findstr';
                        searchArgs = ['/S', '/N', '/I', query, '*.*'];
                    } else {
                        // Unix/Linux/macOS: use grep
                        // -r = recursive, -n = line numbers, -i = case insensitive, -I = skip binary files
                        searchCommand = 'grep';
                        searchArgs = ['-r', '-n', '-i', '-I', '--', query, '.'];
                    }
                    
                    const child = spawn(searchCommand, searchArgs, {
                        cwd: searchDir,
                        shell: false,
                        env: { ...process.env }
                    });
                    
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
                            const match = line.match(/^([^:]+):(\d+):(.*)$/);
                            if (match) {
                                const [, filepath, linenum, content] = match;
                                // Make path relative to workspace root
                                const relPath = path.relative(root, path.join(searchDir, filepath));
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
                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, content, 'utf8');
                this._lastFileOp = { path: rel, originalContent: null, action: 'created' };
                this.postFn({ type: 'fileChanged', path: rel, action: 'created' });
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
                const accepted = await this.requestConfirmation('edit', `Edit "${rel}" — ${oldString.split('\n').length} line(s) changed`);
                this.diffViewManager.closeDiffPreview();

                if (!accepted) { return 'Edit cancelled by user.'; }

                fs.writeFileSync(full, newContent, 'utf8');
                this._lastFileOp = { path: rel, originalContent: original, action: 'edited' };
                this.postFn({ type: 'fileChanged', path: rel, action: 'edited' });
                return `Edited: ${rel} — ${oldString.split('\n').length} line(s) replaced with ${newString.split('\n').length} line(s)`;
            }

            // ── write_file ─────────────────────────────────────────────────
            case 'write_file': {
                const rel     = String(args.path ?? '');
                const content = String(args.content ?? '');
                if (!rel) { throw new Error('path is required'); }
                const full = this.safePath(root, rel);
                const originalContent = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;

                const accepted = await this.requestConfirmation('write', `Overwrite "${rel}" (${content.split('\n').length} lines)`);
                if (!accepted) { return 'Write cancelled by user.'; }

                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, content, 'utf8');
                this._lastFileOp = { path: rel, originalContent, action: 'written' };
                this.postFn({ type: 'fileChanged', path: rel, action: 'written' });
                return `Written: ${rel} (${content.split('\n').length} lines)`;
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

                const accepted = await this.requestConfirmation('rename', `Rename "${oldRel}" → "${newRel}"`);
                if (!accepted) { return 'Rename cancelled by user.'; }

                fs.mkdirSync(path.dirname(newFull), { recursive: true });
                fs.renameSync(oldFull, newFull);
                this.postFn({ type: 'fileChanged', path: newRel, action: 'renamed' });
                return `Renamed: ${oldRel} → ${newRel}`;
            }

            // ── delete_file ────────────────────────────────────────────────
            case 'delete_file': {
                const rel = String(args.path ?? '');
                if (!rel) { throw new Error('path is required'); }
                const full = this.safePath(root, rel);
                const originalContent = fs.readFileSync(full, 'utf8');

                const accepted = await this.requestConfirmation('delete', `Delete "${rel}" — this cannot be undone`);
                if (!accepted) { return 'Delete cancelled by user.'; }

                fs.unlinkSync(full);
                this._lastFileOp = { path: rel, originalContent, action: 'deleted' };
                this.postFn({ type: 'fileChanged', path: rel, action: 'deleted' });
                return `Deleted: ${rel}`;
            }

            // ── find_files ─────────────────────────────────────────────────
            case 'find_files': {
                const pattern = String(args.pattern ?? '');
                if (!pattern) { throw new Error('pattern is required'); }
                const searchDir = args.path ? this.safePath(root, String(args.path)) : root;
                const isWindows = process.platform === 'win32';
                const MAX_RESULTS = 200;
                const SKIP_PATTERNS = ['node_modules', '.git', 'dist', '__pycache__', '.nyc_output', 'coverage'];

                return new Promise<string>((resolve) => {
                    let cmd: string;
                    let cmdArgs: string[];

                    if (isWindows) {
                        // Use PowerShell for reliable glob + exclusion on Windows
                        const excludeFilter = SKIP_PATTERNS.map(d => `'*\\${d}\\*'`).join(',');
                        const psCmd = `Get-ChildItem -Path . -Recurse -Filter '${pattern}' -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '(${SKIP_PATTERNS.join('|')})' } | Resolve-Path -Relative`;
                        cmd = 'powershell';
                        cmdArgs = ['-NoProfile', '-Command', psCmd];
                    } else {
                        cmd = 'find';
                        cmdArgs = ['.', '-name', pattern];
                        for (const skip of SKIP_PATTERNS) {
                            cmdArgs.push('-not', '-path', `*/${skip}/*`);
                        }
                    }

                    const child = spawn(cmd, cmdArgs, { cwd: searchDir, shell: false });
                    let output = '';

                    child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
                    child.stderr?.on('data', () => { /* ignore */ });

                    child.on('close', () => {
                        if (!output.trim()) {
                            resolve(`No files matching "${pattern}"`);
                            return;
                        }
                        const lines = output.trim().split('\n')
                            .map(l => l.trim().replace(/^\.\//, '').replace(/^\.\\/, ''))
                            .filter(Boolean)
                            .map(l => {
                                // Make paths relative to workspace root
                                const abs = path.resolve(searchDir, l);
                                return path.relative(root, abs).replace(/\\/g, '/');
                            })
                            .filter(l => !l.startsWith('..'));

                        const truncated = lines.length > MAX_RESULTS;
                        const results = lines.slice(0, MAX_RESULTS);
                        const suffix = truncated ? `\n(showing first ${MAX_RESULTS} of ${lines.length})` : '';
                        resolve(`Files matching "${pattern}" (${results.length}):${suffix}\n${results.join('\n')}`);
                    });

                    child.on('error', (err) => {
                        resolve(`find_files failed: ${err.message}`);
                    });

                    setTimeout(() => { child.kill(); resolve('find_files timed out after 15s'); }, 15_000);
                });
            }

            // ── shell_read ─────────────────────────────────────────────────
            case 'shell_read': {
                const cmd = String(args.command ?? '');
                if (!cmd) { throw new Error('command is required'); }

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
                    /[>|]\s*[^|]/, // redirect to file
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
                const cmd = String(args.command ?? '');
                if (!cmd) { throw new Error('command is required'); }

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

                const accepted = await this.requestConfirmation('run', cmd);
                if (!accepted) { return 'Command cancelled by user.'; }

                return this.runCommandStreaming(cmd, root, _toolId);
            }

            // ── memory_list ────────────────────────────────────────────────
            case 'memory_list': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                
                if (this.memory instanceof TieredMemoryManager) {
                    return `Project memory notes:\n\n${this.memory.formatTiers([0, 1, 2, 3, 4, 5])}`;
                } else {
                    return `Project memory notes:\n\n${this.memory.formatAll()}`;
                }
            }

            // ── memory_write ───────────────────────────────────────────────
            case 'memory_write': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                const content = String(args.content ?? '');
                const tag     = args.tag ? String(args.tag) : undefined;
                if (!content.trim()) { throw new Error('content is required'); }
                
                if (this.memory instanceof TieredMemoryManager) {
                    const note = await this.memory.addEntry(2, content, tag ? [tag] : undefined);
                    return `Note saved to Tier 2 (id: ${note.id}). Use memory_list to view all notes.`;
                } else {
                    const note = await this.memory.add(content, tag);
                    return `Note saved (id: ${note.id}). Use memory_list to view all notes.`;
                }
            }

            // ── memory_delete ──────────────────────────────────────────────
            case 'memory_delete': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                const id = String(args.id ?? '');
                if (!id) { throw new Error('id is required'); }
                
                if (this.memory instanceof TieredMemoryManager) {
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
                } else {
                    const ok = await this.memory.delete(id);
                    return ok ? `Deleted note ${id}.` : `Note ${id} not found. Use memory_list to see current notes.`;
                }
            }

            // ── memory_search ───────────────────────────────────────────────
            case 'memory_search': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                
                if (this.memory instanceof TieredMemoryManager) {
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
                } else {
                    return '(semantic search requires tiered memory system with Qdrant)';
                }
            }

            // ── memory_tier_write ──────────────────────────────────────────────
            case 'memory_tier_write': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                
                if (this.memory instanceof TieredMemoryManager) {
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
                    if (this.memory instanceof TieredMemoryManager) {
                        try {
                            const isDupe = await this.memory.isSemanticDuplicate(content, 0.80);
                            if (isDupe) {
                                logInfo(`[memory] Semantic-deduped: "${content.slice(0, 60)}"`);
                                return `Duplicate: a semantically similar entry already exists in memory.`;
                            }
                        } catch {
                            // Qdrant unavailable — skip semantic check, allow save
                        }
                    }
                    
                    const note = await this.memory.addEntry(tier as 0|1|2|3|4|5, content, tags);
                    this.memoryWritesThisResponse++;
                    const tierName = ['Critical', 'Essential', 'Operational', 'Collaboration', 'References', 'Archive'][tier];
                    return `Note saved to Tier ${tier} (${tierName}) with id: ${note.id}.`;
                } else {
                    return '(tier-specific write requires tiered memory system)';
                }
            }

            // ── memory_tier_list ──────────────────────────────────────────────
            case 'memory_tier_list': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                
                if (this.memory instanceof TieredMemoryManager) {
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
                } else {
                    return `Project memory notes:\n\n${this.memory.formatAll()}`;
                }
            }

            // ── memory_stats ────────────────────────────────────────────────
            case 'memory_stats': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                
                if (this.memory instanceof TieredMemoryManager) {
                    const stats = this.memory.getStats();
                    const totalEntries = stats.reduce((sum, s) => sum + s.count, 0);
                    const totalTokens = stats.reduce((sum, s) => sum + s.tokens, 0);
                    
                    let output = 'Memory Statistics:\n\n';
                    stats.forEach(s => {
                        output += `Tier ${s.tier} (${s.name}): ${s.count} entries, ~${s.tokens} tokens\n`;
                    });
                    output += `\nTotal: ${totalEntries} entries, ~${totalTokens} tokens`;
                    
                    return output;
                } else {
                    const notes = this.memory.list();
                    const tokens = notes.reduce((sum, n) => sum + Math.ceil(n.content.length / 4), 0);
                    return `Memory Statistics:\n\nTotal: ${notes.length} entries, ~${tokens} tokens`;
                }
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
        const allDiags = vscode.languages.getDiagnostics();
        const lines: string[] = [];

        for (const [uri, diags] of allDiags) {
            const filePath = uri.fsPath;
            if (!filePath.startsWith(root)) { continue; }
            const rel = path.relative(root, filePath);
            if (relPath && rel !== relPath && !rel.endsWith(relPath)) { continue; }

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
        if (!(this.memory instanceof TieredMemoryManager)) { return; }

        // Only extract from user message — assistant responses are too noisy
        const text = userMessage;
        if (text.length < 10) { return; } // Too short to contain meaningful facts

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
                logWarn(`[auto-memory] Failed to save: ${(err as Error).message}`);
            }
        }
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
