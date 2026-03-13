import * as vscode from 'vscode';
import { getConfig } from './config';

export interface MemoryConfig {
    enabled: boolean;
    qdrantUrl: string;
    embeddingUrl: string;
    embeddingModel: string;
    autoLoadTiers: number[];
    demotionThresholdDays: number;
    promotionAccessCount: number;
    archiveThresholdDays: number;
    maxContextTokens: number;
    semanticSearchLimit: number;
    fallbackToLocal: boolean;
}

/**
 * Get memory configuration with smart URL resolution.
 * 
 * Qdrant URL priority:
 * 1. ollamaAgent.memory.qdrantUrl (if set)
 * 2. ollamaAgent.memory.qdrantHost + qdrantPort (if host set)
 * 3. Ollama host + qdrantPort (default - co-located)
 * 
 * Embedding URL priority:
 * 1. ollamaAgent.memory.embeddingUrl (if set)
 * 2. Ollama baseUrl (default)
 */
export function getMemoryConfig(): MemoryConfig {
    const config = vscode.workspace.getConfiguration('ollamaAgent');
    const ollamaConfig = getConfig();
    
    // Resolve Qdrant URL with priority logic
    let qdrantUrl = config.get<string>('memory.qdrantUrl', '').trim();
    if (!qdrantUrl) {
        const qdrantHost = config.get<string>('memory.qdrantHost', '').trim();
        const qdrantPort = config.get<number>('memory.qdrantPort', 6333);
        
        if (qdrantHost) {
            // Use custom Qdrant host
            qdrantUrl = `http://${qdrantHost}:${qdrantPort}`;
        } else {
            // Use Ollama host (default co-location)
            try {
                const ollamaUrl = new URL(
                    ollamaConfig.baseUrl || `http://${ollamaConfig.host}:${ollamaConfig.port}`
                );
                qdrantUrl = `http://${ollamaUrl.hostname}:${qdrantPort}`;
            } catch {
                // Fallback if URL parsing fails
                qdrantUrl = `http://${ollamaConfig.host}:${qdrantPort}`;
            }
        }
    }
    
    // Resolve Embedding URL
    const embeddingUrl = config.get<string>('memory.embeddingUrl', '').trim() 
        || ollamaConfig.baseUrl 
        || `http://${ollamaConfig.host}:${ollamaConfig.port}`;
    
    return {
        enabled: config.get<boolean>('memory.enabled', true),
        qdrantUrl,
        embeddingUrl,
        embeddingModel: config.get<string>('memory.embeddingModel', 'nomic-embed-text'),
        autoLoadTiers: config.get<number[]>('memory.autoLoadTiers', [0, 1, 2]),
        demotionThresholdDays: config.get<number>('memory.demotionThresholdDays', 30),
        promotionAccessCount: config.get<number>('memory.promotionAccessCount', 5),
        archiveThresholdDays: config.get<number>('memory.archiveThresholdDays', 90),
        maxContextTokens: config.get<number>('memory.maxContextTokens', 4000),
        semanticSearchLimit: config.get<number>('memory.semanticSearchLimit', 5),
        fallbackToLocal: config.get<boolean>('memory.fallbackToLocal', true)
    };
}
