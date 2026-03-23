/**
 * similarityAnalyzer.ts
 *
 * Finds groups of semantically similar files using stored Qdrant embeddings.
 * No model call required — operates entirely on vectors already in the index.
 *
 * Two modes:
 *   findSimilarInDirectory(dir)  — cluster all files in a directory by similarity
 *   findFilesLike(anchorFile)    — find files most similar to a specific file
 */

import * as path from 'path';
import { CodeIndexer } from './codeIndex';
import { logInfo } from './logger';

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface SimilarityCluster {
    label: string;
    files: Array<{ relPath: string; score: number }>;
    avgSimilarity: number;
}

export interface SimilarityReport {
    mode: 'directory' | 'anchor';
    scope: string;
    clusters: SimilarityCluster[];
    ungrouped: string[];
    threshold: number;
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot   += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) { return 0; }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Label derivation ─────────────────────────────────────────────────────────

// Tokens that appear in almost every service file name — useless as cluster labels
const NOISE_TOKENS = new Set([
    'service', 'services', 'api', 'engine', 'manager', 'handler',
    'util', 'utils', 'helper', 'helpers', 'base', 'core', 'main',
    'index', 'init', 'py', 'ts', 'js',
]);

/**
 * Derive a human-readable label from a group of file paths.
 * Prefers meaningful tokens shared by a majority of files.
 * Falls back to the directory name if only noise tokens are common.
 */
function deriveLabel(relPaths: string[], scopeDir: string): string {
    const stems = relPaths.map(p => path.basename(p, path.extname(p)));
    const tokenSets = stems.map(s => s.split(/[_-]/));

    // Count how many files contain each token
    const tokenFreq = new Map<string, number>();
    for (const tokens of tokenSets) {
        for (const t of new Set(tokens)) {
            tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
        }
    }

    const majority = Math.ceil(relPaths.length * 0.5);

    // Common meaningful tokens — shared by majority and not noise
    const meaningful = [...tokenFreq.entries()]
        .filter(([t, freq]) => freq >= majority && !NOISE_TOKENS.has(t) && t.length > 2)
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t);

    if (meaningful.length > 0) {
        return meaningful.slice(0, 2).join('_');
    }

    // All common tokens were noise — fall back to directory name
    return path.basename(scopeDir);
}

// ── Greedy clustering ─────────────────────────────────────────────────────────

interface FileVector {
    relPath: string;
    summary: string;
    vector: number[];
}

/**
 * Greedy complete-linkage clustering.
 *
 * A node joins a cluster only if its average similarity to ALL current
 * cluster members is >= threshold. This prevents low-similarity stragglers
 * from being dragged in just because they're close to the seed.
 */
function clusterByThreshold(files: FileVector[], threshold: number): {
    clusters: Array<{ indices: number[]; avgSim: number }>;
    ungrouped: number[];
} {
    const n = files.length;
    if (n === 0) { return { clusters: [], ungrouped: [] }; }

    // Pre-compute full similarity matrix
    const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const s = cosineSimilarity(files[i].vector, files[j].vector);
            sim[i][j] = s;
            sim[j][i] = s;
        }
    }

    // Degree = number of neighbors >= threshold (used for seeding order)
    const degree = files.map((_, i) =>
        sim[i].reduce((acc, s) => acc + (s >= threshold ? 1 : 0), 0)
    );

    const assigned = new Set<number>();
    const clusters: Array<{ indices: number[]; avgSim: number }> = [];

    // Process seeds in descending degree order (most-connected first)
    const order = [...Array(n).keys()].sort((a, b) => degree[b] - degree[a]);

    for (const seed of order) {
        if (assigned.has(seed)) { continue; }
        if (degree[seed] < 1) { break; } // no node can form a pair

        const members = [seed];

        // Candidate expansion: add nodes whose avg sim to ALL current members >= threshold
        // Iterate until stable (complete-linkage condition)
        let changed = true;
        while (changed) {
            changed = false;
            for (let j = 0; j < n; j++) {
                if (j === seed || assigned.has(j) || members.includes(j)) { continue; }
                // Avg similarity of j to current members
                const avgToMembers = members.reduce((acc, m) => acc + sim[j][m], 0) / members.length;
                if (avgToMembers >= threshold) {
                    members.push(j);
                    changed = true;
                }
            }
        }

        if (members.length < 2) { continue; }

        // Post-expansion ejection: remove members whose cohesion (avg sim to
        // rest of cluster) is below threshold. Iterate until stable.
        let ejected = true;
        while (ejected && members.length >= 2) {
            ejected = false;
            for (let pos = members.length - 1; pos >= 0; pos--) {
                const i = members[pos];
                const others = members.filter((_, p) => p !== pos);
                const cohesion = others.reduce((acc, j) => acc + sim[i][j], 0) / others.length;
                if (cohesion < threshold) {
                    members.splice(pos, 1);
                    ejected = true;
                }
            }
        }

        if (members.length < 2) { continue; }

        // Compute average pairwise similarity for the final cluster
        let total = 0, pairs = 0;
        for (let a = 0; a < members.length; a++) {
            for (let b = a + 1; b < members.length; b++) {
                total += sim[members[a]][members[b]];
                pairs++;
            }
        }
        const avgSim = pairs > 0 ? total / pairs : threshold;

        for (const m of members) { assigned.add(m); }
        clusters.push({ indices: members, avgSim });
    }

    const ungrouped = [...Array(n).keys()].filter(i => !assigned.has(i));
    return { clusters, ungrouped };
}

