/**
 * Context calculator for monitoring token usage and model limits.
 * Provides utilities for estimating context size and determining when to compact.
 */

import { OllamaMessage } from './ollamaClient';
import { logInfo, logWarn, logError } from './logger';

/** Message overhead tokens for role and structure */
const MESSAGE_OVERHEAD_TOKENS = 10;

/** Known model context windows (in tokens) */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
    // Llama models
    'llama2': 4096,
    'llama2:7b': 4096,
    'llama2:13b': 4096,
    'llama3': 8192,
    'llama3:8b': 8192,
    'llama3.1': 128000,
    'llama3.1:8b': 128000,
    'llama3.2': 128000,
    'llama3.2:3b': 128000,
    
    // Qwen models
    'qwen': 8192,
    'qwen:7b': 8192,
    'qwen2': 32768,
    'qwen2:7b': 32768,
    'qwen2.5': 32768,
    'qwen2.5:7b': 32768,
    'qwen2.5-coder': 32768,
    'qwen2.5-coder:7b': 32768,
    'qwen2.5-coder:7b-256k': 262144,
    
    // Phi models
    'phi': 2048,
    'phi3': 4096,
    'phi3:mini': 4096,
    'phi3:medium': 4096,
    
    // Mistral models
    'mistral': 8192,
    'mistral:7b': 8192,
    'mixtral': 32768,
    'mixtral:8x7b': 32768,
    
    // CodeLlama models
    'codellama': 16384,
    'codellama:7b': 16384,
    'codellama:13b': 16384,
    
    // DeepSeek models
    'deepseek-coder': 16384,
    'deepseek-coder:6.7b': 16384,
    'deepseek-r1': 65536,
    'deepseek-r1:8b': 65536,
    'deepseek-r1:32b': 65536,
    
    // Gemma models
    'gemma': 8192,
    'gemma:7b': 8192,
    'gemma2': 8192,
    'gemma2:9b': 8192,
};

/** Default context limit for unknown models */
const DEFAULT_CONTEXT_LIMIT = 8192;

/**
 * Get the context window size for a given model.
 * Returns the known limit or a safe default.
 */
export function getModelContextLimit(model: string): number {
    // Normalize to lowercase for case-insensitive matching
    const modelLower = model.toLowerCase();
    
    // Try exact match first
    if (MODEL_CONTEXT_LIMITS[modelLower]) {
        return MODEL_CONTEXT_LIMITS[modelLower];
    }
    
    // Try partial match (e.g., "qwen2.5-coder:7b-instruct" matches "qwen2.5-coder:7b")
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
        if (modelLower.startsWith(key)) {
            return limit;
        }
    }
    
    logWarn(`[context] Unknown model "${model}", using default limit of ${DEFAULT_CONTEXT_LIMIT} tokens`);
    return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Estimate token count from text using the 4 chars ≈ 1 token heuristic.
 * This is approximate but good enough for monitoring.
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Calculate total tokens in conversation history.
 */
export function calculateHistoryTokens(history: OllamaMessage[]): number {
    let total = 0;
    for (const msg of history) {
        total += estimateTokens(msg.content);
        // Add overhead for role and structure
        total += MESSAGE_OVERHEAD_TOKENS;
    }
    return total;
}

/**
 * Calculate context usage percentage.
 * Returns a value between 0 and 100.
 */
export function calculateContextUsage(
    historyTokens: number,
    systemPromptTokens: number,
    memoryTokens: number,
    modelLimit: number
): number {
    // Guard against invalid model limit
    if (modelLimit <= 0) {
        logWarn(`[context] Invalid model limit: ${modelLimit}, assuming full context`);
        return 100; // Assume full to be safe
    }
    
    const totalTokens = historyTokens + systemPromptTokens + memoryTokens;
    const percentage = (totalTokens / modelLimit) * 100;
    return Math.min(100, Math.max(0, percentage));
}

/**
 * Context usage level for determining alert behavior.
 */
export type ContextLevel = 'safe' | 'warning' | 'critical' | 'overflow';

/**
 * Determine context usage level based on percentage.
 */
export function getContextLevel(percentage: number): ContextLevel {
    if (percentage >= 99) return 'overflow';
    if (percentage >= 70) return 'critical';
    if (percentage >= 50) return 'warning';
    return 'safe';
}

/**
 * Context usage statistics for monitoring.
 */
export interface ContextStats {
    historyTokens: number;
    systemPromptTokens: number;
    memoryTokens: number;
    totalTokens: number;
    modelLimit: number;
    usagePercentage: number;
    level: ContextLevel;
    messagesCount: number;
}

/**
 * Calculate comprehensive context statistics.
 */
export function calculateContextStats(
    history: OllamaMessage[],
    systemPrompt: string,
    memoryContext: string,
    model: string
): ContextStats {
    const historyTokens = calculateHistoryTokens(history);
    const systemPromptTokens = estimateTokens(systemPrompt);
    const memoryTokens = estimateTokens(memoryContext);
    const totalTokens = historyTokens + systemPromptTokens + memoryTokens;
    const modelLimit = getModelContextLimit(model);
    const usagePercentage = calculateContextUsage(
        historyTokens,
        systemPromptTokens,
        memoryTokens,
        modelLimit
    );
    const level = getContextLevel(usagePercentage);
    
    return {
        historyTokens,
        systemPromptTokens,
        memoryTokens,
        totalTokens,
        modelLimit,
        usagePercentage,
        level,
        messagesCount: history.length,
    };
}

/**
 * Compact conversation history by removing older messages while preserving recent context.
 * Keeps the most recent N messages and removes older ones.
 * 
 * @param history Current conversation history
 * @param targetPercentage Target usage percentage after compaction (default: 50%)
 * @param modelLimit Model's context window limit
 * @param systemPromptTokens Tokens used by system prompt
 * @param memoryTokens Tokens used by memory context
 * @returns Compacted history
 */
export function compactHistory(
    history: OllamaMessage[],
    targetPercentage: number,
    modelLimit: number,
    systemPromptTokens: number,
    memoryTokens: number
): OllamaMessage[] {
    if (history.length === 0) {
        return [];
    }
    
    // Calculate target tokens for history (accounting for system prompt and memory)
    const targetTotalTokens = Math.floor((modelLimit * targetPercentage) / 100);
    const targetHistoryTokens = targetTotalTokens - systemPromptTokens - memoryTokens;
    
    if (targetHistoryTokens <= 0) {
        logWarn('[context] Target history tokens is negative, keeping only last message');
        return history.slice(-1);
    }
    
    // Work backwards from the end, keeping messages until we hit the target
    const compacted: OllamaMessage[] = [];
    let currentTokens = 0;
    
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        const msgTokens = estimateTokens(msg.content) + MESSAGE_OVERHEAD_TOKENS;
        
        if (currentTokens + msgTokens > targetHistoryTokens && compacted.length > 0) {
            // Would exceed target, stop here
            break;
        }
        
        compacted.unshift(msg);
        currentTokens += msgTokens;
    }
    
    const removedCount = history.length - compacted.length;
    logInfo(`[context] Compacted history: removed ${removedCount} messages, kept ${compacted.length} (${currentTokens} tokens)`);
    
    return compacted;
}
