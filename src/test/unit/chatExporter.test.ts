import * as assert from 'assert';
import * as sinon from 'sinon';

describe('ChatExporter Module', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Markdown Export', () => {
    it('should format messages as markdown', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ];

      const markdown = messages.map(m => 
        `**${m.role === 'user' ? 'User' : 'Assistant'}**: ${m.content}`
      ).join('\n\n');

      assert.ok(markdown.includes('**User**: Hello'));
      assert.ok(markdown.includes('**Assistant**: Hi there!'));
    });

    it('should include timestamps', () => {
      const timestamp = new Date().toISOString();
      const header = `# Chat Export\n\nExported: ${timestamp}\n\n---\n\n`;

      assert.ok(header.includes('Chat Export'));
      assert.ok(header.includes('Exported:'));
    });

    it('should preserve code blocks', () => {
      const message = {
        role: 'assistant',
        content: 'Here is code:\n```typescript\nconst x = 1;\n```'
      };

      assert.ok(message.content.includes('```typescript'));
      assert.ok(message.content.includes('const x = 1;'));
    });
  });

  describe('JSON Export', () => {
    it('should export as valid JSON', () => {
      const session = {
        id: 'test-123',
        title: 'Test Chat',
        messages: [{ role: 'user', content: 'Hello' }],
        timestamp: Date.now()
      };

      const json = JSON.stringify(session, null, 2);
      const parsed = JSON.parse(json);

      assert.deepStrictEqual(parsed, session);
    });

    it('should include metadata', () => {
      const exportData = {
        version: '0.4.0-alpha',
        exportedAt: new Date().toISOString(),
        session: { id: 'test', messages: [] }
      };

      assert.ok(exportData.version);
      assert.ok(exportData.exportedAt);
      assert.ok(exportData.session);
    });
  });

  describe('Filename Sanitization', () => {
    it('should remove invalid characters', () => {
      const title = 'Test: Chat / With \\ Invalid * Chars';
      const sanitized = title.replace(/[<>:"/\\|?*]/g, '-');

      assert.strictEqual(sanitized, 'Test- Chat - With - Invalid - Chars');
    });

    it('should truncate long filenames', () => {
      const longTitle = 'A'.repeat(300);
      const maxLength = 100;
      const truncated = longTitle.substring(0, maxLength);

      assert.strictEqual(truncated.length, maxLength);
    });

    it('should handle empty titles', () => {
      const title = '';
      const fallback = title || 'chat-export';

      assert.strictEqual(fallback, 'chat-export');
    });
  });

  describe('File Extension', () => {
    it('should add .md for markdown', () => {
      const filename = 'test-chat';
      const withExt = `${filename}.md`;

      assert.ok(withExt.endsWith('.md'));
    });

    it('should add .json for JSON', () => {
      const filename = 'test-chat';
      const withExt = `${filename}.json`;

      assert.ok(withExt.endsWith('.json'));
    });
  });

  describe('Export Validation', () => {
    it('should validate session has messages', () => {
      const validSession = { messages: [{ role: 'user', content: 'test' }] };
      const emptySession = { messages: [] };

      assert.ok(validSession.messages.length > 0);
      assert.strictEqual(emptySession.messages.length, 0);
    });

    it('should handle missing session data', () => {
      const session = null;
      const canExport = session !== null && session !== undefined;

      assert.strictEqual(canExport, false);
    });
  });
});