// ── Per-file score within cluster ─────────────────────────────────────────────

/**
 * Score each file as its average similarity to other cluster members.
 * This is the "cohesion" score — how well it fits the cluster.
 */
function scoreMembership(
    memberIndices: number[],
    sim: number[][]
): Map<number, number> {
    const scores = new Map<number, number>();
    for (let pos = 0; pos < memberIndices.length; pos++) {
        const i = memberIndices[pos];
        const others = memberIndices.filter((_, p) => p !== pos);
        const avg = others.length
            ? others.reduce((acc, j) => acc + sim[i][j], 0) / others.length
            : 1;
        scores.set(i, Math.round(avg * 100) / 100);
    }
    return scores;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Cluster all directly-indexed files under `scopeDir` by semantic similarity.
 * Files in subdirectories are excluded (they should be analyzed separately).
 */
export async function findSimilarInDirectory(
    scopeDir: string,
    workspaceRoot: string,
    codeIndex: CodeIndexer,
    threshold = 0.85
): Promise<SimilarityReport> {
    const dirRelPath = path.relative(workspaceRoot, scopeDir).replace(/\\/g, '/');
    logInfo(`[similarity] Clustering files in ${dirRelPath} (threshold=${threshold})`);

    const allEntries = await codeIndex.getEmbeddingsForDirectory(dirRelPath);

    // Exclude files in subdirectories — they belong to a different logical layer
    const prefix = dirRelPath + '/';
    const entries = allEntries.filter(e => {
        const rest = e.relPath.slice(prefix.length);
        return !rest.includes('/'); // no further slash = direct child
    });

    logInfo(`[similarity] ${entries.length} direct files (${allEntries.length - entries.length} subdir files excluded)`);

    if (entries.length === 0) {
        return { mode: 'directory', scope: dirRelPath, clusters: [], ungrouped: [], threshold };
    }

    const files: FileVector[] = entries.map(e => ({
        relPath: e.relPath,
        summary: e.summary,
        vector: e.vector,
    }));

    // Pre-compute sim matrix here so we can reuse it for scoring
    const n = files.length;
    const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const s = cosineSimilarity(files[i].vector, files[j].vector);
            sim[i][j] = s;
            sim[j][i] = s;
        }
    }

    const { clusters, ungrouped } = clusterByThreshold(files, threshold);

    // Detect stub files: tiny files (< 120 lines) with only placeholder methods
    const STUB_LINE_LIMIT = 120;
    const isStub = (relPath: string): boolean => {
        try {
            const abs = path.join(workspaceRoot, relPath.replace(/\//g, path.sep));
            const content = require('fs').readFileSync(abs, 'utf8') as string;
            const lineCount = content.split('\n').length;
            return lineCount <= STUB_LINE_LIMIT && /pass\s*$|return \[\]|return \{\}|return None|raise NotImplementedError/m.test(content);
        } catch { return false; }
    };

    const result: SimilarityReport = {
        mode: 'directory',
        scope: dirRelPath,
        threshold,
        clusters: clusters.map(c => {
            const memberScores = scoreMembership(c.indices, sim);
            const relPaths = c.indices.map(i => files[i].relPath);
            const stubCount = relPaths.filter(isStub).length;
            const allStubs = stubCount === relPaths.length;
            const baseLabel = deriveLabel(relPaths, scopeDir);
            const dirName = path.basename(scopeDir);
            const labelDefaulted = baseLabel === dirName;
            const label = allStubs
                ? `${baseLabel} (empty stubs)`
                : labelDefaulted
                    ? `${baseLabel} (review — no common tokens)`
                    : baseLabel;
            return {
                label,
                avgSimilarity: Math.round(c.avgSim * 100) / 100,
                files: c.indices
                    .map(i => ({ relPath: files[i].relPath, score: memberScores.get(i) ?? 0 }))
                    .sort((a, b) => b.score - a.score),
            };
        }).sort((a, b) => b.avgSimilarity - a.avgSimilarity),
        ungrouped: ungrouped.map(i => files[i].relPath),
    };

    logInfo(`[similarity] Found ${result.clusters.length} clusters, ${result.ungrouped.length} ungrouped`);
    return result;
}

/**
 * Find files most similar to a specific anchor file.
 */
export async function findFilesLike(
    anchorRelPath: string,
    workspaceRoot: string,
    codeIndex: CodeIndexer,
    limit = 10
): Promise<SimilarityReport> {
    logInfo(`[similarity] Finding files like ${anchorRelPath}`);

    const results = await codeIndex.findRelevantFiles(
        `file: ${path.basename(anchorRelPath, path.extname(anchorRelPath))}`,
        limit + 2
    );

    const filtered = results
        .filter(r => r.relPath !== anchorRelPath)
        .slice(0, limit);

    const avgSim = filtered.length
        ? filtered.reduce((a, b) => a + b.score, 0) / filtered.length
        : 0;

    return {
        mode: 'anchor',
        scope: anchorRelPath,
        threshold: 0,
        clusters: filtered.length > 0 ? [{
            label: `similar to ${path.basename(anchorRelPath)}`,
            avgSimilarity: Math.round(avgSim * 100) / 100,
            files: filtered.map(r => ({ relPath: r.relPath, score: Math.round(r.score * 100) / 100 })),
        }] : [],
        ungrouped: [],
    };
}

// ── Report formatting ─────────────────────────────────────────────────────────

export function formatSimilarityReport(report: SimilarityReport): string {
    const lines: string[] = [];

    if (report.clusters.length === 0 && report.ungrouped.length === 0) {
        return `No indexed files found in \`${report.scope}\`. Try running a workspace index first.`;
    }

    if (report.clusters.length === 0) {
        return `No similarity clusters found in \`${report.scope}\` at threshold ${report.threshold} — all ${report.ungrouped.length} files appear distinct.`;
    }

    const totalFiles = report.clusters.reduce((a, c) => a + c.files.length, 0) + report.ungrouped.length;

    lines.push(`Found **${report.clusters.length}** similarity cluster${report.clusters.length !== 1 ? 's' : ''} in \`${report.scope}\` (${totalFiles} files, threshold: ${report.threshold})\n`);

    for (let i = 0; i < report.clusters.length; i++) {
        const cluster = report.clusters[i];
        lines.push(`**Cluster ${i + 1} — ${cluster.label}** (${cluster.files.length} files, avg similarity: ${cluster.avgSimilarity})`);
        for (const f of cluster.files) {
            lines.push(`  - \`${path.basename(f.relPath)}\`  ${f.score}`);
        }
        lines.push('');
    }

    if (report.ungrouped.length > 0) {
        lines.push(`**${report.ungrouped.length}** file${report.ungrouped.length !== 1 ? 's' : ''} with no close matches:`);
        for (const f of report.ungrouped) {
            lines.push(`  - \`${path.basename(f)}\``);
        }
    }

    return lines.join('\n');
}
