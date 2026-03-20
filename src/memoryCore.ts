import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logError, logWarn, toErrorMessage } from './logger';
import { MemoryConfig } from './memoryConfig';
import { QdrantClient, QdrantPoint } from './qdrantClient';
import { EmbeddingService } from './embeddingService';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
    id: string;
    tier: 0 | 1 | 2 | 3 | 4 | 5;
    content: string;
    createdAt: string;
    lastAccessed: string;
    accessCount: number;
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

    /** Record access to an entry (increments count, updates timestamp) */
    recordAccess(entryId: string): void {
        // Non-blocking access tracking - fire and forget
        this.withLock(async () => {
            const core = this.getCore();
            for (const tierKey of Object.keys(core) as (keyof MemoryCore)[]) {
                const entry = core[tierKey].find(e => e.id === entryId);
                if (entry) {
                    entry.lastAccessed = new Date().toISOString();
                    entry.accessCount++;
                    await this.saveCore(core);
                    break;
                }
            }
        }).catch((error) => {
            logError(`[memory] Failed to record access for ${entryId}: ${toErrorMessage(error)}`);
        });
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

    /** Automatically demote stale entries from Tier 2-4 */
    async demoteStaleEntries(daysThreshold?: number): Promise<number> {
        return this.withLock(async () => {
            const threshold = daysThreshold ?? this.config.demotionThresholdDays;
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - threshold);
            
            const core = this.getCore();
            let demotedCount = 0;
            const entriesToDemote: string[] = [];

            // Collect entries to demote (read-only pass)
            for (let tier = 2; tier <= 4; tier++) {
                const tierKey = `tier_${tier}_${this.getTierName(tier)}` as keyof MemoryCore;
                const entries = core[tierKey];
                
                for (const entry of entries) {
                    const lastAccess = new Date(entry.lastAccessed);
                    if (lastAccess < cutoffDate && entry.accessCount < 3) {
                        entriesToDemote.push(entry.id);
                    }
                }
            }
            
            // Demote collected entries (write pass)
            for (const id of entriesToDemote) {
                if (await this.demoteEntryInternal(id, core)) {
                    demotedCount++;
                }
            }
            
            if (demotedCount > 0) {
                await this.saveCore(core);
                logInfo(`[memory] Auto-demoted ${demotedCount} stale entries`);
            }
            return demotedCount;
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

    /** Archive old Tier 3 entries to Tier 5 */
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

            // Collect entries to archive (read-only pass)
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
                    
                    // Handle Qdrant transition (Tier 3 → Tier 5)
                    await this.handleTierTransition(archived, oldTier, 5);
                    
                    archivedCount++;
                }
            }
            
            if (archivedCount > 0) {
                await this.saveCore(core);
                logInfo(`[memory] Archived ${archivedCount} old entries to Tier 5`);
            }
            return archivedCount;
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
            logError('[memory] Semantic search unavailable: Qdrant or embedding service not initialized');
            return [];
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
            }
        }

        // Add a summary of what's available (not the content itself)
        const stats = this.getStats();
        const totalEntries = stats.reduce((s, t) => s + t.count, 0);
        const nonCriticalEntries = totalEntries - (core.tier_0_critical?.length || 0);
        if (nonCriticalEntries > 0) {
            const tierSummary = stats
                .filter(s => s.tier > 0 && s.count > 0)
                .map(s => `T${s.tier}(${s.name}): ${s.count}`)
                .join(', ');
            context += `\n### Memory Available (use memory_search or memory_tier_list to access)\n`;
            context += `${nonCriticalEntries} entries across tiers: ${tierSummary}\n`;
            context += `Call memory_search("<topic>") to find relevant memories before answering project-specific questions.\n`;
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
            await previousLock;
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
}
