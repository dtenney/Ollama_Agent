import axios from 'axios';
import { logInfo, logError } from './logger';
import { MemoryConfig } from './memoryConfig';

/** LRU cache entry */
interface CacheEntry {
    vector: number[];
    lastUsed: number;
}

/**
 * Service for generating embeddings using Ollama.
 * Used for semantic search in tiered memory system.
 *
 * Includes an in-process LRU cache keyed by SHA-256 of the input text.
 * The same content string (e.g. repeated isSemanticDuplicate calls on
 * identical memory entries) will never hit Ollama more than once per session.
 */
export class EmbeddingService {
    private readonly ollamaUrl: string;
    private readonly model: string;
    private cachedDimension: number | null = null;

    /** In-process LRU embedding cache: SHA-256(text) → vector */
    private readonly _embeddingCache = new Map<string, CacheEntry>();
    private static readonly CACHE_MAX = 256;

    constructor(config: MemoryConfig) {
        this.ollamaUrl = config.embeddingUrl;
        this.model = config.embeddingModel;
    }

    /** Fast djb2 hash of text. Used as cache key — collision probability negligible at 256-entry scale. */
    private static hashText(text: string): string {
        let h = 5381;
        for (let i = 0; i < text.length; i++) {
            h = ((h << 5) + h) ^ text.charCodeAt(i);
            h = h >>> 0; // keep 32-bit unsigned
        }
        return h.toString(36) + '_' + text.length.toString(36);
    }

    /** Evict the least-recently-used entry when cache is full. */
    private evictLRU(): void {
        let oldest = Infinity;
        let oldestKey = '';
        for (const [k, v] of this._embeddingCache) {
            if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
        }
        if (oldestKey) { this._embeddingCache.delete(oldestKey); }
    }

    /** Expose cache stats for logging / tests. */
    getCacheStats(): { size: number; max: number } {
        return { size: this._embeddingCache.size, max: EmbeddingService.CACHE_MAX };
    }

    /**
     * Generate embedding vector for a single text string.
     * Returns a cached vector if the same text was seen this session.
     * Automatically detects and caches the dimension size.
     */
    async generateEmbedding(text: string): Promise<number[]> {
        if (!text || !text.trim()) {
            throw new Error('Cannot generate embedding for empty text');
        }

        // Truncate very long texts to prevent API issues
        const maxLength = 8000;
        const truncated = text.length > maxLength ? text.slice(0, maxLength) : text;

        // Check in-process cache first
        const key = EmbeddingService.hashText(truncated);
        const cached = this._embeddingCache.get(key);
        if (cached) {
            cached.lastUsed = Date.now();
            return cached.vector;
        }

        try {
            const response = await axios.post(
                `${this.ollamaUrl}/api/embeddings`,
                {
                    model: this.model,
                    prompt: truncated
                },
                {
                    timeout: 30000 // 30 second timeout
                }
            );

            if (!response.data || !response.data.embedding) {
                throw new Error('Invalid response from Ollama embeddings API');
            }
            
            if (!Array.isArray(response.data.embedding) || response.data.embedding.length === 0) {
                throw new Error('Embedding response is not a valid array');
            }

            // Cache the actual dimension on first call
            if (this.cachedDimension === null) {
                this.cachedDimension = response.data.embedding.length;
                logInfo(`[embedding] Detected dimension: ${this.cachedDimension} for model ${this.model}`);
            } else if (this.cachedDimension !== response.data.embedding.length) {
                logError(`[embedding] Dimension mismatch: expected ${this.cachedDimension}, got ${response.data.embedding.length}`);
            }

            // Store in LRU cache
            if (this._embeddingCache.size >= EmbeddingService.CACHE_MAX) { this.evictLRU(); }
            this._embeddingCache.set(key, { vector: response.data.embedding, lastUsed: Date.now() });

            return response.data.embedding;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.code === 'ECONNREFUSED') {
                    throw new Error(`Ollama not reachable at ${this.ollamaUrl}`);
                }
                if (error.response?.status === 404) {
                    throw new Error(`Embedding model '${this.model}' not found. Run: ollama pull ${this.model}`);
                }
                if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
                    throw new Error(`Embedding request timed out after 30s`);
                }
                throw new Error(`Ollama embeddings error: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Generate embeddings for multiple texts in batch.
     * More efficient than calling generateEmbedding multiple times.
     */
    async generateEmbeddings(texts: string[]): Promise<number[][]> {
        const embeddings: number[][] = [];
        
        // Process in batches to avoid overwhelming Ollama
        const batchSize = 5;
        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            const batchEmbeddings = await Promise.all(
                batch.map(text => this.generateEmbedding(text))
            );
            embeddings.push(...batchEmbeddings);
        }
        
        return embeddings;
    }

    /**
     * Get the dimension size of embeddings for this model.
     * Returns cached dimension if available, otherwise returns default.
     * Used for Qdrant collection configuration.
     */
    getEmbeddingDimension(): number {
        // Return cached dimension if we've generated embeddings
        if (this.cachedDimension !== null) {
            return this.cachedDimension;
        }
        
        // Known dimensions for common models
        const dimensions: Record<string, number> = {
            'nomic-embed-text': 768,
            'nomic-embed-text:latest': 768,
            'mxbai-embed-large': 1024,
            'all-minilm': 384,
        };

        return dimensions[this.model] || 768; // Default to 768 (nomic-embed-text v1.5+)
    }
    
    /**
     * Validate that embedding dimensions match expected dimensions.
     * Call this after generating first embedding to ensure compatibility.
     */
    validateDimensions(expectedDimension: number): boolean {
        if (this.cachedDimension === null) {
            logError('[embedding] Cannot validate dimensions: no embeddings generated yet');
            return false;
        }
        
        if (this.cachedDimension !== expectedDimension) {
            logError(`[embedding] Dimension mismatch: model produces ${this.cachedDimension}D vectors but ${expectedDimension}D expected`);
            logError(`[embedding] This usually means the Qdrant collection was created with wrong dimensions`);
            logError(`[embedding] Solution: Delete the collection and let it be recreated with correct dimensions`);
            return false;
        }
        
        return true;
    }
}
