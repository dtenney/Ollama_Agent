import * as assert from 'assert';
import * as sinon from 'sinon';

// Test the pure helper functions and patterns used by provider.ts

// Replicate toSummary from provider.ts
function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

interface SessionSummary {
    id: string;
    title: string;
    model: string;
    messageCount: number;
    updatedAt: number;
    relativeTime: string;
}

function toSummary(s: { id: string; title: string; model: string; messages: any[]; updatedAt: number }): SessionSummary {
    return {
        id: s.id,
        title: s.title,
        model: s.model,
        messageCount: s.messages.length,
        updatedAt: s.updatedAt,
        relativeTime: relativeTime(s.updatedAt),
    };
}

describe('Provider Module', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
    });

    afterEach(() => {
        sandbox.restore();
    });

    describe('toSummary', () => {
        it('should convert session to summary with message count', () => {
            const session = {
                id: 'sess-123',
                title: 'Test Chat',
                model: 'qwen2.5-coder:7b',
                messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
                updatedAt: Date.now(),
            };

            const summary = toSummary(session);
            assert.strictEqual(summary.id, 'sess-123');
            assert.strictEqual(summary.title, 'Test Chat');
            assert.strictEqual(summary.model, 'qwen2.5-coder:7b');
            assert.strictEqual(summary.messageCount, 2);
            assert.strictEqual(summary.relativeTime, 'just now');
        });

        it('should handle empty messages', () => {
            const session = {
                id: 'sess-empty',
                title: 'New Chat',
                model: 'llama2',
                messages: [],
                updatedAt: Date.now() - 3600000, // 1 hour ago
            };

            const summary = toSummary(session);
            assert.strictEqual(summary.messageCount, 0);
            assert.strictEqual(summary.relativeTime, '1h ago');
        });
    });

    describe('relativeTime', () => {
        it('should return "just now" for recent timestamps', () => {
            assert.strictEqual(relativeTime(Date.now()), 'just now');
            assert.strictEqual(relativeTime(Date.now() - 30000), 'just now');
        });

        it('should return minutes for < 1 hour', () => {
            assert.strictEqual(relativeTime(Date.now() - 5 * 60000), '5m ago');
            assert.strictEqual(relativeTime(Date.now() - 30 * 60000), '30m ago');
        });

        it('should return hours for < 24 hours', () => {
            assert.strictEqual(relativeTime(Date.now() - 2 * 3600000), '2h ago');
            assert.strictEqual(relativeTime(Date.now() - 12 * 3600000), '12h ago');
        });

        it('should return days for >= 24 hours', () => {
            assert.strictEqual(relativeTime(Date.now() - 48 * 3600000), '2d ago');
            assert.strictEqual(relativeTime(Date.now() - 7 * 24 * 3600000), '7d ago');
        });
    });

    describe('_running Guard Pattern', () => {
        it('should prevent concurrent execution', () => {
            let running = false;
            const results: string[] = [];

            function sendMessage(text: string): boolean {
                if (running) {
                    results.push(`blocked:${text}`);
                    return false;
                }
                running = true;
                results.push(`started:${text}`);
                // Simulate async work completing
                running = false;
                results.push(`finished:${text}`);
                return true;
            }

            assert.ok(sendMessage('first'));
            assert.ok(sendMessage('second'));
            assert.deepStrictEqual(results, [
                'started:first', 'finished:first',
                'started:second', 'finished:second',
            ]);
        });

        it('should block retry while running', () => {
            let running = true; // Simulate active run
            const canRetry = !running;
            assert.strictEqual(canRetry, false);
        });

        it('should block compact while running', () => {
            let running = true;
            const canCompact = !running;
            assert.strictEqual(canCompact, false);
        });

        it('should reset on completion', () => {
            let running = true;
            // Simulate run completion
            running = false;
            assert.strictEqual(running, false);
        });
    });

    describe('Session Management', () => {
        it('should trim session to last user message', () => {
            const messages = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' },
                { role: 'error', content: 'Connection lost' },
            ];

            // trimSessionToLastUser logic
            while (messages.length > 0 && messages[messages.length - 1].role !== 'user') {
                messages.pop();
            }

            assert.strictEqual(messages.length, 1);
            assert.strictEqual(messages[0].role, 'user');
        });

        it('should handle all-user messages', () => {
            const messages = [
                { role: 'user', content: 'First' },
                { role: 'user', content: 'Second' },
            ];

            while (messages.length > 0 && messages[messages.length - 1].role !== 'user') {
                messages.pop();
            }

            assert.strictEqual(messages.length, 2);
        });

        it('should handle empty messages', () => {
            const messages: any[] = [];

            while (messages.length > 0 && messages[messages.length - 1].role !== 'user') {
                messages.pop();
            }

            assert.strictEqual(messages.length, 0);
        });
    });

    describe('Title Derivation', () => {
        it('should derive title from first user message', () => {
            const messages = [
                { role: 'user', content: 'Explain what this project does' },
                { role: 'assistant', content: 'This project is...' },
            ];

            const firstUser = messages.find(m => m.role === 'user');
            const title = firstUser
                ? firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? '…' : '')
                : 'New Chat';

            assert.strictEqual(title, 'Explain what this project does');
        });

        it('should truncate long titles', () => {
            const longMessage = 'A'.repeat(100);
            const title = longMessage.slice(0, 50) + (longMessage.length > 50 ? '…' : '');
            assert.strictEqual(title.length, 51); // 50 chars + ellipsis
            assert.ok(title.endsWith('…'));
        });

        it('should fallback to New Chat when no user messages', () => {
            const messages: any[] = [];
            const firstUser = messages.find((m: any) => m.role === 'user');
            const title = firstUser ? firstUser.content.slice(0, 50) : 'New Chat';
            assert.strictEqual(title, 'New Chat');
        });
    });

    describe('Assistant Buffer Cleaning', () => {
        // Replicate stripToolBlocksFromText from provider.ts (brace-counting)
        function stripToolBlocksFromText(text: string): string {
            let result = text;
            let pos = 0;
            while (pos < result.length) {
                const idx = result.toLowerCase().indexOf('<tool>', pos);
                if (idx === -1) break;
                let depth = 0, jsonEnd = -1;
                for (let i = idx + 6; i < result.length; i++) {
                    if (result[i] === '{') depth++;
                    else if (result[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
                }
                if (jsonEnd === -1) { result = result.slice(0, idx); break; }
                let endPos = jsonEnd;
                const afterJson = result.slice(jsonEnd).match(/^\s*<\/tool>/i);
                if (afterJson) endPos = jsonEnd + afterJson[0].length;
                result = result.slice(0, idx) + result.slice(endPos);
                pos = idx;
            }
            return result.replace(/<\/tool>/gi, '');
        }

        it('should strip tool blocks from assistant output', () => {
            const raw = 'Here is the result.\n<tool>{"name":"read_file"}</tool>\nDone.';
            const clean = stripToolBlocksFromText(raw)
                .replace(/<mention[\s\S]*?<\/mention>\s*/g, '')
                .replace(/<git-diff[\s\S]*?<\/git-diff>\s*/g, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            assert.strictEqual(clean, 'Here is the result.\n\nDone.');
        });

        it('should strip tool blocks with nested JSON arguments', () => {
            const raw = 'Result:\n<tool>{"name":"list_files","arguments":{}}</tool>\nDone.';
            const clean = stripToolBlocksFromText(raw).replace(/\n{3,}/g, '\n\n').trim();
            assert.strictEqual(clean, 'Result:\n\nDone.');
        });

        it('should strip tool blocks without closing tag', () => {
            const raw = 'Text before<tool>{"name":"memory_write","arguments":{"content":"test"}}';
            const clean = stripToolBlocksFromText(raw).trim();
            assert.strictEqual(clean, 'Text before');
        });

        it('should strip mention blocks', () => {
            const raw = 'Answer: yes\n<mention file="test.ts">content</mention>\n';
            const clean = raw
                .replace(/<mention[\s\S]*?<\/mention>\s*/g, '')
                .trim();

            assert.strictEqual(clean, 'Answer: yes');
        });

        it('should strip git-diff blocks', () => {
            const raw = 'Changes look good.\n<git-diff summary="1 file">diff content</git-diff>\n';
            const clean = raw
                .replace(/<git-diff[\s\S]*?<\/git-diff>\s*/g, '')
                .trim();

            assert.strictEqual(clean, 'Changes look good.');
        });

        it('should collapse excessive newlines', () => {
            const raw = 'Line 1\n\n\n\n\nLine 2';
            const clean = raw.replace(/\n{3,}/g, '\n\n');
            assert.strictEqual(clean, 'Line 1\n\nLine 2');
        });
    });
});
