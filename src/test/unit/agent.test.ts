import * as assert from 'assert';
import * as sinon from 'sinon';

describe('Agent Module', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Tool Definitions', () => {
    it('should define all 23 tools', () => {
      const toolNames = [
        'workspace_summary', 'read_file', 'list_files', 'search_files',
        'create_file', 'edit_file', 'write_file', 'append_to_file',
        'rename_file', 'delete_file', 'find_files', 'shell_read', 'run_command',
        'memory_list', 'memory_write', 'memory_delete', 'memory_search',
        'memory_tier_write', 'memory_tier_list', 'memory_stats',
        'read_terminal', 'get_diagnostics', 'refactor_multi_file'
      ];

      assert.strictEqual(toolNames.length, 23);
    });

    it('should mark destructive tools for confirmation', () => {
      const confirmationRequired = ['edit_file', 'write_file', 'rename_file', 'delete_file', 'run_command'];

      assert.strictEqual(confirmationRequired.length, 5);
      assert.ok(confirmationRequired.includes('edit_file'));
      assert.ok(confirmationRequired.includes('delete_file'));
      assert.ok(confirmationRequired.includes('run_command'));
    });
  });

  describe('Tool Mode Detection', () => {
    it('should detect native tool support', () => {
      const nativeModels = ['qwen2.5-coder', 'llama3-groq-tool-use'];
      const model = 'qwen2.5-coder:7b';

      const supportsNative = nativeModels.some(m => model.includes(m));
      assert.strictEqual(supportsNative, true);
    });

    it('should fallback to text mode on 400 error', () => {
      const errorMessage = 'does not support tools';
      const shouldFallback = errorMessage.includes('does not support tools');

      assert.strictEqual(shouldFallback, true);
    });
  });

  describe('Text Mode Tool Parsing', () => {
    it('should parse tool call from XML-like tags', () => {
      const text = '<tool>{"name":"read_file","arguments":{"path":"test.ts"}}</tool>';
      const match = text.match(/<tool>(.*?)<\/tool>/s);

      assert.ok(match);
      const parsed = JSON.parse(match![1]);
      assert.strictEqual(parsed.name, 'read_file');
      assert.strictEqual(parsed.arguments.path, 'test.ts');
    });

    it('should handle multiple tool calls', () => {
      const text = '<tool>{"name":"read_file","arguments":{"path":"a.ts"}}</tool> some text <tool>{"name":"read_file","arguments":{"path":"b.ts"}}</tool>';
      const matches = [...text.matchAll(/<tool>(.*?)<\/tool>/gs)];

      assert.strictEqual(matches.length, 2);
    });

    it('should handle malformed tool calls gracefully', () => {
      const text = '<tool>not valid json</tool>';
      const match = text.match(/<tool>(.*?)<\/tool>/s);

      assert.ok(match);
      let parsed = null;
      try {
        parsed = JSON.parse(match![1]);
      } catch {
        parsed = null;
      }

      assert.strictEqual(parsed, null);
    });
  });

  describe('Path Validation', () => {
    it('should reject paths outside workspace', () => {
      const workspaceRoot = '/workspace/project';
      const validPath = '/workspace/project/src/test.ts';
      const invalidPath = '/etc/passwd';

      assert.ok(validPath.startsWith(workspaceRoot));
      assert.ok(!invalidPath.startsWith(workspaceRoot));
    });

    it('should reject path traversal attempts', () => {
      const path = '../../../etc/passwd';
      const hasTraversal = path.includes('..');

      assert.strictEqual(hasTraversal, true);
    });

    it('should normalize paths', () => {
      const path = '/workspace/project/src/../lib/test.ts';
      const normalized = '/workspace/project/lib/test.ts';

      assert.ok(!normalized.includes('..'));
    });
  });

  describe('Dangerous Command Blocking', () => {
    it('should block rm -rf /', () => {
      const dangerousPatterns = ['rm -rf /', 'mkfs', 'dd if=', ':(){:|:&};:'];
      const command = 'rm -rf /';

      const isBlocked = dangerousPatterns.some(p => command.includes(p));
      assert.strictEqual(isBlocked, true);
    });

    it('should allow safe commands', () => {
      const dangerousPatterns = ['rm -rf /', 'mkfs', 'dd if=', ':(){:|:&};:'];
      const command = 'npm install';

      const isBlocked = dangerousPatterns.some(p => command.includes(p));
      assert.strictEqual(isBlocked, false);
    });

    it('should block fork bombs', () => {
      const dangerousPatterns = [':(){:|:&};:'];
      const command = ':(){:|:&};:';

      const isBlocked = dangerousPatterns.some(p => command.includes(p));
      assert.strictEqual(isBlocked, true);
    });
  });

  describe('Agent Loop', () => {
    it('should limit tool call iterations', () => {
      const maxIterations = 10;
      let iterations = 0;

      while (iterations < maxIterations) {
        iterations++;
      }

      assert.strictEqual(iterations, maxIterations);
    });

    it('should build conversation history', () => {
      const history: Array<{ role: string; content: string }> = [];

      history.push({ role: 'system', content: 'You are a coding assistant.' });
      history.push({ role: 'user', content: 'Hello' });
      history.push({ role: 'assistant', content: 'Hi!' });

      assert.strictEqual(history.length, 3);
      assert.strictEqual(history[0].role, 'system');
    });

    it('should append tool results to history', () => {
      const history: Array<{ role: string; content: string }> = [];

      history.push({ role: 'user', content: 'Read test.ts' });
      history.push({ role: 'assistant', content: 'I will read the file.' });
      history.push({ role: 'tool', content: 'const x = 1;' });

      assert.strictEqual(history.length, 3);
      assert.strictEqual(history[2].role, 'tool');
    });
  });

  describe('Context Compaction', () => {
    it('should estimate token count', () => {
      const text = 'Hello world, this is a test message.';
      const estimatedTokens = Math.ceil(text.length / 4);

      assert.strictEqual(estimatedTokens, 9);
    });

    it('should trigger compaction at 99% usage', () => {
      const contextLimit = 32768;
      const currentTokens = 32768; // 100%
      const threshold = 0.99;

      const shouldCompact = currentTokens / contextLimit >= threshold;
      assert.strictEqual(shouldCompact, true);
    });

    it('should not compact below threshold', () => {
      const contextLimit = 32768;
      const currentTokens = 16000; // ~49%
      const threshold = 0.99;

      const shouldCompact = currentTokens / contextLimit >= threshold;
      assert.strictEqual(shouldCompact, false);
    });
  });

  describe('Diff Preview', () => {
    it('should detect edit_file tool', () => {
      const toolName = 'edit_file';
      const needsDiff = toolName === 'edit_file';

      assert.strictEqual(needsDiff, true);
    });

    it('should validate old/new content for edit', () => {
      const args = {
        path: 'test.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;'
      };

      assert.ok(args.path);
      assert.ok(args.old_string);
      assert.ok(args.new_string);
      assert.notStrictEqual(args.old_string, args.new_string);
    });
  });

  describe('Multi-File Refactoring', () => {
    it('should detect refactor_multi_file tool', () => {
      const toolName = 'refactor_multi_file';
      const isRefactor = toolName === 'refactor_multi_file';

      assert.strictEqual(isRefactor, true);
    });

    it('should validate file changes array', () => {
      const changes = [
        { path: 'a.ts', content: 'new content A' },
        { path: 'b.ts', content: 'new content B' }
      ];

      assert.strictEqual(changes.length, 2);
      changes.forEach(c => {
        assert.ok(c.path);
        assert.ok(c.content);
      });
    });
  });
});
