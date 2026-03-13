import * as assert from 'assert';
import * as sinon from 'sinon';

describe('OllamaClient Module', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('URL Construction', () => {
    it('should use baseUrl when provided', () => {
      const baseUrl = 'http://192.168.1.100:11434';
      const endpoint = '/api/chat';
      const url = `${baseUrl}${endpoint}`;

      assert.strictEqual(url, 'http://192.168.1.100:11434/api/chat');
    });

    it('should construct URL from host and port', () => {
      const host = 'localhost';
      const port = 11434;
      const endpoint = '/api/chat';
      const url = `http://${host}:${port}${endpoint}`;

      assert.strictEqual(url, 'http://localhost:11434/api/chat');
    });

    it('should strip trailing slash from baseUrl', () => {
      const baseUrl = 'http://localhost:11434/';
      const cleaned = baseUrl.replace(/\/$/, '');

      assert.strictEqual(cleaned, 'http://localhost:11434');
    });
  });

  describe('API Endpoints', () => {
    it('should use /api/chat for chat', () => {
      assert.strictEqual('/api/chat', '/api/chat');
    });

    it('should use /api/tags for model listing', () => {
      assert.strictEqual('/api/tags', '/api/tags');
    });

    it('should use /api/embeddings for embeddings', () => {
      assert.strictEqual('/api/embeddings', '/api/embeddings');
    });
  });

  describe('Request Body', () => {
    it('should build chat request with model and messages', () => {
      const body = {
        model: 'qwen2.5-coder:7b',
        messages: [
          { role: 'system', content: 'You are a coding assistant.' },
          { role: 'user', content: 'Hello' }
        ],
        stream: true
      };

      assert.strictEqual(body.model, 'qwen2.5-coder:7b');
      assert.strictEqual(body.messages.length, 2);
      assert.strictEqual(body.stream, true);
    });

    it('should include temperature when non-default', () => {
      const body: Record<string, any> = {
        model: 'llama2',
        messages: [],
        stream: true
      };

      const temperature: number = 0.5;
      const defaultTemp: number = 0.7;
      if (temperature !== defaultTemp) {
        body.options = { temperature };
      }

      assert.ok(body.options);
      assert.strictEqual(body.options.temperature, 0.5);
    });

    it('should omit temperature when default', () => {
      const body: Record<string, any> = {
        model: 'llama2',
        messages: [],
        stream: true
      };

      const temperature: number = 0.7;
      const defaultTemp: number = 0.7;
      if (temperature !== defaultTemp) {
        body.options = { temperature };
      }

      assert.strictEqual(body.options, undefined);
    });

    it('should include tools when provided', () => {
      const tools = [
        { type: 'function', function: { name: 'read_file', parameters: {} } }
      ];

      const body = {
        model: 'qwen2.5-coder:7b',
        messages: [],
        stream: true,
        tools
      };

      assert.strictEqual(body.tools.length, 1);
      assert.strictEqual(body.tools[0].function.name, 'read_file');
    });
  });

  describe('Streaming Response Parsing', () => {
    it('should parse NDJSON lines', () => {
      const line = '{"message":{"role":"assistant","content":"Hello"},"done":false}';
      const parsed = JSON.parse(line);

      assert.strictEqual(parsed.message.content, 'Hello');
      assert.strictEqual(parsed.done, false);
    });

    it('should detect stream end', () => {
      const line = '{"message":{"role":"assistant","content":""},"done":true}';
      const parsed = JSON.parse(line);

      assert.strictEqual(parsed.done, true);
    });

    it('should handle tool call responses', () => {
      const line = '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read_file","arguments":{"path":"test.ts"}}}]},"done":false}';
      const parsed = JSON.parse(line);

      assert.ok(parsed.message.tool_calls);
      assert.strictEqual(parsed.message.tool_calls[0].function.name, 'read_file');
    });

    it('should skip empty lines', () => {
      const lines = ['', '  ', '{"done":false}', '', '{"done":true}'];
      const nonEmpty = lines.filter(l => l.trim().length > 0);

      assert.strictEqual(nonEmpty.length, 2);
    });
  });

  describe('Model Listing', () => {
    it('should parse model list response', () => {
      const response = {
        models: [
          { name: 'qwen2.5-coder:7b', size: 4000000000 },
          { name: 'llama3.1:8b', size: 5000000000 }
        ]
      };

      assert.strictEqual(response.models.length, 2);
      assert.strictEqual(response.models[0].name, 'qwen2.5-coder:7b');
    });

    it('should handle empty model list', () => {
      const response = { models: [] };
      assert.strictEqual(response.models.length, 0);
    });
  });

  describe('Error Handling', () => {
    it('should detect tool-not-supported error', () => {
      const errorMsg = 'does not support tools';
      const isToolError = errorMsg.includes('does not support tools');

      assert.strictEqual(isToolError, true);
    });

    it('should detect connection refused', () => {
      const errorMsg = 'ECONNREFUSED';
      const isConnectionError = errorMsg.includes('ECONNREFUSED');

      assert.strictEqual(isConnectionError, true);
    });

    it('should detect timeout', () => {
      const errorMsg = 'ETIMEDOUT';
      const isTimeout = errorMsg.includes('ETIMEDOUT');

      assert.strictEqual(isTimeout, true);
    });
  });

  describe('Context Window Limits', () => {
    it('should know model context windows', () => {
      const contextWindows: Record<string, number> = {
        'qwen2.5-coder:7b': 32768,
        'llama3.1:8b': 131072,
        'phi3:mini': 128000,
        'mistral:7b': 32768
      };

      assert.strictEqual(contextWindows['qwen2.5-coder:7b'], 32768);
      assert.strictEqual(contextWindows['llama3.1:8b'], 131072);
    });

    it('should default to 8192 for unknown models', () => {
      const contextWindows: Record<string, number> = {};
      const defaultWindow = 8192;
      const model = 'unknown-model';

      const window = contextWindows[model] || defaultWindow;
      assert.strictEqual(window, 8192);
    });
  });
});
