import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TieredMemoryManager } from './memoryCore';
import { SKIP_DIRS } from './workspace';
import { logInfo, logError, toErrorMessage } from './logger';

/** Max file size to read (256 KB) */
const MAX_FILE_SIZE = 256 * 1024;

/** Max depth to recurse */
const MAX_DEPTH = 5;

interface MdSection {
    heading: string;
    body: string;
    file: string;
}

/**
 * Recursively find all .md files in a directory.
 */
async function findMarkdownFiles(dir: string, depth = 0): Promise<string[]> {
    if (depth > MAX_DEPTH) { return []; }
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return results;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                results.push(...await findMarkdownFiles(path.join(dir, entry.name), depth + 1));
            }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            results.push(path.join(dir, entry.name));
        }
    }
    return results;
}

/**
 * Parse a markdown file into sections split by headings.
 * Each section becomes a separate memory entry.
 */
function parseSections(content: string, relPath: string): MdSection[] {
    const lines = content.split(/\r?\n/);
    const sections: MdSection[] = [];
    let currentHeading = relPath; // default heading = filename
    let bodyLines: string[] = [];

    for (const line of lines) {
        const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
        if (headingMatch) {
            // Flush previous section
            const body = bodyLines.join('\n').trim();
            if (body.length > 20) { // skip trivially short sections
                sections.push({ heading: currentHeading, body, file: relPath });
            }
            currentHeading = headingMatch[2].trim();
            bodyLines = [];
        } else {
            bodyLines.push(line);
        }
    }
    // Flush last section
    const body = bodyLines.join('\n').trim();
    if (body.length > 20) {
        sections.push({ heading: currentHeading, body, file: relPath });
    }
    return sections;
}

/**
 * Ingest all .md files in the workspace into memory Tier 4 (References).
 * Skips sections whose content already exists in memory.
 */
export async function ingestMarkdownFiles(memoryManager: TieredMemoryManager): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Ingesting Markdown files…', cancellable: true },
        async (progress, token) => {
            // 1. Find .md files
            progress.report({ message: 'Scanning for .md files…' });
            const files = await findMarkdownFiles(root);
            if (files.length === 0) {
                vscode.window.showInformationMessage('No .md files found in workspace.');
                return;
            }
            logInfo(`[md-ingest] Found ${files.length} .md file(s)`);

            // 2. Get existing memory content to deduplicate
            const existing = new Set<string>();
            for (let tier = 0; tier <= 5; tier++) {
                const entries = await memoryManager.listByTier(tier);
                for (const e of entries) {
                    existing.add(e.content);
                }
            }

            // 3. Parse and ingest
            let ingested = 0;
            let skipped = 0;
            for (let i = 0; i < files.length; i++) {
                if (token.isCancellationRequested) { break; }

                const filePath = files[i];
                const relPath = path.relative(root, filePath).replace(/\\/g, '/');
                progress.report({
                    message: `${relPath} (${i + 1}/${files.length})`,
                    increment: (100 / files.length)
                });

                try {
                    const stat = fs.statSync(filePath);
                    if (stat.size > MAX_FILE_SIZE) {
                        logInfo(`[md-ingest] Skipping ${relPath} (too large: ${stat.size} bytes)`);
                        continue;
                    }
                    const content = fs.readFileSync(filePath, 'utf8');
                    const sections = parseSections(content, relPath);

                    for (const section of sections) {
                        if (token.isCancellationRequested) { break; }
                        const entryContent = `[${section.file}] ${section.heading}: ${section.body}`;
                        // Cap at 4000 chars (memoryCore MAX_NOTE_LEN)
                        const trimmed = entryContent.slice(0, 4000);

                        if (existing.has(trimmed)) {
                            skipped++;
                            continue;
                        }

                        await memoryManager.addEntry(4, trimmed, ['markdown-ingest', section.file]);
                        existing.add(trimmed);
                        ingested++;
                    }
                } catch (err) {
                    const msg = toErrorMessage(err);
                    logError(`[md-ingest] Error reading ${relPath}: ${msg}`);
                }
            }

            const summary = `Markdown ingest complete: ${ingested} sections added, ${skipped} duplicates skipped (from ${files.length} files).`;
            logInfo(`[md-ingest] ${summary}`);
            vscode.window.showInformationMessage(summary);
        }
    );
}
