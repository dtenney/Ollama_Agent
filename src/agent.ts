import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';

import { streamChatRequest, OllamaMessage, OllamaToolCall, StreamResult, ToolsNotSupportedError } from './ollamaClient';
import { getConfig } from './config';
import { logInfo, logError } from './logger';
import { buildWorkspaceSummary, SKIP_DIRS } from './workspace';

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
            description: 'Search for a text string across all files in the workspace. Returns matching file:line pairs.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text to search for' },
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
            description: 'Run a shell command in the workspace directory. Output streams live to the chat. Requires user confirmation.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute' },
                },
                required: ['command'],
            },
        },
    },
];

const DEFAULT_SYSTEM_PROMPT = `You are an expert AI coding assistant integrated into VS Code.
You have access to the user's workspace through the following tools:

  workspace_summary  — understand the project structure (call this first)
  read_file          — read any file
  list_files         — list a directory
  search_files       — search for text across files
  create_file        — create a new file
  edit_file          — make targeted edits (old_string → new_string). Preferred for code changes.
  write_file         — overwrite a file entirely (use only when necessary)
  append_to_file     — append text to a file
  rename_file        — rename or move a file
  delete_file        — delete a file (destructive, use carefully)
  run_command        — execute shell commands (npm, git, etc.)

Guidelines:
- Always call workspace_summary or read_file before proposing code changes.
- Prefer edit_file over write_file for targeted modifications.
- Be concise and accurate. Format all code with markdown fenced code blocks.
- Explain what you are doing before calling a tool.`;

// ── Text-mode tool calling (fallback for models without native tool support) ──

/**
 * Appended to the system prompt when the model doesn't support native tools.
 * Instructs the model to emit structured <tool> XML blocks instead.
 */
const TEXT_MODE_TOOL_INSTRUCTIONS = `

═══ TOOL USAGE ═══
You can call workspace tools by outputting a tool call block in EXACTLY this format — nothing before or after it on those lines:

<tool>{"name": "TOOL_NAME", "arguments": {JSON_ARGS}}</tool>

IMPORTANT:
- Output ONLY the <tool>...</tool> block when calling a tool. No extra text on that line.
- After receiving a [TOOL RESULT: ...] block, you may continue your response.
- Call one tool at a time and wait for its result.

Available tools and their argument schemas:
  workspace_summary   — {}
  read_file           — {"path": "relative/path/to/file"}
  list_files          — {"path": "relative/dir (optional)"}
  search_files        — {"query": "text", "path": "optional dir"}
  create_file         — {"path": "path", "content": "full content"}
  edit_file           — {"path": "path", "old_string": "exact text", "new_string": "replacement"}
  write_file          — {"path": "path", "content": "full content"}
  append_to_file      — {"path": "path", "content": "text to append"}
  rename_file         — {"old_path": "current", "new_path": "new name"}
  delete_file         — {"path": "path"}
  run_command         — {"command": "shell command"}
═══════════════════`;

/** Parse <tool>...</tool> blocks from text-mode model output. */
function parseTextToolCalls(text: string): OllamaToolCall[] {
    const calls: OllamaToolCall[] = [];
    const pattern = /<tool>([\s\S]*?)<\/tool>/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1].trim()) as {
                name?: string;
                arguments?: Record<string, unknown>;
            };
            if (parsed.name && typeof parsed.name === 'string') {
                calls.push({
                    function: {
                        name: parsed.name,
                        arguments: parsed.arguments ?? {},
                    },
                });
            }
        } catch { /* skip malformed block */ }
    }
    return calls;
}

