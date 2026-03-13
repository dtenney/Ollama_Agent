import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logError } from './logger';

export interface FileChange {
    path: string;
    oldContent: string;
    newContent: string;
    description?: string;
}

export interface RefactoringPlan {
    title: string;
    description: string;
    changes: FileChange[];
}

export class MultiFileRefactoringManager {
    private currentPlan?: RefactoringPlan;

    /**
     * Show a preview of multi-file changes and get user approval
     */
    async showRefactoringPlan(plan: RefactoringPlan): Promise<boolean> {
        this.currentPlan = plan;

        logInfo(`[refactor] Showing plan: ${plan.title} (${plan.changes.length} files)`);

        // Create webview panel for preview
        const panel = vscode.window.createWebviewPanel(
            'refactoringPlan',
            `Refactoring: ${plan.title}`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = this.getWebviewContent(plan);

        return new Promise<boolean>((resolve) => {
            let resolved = false;

            panel.webview.onDidReceiveMessage(async (message) => {
                if (resolved) return;

                switch (message.command) {
                    case 'accept':
                        resolved = true;
                        panel.dispose();
                        resolve(true);
                        break;
                    case 'reject':
                        resolved = true;
                        panel.dispose();
                        resolve(false);
                        break;
                    case 'viewDiff':
                        await this.showFileDiff(plan.changes[message.index]);
                        break;
                }
            });

            panel.onDidDispose(() => {
                if (!resolved) {
                    resolved = true;
                    resolve(false);
                }
            });
        });
    }

    /**
     * Apply all changes in the refactoring plan
     */
    async applyRefactoring(plan: RefactoringPlan, workspaceRoot: string): Promise<{ success: number; failed: number }> {
        let success = 0;
        let failed = 0;

        for (const change of plan.changes) {
            try {
                const fullPath = path.resolve(workspaceRoot, change.path);
                
                // Verify old content matches (safety check)
                const currentContent = fs.readFileSync(fullPath, 'utf8');
                if (currentContent !== change.oldContent) {
                    logError(`[refactor] Content mismatch for ${change.path} - file may have been modified`);
                    failed++;
                    continue;
                }

                // Write new content
                fs.writeFileSync(fullPath, change.newContent, 'utf8');
                logInfo(`[refactor] Applied changes to ${change.path}`);
                success++;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logError(`[refactor] Failed to apply changes to ${change.path}: ${msg}`);
                failed++;
            }
        }

        return { success, failed };
    }

    /**
     * Show diff for a single file change
     */
    private async showFileDiff(change: FileChange): Promise<void> {
        try {
            const originalUri = vscode.Uri.file(change.path);
            
            // Create temp file with new content
            const tmpPath = path.join(
                require('os').tmpdir(),
                `ollama-refactor-${Date.now()}-${path.basename(change.path)}`
            );
            fs.writeFileSync(tmpPath, change.newContent, 'utf8');
            const modifiedUri = vscode.Uri.file(tmpPath);

            await vscode.commands.executeCommand(
                'vscode.diff',
                originalUri,
                modifiedUri,
                `${path.basename(change.path)} (Proposed Changes)`
            );

            // Clean up temp file after a delay
            setTimeout(() => {
                try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            }, 60000); // 1 minute
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logError(`[refactor] Failed to show diff: ${msg}`);
        }
    }

    /**
     * Generate HTML for refactoring preview webview
     */
    private getWebviewContent(plan: RefactoringPlan): string {
        const changesHtml = plan.changes.map((change, index) => {
            const fileName = path.basename(change.path);
            const oldLines = change.oldContent.split('\n').length;
            const newLines = change.newContent.split('\n').length;
            const delta = newLines - oldLines;
            const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '±0';

            return `
                <div class="file-change">
                    <div class="file-header">
                        <span class="file-name">${change.path}</span>
                        <span class="file-stats">${oldLines} → ${newLines} lines (${deltaStr})</span>
                    </div>
                    ${change.description ? `<div class="file-description">${change.description}</div>` : ''}
                    <button class="view-diff-btn" onclick="viewDiff(${index})">View Diff</button>
                </div>
            `;
        }).join('');

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 20px;
            margin: 0;
        }
        h1 {
            color: var(--vscode-foreground);
            margin-top: 0;
        }
        .description {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 20px;
            line-height: 1.5;
        }
        .file-change {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 12px;
        }
        .file-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .file-name {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }
        .file-stats {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }
        .file-description {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
            margin-bottom: 8px;
        }
        .view-diff-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 6px 12px;
            border-radius: 2px;
            cursor: pointer;
            font-size: 0.9em;
        }
        .view-diff-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .actions {
            display: flex;
            gap: 12px;
            margin-top: 24px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
        }
        .btn-accept {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-accept:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-reject {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-reject:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .summary {
            background: var(--vscode-textBlockQuote-background);
            border-left: 4px solid var(--vscode-textLink-foreground);
            padding: 12px;
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <h1>${plan.title}</h1>
    <div class="description">${plan.description}</div>
    
    <div class="summary">
        <strong>Summary:</strong> ${plan.changes.length} file(s) will be modified
    </div>

    <div class="changes">
        ${changesHtml}
    </div>

    <div class="actions">
        <button class="btn btn-accept" onclick="accept()">✓ Apply All Changes</button>
        <button class="btn btn-reject" onclick="reject()">✗ Cancel</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function accept() {
            vscode.postMessage({ command: 'accept' });
        }

        function reject() {
            vscode.postMessage({ command: 'reject' });
        }

        function viewDiff(index) {
            vscode.postMessage({ command: 'viewDiff', index });
        }
    </script>
</body>
</html>`;
    }
}
