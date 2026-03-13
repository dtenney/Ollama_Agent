import * as vscode from 'vscode';
import { Agent } from './agent';
import { ProjectMemory } from './projectMemory';
import { TieredMemoryManager } from './memoryCore';
import { logInfo, logError } from './logger';

export interface WorkspaceContext {
    folder: vscode.WorkspaceFolder;
    agent: Agent;
    memory: ProjectMemory | TieredMemoryManager;
}

export class MultiWorkspaceManager {
    private workspaces: Map<string, WorkspaceContext> = new Map();
    private activeWorkspaceUri?: string;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly memoryManager?: TieredMemoryManager | null
    ) {}

    /**
     * Initialize all workspace folders
     */
    async initialize(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return;
        }

        logInfo(`[workspace] Initializing ${folders.length} workspace folder(s)`);

        for (const folder of folders) {
            await this.addWorkspace(folder);
        }

        // Set first folder as active
        if (folders.length > 0) {
            this.activeWorkspaceUri = folders[0].uri.toString();
        }
    }

    /**
     * Add a workspace folder
     */
    async addWorkspace(folder: vscode.WorkspaceFolder): Promise<void> {
        const uri = folder.uri.toString();
        
        if (this.workspaces.has(uri)) {
            return; // Already exists
        }

        logInfo(`[workspace] Adding workspace: ${folder.name}`);

        // Create memory instance for this workspace
        const memory = this.memoryManager ?? new ProjectMemory(this.context);

        // Create agent for this workspace
        const agent = new Agent(folder.uri.fsPath, memory);

        this.workspaces.set(uri, {
            folder,
            agent,
            memory
        });
    }

    /**
     * Remove a workspace folder
     */
    removeWorkspace(folder: vscode.WorkspaceFolder): void {
        const uri = folder.uri.toString();
        
        if (!this.workspaces.has(uri)) {
            return;
        }

        logInfo(`[workspace] Removing workspace: ${folder.name}`);
        
        // Clean up
        const ctx = this.workspaces.get(uri)!;
        // Agent cleanup happens automatically via garbage collection
        
        this.workspaces.delete(uri);

        // If this was the active workspace, switch to another
        if (this.activeWorkspaceUri === uri) {
            const remaining = Array.from(this.workspaces.keys());
            this.activeWorkspaceUri = remaining.length > 0 ? remaining[0] : undefined;
        }
    }

    /**
     * Get the active workspace context
     */
    getActiveWorkspace(): WorkspaceContext | undefined {
        if (!this.activeWorkspaceUri) {
            return undefined;
        }
        return this.workspaces.get(this.activeWorkspaceUri);
    }

    /**
     * Set the active workspace
     */
    setActiveWorkspace(folder: vscode.WorkspaceFolder): void {
        const uri = folder.uri.toString();
        
        if (!this.workspaces.has(uri)) {
            logError(`[workspace] Cannot set active workspace: ${folder.name} not found`);
            return;
        }

        this.activeWorkspaceUri = uri;
        logInfo(`[workspace] Active workspace: ${folder.name}`);
    }

    /**
     * Get workspace context for a specific file
     */
    getWorkspaceForFile(fileUri: vscode.Uri): WorkspaceContext | undefined {
        const folder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!folder) {
            return undefined;
        }

        return this.workspaces.get(folder.uri.toString());
    }

    /**
     * Get all workspace contexts
     */
    getAllWorkspaces(): WorkspaceContext[] {
        return Array.from(this.workspaces.values());
    }

    /**
     * Get workspace count
     */
    getWorkspaceCount(): number {
        return this.workspaces.size;
    }

    /**
     * Check if multi-workspace mode is active
     */
    isMultiWorkspace(): boolean {
        return this.workspaces.size > 1;
    }

    /**
     * Get workspace picker items
     */
    getWorkspacePickerItems(): Array<{ label: string; description: string; uri: string }> {
        return Array.from(this.workspaces.values()).map(ctx => ({
            label: `$(folder) ${ctx.folder.name}`,
            description: ctx.folder.uri.fsPath,
            uri: ctx.folder.uri.toString()
        }));
    }

    /**
     * Show workspace picker and switch
     */
    async showWorkspacePicker(): Promise<boolean> {
        if (!this.isMultiWorkspace()) {
            vscode.window.showInformationMessage('Only one workspace folder is open');
            return false;
        }

        const items = this.getWorkspacePickerItems();
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select workspace folder for AI assistant'
        });

        if (!selected) {
            return false;
        }

        const ctx = this.workspaces.get(selected.uri);
        if (ctx) {
            this.setActiveWorkspace(ctx.folder);
            return true;
        }

        return false;
    }

    /**
     * Dispose all workspaces
     */
    dispose(): void {
        this.workspaces.clear();
        this.activeWorkspaceUri = undefined;
    }
}
