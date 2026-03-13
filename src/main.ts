import * as vscode from 'vscode';
import { OllamaAgentProvider, runDiagnostics } from './provider';
import { fetchModels, streamChatRequest } from './ollamaClient';
import { getConfig } from './config';
import { channel, logInfo, logError } from './logger';
import { startMCPServer, stopAllMCPServers } from './mcpClient';
import { loadMCPConfig, createExampleMCPConfig } from './mcpConfig';
import { TieredMemoryManager } from './memoryCore';
import { getMemoryConfig } from './memoryConfig';
import { QdrantClient } from './qdrantClient';
import { EmbeddingService } from './embeddingService';
import { MemoryViewProvider, MemoryTreeItem } from './memoryViewProvider';
import { OllamaCodeActionsProvider } from './codeActionsProvider';
import { OllamaInlineCompletionProvider } from './inlineCompletionProvider';
import { showManageTemplatesUI } from './promptTemplates';
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
                    logError(`MCP server ${cfg.name} failed to start: ${err.message}`);
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
                logError(`Unexpected error starting MCP servers: ${err.message}`);
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
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logError(`[memory] Qdrant unavailable, using local storage only: ${errorMsg}`);
                    qdrantClient = undefined;
                    embeddingService = undefined;
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
            
            // Run initial maintenance on startup
            setTimeout(async () => {
                if (memoryManager) {
                    logInfo('[memory] Running initial maintenance...');
                    await memoryManager.demoteStaleEntries();
                    await memoryManager.promoteFrequentEntries();
                    await memoryManager.archiveOldEntries();
                }
            }, 5000); // 5 seconds after startup
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logError(`[memory] Failed to initialize: ${errorMsg}`);
            memoryManager = null;
        }
    } else {
        logInfo('[memory] Multi-tiered memory disabled in settings');
    }

    // ── Sidebar provider ─────────────────────────────────────────────────────
    const provider = new OllamaAgentProvider(context, memoryManager);
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
                vscode.window.showErrorMessage(`Ollama error: ${(err as Error).message}`);
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
                case 'tests':
                    prompt = `Generate unit tests for this ${args.language} code:\n\n\`\`\`${args.language}\n${args.selection}\n\`\`\``;
                    break;
                case 'docs':
                    prompt = `Add ${args.language === 'python' ? 'docstring' : 'JSDoc'} documentation to this code:\n\n\`\`\`${args.language}\n${args.selection}\n\`\`\``;
                    break;
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
                vscode.window.showErrorMessage(`Failed to promote: ${err instanceof Error ? err.message : String(err)}`);
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
                vscode.window.showErrorMessage(`Failed to demote: ${err instanceof Error ? err.message : String(err)}`);
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
                    vscode.window.showErrorMessage(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
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
                vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
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
                vscode.window.showErrorMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
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
                'Memory Statistics',
                vscode.ViewColumn.One,
                { enableScripts: true }
            );
            
            // Add to subscriptions for proper disposal
            context.subscriptions.push(panel);
            
            const htmlPath = path.join(context.extensionPath, 'webview', 'memoryPanel.html');
            const html = await fs.promises.readFile(htmlPath, 'utf8');
            
            panel.webview.onDidReceiveMessage(async message => {
                if (message.command === 'ready') {
                    const stats = memoryManager!.getStats();
                    const tierCounts = stats.map(s => s.count);
                    const totalEntries = tierCounts.reduce((a, b) => a + b, 0);
                    const totalAccesses = stats.reduce((sum, s) => sum + s.totalAccesses, 0);
                    
                    panel.webview.postMessage({
                        type: 'stats',
                        stats: { tierCounts, totalEntries, totalAccesses }
                    });
                } else if (message.command === 'export') {
                    vscode.commands.executeCommand('ollamaAgent.exportMemory');
                } else if (message.command === 'import') {
                    try {
                        const imported = await importMemoryData(message.data);
                        memoryViewProvider?.refresh();
                        vscode.window.showInformationMessage(`Imported ${imported} entries`);
                    } catch (err) {
                        vscode.window.showErrorMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
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

    logInfo('Activated — view: ollamaAgent.chatView');
}

export async function deactivate(): Promise<void> {
    logInfo('Deactivating...');
    await stopAllMCPServers();
    logInfo('Deactivated');
}
