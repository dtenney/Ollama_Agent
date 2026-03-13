import * as vscode from 'vscode';
import { logInfo } from './logger';

/**
 * Provides code actions (right-click menu items) for selected code.
 * Offers AI-powered actions like "Explain", "Add comments", "Refactor", etc.
 */
export class OllamaCodeActionsProvider implements vscode.CodeActionProvider {
    
    /**
     * Provide code actions for the given document and range.
     * Only shows actions when text is selected.
     */
    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        
        // Get selected text
        const selection = document.getText(range);
        if (!selection || selection.trim().length === 0) {
            return actions; // No selection, no actions
        }
        
        const language = document.languageId;
        const filename = vscode.workspace.asRelativePath(document.uri);
        
        logInfo(`[codeActions] Providing actions for ${selection.length} chars in ${filename}`);
        
        // Add code actions for selected text
        actions.push(
            this.createAction(
                'Explain this code',
                'explain',
                selection,
                language,
                filename,
                'Get a detailed explanation of what this code does'
            ),
            this.createAction(
                'Add comments',
                'comment',
                selection,
                language,
                filename,
                'Add inline comments explaining the code'
            ),
            this.createAction(
                'Refactor this',
                'refactor',
                selection,
                language,
                filename,
                'Suggest improvements and refactoring opportunities'
            ),
            this.createAction(
                'Find potential bugs',
                'bugs',
                selection,
                language,
                filename,
                'Analyze code for potential bugs and issues'
            ),
            this.createAction(
                'Generate tests',
                'tests',
                selection,
                language,
                filename,
                'Generate unit tests for this code'
            ),
            this.createAction(
                'Add documentation',
                'docs',
                selection,
                language,
                filename,
                'Add JSDoc/docstring documentation'
            )
        );
        
        // Handle diagnostics (errors/warnings) if present
        if (context.diagnostics && context.diagnostics.length > 0) {
            for (const diagnostic of context.diagnostics) {
                actions.push(this.createErrorAction(diagnostic, document, range));
            }
        }
        
        return actions;
    }
    
    /**
     * Create a code action for a specific type of AI assistance.
     */
    private createAction(
        title: string,
        type: string,
        selection: string,
        language: string,
        filename: string,
        tooltip: string
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(
            `🤖 ${title}`,
            vscode.CodeActionKind.RefactorRewrite
        );
        
        action.command = {
            command: 'ollamaAgent.codeAction',
            title,
            arguments: [{ type, selection, language, filename }],
            tooltip
        };
        
        return action;
    }
    
    /**
     * Create a code action for explaining an error/warning.
     */
    private createErrorAction(
        diagnostic: vscode.Diagnostic,
        document: vscode.TextDocument,
        range: vscode.Range
    ): vscode.CodeAction {
        const action = new vscode.CodeAction(
            '🤖 Ask OllamaPilot about this error',
            vscode.CodeActionKind.QuickFix
        );
        
        // Extract surrounding code (5 lines before and after)
        const startLine = Math.max(0, diagnostic.range.start.line - 5);
        const endLine = Math.min(document.lineCount - 1, diagnostic.range.end.line + 5);
        const surroundingRange = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
        const surroundingCode = document.getText(surroundingRange);
        
        action.command = {
            command: 'ollamaAgent.explainError',
            title: 'Explain Error',
            arguments: [{
                error: diagnostic.message,
                code: surroundingCode,
                language: document.languageId,
                filename: vscode.workspace.asRelativePath(document.uri),
                line: diagnostic.range.start.line + 1,
                severity: vscode.DiagnosticSeverity[diagnostic.severity]
            }]
        };
        
        action.diagnostics = [diagnostic];
        action.isPreferred = true; // Show this action first
        
        return action;
    }
}
