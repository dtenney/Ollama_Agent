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
import { calculateContextStats, compactHistory, ContextLevel } from './contextCalculator';
import { DiffViewManager } from './diffView';
import { MultiFileRefactoringManager, RefactoringPlan } from './multiFileRefactor';

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
            name: 'run_command',
            description: 'Run a shell command in the workspace directory. Output streams live to the chat. Requires user confirmation. Use this for: running tests (pytest, npm test), linting (ruff, eslint), type checking (mypy, tsc), installing dependencies, running scripts, git operations, and any other CLI tool.',
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
            description: 'List all saved project memory notes for this workspace. Use this to recall previously stored facts, decisions, or context about the project.',
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
            description: 'Delete a saved project memory note by its id. Use memory_list first to get the id.',
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
            description: 'List memories from specific tiers. Use to view only relevant tier(s) instead of all memories.',
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
        ? `- AUTOMATICALLY save important information to memory as you discover it:
  * When you discover server URLs, IPs, ports → immediately save to Tier 0 (critical)
  * When you identify frameworks, languages, tools → immediately save to Tier 1 (essential)
  * When you learn about current tasks or bugs → immediately save to Tier 2 (operational)
  * When you note team conventions or standards → immediately save to Tier 3 (collaboration)
  * When you solve a problem → immediately save the solution to Tier 4 (references)
- NEVER say "Saving to memory" or "I will save" - JUST CALL THE TOOL directly with no explanation
- Save to memory proactively and silently in the background
- When user provides MULTIPLE pieces of information, break them into SEPARATE memory entries by tier`
        : `- Use memory_tier_write to save information to the appropriate tier:
  * Tier 0: Critical infrastructure (IPs, paths, keys, credentials, URLs)
  * Tier 1: Essential capabilities (languages, frameworks, tools, deployment processes)
  * Tier 2: Operational context (current tasks, recent decisions, active bugs)
  * Tier 3: Collaboration (team conventions, standards, workflows)
  * Tier 4: References (past solutions, learned patterns, troubleshooting guides)
- When user provides MULTIPLE pieces of information, break them into SEPARATE memory entries by tier
- Each memory entry should be focused and atomic (one concept per entry)`;

    return `You are an expert AI coding assistant integrated into VS Code.
You have access to the user's workspace through the following tools:

  workspace_summary  — understand the project structure (call this first)
  read_file          — read any file
  list_files         — list a directory (use this to find files by name)
  search_files       — search for TEXT CONTENT across files (NOT filenames - use list_files for that)
  create_file        — create a new file
  edit_file          — make targeted edits (old_string → new_string). Preferred for code changes.
  write_file         — overwrite a file entirely (use only when necessary)
  append_to_file     — append text to a file
  rename_file        — rename or move a file
  delete_file        — delete a file (destructive, use carefully)
  run_command        — execute shell commands (tests, linters, type checkers, package managers, git, etc.)
  memory_list        — recall saved facts/decisions about this project
  memory_write       — persist important facts, decisions, or context across sessions
  memory_delete      — remove a stale memory note
  memory_search      — search past memories using semantic similarity
  memory_tier_write  — save to specific tier (0=critical, 1=essential, 2=operational, 3=collaboration, 4=references)
  memory_tier_list   — list memories from specific tiers
  memory_stats       — get memory statistics (entry count and tokens per tier)
  read_terminal      — read recent output from VS Code integrated terminals
  get_diagnostics    — get VS Code errors/warnings for a file (use after editing to verify changes)

Guidelines:
- ALWAYS CALL TOOLS DIRECTLY - never explain what tool to call, just call it immediately
- Always call workspace_summary or read_file before proposing code changes.
- Prefer edit_file over write_file for targeted modifications.
- After editing or creating files, call get_diagnostics to check for errors introduced by your changes. If errors exist, fix them.
- Your persistent memory is automatically loaded (Tiers 0-2) and shown above.
${memoryGuidelines}
- Use memory_search to find relevant past solutions without loading all memories.
- Be concise and accurate. Format all code with markdown fenced code blocks.
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

EXAMPLE - User says "run the tests":
CORRECT: <tool>{"name": "run_command", "arguments": {"command": "python -m pytest -v"}}</tool>

EXAMPLE - User says "check for lint errors":
CORRECT: <tool>{"name": "run_command", "arguments": {"command": "ruff check ."}}</tool>

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
  run_command         — {"command": "shell command"}
  memory_list         — {}
  memory_write        — {"content": "note text", "tag": "optional tag"}
  memory_delete       — {"id": "note id from memory_list"}
  memory_search       — {"query": "search text", "tier": "optional", "limit": "optional"}
  memory_tier_write   — {"tier": 0-5, "content": "note text", "tags": ["optional"]}
  memory_tier_list    — {"tiers": [0, 1, 2]}
  memory_stats        — {}
  read_terminal       — {"index": "optional terminal index"}
  get_diagnostics     — {"path": "optional relative/path"}
===================`;
}

