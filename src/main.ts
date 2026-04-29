import * as vscode from 'vscode';
import { OllamaAgentProvider, runDiagnostics } from './provider';
import { fetchModels, streamChatRequest, keepAliveModel } from './ollamaClient';
import { getConfig } from './config';
import { channel, logInfo, logError, toErrorMessage } from './logger';
import { startMCPServer, stopAllMCPServers } from './mcpClient';
import { loadMCPConfig, createExampleMCPConfig } from './mcpConfig';
import { TieredMemoryManager } from './memoryCore';
import { getMemoryConfig } from './memoryConfig';
import { QdrantClient } from './qdrantClient';
import { EmbeddingService } from './embeddingService';
import { MemoryViewProvider, MemoryTreeItem } from './memoryViewProvider';
import { OllamaCodeActionsProvider } from './codeActionsProvider';
import { OllamaCodeLensProvider } from './codeLensProvider';
import { OllamaInlineCompletionProvider } from './inlineCompletionProvider';
import { ChatExporter } from './chatExporter';
import { MultiWorkspaceManager } from './multiWorkspace';
import { buildReviewRequest, buildCommitReviewRequest } from './codeReview';
import { showManageTemplatesUI } from './promptTemplates';
import { scanProjectDocs } from './docScanner';
import { CodeIndexer } from './codeIndex';
import { ensureEnvironmentContext } from './environmentProbe';
import * as fs from 'fs';
import * as path from 'path';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logInfo('Ollama Agent activating…');
    logInfo(`extensionUri: ${context.extensionUri.fsPath}`);
    channel.show(true);
    context.subscriptions.push(channel);

    // ── Start MCP servers ────────────────────────────────────────────────────
    const mcpConfigs = loadMCPConfig();
    if (mcpConfigs.length > 0) {
        logInfo(`Starting ${mcpConfigs.length} MCP server(s)...`);
        const serverPromises = mcpConfigs.map(cfg => 
            startMCPServer(cfg.name, cfg.command, cfg.args, cfg.env || {})
                .catch(err => {
                    logError(`MCP server ${cfg.name} failed to start: ${toErrorMessage(err)}`);
                    return null;
                })
        );
        
        // Don't block activation on MCP servers
        Promise.all(serverPromises)
            .then(servers => {
                const successful = servers.filter(s => s !== null).length;
                logInfo(`MCP servers started: ${successful}/${mcpConfigs.length}`);
            })
            .catch(err => {
                logError(`Unexpected error starting MCP servers: ${toErrorMessage(err)}`);
            });
    } else {
        logInfo('No MCP servers configured');
    }

    // ── Initialize Memory System ─────────────────────────────────────────────
    const memoryConfig = getMemoryConfig();
    let memoryManager: TieredMemoryManager | null = null;
    
    if (memoryConfig.enabled) {
        try {
            const workspaceName = vscode.workspace.name || 'default';
            let qdrantClient: QdrantClient | undefined;
            let embeddingService: EmbeddingService | undefined;
            
            // Try to initialize Qdrant and embeddings for Tier 4-5
            try {
                embeddingService = new EmbeddingService(memoryConfig);
                const vectorSize = embeddingService.getEmbeddingDimension();
                qdrantClient = new QdrantClient(memoryConfig, workspaceName, vectorSize);
                await qdrantClient.initialize();
                
                // Validate collection dimensions match embedding model
                const collectionInfo = await qdrantClient.getCollectionInfo();
                if (collectionInfo && collectionInfo.vectorSize !== vectorSize) {
                    logError(`[memory] Dimension mismatch detected: collection is ${collectionInfo.vectorSize}D but model produces ${vectorSize}D`);
                    logInfo(`[memory] Recreating collection with correct dimensions...`);
                    await qdrantClient.deleteCollection();
                    await qdrantClient.initialize();
                    logInfo(`[memory] Collection recreated with ${vectorSize}D vectors`);
                }
                
                logInfo(`[memory] Qdrant connected at ${memoryConfig.qdrantUrl}`);
                logInfo(`[memory] Embedding model: ${memoryConfig.embeddingModel} (${vectorSize}d)`);
            } catch (error) {
                if (memoryConfig.fallbackToLocal) {
                    logError(`[memory] Qdrant unavailable, using local storage only: ${toErrorMessage(error)}`);
                    qdrantClient = undefined;
                    embeddingService = undefined;
                    // Notify the user so they know semantic search (Tiers 4-5) is offline.
                    // Use showWarningMessage so it appears in the UI, not just the log.
                    vscode.window.showWarningMessage(
                        'OllamaPilot: Qdrant is unavailable — memory Tiers 4-5 (semantic search) are offline. Tiers 0-3 (local) are still active.',
                        'Open Log'
                    ).then(choice => {
                        if (choice === 'Open Log') {
                            vscode.commands.executeCommand('ollamapilot.showLog');
                        }
                    });
                } else {
                    throw error;
                }
            }
            
            memoryManager = new TieredMemoryManager(
                context,
                memoryConfig,
                qdrantClient,
                embeddingService
            );
            
            logInfo('[memory] Multi-tiered memory system initialized');
            logInfo(`[memory] Auto-load tiers: ${memoryConfig.autoLoadTiers.join(', ')}`);
            
            // Log memory stats
            const stats = memoryManager.getStats();
            const totalEntries = stats.reduce((sum, s) => sum + s.count, 0);
            const totalTokens = stats.reduce((sum, s) => sum + s.tokens, 0);
            logInfo(`[memory] Current state: ${totalEntries} entries, ~${totalTokens} tokens`);
            
            // Schedule periodic memory maintenance (daily)
            const maintenanceInterval = setInterval(async () => {
                if (memoryManager) {
                    logInfo('[memory] Running scheduled maintenance...');
                    const demoted = await memoryManager.demoteStaleEntries();
                    const promoted = await memoryManager.promoteFrequentEntries();
                    const archived = await memoryManager.archiveOldEntries();
                    logInfo(`[memory] Maintenance complete: ${demoted} demoted, ${promoted} promoted, ${archived} archived`);
                }
            }, 24 * 60 * 60 * 1000); // 24 hours
            
            context.subscriptions.push({
                dispose: () => clearInterval(maintenanceInterval)
            });

            // Register TieredMemoryManager disposal
            context.subscriptions.push({
                dispose: () => memoryManager?.dispose()
            });
            
            // Run initial maintenance and project seeding on startup
            setTimeout(async () => {
                try {
                    if (memoryManager) {
                        logInfo('[memory] Running initial maintenance...');
                        await memoryManager.demoteStaleEntries();
                        await memoryManager.promoteFrequentEntries();
                        await memoryManager.archiveOldEntries();
                        // Seed project memory from workspace files (runs once per workspace)
                        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        if (root) {
                            await memoryManager.seedProjectMemory(root);
                        }
                    }
                } catch (err) {
                    logError(`[memory] Initial maintenance failed: ${toErrorMessage(err)}`);
                }

                // Probe local environment and write/refresh .ollamapilot/context.md
                // Runs on first activation and whenever the file is >7 days stale.
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (root) {
                    ensureEnvironmentContext(root).catch(err =>
                        logError(`[env-probe] Unexpected error: ${toErrorMessage(err)}`)
                    );
                }
            }, 5000); // 5 seconds after startup
        } catch (error) {
            logError(`[memory] Failed to initialize: ${toErrorMessage(error)}`);
            memoryManager = null;
        }
    } else {
        logInfo('[memory] Multi-tiered memory disabled in settings');
    }

    // ── Code Index (semantic file search via Qdrant) ─────────────────────────
    // Builds a per-file vector index so the agent can find relevant files by
    // semantic similarity rather than keyword matching.  Runs in the background
    // so it never blocks activation.
    let codeIndexer: CodeIndexer | null = null;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    logInfo(`[code-index] Setup: memory.enabled=${memoryConfig.enabled}, workspaceRoot=${workspaceRoot ?? '(none)'}`);

    if (memoryConfig.enabled && workspaceRoot) {
        try {
            const embSvc = new EmbeddingService(memoryConfig);
            const vectorSize = embSvc.getEmbeddingDimension();
            const workspaceName = vscode.workspace.name || path.basename(workspaceRoot);
            codeIndexer = new CodeIndexer(memoryConfig, workspaceName, workspaceRoot, embSvc, vectorSize);
            // Non-blocking — indexing happens in the background
            codeIndexer.initialize().catch(err =>
                logError(`[code-index] Init error: ${toErrorMessage(err)}`)
            );
            logInfo('[code-index] CodeIndexer created');

            // Dispose indexer (cancels in-progress indexing) on extension deactivate/reload
            context.subscriptions.push({ dispose: () => codeIndexer?.dispose() });

            // Re-index any file the user saves
            context.subscriptions.push(
                vscode.workspace.onDidSaveTextDocument(doc => {
                    if (codeIndexer && doc.uri.scheme === 'file') {
                        codeIndexer.indexFile(doc.uri.fsPath).catch(() => {/* silent */});
                    }
                })
            );
        } catch (err) {
            logError(`[code-index] Failed to create CodeIndexer: ${toErrorMessage(err)}`);
        }
    }

    // Make codeIndexer available to the provider
    (global as any).__ollamapilotCodeIndexer = codeIndexer;

    // ── Multi-Workspace Manager ──────────────────────────────────────────────
    const workspaceManager = new MultiWorkspaceManager(context, memoryManager);
    await workspaceManager.initialize();
    context.subscriptions.push({ dispose: () => workspaceManager.dispose() });

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
            for (const folder of event.added) {
                await workspaceManager.addWorkspace(folder);
            }
            for (const folder of event.removed) {
                workspaceManager.removeWorkspace(folder);
            }
            if (workspaceManager.isMultiWorkspace()) {
                logInfo(`[workspace] Now managing ${workspaceManager.getWorkspaceCount()} folders`);
            }
        })
    );

    // ── Sidebar provider ─────────────────────────────────────────────────────
    const provider = new OllamaAgentProvider(context, memoryManager, workspaceManager, codeIndexer);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ollamaAgent.chatView', provider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    // ── Code Actions Provider (right-click menu) ───────────────────────────
    const codeActionsProvider = new OllamaCodeActionsProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file' },
            codeActionsProvider,
            { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite, vscode.CodeActionKind.QuickFix] }
        )
    );

    // ── Code Lens Provider ("✨ Explain" above functions) ────────────────────
    const codeLensConfig = vscode.workspace.getConfiguration('ollamaAgent');
    if (codeLensConfig.get<boolean>('codeLens.enabled', false)) {
        const codeLensProvider = new OllamaCodeLensProvider();
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider(
                { scheme: 'file' },
                codeLensProvider
            )
        );
        logInfo('[codeLens] Code lens provider registered');
    }

    // ── Inline Completion Provider ──────────────────────────────────────────
    const inlineConfig = vscode.workspace.getConfiguration('ollamaAgent');
    if (inlineConfig.get<boolean>('inlineCompletions.enabled', false)) {
        const inlineProvider = new OllamaInlineCompletionProvider();
        context.subscriptions.push(
            vscode.languages.registerInlineCompletionItemProvider(
                { pattern: '**' },
                inlineProvider
            )
        );
        logInfo('[inline] Inline completion provider registered');
    }

    // ── Memory View Provider ─────────────────────────────────────────────────
    let memoryViewProvider: MemoryViewProvider | undefined;
    if (memoryManager) {
        memoryViewProvider = new MemoryViewProvider(memoryManager);
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('ollamaAgent.memoryView', memoryViewProvider)
        );
        logInfo('[memory] Memory tree view registered');
    }

    // ── Commands ─────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.openChat', () =>
            vscode.commands.executeCommand('ollamaAgent.chatView.focus')
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.newChat', () => provider.newChat())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.generateCode', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('No active editor.'); return; }
            const selection = editor.selection;
            const prompt = editor.document.getText(selection);
            if (!prompt) { vscode.window.showWarningMessage('Select text to use as prompt first.'); return; }

            const model = getConfig().model;
            let full = '';
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Ollama: generating…', cancellable: false },
                    async () => {
                        const result = await streamChatRequest(
                            model,
                            [{ role: 'user', content: prompt }],
                            [],
                            (t) => (full += t),
                            { stop: false }
                        );
                        full = result.content;
                    }
                );
                await editor.edit((b) => b.replace(selection, full));
            } catch (err) {
                vscode.window.showErrorMessage(`Ollama error: ${toErrorMessage(err)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.explainSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor.');
                return;
            }
            
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);
            
            if (!selectedText) {
                vscode.window.showWarningMessage('Please select code to explain.');
                return;
            }
            
            // Get language and filename for context
            const language = editor.document.languageId;
            const filename = editor.document.fileName.split(/[\\\/]/).pop() || 'file';
            
            // Open chat and send explain prompt
            await vscode.commands.executeCommand('ollamaAgent.chatView.focus');
            
            // Send message to provider with selection context
            const prompt = `Explain this ${language} code from ${filename}:\n\n\`\`\`${language}\n${selectedText}\n\`\`\``;
            provider.sendMessageFromCommand(prompt, true, true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.codeAction', async (args: {
            type: string;
            selection: string;
            language: string;
            filename: string;
        }) => {
            await vscode.commands.executeCommand('ollamaAgent.chatView.focus');
            
            let prompt = '';
            switch (args.type) {
                case 'explain':
                    prompt = `Explain this ${args.language} code from ${args.filename}:\n\n\`\`\`${args.language}\n${args.selection}\n\`\`\``;
                    break;
                case 'comment':
                    prompt = `Add inline comments to this ${args.language} code:\n\n\`\`\`${args.language}\n${args.selection}\n\`\`\``;
                    break;
                case 'refactor':
                    prompt = `Suggest refactoring improvements for this ${args.language} code:\n\n\`\`\`${args.language}\n${args.selection}\n\`\`\``;
                    break;
                case 'bugs':
                    prompt = `Analyze this ${args.language} code for potential bugs and issues:\n\n\`\`\`${args.language}\n${args.selection}\n\`\`\``;
                    break;
                case 'tests': {
                    const testFramework: Record<string, string> = {
                        python: 'pytest', javascript: 'Jest', typescript: 'Jest',
                        java: 'JUnit', kotlin: 'JUnit', go: 'testing package',
                        rust: '#[test]', csharp: 'xUnit', ruby: 'RSpec', php: 'PHPUnit',
                    };
                    const fw = testFramework[args.language] || 'the standard test framework';
                    prompt = `Generate unit tests for this ${args.language} code using ${fw}. Cover edge cases and error paths. Create the test file using create_file:\n\n\`\`\`${args.language}\n${args.selection}\n\`\`\``;
                    break;
                }
                case 'docs': {
                    const docStyle: Record<string, string> = {
                        python: 'Google-style docstrings',
                        javascript: 'JSDoc', typescript: 'JSDoc/TSDoc',
                        java: 'Javadoc', kotlin: 'KDoc',
                        rust: '/// doc comments', go: 'Go doc comments',
                        csharp: 'XML doc comments', php: 'PHPDoc',
                        ruby: 'YARD', c: 'Doxygen', cpp: 'Doxygen',
                    };
                    const style = docStyle[args.language] || 'appropriate documentation comments';
                    prompt = `Add ${style} to every function/class/method in this ${args.language} code. Include parameter types, return types, and descriptions. Use edit_file to apply the changes to ${args.filename}:\n\n\`\`\`${args.language}\n${args.selection}\n\`\`\``;
                    break;
                }
                default:
                    prompt = `Help with this ${args.language} code:\n\n\`\`\`${args.language}\n${args.selection}\n\`\`\``;
            }
            
            provider.sendMessageFromCommand(prompt, false, true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.explainError', async (args: {
            error: string;
            code: string;
            language: string;
            filename: string;
            line: number;
            severity: string;
        }) => {
            await vscode.commands.executeCommand('ollamaAgent.chatView.focus');
            
            const prompt = `Explain this ${args.severity} in ${args.filename} (line ${args.line}) and suggest a fix:\n\n` +
                `**Error:** ${args.error}\n\n` +
                `**Code:**\n\`\`\`${args.language}\n${args.code}\n\`\`\``;
            
            provider.sendMessageFromCommand(prompt, false, false);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.diagnose', () => runDiagnostics())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.createMCPConfig', () => createExampleMCPConfig())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.runMemoryMaintenance', async () => {
            if (memoryManager) {
                logInfo('[memory] Running manual maintenance...');
                const demoted = await memoryManager.demoteStaleEntries();
                const promoted = await memoryManager.promoteFrequentEntries();
                const archived = await memoryManager.archiveOldEntries();
                const stats = memoryManager.getStats();
                const totalEntries = stats.reduce((sum, s) => sum + s.count, 0);
                
                vscode.window.showInformationMessage(
                    `Memory maintenance complete: ${demoted} demoted, ${promoted} promoted, ${archived} archived. Total: ${totalEntries} entries.`
                );
                logInfo(`[memory] Maintenance complete: ${demoted} demoted, ${promoted} promoted, ${archived} archived`);
            } else {
                vscode.window.showWarningMessage('Memory system not initialized');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.clearMemory', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Clear ALL memory entries? This cannot be undone.',
                'Clear All', 'Cancel'
            );
            if (confirm === 'Clear All') {
                if (memoryManager) {
                    await memoryManager.clearAll();
                } else {
                    await context.workspaceState.update('ollamaAgent.memoryCore', undefined);
                    const memRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (memRoot) {
                        const memFile = path.join(memRoot, '.ollamapilot', 'memory.json');
                        if (fs.existsSync(memFile)) {
                            fs.unlinkSync(memFile);
                        }
                    }
                }
                memoryViewProvider?.refresh();
                vscode.window.showInformationMessage('Memory cleared.');
                logInfo('[memory] All memory entries cleared');
            }
        })
    );

    // ── Memory View Commands ─────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.refreshMemory', () => {
            memoryViewProvider?.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.promoteEntry', async (item: MemoryTreeItem) => {
            if (!memoryManager || !item.entry) return;
            
            if (item.entry.tier === 0) {
                vscode.window.showWarningMessage('Entry is already at highest tier (Critical)');
                return;
            }
            
            try {
                const oldTier = item.entry.tier;
                const success = await memoryManager.promoteEntry(item.entry.id);
                if (success) {
                    memoryViewProvider?.refresh();
                    vscode.window.showInformationMessage(`Promoted from Tier ${oldTier} to Tier ${oldTier - 1}`);
                } else {
                    vscode.window.showWarningMessage('Failed to promote entry');
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to promote: ${toErrorMessage(err)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.demoteEntry', async (item: MemoryTreeItem) => {
            if (!memoryManager || !item.entry) return;
            
            if (item.entry.tier === 5) {
                vscode.window.showWarningMessage('Entry is already at lowest tier (Archive)');
                return;
            }
            
            try {
                const oldTier = item.entry.tier;
                const success = await memoryManager.demoteEntry(item.entry.id);
                if (success) {
                    memoryViewProvider?.refresh();
                    vscode.window.showInformationMessage(`Demoted from Tier ${oldTier} to Tier ${oldTier + 1}`);
                } else {
                    vscode.window.showWarningMessage('Failed to demote entry');
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to demote: ${toErrorMessage(err)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.deleteMemoryEntry', async (item: MemoryTreeItem) => {
            if (!memoryManager || !item.entry) return;
            const confirm = await vscode.window.showWarningMessage(
                `Delete memory entry: "${item.entry.content.substring(0, 50)}..."?`,
                'Delete', 'Cancel'
            );
            if (confirm === 'Delete') {
                try {
                    await memoryManager.deleteEntry(item.entry.id);
                    memoryViewProvider?.refresh();
                    vscode.window.showInformationMessage('Memory entry deleted');
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to delete: ${toErrorMessage(err)}`);
                }
            }
        })
    );

    // Helper function for importing memory data
    async function importMemoryData(data: any): Promise<number> {
        if (!data.entries || !Array.isArray(data.entries)) {
            throw new Error('Invalid export format: missing entries array');
        }
        
        let imported = 0;
        for (const entry of data.entries) {
            // Validate entry structure
            if (typeof entry.tier !== 'number' || entry.tier < 0 || entry.tier > 5) {
                logError(`[memory] Skipping entry with invalid tier: ${entry.tier}`);
                continue;
            }
            if (!entry.content || typeof entry.content !== 'string') {
                logError(`[memory] Skipping entry with invalid content`);
                continue;
            }
            
            await memoryManager!.addEntry(entry.tier, entry.content, entry.tags);
            imported++;
        }
        return imported;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.exportMemory', async () => {
            if (!memoryManager) {
                vscode.window.showWarningMessage('Memory system not initialized');
                return;
            }
            try {
                const allEntries = [];
                for (let tier = 0; tier <= 5; tier++) {
                    const entries = await memoryManager.listByTier(tier);
                    allEntries.push(...entries);
                }
                const exportData = {
                    version: '1.0',
                    exportedAt: new Date().toISOString(),
                    workspace: vscode.workspace.name || 'unknown',
                    entries: allEntries
                };
                const uri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(`memory-export-${Date.now()}.json`),
                    filters: { 'JSON': ['json'] }
                });
                if (uri) {
                    await fs.promises.writeFile(uri.fsPath, JSON.stringify(exportData, null, 2));
                    vscode.window.showInformationMessage(`Exported ${allEntries.length} entries`);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Export failed: ${toErrorMessage(err)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.importMemory', async () => {
            if (!memoryManager) {
                vscode.window.showWarningMessage('Memory system not initialized');
                return;
            }
            try {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'JSON': ['json'] }
                });
                if (!uris || uris.length === 0) return;
                
                const content = await fs.promises.readFile(uris[0].fsPath, 'utf8');
                const data = JSON.parse(content);
                
                const imported = await importMemoryData(data);
                
                memoryViewProvider?.refresh();
                vscode.window.showInformationMessage(`Imported ${imported} entries`);
            } catch (err) {
                vscode.window.showErrorMessage(`Import failed: ${toErrorMessage(err)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.showMemoryStats', async () => {
            if (!memoryManager) {
                vscode.window.showWarningMessage('Memory system not initialized');
                return;
            }
            
            const panel = vscode.window.createWebviewPanel(
                'memoryStats',
                'Memory Manager',
                vscode.ViewColumn.One,
                { enableScripts: true }
            );
            
            // Don't push to context.subscriptions — panel auto-disposes on close
            
            const htmlPath = path.join(context.extensionPath, 'webview', 'memoryPanel.html');
            const html = await fs.promises.readFile(htmlPath, 'utf8');

            async function sendFullData() {
                const stats = memoryManager!.getStats();
                const entriesByTier: Record<number, any[]> = {};
                for (let tier = 0; tier <= 5; tier++) {
                    entriesByTier[tier] = await memoryManager!.listByTier(tier);
                }
                panel.webview.postMessage({ type: 'fullData', stats, entries: entriesByTier });
            }
            
            panel.webview.onDidReceiveMessage(async message => {
                switch (message.command) {
                    case 'ready':
                    case 'refresh':
                        await sendFullData();
                        break;
                    case 'promote': {
                        const ok = await memoryManager!.promoteEntry(message.id);
                        if (ok) { memoryViewProvider?.refresh(); }
                        await sendFullData();
                        break;
                    }
                    case 'demote': {
                        const ok = await memoryManager!.demoteEntry(message.id);
                        if (ok) { memoryViewProvider?.refresh(); }
                        await sendFullData();
                        break;
                    }
                    case 'deleteEntry': {
                        await memoryManager!.deleteEntry(message.id);
                        memoryViewProvider?.refresh();
                        await sendFullData();
                        break;
                    }
                    case 'clearAll': {
                        const confirmClear = await vscode.window.showWarningMessage(
                            'Clear ALL memory entries? This cannot be undone.',
                            'Clear All', 'Cancel'
                        );
                        if (confirmClear !== 'Clear All') { break; }
                        if (memoryManager) {
                            await memoryManager.clearAll();
                        }
                        memoryViewProvider?.refresh();
                        await sendFullData();
                        vscode.window.showInformationMessage('All memory cleared.');
                        logInfo('[memory] All memory entries cleared from panel');
                        break;
                    }
                    case 'export':
                        vscode.commands.executeCommand('ollamaAgent.exportMemory');
                        break;
                    case 'scanDocs': {
                        await scanProjectDocs(memoryManager!);
                        memoryViewProvider?.refresh();
                        await sendFullData();
                        break;
                    }
                    case 'import': {
                        try {
                            const imported = await importMemoryData(message.data);
                            memoryViewProvider?.refresh();
                            vscode.window.showInformationMessage(`Imported ${imported} entries`);
                            await sendFullData();
                        } catch (err) {
                            vscode.window.showErrorMessage(`Import failed: ${toErrorMessage(err)}`);
                        }
                        break;
                    }
                }
            });
            
            panel.webview.html = html;
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.manageTemplates', async () => {
            const templateManager = provider.getTemplateManager();
            await showManageTemplatesUI(templateManager);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.triggerInlineCompletion', async () => {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.exportChatMarkdown', async () => {
            const messages = provider.getCurrentChatMessages();
            const title = provider.getCurrentChatTitle();
            await ChatExporter.exportToMarkdown(messages, title);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.exportChatJSON', async () => {
            const messages = provider.getCurrentChatMessages();
            const title = provider.getCurrentChatTitle();
            await ChatExporter.exportToJSON(messages, title);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.reviewChanges', async () => {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!root) {
                vscode.window.showWarningMessage('No workspace folder open.');
                return;
            }

            const review = await buildReviewRequest(root);
            if (!review) {
                vscode.window.showInformationMessage('No uncommitted changes to review.');
                return;
            }

            await vscode.commands.executeCommand('ollamaAgent.chatView.focus');
            provider.sendMessageFromCommand(review.prompt, false, false);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.reviewCommit', async () => {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!root) {
                vscode.window.showWarningMessage('No workspace folder open.');
                return;
            }

            const range = await vscode.window.showInputBox({
                prompt: 'Enter commit range (e.g. HEAD~1, main..feature, abc123)',
                placeHolder: 'HEAD~1'
            });
            if (!range) { return; }

            const review = await buildCommitReviewRequest(root, range);
            if (!review) {
                vscode.window.showWarningMessage('No changes found for that commit range.');
                return;
            }

            await vscode.commands.executeCommand('ollamaAgent.chatView.focus');
            provider.sendMessageFromCommand(review.prompt, false, false);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.switchWorkspace', async () => {
            const switched = await workspaceManager.showWorkspacePicker();
            if (switched) {
                vscode.window.showInformationMessage('Workspace switched. Start a new chat to use the new workspace.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ollamaAgent.scanProjectDocs', async () => {
            if (!memoryManager) {
                vscode.window.showWarningMessage('Memory system not initialized.');
                return;
            }
            await scanProjectDocs(memoryManager);
            memoryViewProvider?.refresh();
        })
    );

    // Listen for config changes to clear context limit cache
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ollamaAgent')) {
                const { clearContextLimitCache } = require('./contextCalculator');
                clearContextLimitCache();
                logInfo('[config] Configuration changed, context limit cache cleared');
            }
        })
    );

    // ── Pre-warm model ───────────────────────────────────────────────────────
    // After a short delay, load the configured model into GPU memory so the
    // first real chat request responds without a cold-start penalty.
    setTimeout(() => {
        const cfg = getConfig();
        if (cfg.model) {
            logInfo(`[keep-alive] Pre-warming model: ${cfg.model}`);
            keepAliveModel(cfg.model);
        }
    }, 8_000); // 8s delay — let VS Code finish loading first

    logInfo('Activated — view: ollamaAgent.chatView');
}

export async function deactivate(): Promise<void> {
    logInfo('Deactivating...');
    (global as any).__ollamapilotCodeIndexer = undefined;
    await stopAllMCPServers();
    logInfo('Deactivated');
}
