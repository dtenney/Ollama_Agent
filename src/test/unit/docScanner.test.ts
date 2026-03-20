import * as assert from 'assert';

// Replicate a representative subset of GARBAGE_PATTERNS from docScanner.ts
// (cannot import directly because docScanner → memoryCore → vscode)
const GARBAGE_PATTERNS: RegExp[] = [
    /marketplace\.visualstudio/i,
    /github\.com/i,
    /npmjs\.com/i,
    /ollama\.com/i,
    /code.of.conduct/i,
    /\blicense\b/i,
    /no.cloud/i,
    /no.subscriptions/i,
    /no.telemetry/i,
    /100%.(?:private|offline|free|local)/i,
    /\bollama\s+serve\b/i,
    /\bollama\s+pull\b/i,
    /\bgit\s+clone\b/i,
    /localhost:\d{4}/i,
    /127\.0\.0\.1/i,
    /^[\w.-]+$/,
    /^no\s+specific\b/i,
    /\bnot\s+(?:specified|provided|mentioned|listed)\.{0,3}$/i,
];

// Replicate pure functions from docScanner.ts for testing

interface ExtractedFact {
    tier: 0 | 1 | 2 | 3;
    content: string;
    tags: string[];
}

function parseExtractedFacts(raw: string): ExtractedFact[] {
    const facts: ExtractedFact[] = [];
    const cleaned = raw.replace(/```(?:json|jsonl)?\s*/gi, '').replace(/```/g, '');
    const lines = cleaned.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) { continue; }
        try {
            const parsed = JSON.parse(trimmed);
            if (
                typeof parsed.tier === 'number' &&
                parsed.tier >= 0 && parsed.tier <= 3 &&
                typeof parsed.content === 'string' &&
                parsed.content.trim().length >= 20
            ) {
                facts.push({
                    tier: parsed.tier as 0 | 1 | 2 | 3,
                    content: parsed.content.trim().slice(0, 500),
                    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
                });
            }
        } catch {
            // Not valid JSON, skip
        }
    }
    return facts;
}

const CHUNK_TARGET_CHARS = 4_000;

function splitIntoChunks(content: string): string[] {
    if (content.length <= CHUNK_TARGET_CHARS) { return [content]; }

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
        if (remaining.length <= CHUNK_TARGET_CHARS) {
            chunks.push(remaining);
            break;
        }

        const searchRegion = remaining.slice(0, CHUNK_TARGET_CHARS);
        let splitIdx = -1;

        // Prefer splitting on markdown headers
        const re = /\n(?=##\s)/g;
        let lastPos = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(searchRegion)) !== null) {
            if (match.index > CHUNK_TARGET_CHARS * 0.3) {
                lastPos = match.index;
            }
        }
        if (lastPos > 0) { splitIdx = lastPos; }

        // Fallback: double newline
        if (splitIdx === -1) {
            const lastDoubleNl = searchRegion.lastIndexOf('\n\n');
            if (lastDoubleNl > CHUNK_TARGET_CHARS * 0.3) {
                splitIdx = lastDoubleNl;
            }
        }

        // Last resort: any newline
        if (splitIdx === -1) {
            const lastNl = searchRegion.lastIndexOf('\n');
            splitIdx = lastNl > 0 ? lastNl : CHUNK_TARGET_CHARS;
        }

        chunks.push(remaining.slice(0, splitIdx).trim());
        remaining = remaining.slice(splitIdx).trim();
    }

    return chunks.filter(c => c.length > 50);
}