/** Parse <tool>...</tool> blocks or raw JSON from text-mode model output. */
function parseTextToolCalls(text: string): OllamaToolCall[] {
    const calls: OllamaToolCall[] = [];
    const seenIds = new Set<string>(); // Prevent duplicates
    
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
                const parsed = JSON.parse(jsonStr) as {
                    name?: string;
                    arguments?: Record<string, unknown>;
                    [key: string]: unknown;
                };
                if (parsed.name && typeof parsed.name === 'string') {
                    // Handle both formats:
                    // 1. {"name": "tool", "arguments": {...}}
                    // 2. {"name": "tool", "arg1": "val1", ...}
                    let args: Record<string, unknown>;
                    if (parsed.arguments !== undefined) {
                        args = parsed.arguments;
                    } else {
                        // Extract all fields except 'name' as arguments
                        const { name, ...rest } = parsed;
                        args = rest;
                    }
                    
                    const callId = `${parsed.name}_${JSON.stringify(args)}`;
                    if (!seenIds.has(callId)) {
                        seenIds.add(callId);
                        logInfo(`[parseTextToolCalls] Found XML tool call: ${parsed.name}`);
                        calls.push({
                            function: {
                                name: parsed.name,
                                arguments: args,
                            },
                        });
                    }
                }
            } catch (e) {
                logWarn(`[parseTextToolCalls] Failed to parse XML JSON: ${jsonStr.slice(0, 100)}`);
            }
            pos = jsonEnd;
        } else {
            pos = toolStart + 6;
        }
    }
    
    // If no XML format found, try raw JSON format: {"name": "...", "arguments": {...}}
    if (calls.length === 0) {
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('{') && trimmed.includes('"name"')) {
                try {
                    const parsed = JSON.parse(trimmed) as {
                        name?: string;
                        arguments?: Record<string, unknown>;
                        [key: string]: unknown;
                    };
                    if (parsed.name && typeof parsed.name === 'string') {
                        // Handle both formats
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
                            logInfo(`[parseTextToolCalls] Found raw JSON tool call: ${parsed.name}`);
                            calls.push({
                                function: {
                                    name: parsed.name,
                                    arguments: args,
                                },
                            });
                        }
                    }
                } catch (e) {
                    // Not valid JSON, skip
                }
            }
        }
        
        if (calls.length === 0) {
            logWarn(`[parseTextToolCalls] No tool calls found in text. First 200 chars: ${text.slice(0, 200)}`);
        }
    }
    
    return calls;
}

