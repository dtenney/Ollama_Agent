import * as vscode from 'vscode';

export interface WorkspaceContext {
    /** Workspace-relative path to the active file, or null. */
    file: string | null;
    /** Number of lines in the active file. */
    fileLines: number;
    /** Language ID of the active file (e.g. "typescript"). */
    language: string;
    /** Number of lines currently selected, or 0 if no selection. */
    selectionLines: number;
}

/** Snapshot of the active editor state, safe to send to the webview. */
export function getActiveContext(): WorkspaceContext {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return { file: null, fileLines: 0, language: '', selectionLines: 0 };
    }
    const doc = editor.document;
    const file = vscode.workspace.asRelativePath(doc.uri, false);
    const fileLines = doc.lineCount;
    const language = doc.languageId;
    const sel = editor.selection;
    const selectionLines = sel.isEmpty ? 0 : sel.end.line - sel.start.line + 1;
    return { file, fileLines, language, selectionLines };
}

/**
 * Build a context block to prepend to a user message before sending to the model.
 * Only includes what the user explicitly opted in to via the UI flags.
 */
export function buildContextString(
    includeFile: boolean,
    includeSelection: boolean
): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return ''; }

    const doc = editor.document;
    const relPath = vscode.workspace.asRelativePath(doc.uri, false);
    const lang = doc.languageId;
    const parts: string[] = [];

    if (includeFile) {
        const content = doc.getText();
        parts.push(
            `<active-file path="${relPath}" lang="${lang}">\n\`\`\`${lang}\n${content}\n\`\`\`\n</active-file>`
        );
    } else if (includeSelection) {
        const sel = editor.selection;
        if (!sel.isEmpty) {
            const text = doc.getText(sel);
            const start = sel.start.line + 1;
            const end   = sel.end.line + 1;
            parts.push(
                `<selection file="${relPath}" lines="${start}-${end}" lang="${lang}">\n\`\`\`${lang}\n${text}\n\`\`\`\n</selection>`
            );
        }
    }

    return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}
