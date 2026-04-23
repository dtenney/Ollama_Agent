import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logError, logWarn, toErrorMessage } from './logger';
import { MemoryConfig } from './memoryConfig';
import { QdrantClient, QdrantPoint } from './qdrantClient';
import { EmbeddingService } from './embeddingService';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * How an entry was accessed:
 * - passive_load : injected into system prompt automatically (weakest signal)
 * - search_result: returned by memory_search but may not have been read carefully
 * - search_hit   : returned by memory_search AND referenced by the model in its response
 *                  (strongest signal — model actually used this fact)
 */
export type MemoryAccessType = 'passive_load' | 'search_result' | 'search_hit';

export interface MemoryEntry {
    id: string;
    tier: 0 | 1 | 2 | 3 | 4 | 5;
    content: string;
    createdAt: string;
    lastAccessed: string;
    accessCount: number;
    /** Breakdown of how this entry has been accessed, by type */
    accessHistory?: { type: MemoryAccessType; at: string }[];
    tags?: string[];
    relevanceScore?: number;
}

export interface MemoryCore {
    tier_0_critical: MemoryEntry[];
    tier_1_essential: MemoryEntry[];
    tier_2_operational: MemoryEntry[];
    tier_3_collaboration: MemoryEntry[];
    tier_4_references: MemoryEntry[];
    tier_5_archive: MemoryEntry[];
}

/** On-disk format for .ollamapilot/memory.json */
interface MemoryFileFormat {
    version: '1.0';
    updatedAt: string;
    tiers: MemoryCore;
}

// ── TieredMemoryManager ───────────────────────────────────────────────────────

/**
 * Multi-tiered memory system for OllamaPilot.
 * 
 * Tiers:
 * - 0: Critical (always loaded) - IPs, paths, keys
 * - 1: Essential (session start) - frameworks, capabilities
 * - 2: Operational (task-relevant) - current work
 * - 3: Collaboration (on-demand) - team conventions
 * - 4: References (semantic search) - past solutions
 * - 5: Archive (deep storage) - historical data
 * 
 * Storage:
 * - Tiers 0-3: VS Code workspaceState (fast, local)
 * - Tiers 4-5: Qdrant vector DB (semantic search, unlimited)
 */
export class TieredMemoryManager {
    private static readonly STORAGE_KEY = 'ollamaAgent.memoryCore';
    private static readonly MAX_NOTE_LEN = 4_000;
    private static readonly MEMORY_FILENAME = '.ollamapilot/memory.json';
    /** Debounce timer for file sync to avoid excessive disk writes */
    private fileSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly FILE_SYNC_DELAY_MS = 2_000;
    private operationLock = Promise.resolve();
    /** In-memory cache of the core to prevent stale reads between async writes */
    private _cachedCore: MemoryCore | null = null;
    private _disposed = false;
    
    constructor(
        private readonly context: vscode.ExtensionContext,
        readonly config: MemoryConfig,
        private readonly qdrantClient?: QdrantClient,
        private readonly embeddingService?: EmbeddingService
    ) {
        // On construction, load from .ollamapilot/memory.json if it exists
        // and workspaceState is empty (first open of a cloned/shared project)
        this.loadFromFileIfNeeded();
        // Populate in-memory cache
        this._cachedCore = this.readCoreFromStorage();
    }

    /** True when Qdrant + embeddings are available (Tiers 4-5 operational). */
    get isQdrantAvailable(): boolean {
        return !!(this.qdrantClient && this.embeddingService);
    }

    /** Dispose resources: clear pending timers and flush to storage. */
    dispose(): void {
        if (this._disposed) { return; }
        this._disposed = true;
        if (this.fileSyncTimer) {
            clearTimeout(this.fileSyncTimer);
            this.fileSyncTimer = null;
            // Flush synchronously on dispose
            this.syncToFile();
        }
        this._cachedCore = null;
        logInfo('[memory] TieredMemoryManager disposed');
    }

