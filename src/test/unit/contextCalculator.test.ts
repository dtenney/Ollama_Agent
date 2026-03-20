import * as assert from 'assert';

// Replicate pure functions from contextCalculator.ts to avoid vscode dependency chain
// (contextCalculator → ollamaClient → config → vscode)

const MESSAGE_OVERHEAD_TOKENS = 10;

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
    'llama2': 4096, 'llama2:7b': 4096, 'llama2:13b': 4096,
    'llama3': 8192, 'llama3:8b': 8192,
    'llama3.1': 128000, 'llama3.1:8b': 128000,
    'llama3.2': 128000, 'llama3.2:3b': 128000,
    'qwen2.5-coder': 32768, 'qwen2.5-coder:7b': 32768,
    'phi3': 4096, 'phi3:mini': 4096,
    'mistral': 8192, 'mistral:7b': 8192,
    'codellama': 16384, 'codellama:7b': 16384,
    'deepseek-coder': 16384, 'deepseek-r1:8b': 65536,
};

const DEFAULT_CONTEXT_LIMIT = 8192;

function estimateTokens(text: string): number {
    if (!text) return 0;
    const codeChars = (text.match(/[{}()\[\];=<>!&|+\-*/^~@#$%]/g) || []).length;
    const ratio = (codeChars / text.length) > 0.05 ? 3.5 : 4;
    return Math.ceil(text.length / ratio);
}

function calculateHistoryTokens(history: Array<{ role: string; content: string }>): number {
    let total = 0;
    for (const msg of history) {
        total += estimateTokens(msg.content);
        total += MESSAGE_OVERHEAD_TOKENS;
    }
    return total;
}

function calculateContextUsage(
    historyTokens: number, systemPromptTokens: number,
    memoryTokens: number, modelLimit: number
): number {
    if (modelLimit <= 0) return 100;
    const totalTokens = historyTokens + systemPromptTokens + memoryTokens;
    const percentage = (totalTokens / modelLimit) * 100;
    return Math.min(100, Math.max(0, percentage));
}

type ContextLevel = 'safe' | 'warning' | 'critical' | 'overflow';

function getContextLevel(percentage: number): ContextLevel {
    if (percentage >= 99) return 'overflow';
    if (percentage >= 95) return 'critical';
    if (percentage >= 75) return 'warning';
    return 'safe';
}

function getModelContextLimit(model: string): number {
    const modelLower = model.toLowerCase();
    if (MODEL_CONTEXT_LIMITS[modelLower]) return MODEL_CONTEXT_LIMITS[modelLower];
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
        if (modelLower.startsWith(key)) return limit;
    }
    return DEFAULT_CONTEXT_LIMIT;
}

function compactHistory(
    history: Array<{ role: string; content: string }>,
    targetPercentage: number, modelLimit: number,
    systemPromptTokens: number, memoryTokens: number
): Array<{ role: string; content: string }> {
    if (history.length === 0) return [];
    const targetTotalTokens = Math.floor((modelLimit * targetPercentage) / 100);
    const targetHistoryTokens = targetTotalTokens - systemPromptTokens - memoryTokens;
    if (targetHistoryTokens <= 0) return history.slice(-1);

    const compacted: Array<{ role: string; content: string }> = [];
    let currentTokens = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        const msgTokens = estimateTokens(msg.content) + MESSAGE_OVERHEAD_TOKENS;
        if (currentTokens + msgTokens > targetHistoryTokens && compacted.length > 0) break;
        compacted.unshift(msg);
        currentTokens += msgTokens;
    }
    return compacted;
}

describe('ContextCalculator Module', () => {

    describe('estimateTokens', () => {
        it('should return 0 for empty string', () => {
            assert.strictEqual(estimateTokens(''), 0);
        });

        it('should return 0 for null/undefined input', () => {
            assert.strictEqual(estimateTokens(null as any), 0);
            assert.strictEqual(estimateTokens(undefined as any), 0);
        });

        it('should estimate prose at ~char/4 ratio', () => {
            const prose = 'The quick brown fox jumps over the lazy dog and runs away.';
            const tokens = estimateTokens(prose);
            assert.ok(tokens > 10 && tokens < 25, `Expected ~15, got ${tokens}`);
        });

        it('should estimate code at ~char/3.5 ratio (tighter)', () => {
            const code = 'if (x > 0) { return arr[i] + obj.val; } else { throw new Error(); }';
            const tokens = estimateTokens(code);
            assert.ok(tokens > 15 && tokens < 30, `Expected ~20, got ${tokens}`);
        });

        it('should use tighter ratio when code punctuation exceeds 5%', () => {
            const codeHeavy = '{}()[];=<>!&|+-*/^~@#$%' + 'a'.repeat(400);
            const proseOnly = 'a'.repeat(424);
            const codeTokens = estimateTokens(codeHeavy);
            const proseTokens = estimateTokens(proseOnly);
            assert.ok(codeTokens > proseTokens, `Code tokens (${codeTokens}) should exceed prose tokens (${proseTokens})`);
        });
    });

    describe('calculateHistoryTokens', () => {
        it('should return 0 for empty history', () => {
            assert.strictEqual(calculateHistoryTokens([]), 0);
        });

        it('should include message overhead per message', () => {
            const history = [
                { role: 'user', content: '' },
                { role: 'assistant', content: '' },
            ];
            assert.strictEqual(calculateHistoryTokens(history), 20);
        });

        it('should sum content tokens plus overhead', () => {
            const history = [{ role: 'user', content: 'Hello world' }];
            const tokens = calculateHistoryTokens(history);
            assert.ok(tokens > 10, `Expected > 10, got ${tokens}`);
        });
    });

    describe('calculateContextUsage', () => {
        it('should return percentage of model limit', () => {
            assert.strictEqual(calculateContextUsage(4000, 500, 500, 10000), 50);
        });

        it('should cap at 100%', () => {
            assert.strictEqual(calculateContextUsage(10000, 5000, 5000, 10000), 100);
        });

        it('should not go below 0%', () => {
            assert.strictEqual(calculateContextUsage(0, 0, 0, 10000), 0);
        });

        it('should return 100 for invalid model limit', () => {
            assert.strictEqual(calculateContextUsage(100, 0, 0, 0), 100);
            assert.strictEqual(calculateContextUsage(100, 0, 0, -1), 100);
        });
    });

    describe('getContextLevel', () => {
        it('should return safe below 75%', () => {
            assert.strictEqual(getContextLevel(0), 'safe');
            assert.strictEqual(getContextLevel(50), 'safe');
            assert.strictEqual(getContextLevel(74.9), 'safe');
        });

        it('should return warning at 75%', () => {
            assert.strictEqual(getContextLevel(75), 'warning');
            assert.strictEqual(getContextLevel(90), 'warning');
            assert.strictEqual(getContextLevel(94.9), 'warning');
        });

        it('should return critical at 95%', () => {
            assert.strictEqual(getContextLevel(95), 'critical');
            assert.strictEqual(getContextLevel(98), 'critical');
        });

        it('should return overflow at 99%', () => {
            assert.strictEqual(getContextLevel(99), 'overflow');
            assert.strictEqual(getContextLevel(100), 'overflow');
        });
    });

    describe('getModelContextLimit', () => {
        it('should return known limits for common models', () => {
            assert.strictEqual(getModelContextLimit('llama2'), 4096);
            assert.strictEqual(getModelContextLimit('qwen2.5-coder:7b'), 32768);
            assert.strictEqual(getModelContextLimit('llama3.1:8b'), 128000);
        });

        it('should be case-insensitive', () => {
            assert.strictEqual(getModelContextLimit('Llama2'), 4096);
            assert.strictEqual(getModelContextLimit('QWEN2.5-CODER:7B'), 32768);
        });

        it('should match partial model names (prefix)', () => {
            assert.strictEqual(getModelContextLimit('qwen2.5-coder:7b-instruct'), 32768);
        });

        it('should return default 8192 for unknown models', () => {
            assert.strictEqual(getModelContextLimit('totally-unknown-model'), 8192);
        });
    });

    describe('compactHistory', () => {
        it('should return empty array for empty history', () => {
            assert.deepStrictEqual(compactHistory([], 50, 8192, 100, 100), []);
        });

        it('should keep recent messages and remove older ones', () => {
            const history = Array.from({ length: 20 }, (_, i) => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `Message ${i}: ${'x'.repeat(200)}`,
            }));
            // Use a small model limit so compaction is forced
            const result = compactHistory(history, 30, 2000, 100, 100);
            assert.ok(result.length < history.length);
            assert.ok(result.length > 0);
            assert.strictEqual(result[result.length - 1].content, history[history.length - 1].content);
        });

        it('should keep at least one message when target is very small', () => {
            const history = [
                { role: 'user', content: 'x'.repeat(1000) },
                { role: 'assistant', content: 'y'.repeat(1000) },
            ];
            const result = compactHistory(history, 1, 100, 50, 50);
            assert.ok(result.length >= 1);
        });

        it('should not compact when history fits within target', () => {
            const history = [
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Hello' },
            ];
            const result = compactHistory(history, 50, 100000, 100, 100);
            assert.strictEqual(result.length, history.length);
        });
    });
});
