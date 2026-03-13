import * as vscode from 'vscode';
import * as path from 'path';
import { Agent, PostFn } from './agent';
import { fetchModels, rawGet, streamChatRequest } from './ollamaClient';
import { getConfig } from './config';
import { getActiveContext, buildContextString } from './context';
import { logInfo, logError, channel } from './logger';
import { ChatStorage, ChatSession, StoredMessage, deriveTitle, relativeTime } from './chatStorage';
import { indexWorkspaceFiles, fuzzySearchFiles, buildMentionContext } from './mentions';
import { buildGitDiffContext } from './gitContext';
import { ProjectMemory } from './projectMemory';
import { TieredMemoryManager } from './memoryCore';
import { TemplateManager } from './promptTemplates';
import { SmartContextManager } from './smartContext';
import { SymbolProvider } from './symbolProvider';

// ── Message shapes (webview → extension) ─────────────────────────────────────

interface MsgGetModels     { command: 'getModels' }
interface MsgSendMessage   { command: 'sendMessage'; text: string; model: string; includeFile: boolean; includeSelection: boolean; mentionedFiles?: string[]; mentionedSymbols?: Array<{ name: string; filePath: string; }>; }
interface MsgNewChat       { command: 'newChat' }
interface MsgStopGen       { command: 'stopGeneration' }
interface MsgRetryLast     { command: 'retryLast'; model: string }
interface MsgGetContext    { command: 'getContext' }
interface MsgListSessions  { command: 'listSessions' }
interface MsgLoadSession   { command: 'loadSession';   id: string }
interface MsgDeleteSession { command: 'deleteSession'; id: string }
interface MsgClearSessions { command: 'clearAllSessions' }
interface MsgSearchFiles   { command: 'searchFiles'; query: string }
interface MsgSetPreset     { command: 'setPreset'; preset: string; model?: string; temperature?: number }
interface MsgGetTemplates  { command: 'getTemplates' }
interface MsgToggleSmartContext { command: 'toggleSmartContext'; enabled: boolean }

type WebviewMsg =
    | MsgGetModels | MsgSendMessage  | MsgNewChat      | MsgStopGen
    | MsgRetryLast | MsgGetContext   | MsgListSessions  | MsgLoadSession
    | MsgDeleteSession | MsgClearSessions | MsgSearchFiles | MsgSetPreset
    | MsgGetTemplates | MsgToggleSmartContext
    | { command: 'searchSymbols'; query: string };

// ── Serialised session summary sent to the webview ───────────────────────────

interface SessionSummary {
    id: string;
    title: string;
    model: string;
    messageCount: number;
    updatedAt: number;
    relativeTime: string;
}