describe('DocScanner Module', () => {

    describe('GARBAGE_PATTERNS', () => {
        it('should have a substantial number of patterns', () => {
            assert.ok(GARBAGE_PATTERNS.length > 10, `Expected >10 patterns, got ${GARBAGE_PATTERNS.length}`);
        });

        it('should filter external URLs', () => {
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('Visit marketplace.visualstudio.com')));
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('See github.com/user/repo')));
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('Available on npmjs.com')));
        });

        it('should filter marketing text', () => {
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('100% private and secure')));
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('No cloud required')));
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('No telemetry of any kind')));
        });

        it('should filter generic install commands', () => {
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('ollama serve')));
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('ollama pull model')));
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('git clone repo')));
        });

        it('should filter license/CoC references', () => {
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('MIT License')));
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('Code of Conduct')));
        });

        it('should filter localhost URLs', () => {
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('localhost:3000')));
            assert.ok(GARBAGE_PATTERNS.some(p => p.test('127.0.0.1')));
        });

        it('should NOT filter real infrastructure facts', () => {
            const realFact = 'Production database runs on PostgreSQL 15 with pgvector extension';
            const blocked = GARBAGE_PATTERNS.some(p => p.test(realFact));
            assert.ok(!blocked, `Real fact should not be filtered: "${realFact}"`);
        });
    });

    describe('parseExtractedFacts', () => {
        it('should parse valid JSONL output', () => {
            const raw = '{"tier": 0, "content": "Database server at db.example.com:5432", "tags": ["infra"]}\n' +
                        '{"tier": 1, "content": "Build command: npm run build:prod", "tags": ["build"]}';
            const facts = parseExtractedFacts(raw);
            assert.strictEqual(facts.length, 2);
            assert.strictEqual(facts[0].tier, 0);
            assert.ok(facts[0].content.includes('db.example.com'));
            assert.deepStrictEqual(facts[0].tags, ['infra']);
        });

        it('should strip markdown code fences', () => {
            const raw = '```json\n{"tier": 1, "content": "Deploy with: kubectl apply -f k8s/", "tags": ["deploy"]}\n```';
            const facts = parseExtractedFacts(raw);
            assert.strictEqual(facts.length, 1);
        });

        it('should skip non-JSON lines', () => {
            const raw = 'Here are the facts:\n{"tier": 0, "content": "Server IP: 10.0.1.50 for staging", "tags": []}\nThat is all.';
            const facts = parseExtractedFacts(raw);
            assert.strictEqual(facts.length, 1);
        });

        it('should reject entries with content shorter than 20 chars', () => {
            const raw = '{"tier": 0, "content": "short", "tags": []}';
            const facts = parseExtractedFacts(raw);
            assert.strictEqual(facts.length, 0);
        });

        it('should reject entries with invalid tier', () => {
            const raw = '{"tier": 5, "content": "This has an invalid tier number value", "tags": []}';
            const facts = parseExtractedFacts(raw);
            assert.strictEqual(facts.length, 0);
        });

        it('should cap content at 500 characters', () => {
            const longContent = 'x'.repeat(600);
            const raw = `{"tier": 0, "content": "${longContent}", "tags": []}`;
            const facts = parseExtractedFacts(raw);
            assert.strictEqual(facts.length, 1);
            assert.strictEqual(facts[0].content.length, 500);
        });

        it('should handle missing tags gracefully', () => {
            const raw = '{"tier": 1, "content": "Build with make all target", "tags": null}';
            const facts = parseExtractedFacts(raw);
            assert.strictEqual(facts.length, 1);
            assert.deepStrictEqual(facts[0].tags, []);
        });
    });

    describe('splitIntoChunks', () => {
        it('should return single chunk for small content', () => {
            const content = 'Small content here.';
            const chunks = splitIntoChunks(content);
            assert.strictEqual(chunks.length, 1);
            assert.strictEqual(chunks[0], content);
        });

        it('should split large content into multiple chunks', () => {
            // Create content larger than CHUNK_TARGET_CHARS (4000)
            const sections = Array.from({ length: 10 }, (_, i) =>
                `## Section ${i}\n\n${'Lorem ipsum dolor sit amet. '.repeat(20)}\n\n`
            ).join('');
            const chunks = splitIntoChunks(sections);
            assert.ok(chunks.length > 1, `Expected >1 chunks, got ${chunks.length}`);
        });

        it('should prefer splitting on markdown headers', () => {
            const content = 'A'.repeat(2000) + '\n## Header\n' + 'B'.repeat(3000);
            const chunks = splitIntoChunks(content);
            assert.ok(chunks.length >= 2);
            // First chunk should end before the header
            assert.ok(!chunks[0].includes('## Header'));
        });

        it('should filter out tiny trailing fragments', () => {
            // Fragments under 50 chars should be dropped
            const content = 'A'.repeat(4500) + '\n\n' + 'tiny';
            const chunks = splitIntoChunks(content);
            for (const chunk of chunks) {
                assert.ok(chunk.length > 50, `Chunk too small: ${chunk.length} chars`);
            }
        });
    });
});
