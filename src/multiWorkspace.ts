import * as vscode from 'vscode';
import { logInfo, logError } from './logger';

export class MultiWorkspaceManager {
    private folders: Map<string, vscode.WorkspaceFolder> = new Map();
    private activeWorkspaceUri?: string;

    constructor(
        private readonly context: vscode.ExtensionContext,
        _memoryManager?: any
    ) {}

    async initialize(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return; }

        logInfo(`[workspace] Initializing ${folders.length} workspace folder(s)`);
        for (const folder of folders) {
            await this.addWorkspace(folder);
        }
        if (folders.length > 0) {
            this.activeWorkspaceUri = folders[0].uri.toString();
        }
    }

    async addWorkspace(folder: vscode.WorkspaceFolder): Promise<void> {
        const uri = folder.uri.toString();
        if (this.folders.has(uri)) { return; }
        logInfo(`[workspace] Adding workspace: ${folder.name}`);
        this.folders.set(uri, folder);
    }

    removeWorkspace(folder: vscode.WorkspaceFolder): void {
        const uri = folder.uri.toString();
        if (!this.folders.has(uri)) { return; }
        logInfo(`[workspace] Removing workspace: ${folder.name}`);
        this.folders.delete(uri);
        if (this.activeWorkspaceUri === uri) {
            const remaining = Array.from(this.folders.keys());
            this.activeWorkspaceUri = remaining.length > 0 ? remaining[0] : undefined;
        }
    }

    getActiveFolder(): vscode.WorkspaceFolder | undefined {
        if (!this.activeWorkspaceUri) { return undefined; }
        return this.folders.get(this.activeWorkspaceUri);
    }

    setActiveWorkspace(folder: vscode.WorkspaceFolder): void {
        const uri = folder.uri.toString();
        if (!this.folders.has(uri)) {
            logError(`[workspace] Cannot set active workspace: ${folder.name} not found`);
            return;
        }
        this.activeWorkspaceUri = uri;
        logInfo(`[workspace] Active workspace: ${folder.name}`);
    }

    getWorkspaceForFile(fileUri: vscode.Uri): vscode.WorkspaceFolder | undefined {
        return vscode.workspace.getWorkspaceFolder(fileUri);
    }

    getWorkspaceCount(): number { return this.folders.size; }

    isMultiWorkspace(): boolean { return this.folders.size > 1; }

    async showWorkspacePicker(): Promise<boolean> {
        if (!this.isMultiWorkspace()) {
            vscode.window.showInformationMessage('Only one workspace folder is open');
            return false;
        }

        const items = Array.from(this.folders.values()).map(f => ({
            label: `$(folder) ${f.name}`,
            description: f.uri.fsPath,
            folder: f
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select workspace folder for AI assistant'
        });

        if (selected) {
            this.setActiveWorkspace(selected.folder);
            return true;
        }
        return false;
    }

    dispose(): void {
        this.folders.clear();
        this.activeWorkspaceUri = undefined;
    }
}
