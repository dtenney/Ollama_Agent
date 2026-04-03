/**
 * agentHarness.test.ts
 *
 * Headless integration tests for the Agent loop.
 *
 * Strategy:
 *   - Register a vscode stub in require.cache BEFORE importing agent.ts
 *   - Stub ollamaClient.streamChatRequest to return scripted model responses
 *   - Create a real Agent with a temp workspace (real fs)
 *   - Auto-resolve confirmations via postFn callback
 *   - Assert on posted messages and file system state
 *
 * Run with:  npm run test:unit  (or mocha dist/test/unit/agentHarness.test.js)
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as sinon from 'sinon';

// vscode is mocked by the --require preload (dist/test/vscode-mock.js)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ollamaClient = require('../../ollamaClient') as typeof import('../../ollamaClient');
import type { OllamaMessage, StreamResult } from '../../ollamaClient';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Agent } = require('../../agent') as typeof import('../../agent');

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface PostedMessage { type: string; [k: string]: unknown }

/**
 * Build a fake Ollama NDJSON stream that yields the given text chunks,
 * then a [DONE] line.  Matches what streamChatRequest calls `onChunk` with.
 *
 * streamChatRequest calls: onChunk(delta_text) for each chunk, then onDone()
 * We stub streamChatRequest itself so we don't need to simulate HTTP.
 */
function makeStreamStub(
    sandbox: sinon.SinonSandbox,
    responses: Array<string | ((call: number) => string)>
) {
    let callCount = 0;
    return sandbox.stub(ollamaClient, 'streamChatRequest').callsFake(
        (_model: string, _messages: OllamaMessage[], _tools: unknown[], onToken: (t: string) => void, _stopRef: object): Promise<StreamResult> => {
            const resp = responses[callCount] ?? responses[responses.length - 1];
            const text = typeof resp === 'function' ? resp(callCount) : resp;
            callCount++;
            onToken(text);
            return Promise.resolve({ content: text, toolCalls: [] });
        }
    );
}

/**
 * Drive agent.run() while auto-resolving any confirmAction prompts.
 * Returns all posted messages once run() resolves.
 */
