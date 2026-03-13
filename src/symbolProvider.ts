import * as vscode from 'vscode';
import { logInfo, logError } from './logger';

export interface SymbolInfo {
    name: string;
    kind: vscode.SymbolKind;
    location: vscode.Location;
    containerName?: string;
    detail?: string;
}

export class SymbolProvider {
    private symbolCache: Map<string, SymbolInfo[]> = new Map();
    private lastIndexTime = 0;
    private readonly CACHE_DURATION = 30000; // 30 seconds

    /**
     * Get all symbols in the workspace
     */
    async getWorkspaceSymbols(query: string = ''): Promise<SymbolInfo[]> {
        const now = Date.now();
        
        // Use cache if recent
        if (now - this.lastIndexTime < this.CACHE_DURATION && this.symbolCache.size > 0) {
            return this.filterSymbols(Array.from(this.symbolCache.values()).flat(), query);
        }

        // Rebuild cache
        await this.rebuildCache();
        
        return this.filterSymbols(Array.from(this.symbolCache.values()).flat(), query);
    }

    /**
     * Get symbols from a specific file
     */
    async getFileSymbols(uri: vscode.Uri): Promise<SymbolInfo[]> {
        const cacheKey = uri.fsPath;
        
        // Check cache first
        if (this.symbolCache.has(cacheKey)) {
            return this.symbolCache.get(cacheKey)!;
        }

        // Query symbols
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            );

            if (!symbols) {
                return [];
            }

            const flatSymbols = this.flattenSymbols(symbols, uri);
            this.symbolCache.set(cacheKey, flatSymbols);
            
            return flatSymbols;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logError(`[symbols] Failed to get symbols for ${uri.fsPath}: ${msg}`);
            return [];
        }
    }

    /**
     * Get symbol at a specific position
     */
    async getSymbolAtPosition(uri: vscode.Uri, position: vscode.Position): Promise<SymbolInfo | null> {
        const symbols = await this.getFileSymbols(uri);
        
        for (const symbol of symbols) {
            if (symbol.location.range.contains(position)) {
                return symbol;
            }
        }
        
        return null;
    }

    /**
     * Get symbol definition (code content)
     */
    async getSymbolContent(symbol: SymbolInfo): Promise<string> {
        try {
            const document = await vscode.workspace.openTextDocument(symbol.location.uri);
            const range = symbol.location.range;
            return document.getText(range);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logError(`[symbols] Failed to get symbol content: ${msg}`);
            return '';
        }
    }

    /**
     * Format symbol for display in autocomplete
     */
    formatSymbolForDisplay(symbol: SymbolInfo): string {
        const kindIcon = this.getSymbolIcon(symbol.kind);
        const container = symbol.containerName ? ` (${symbol.containerName})` : '';
        return `${kindIcon} ${symbol.name}${container}`;
    }

    /**
     * Rebuild the symbol cache
     */
    private async rebuildCache(): Promise<void> {
        this.symbolCache.clear();
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }

        logInfo('[symbols] Rebuilding symbol cache...');

        // Get all code files
        const files = await vscode.workspace.findFiles(
            '**/*.{ts,js,tsx,jsx,py,java,go,rs,cpp,c,cs,php}',
            '**/node_modules/**',
            1000 // Limit to 1000 files
        );

        // Index symbols from each file
        const promises = files.map(uri => this.getFileSymbols(uri));
        await Promise.all(promises);

        this.lastIndexTime = Date.now();
        logInfo(`[symbols] Indexed ${this.symbolCache.size} files`);
    }

    /**
     * Flatten nested symbols into a flat list
     */
    private flattenSymbols(
        symbols: vscode.DocumentSymbol[],
        uri: vscode.Uri,
        containerName?: string
    ): SymbolInfo[] {
        const result: SymbolInfo[] = [];

        for (const symbol of symbols) {
            result.push({
                name: symbol.name,
                kind: symbol.kind,
                location: new vscode.Location(uri, symbol.range),
                containerName,
                detail: symbol.detail
            });

            // Recursively flatten children
            if (symbol.children && symbol.children.length > 0) {
                result.push(...this.flattenSymbols(symbol.children, uri, symbol.name));
            }
        }

        return result;
    }

    /**
     * Filter symbols by query
     */
    private filterSymbols(symbols: SymbolInfo[], query: string): SymbolInfo[] {
        if (!query) {
            return symbols;
        }

        const lowerQuery = query.toLowerCase();
        return symbols.filter(s => 
            s.name.toLowerCase().includes(lowerQuery) ||
            (s.containerName && s.containerName.toLowerCase().includes(lowerQuery))
        );
    }

    /**
     * Get icon for symbol kind
     */
    private getSymbolIcon(kind: vscode.SymbolKind): string {
        switch (kind) {
            case vscode.SymbolKind.Function:
            case vscode.SymbolKind.Method:
                return '⚡';
            case vscode.SymbolKind.Class:
                return '📦';
            case vscode.SymbolKind.Interface:
                return '🔷';
            case vscode.SymbolKind.Variable:
            case vscode.SymbolKind.Constant:
                return '📌';
            case vscode.SymbolKind.Property:
            case vscode.SymbolKind.Field:
                return '🔹';
            case vscode.SymbolKind.Enum:
                return '🔢';
            case vscode.SymbolKind.Module:
            case vscode.SymbolKind.Namespace:
                return '📁';
            default:
                return '•';
        }
    }

    /**
     * Clear the cache
     */
    clearCache(): void {
        this.symbolCache.clear();
        this.lastIndexTime = 0;
    }
}
