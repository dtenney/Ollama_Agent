import axios, { AxiosInstance } from 'axios';
import { logInfo, logError } from './logger';
import { MemoryConfig } from './memoryConfig';

export interface QdrantPoint {
    id: string;
    vector: number[];
    payload: {
        content: string;
        tier: number;
        tags?: string[];
        timestamp: string;
        workspaceId: string;
        createdAt: string;
        accessCount: number;
    };
}

export interface QdrantSearchResult {
    id: string;
    score: number;
    payload: QdrantPoint['payload'];
}

/**
 * Client for interacting with Qdrant vector database.
 * Used for semantic search in Tiers 4-5 of the memory system.
 */
export class QdrantClient {
    private client: AxiosInstance;
    private collectionName: string;
    private vectorSize: number;

    constructor(config: MemoryConfig, workspaceName: string, vectorSize: number = 384) {
        this.client = axios.create({
            baseURL: config.qdrantUrl,
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // Sanitize workspace name for collection naming
        this.collectionName = `ollamapilot_${workspaceName.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
        this.vectorSize = vectorSize;
    }

    /**
     * Initialize the Qdrant collection.
     * Creates collection if it doesn't exist.
     */
    async initialize(): Promise<void> {
        try {
            const exists = await this.collectionExists();
            if (!exists) {
                await this.createCollection();
            }
            logInfo(`[qdrant] Connected to collection: ${this.collectionName}`);
        } catch (error) {
            logError(`[qdrant] Initialization failed: ${error}`);
            throw error;
        }
    }

    /**
     * Check if the collection exists.
     */
    async collectionExists(): Promise<boolean> {
        try {
            await this.client.get(`/collections/${this.collectionName}`);
            return true;
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                return false;
            }
            throw error;
        }
    }

    /**
     * Create a new collection with vector configuration.
     */
    async createCollection(): Promise<void> {
        try {
            await this.client.put(`/collections/${this.collectionName}`, {
                vectors: {
                    size: this.vectorSize,
                    distance: 'Cosine'
                },
                optimizers_config: {
                    default_segment_number: 2
                }
            });
            logInfo(`[qdrant] Created collection: ${this.collectionName} (${this.vectorSize}d vectors)`);
        } catch (error) {
            if (axios.isAxiosError(error)) {
                throw new Error(`Failed to create Qdrant collection: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Insert or update a point in the collection.
     */
    async upsertPoint(point: QdrantPoint): Promise<void> {
        try {
            await this.client.put(`/collections/${this.collectionName}/points`, {
                points: [point]
            });
        } catch (error) {
            if (axios.isAxiosError(error)) {
                throw new Error(`Failed to upsert point: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Insert or update multiple points in batch.
     */
    async upsertPoints(points: QdrantPoint[]): Promise<void> {
        if (points.length === 0) return;

        try {
            // Batch in groups of 100 to avoid overwhelming Qdrant
            const batchSize = 100;
            for (let i = 0; i < points.length; i += batchSize) {
                const batch = points.slice(i, i + batchSize);
                await this.client.put(`/collections/${this.collectionName}/points`, {
                    points: batch
                });
            }
            logInfo(`[qdrant] Upserted ${points.length} points`);
        } catch (error) {
            if (axios.isAxiosError(error)) {
                throw new Error(`Failed to upsert points: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Search for similar vectors using semantic similarity.
     */
    async search(
        queryVector: number[],
        limit: number = 5,
        tier?: number,
        minScore: number = 0.5
    ): Promise<QdrantSearchResult[]> {
        if (!queryVector || queryVector.length === 0) {
            throw new Error('Query vector cannot be empty');
        }
        
        if (queryVector.length !== this.vectorSize) {
            throw new Error(`Query vector dimension (${queryVector.length}) does not match collection dimension (${this.vectorSize})`);
        }
        
        const safeLimit = Math.min(Math.max(1, limit), 100);
        const safeMinScore = Math.min(Math.max(0, minScore), 1);
        
        try {
            // Build filter for tier if specified
            const filter = tier !== undefined ? {
                must: [
                    { key: 'tier', match: { value: tier } }
                ]
            } : undefined;

            const response = await this.client.post(`/collections/${this.collectionName}/points/search`, {
                vector: queryVector,
                limit: safeLimit,
                filter,
                with_payload: true,
                score_threshold: safeMinScore
            });

            if (!response.data || !response.data.result) {
                return [];
            }

            return response.data.result.map((r: any) => ({
                id: r.id,
                score: r.score,
                payload: r.payload
            }));
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.response?.status === 404) {
                    // Collection doesn't exist yet
                    return [];
                }
                throw new Error(`Qdrant search failed: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Delete a point by ID.
     */
    async deletePoint(id: string): Promise<void> {
        try {
            await this.client.post(`/collections/${this.collectionName}/points/delete`, {
                points: [id]
            });
        } catch (error) {
            if (axios.isAxiosError(error)) {
                throw new Error(`Failed to delete point: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Delete multiple points by ID.
     */
    async deletePoints(ids: string[]): Promise<void> {
        if (ids.length === 0) return;

        try {
            await this.client.post(`/collections/${this.collectionName}/points/delete`, {
                points: ids
            });
            logInfo(`[qdrant] Deleted ${ids.length} points`);
        } catch (error) {
            if (axios.isAxiosError(error)) {
                throw new Error(`Failed to delete points: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Get collection info and statistics.
     * Returns null if collection doesn't exist.
     */
    async getCollectionInfo(): Promise<{ vectorSize: number; pointsCount: number } | null> {
        try {
            const response = await this.client.get(`/collections/${this.collectionName}`);
            const result = response.data.result;
            return {
                vectorSize: result.config?.params?.vectors?.size || this.vectorSize,
                pointsCount: result.points_count || 0
            };
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Delete the entire collection.
     * Use with caution - this removes all stored vectors.
     */
    async deleteCollection(): Promise<void> {
        try {
            await this.client.delete(`/collections/${this.collectionName}`);
            logInfo(`[qdrant] Deleted collection: ${this.collectionName}`);
        } catch (error) {
            if (axios.isAxiosError(error)) {
                throw new Error(`Failed to delete collection: ${error.message}`);
            }
            throw error;
        }
    }
}