/** Remove <tool>...</tool> blocks and raw JSON tool calls from content before storing in history / rendering. */
function stripToolBlocks(text: string): string {
    let result = text;
    
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
    private toolMode: 'native' | 'text' = 'native';
    /** Track if we've detected the model outputting JSON instead of calling tools */
    private detectedFakeToolCalls = false;
    /** Track consecutive failed tool calls to prevent infinite loops */
    private consecutiveFailures = 0;
    private readonly MAX_CONSECUTIVE_FAILURES = 3;
    /** Track mode-switch retries to prevent infinite retry loops */
    private modeSwitchRetries = 0;
    private readonly MAX_MODE_SWITCH_RETRIES = 2;
    /** Maximum number of messages to keep in history to prevent memory leaks */
    private readonly MAX_HISTORY_MESSAGES = 100;
    /** Track last context warning level to avoid duplicate alerts */
    private lastContextLevel: ContextLevel = 'safe';
    /** Current model being used (for accurate context calculations) */
    private currentModel: string = '';

    private diffViewManager: DiffViewManager;
    private refactorManager: MultiFileRefactoringManager;
    /** Last file operation for undo support */
    private _lastFileOp: { path: string; originalContent: string | null; action: string } | null = null;

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
        
        logInfo(`Agent run — model: ${model}, mode: ${this.toolMode}, history: ${this.history.length}`);

        const cfg = getConfig();
        const baseSystemContent = cfg.systemPrompt.trim() || buildSystemPrompt(cfg.autoSaveMemory, this.workspaceRoot);
        
        // Build memory context from auto-load tiers
        let memoryContext = '';
        if (this.memory && this.memory instanceof TieredMemoryManager) {
            try {
                const memoryConfig = (this.memory as any).config;
                const autoLoadTiers = memoryConfig?.autoLoadTiers || [0, 1, 2];
                const maxTokens = memoryConfig?.maxContextTokens || 4000;
                memoryContext = this.memory.buildContext(autoLoadTiers, maxTokens);
                if (memoryContext) {
                    logInfo(`[agent] Loaded memory context: ${Math.ceil(memoryContext.length / 4)} tokens from tiers ${autoLoadTiers.join(', ')}`);
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                logError(`[agent] Failed to load memory context: ${errorMsg}`);
            }
        }

        const MAX_TURNS = 5;
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

This memory persists across all conversations. Use memory_write to add new information, memory_search to find past solutions.`;
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
                    const hasJsonToolCall = content.split('\n').some(line => {
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
                    
                    if (hasJsonToolCall || hasXmlToolCall) {
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

                // Show enhanced diff view with accept/reject options
                const diffResult = await this.diffViewManager.showDiff(full, original, newContent);

                if (!diffResult.accepted) { return 'Edit cancelled by user.'; }

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

                const action = await vscode.window.showWarningMessage(
                    `Ollama Agent wants to overwrite "${rel}" (${content.split('\n').length} lines)`,
                    { modal: true }, 'Write', 'Cancel'
                );
                if (action !== 'Write') { return 'Write cancelled by user.'; }

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

                const action = await vscode.window.showWarningMessage(
                    `Ollama Agent wants to rename "${oldRel}" → "${newRel}"`,
                    { modal: true }, 'Rename', 'Cancel'
                );
                if (action !== 'Rename') { return 'Rename cancelled by user.'; }

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

                const action = await vscode.window.showWarningMessage(
                    `Ollama Agent wants to DELETE "${rel}". This cannot be undone.`,
                    { modal: true }, 'Delete', 'Cancel'
                );
                if (action !== 'Delete') { return 'Delete cancelled by user.'; }

                fs.unlinkSync(full);
                this._lastFileOp = { path: rel, originalContent, action: 'deleted' };
                this.postFn({ type: 'fileChanged', path: rel, action: 'deleted' });
                return `Deleted: ${rel}`;
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

                const action = await vscode.window.showWarningMessage(
                    `Ollama Agent wants to run:\n${cmd}`,
                    { modal: true }, 'Run', 'Cancel'
                );
                if (action !== 'Run') { return 'Command cancelled by user.'; }

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
                    const note = this.memory.add(content, tag);
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
                    return ok ? `Deleted note ${id}.` : `Note ${id} not found. Use memory_list to see current notes.`;
                } else {
                    const ok = this.memory.delete(id);
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
                    
                    const note = await this.memory.addEntry(tier as 0|1|2|3|4|5, content, tags);
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
                    const tiers = args.tiers ? (args.tiers as number[]) : [0, 1, 2, 3, 4, 5];
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

    private friendlyError(raw: string): string {
        if (raw.includes('ECONNREFUSED')) { return 'Ollama is not running. Run: ollama serve'; }
        if (raw.includes('timed out'))    { return 'Request timed out. The model may be loading or overloaded.'; }
        if (raw.includes('404'))          { return 'Model not found. Run: ollama pull <model-name>'; }
        return raw;
    }
}
