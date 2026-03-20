import * as vscode from 'vscode';
import { streamGenerateRequest } from './ollamaClient';
import { getConfig } from './config';
import { logInfo, logError, toErrorMessage } from './logger';

export class OllamaInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private lastTriggerTime = 0;
    private activeStopRef?: { stop: boolean };

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | null> {
        const inlineCfg = vscode.workspace.getConfiguration('ollamaAgent.inlineCompletions');
        const triggerMode = inlineCfg.get<string>('triggerMode', 'automatic');
        const debounceMs = inlineCfg.get<number>('debounceMs', 500);

        // Respect manual-only mode: reject automatic triggers entirely
        if (triggerMode === 'manual' && context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
            return null;
        }

        // Debounce (applies to both automatic and manual triggers)
        const now = Date.now();
        if (now - this.lastTriggerTime < debounceMs) return null;
        this.lastTriggerTime = now;

        // On automatic triggers, wait for typing pause then re-check cancellation
        if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
            await new Promise(r => setTimeout(r, debounceMs));
            if (token.isCancellationRequested) return null;
        }

        // Skip empty/whitespace-only prefix on current line
        const lineText = document.lineAt(position.line).text;
        if (!lineText.substring(0, position.character).trim()) return null;

        // Build prefix: up to 50 lines before cursor
        const prefixStart = Math.max(0, position.line - 50);
        const prefix = document.getText(new vscode.Range(prefixStart, 0, position.line, position.character));

        // Build suffix: up to 50 lines after cursor
        const suffixEnd = Math.min(document.lineCount - 1, position.line + 50);
        const suffix = document.getText(new vscode.Range(position.line, position.character, suffixEnd, document.lineAt(suffixEnd).text.length));

        const model = getConfig().model;
        logInfo(`[FIM] model=${model} line=${position.line} prefix=${prefix.length}c suffix=${suffix.length}c`);

        try {
            // Cancel previous in-flight request
            if (this.activeStopRef) this.activeStopRef.stop = true;
            const stopRef = { stop: false };
            this.activeStopRef = stopRef;

            token.onCancellationRequested(() => { stopRef.stop = true; });

            const raw = await streamGenerateRequest(model, prefix, suffix, () => {}, stopRef);

            if (stopRef.stop || token.isCancellationRequested) return null;

            const completion = this.clean(raw, prefix);
            if (!completion) return null;

            logInfo(`[FIM] ${completion.split('\n').length} lines, ${completion.length} chars`);

            return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
        } catch (err) {
            logError(`[FIM] ${toErrorMessage(err)}`);
            return null;
        }
    }

    private clean(raw: string, prefix: string): string {
        let text = raw;

        // Strip markdown fences if model wraps output
        text = text.replace(/```[\w]*\n?/g, '');

        // Remove echoed prefix
        if (text.startsWith(prefix)) text = text.substring(prefix.length);

        // Trim trailing blank lines but keep meaningful whitespace
        text = text.replace(/\n{3,}/g, '\n\n').trimEnd();

        return text;
    }
}
