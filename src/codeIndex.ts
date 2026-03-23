import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { logInfo, logError, logWarn } from './logger';
import { EmbeddingService } from './embeddingService';
import { MemoryConfig } from './memoryConfig';
import { SKIP_DIRS } from './workspace';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CodeIndexEntry {
    /** Relative path from workspace root, forward slashes */
    relPath: string;
    /** One-line summary: purpose + key symbols */
    summary: string;
    /** File modification time (ms) at index time — for incremental updates */
    mtime: number;
}

export interface RelevantFile {
    relPath: string;
    absPath: string;
    summary: string;
    score: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set([
    '.py', '.ts', '.js', '.tsx', '.jsx',
    '.go', '.java', '.rs', '.rb', '.php',
    '.cs', '.c', '.cpp', '.h', '.swift',
]);

const MAX_FILE_BYTES = 150_000;
const INDEX_BATCH_SIZE = 20;
const COLLECTION_SUFFIX = '_code_index';

// ── Helpers ───────────────────────────────────────────────────────────────────

function stringToUuid(id: string): string {
    const hash = crypto.createHash('md5').update(id).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Extract a compact summary from file content using simple regex.
 * No AST — works on any language.
 * Returns: purpose line + key class/function names.
 */
function extractFileSummary(relPath: string, content: string): string {
    const lines = content.split('\n');
    const ext = path.extname(relPath).toLowerCase();
    const basename = path.basename(relPath, path.extname(relPath));

    const symbols: string[] = [];
    let docLine = '';

    if (ext === '.py') {
        // First module docstring
        const docMatch = content.match(/^(?:"""|\'\'\')([\s\S]*?)(?:"""|\'\'\')/)
                      || content.match(/^#\s*(.+)/m);
        if (docMatch) { docLine = docMatch[1].trim().split('\n')[0].slice(0, 120); }
        // Classes and top-level functions
        for (const line of lines) {
            const cls = line.match(/^class\s+(\w+)/);
            const fn  = line.match(/^def\s+(\w+)/);
            if (cls) { symbols.push(cls[1]); }
            else if (fn && !fn[1].startsWith('_')) { symbols.push(fn[1] + '()'); }
            if (symbols.length >= 8) { break; }
        }
    } else if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
        // First block comment or // comment
        const docMatch = content.match(/^\/\*\*([\s\S]*?)\*\//)
                      || content.match(/^\/\/\s*(.+)/m);
        if (docMatch) { docLine = docMatch[1].trim().split('\n')[0].replace(/^\s*\*\s*/, '').slice(0, 120); }
        for (const line of lines) {
            const cls   = line.match(/(?:export\s+)?(?:class|interface)\s+(\w+)/);
            const fn    = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
            const arrow = line.match(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/);
            if (cls)   { symbols.push(cls[1]); }
            else if (fn) { symbols.push(fn[1] + '()'); }
            else if (arrow) { symbols.push(arrow[1] + '()'); }
            if (symbols.length >= 8) { break; }
        }
    } else {
        // Generic: grab first comment line
        const docMatch = content.match(/^(?:\/\/|#|--|\/\*)\s*(.+)/m);
        if (docMatch) { docLine = docMatch[1].trim().slice(0, 120); }
    }

    const symbolStr = symbols.length > 0 ? `  Symbols: ${symbols.join(', ')}` : '';
    const purposeStr = docLine ? `  Purpose: ${docLine}` : '';
    return `File: ${relPath}${purposeStr}${symbolStr}`.trim();
}

/**
 * Walk workspace and collect all indexable source files.
 */
function collectSourceFiles(root: string): Array<{ relPath: string; absPath: string; mtime: number }> {
    const results: Array<{ relPath: string; absPath: string; mtime: number }> = [];

    const walk = (dir: string, depth: number) => {
        if (depth > 10) { return; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full, depth + 1);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!CODE_EXTENSIONS.has(ext)) { continue; }
                try {
                    const stat = fs.statSync(full);
                    if (stat.size > MAX_FILE_BYTES) { continue; }
                    results.push({
                        relPath: path.relative(root, full).replace(/\\/g, '/'),
                        absPath: full,
                        mtime: stat.mtimeMs,
                    });
                } catch { /* skip unreadable */ }
            }
        }
    };

    walk(root, 0);
    return results;
}

// ── CodeIndexer ───────────────────────────────────────────────────────────────

export class CodeIndexer {
    private client: AxiosInstance;
    private collectionName: string;
    private embedding: EmbeddingService;
    private vectorSize: number;
    private workspaceRoot: string;
    /** relPath → mtime: tracks what's already indexed */
    private indexedFiles = new Map<string, number>();
    private initialized = false;
    private indexing = false;

    constructor(
        config: MemoryConfig,
        workspaceName: string,
        workspaceRoot: string,
        embeddingService: EmbeddingService,
        vectorSize: number
    ) {
        this.client = axios.create({
            baseURL: config.qdrantUrl,
            timeout: 15_000,
            headers: { 'Content-Type': 'application/json' },
        });
        this.collectionName = `ollamapilot_${workspaceName
            .replace(/[^a-z0-9_]/gi, '_').toLowerCase()}${COLLECTION_SUFFIX}`;
        this.embedding = embeddingService;
        this.vectorSize = vectorSize;
        this.workspaceRoot = workspaceRoot;
    }

    // ── Qdrant collection management ─────────────────────────────────────────

    private async ensureCollection(): Promise<void> {
        try {
            await this.client.get(`/collections/${this.collectionName}`);
        } catch (err: any) {
            if (err?.response?.status === 404) {
                await this.client.put(`/collections/${this.collectionName}`, {
                    vectors: { size: this.vectorSize, distance: 'Cosine' },
                    optimizers_config: { default_segment_number: 2 },
                });
                logInfo(`[code-index] Created collection: ${this.collectionName}`);
            } else {
                throw err;
            }
        }
    }

    private async upsertPoints(points: Array<{
        id: string; vector: number[];
        payload: { relPath: string; summary: string; mtime: number; workspaceRoot: string };
    }>): Promise<void> {
        if (points.length === 0) { return; }
        await this.client.put(`/collections/${this.collectionName}/points`, {
            points: points.map(p => ({ ...p, id: stringToUuid(p.id) })),
        });
    }

    private async deletePoints(ids: string[]): Promise<void> {
        if (ids.length === 0) { return; }
        await this.client.post(`/collections/${this.collectionName}/points/delete`, {
            points: ids.map(stringToUuid),
        });
    }

    private async searchPoints(vector: number[], limit: number): Promise<Array<{
        score: number; payload: { relPath: string; summary: string };
    }>> {
        const resp = await this.client.post(
            `/collections/${this.collectionName}/points/search`,
            { vector, limit, with_payload: true, score_threshold: 0.3 }
        );
        return (resp.data?.result ?? []).map((r: any) => ({
            score: r.score,
            payload: r.payload,
        }));
    }

    /** Load existing indexed file metadata from Qdrant (for incremental updates). */
    private async loadExistingIndex(): Promise<void> {
        try {
            // Scroll all points to get current index state
            let offset: string | null = null;
            this.indexedFiles.clear();
            do {
                // eslint-disable-next-line no-await-in-loop
                const resp: { data: any } = await this.client.post(
                    `/collections/${this.collectionName}/points/scroll`,
                    { limit: 250, with_payload: true, offset: offset ?? undefined }
                );
                const points: any[] = resp.data?.result?.points ?? [];
                for (const p of points) {
                    if (p.payload?.relPath) {
                        this.indexedFiles.set(p.payload.relPath, p.payload.mtime ?? 0);
                    }
                }
                offset = resp.data?.result?.next_page_offset ?? null;
            } while (offset !== null);
            logInfo(`[code-index] Loaded ${this.indexedFiles.size} existing entries`);
        } catch {
            // Collection may be empty — that's fine
            this.indexedFiles.clear();
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Initialize collection and run the initial indexing pass.
     * Non-blocking — caller does not need to await completion.
     */
    async initialize(): Promise<void> {
        try {
            await this.ensureCollection();
            await this.loadExistingIndex();
            this.initialized = true;
            logInfo('[code-index] Initialized');
            // Run initial index in background
            this.indexWorkspace().catch(e =>
                logError(`[code-index] Initial index failed: ${e}`)
            );
        } catch (err) {
            logError(`[code-index] Initialization failed: ${err}`);
        }
    }

    /**
     * Full incremental workspace index.
     * Indexes new/modified files, removes deleted files.
     */
    async indexWorkspace(): Promise<void> {
        if (this.indexing || !this.initialized) { return; }
        this.indexing = true;
        try {
            const files = collectSourceFiles(this.workspaceRoot);
            const fileMap = new Map(files.map(f => [f.relPath, f]));

            // Find files to add/update
            const toIndex = files.filter(f => {
                const existing = this.indexedFiles.get(f.relPath);
                return existing === undefined || existing < f.mtime;
            });

            // Find deleted files
            const toDelete = [...this.indexedFiles.keys()].filter(p => !fileMap.has(p));

            logInfo(`[code-index] Indexing ${toIndex.length} new/changed, removing ${toDelete.length} deleted`);

            // Delete removed files
            if (toDelete.length > 0) {
                await this.deletePoints(toDelete);
                for (const p of toDelete) { this.indexedFiles.delete(p); }
            }

            // Index in batches
            for (let i = 0; i < toIndex.length; i += INDEX_BATCH_SIZE) {
                const batch = toIndex.slice(i, i + INDEX_BATCH_SIZE);
                const points: Parameters<typeof this.upsertPoints>[0] = [];

                for (const file of batch) {
                    try {
                        const content = fs.readFileSync(file.absPath, 'utf8');
                        const summary = extractFileSummary(file.relPath, content);
                        const vector  = await this.embedding.generateEmbedding(summary);
                        points.push({
                            id: file.relPath,
                            vector,
                            payload: {
                                relPath: file.relPath,
                                summary,
                                mtime: file.mtime,
                                workspaceRoot: this.workspaceRoot,
                            },
                        });
                        this.indexedFiles.set(file.relPath, file.mtime);
                    } catch (e) {
                        logWarn(`[code-index] Skipping ${file.relPath}: ${e}`);
                    }
                }

                if (points.length > 0) {
                    await this.upsertPoints(points);
                }
            }

            logInfo(`[code-index] Index complete — ${this.indexedFiles.size} files total`);
        } finally {
            this.indexing = false;
        }
    }

    /**
     * Update index for a single file (call on file save).
     */
    async indexFile(absPath: string): Promise<void> {
        if (!this.initialized) { return; }
        const relPath = path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/');
        const ext = path.extname(absPath).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) { return; }
        try {
            const stat = fs.statSync(absPath);
            if (stat.size > MAX_FILE_BYTES) { return; }
            const content = fs.readFileSync(absPath, 'utf8');
            const summary = extractFileSummary(relPath, content);
            const vector  = await this.embedding.generateEmbedding(summary);
            await this.upsertPoints([{
                id: relPath,
                vector,
                payload: { relPath, summary, mtime: stat.mtimeMs, workspaceRoot: this.workspaceRoot },
            }]);
            this.indexedFiles.set(relPath, stat.mtimeMs);
            logInfo(`[code-index] Re-indexed ${relPath}`);
        } catch (e) {
            logWarn(`[code-index] Failed to index ${relPath}: ${e}`);
        }
    }

    /**
     * Semantic search — find files most relevant to the user's query.
     * Returns up to `limit` results sorted by similarity score.
     */
    async findRelevantFiles(query: string, limit = 5): Promise<RelevantFile[]> {
        if (!this.initialized) { return []; }
        try {
            const vector = await this.embedding.generateEmbedding(query);
            const results = await this.searchPoints(vector, limit);
            return results.map(r => ({
                relPath: r.payload.relPath,
                absPath: path.join(this.workspaceRoot, r.payload.relPath.replace(/\//g, path.sep)),
                summary: r.payload.summary,
                score: r.score,
            }));
        } catch (e) {
            logError(`[code-index] findRelevantFiles failed: ${e}`);
            return [];
        }
    }

    /**
     * Fetch stored vectors for all indexed files under a given directory prefix.
     * Used by similarityAnalyzer for clustering without re-embedding.
     * @param dirRelPath - relative path prefix, forward slashes, e.g. "app/services"
     */
    async getEmbeddingsForDirectory(dirRelPath: string): Promise<Array<{
        relPath: string;
        absPath: string;
        summary: string;
        vector: number[];
    }>> {
        if (!this.initialized) { return []; }
        const prefix = dirRelPath.replace(/\\/g, '/').replace(/\/?$/, '/');
        const results: Array<{ relPath: string; absPath: string; summary: string; vector: number[] }> = [];
        let offset: string | null = null;
        try {
            do {
                // eslint-disable-next-line no-await-in-loop
                const resp: { data: any } = await this.client.post(
                    `/collections/${this.collectionName}/points/scroll`,
                    {
                        limit: 250,
                        with_payload: true,
                        with_vector: true,
                        offset: offset ?? undefined,
                        filter: {
                            must: [{
                                key: 'relPath',
                                match: { any: [...this.indexedFiles.keys()].filter(p => p.startsWith(prefix)) }
                            }]
                        }
                    }
                );
                const points: any[] = resp.data?.result?.points ?? [];
                for (const p of points) {
                    if (p.payload?.relPath && p.vector) {
                        results.push({
                            relPath: p.payload.relPath,
                            absPath: path.join(this.workspaceRoot, p.payload.relPath.replace(/\//g, path.sep)),
                            summary: p.payload.summary ?? '',
                            vector: p.vector,
                        });
                    }
                }
                offset = resp.data?.result?.next_page_offset ?? null;
            } while (offset !== null);
        } catch (e) {
            logWarn(`[code-index] getEmbeddingsForDirectory failed: ${e}`);
        }
        return results;
    }

    get isReady(): boolean { return this.initialized; }
    get fileCount(): number { return this.indexedFiles.size; }
}
