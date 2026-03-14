import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

// ── Smart Context Manager ─────────────────────────────────────────────────────

export interface RelatedFile {
    path: string;
    relativePath: string;
    reason: 'import' | 'recent' | 'frequent';
    score: number;
}

export class SmartContextManager {
    private importCache = new Map<string, string[]>();

    /**
     * Get related files for the active document.
     * Returns files sorted by relevance score.
     */
    async getRelatedFiles(
        document: vscode.TextDocument,
        maxFiles: number = 5
    ): Promise<RelatedFile[]> {
        const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        if (!workspaceRoot) return [];

        const related: RelatedFile[] = [];

        // 1. Parse imports from current file
        const imports = this.parseImports(document);
        for (const importPath of imports) {
            const resolved = await this.resolveImportPath(importPath, document.uri, workspaceRoot);
            if (resolved) {
                related.push({
                    path: resolved,
                    relativePath: path.relative(workspaceRoot, resolved),
                    reason: 'import',
                    score: 10
                });
            }
        }

        // 2. Add recently modified files (git)
        const recentFiles = await this.getRecentlyModifiedFiles(workspaceRoot);
        for (const file of recentFiles.slice(0, 3)) {
            if (!related.some(r => r.path === file)) {
                related.push({
                    path: file,
                    relativePath: path.relative(workspaceRoot, file),
                    reason: 'recent',
                    score: 5
                });
            }
        }

        // 3. Sort by score and limit
        related.sort((a, b) => b.score - a.score);
        return related.slice(0, maxFiles);
    }

    /**
     * Parse import statements from a document.
     */
    private parseImports(document: vscode.TextDocument): string[] {
        const cacheKey = document.uri.fsPath;
        if (this.importCache.has(cacheKey)) {
            return this.importCache.get(cacheKey)!;
        }

        const text = document.getText();
        const language = document.languageId;
        const imports: string[] = [];

        switch (language) {
            case 'typescript':
            case 'javascript':
            case 'typescriptreact':
            case 'javascriptreact':
                imports.push(...this.parseTypeScriptImports(text));
                break;

            case 'python':
                imports.push(...this.parsePythonImports(text));
                break;

            case 'java':
                imports.push(...this.parseJavaImports(text));
                break;

            case 'go':
                imports.push(...this.parseGoImports(text));
                break;
        }

        this.importCache.set(cacheKey, imports);
        return imports;
    }

    private parseTypeScriptImports(text: string): string[] {
        const imports: string[] = [];
        
        // Match: import ... from 'path' or import ... from "path"
        const importRegex = /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = importRegex.exec(text)) !== null) {
            imports.push(match[1]);
        }

        // Match: require('path')
        const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((match = requireRegex.exec(text)) !== null) {
            imports.push(match[1]);
        }

        return imports;
    }

    private parsePythonImports(text: string): string[] {
        const imports: string[] = [];
        
        // Match: from path import ... or import path
        const importRegex = /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
        let match;
        while ((match = importRegex.exec(text)) !== null) {
            const importPath = match[1] || match[2];
            imports.push(importPath.replace(/\./g, '/'));
        }

        return imports;
    }

    private parseJavaImports(text: string): string[] {
        const imports: string[] = [];
        
        // Match: import package.Class;
        const importRegex = /import\s+([\w.]+);/g;
        let match;
        while ((match = importRegex.exec(text)) !== null) {
            imports.push(match[1].replace(/\./g, '/'));
        }

        return imports;
    }

    private parseGoImports(text: string): string[] {
        const imports: string[] = [];
        
        // Match: import "path" or import ( "path1" "path2" )
        const singleImportRegex = /import\s+"([^"]+)"/g;
        const multiImportRegex = /import\s+\(([\s\S]*?)\)/g;
        
        let match;
        while ((match = singleImportRegex.exec(text)) !== null) {
            imports.push(match[1]);
        }
        
        while ((match = multiImportRegex.exec(text)) !== null) {
            const block = match[1];
            const pathRegex = /"([^"]+)"/g;
            let pathMatch;
            while ((pathMatch = pathRegex.exec(block)) !== null) {
                imports.push(pathMatch[1]);
            }
        }

        return imports;
    }

    /**
     * Resolve an import path to an actual file path.
     */
    private async resolveImportPath(
        importPath: string,
        currentFileUri: vscode.Uri,
        workspaceRoot: string
    ): Promise<string | null> {
        // Skip node_modules and external packages
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
            return null;
        }

        const currentDir = path.dirname(currentFileUri.fsPath);
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', ''];

        // Try relative path resolution
        for (const ext of extensions) {
            const fullPath = path.resolve(currentDir, importPath + ext);
            if (await this.fileExists(fullPath)) {
                return fullPath;
            }
        }

        // Try index file
        const indexPath = path.resolve(currentDir, importPath, 'index');
        for (const ext of extensions) {
            const fullPath = indexPath + ext;
            if (await this.fileExists(fullPath)) {
                return fullPath;
            }
        }

        return null;
    }

    /**
     * Get recently modified files from git.
     */
    private async getRecentlyModifiedFiles(workspaceRoot: string): Promise<string[]> {
        try {
            const output = execSync('git diff --name-only HEAD~5..HEAD', {
                cwd: workspaceRoot,
                encoding: 'utf8',
                timeout: 2000
            });

            return output
                .split('\n')
                .filter((line: string) => line.trim())
                .map((file: string) => path.join(workspaceRoot, file))
                .filter((file: string) => this.isSourceFile(file));
        } catch {
            return [];
        }
    }

    /**
     * Check if a file exists.
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if a file is a source code file.
     */
    private isSourceFile(filePath: string): boolean {
        const ext = path.extname(filePath);
        const sourceExts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h'];
        return sourceExts.includes(ext);
    }

    /**
     * Clear import cache for a file (call on file change).
     */
    clearCache(filePath: string): void {
        this.importCache.delete(filePath);
    }

    /**
     * Clear all caches.
     */
    clearAllCaches(): void {
        this.importCache.clear();
    }
}
