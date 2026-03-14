import * as vscode from 'vscode';

const FUNCTION_PATTERNS: Record<string, RegExp[]> = {
    typescript:  [/^\s*(export\s+)?(async\s+)?function\s+\w+/,  /^\s*(public|private|protected|static|async)\s+\w+\s*\(/, /^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/],
    javascript:  [/^\s*(export\s+)?(async\s+)?function\s+\w+/,  /^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/],
    python:      [/^\s*(async\s+)?def\s+\w+/,                   /^\s*class\s+\w+/],
    java:        [/^\s*(public|private|protected|static)\s+[\w<>\[\]]+\s+\w+\s*\(/],
    go:          [/^\s*func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/],
    rust:        [/^\s*(pub\s+)?(async\s+)?fn\s+\w+/,           /^\s*(pub\s+)?struct\s+\w+/],
    csharp:      [/^\s*(public|private|protected|internal|static)\s+[\w<>\[\]]+\s+\w+\s*\(/],
    ruby:        [/^\s*def\s+\w+/,                              /^\s*class\s+\w+/],
    php:         [/^\s*(public|private|protected|static)?\s*function\s+\w+/],
    kotlin:      [/^\s*(fun|class|object)\s+\w+/],
    c:           [/^\s*[\w*]+\s+\w+\s*\([^)]*\)\s*\{/],
    cpp:         [/^\s*[\w*:]+\s+\w+\s*\([^)]*\)\s*\{/],
};

// Map common languageIds to our pattern keys
function getPatternKey(languageId: string): string | undefined {
    const aliases: Record<string, string> = {
        typescriptreact: 'typescript', javascriptreact: 'javascript',
    };
    return aliases[languageId] || (FUNCTION_PATTERNS[languageId] ? languageId : undefined);
}

export class OllamaCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChange.event;

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const key = getPatternKey(document.languageId);
        if (!key) { return []; }

        const patterns = FUNCTION_PATTERNS[key];
        const lenses: vscode.CodeLens[] = [];

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
            if (patterns.some(p => p.test(line))) {
                // Find the end of the function/block (simple heuristic: next function or end of file)
                let endLine = i;
                for (let j = i + 1; j < Math.min(i + 200, document.lineCount); j++) {
                    if (patterns.some(p => p.test(document.lineAt(j).text))) { break; }
                    endLine = j;
                }
                const range = new vscode.Range(i, 0, endLine, document.lineAt(endLine).text.length);
                const selection = document.getText(range);

                lenses.push(new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
                    title: '✨ Explain',
                    command: 'ollamaAgent.codeAction',
                    arguments: [{
                        type: 'explain',
                        selection,
                        language: document.languageId,
                        filename: vscode.workspace.asRelativePath(document.uri),
                    }],
                }));

                lenses.push(new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
                    title: '📝 Document',
                    command: 'ollamaAgent.codeAction',
                    arguments: [{
                        type: 'docs',
                        selection,
                        language: document.languageId,
                        filename: vscode.workspace.asRelativePath(document.uri),
                    }],
                }));
            }
        }

        return lenses;
    }
}