    /**
     * Clear ALL memory: workspaceState, Qdrant collection, memory.json, and in-memory cache.
     */
    async clearAll(): Promise<void> {
        return this.withLock(async () => {
            // Clear workspaceState
            await this.context.workspaceState.update(TieredMemoryManager.STORAGE_KEY, undefined);
            // Clear in-memory cache
            this._cachedCore = this.emptyCore();
            // Clear Qdrant collection
            if (this.qdrantClient) {
                try {
                    await this.qdrantClient.deleteCollection();
                    await this.qdrantClient.initialize();
                    logInfo('[memory] Qdrant collection cleared and recreated');
                } catch (err) {
                    logError(`[memory] Failed to clear Qdrant: ${toErrorMessage(err)}`);
                }
            }
            // Delete memory.json
            const filePath = this.getMemoryFilePath();
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                logInfo('[memory] Deleted .ollamapilot/memory.json');
            }
            logInfo('[memory] All memory cleared');
        });
    }

    // ── File-based persistence (.ollamapilot/memory.json) ─────────────────────

    /** Get the path to the memory file in the workspace */
    private getMemoryFilePath(): string | null {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return null; }
        return path.join(root, TieredMemoryManager.MEMORY_FILENAME);
    }

    /**
     * If workspaceState is empty but .ollamapilot/memory.json exists,
     * import from the file. This handles: cloning a repo, opening on
     * a new machine, or sharing project memory via git.
     */
    private loadFromFileIfNeeded(): void {
        const core = this.getCore();
        const hasEntries = Object.values(core).some(tier => tier.length > 0);
        if (hasEntries) { return; } // workspaceState already has data

        const filePath = this.getMemoryFilePath();
        if (!filePath || !fs.existsSync(filePath)) { return; }

        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(raw) as MemoryFileFormat;
            if (data.version !== '1.0' || !data.tiers) {
                logWarn('[memory] Ignoring memory.json: unsupported format');
                return;
            }
            // Merge file data into workspaceState
            const merged: MemoryCore = {
                tier_0_critical: data.tiers.tier_0_critical || [],
                tier_1_essential: data.tiers.tier_1_essential || [],
                tier_2_operational: data.tiers.tier_2_operational || [],
                tier_3_collaboration: data.tiers.tier_3_collaboration || [],
                tier_4_references: data.tiers.tier_4_references || [],
                tier_5_archive: data.tiers.tier_5_archive || [],
            };
            const total = Object.values(merged).reduce((s, t) => s + t.length, 0);
            if (total > 0) {
                this.context.workspaceState.update(TieredMemoryManager.STORAGE_KEY, merged);
                logInfo(`[memory] Imported ${total} entries from ${TieredMemoryManager.MEMORY_FILENAME}`);
            }
        } catch (err) {
            logError(`[memory] Failed to load ${TieredMemoryManager.MEMORY_FILENAME}: ${toErrorMessage(err)}`);
        }
    }

    /**
     * Write current memory state to .ollamapilot/memory.json (debounced).
     * Only writes tiers 0, 1, 3 (stable project knowledge).
     * Tier 2 (operational/ephemeral) and 4-5 (Qdrant) are excluded.
     */
    private scheduleSyncToFile(): void {
        if (this.fileSyncTimer) { clearTimeout(this.fileSyncTimer); }
        this.fileSyncTimer = setTimeout(() => {
            this.fileSyncTimer = null;
            this.syncToFile();
        }, TieredMemoryManager.FILE_SYNC_DELAY_MS);
    }

    private syncToFile(): void {
        const filePath = this.getMemoryFilePath();
        if (!filePath) { return; }

        try {
            const core = this.getCore();
            const fileData: MemoryFileFormat = {
                version: '1.0',
                updatedAt: new Date().toISOString(),
                tiers: {
                    tier_0_critical: core.tier_0_critical,
                    tier_1_essential: core.tier_1_essential,
                    tier_2_operational: [], // Ephemeral — don't persist to file
                    tier_3_collaboration: core.tier_3_collaboration,
                    tier_4_references: core.tier_4_references,
                    tier_5_archive: core.tier_5_archive,
                },
            };
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2), 'utf8');
            logInfo(`[memory] Synced to ${TieredMemoryManager.MEMORY_FILENAME}`);
        } catch (err) {
            logError(`[memory] Failed to sync to file: ${toErrorMessage(err)}`);
        }
    }

    // ── Tier Access ───────────────────────────────────────────────────────────

    /** Get all entries from a specific tier */
    getTier(tier: 0 | 1 | 2 | 3 | 4 | 5): MemoryEntry[] {
        if (tier < 0 || tier > 5) {
            logError(`[memory] Invalid tier: ${tier}`);
            return [];
        }
        const core = this.getCoreReadonly();
        const tierKey = `tier_${tier}_${this.getTierName(tier)}` as keyof MemoryCore;
        return [...(core[tierKey] || [])]; // Return copy to prevent external mutations
    }

    /** List all entries from a specific tier (alias for getTier) */
    async listByTier(tier: number): Promise<MemoryEntry[]> {
        if (tier < 0 || tier > 5) {
            return [];
        }
        return this.getTier(tier as 0 | 1 | 2 | 3 | 4 | 5);
    }

    /** Add entry to specific tier */
    async addEntry(tier: 0 | 1 | 2 | 3 | 4 | 5, content: string, tags?: string[]): Promise<MemoryEntry> {
        return this.withLock(async () => {
            if (!content.trim()) {
                throw new Error('Memory content cannot be empty');
            }

            const trimmed = content.slice(0, TieredMemoryManager.MAX_NOTE_LEN);
            const entry: MemoryEntry = {
                id: `t${tier}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                tier,
                content: trimmed,
                createdAt: new Date().toISOString(),
                lastAccessed: new Date().toISOString(),
                accessCount: 0,
                ...(tags && tags.length ? { tags } : {})
            };
            
            const core = this.getCore();
            const tierKey = `tier_${tier}_${this.getTierName(tier)}` as keyof MemoryCore;
            
            // Always store in local storage (all tiers)
            core[tierKey] = [entry, ...core[tierKey]];
            await this.saveCore(core);

            // Additionally store in Qdrant for Tiers 4-5 (if available)
            if ((tier === 4 || tier === 5) && this.qdrantClient && this.embeddingService) {
                try {
                    const embedding = await this.embeddingService.generateEmbedding(trimmed);
                    const workspaceName = vscode.workspace.name || 'default';
                    
                    const point: QdrantPoint = {
                        id: entry.id,
                        vector: embedding,
                        payload: {
                            memoryId: entry.id,
                            content: trimmed,
                            tier,
                            tags,
                            timestamp: entry.lastAccessed,
                            workspaceId: workspaceName,
                            createdAt: entry.createdAt,
                            accessCount: 0
                        }
                    };
                    
                    await this.qdrantClient.upsertPoint(point);
                    logInfo(`[memory] Added to Tier ${tier} (local + Qdrant): "${trimmed.slice(0, 60)}..."`);
                } catch (error) {
                    logError(`[memory] Failed to store in Qdrant (local saved): ${toErrorMessage(error)}`);
                }
            } else {
                logInfo(`[memory] Added to Tier ${tier}: "${trimmed.slice(0, 60)}..."`);
            }
            return entry;
        });
    }

    /** Update an existing entry's content */
    async updateEntry(id: string, content: string): Promise<boolean> {
        return this.withLock(async () => {
            const core = this.getCore();
            for (const tierKey of Object.keys(core) as (keyof MemoryCore)[]) {
                const entry = core[tierKey].find(e => e.id === id);
                if (entry) {
                    const trimmed = content.slice(0, TieredMemoryManager.MAX_NOTE_LEN);
                    entry.content = trimmed;
                    entry.lastAccessed = new Date().toISOString();
                    
                    // Update in Qdrant if Tier 4-5
                    if ((entry.tier === 4 || entry.tier === 5) && this.qdrantClient && this.embeddingService) {
                        try {
                            const embedding = await this.embeddingService.generateEmbedding(trimmed);
                            const workspaceName = vscode.workspace.name || 'default';
                            await this.qdrantClient.upsertPoint({
                                id: entry.id,
                                vector: embedding,
                                payload: {
                                    memoryId: entry.id,
                                    content: trimmed,
                                    tier: entry.tier,
                                    tags: entry.tags,
                                    timestamp: entry.lastAccessed,
                                    workspaceId: workspaceName,
                                    createdAt: entry.createdAt,
                                    accessCount: entry.accessCount
                                }
                            });
                        } catch (error) {
                            logError(`[memory] Failed to update in Qdrant: ${toErrorMessage(error)}`);
                        }
                    }
                    
                    await this.saveCore(core);
                    logInfo(`[memory] Updated entry ${id}`);
                    return true;
                }
            }
            return false;
        });
    }

    /** Delete an entry by ID */
    async deleteEntry(id: string): Promise<boolean> {
        return this.withLock(async () => {
            const core = this.getCore();
            for (const tierKey of Object.keys(core) as (keyof MemoryCore)[]) {
                const tierEntries = core[tierKey];
                const idx = tierEntries.findIndex(e => e.id === id);
                if (idx !== -1) {
                    const entry = tierEntries[idx];
                    
                    // Delete from Qdrant if Tier 4-5
                    if ((entry.tier === 4 || entry.tier === 5) && this.qdrantClient) {
                        try {
                            await this.qdrantClient.deletePoint(id);
                        } catch (error) {
                            logError(`[memory] Failed to delete from Qdrant: ${toErrorMessage(error)}`);
                        }
                    }
                    
                    tierEntries.splice(idx, 1);
                    await this.saveCore(core);
                    logInfo(`[memory] Deleted entry ${id}`);
                    return true;
                }
            }
            return false;
        });
    }

    // ── Access Tracking ───────────────────────────────────────────────────────

    /** Find an entry by ID across all tiers. Returns undefined if not found. */
    findById(entryId: string): MemoryEntry | undefined {
        const core = this.getCoreReadonly();
        for (const tierKey of Object.keys(core) as (keyof MemoryCore)[]) {
            const entry = core[tierKey].find(e => e.id === entryId);
            if (entry) { return entry; }
        }
        return undefined;
    }

    /**
     * Record access to an entry.
     * - Increments accessCount
     * - Updates lastAccessed timestamp
     * - Appends to accessHistory (capped at last 50 events to avoid unbounded growth)
     * accessType: 'passive_load' | 'search_result' | 'search_hit'
     */
    recordAccess(entryId: string, accessType: MemoryAccessType = 'passive_load'): void {
        // Non-blocking access tracking - fire and forget
        this.withLock(async () => {
            const core = this.getCore();
            for (const tierKey of Object.keys(core) as (keyof MemoryCore)[]) {
                const entry = core[tierKey].find(e => e.id === entryId);
                if (entry) {
                    const now = new Date().toISOString();
                    entry.lastAccessed = now;
                    entry.accessCount++;
                    if (!entry.accessHistory) { entry.accessHistory = []; }
                    entry.accessHistory.push({ type: accessType, at: now });
                    // Cap history at 50 events — oldest drop off
                    if (entry.accessHistory.length > 50) {
                        entry.accessHistory = entry.accessHistory.slice(-50);
                    }
                    await this.saveCore(core);
                    break;
                }
            }
        }).catch((error) => {
            logError(`[memory] Failed to record access for ${entryId}: ${toErrorMessage(error)}`);
        });
    }

    /**
     * Convenience: count accesses of a specific type for an entry.
     * Used by maintenance to distinguish passive views from real usage.
     */
    countAccessType(entry: MemoryEntry, type: MemoryAccessType): number {
        return entry.accessHistory?.filter(h => h.type === type).length ?? 0;
    }

    // ── Tier Management ──────────────────────────────────────────────────────

    /** Promote entry to higher tier (lower number) */
    async promoteEntry(entryId: string): Promise<boolean> {
        return this.withLock(async () => {
            const core = this.getCore();
            for (const tierKey of Object.keys(core) as (keyof MemoryCore)[]) {
                const tierEntries = core[tierKey];
                const idx = tierEntries.findIndex(e => e.id === entryId);
                if (idx !== -1 && tierEntries[idx].tier > 0) {
                    const entry = tierEntries.splice(idx, 1)[0];
                    const oldTier = entry.tier;
                    entry.tier = (entry.tier - 1) as 0 | 1 | 2 | 3 | 4 | 5;
                    const newTierKey = `tier_${entry.tier}_${this.getTierName(entry.tier)}` as keyof MemoryCore;
                    core[newTierKey] = [entry, ...core[newTierKey]];
                    
                    // Handle Qdrant transitions
                    await this.handleTierTransition(entry, oldTier, entry.tier);
                    
                    await this.saveCore(core);
                    logInfo(`[memory] Promoted ${entryId} to Tier ${entry.tier}`);
                    return true;
                }
            }
            return false;
        });
    }

    /** Demote entry to lower tier (higher number) */
    async demoteEntry(entryId: string): Promise<boolean> {
        return this.withLock(async () => {
            const core = this.getCore();
            for (const tierKey of Object.keys(core) as (keyof MemoryCore)[]) {
                const tierEntries = core[tierKey];
                const idx = tierEntries.findIndex(e => e.id === entryId);
                if (idx !== -1 && tierEntries[idx].tier < 5) {
                    const entry = tierEntries.splice(idx, 1)[0];
                    const oldTier = entry.tier;
                    entry.tier = (entry.tier + 1) as 0 | 1 | 2 | 3 | 4 | 5;
                    const newTierKey = `tier_${entry.tier}_${this.getTierName(entry.tier)}` as keyof MemoryCore;
                    core[newTierKey] = [entry, ...core[newTierKey]];
                    
                    // Handle Qdrant transitions
                    await this.handleTierTransition(entry, oldTier, entry.tier);
                    
                    await this.saveCore(core);
                    logInfo(`[memory] Demoted ${entryId} to Tier ${entry.tier}`);
                    return true;
                }
            }
            return false;
        });
    }

    /**
     * Tag-based TTL rules for auto-demotion and deletion of stale entries.
     *
     * Categories (matched by tags):
     *  - ephemeral  (auto-compact, session)         → delete after 7 days with 0 search_hits
     *  - discovered (auto-discovery, file-resolution,
     *                stub, template, js-handler,
     *                route, schema, auto-edit)       → demote after 30 days with 0 search_hits
     *  - session-end (session-end, completed)        → demote after 60 days with 0 search_hits
     *  - manual (no matching tags)                   → demote after demotionThresholdDays
     *                                                   with total accessCount < 3 (legacy rule)
     *
     * Returns { demoted, deleted } counts.
     */
    async demoteStaleEntries(daysThreshold?: number): Promise<number> {
        return this.withLock(async () => {
            const manualThreshold = daysThreshold ?? this.config.demotionThresholdDays;
            const now = Date.now();
            const DAY_MS = 86_400_000;

            const core = this.getCore();
            const entriesToDemote: string[] = [];
            const entriesToDelete: string[] = [];

            const daysSince = (iso: string) => (now - new Date(iso).getTime()) / DAY_MS;
            const searchHits = (e: MemoryEntry) =>
                e.accessHistory?.filter(h => h.type === 'search_hit').length ?? 0;

            // Collect decisions (read-only pass — tiers 2-4)
            for (let tier = 2; tier <= 4; tier++) {
                const tierKey = `tier_${tier}_${this.getTierName(tier)}` as keyof MemoryCore;
                for (const entry of core[tierKey]) {
                    const tags = entry.tags ?? [];
                    const age = daysSince(entry.lastAccessed);
                    const hits = searchHits(entry);

                    // Ephemeral: auto-compact / session entries expire fast
                    if (tags.some(t => ['auto-compact', 'session'].includes(t))) {
                        if (age >= 7 && hits === 0) {
                            entriesToDelete.push(entry.id);
                        }
                        continue;
                    }

                    // Discovered: auto-saved file/schema facts — demote if unused
                    if (tags.some(t => ['auto-discovery', 'file-resolution', 'stub', 'template',
                                        'js-handler', 'route', 'schema', 'auto-edit'].includes(t))) {
                        if (age >= 30 && hits === 0) {
                            entriesToDemote.push(entry.id);
                        }
                        continue;
                    }

                    // Session-end summaries — longer lived, demote if not revisited
                    if (tags.some(t => ['session-end', 'completed', 'compaction'].includes(t))) {
                        if (age >= 60 && hits === 0) {
                            entriesToDemote.push(entry.id);
                        }
                        continue;
                    }

                    // Manual / untagged — legacy rule: age + low total access count
                    if (age >= manualThreshold && entry.accessCount < 3) {
                        entriesToDemote.push(entry.id);
                    }
                }
            }

            // Write pass
            let demotedCount = 0;
            let deletedCount = 0;

            for (const id of entriesToDelete) {
                if (await this.deleteEntry(id)) { deletedCount++; }
            }
            for (const id of entriesToDemote) {
                if (await this.demoteEntryInternal(id, core)) { demotedCount++; }
            }

            if (demotedCount > 0 || deletedCount > 0) {
                await this.saveCore(core);
                logInfo(`[memory] Maintenance: demoted=${demotedCount}, deleted=${deletedCount} (ephemeral/stale entries)`);
            }
            return demotedCount + deletedCount;
        });
    }

    /** Automatically promote frequently accessed entries */
    async promoteFrequentEntries(accessThreshold?: number): Promise<number> {
        return this.withLock(async () => {
            const threshold = accessThreshold ?? this.config.promotionAccessCount;
            const core = this.getCore();
            let promotedCount = 0;
            const entriesToPromote: string[] = [];

            // Collect entries to promote (read-only pass)
            for (let tier = 2; tier <= 4; tier++) {
                const tierKey = `tier_${tier}_${this.getTierName(tier)}` as keyof MemoryCore;
                const entries = core[tierKey];
                
                for (const entry of entries) {
                    if (entry.accessCount >= threshold) {
                        entriesToPromote.push(entry.id);
                    }
                }
            }
            
            // Promote collected entries (write pass)
            for (const id of entriesToPromote) {
                if (await this.promoteEntryInternal(id, core)) {
                    promotedCount++;
                }
            }
            
            if (promotedCount > 0) {
                await this.saveCore(core);
                logInfo(`[memory] Auto-promoted ${promotedCount} frequently accessed entries`);
            }
            return promotedCount;
        });
    }

    /**
     * Archive old Tier 3 entries to Tier 5, and prune Tier 5 entries that have
     * been sitting unused long enough to be considered dead weight.
     *
     * Tier 5 pruning threshold: 180 days since lastAccessed with 0 search_hits.
     * Entries that have ever been retrieved via search (search_hit > 0) are kept.
     */
    async archiveOldEntries(daysThreshold?: number): Promise<number> {
        return this.withLock(async () => {
            const threshold = daysThreshold ?? this.config.archiveThresholdDays;
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - threshold);

            const core = this.getCore();
            const tier3Key = 'tier_3_collaboration' as keyof MemoryCore;
            const tier5Key = 'tier_5_archive' as keyof MemoryCore;
            let archivedCount = 0;
            const entriesToArchive: MemoryEntry[] = [];

            // Collect Tier 3 entries old enough to archive (read-only pass)
            for (const entry of core[tier3Key]) {
                const createdAt = new Date(entry.createdAt);
                if (createdAt < cutoffDate) {
                    entriesToArchive.push(entry);
                }
            }

            // Archive collected entries (write pass)
            for (const entry of entriesToArchive) {
                const idx = core[tier3Key].findIndex(e => e.id === entry.id);
                if (idx !== -1) {
                    const [archived] = core[tier3Key].splice(idx, 1);
                    const oldTier = archived.tier;
                    archived.tier = 5;
                    core[tier5Key] = [archived, ...core[tier5Key]];
                    await this.handleTierTransition(archived, oldTier, 5);
                    archivedCount++;
                }
            }

            // ── Tier 5 pruning ────────────────────────────────────────────
            // Delete Tier 5 entries that are very old and have never been
            // retrieved by a real search (search_hit = 0). These are facts
            // the system auto-saved but the agent never found useful enough
            // to reference — safe to remove.
            const PRUNE_DAYS = 180;
            const pruneCutoff = new Date();
            pruneCutoff.setDate(pruneCutoff.getDate() - PRUNE_DAYS);
            const idsToDelete: string[] = [];

            for (const entry of core[tier5Key]) {
                const lastAccess = new Date(entry.lastAccessed);
                const searchHits = entry.accessHistory?.filter(h => h.type === 'search_hit').length ?? 0;
                if (lastAccess < pruneCutoff && searchHits === 0) {
                    idsToDelete.push(entry.id);
                }
            }

            let prunedCount = 0;
            for (const id of idsToDelete) {
                // Remove from in-memory core directly (already inside the lock)
                const idx5 = core[tier5Key].findIndex(e => e.id === id);
                if (idx5 !== -1) {
                    const [removed] = core[tier5Key].splice(idx5, 1);
                    // Clean up Qdrant if present
                    if (this.qdrantClient) {
                        this.qdrantClient.deletePoint(removed.id).catch(() => {});
                    }
                    prunedCount++;
                }
            }

            if (archivedCount > 0 || prunedCount > 0) {
                await this.saveCore(core);
                logInfo(`[memory] archiveOldEntries: archived=${archivedCount} to Tier 5, pruned=${prunedCount} from Tier 5`);
            }
            return archivedCount + prunedCount;
        });
    }

    // ── Context Building ──────────────────────────────────────────────────────

    /**
     * Semantic search across memory tiers using Qdrant.
     * Returns relevant memories based on query similarity.
     */
    async searchMemory(query: string, tier?: number, limit?: number): Promise<MemoryEntry[]> {
        if (!query || !query.trim()) {
            logError('[memory] Search query cannot be empty');
            return [];
        }

        const searchLimit = Math.min(Math.max(1, limit ?? this.config.semanticSearchLimit), 50);

        if (!this.qdrantClient || !this.embeddingService) {
            // Local keyword fallback — search tiers 0-3 by keyword matching
            return this.searchLocal(query, tier, searchLimit);
        }

        try {
            // Generate embedding for the query
            const queryEmbedding = await this.embeddingService.generateEmbedding(query);
            
            // Validate dimensions match Qdrant collection
            const collectionInfo = await this.qdrantClient.getCollectionInfo();
            if (collectionInfo && collectionInfo.vectorSize !== queryEmbedding.length) {
                logError(`[memory] Dimension mismatch: query embedding is ${queryEmbedding.length}D but collection expects ${collectionInfo.vectorSize}D`);
                logError(`[memory] This means the embedding model changed or collection was created with wrong dimensions`);
                logError(`[memory] To fix: Delete the Qdrant collection and restart VS Code to recreate it`);
                return [];
            }
            
            // Validate tier if provided
            if (tier !== undefined && (tier < 0 || tier > 5)) {
                logError(`[memory] Invalid tier: ${tier}`);
                return [];
            }
            
            // Search in Qdrant
            const results = await this.qdrantClient.search(
                queryEmbedding,
                searchLimit,
                tier,
                0.5 // Minimum similarity score
            );
            
            // Convert Qdrant results to MemoryEntry format
            const entries: MemoryEntry[] = results.map(r => ({
                id: r.id,
                tier: r.payload.tier as 0 | 1 | 2 | 3 | 4 | 5,
                content: r.payload.content,
                createdAt: r.payload.createdAt,
                lastAccessed: r.payload.timestamp,
                accessCount: r.payload.accessCount,
                tags: r.payload.tags,
                relevanceScore: r.score
            }));
            
            logInfo(`[memory] Semantic search for "${query}" returned ${entries.length} results`);
            return entries;
        } catch (error) {
            logError(`[memory] Semantic search failed: ${toErrorMessage(error)}`);
            return [];
        }
    }

    /**
     * Build a compact context string for the system prompt.
     * Only includes Tier 0 (critical) always. Tier 1-2 are summarized as a brief list.
     * For detailed recall, the agent should use memory_search or memory_tier_list tools.
     */
    buildContext(tiers: number[], maxTokens?: number): string {
        if (!tiers || tiers.length === 0) {
            return '';
        }
        
        const tokenLimit = Math.max(100, maxTokens ?? this.config.maxContextTokens);
        const core = this.getCoreReadonly();
        let context = '';
        let estimatedTokens = 0;
        
        // Filter and sort valid tiers
        const validTiers = tiers.filter(t => t >= 0 && t <= 5).sort();
        
        for (const tier of validTiers) {
            const tierKey = `tier_${tier}_${this.getTierName(tier)}` as keyof MemoryCore;
            const entries = core[tierKey];
            
            if (entries.length === 0) continue;
            
            if (tier === 0) {
                // Tier 0: always include full content (critical infra)
                const tierHeader = `\n### Critical\n`;
                const headerTokens = Math.ceil(tierHeader.length / 4);
                if (estimatedTokens + headerTokens > tokenLimit) break;
                context += tierHeader;
                estimatedTokens += headerTokens;
                
                for (const entry of entries) {
                    const entryText = `- ${entry.content}\n`;
                    const entryTokens = Math.ceil(entryText.length / 4);
                    if (estimatedTokens + entryTokens > tokenLimit) break;
                    context += entryText;
                    estimatedTokens += entryTokens;
                }
            } else {
                // Tiers 1+: compact summary (just content, no metadata)
                const tierHeader = `\n### ${this.getTierName(tier).charAt(0).toUpperCase() + this.getTierName(tier).slice(1)}\n`;
                const headerTokens = Math.ceil(tierHeader.length / 4);
                if (estimatedTokens + headerTokens > tokenLimit) break;
                context += tierHeader;
                estimatedTokens += headerTokens;
                
                for (const entry of entries) {
                    const entryText = `- ${entry.content}\n`;
                    const entryTokens = Math.ceil(entryText.length / 4);
                    if (estimatedTokens + entryTokens > tokenLimit) break;
                    context += entryText;
                    estimatedTokens += entryTokens;
                }
            }
        }
        
        return context.trim();
    }

    /**
     * Build a minimal context for the system prompt.
     * Only injects Tier 0 (critical infrastructure) — IPs, URLs, ports, paths.
     * All other tiers are accessed on-demand via memory tools (memory_search,
     * memory_tier_list, memory_list) to avoid wasting context window tokens.
     */
    async buildRelevantContext(userMessage: string, maxTokens?: number): Promise<string> {
        const tokenLimit = Math.max(100, maxTokens ?? this.config.maxContextTokens);
        const core = this.getCoreReadonly();
        let context = '';
        let estimatedTokens = 0;

        // Only inject Tier 0 (critical) — small, always relevant
        const tier0 = core.tier_0_critical;
        if (tier0.length > 0) {
            context += '### Critical Infrastructure\n';
            estimatedTokens += 5;
            for (const entry of tier0) {
                const line = `- ${entry.content}\n`;
                const tokens = Math.ceil(line.length / 4);
                if (estimatedTokens + tokens > tokenLimit) break;
                context += line;
                estimatedTokens += tokens;
                this.recordAccess(entry.id, 'passive_load');
            }
        }

        // Inject auto-seeded Tier 1 entries (project info, tech stack, structure) — always small
        const seededEntries = core.tier_1_essential.filter(e => e.tags?.includes('auto-seeded'));
        if (seededEntries.length > 0) {
            context += '\n### Project Context (auto-seeded)\n';
            estimatedTokens += 5;
            for (const entry of seededEntries) {
                const line = `- ${entry.content}\n`;
                const tokens = Math.ceil(line.length / 4);
                if (estimatedTokens + tokens > tokenLimit) { break; }
                context += line;
                estimatedTokens += tokens;
                this.recordAccess(entry.id, 'passive_load');
            }
        }

        // Auto-search remaining tiers using keywords from the user message
        if (userMessage && userMessage.trim()) {
            try {
                // Extract meaningful keywords (skip stopwords, short words)
                const stopwords = new Set(['the','a','an','is','in','on','at','to','for','of','and','or','but','with','this','that','what','how','why','can','we','i','it','be','do','my','our','your','from','by','as','are','was','were','will','would','should','could','have','has','had','not','no','if','so','up','out','its']);
                const keywords = userMessage.toLowerCase()
                    .replace(/[^a-z0-9\s_]/g, ' ')
                    .split(/\s+/)
                    .filter(w => w.length > 3 && !stopwords.has(w))
                    .slice(0, 6); // top 6 keywords

                if (keywords.length > 0) {
                    const searchQuery = keywords.join(' ');
                    const hits = await this.searchMemory(searchQuery, undefined, 5);
                    // Filter out entries already shown (tier 0 and auto-seeded tier 1)
                    const shownIds = new Set([
                        ...core.tier_0_critical.map(e => e.id),
                        ...seededEntries.map(e => e.id),
                    ]);
                    const relevant = hits.filter(e => !shownIds.has(e.id));
                    if (relevant.length > 0) {
                        context += '\n### Relevant Memory\n';
                        for (const entry of relevant) {
                            const line = `- ${entry.content}\n`;
                            const tokens = Math.ceil(line.length / 4);
                            if (estimatedTokens + tokens > tokenLimit) break;
                            context += line;
                            estimatedTokens += tokens;
                            // search_result: surfaced by semantic search into the prompt
                            this.recordAccess(entry.id, 'search_result');
                        }
                    }
                }
            } catch { /* search failure is non-fatal */ }
        }

        return context.trim();
    }

    /**
     * Format all entries from specific tiers as readable text.
     * Used for tool responses (memory_tier_list).
     */
    formatTiers(tiers: number[]): string {
        if (!tiers || tiers.length === 0) {
            return '(no tiers specified)';
        }
        
        const core = this.getCoreReadonly();
        let output = '';
        
        // Filter and sort valid tiers
        const validTiers = tiers.filter(t => t >= 0 && t <= 5).sort();
        
        for (const tier of validTiers) {
            const tierKey = `tier_${tier}_${this.getTierName(tier)}` as keyof MemoryCore;
            const entries = core[tierKey];
            
            if (entries.length === 0) continue;
            
            output += `\n## Tier ${tier}: ${this.getTierName(tier).toUpperCase()}\n\n`;
            
            entries.forEach((entry, i) => {
                const tags = entry.tags && entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
                output += `[${i + 1}] id=${entry.id}${tags} (accessed ${entry.accessCount}x, ${entry.createdAt.slice(0, 10)})\n`;
                output += `${entry.content}\n\n`;
            });
        }
        
        return output.trim() || '(no entries in specified tiers)';
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    private emptyCore(): MemoryCore {
        return {
            tier_0_critical: [],
            tier_1_essential: [],
            tier_2_operational: [],
            tier_3_collaboration: [],
            tier_4_references: [],
            tier_5_archive: []
        };
    }

    /** Read directly from workspaceState (only used for init and cache miss). */
    private readCoreFromStorage(): MemoryCore {
        return this.context.workspaceState.get<MemoryCore>(
            TieredMemoryManager.STORAGE_KEY,
            this.emptyCore()
        );
    }

    /** Get a deep copy of the core for write operations (safe to mutate). */
    private getCore(): MemoryCore {
        if (!this._cachedCore) {
            this._cachedCore = this.readCoreFromStorage();
        }
        return JSON.parse(JSON.stringify(this._cachedCore));
    }

    /** Get a readonly reference to the cached core (no copy — callers must NOT mutate). */
    private getCoreReadonly(): MemoryCore {
        if (!this._cachedCore) {
            this._cachedCore = this.readCoreFromStorage();
        }
        return this._cachedCore;
    }

    private async saveCore(core: MemoryCore): Promise<void> {
        this._cachedCore = JSON.parse(JSON.stringify(core));
        await this.context.workspaceState.update(TieredMemoryManager.STORAGE_KEY, core);
        this.scheduleSyncToFile();
    }

    private getTierName(tier: number): string {
        const names = ['critical', 'essential', 'operational', 'collaboration', 'references', 'archive'];
        return names[tier] || 'unknown';
    }

    // ── Concurrency Control ───────────────────────────────────────────────────

    /** Execute operation with exclusive lock to prevent race conditions */
    private async withLock<T>(operation: () => Promise<T>): Promise<T> {
        const previousLock = this.operationLock;
        let releaseLock: () => void;

        this.operationLock = new Promise<void>(resolve => {
            releaseLock = resolve;
        });

        try {
            // Wait for previous lock with a 10s timeout so a hung background
            // save (e.g. embedding request that never returns) can't block the UI forever.
            await Promise.race([
                previousLock,
                new Promise<void>(resolve => setTimeout(resolve, 10_000))
            ]);
            return await operation();
        } finally {
            releaseLock!();
        }
    }

    /** Internal promote without lock (for use within locked operations) */
    private async promoteEntryInternal(entryId: string, core: MemoryCore): Promise<boolean> {
        for (const tierKey of Object.keys(core) as (keyof MemoryCore)[]) {
            const tierEntries = core[tierKey];
            const idx = tierEntries.findIndex(e => e.id === entryId);
            if (idx !== -1 && tierEntries[idx].tier > 0) {
                const entry = tierEntries.splice(idx, 1)[0];
                const oldTier = entry.tier;
                entry.tier = (entry.tier - 1) as 0 | 1 | 2 | 3 | 4 | 5;
                const newTierKey = `tier_${entry.tier}_${this.getTierName(entry.tier)}` as keyof MemoryCore;
                core[newTierKey] = [entry, ...core[newTierKey]];
                
                await this.handleTierTransition(entry, oldTier, entry.tier);
                return true;
            }
        }
        return false;
    }

    /** Internal demote without lock (for use within locked operations) */
    private async demoteEntryInternal(entryId: string, core: MemoryCore): Promise<boolean> {
        for (const tierKey of Object.keys(core) as (keyof MemoryCore)[]) {
            const tierEntries = core[tierKey];
            const idx = tierEntries.findIndex(e => e.id === entryId);
            if (idx !== -1 && tierEntries[idx].tier < 5) {
                const entry = tierEntries.splice(idx, 1)[0];
                const oldTier = entry.tier;
                entry.tier = (entry.tier + 1) as 0 | 1 | 2 | 3 | 4 | 5;
                const newTierKey = `tier_${entry.tier}_${this.getTierName(entry.tier)}` as keyof MemoryCore;
                core[newTierKey] = [entry, ...core[newTierKey]];
                
                await this.handleTierTransition(entry, oldTier, entry.tier);
                return true;
            }
        }
        return false;
    }

    /** Handle Qdrant storage transitions when moving between tiers */
    private async handleTierTransition(entry: MemoryEntry, oldTier: number, newTier: number): Promise<void> {
        if (!this.qdrantClient || !this.embeddingService) {
            return;
        }
        
        const oldInQdrant = oldTier === 4 || oldTier === 5;
        const newInQdrant = newTier === 4 || newTier === 5;
        
        try {
            if (oldInQdrant && !newInQdrant) {
                // Moving from Qdrant to local storage - delete from Qdrant
                await this.qdrantClient.deletePoint(entry.id);
                logInfo(`[memory] Removed ${entry.id} from Qdrant (Tier ${oldTier} → ${newTier})`);
            } else if (!oldInQdrant && newInQdrant) {
                // Moving from local storage to Qdrant - add to Qdrant
                const embedding = await this.embeddingService.generateEmbedding(entry.content);
                const workspaceName = vscode.workspace.name || 'default';
                await this.qdrantClient.upsertPoint({
                    id: entry.id,
                    vector: embedding,
                    payload: {
                        memoryId: entry.id,
                        content: entry.content,
                        tier: newTier,
                        tags: entry.tags,
                        timestamp: entry.lastAccessed,
                        workspaceId: workspaceName,
                        createdAt: entry.createdAt,
                        accessCount: entry.accessCount
                    }
                });
                logInfo(`[memory] Added ${entry.id} to Qdrant (Tier ${oldTier} → ${newTier})`);
            } else if (oldInQdrant && newInQdrant) {
                // Moving within Qdrant tiers - update tier in payload
                const embedding = await this.embeddingService.generateEmbedding(entry.content);
                const workspaceName = vscode.workspace.name || 'default';
                await this.qdrantClient.upsertPoint({
                    id: entry.id,
                    vector: embedding,
                    payload: {
                        memoryId: entry.id,
                        content: entry.content,
                        tier: newTier,
                        tags: entry.tags,
                        timestamp: entry.lastAccessed,
                        workspaceId: workspaceName,
                        createdAt: entry.createdAt,
                        accessCount: entry.accessCount
                    }
                });
            }
        } catch (error) {
            logError(`[memory] Failed to handle tier transition: ${toErrorMessage(error)}`);
        }
    }

    // ── Semantic Deduplication ─────────────────────────────────────────────────

    /**
     * Check if content is semantically similar to any existing memory entry.
     * Used by doc scanner to avoid saving near-duplicate facts.
     * Returns false (not duplicate) if Qdrant/embeddings are unavailable.
     */
    async isSemanticDuplicate(content: string, threshold: number = 0.85): Promise<boolean> {
        if (!this.qdrantClient || !this.embeddingService) {
            return false;
        }
        try {
            const embedding = await this.embeddingService.generateEmbedding(content);
            const results = await this.qdrantClient.search(embedding, 1, undefined, threshold);
            return results.length > 0;
        } catch (error) {
            logWarn(`[memory] Semantic dedup check failed (skipping): ${toErrorMessage(error)}`);
            return false;
        }
    }

    /**
     * Index a memory entry into Qdrant for semantic search.
     * Used after addEntry() for tiers 0-3 so that subsequent
     * isSemanticDuplicate() calls can find them during batch operations.
     */
    async indexForSearch(entry: { id: string; tier: number; content: string; tags?: string[] }): Promise<void> {
        if (!this.qdrantClient || !this.embeddingService) { return; }
        try {
            const embedding = await this.embeddingService.generateEmbedding(entry.content);
            const workspaceName = vscode.workspace.name || 'default';
            await this.qdrantClient.upsertPoint({
                id: entry.id,
                vector: embedding,
                payload: {
                    memoryId: entry.id,
                    content: entry.content,
                    tier: entry.tier,
                    tags: entry.tags,
                    timestamp: new Date().toISOString(),
                    workspaceId: workspaceName,
                    createdAt: new Date().toISOString(),
                    accessCount: 0
                }
            });
        } catch (error) {
            logWarn(`[memory] Failed to index for search: ${toErrorMessage(error)}`);
        }
    }

    // ── Statistics ────────────────────────────────────────────────────────────

    /** Get memory statistics for all tiers */
    getStats(): { tier: number; name: string; count: number; tokens: number; totalAccesses: number }[] {
        const core = this.getCoreReadonly();
        const stats = [];
        
        for (let tier = 0; tier <= 5; tier++) {
            const tierKey = `tier_${tier}_${this.getTierName(tier)}` as keyof MemoryCore;
            const entries = core[tierKey];
            const tokens = entries.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);
            const totalAccesses = entries.reduce((sum, e) => sum + e.accessCount, 0);
            
            stats.push({
                tier,
                name: this.getTierName(tier),
                count: entries.length,
                tokens,
                totalAccesses
            });
        }
        
        return stats;
    }

    /**
     * Local keyword search across tiers 0-3 (fallback when Qdrant unavailable).
     * Scores entries by how many query words appear in the content.
     */
    private searchLocal(query: string, tier?: number, limit: number = 5): MemoryEntry[] {
        const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        if (words.length === 0) { return []; }

        const core = this.getCoreReadonly();
        const tiersToSearch: Array<keyof MemoryCore> = tier !== undefined
            ? [`tier_${tier}_${this.getTierName(tier as 0|1|2|3|4|5)}` as keyof MemoryCore]
            : ['tier_0_critical', 'tier_1_essential', 'tier_2_operational', 'tier_3_collaboration'];

        const scored: Array<{ entry: MemoryEntry; score: number }> = [];
        for (const key of tiersToSearch) {
            const entries = core[key] as MemoryEntry[];
            for (const entry of entries) {
                const text = entry.content.toLowerCase();
                const matches = words.filter(w => text.includes(w)).length;
                if (matches > 0) {
                    scored.push({ entry: { ...entry, relevanceScore: matches / words.length }, score: matches });
                }
            }
        }

        scored.sort((a, b) => b.score - a.score);
        logInfo(`[memory] Local keyword search for "${query}" returned ${scored.length} results`);
        return scored.slice(0, limit).map(s => s.entry);
    }

    /**
     * Seed project memory from the workspace on first activation.
     * Scans key files to extract tech stack, entry points, and structure.
     * Only runs once per workspace (tracked via a seeded flag in Tier 0 tags).
     * Seeds go to Tier 1 (essential) — NOT injected into the system prompt automatically.
     */
    async seedProjectMemory(workspaceRoot: string): Promise<void> {
        // Check if already seeded — read from JSON file directly to avoid stale workspaceState
        // Re-seed if ARCHITECTURE.md is newer than the last seed (catches regenerated architecture docs)
        const filePath = this.getMemoryFilePath();
        let alreadySeeded = false;
        let seededAt = 0;
        if (filePath && fs.existsSync(filePath)) {
            try {
                const raw = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(raw) as MemoryFileFormat;
                const seedEntry = (data.tiers?.tier_1_essential || []).find(e => e.tags?.includes('auto-seeded'));
                if (seedEntry) {
                    alreadySeeded = true;
                    seededAt = new Date(seedEntry.createdAt).getTime();
                }
            } catch { /* ignore parse errors — will re-seed */ }
        }
        // Check if ARCHITECTURE.md is newer than the last seed
        if (alreadySeeded) {
            try {
                const archPath = path.join(workspaceRoot, 'ARCHITECTURE.md');
                const archStat = fs.statSync(archPath);
                if (archStat.mtimeMs > seededAt) {
                    logInfo('[memory] ARCHITECTURE.md updated since last seed — re-seeding');
                    alreadySeeded = false;
                }
            } catch { /* no ARCHITECTURE.md — use existing seed */ }
        }
        if (alreadySeeded) {
            logInfo('[memory] Project memory already seeded — skipping');
            return;
        }

        logInfo('[memory] Seeding project memory from workspace...');
        const seeds: Array<{ content: string; tags: string[] }> = [];

        const tryRead = (rel: string): string | null => {
            try {
                const p = path.join(workspaceRoot, rel);
                if (fs.existsSync(p)) { return fs.readFileSync(p, 'utf8').slice(0, 8000); }
            } catch { /* ignore */ }
            return null;
        };

        // ── Tech stack from package.json ────────────────────────────────────
        const pkg = tryRead('package.json');
        if (pkg) {
            try {
                const parsed = JSON.parse(pkg);
                const deps = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies });
                const frameworks = deps.filter(d =>
                    /flask|django|express|fastapi|react|vue|angular|next|nest|spring|rails|laravel/i.test(d)
                ).slice(0, 10);
                if (frameworks.length) {
                    seeds.push({ content: `JS/TS frameworks and libraries: ${frameworks.join(', ')}`, tags: ['auto-seeded', 'tech-stack'] });
                }
                if (parsed.name) {
                    seeds.push({ content: `Project name: ${parsed.name}${parsed.description ? `. ${parsed.description}` : ''}`, tags: ['auto-seeded', 'project-info'] });
                }
            } catch { /* ignore */ }
        }

        // ── Tech stack from requirements.txt / pyproject.toml ───────────────
        const reqs = tryRead('requirements.txt') || tryRead('requirements/base.txt');
        if (reqs) {
            const pyDeps = reqs.split('\n')
                .map(l => l.split(/[=<>!~]/)[0].trim().toLowerCase())
                .filter(l => l && !l.startsWith('#') && l.length > 1)
                .slice(0, 30);
            const frameworks = pyDeps.filter(d =>
                /flask|django|fastapi|sqlalchemy|celery|redis|postgres|pymongo|pydantic|aiohttp/i.test(d)
            );
            if (frameworks.length) {
                seeds.push({ content: `Python frameworks and libraries: ${frameworks.join(', ')}`, tags: ['auto-seeded', 'tech-stack'] });
            }
            if (pyDeps.length) {
                seeds.push({ content: `Python dependencies (${pyDeps.length} total): ${pyDeps.slice(0, 15).join(', ')}`, tags: ['auto-seeded', 'dependencies'] });
            }
        }

        // ── Project structure from README ────────────────────────────────────
        const readme = tryRead('README.md') || tryRead('README.rst');
        if (readme) {
            const firstPara = readme.split(/\n\n/)[0].replace(/[#*`]/g, '').trim().slice(0, 300);
            if (firstPara.length > 30) {
                seeds.push({ content: `Project description (from README): ${firstPara}`, tags: ['auto-seeded', 'project-info'] });
            }
        }

        // ── Entry points from common patterns ───────────────────────────────
        const entryPoints: string[] = [];
        for (const candidate of ['app.py', 'main.py', 'run.py', 'server.py', 'wsgi.py', 'manage.py', 'index.ts', 'index.js', 'src/main.ts', 'src/index.ts']) {
            if (fs.existsSync(path.join(workspaceRoot, candidate))) {
                entryPoints.push(candidate);
            }
        }
        if (entryPoints.length) {
            seeds.push({ content: `Entry points: ${entryPoints.join(', ')}`, tags: ['auto-seeded', 'structure'] });
        }

        // ── App structure (top-level dirs) ───────────────────────────────────
        try {
            const topDirs = fs.readdirSync(workspaceRoot, { withFileTypes: true })
                .filter(d => d.isDirectory() && !d.name.startsWith('.') && !['node_modules', '__pycache__', 'dist', 'build', 'venv', '.venv'].includes(d.name))
                .map(d => d.name)
                .slice(0, 12);
            if (topDirs.length) {
                seeds.push({ content: `Top-level directories: ${topDirs.join(', ')}`, tags: ['auto-seeded', 'structure'] });
            }
        } catch { /* ignore */ }

        // ── Config / environment hints ───────────────────────────────────────
        const configFile = tryRead('config/settings.py') || tryRead('config.py') || tryRead('.env.example');
        if (configFile) {
            const dbLine = configFile.match(/(?:DATABASE_URL|SQLALCHEMY_DATABASE_URI|DB_HOST)\s*[=:]\s*([^\n]{0,80})/)?.[1]?.trim();
            if (dbLine && !dbLine.includes('secret') && !dbLine.includes('password')) {
                seeds.push({ content: `Database config hint: ${dbLine}`, tags: ['auto-seeded', 'config'] });
            }
        }

        // ── Security / PII utilities ─────────────────────────────────────────
        const securityFiles: string[] = [];
        const securityPatterns = [
            'app/utils/pii_encryption.py', 'app/utils/secure_photo_storage.py',
            'app/utils/log_sanitizer.py', 'app/utils/security.py',
            'app/utils/compliance_validator.py', 'app/utils/secure_file_helper.py',
            'app/services/nj_compliance_service.py', 'app/routes/pii_admin.py',
            'app/utils/encryption.py', 'app/utils/pii_audit.py',
        ];
        for (const f of securityPatterns) {
            if (fs.existsSync(path.join(workspaceRoot, f))) { securityFiles.push(f); }
        }
        if (securityFiles.length) {
            seeds.push({ content: `Security/PII utility files: ${securityFiles.join(', ')}`, tags: ['auto-seeded', 'security'] });
        }

        // ── Key model files ──────────────────────────────────────────────────
        const modelFiles: string[] = [];
        for (const f of ['app/models/customer.py', 'app/models/transaction.py', 'app/models/user.py']) {
            if (fs.existsSync(path.join(workspaceRoot, f))) { modelFiles.push(f); }
        }
        if (modelFiles.length) {
            seeds.push({ content: `Key model files: ${modelFiles.join(', ')}`, tags: ['auto-seeded', 'structure'] });
        }

        // ── Docs available ───────────────────────────────────────────────────
        const docsDir = path.join(workspaceRoot, 'docs');
        if (fs.existsSync(docsDir)) {
            try {
                const docFiles = fs.readdirSync(docsDir)
                    .filter(f => f.endsWith('.md') || f.endsWith('.rst'))
                    .slice(0, 10);
                if (docFiles.length) {
                    seeds.push({ content: `Documentation files in docs/: ${docFiles.join(', ')}`, tags: ['auto-seeded', 'docs'] });
                }
            } catch { /* ignore */ }
        }

        // ── ARCHITECTURE.md (auto-generated project structure briefing) ─────
        // Seed the full content into Tier 1 so every session starts with
        // a complete structural picture without needing memory_search.
        const archContent = tryRead('ARCHITECTURE.md');
        if (archContent) {
            seeds.push({
                content: `Project architecture (from ARCHITECTURE.md):\n${archContent.slice(0, 3000)}`,
                tags: ['auto-seeded', 'architecture', 'structure'],
            });
            logInfo('[memory] Seeding ARCHITECTURE.md into Tier 1');
        }

        // Write all seeds to Tier 1 (essential — available via memory_search, not auto-injected)
        let saved = 0;
        for (const seed of seeds) {
            try {
                await this.addEntry(1, seed.content, seed.tags);
                saved++;
            } catch { /* ignore individual failures */ }
        }

        logInfo(`[memory] Project seed complete — saved ${saved} entries to Tier 1`);
    }
}
