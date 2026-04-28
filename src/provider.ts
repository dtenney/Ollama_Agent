import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Agent, PostFn } from './agent';
import { fetchModels, rawGet, streamChatRequest, generateChatTitle } from './ollamaClient';
import { getConfig, getOpenClawConfig } from './config';
import { dispatchTask, checkConnection } from './openClawClient';
import { getActiveContext, buildContextString } from './context';
import { logInfo, logError, channel, toErrorMessage } from './logger';
import { ChatStorage, ChatSession, StoredMessage, deriveTitle, relativeTime } from './chatStorage';
import { appendSessionLog } from './sessionLog';
import { indexWorkspaceFiles, fuzzySearchFiles, buildMentionContext } from './mentions';
import { buildGitDiffContext } from './gitContext';
import { TieredMemoryManager } from './memoryCore';
import { CodeIndexer } from './codeIndex';
import { TemplateManager } from './promptTemplates';
import { SmartContextManager } from './smartContext';
import { SymbolProvider } from './symbolProvider';
import { DiffViewManager } from './diffView';
import { MultiWorkspaceManager } from './multiWorkspace';

/** Strip <tool>{...}</tool> blocks using brace-counting for nested JSON. */
function stripToolBlocksFromText(text: string): string {
    let result = text;
    let pos = 0;
    while (pos < result.length) {
        const idx = result.toLowerCase().indexOf('<tool>', pos);
        if (idx === -1) break;
        let depth = 0, jsonEnd = -1;
        for (let i = idx + 6; i < result.length; i++) {
            if (result[i] === '{') depth++;
            else if (result[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
        }
        if (jsonEnd === -1) { result = result.slice(0, idx); break; }
        let endPos = jsonEnd;
        const afterJson = result.slice(jsonEnd).match(/^\s*<\/tool>/i);
        if (afterJson) endPos = jsonEnd + afterJson[0].length;
        result = result.slice(0, idx) + result.slice(endPos);
        pos = idx;
    }
    return result.replace(/<\/tool>/gi, '');
}

// ── Message shapes (webview → extension) ─────────────────────────────────────

interface MsgGetModels     { command: 'getModels' }
interface MsgSendMessage   { command: 'sendMessage'; text: string; model: string; includeFile: boolean; includeSelection: boolean; mentionedFiles?: string[]; mentionedSymbols?: Array<{ name: string; filePath: string; }>; pinnedFiles?: string[]; }
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
    | { command: 'searchSymbols'; query: string }
    | { command: 'updatePins'; pins: string[] }
    | { command: 'updatePinnedFiles'; files: string[] }
    | { command: 'openSettings' }
    | { command: 'compactContext' }
    | { command: 'undoLastTool' }
    | { command: 'confirmResponse'; id: string; accepted: boolean }
    | { command: 'confirmResponseAll'; id: string; toolName: string }
    | { command: 'applyCodeBlock'; code: string; lang: string }
    | { command: 'webviewError'; text: string }
    | { command: 'openTab' }
    | { command: 'closeTab'; tabId: string }
    | { command: 'switchTab'; tabId: string };

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

// ── Tab state ─────────────────────────────────────────────────────────────────

interface TabState {
    id: string;
    agent: Agent;
    session: ChatSession;
    running: boolean;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class OllamaAgentProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _editorListener?: vscode.Disposable;
    private _selectionListener?: vscode.Disposable;
    private _workspaceListener?: vscode.Disposable;
    private _currentWorkspaceRoot?: string;
    /** Mutex to prevent concurrent workspace changes */
    private _workspaceChanging: boolean = false;
    /** Shared DiffViewManager for applyCodeBlock (reused, not created per call) */
    private _diffViewManager: DiffViewManager = new DiffViewManager();

    // ── Tab management ────────────────────────────────────────────────────────
    private _tabs: Map<string, TabState> = new Map();
    private _activeTabId: string = '';

    /** Active tab — always valid after resolveWebviewView */
    private get _tab(): TabState { return this._tabs.get(this._activeTabId)!; }
    /** Convenience proxies so existing code reads naturally */
    private get _agent(): Agent  { return this._tab.agent; }
    private get _running(): boolean { return this._tab.running; }
    private set _running(v: boolean) { this._tab.running = v; }
    private get currentSession(): ChatSession { return this._tab.session; }
    private set currentSession(s: ChatSession) { this._tab.session = s; }

    private readonly storage: ChatStorage;
    private readonly memory: TieredMemoryManager | null;
    private readonly templateManager: TemplateManager;
    private readonly smartContext: SmartContextManager;
    private readonly symbolProvider: SymbolProvider;
    /** Cached workspace file index for @mention autocomplete. Rebuilt on new workspace. */
    private _fileIndex: Awaited<ReturnType<typeof indexWorkspaceFiles>> = [];
    /** Current active preset name (persisted in workspace state). */
    private _activePreset: string = 'balanced';
    /** Smart context enabled state (persisted in workspace state). */
    private _smartContextEnabled: boolean = false;
    /** Pinned files (always-in-context, persisted in workspace state). */
    private _pinnedFiles: string[] = [];
    /** Listener for file saves to invalidate smart context import cache. */
    private _saveListener?: vscode.Disposable;
    /** Listener for webview messages — disposed on re-resolve to prevent accumulation. */
    private _messageListener?: vscode.Disposable;

    private readonly codeIndexer: CodeIndexer | null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        memoryManager?: TieredMemoryManager | null,
        private readonly workspaceManager?: MultiWorkspaceManager,
        codeIndexer?: CodeIndexer | null
    ) {
        this.storage = new ChatStorage(context);
        this.memory = memoryManager ?? null;
        this.codeIndexer = codeIndexer ?? null;
        this.templateManager = new TemplateManager(context);
        this.symbolProvider = new SymbolProvider();
        this.smartContext = new SmartContextManager();
        // Restore active preset from workspace state
        this._activePreset = context.workspaceState.get('ollamaAgent.activePreset', 'balanced');
        // Restore smart context enabled state
        this._smartContextEnabled = context.workspaceState.get('ollamaAgent.smartContextEnabled', false);
        // Restore pinned files
        this._pinnedFiles = context.workspaceState.get('ollamaAgent.pinnedFiles', []);
        // Bootstrap first tab — agent is created in resolveWebviewView once we have workspaceRoot
        const sessions = this.storage.list();
        const firstSession = sessions[0] ?? this.storage.createNew(getConfig().model);
        const firstTabId = `tab_${Date.now()}`;
        // Temporary placeholder agent — replaced in resolveWebviewView
        this._tabs.set(firstTabId, {
            id: firstTabId,
            agent: null as unknown as Agent,
            session: firstSession,
            running: false,
        });
        this._activeTabId = firstTabId;
        logInfo(`[provider] Loaded session "${firstSession.title}" (${firstSession.messages.length} msgs)`);
    }

    async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        this._view = webviewView;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        this._currentWorkspaceRoot = workspaceRoot;
        // Wire real agent into the first tab only when it still holds the null placeholder.
        // On subsequent re-resolves (sidebar hide/show) all tabs already have live agents —
        // do NOT replace them or we leak the old agent and destroy restored history.
        if (!this._tab.agent) {
            this._tab.agent = new Agent(workspaceRoot, this.memory, this.codeIndexer);
        }

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
                    
                    // Stop, dispose, and recreate all tab agents for the new root.
                    // Also reset all sessions so stale workspace context doesn't bleed in.
                    const model = getConfig().model;
                    for (const tab of this._tabs.values()) {
                        tab.agent?.stop();
                        tab.agent?.dispose();
                        tab.running = false;
                        tab.agent = new Agent(newRoot, this.memory, this.codeIndexer);
                        tab.session = this.storage.createNew(model);
                    }

                    // Clear file index - will be rebuilt on next use
                    this._fileIndex = [];

                    const post = (m: object) => this._view?.webview.postMessage(m);
                    post({ type: 'clearChat' });
                    post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                    logInfo(`[provider] Workspace changed — all tabs reset to new root`);
                } finally {
                    this._workspaceChanging = false;
                }
            }
        });
        this.context.subscriptions.push(this._workspaceListener);

        // Build file index for @mention autocomplete (async, non-blocking)
        if (workspaceRoot) {
            // Start indexing immediately but don't block
            indexWorkspaceFiles(workspaceRoot).then(index => {
                this._fileIndex = index;
                logInfo(`[provider] File index built: ${this._fileIndex.length} files`);
            }).catch(err => {
                logError(`[provider] File indexing failed: ${toErrorMessage(err)}`);
            });

            // Auto-refresh AGENTS.md if stale (non-blocking background run)
            this.maybeRefreshContextFile(workspaceRoot);
        }

        // Restore agent conversation history and task state from the loaded session
        if (this.currentSession.agentHistory.length) {
            this._tab.agent.restoreHistory(this.currentSession.agentHistory);
        }
        if (this.currentSession.activeTask) {
            this._tab.agent.restoreActiveTask(this.currentSession.activeTask);
        }

        webviewView.webview.options = { enableScripts: true };

        const post = (m: object) => this._view?.webview.postMessage(m);

        this._messageListener?.dispose();
        this._messageListener = webviewView.webview.onDidReceiveMessage(async (raw: WebviewMsg) => {
            logInfo(`[webview→ext] ${raw.command}`);

            switch (raw.command) {

                // ── Model discovery ───────────────────────────────────────
                case 'getModels': {
                    const models = await fetchModels();
                    post({ type: 'models', models, connected: models.length > 0, defaultModel: getConfig().model });
                    break;
                }

                // ── Send a message ────────────────────────────────────────
                case 'sendMessage': {
                    if (this._running) {
                        post({ type: 'error', text: 'Please wait for the current response to finish.' });
                        break;
                    }
                    const text  = raw.text?.trim() ?? '';
                    const model = raw.model ?? getConfig().model;
                    if (!text) { break; }
                    this._running = true;
                    // Capture the tab that owns this run. If the user switches tabs mid-run,
                    // _activeTabId changes but this closure still writes to the correct tab.
                    const runTab = this._tab;

                    logInfo(`[user] ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);

                    // ── /openclaw <query> ─────────────────────────────────
                    if (/^\/openclaw\b/i.test(text)) {
                        this._running = false;
                        const query = text.replace(/^\/openclaw\s*/i, '').trim();
                        const ocCfg = getOpenClawConfig();
                        this.appendToSession({ role: 'user', content: text, timestamp: Date.now() });
                        if (!ocCfg.baseUrl) {
                            post({ type: 'error', text: 'OpenCLAW is not configured. Set `ollamaAgent.openClaw.baseUrl` in VS Code settings.' });
                            break;
                        }
                        if (!query) {
                            post({ type: 'error', text: 'Usage: /openclaw <your task or question>' });
                            break;
                        }
                        const taskId = `oc_${Date.now()}`;
                        post({ type: 'openClawDispatched', taskId, query });
                        logInfo(`[openclaw] Task dispatched: ${query.slice(0, 80)}`);
                        dispatchTask(query, ocCfg, (result) => {
                            if (result.error) {
                                post({ type: 'openClawResult', taskId, error: result.error, durationMs: result.durationMs });
                                this.appendToSession({ role: 'error', content: `OpenCLAW error: ${result.error}`, timestamp: Date.now() });
                            } else {
                                post({ type: 'openClawResult', taskId, content: result.content, durationMs: result.durationMs });
                                const saved = `**OpenCLAW result** *(${Math.round(result.durationMs / 1000)}s)*\n\n${result.content}`;
                                this.appendToSession({ role: 'assistant', content: saved, timestamp: Date.now() });
                            }
                            this.persistSession();
                        });
                        break;
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
                    const currentWsRoot = this._currentWorkspaceRoot ?? '';
                    const mentionCtx = raw.mentionedFiles?.length
                        ? buildMentionContext(raw.mentionedFiles, currentWsRoot, new Set([autoAttachedFile]))
                        : '';

                    // Resolve @mentioned symbols
                    let symbolCtx = '';
                    if (raw.mentionedSymbols?.length) {
                        symbolCtx = '\n\n<symbol-mentions>\n';
                        for (const sym of raw.mentionedSymbols) {
                            try {
                                const uri = vscode.Uri.file(path.join(currentWsRoot, sym.filePath));
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

                    // ── Parallel context assembly ─────────────────────────
                    // Smart context, git diff, and symbol resolution are all
                    // independent I/O — run them concurrently.
                    const smartContextFiles: string[] = [];

                    const [smartCtxResult, gitCtx] = await Promise.all([
                        // Smart context: auto-include related files
                        (async (): Promise<string> => {
                            if (!this._smartContextEnabled || !vscode.window.activeTextEditor) { return ''; }
                            const relatedFiles = await this.smartContext.getRelatedFiles(
                                vscode.window.activeTextEditor.document,
                                cfg.maxContextFiles
                            );
                            if (relatedFiles.length === 0) { return ''; }
                            const alreadyIncluded = new Set([autoAttachedFile, ...(raw.mentionedFiles || [])]);
                            const filesToInclude = relatedFiles.filter(f => !alreadyIncluded.has(f.relativePath));
                            if (filesToInclude.length === 0) { return ''; }
                            let sc = '\n\n<smart-context>\n';
                            sc += `Auto-included ${filesToInclude.length} related file(s):\n\n`;
                            await Promise.all(filesToInclude.map(async (file) => {
                                smartContextFiles.push(file.relativePath);
                                try {
                                    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(file.path));
                                    const txt = Buffer.from(content).toString('utf8');
                                    sc += `File: ${file.relativePath} (${file.reason})\n\`\`\`\n${txt.slice(0, 10000)}\n\`\`\`\n\n`;
                                } catch { /* skip unreadable files */ }
                            }));
                            sc += '</smart-context>';
                            post({ type: 'smartContextFiles', files: filesToInclude.map(f => f.relativePath) });
                            return sc;
                        })(),

                        // Git diff context
                        cfg.injectGitDiff && this._currentWorkspaceRoot
                            ? buildGitDiffContext(this._currentWorkspaceRoot, text)
                            : Promise.resolve(''),
                    ]);
                    const smartCtx = smartCtxResult;

                    const fullMessage = ctx || mentionCtx || symbolCtx || smartCtx || gitCtx
                        ? `${text}${ctx}${mentionCtx}${symbolCtx}${smartCtx}${gitCtx}`
                        : text;

                    // Build pinned files context (dedup against mentions, auto-attached, AND smart context)
                    let pinnedCtx = '';
                    if (raw.pinnedFiles?.length && this._currentWorkspaceRoot) {
                        const alreadyIncluded = new Set([
                            autoAttachedFile,
                            ...(raw.mentionedFiles || []),
                            ...smartContextFiles,
                        ]);
                        const uniquePinned = raw.pinnedFiles.filter(f => !alreadyIncluded.has(f));
                        if (uniquePinned.length) {
                            pinnedCtx = buildMentionContext(uniquePinned, this._currentWorkspaceRoot, alreadyIncluded);
                        }
                    }

                    const fullMessageWithPins = pinnedCtx
                        ? `${fullMessage}${pinnedCtx}`
                        : fullMessage;

                    // Wrap post() to capture streamed tokens → save assistant message.
                    // All references use runTab (captured above) so a mid-run tab switch
                    // cannot corrupt the wrong tab's session or flags.
                    let assistantBuf = '';
                    let inThinking = false; // local, not on `this` — tab-safe
                    const isFirstExchange = runTab.session.messages.filter(m => m.role === 'assistant').length === 0;
                    const trackedPost: PostFn = (m: object) => {
                        post(m);
                        const pm = m as { type: string; text?: string };
                        if (pm.type === 'token') {
                            const tok = pm.text ?? '';
                            // Strip thinking sentinels and thinking content from session buffer
                            if (tok === '\x01THINK_START\x01') { inThinking = true; }
                            else if (tok === '\x01THINK_END\x01') { inThinking = false; }
                            else if (!inThinking) { assistantBuf += tok; }
                        } else if (pm.type === 'streamEnd') {
                            if (assistantBuf.trim()) {
                                const clean = stripToolBlocksFromText(assistantBuf)
                                    .replace(/<mention[\s\S]*?<\/mention>\s*/g, '')
                                    .replace(/<git-diff[\s\S]*?<\/git-diff>\s*/g, '')
                                    .replace(/\[wait for result[^\]]*\]/gi, '')
                                    .replace(/\n{3,}/g, '\n\n')
                                    .trim();
                                runTab.session.messages.push({ role: 'assistant', content: clean, timestamp: Date.now() });
                                if (runTab.session.title === 'New Chat') {
                                    runTab.session.title = deriveTitle(runTab.session.messages);
                                }
                                logInfo(`[assistant] ${clean.slice(0, 120)}${clean.length > 120 ? '…' : ''}`);

                                // Auto-generate a title after the first assistant response
                                if (isFirstExchange && runTab.session.title === 'New Chat') {
                                    generateChatTitle(model, text, clean).then((title) => {
                                        if (title && runTab.session.title === 'New Chat') {
                                            runTab.session.title = title;
                                            this.storage.upsert(runTab.session);
                                            post({ type: 'sessionSaved', session: { id: runTab.session.id, title } });
                                            post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                                            logInfo(`[provider] Auto-title: "${title}"`);
                                        }
                                    }).catch(() => {});
                                }
                            }
                            assistantBuf = '';
                            inThinking = false;
                            // Sync agent history and task state mid-run so a crash/force-close
                            // doesn't lose the turns already completed in this run.
                            runTab.session.agentHistory = runTab.agent.conversationHistory;
                            runTab.session.activeTask   = runTab.agent.activeTask;
                            this.storage.upsert(runTab.session);
                        } else if (pm.type === 'error') {
                            const errText = (m as { type: string; text: string }).text;
                            runTab.session.messages.push({ role: 'error', content: errText, timestamp: Date.now() });
                            this.storage.upsert(runTab.session);
                        }
                    };

                    const runStart = Date.now();
                    try {
                        await runTab.agent.run(fullMessageWithPins, model, trackedPost);
                        // Sync agent history and task state into session after run completes
                        runTab.session.agentHistory = runTab.agent.conversationHistory;
                        runTab.session.activeTask   = runTab.agent.activeTask;
                        this.storage.upsert(runTab.session);
                    } finally {
                        const stats = runTab.agent.runStats;
                        if (this._currentWorkspaceRoot) {
                            appendSessionLog(this._currentWorkspaceRoot, {
                                ts:           new Date(runStart).toISOString(),
                                sessionId:    runTab.session.id,
                                model,
                                task:         text.trim().slice(0, 500),
                                turns:        stats.turns,
                                toolCalls:    stats.toolCalls,
                                guardEvents:  stats.guardEvents,
                                filesChanged: stats.filesChanged,
                                avgLogprob:   stats.avgLogprob,
                                durationMs:   Date.now() - runStart,
                                outcome:      stats.outcome,
                            });
                        }
                        runTab.running = false;
                        post({ type: 'agentDone' });
                    }
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
                    this._running = false;
                    post({ type: 'streamEnd' });
                    post({ type: 'agentDone' });
                    logInfo('[provider] Generation stopped');
                    break;
                }

                // ── Retry last ────────────────────────────────────────────
                case 'retryLast': {
                    if (this._running) {
                        post({ type: 'error', text: 'Please wait for the current response to finish.' });
                        break;
                    }
                    this._running = true;
                    const retryTab = this._tab; // capture before any async switch
                    const model   = raw.model ?? getConfig().model;
                    const lastMsg = retryTab.agent.retryLast();
                    if (!lastMsg) { retryTab.running = false; break; }
                    // Remove the last assistant + error messages from session
                    this.trimSessionToLastUser();
                    post({ type: 'removeLastAssistant' });
                    logInfo('[provider] Retrying last message…');

                    let assistantBuf2 = '';
                    let inThinking2 = false; // local, not on `this`
                    const retryPost: PostFn = (m: object) => {
                        post(m);
                        const pm = m as { type: string; text?: string };
                        if (pm.type === 'token') {
                            const tok = pm.text ?? '';
                            if (tok === '\x01THINK_START\x01') { inThinking2 = true; }
                            else if (tok === '\x01THINK_END\x01') { inThinking2 = false; }
                            else if (!inThinking2) { assistantBuf2 += tok; }
                        } else if (pm.type === 'streamEnd') {
                            if (assistantBuf2.trim()) {
                                retryTab.session.messages.push({ role: 'assistant', content: stripToolBlocksFromText(assistantBuf2).replace(/<mention[\s\S]*?<\/mention>\s*/g, '').replace(/<git-diff[\s\S]*?<\/git-diff>\s*/g, '').replace(/\[wait for result[^\]]*\]/gi, '').replace(/\n{3,}/g, '\n\n').trim(), timestamp: Date.now() });
                            }
                            assistantBuf2 = '';
                            inThinking2 = false;
                            retryTab.session.agentHistory = retryTab.agent.conversationHistory;
                            retryTab.session.activeTask   = retryTab.agent.activeTask;
                            this.storage.upsert(retryTab.session);
                        }
                    };

                    const retryStart = Date.now();
                    try {
                        await retryTab.agent.run(lastMsg, model, retryPost);
                        retryTab.session.agentHistory = retryTab.agent.conversationHistory;
                        retryTab.session.activeTask   = retryTab.agent.activeTask;
                        this.storage.upsert(retryTab.session);
                    } finally {
                        const retryStats = retryTab.agent.runStats;
                        if (this._currentWorkspaceRoot) {
                            appendSessionLog(this._currentWorkspaceRoot, {
                                ts:           new Date(retryStart).toISOString(),
                                sessionId:    retryTab.session.id,
                                model,
                                task:         `[retry] ${lastMsg.trim().slice(0, 480)}`,
                                turns:        retryStats.turns,
                                toolCalls:    retryStats.toolCalls,
                                guardEvents:  retryStats.guardEvents,
                                filesChanged: retryStats.filesChanged,
                                avgLogprob:   retryStats.avgLogprob,
                                durationMs:   Date.now() - retryStart,
                                outcome:      retryStats.outcome,
                            });
                        }
                        retryTab.running = false;
                        post({ type: 'agentDone' });
                    }
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
                    // Stop any in-flight generation before switching sessions
                    if (this._running) {
                        this._agent?.stop();
                        this._running = false;
                    }
                    this.currentSession = session;
                    // Dispose old agent and rebuild with the saved history
                    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    this._tab.agent?.dispose();
                    this._tab.agent = new Agent(root, this.memory, this.codeIndexer);
                    if (session.agentHistory.length) {
                        this._tab.agent.restoreHistory(session.agentHistory);
                    }
                    if (session.activeTask) {
                        this._tab.agent.restoreActiveTask(session.activeTask);
                    }
                    if (this.memory) {
                        const stats = this.memory.getStats();
                        const total = stats.reduce((sum, s) => sum + s.count, 0);
                        logInfo(`[provider] Session loaded with ${total} memory entries available`);
                    }
                    logInfo(`[provider] Loaded session "${session.title}"`);
                    post({
                        type: 'sessionLoaded',
                        session: toSummary(session),
                        messages: session.messages,
                        pinnedMsgIds: session.pinnedMsgIds || [],
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

                // ── Tab management ────────────────────────────────────────
                case 'openTab': {
                    const newTabId = `tab_${Date.now()}`;
                    const newSession = this.storage.createNew(getConfig().model);
                    const root = this._currentWorkspaceRoot ?? '';
                    this._tabs.set(newTabId, {
                        id: newTabId,
                        agent: new Agent(root, this.memory, this.codeIndexer),
                        session: newSession,
                        running: false,
                    });
                    this._activeTabId = newTabId;
                    // Order: clear content first, then update tab bar
                    post({ type: 'clearChat' });
                    post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                    logInfo(`[provider] Opened new tab: ${newTabId}`);
                    break;
                }

                case 'closeTab': {
                    const closeMsg = raw as { command: 'closeTab'; tabId: string };
                    const tabToClose = this._tabs.get(closeMsg.tabId);
                    if (!tabToClose) { break; }
                    // Stop before dispose to avoid async continuations on a dead agent
                    tabToClose.agent?.stop();
                    tabToClose.agent?.dispose();
                    this._tabs.delete(closeMsg.tabId);
                    // If we closed the active tab, switch to the nearest remaining tab
                    if (this._activeTabId === closeMsg.tabId) {
                        const remaining = [...this._tabs.keys()];
                        if (remaining.length === 0) {
                            // Always keep at least one tab
                            const fallbackId = `tab_${Date.now()}`;
                            const fallbackSession = this.storage.createNew(getConfig().model);
                            const root = this._currentWorkspaceRoot ?? '';
                            this._tabs.set(fallbackId, {
                                id: fallbackId,
                                agent: new Agent(root, this.memory, this.codeIndexer),
                                session: fallbackSession,
                                running: false,
                            });
                            this._activeTabId = fallbackId;
                        } else {
                            // Pick the tab inserted just before the closed one (nearest left neighbor)
                            const allIds = [...this._tabs.keys()];
                            this._activeTabId = allIds[allIds.length - 1];
                        }
                        const active = this._tab;
                        // Order: clear, populate content, then update tab bar
                        post({ type: 'clearChat' });
                        post({
                            type: 'sessionLoaded',
                            session: toSummary(active.session),
                            messages: active.session.messages,
                            pinnedMsgIds: active.session.pinnedMsgIds || [],
                        });
                    }
                    post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                    logInfo(`[provider] Closed tab: ${closeMsg.tabId}`);
                    break;
                }

                case 'switchTab': {
                    const switchMsg = raw as { command: 'switchTab'; tabId: string };
                    if (!this._tabs.has(switchMsg.tabId) || switchMsg.tabId === this._activeTabId) { break; }
                    // Stop any in-flight run on the outgoing tab
                    const outgoing = this._tab;
                    if (outgoing.running) { outgoing.agent?.stop(); outgoing.running = false; }
                    this._activeTabId = switchMsg.tabId;
                    const incoming = this._tab;
                    // Order: clear content, populate incoming session, then update tab bar highlight
                    post({ type: 'clearChat' });
                    post({
                        type: 'sessionLoaded',
                        session: toSummary(incoming.session),
                        messages: incoming.session.messages,
                        pinnedMsgIds: incoming.session.pinnedMsgIds || [],
                    });
                    post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                    logInfo(`[provider] Switched to tab: ${switchMsg.tabId}`);
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

                // ── Update pinned files ───────────────────────────────────
                case 'updatePinnedFiles': {
                    const pfMsg = raw as { command: 'updatePinnedFiles'; files: string[] };
                    this._pinnedFiles = pfMsg.files || [];
                    this.context.workspaceState.update('ollamaAgent.pinnedFiles', this._pinnedFiles);
                    logInfo(`[provider] Pinned files updated: ${this._pinnedFiles.join(', ') || '(none)'}`);
                    break;
                }

                // ── Pin persistence ───────────────────────────────────────
                case 'updatePins': {
                    const pinMsg = raw as { command: 'updatePins'; pins: string[] };
                    this.currentSession.pinnedMsgIds = pinMsg.pins;
                    this.persistSession();
                    break;
                }

                // ── Open extension settings ──────────────────────────────
                case 'openSettings': {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'ollamaAgent');
                    break;
                }

                // ── Manual context compaction ─────────────────────────────
                case 'compactContext': {
                    if (this._running) {
                        post({ type: 'error', text: 'Cannot compact while a response is in progress.' });
                        break;
                    }
                    post({ type: 'compactingStarted' });
                    const result = await this._agent!.compactContext(25, (token) => {
                        post({ type: 'compactSummaryToken', token });
                    });
                    post({
                        type: 'contextCompacted',
                        messagesRemoved: result.removed,
                        newPercentage: result.newPercentage,
                        summary: result.summary,
                    });
                    this.currentSession.agentHistory = this._agent!.conversationHistory;
                    this.currentSession.activeTask   = this._agent!.activeTask;
                    this.persistSession();
                    logInfo(`[provider] Manual compact: removed ${result.removed} messages`);
                    break;
                }

                // ── Undo last tool execution ──────────────────────────────
                case 'undoLastTool': {
                    const undoResult = this._agent!.undoLastTool();
                    if (undoResult) {
                        post({ type: 'undoResult', success: true, message: undoResult });
                        logInfo(`[provider] ${undoResult}`);
                    } else {
                        post({ type: 'undoResult', success: false, message: 'Nothing to undo' });
                    }
                    break;
                }

                // ── Apply code block from chat ───────────────────────────────
                case 'applyCodeBlock': {
                    const applyMsg = raw as { command: 'applyCodeBlock'; code: string; lang: string };
                    await this.applyCodeBlock(applyMsg.code, applyMsg.lang);
                    break;
                }

                // ── Inline confirmation response from webview ─────────────────
                case 'confirmResponse': {
                    const crMsg = raw as unknown as { command: 'confirmResponse'; id: string; accepted: boolean };
                    this._agent?.resolveConfirmation(crMsg.accepted);
                    break;
                }

                // ── Batch-approve: accept this AND all future calls to same tool ──
                case 'confirmResponseAll': {
                    const caMsg = raw as unknown as { command: 'confirmResponseAll'; id: string; toolName: string };
                    this._agent?.resolveConfirmationAll(caMsg.toolName);
                    break;
                }

                // ── Webview JS error reporting ────────────────────────────────
                case 'webviewError': {
                    const errMsg = raw as { command: 'webviewError'; text: string };
                    logError(errMsg.text);
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
        // Track selection listener as a class field to prevent accumulation on re-resolve
        this._selectionListener?.dispose();
        this._selectionListener = vscode.window.onDidChangeTextEditorSelection(() => {
            if (webviewView.visible) {
                post({ type: 'contextUpdate', ...getActiveContext() });
            }
        });
        // Invalidate smart context import cache when files are saved
        this._saveListener?.dispose();
        this._saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
            this.smartContext.clearCache(doc.uri.fsPath);
        });

        try {
            webviewView.webview.html = await this.buildHtml();
            logInfo('[provider] Webview HTML loaded');

            // Restore tabs and current session into the freshly-loaded webview
            setTimeout(() => {
                post({ type: 'tabList', tabs: this.getTabSummaries(), activeTabId: this._activeTabId });
                if (this.currentSession.messages.length) {
                    post({
                        type: 'sessionLoaded',
                        session: toSummary(this.currentSession),
                        messages: this.currentSession.messages,
                        pinnedMsgIds: this.currentSession.pinnedMsgIds || [],
                    });
                }
            }, 300); // small delay so the webview JS has time to initialise

            // Restore active preset
            setTimeout(() => {
                post({ type: 'presetRestored', preset: this._activePreset });
                post({ type: 'smartContextRestored', enabled: this._smartContextEnabled });
                post({ type: 'pinnedFilesRestored', files: this._pinnedFiles.map(f => ({ rel: f })) });
            }, 400);
        } catch (err) {
            logError(`[provider] Failed to build webview: ${toErrorMessage(err)}`);
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
        return this.currentSession.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(msg => ({
                role: msg.role as 'user' | 'assistant' | 'system',
                content: msg.content,
                timestamp: msg.timestamp
            }));
    }

    /** Get current chat title. */
    getCurrentChatTitle(): string {
        return this.currentSession.title || 'Untitled Chat';
    }

    dispose(): void {
        this._editorListener?.dispose();
        this._selectionListener?.dispose();
        this._workspaceListener?.dispose();
        this._saveListener?.dispose();
        this._messageListener?.dispose();
        for (const tab of this._tabs.values()) { tab.agent?.stop(); tab.agent?.dispose(); }
        this._tabs.clear();
        this._diffViewManager.dispose();
    }

    // ── Apply code block from chat ─────────────────────────────────────────

    private async applyCodeBlock(code: string, _lang: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor — open a file first, then click Apply.');
            return;
        }

        const doc = editor.document;
        const original = doc.getText();
        const filePath = doc.uri.fsPath;

        // If there's a selection, replace just the selection; otherwise replace entire file
        const selection = editor.selection;
        const hasSelection = !selection.isEmpty;

        let newContent: string;
        if (hasSelection) {
            const before = original.slice(0, doc.offsetAt(selection.start));
            const after = original.slice(doc.offsetAt(selection.end));
            newContent = before + code + after;
        } else {
            newContent = code;
        }

        // Show diff preview using shared DiffViewManager
        try {
            await this._diffViewManager.showDiffPreview(filePath, original, newContent);
            const choice = await vscode.window.showInformationMessage(
                `Apply changes to ${path.basename(filePath)}?`,
                'Accept', 'Reject'
            );
            if (choice === 'Accept') {
                const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(original.length));
                await editor.edit(eb => eb.replace(fullRange, newContent));
                logInfo(`[provider] Applied code block to ${vscode.workspace.asRelativePath(doc.uri)}`);
            }
            await this._diffViewManager.closeDiffPreview();
        } catch (err) {
            logError(`[provider] Apply code block failed: ${toErrorMessage(err)}`);
        }
    }

    // ── Session helpers ───────────────────────────────────────────────────────

    private startNewSession(opts: { model?: string }): void {
        const model = opts.model ?? getConfig().model;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        this._tab.session = this.storage.createNew(model);
        this._tab.agent?.dispose();
        this._tab.agent = new Agent(root, this.memory, this.codeIndexer);
        if (root && !this._fileIndex.length) {
            indexWorkspaceFiles(root).then(idx => { this._fileIndex = idx; }).catch(() => {});
        }
        logInfo(`[provider] New session: ${this.currentSession.id}`);
        logInfo(`[provider] Workspace root: ${root || '(none)'}`);
    }

    /** Build tab summaries for sending to the webview. */
    private getTabSummaries(): Array<{ tabId: string; title: string; active: boolean }> {
        return [...this._tabs.entries()].map(([id, tab]) => ({
            tabId: id,
            title: tab.session.title,
            active: id === this._activeTabId,
        }));
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

    /**
     * Check if AGENTS.md (or CLAUDE.md / .ollamapilot.md) in the workspace root is stale.
     * If so, fire a silent background agent run to refresh it.
     * Controlled by `contextFile.autoUpdateDays` (0 = disabled).
     */
    private maybeRefreshContextFile(workspaceRoot: string): void {
        const cfg = getConfig();
        if (!cfg.contextFileAutoUpdateDays || cfg.contextFileAutoUpdateDays <= 0) { return; }

        const candidates = ['.ollamapilot.md', 'AGENTS.md', 'CLAUDE.md'];
        let contextFilePath: string | null = null;
        let ageMsDays = Infinity;

        for (const name of candidates) {
            const p = path.join(workspaceRoot, name);
            try {
                const stat = fs.statSync(p);
                const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
                if (ageDays < ageMsDays) { ageMsDays = ageDays; contextFilePath = p; }
            } catch { /* file doesn't exist */ }
        }

        const targetFile = contextFilePath ? path.basename(contextFilePath) : 'AGENTS.md';
        const isStale = ageMsDays > cfg.contextFileAutoUpdateDays;
        const isMissing = contextFilePath === null;

        if (!isStale && !isMissing) { return; }

        const reason = isMissing ? 'no context file found' : `${targetFile} is ${Math.floor(ageMsDays)} days old`;
        logInfo(`[context-file] Auto-refresh triggered — ${reason} (threshold: ${cfg.contextFileAutoUpdateDays} days)`);

        const REFRESH_PROMPT = `Scan this project and generate (or update) an AGENTS.md file in the workspace root. The file should include:
1. One-paragraph project description (what it does, tech stack)
2. Directory structure overview (key folders and their purpose)
3. Coding conventions you can infer from reading the code (naming, error handling, return formats, DB patterns, etc.)
4. Key domains/modules — one line each explaining what each major file or group of files does
5. Any constraints or rules an AI agent should follow when making changes

Steps:
- Read the root directory listing
- Read package.json or requirements.txt to identify the stack
- Sample 3-5 representative source files to infer conventions
- If AGENTS.md already exists, read it first and update rather than replace
- Write the final file to AGENTS.md in the project root

Be specific and factual — only write what you can confirm from the code, not guesses.`;

        // Run silently in background — use a fresh agent so it doesn't pollute the current session history
        const backgroundAgent = new Agent(workspaceRoot, this.memory, this.codeIndexer);
        const model = cfg.model;
        const silentPost: PostFn = (m) => {
            const msg = m as { type: string; path?: string };
            if (msg.type === 'fileChanged' && msg.path) {
                logInfo(`[context-file] Auto-refresh wrote ${msg.path}`);
                this._view?.webview.postMessage({ type: 'contextFileRefreshed', path: msg.path });
            }
        };
        backgroundAgent.run(REFRESH_PROMPT, model, silentPost).then(() => {
            logInfo('[context-file] Auto-refresh complete');
        }).catch(err => {
            logInfo(`[context-file] Auto-refresh skipped: ${toErrorMessage(err)}`);
        });
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
        logError(`Ollama unreachable: ${toErrorMessage(e)}`);
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
            logError(`Stream test failed: ${toErrorMessage(e)}`);
        }
    }

    logInfo('━━━━━  END  ━━━━━');
    vscode.window.showInformationMessage('Diagnostics done — check Output › Ollama Agent');
}
