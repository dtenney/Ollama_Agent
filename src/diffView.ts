import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { logInfo } from './logger';

export class DiffViewManager {
    private currentTmpPath?: string;

    dispose(): void {
        this.cleanup();
    }

    /**
     * Open a diff view so the user can review the proposed changes.
     * Accept/reject is handled separately via the chat confirmation UI.
     */
    async showDiffPreview(
        filePath: string,
        oldContent: string,
        newContent: string
    ): Promise<void> {
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath);

        // Create temp file for new content
        const tmpPath = path.join(os.tmpdir(), `ollama-edit-${Date.now()}${ext}`);
        fs.writeFileSync(tmpPath, newContent, 'utf8');
        this.currentTmpPath = tmpPath;

        await vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.file(filePath),
            vscode.Uri.file(tmpPath),
            `Ollama Agent — Edit: ${fileName}`,
            { preview: false, preserveFocus: false }
        );

        logInfo(`[diffView] Opened diff for ${fileName}`);
    }

    /** Close the diff editor and clean up the temp file. */
    async closeDiffPreview(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        } catch { /* ignore */ }
        this.cleanup();
    }

    private cleanup(): void {
        if (this.currentTmpPath) {
            try { fs.unlinkSync(this.currentTmpPath); } catch { /* ignore */ }
            this.currentTmpPath = undefined;
        }
    }
}