function toSummary(s: ChatSession): SessionSummary {
    return {
        id:           s.id,
        title:        s.title,
        model:        s.model,
        messageCount: s.messages.length,
        updatedAt:    s.updatedAt,
        relativeTime: relativeTime(s.updatedAt),
    };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class OllamaAgentProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _agent?: Agent;
    private _editorListener?: vscode.Disposable;
    private _workspaceListener?: vscode.Disposable;
    private _currentWorkspaceRoot?: string;
    /** Mutex to prevent concurrent workspace changes */
    private _workspaceChanging: boolean = false;

    private readonly storage: ChatStorage;
    private readonly memory: ProjectMemory | TieredMemoryManager;
    private readonly templateManager: TemplateManager;
    private readonly smartContext: SmartContextManager;
    private readonly symbolProvider: SymbolProvider;
    private currentSession: ChatSession;
    /** Cached workspace file index for @mention autocomplete. Rebuilt on new workspace. */
    private _fileIndex: ReturnType<typeof indexWorkspaceFiles> = [];
    /** Current active preset name (persisted in workspace state). */
    private _activePreset: string = 'balanced';
    /** Smart context enabled state (persisted in workspace state). */
    private _smartContextEnabled: boolean = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        memoryManager?: TieredMemoryManager | null
    ) {
        this.storage = new ChatStorage(context);
        // Use tiered memory if provided, otherwise fall back to legacy ProjectMemory
        this.memory = memoryManager ?? new ProjectMemory(context);
        this.templateManager = new TemplateManager(context);
        this.symbolProvider = new SymbolProvider();
        this.smartContext = new SmartContextManager();
        // Bootstrap: restore the last session or start fresh
        const sessions = this.storage.list();
        this.currentSession = sessions[0] ?? this.storage.createNew(getConfig().model);
        // Restore active preset from workspace state
        this._activePreset = context.workspaceState.get('ollamaAgent.activePreset', 'balanced');
        // Restore smart context enabled state
        this._smartContextEnabled = context.workspaceState.get('ollamaAgent.smartContextEnabled', false);
        logInfo(`[provider] Loaded session "${this.currentSession.title}" (${this.currentSession.messages.length} msgs)`);
    }

    async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        this._view = webviewView;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        this._currentWorkspaceRoot = workspaceRoot;
        this._agent = new Agent(workspaceRoot, this.memory);

        // Listen for workspace folder changes
        this._workspaceListener?.dispose();
        this._workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            // Prevent concurrent workspace changes
            if (this._workspaceChanging) {
                logInfo('[provider] Workspace change already in progress, skipping');
                return;
            }
            
            const newRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            if (newRoot !== this._currentWorkspaceRoot) {
                this._workspaceChanging = true;
                try {
                    logInfo(`[provider] Workspace changed: ${this._currentWorkspaceRoot} → ${newRoot}`);
                    this._currentWorkspaceRoot = newRoot;
                    
                    // Dispose old agent to prevent memory leak
                    this._agent = undefined;
                    
                    // Recreate agent with new workspace root
                    this._agent = new Agent(newRoot, this.memory);
                    
                    // Clear file index - will be rebuilt on next use
                    this._fileIndex = [];
                    
                    // Start a new session for the new workspace
                    this.startNewSession({});
                    this._view?.webview.postMessage({ type: 'clearChat' });
                    this._view?.webview.postMessage({ 
                        type: 'info', 
                        text: `Switched to workspace: ${vscode.workspace.name || 'Unknown'}` 
                    });
                } finally {
                    this._workspaceChanging = false;
                }
            }
        });
        this.context.subscriptions.push(this._workspaceListener);

        // Build file index for @mention autocomplete (async, non-blocking)
        if (workspaceRoot) {
            // Start indexing immediately but don't block
            Promise.resolve().then(() => {
                try { 
                    this._fileIndex = indexWorkspaceFiles(workspaceRoot);
                    logInfo(`[provider] File index built: ${this._fileIndex.length} files`);
                } catch (err) {
                    logError(`[provider] File indexing failed: ${(err as Error).message}`);
                }
            });
        }

        // Restore agent conversation history from the loaded session
        if (this.currentSession.agentHistory.length) {
            this._agent.restoreHistory(this.currentSession.agentHistory);
        }

        webviewView.webview.options = { enableScripts: true };

        const post = (m: object) => webviewView.webview.postMessage(m);

        webviewView.webview.onDidReceiveMessage(async (raw: WebviewMsg) => {
            logInfo(`[webview→ext] ${raw.command}`);

            switch (raw.command) {

                // ── Model discovery ───────────────────────────────────────
                case 'getModels': {
                    const models = await fetchModels();
                    post({ type: 'models', models, connected: models.length > 0 });
                    break;
                }

                // ── Send a message ────────────────────────────────────────
                case 'sendMessage': {
                    const text  = raw.text?.trim() ?? '';
                    const model = raw.model ?? getConfig().model;
                    if (!text) { break; }

                    logInfo(`[user] ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);
                    
                    // Check if workspace has changed since agent was created
                    // Skip if workspace change is already being handled by the listener
                    const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    if (currentRoot !== this._currentWorkspaceRoot && !this._workspaceChanging) {
                        this._workspaceChanging = true;
                        try {
                            logInfo(`[provider] Workspace changed detected: ${this._currentWorkspaceRoot} → ${currentRoot}`);
                            this._currentWorkspaceRoot = currentRoot;
                            
                            // Dispose old agent to prevent memory leak
                            this._agent = undefined;
                            
                            // Create new agent with fresh memory context for new workspace
                            this._agent = new Agent(currentRoot, this.memory);
                            
                            // Clear file index
                            this._fileIndex = [];
                            
                            // Start a completely new session for the new workspace
                            this.startNewSession({ model });
                            
                            // Clear the chat UI
                            post({ type: 'clearChat' });
                            
                            // Notify user
                            const workspaceName = vscode.workspace.name || 'Unknown';
                            post({ type: 'info', text: `Switched to workspace: ${workspaceName}` });
                            
                            logInfo(`[provider] New session started for workspace: ${workspaceName}`);
                        } finally {
                            this._workspaceChanging = false;
                        }
                    }

                    // Record user message (display text only, no injected context)
                    this.appendToSession({ role: 'user', content: text, timestamp: Date.now() });
                    // Propagate model if it changed
                    this.currentSession.model = model;

                    // Build context string for the model
                    const ctx = buildContextString(raw.includeFile, raw.includeSelection);

                    // Resolve @mentioned files (deduplicate against auto-attached file)
                    const autoAttachedFile = raw.includeFile
                        ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse(''), false)
                        : '';
                    const mentionCtx = raw.mentionedFiles?.length
                        ? buildMentionContext(raw.mentionedFiles, workspaceRoot, new Set([autoAttachedFile]))
                        : '';

                    // Resolve @mentioned symbols
                    let symbolCtx = '';
                    if (raw.mentionedSymbols?.length) {
                        symbolCtx = '\n\n<symbol-mentions>\n';
                        for (const sym of raw.mentionedSymbols) {
                            try {
                                const uri = vscode.Uri.file(path.join(workspaceRoot, sym.filePath));
                                const symbols = await this.symbolProvider.getFileSymbols(uri);
                                const match = symbols.find(s => s.name === sym.name);
                                if (match) {
                                    const content = await this.symbolProvider.getSymbolContent(match);
                                    symbolCtx += `Symbol: ${sym.name} (${sym.filePath})\n\`\`\`\n${content}\n\`\`\`\n\n`;
                                }
                            } catch { /* skip unresolvable symbols */ }
                        }
                        symbolCtx += '</symbol-mentions>';
                    }

                    // Get config for smart context and git diff
                    const cfg = getConfig();

                    // Smart context: auto-include related files
                    let smartCtx = '';
                    if (this._smartContextEnabled && vscode.window.activeTextEditor) {
                        const relatedFiles = await this.smartContext.getRelatedFiles(
                            vscode.window.activeTextEditor.document,
                            cfg.maxContextFiles
                        );
                        if (relatedFiles.length > 0) {
                            const alreadyIncluded = new Set([autoAttachedFile, ...(raw.mentionedFiles || [])]);
                            const filesToInclude = relatedFiles.filter(f => !alreadyIncluded.has(f.relativePath));
                            
                            if (filesToInclude.length > 0) {
                                smartCtx = '\n\n<smart-context>\n';
                                smartCtx += `Auto-included ${filesToInclude.length} related file(s):\n\n`;
                                for (const file of filesToInclude) {
                                    try {
                                        const content = await vscode.workspace.fs.readFile(vscode.Uri.file(file.path));
                                        const text = Buffer.from(content).toString('utf8');
                                        smartCtx += `File: ${file.relativePath} (${file.reason})\n\`\`\`\n${text.slice(0, 10000)}\n\`\`\`\n\n`;
                                    } catch { /* skip unreadable files */ }
                                }
                                smartCtx += '</smart-context>';
                                
                                // Send related files to webview for display
                                post({ type: 'smartContextFiles', files: filesToInclude.map(f => f.relativePath) });
                            }
                        }
                    }

                    // Optionally inject git diff context
                    const gitCtx = cfg.injectGitDiff && workspaceRoot
                        ? await buildGitDiffContext(workspaceRoot)
                        : '';

                    const fullMessage = ctx || mentionCtx || symbolCtx || smartCtx || gitCtx
                        ? `${text}${ctx}${mentionCtx}${symbolCtx}${smartCtx}${gitCtx}`
                        : text;

                    // Wrap post() to capture streamed tokens → save assistant message
                    let assistantBuf = '';
                    const trackedPost: PostFn = (m: object) => {
                        post(m);
                        const pm = m as { type: string; text?: string };
                        if (pm.type === 'token') {
                            assistantBuf += pm.text ?? '';
                        } else if (pm.type === 'streamEnd') {
                            if (assistantBuf.trim()) {
                                const clean = assistantBuf
                                    .replace(/<tool>[\s\S]*?<\/tool>\s*/g, '')
                                    .replace(/<mention[\s\S]*?<\/mention>\s*/g, '')
                                    .replace(/<git-diff[\s\S]*?<\/git-diff>\s*/g, '')
                                    .trim();
                                this.appendToSession({ role: 'assistant', content: clean, timestamp: Date.now() });
                                logInfo(`[assistant] ${clean.slice(0, 120)}${clean.length > 120 ? '…' : ''}`);
                            }
                            assistantBuf = '';
                            this.persistSession();
                        } else if (pm.type === 'error') {
                            const errText = (m as { type: string; text: string }).text;
                            this.appendToSession({ role: 'error', content: errText, timestamp: Date.now() });
                            this.persistSession();
                        }
                    };

                    await this._agent!.run(fullMessage, model, trackedPost);
                    // Sync agent history into session after run completes
                    this.currentSession.agentHistory = this._agent!.conversationHistory;
                    this.persistSession();
                    break;
                }

                // ── New chat ──────────────────────────────────────────────
                case 'newChat': {
                    this.startNewSession(raw as unknown as { model?: string });
                    post({ type: 'clearChat' });
                    logInfo('[provider] New chat started');
                    break;
                }

                // ── Stop generation ───────────────────────────────────────
                case 'stopGeneration': {
                    this._agent!.stop();
                    post({ type: 'streamEnd' });
                    logInfo('[provider] Generation stopped');
                    break;
                }

                // ── Retry last ────────────────────────────────────────────
                case 'retryLast': {
                    const model   = raw.model ?? getConfig().model;
                    const lastMsg = this._agent!.retryLast();
                    if (!lastMsg) { break; }
                    // Remove the last assistant + error messages from session
                    this.trimSessionToLastUser();
                    post({ type: 'removeLastAssistant' });
                    logInfo('[provider] Retrying last message…');

                    let assistantBuf2 = '';
                    const retryPost: PostFn = (m: object) => {
                        post(m);
                        const pm = m as { type: string; text?: string };
                        if (pm.type === 'token') { assistantBuf2 += pm.text ?? ''; }
                        else if (pm.type === 'streamEnd') {
                            if (assistantBuf2.trim()) {
                                this.appendToSession({ role: 'assistant', content: assistantBuf2.replace(/<tool>[\s\S]*?<\/tool>\s*/g, '').replace(/<mention[\s\S]*?<\/mention>\s*/g, '').replace(/<git-diff[\s\S]*?<\/git-diff>\s*/g, '').trim(), timestamp: Date.now() });
                            }
                            assistantBuf2 = '';
                            this.persistSession();
                        }
                    };

                    await this._agent!.run(lastMsg, model, retryPost);
                    this.currentSession.agentHistory = this._agent!.conversationHistory;
                    this.persistSession();
                    break;
                }

                // ── Context ───────────────────────────────────────────────
                case 'getContext': {
                    post({ type: 'contextUpdate', ...getActiveContext() });
                    break;
                }

                // ── Session management ────────────────────────────────────
                case 'listSessions': {
                    const summaries = this.storage.list().map(toSummary);
                    post({ type: 'sessionList', sessions: summaries, currentId: this.currentSession.id });
                    break;
                }

                case 'loadSession': {
                    const session = this.storage.get(raw.id);
                    if (!session) {
                        post({ type: 'error', text: `Session not found: ${raw.id}` });
                        break;
                    }
                    this.currentSession = session;
                    // Dispose old agent and rebuild with the saved history
                    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    this._agent = undefined;
                    this._agent = new Agent(root, this.memory);
                    if (session.agentHistory.length) {
                        this._agent.restoreHistory(session.agentHistory);
                    }
                    logInfo(`[provider] Loaded session "${session.title}"`);
                    post({
                        type: 'sessionLoaded',
                        session: toSummary(session),
                        messages: session.messages,
                    });
                    break;
                }

                case 'deleteSession': {
                    this.storage.delete(raw.id);
                    // If we just deleted the active session, start a new one
                    if (raw.id === this.currentSession.id) {
                        this.startNewSession({});
                        post({ type: 'clearChat' });
                    }
                    post({ type: 'sessionList', sessions: this.storage.list().map(toSummary), currentId: this.currentSession.id });
                    break;
                }

                case 'clearAllSessions': {
                    this.storage.clearAll();
                    this.startNewSession({});
                    post({ type: 'clearChat' });
                    post({ type: 'sessionList', sessions: [], currentId: this.currentSession.id });
                    logInfo('[provider] All sessions cleared');
                    break;
                }

                // ── @mention file search ──────────────────────────────────
                case 'searchFiles': {
                    const q = (raw as MsgSearchFiles).query ?? '';
                    const matches = fuzzySearchFiles(this._fileIndex, q, 12);
                    post({ type: 'fileSearchResults', query: q, files: matches.map((f) => ({ rel: f.rel, display: f.display, ext: f.ext })) });
                    break;
                }

                // ── Search symbols ────────────────────────────────────────
                case 'searchSymbols': {
                    const q = (raw as any).query ?? '';
                    const symbols = await this.symbolProvider.getWorkspaceSymbols(q);
                    const results = symbols.slice(0, 12).map(s => ({
                        name: s.name,
                        kind: s.kind,
                        containerName: s.containerName,
                        filePath: vscode.workspace.asRelativePath(s.location.uri),
                        display: this.symbolProvider.formatSymbolForDisplay(s)
                    }));
                    post({ type: 'symbolSearchResults', query: q, symbols: results });
                    break;
                }

                // ── Model preset selection ────────────────────────────────
                case 'setPreset': {
                    const msg = raw as MsgSetPreset;
                    this._activePreset = msg.preset || '';
                    // Persist to workspace state
                    this.context.workspaceState.update('ollamaAgent.activePreset', this._activePreset);
                    logInfo(`[provider] Preset changed to: ${this._activePreset || 'custom'}`);
                    break;
                }

                // ── Get templates ─────────────────────────────────────────
                case 'getTemplates': {
                    const templates = this.templateManager.getAll();
                    post({ type: 'templates', templates });
                    break;
                }

                // ── Toggle smart context ──────────────────────────────────
                case 'toggleSmartContext': {
                    const msg = raw as MsgToggleSmartContext;
                    this._smartContextEnabled = msg.enabled;
                    this.context.workspaceState.update('ollamaAgent.smartContextEnabled', this._smartContextEnabled);
                    logInfo(`[provider] Smart context ${this._smartContextEnabled ? 'enabled' : 'disabled'}`);
                    break;
                }
            }
        });

        // Push context updates when the active editor / selection changes
        this._editorListener?.dispose();
        this._editorListener = vscode.window.onDidChangeActiveTextEditor(() => {
            if (webviewView.visible) {
                post({ type: 'contextUpdate', ...getActiveContext() });
            }
        });
        this.context.subscriptions.push(
            vscode.window.onDidChangeTextEditorSelection(() => {
                if (webviewView.visible) {
                    post({ type: 'contextUpdate', ...getActiveContext() });
                }
            })
        );

        try {
            webviewView.webview.html = await this.buildHtml();
            logInfo('[provider] Webview HTML loaded');

            // Restore the current session into the freshly-loaded webview
            if (this.currentSession.messages.length) {
                setTimeout(() => {
                    post({
                        type: 'sessionLoaded',
                        session: toSummary(this.currentSession),
                        messages: this.currentSession.messages,
                    });
                }, 300); // small delay so the webview JS has time to initialise
            }

            // Restore active preset
            setTimeout(() => {
                post({ type: 'presetRestored', preset: this._activePreset });
                post({ type: 'smartContextRestored', enabled: this._smartContextEnabled });
            }, 400);
        } catch (err) {
            logError(`[provider] Failed to build webview: ${(err as Error).message}`);
        }
    }

    /** Called from the `ollamaAgent.newChat` command. */
    newChat(): void {
        this.startNewSession({});
        this._view?.webview.postMessage({ type: 'clearChat' });
    }

    /** Called from commands to send a message programmatically (e.g., Explain Selection). */
    sendMessageFromCommand(text: string, includeFile: boolean, includeSelection: boolean): void {
        if (!this._view) {
            logError('[provider] Cannot send message - webview not initialized');
            return;
        }
        
        // Send the message through the webview as if user typed it
        this._view.webview.postMessage({
            type: 'sendFromCommand',
            text,
            includeFile,
            includeSelection
        });
    }

    /** Get the template manager instance. */
    getTemplateManager(): TemplateManager {
        return this.templateManager;
    }

    /** Get current chat messages for export. */
    getCurrentChatMessages(): Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp?: number }> {
        if (!this._agent) {
            return [];
        }
        return this._agent.conversationHistory.map(msg => ({
            role: msg.role as 'user' | 'assistant' | 'system',
            content: msg.content,
            timestamp: Date.now()
        }));
    }

    /** Get current chat title. */
    getCurrentChatTitle(): string {
        return this.currentSession.title || 'Untitled Chat';
    }

    dispose(): void {
        this._editorListener?.dispose();
        this._workspaceListener?.dispose();
    }

    // ── Session helpers ───────────────────────────────────────────────────────

    private startNewSession(opts: { model?: string }): void {
        const model = opts.model ?? getConfig().model;
        this.currentSession = this.storage.createNew(model);
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        
        // IMPORTANT: Dispose old agent and create new one with current workspace root
        // Memory is workspace-scoped, so agent needs fresh memory context
        this._agent = undefined;
        this._agent = new Agent(root, this.memory);
        
        // Re-index files for the new session (workspace may have changed)
        if (root && !this._fileIndex.length) {
            try { this._fileIndex = indexWorkspaceFiles(root); } catch { /* best-effort */ }
        }
        logInfo(`[provider] New session: ${this.currentSession.id}`);
        logInfo(`[provider] Workspace root: ${root || '(none)'}`);
    }

    private appendToSession(msg: StoredMessage): void {
        this.currentSession.messages.push(msg);
        // Update title once we have the first user message
        if (this.currentSession.title === 'New Chat') {
            this.currentSession.title = deriveTitle(this.currentSession.messages);
        }
    }

    private trimSessionToLastUser(): void {
        // Remove everything after (and including) the last non-user message
        while (
            this.currentSession.messages.length > 0 &&
            this.currentSession.messages[this.currentSession.messages.length - 1].role !== 'user'
        ) {
            this.currentSession.messages.pop();
        }
    }

    private persistSession(): void {
        this.storage.upsert(this.currentSession);
        this._view?.webview.postMessage({
            type: 'sessionSaved',
            session: toSummary(this.currentSession),
        });
    }

    // ── HTML builder ──────────────────────────────────────────────────────────

    private async buildHtml(): Promise<string> {
        const read = async (rel: string): Promise<string> => {
            const uri = vscode.Uri.joinPath(this.context.extensionUri, rel);
            return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        };

        // Load vendor bundle — gracefully degrade if missing (first build before vendor step)
        let hljs = '';
        try { hljs = await read('webview/vendor/highlight.bundle.js'); }
        catch { logInfo('[provider] highlight.bundle.js not found — syntax highlighting disabled'); }

        const [html, js] = await Promise.all([
            read('webview/webview.html'),
            read('webview/webview.js'),
        ]);

        const nonce = Array.from({ length: 32 }, () =>
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
                .charAt(Math.floor(Math.random() * 62))
        ).join('');

        return html
            .replace(/\{\{nonce\}\}/g, nonce)
            .replace('{{inlineHljs}}', () => hljs)
            .replace('{{inlineScript}}', () => js);
    }
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export async function runDiagnostics(): Promise<void> {
    channel.show(false);
    logInfo('━━━━━  DIAGNOSTICS  ━━━━━');
    logInfo(`Platform: ${process.platform}  Node: ${process.version}`);
    logInfo(`HTTP_PROXY: ${process.env.HTTP_PROXY ?? process.env.http_proxy ?? '(none)'}`);
    logInfo(`Extension storage: ${vscode.Uri.joinPath(vscode.extensions.getExtension('local-dev.ollama-agent')?.extensionUri ?? vscode.Uri.parse(''), '').fsPath}`);

    try {
        const { status, body } = await rawGet('/', 3000);
        logInfo(`Ollama root → HTTP ${status}: ${body.trim()}`);
    } catch (e) {
        logError(`Ollama unreachable: ${(e as Error).message}`);
    }

    const models = await fetchModels();
    logInfo(`Available models: ${models.join(', ') || '(none)'}`);

    if (models.length) {
        let toks = 0;
        try {
            await streamChatRequest(
                models[0],
                [{ role: 'user', content: 'Say ok.' }],
                [],
                () => toks++,
                { stop: false }
            );
            logInfo(`Stream test OK — ${toks} tokens from ${models[0]}`);
        } catch (e) {
            logError(`Stream test failed: ${(e as Error).message}`);
        }
    }

    logInfo('━━━━━  END  ━━━━━');
    vscode.window.showInformationMessage('Diagnostics done — check Output › Ollama Agent');
}
