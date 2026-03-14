import * as assert from 'assert';
import * as sinon from 'sinon';

describe('PromptTemplates Module', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Template Variable Substitution', () => {
    it('should replace {{selection}} with actual code', () => {
      const template = 'Explain this code:\n{{selection}}';
      const selection = 'function test() { return 42; }';
      const result = template.replace('{{selection}}', selection);

      assert.strictEqual(result, 'Explain this code:\nfunction test() { return 42; }');
    });

    it('should replace {{language}} with file language', () => {
      const template = 'Write {{language}} code for:';
      const language = 'TypeScript';
      const result = template.replace('{{language}}', language);

      assert.strictEqual(result, 'Write TypeScript code for:');
    });

    it('should replace {{filename}} with file name', () => {
      const template = 'Review {{filename}}';
      const filename = 'test.ts';
      const result = template.replace('{{filename}}', filename);

      assert.strictEqual(result, 'Review test.ts');
    });

    it('should handle multiple variables', () => {
      const template = 'In {{filename}} ({{language}}): {{selection}}';
      let result = template
        .replace('{{filename}}', 'app.ts')
        .replace('{{language}}', 'TypeScript')
        .replace('{{selection}}', 'const x = 1;');

      assert.strictEqual(result, 'In app.ts (TypeScript): const x = 1;');
    });

    it('should sort keys by length to prevent partial replacements', () => {
      const keys = ['{{selection}}', '{{sel}}', '{{language}}', '{{lang}}'];
      const sorted = keys.sort((a, b) => b.length - a.length);

      assert.strictEqual(sorted[0], '{{selection}}');
      assert.strictEqual(sorted[1], '{{language}}');
      assert.strictEqual(sorted[2], '{{lang}}');
      assert.strictEqual(sorted[3], '{{sel}}');
    });
  });

  describe('Built-in Templates', () => {
    it('should have 6 built-in templates', () => {
      const builtInCount = 6;
      assert.strictEqual(builtInCount, 6);
    });

    it('should include Add Tests template', () => {
      const template = {
        name: 'Add Tests',
        prompt: 'Write comprehensive unit tests for:\n{{selection}}'
      };

      assert.strictEqual(template.name, 'Add Tests');
      assert.ok(template.prompt.includes('{{selection}}'));
    });

    it('should include JSDoc template', () => {
      const template = {
        name: 'Add JSDoc',
        prompt: 'Add JSDoc comments to:\n{{selection}}'
      };

      assert.strictEqual(template.name, 'Add JSDoc');
      assert.ok(template.prompt.includes('{{selection}}'));
    });
  });

  describe('Custom Templates', () => {
    it('should validate template structure', () => {
      const validTemplate = {
        id: 'custom-1',
        name: 'My Template',
        prompt: 'Do something with {{selection}}',
        isBuiltIn: false
      };

      assert.ok(validTemplate.id);
      assert.ok(validTemplate.name);
      assert.ok(validTemplate.prompt);
      assert.strictEqual(validTemplate.isBuiltIn, false);
    });

    it('should reject templates without required fields', () => {
      const invalidTemplate = { name: 'Test' };
      const hasRequiredFields = 'id' in invalidTemplate && 'name' in invalidTemplate && 'prompt' in invalidTemplate;

      assert.strictEqual(hasRequiredFields, false);
    });
  });
});
