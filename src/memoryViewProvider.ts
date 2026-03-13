import * as vscode from 'vscode';
import { TieredMemoryManager, MemoryEntry } from './memoryCore';

const TIER_NAMES = ['Critical', 'Essential', 'Operational', 'Collaboration', 'References', 'Archive'];
const TIER_ICONS = ['shield', 'star', 'tools', 'organization', 'book', 'archive'];

export class MemoryViewProvider implements vscode.TreeDataProvider<MemoryTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<MemoryTreeItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private memoryManager: TieredMemoryManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: MemoryTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: MemoryTreeItem): Promise<MemoryTreeItem[]> {
        if (!element) {
            // Root level - show tiers
            const items: MemoryTreeItem[] = [];
            for (let tier = 0; tier <= 5; tier++) {
                const entries = await this.memoryManager.listByTier(tier);
                items.push(new MemoryTreeItem(
                    `Tier ${tier}: ${TIER_NAMES[tier]} (${entries.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'tier',
                    tier
                ));
            }
            return items;
        }

        if (element.type === 'tier') {
            // Tier level - show entries
            const entries = await this.memoryManager.listByTier(element.tier!);
            return entries.map(entry => new MemoryTreeItem(
                this.formatEntryLabel(entry),
                vscode.TreeItemCollapsibleState.None,
                'entry',
                entry.tier,
                entry
            ));
        }

        return [];
    }

    private formatEntryLabel(entry: MemoryEntry): string {
        const preview = entry.content.substring(0, 50).replace(/\n/g, ' ');
        const suffix = entry.content.length > 50 ? '...' : '';
        return `${preview}${suffix}`;
    }
}

export class MemoryTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'tier' | 'entry',
        public readonly tier?: number,
        public readonly entry?: MemoryEntry
    ) {
        super(label, collapsibleState);

        if (type === 'tier') {
            this.iconPath = new vscode.ThemeIcon(TIER_ICONS[tier!]);
            this.contextValue = 'memoryTier';
        } else if (type === 'entry') {
            this.iconPath = new vscode.ThemeIcon('note');
            this.contextValue = 'memoryEntry';
            this.tooltip = this.createTooltip(entry!);
            this.description = entry!.tags?.join(', ') || '';
        }
    }

    private createTooltip(entry: MemoryEntry): string {
        const lines = [
            `Content: ${entry.content}`,
            `Tier: ${entry.tier} (${TIER_NAMES[entry.tier]})`,
            `Created: ${new Date(entry.createdAt).toLocaleString()}`,
            `Last Accessed: ${new Date(entry.lastAccessed).toLocaleString()}`,
            `Accessed: ${entry.accessCount} times`
        ];
        if (entry.tags?.length) {
            lines.push(`Tags: ${entry.tags.join(', ')}`);
        }
        return lines.join('\n');
    }
}