/** Remove <tool>...</tool> blocks from content before storing in history / rendering. */
function stripToolBlocks(text: string): string {
    return text.replace(/<tool>[\s\S]*?<\/tool>\s*/g, '').trim();
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

    constructor(private workspaceRoot: string) {}

    get historyLength(): number { return this.history.length; }

    reset(): void { this.history = []; }

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

    async run(userMessage: string, model: string, post: PostFn): Promise<void> {
        this.stopRef = { stop: false };
        this.postFn  = post;
        this.history.push({ role: 'user', content: userMessage });
        logInfo(`Agent run — model: ${model}, mode: ${this.toolMode}, history: ${this.history.length}`);

        const cfg = getConfig();
        const baseSystemContent = cfg.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;

        const MAX_TURNS = 10;
        for (let turn = 0; turn < MAX_TURNS; turn++) {
            if (this.stopRef.stop) { break; }

            // Build system content and tool list based on current mode
            const isTextMode = this.toolMode === 'text';
            const systemContent = isTextMode
                ? baseSystemContent + TEXT_MODE_TOOL_INSTRUCTIONS
                : baseSystemContent;
            const tools = isTextMode ? [] : TOOL_DEFINITIONS;

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
                    turn--; // retry this turn in text mode
                    continue;
                }

                const msg = (err as Error).message;
                logError(`Agent stream error (turn ${turn}): ${msg}`);
                post({ type: 'error', text: this.friendlyError(msg) });
                break;
            }

            post({ type: 'streamEnd' });

            // ── Extract tool calls depending on mode ──────────────────────────
            let toolCalls: OllamaToolCall[];
            let displayContent: string;

            if (isTextMode) {
                toolCalls    = parseTextToolCalls(result.content);
                displayContent = stripToolBlocks(result.content);
            } else {
                toolCalls    = result.toolCalls;
                displayContent = result.content;
            }

            // Store clean content in history (no raw tool XML)
            this.history.push({
                role: 'assistant',
                content: displayContent || result.content,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            });

            if (!toolCalls.length) { break; }

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
                } catch (err) {
                    toolResult = `Error: ${(err as Error).message}`;
                    logError(`Tool ${name} failed: ${toolResult}`);
                    post({ type: 'toolResult', id: toolId, name, success: false, preview: toolResult });
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
    }

    // ── Tool executor ─────────────────────────────────────────────────────────

    private async executeTool(
        name: string,
        args: Record<string, unknown>,
        _toolId: string
    ): Promise<string> {
        const root = this.workspaceRoot;
        if (!root) { return 'No workspace folder is open.'; }

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
                const results: string[] = [];
                const MAX = 40;

                const walk = (dir: string) => {
                    if (results.length >= MAX) { return; }
                    try {
                        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                            if (SKIP_DIRS.has(e.name)) { continue; }
                            const full = path.join(dir, e.name);
                            if (e.isDirectory()) { walk(full); continue; }
                            try {
                                fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                                    if (results.length < MAX && line.toLowerCase().includes(query.toLowerCase())) {
                                        results.push(`${path.relative(root, full)}:${i + 1}: ${line.trim()}`);
                                    }
                                });
                            } catch { /* skip binary */ }
                        }
                    } catch { /* skip inaccessible */ }
                };

                walk(searchDir);
                return results.length
                    ? `Results for "${query}" (${results.length}):\n${results.join('\n')}`
                    : `No matches found for "${query}"`;
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

                // Open VS Code diff view so the user can review the change visually
                const tmpPath = path.join(os.tmpdir(), `ollama-edit-${Date.now()}${path.extname(rel)}`);
                fs.writeFileSync(tmpPath, newContent, 'utf8');

                try {
                    await vscode.commands.executeCommand(
                        'vscode.diff',
                        vscode.Uri.file(full),
                        vscode.Uri.file(tmpPath),
                        `Ollama Agent — Edit: ${rel}`
                    );
                } catch { /* diff view is optional; proceed to confirmation */ }

                const action = await vscode.window.showWarningMessage(
                    `Apply edit to "${rel}"? (${oldString.split('\n').length} line(s) → ${newString.split('\n').length} line(s))`,
                    { modal: true }, 'Apply', 'Cancel'
                );

                // Clean up temp file and close diff tab
                try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
                try {
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                } catch { /* ignore */ }

                if (action !== 'Apply') { return 'Edit cancelled by user.'; }

                fs.writeFileSync(full, newContent, 'utf8');
                this.postFn({ type: 'fileChanged', path: rel, action: 'edited' });
                return `Edited: ${rel} — ${oldString.split('\n').length} line(s) replaced with ${newString.split('\n').length} line(s)`;
            }

            // ── write_file ─────────────────────────────────────────────────
            case 'write_file': {
                const rel     = String(args.path ?? '');
                const content = String(args.content ?? '');
                if (!rel) { throw new Error('path is required'); }
                const full = this.safePath(root, rel);

                const action = await vscode.window.showWarningMessage(
                    `Ollama Agent wants to overwrite "${rel}" (${content.split('\n').length} lines)`,
                    { modal: true }, 'Write', 'Cancel'
                );
                if (action !== 'Write') { return 'Write cancelled by user.'; }

                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, content, 'utf8');
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
                fs.appendFileSync(full, content, 'utf8');
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

                const action = await vscode.window.showWarningMessage(
                    `Ollama Agent wants to DELETE "${rel}". This cannot be undone.`,
                    { modal: true }, 'Delete', 'Cancel'
                );
                if (action !== 'Delete') { return 'Delete cancelled by user.'; }

                fs.unlinkSync(full);
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

            default:
                throw new Error(`Unknown tool: "${name}". Available tools: ${TOOL_DEFINITIONS.map((t) => (t as { function: { name: string } }).function.name).join(', ')}`);
        }
    }

    // ── Streaming command execution ───────────────────────────────────────────

    private runCommandStreaming(cmd: string, cwd: string, cmdId: string): Promise<string> {
        return new Promise((resolve) => {
            const post = this.postFn;
            post({ type: 'commandStart', id: cmdId, cmd });

            const child = spawn('sh', ['-c', cmd], {
                cwd,
                env: { ...process.env },
            });

            let output = '';
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
                child.kill();
                post({ type: 'commandChunk', id: cmdId, text: '\n(timed out after 60s)', stream: 'stderr' });
                finish(-1);
            }, 60_000);

            child.on('close', () => clearTimeout(timer));
        });
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

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
