import * as vscode from 'vscode';
import { OllamaAgentProvider, runDiagnostics } from './provider';
import { fetchModels, streamChatRequest } from './ollamaClient';
import { getConfig } from './config';
import { channel, logInfo, logError } from './logger';

export function activate(context: vscode.ExtensionContext): void {
    logInfo('Ollama Agent activating…');
    logInfo(`extensionUri: ${context.extensionUri.fsPath}`);
    channel.show(true);
    context.subscriptions.push(channel);

    // ── Sidebar provider ─────────────────────────────────────────────────────
    const provider = new OllamaAgentProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ollamaAgent.chatView', provider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

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
        vscode.commands.registerCommand('ollamaAgent.diagnose', () => runDiagnostics())
    );

    logInfo('Activated — view: ollamaAgent.chatView');
}

export function deactivate(): void {
    logInfo('Deactivated');
}
