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
    private _disposed = false;

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

    /** Cancel any in-progress indexing and release resources. */
    dispose(): void {
        this._disposed = true;
    }

    /**
     * Initialize collection and run the initial indexing pass.
     * Non-blocking — caller does not need to await completion.
     */
    async initialize(): Promise<void> {
        if (this._disposed) { return; }
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
                if (this._disposed) { return; } // cancelled — stop immediately
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

            // Auto-generate ARCHITECTURE.md if it doesn't exist or is stale
            this.generateArchitectureBriefing().catch(e =>
                logWarn(`[code-index] Architecture briefing failed: ${e}`)
            );
        } finally {
            this.indexing = false;
        }
    }

    /**
     * Scan the workspace and write ARCHITECTURE.md — a structured doc listing:
     * project type, entry points, middleware stack, key models, route prefixes, service layers.
     * Only writes if the file doesn't exist or is older than 24 hours.
     * The user can edit it to correct anything the scanner missed.
     */
    private async generateArchitectureBriefing(): Promise<void> {
        const root = this.workspaceRoot;
        const outPath = path.join(root, 'ARCHITECTURE.md');

        // Skip if file is fresh (< 24h old)
        try {
            const stat = fs.statSync(outPath);
            if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
                logInfo('[arch] ARCHITECTURE.md is recent — skipping regeneration');
                return;
            }
        } catch { /* doesn't exist — proceed */ }

        const lines: string[] = [];
        lines.push('# Architecture Briefing');
        lines.push('');
        lines.push('> Auto-generated by OllamaPilot on workspace index. Edit to correct anything the scanner missed.');
        lines.push('');

        // ── Project type detection ──────────────────────────────────────────────
        const hasPy = fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'pyproject.toml'));
        const hasTs = fs.existsSync(path.join(root, 'tsconfig.json'));
        const hasPackageJson = fs.existsSync(path.join(root, 'package.json'));
        const hasFlask = hasPy && (() => {
            try { return fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8').toLowerCase().includes('flask'); } catch { return false; }
        })();
        const hasNext = hasPackageJson && (() => {
            try { const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); return 'next' in (p.dependencies ?? {}) || 'next' in (p.devDependencies ?? {}); } catch { return false; }
        })();

        const projectType = hasFlask ? 'Python / Flask'
            : hasPy ? 'Python'
            : hasNext ? 'TypeScript / Next.js'
            : hasTs ? 'TypeScript / Node.js'
            : hasPackageJson ? 'JavaScript / Node.js'
            : 'Unknown';

        lines.push(`## Project type\n\n${projectType}\n`);

        // ── Entry points ────────────────────────────────────────────────────────
        const entryPoints: string[] = [];
        const entryPatterns = ['app.py', 'main.py', 'run.py', 'wsgi.py', 'manage.py', 'server.ts', 'server.js', 'index.ts', 'index.js', 'app/index.ts', 'src/index.ts'];
        for (const ep of entryPatterns) {
            if (fs.existsSync(path.join(root, ep))) { entryPoints.push(ep); }
        }
        if (entryPoints.length > 0) {
            lines.push(`## Entry points\n\n${entryPoints.map(e => `- \`${e}\``).join('\n')}\n`);
        }

        // ── Models ──────────────────────────────────────────────────────────────
        const modelsDir = path.join(root, hasPy ? 'app/models' : 'src/models');
        if (fs.existsSync(modelsDir)) {
            const modelFiles = fs.readdirSync(modelsDir).filter(f => !f.startsWith('_') && (f.endsWith('.py') || f.endsWith('.ts')));
            const modelClasses: string[] = [];
            for (const mf of modelFiles) {
                try {
                    const mc = fs.readFileSync(path.join(modelsDir, mf), 'utf8');
                    const re = hasPy ? /^class\s+(\w+)\s*[\(:]/gm : /^export\s+(?:interface|class|type)\s+(\w+)/gm;
                    for (const m of mc.matchAll(re)) { modelClasses.push(`\`${m[1]}\` (${mf})`); }
                } catch { /* skip */ }
            }
            if (modelClasses.length > 0) {
                lines.push(`## Models\n\n${modelClasses.map(c => `- ${c}`).join('\n')}\n`);
            }
        }

        // ── Route prefixes ──────────────────────────────────────────────────────
        const routesDir = path.join(root, hasPy ? 'app/routes' : 'src/routes');
        if (fs.existsSync(routesDir)) {
            const routePrefixes: string[] = [];
            const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.py') || f.endsWith('.ts'));
            for (const rf of routeFiles) {
                try {
                    const rc = fs.readFileSync(path.join(routesDir, rf), 'utf8');
                    // Flask blueprint url_prefix
                    const bpMatch = rc.match(/url_prefix\s*=\s*['"]([^'"]+)['"]/);
                    if (bpMatch) { routePrefixes.push(`\`${bpMatch[1]}\` (${rf})`); continue; }
                    // Express router — first app.use('/path', ...)
                    const expMatch = rc.match(/(?:app|router)\.use\(['"]([^'"]+)['"]/);
                    if (expMatch) { routePrefixes.push(`\`${expMatch[1]}\` (${rf})`); continue; }
                    // Fallback: just list the file
                    routePrefixes.push(`(${rf})`);
                } catch { /* skip */ }
            }
            if (routePrefixes.length > 0) {
                lines.push(`## Route prefixes\n\n${routePrefixes.map(r => `- ${r}`).join('\n')}\n`);
            }
        }

        // ── Services / utilities ────────────────────────────────────────────────
        const servicesDirs = ['app/services', 'src/services', 'app/utils', 'src/utils', 'lib'];
        for (const sd of servicesDirs) {
            const fullSd = path.join(root, sd);
            if (!fs.existsSync(fullSd)) { continue; }
            try {
                const sfs = fs.readdirSync(fullSd).filter(f => f.endsWith('.py') || f.endsWith('.ts'));
                if (sfs.length > 0) {
                    lines.push(`## ${sd}\n\n${sfs.map(f => `- \`${sd}/${f}\``).join('\n')}\n`);
                }
            } catch { /* skip */ }
        }

        // ── Middleware ──────────────────────────────────────────────────────────
        const middlewareDirs = ['app/middleware', 'src/middleware', 'middleware'];
        for (const md of middlewareDirs) {
            const fullMd = path.join(root, md);
            if (!fs.existsSync(fullMd)) { continue; }
            try {
                const mfs = fs.readdirSync(fullMd).filter(f => f.endsWith('.py') || f.endsWith('.ts'));
                if (mfs.length > 0) {
                    lines.push(`## Middleware (${md})\n\n${mfs.map(f => `- \`${md}/${f}\``).join('\n')}\n`);
                }
            } catch { /* skip */ }
        }

        // ── Config files ────────────────────────────────────────────────────────
        const configFiles = ['config.py', 'config.ts', '.env.example', 'app/config.py', 'src/config.ts', 'settings.py'];
        const foundConfigs = configFiles.filter(cf => fs.existsSync(path.join(root, cf)));
        if (foundConfigs.length > 0) {
            lines.push(`## Config\n\n${foundConfigs.map(c => `- \`${c}\``).join('\n')}\n`);
        }

        const content = lines.join('\n');
        fs.writeFileSync(outPath, content, 'utf8');
        logInfo(`[arch] Wrote ARCHITECTURE.md (${content.split('\n').length} lines)`);
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