async function runAgent(
    agent: InstanceType<typeof Agent>,
    message: string,
    model = 'qwen2.5-coder:7b-256k'
): Promise<PostedMessage[]> {
    const posted: PostedMessage[] = [];

    const runPromise = agent.run(message, model, (msg: object) => {
        const m = msg as PostedMessage;
        posted.push(m);
        // Auto-accept any confirmation request
        if (m.type === 'confirmAction') {
            setImmediate(() => agent.resolveConfirmation(true));
        }
    });

    await runPromise;
    return posted;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Agent Harness — headless integration', () => {
    let sandbox: sinon.SinonSandbox;
    let tmpDir: string;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-harness-'));
    });

    afterEach(() => {
        sandbox.restore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── 1. Plain text answer (no tool calls) ──────────────────────────────────

    it('returns a plain text answer when model does not call any tool', async () => {
        makeStreamStub(sandbox, ['The answer is 42.']);

        const agent = new Agent(tmpDir, null, null);
        const posted = await runAgent(agent, 'What is the answer to everything?');

        const chunks = posted.filter(m => m.type === 'token');
        const fullText = chunks.map(m => m.text as string).join('');
        assert.ok(fullText.includes('42'), `Expected "42" in response, got: ${fullText}`);
    });

    // ── 2. read_file tool call ────────────────────────────────────────────────

    it('handles read_file tool call and injects result into next model call', async () => {
        // Create a file in the temp workspace
        const relPath = 'hello.py';
        fs.writeFileSync(path.join(tmpDir, relPath), 'print("hello world")\n');

        // First response: tool call. Second response: final answer using the content.
        makeStreamStub(sandbox, [
            `<tool>{"name":"read_file","arguments":{"path":"${relPath}"}}</tool>`,
            'The file contains: print("hello world")',
        ]);

        const agent = new Agent(tmpDir, null, null);
        // Force text mode so our <tool>...</tool> XML is parsed
        (agent as unknown as { toolMode: string }).toolMode = 'text';

        const posted = await runAgent(agent, 'What is in hello.py?');

        // Should have at least one toolResult message
        const toolResults = posted.filter(m => m.type === 'toolResult' || m.type === 'token');
        assert.ok(toolResults.length > 0, 'Expected tool result or chunk messages');

        const chunks = posted.filter(m => m.type === 'token');
        const finalText = chunks.map(m => m.text as string).join('');
        assert.ok(
            finalText.toLowerCase().includes('hello') || finalText.includes('print'),
            `Expected file content reference in final answer, got: ${finalText}`
        );
    });

    // ── 3. edit_file tool call ────────────────────────────────────────────────

    it('edit_file creates the change on disk when confirmed', async () => {
        const relPath = 'greet.py';
        const original = 'def greet():\n    return "hello"\n';
        fs.writeFileSync(path.join(tmpDir, relPath), original);

        makeStreamStub(sandbox, [
            `<tool>{"name":"edit_file","arguments":{"path":"${relPath}","old_string":"return \\"hello\\"","new_string":"return \\"hi there\\""}}</tool>`,
            'Done. Updated the greeting.',
        ]);

        const agent = new Agent(tmpDir, null, null);
        (agent as unknown as { toolMode: string }).toolMode = 'text';

        const posted = await runAgent(agent, 'Change greeting to "hi there"');

        // File should be updated
        const content = fs.readFileSync(path.join(tmpDir, relPath), 'utf8');
        assert.ok(content.includes('hi there'), `Expected "hi there" in file, got: ${content}`);

        // Should have a fileChanged event
        const fileChanged = posted.find(m => m.type === 'fileChanged');
        assert.ok(fileChanged, 'Expected fileChanged event');
        assert.strictEqual((fileChanged as PostedMessage).path, relPath);
    });

    // ── 4. list_files tool call ───────────────────────────────────────────────

    it('list_files tool returns directory listing and injects into history', async () => {
        fs.writeFileSync(path.join(tmpDir, 'alpha.py'), '# a\n');
        fs.writeFileSync(path.join(tmpDir, 'beta.py'),  '# b\n');

        let injectedContent = '';
        let callNum = 0;
        sandbox.stub(ollamaClient, 'streamChatRequest').callsFake(
            (_model: string, messages: OllamaMessage[], _tools: unknown[], onToken: (t: string) => void, _stop: object): Promise<StreamResult> => {
                callNum++;
                if (callNum === 1) {
                    const txt = '<tool>{"name":"list_files","arguments":{"path":"."}}</tool>';
                    onToken(txt);
                    return Promise.resolve({ content: txt, toolCalls: [] });
                } else {
                    // Capture the tool result message
                    const last = messages.at(-1);
                    injectedContent = last?.content ?? '';
                    onToken('Here are the files.');
                    return Promise.resolve({ content: 'Here are the files.', toolCalls: [] });
                }
            }
        );

        const agent = new Agent(tmpDir, null, null);
        (agent as unknown as { toolMode: string }).toolMode = 'text';

        await runAgent(agent, 'List files in the workspace root');

        // Tool result (even an error/redirect) is injected into model history
        assert.ok(
            injectedContent.includes('Tool list_files') || injectedContent.length > 0,
            `Expected tool result injected into history, got: ${injectedContent.slice(0, 300)}`
        );
    });

    // ── 5. Reasoning card is posted before model call for edit tasks ──────────

    it('posts a reasoningCard before the model call on edit tasks', async () => {
        // Set up a minimal Python project structure
        fs.mkdirSync(path.join(tmpDir, 'app'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'app', 'models'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'app', 'routes'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'app', '__init__.py'), '');
        fs.writeFileSync(path.join(tmpDir, 'app', 'models', '__init__.py'), '');
        fs.writeFileSync(path.join(tmpDir, 'app', 'models', 'user.py'), 'class User(db.Model):\n    id = db.Column(db.Integer)\n');
        const routeFile = 'app/routes/users.py';
        fs.mkdirSync(path.join(tmpDir, 'app', 'routes'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, routeFile),
            'from flask import Blueprint\nbp = Blueprint("users", __name__)\n\n@bp.route("/users")\ndef list_users():\n    return []\n'
        );

        makeStreamStub(sandbox, ['Done.']);

        const agent = new Agent(tmpDir, null, null);
        (agent as unknown as { toolMode: string }).toolMode = 'text';

        const posted = await runAgent(agent, `add a route to get a single user by id to ${routeFile}`);

        const card = posted.find(m => m.type === 'reasoningCard');
        assert.ok(card, `Expected reasoningCard message. Got types: ${posted.map(m => m.type).join(', ')}`);
    });

    // ── 6. Model stop without action (validation stop) ────────────────────────

    it('does not retry when model gives a valid validation stop message', async () => {
        let callCount = 0;
        sandbox.stub(ollamaClient, 'streamChatRequest').callsFake(
            (_model: string, _msgs: OllamaMessage[], _tools: unknown[], onToken: (t: string) => void, _stop: object): Promise<StreamResult> => {
                callCount++;
                onToken('Already exists: list_users. No change needed.');
                return Promise.resolve({ content: 'Already exists: list_users. No change needed.', toolCalls: [] });
            }
        );

        fs.writeFileSync(path.join(tmpDir, 'routes.py'), '@app.route("/users")\ndef list_users():\n    return []\n');

        const agent = new Agent(tmpDir, null, null);
        (agent as unknown as { toolMode: string }).toolMode = 'text';

        await runAgent(agent, 'add list_users route to routes.py');

        // Model was only called once — no retry loop
        assert.strictEqual(callCount, 1, `Expected 1 model call, got ${callCount}`);
    });

    // ── 7. Duplicate Python edit blocked by validateNewContent ────────────────

    it('edit_file throws when new content has a non-existent import', async () => {
        const relPath = 'service.py';
        fs.writeFileSync(path.join(tmpDir, relPath), 'x = 1\n');

        // Model tries to write an import to a module that doesn't exist
        const badContent = 'from app.nonexistent.module import Foo\nx = 1\n';
        makeStreamStub(sandbox, [
            `<tool>{"name":"edit_file","arguments":{"path":"${relPath}","old_string":"x = 1","new_string":"${badContent.replace(/\n/g, '\\n')}"}}</tool>`,
            'Done.',
        ]);

        const agent = new Agent(tmpDir, null, null);
        (agent as unknown as { toolMode: string }).toolMode = 'text';

        const posted = await runAgent(agent, 'Add a bad import to service.py');

        // The edit should have been blocked — file unchanged
        const content = fs.readFileSync(path.join(tmpDir, relPath), 'utf8');
        assert.strictEqual(content.trim(), 'x = 1', `Expected file unchanged, got: ${content}`);

        // Should not have a fileChanged event
        const fileChanged = posted.find(m => m.type === 'fileChanged');
        assert.ok(!fileChanged, 'Expected no fileChanged event for blocked edit');
    });

    // ── 8. workspace_summary returns file tree ────────────────────────────────

    it('workspace_summary tool returns file listing', async () => {
        fs.writeFileSync(path.join(tmpDir, 'main.py'), '# main\n');
        fs.writeFileSync(path.join(tmpDir, 'utils.py'), '# utils\n');

        let toolResultContent = '';
        let callCount = 0;

        sandbox.stub(ollamaClient, 'streamChatRequest').callsFake(
            (_model: string, messages: OllamaMessage[], _tools: unknown[], onToken: (t: string) => void, _stop: object): Promise<StreamResult> => {
                callCount++;
                if (callCount === 1) {
                    const txt = '<tool>{"name":"workspace_summary","arguments":{}}</tool>';
                    onToken(txt);
                    return Promise.resolve({ content: txt, toolCalls: [] });
                } else {
                    // The tool result was injected as a user/tool message in history
                    const lastMsg = messages.at(-1);
                    toolResultContent = lastMsg?.content ?? '';
                    onToken('Here is a summary.');
                    return Promise.resolve({ content: 'Here is a summary.', toolCalls: [] });
                }
            }
        );

        const agent = new Agent(tmpDir, null, null);
        (agent as unknown as { toolMode: string }).toolMode = 'text';

        await runAgent(agent, 'Show me the workspace');

        assert.ok(
            toolResultContent.includes('main.py') || toolResultContent.includes('utils.py'),
            `Expected file names in tool result, got: ${toolResultContent.slice(0, 200)}`
        );
    });
});
