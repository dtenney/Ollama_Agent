import * as vscode from 'vscode';
import { streamChatRequest } from './ollamaClient';
import { getConfig } from './config';
import { logInfo, logError } from './logger';

export class OllamaInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private lastTriggerTime = 0;
    private readonly DEBOUNCE_MS = 500;
    private abortController?: AbortController;

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
        // Skip if triggered too frequently
        const now = Date.now();
        if (now - this.lastTriggerTime < this.DEBOUNCE_MS) {
            return null;
        }
        this.lastTriggerTime = now;

        // Skip if user is actively typing (only trigger on pause)
        if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
            // Wait a bit to see if user continues typing
            await new Promise(resolve => setTimeout(resolve, 300));
            if (token.isCancellationRequested) {
                return null;
            }
        }

        const cfg = getConfig();
        const model = cfg.model;

        // Get context: current line + previous lines
        const currentLine = document.lineAt(position.line).text;
        const cursorPos = position.character;
        const prefix = currentLine.substring(0, cursorPos);
        
        // Skip if line is empty or just whitespace
        if (!prefix.trim()) {
            return null;
        }

        // Get surrounding context (up to 50 lines before)
        const startLine = Math.max(0, position.line - 50);
        const contextRange = new vscode.Range(startLine, 0, position.line, cursorPos);
        const contextText = document.getText(contextRange);

        // Build prompt
        const language = document.languageId;
        const prompt = this.buildPrompt(language, contextText, prefix);

        logInfo(`[inline] Generating completion for ${language} at line ${position.line}`);

        try {
            // Cancel any previous request
            if (this.abortController) {
                this.abortController.abort();
            }
            this.abortController = new AbortController();

            const stopRef = { stop: false };
            token.onCancellationRequested(() => {
                stopRef.stop = true;
                this.abortController?.abort();
            });

            let completion = '';
            const result = await streamChatRequest(
                model,
                [{ role: 'user', content: prompt }],
                [],
                (token) => { completion += token; },
                stopRef
            );

            completion = result.content.trim();

            // Clean up completion
            completion = this.cleanCompletion(completion, prefix);

            if (!completion || token.isCancellationRequested) {
                return null;
            }

            logInfo(`[inline] Generated ${completion.length} chars`);

            return [
                new vscode.InlineCompletionItem(
                    completion,
                    new vscode.Range(position, position)
                )
            ];
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logError(`[inline] Completion failed: ${msg}`);
            return null;
        }
    }

    private buildPrompt(language: string, context: string, prefix: string): string {
        return `You are a code completion assistant. Complete the following ${language} code.

Context:
\`\`\`${language}
${context}
\`\`\`

Complete this line (provide ONLY the completion, no explanations):
${prefix}`;
    }

    private cleanCompletion(completion: string, prefix: string): string {
        // Remove markdown code blocks
        completion = completion.replace(/```[\w]*\n?/g, '');
        
        // Remove any repeated prefix
        if (completion.startsWith(prefix)) {
            completion = completion.substring(prefix.length);
        }

        // Take only the first line for inline completion
        const firstLine = completion.split('\n')[0];
        
        // Remove trailing whitespace
        return firstLine.trimEnd();
    }
}
