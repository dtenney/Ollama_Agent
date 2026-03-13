import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { logInfo } from './logger';

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}

export interface DiffResult {
    accepted: boolean;
    hunks?: number[]; // Indices of accepted hunks (for partial accept)
}

export class DiffViewManager {
    private disposables: vscode.Disposable[] = [];
    private currentDiffUri?: vscode.Uri;

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        if (this.currentDiffUri) {
            try { fs.unlinkSync(this.currentDiffUri.fsPath); } catch { /* ignore */ }
        }
    }

    /**
     * Show enhanced diff view with accept/reject options
     */
    async showDiff(
        filePath: string,
        oldContent: string,
        newContent: string
    ): Promise<DiffResult> {
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath);
        
        // Create temp file for new content
        const tmpPath = path.join(os.tmpdir(), `ollama-edit-${Date.now()}${ext}`);
        fs.writeFileSync(tmpPath, newContent, 'utf8');
        this.currentDiffUri = vscode.Uri.file(tmpPath);

        try {
            // Open diff view
            await vscode.commands.executeCommand(
                'vscode.diff',
                vscode.Uri.file(filePath),
                this.currentDiffUri,
                `Ollama Agent — Edit: ${fileName}`,
                { preview: false, preserveFocus: false }
            );

            logInfo(`[diffView] Opened diff for ${fileName}`);

            // Show quick pick with options
            const options: vscode.QuickPickItem[] = [
                {
                    label: '$(check) Accept All Changes',
                    description: 'Apply all changes to the file',
                    detail: 'Keyboard: Alt+A'
                },
                {
                    label: '$(x) Reject All Changes',
                    description: 'Discard all changes',
                    detail: 'Keyboard: Alt+R'
                },
                {
                    label: '$(diff) Keep Diff Open',
                    description: 'Review changes manually and decide later'
                }
            ];

            const selected = await vscode.window.showQuickPick(options, {
                placeHolder: 'Review the diff and choose an action',
                title: `Edit: ${fileName}`
            });

            if (!selected) {
                // User dismissed - keep diff open
                return { accepted: false };
            }

            if (selected.label.includes('Accept')) {
                return { accepted: true };
            } else if (selected.label.includes('Reject')) {
                // Close diff editor
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                return { accepted: false };
            } else {
                // Keep diff open
                return { accepted: false };
            }
        } finally {
            // Cleanup temp file
            try {
                fs.unlinkSync(tmpPath);
            } catch { /* ignore */ }
            this.currentDiffUri = undefined;
        }
    }

    /**
     * Parse unified diff format into hunks
     */
    private parseHunks(oldContent: string, newContent: string): DiffHunk[] {
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        const hunks: DiffHunk[] = [];

        let i = 0, j = 0;
        while (i < oldLines.length || j < newLines.length) {
            // Find next difference
            while (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
                i++;
                j++;
            }

            if (i >= oldLines.length && j >= newLines.length) break;

            // Found a difference - create hunk
            const hunkStart = i;
            const hunkNewStart = j;
            const hunkLines: string[] = [];

            // Collect changed lines
            while (i < oldLines.length || j < newLines.length) {
                if (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
                    hunkLines.push(`-${oldLines[i]}`);
                    i++;
                } else if (j < newLines.length) {
                    hunkLines.push(`+${newLines[j]}`);
                    j++;
                }

                // Check if we've reached matching lines again
                if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
                    break;
                }
            }

            hunks.push({
                oldStart: hunkStart,
                oldLines: i - hunkStart,
                newStart: hunkNewStart,
                newLines: j - hunkNewStart,
                lines: hunkLines
            });
        }

        return hunks;
    }
}
