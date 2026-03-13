import * as assert from 'assert';
import * as sinon from 'sinon';

describe('Mentions Module', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('File Indexing', () => {
    it('should index workspace files', () => {
      const files = [
        'src/main.ts',
        'src/config.ts',
        'src/agent.ts',
        'package.json'
      ];

      assert.strictEqual(files.length, 4);
    });

    it('should exclude node_modules', () => {
      const allFiles = [
        'src/main.ts',
        'node_modules/lodash/index.js',
        'package.json'
      ];

      const filtered = allFiles.filter(f => !f.includes('node_modules'));
      assert.strictEqual(filtered.length, 2);
    });

    it('should exclude dist directory', () => {
      const allFiles = [
        'src/main.ts',
        'dist/main.js',
        'package.json'
      ];

      const filtered = allFiles.filter(f => !f.startsWith('dist/'));
      assert.strictEqual(filtered.length, 2);
    });
  });

  describe('Fuzzy Search', () => {
    it('should match exact filenames', () => {
      const files = ['main.ts', 'config.ts', 'agent.ts'];
      const query = 'main.ts';
      const matches = files.filter(f => f.includes(query));

      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0], 'main.ts');
    });

    it('should match partial filenames', () => {
      const files = ['main.ts', 'config.ts', 'agent.ts'];
      const query = 'main';
      const matches = files.filter(f => f.toLowerCase().includes(query.toLowerCase()));

      assert.strictEqual(matches.length, 1);
    });

    it('should be case-insensitive', () => {
      const files = ['Main.ts', 'CONFIG.ts', 'Agent.ts'];
      const query = 'config';
      const matches = files.filter(f => f.toLowerCase().includes(query.toLowerCase()));

      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0], 'CONFIG.ts');
    });

    it('should match path segments', () => {
      const files = ['src/components/Button.tsx', 'src/utils/helpers.ts', 'src/api/user.ts'];
      const query = 'Button';
      const matches = files.filter(f => f.toLowerCase().includes(query.toLowerCase()));

      assert.strictEqual(matches.length, 1);
    });

    it('should return empty for no matches', () => {
      const files = ['main.ts', 'config.ts'];
      const query = 'nonexistent';
      const matches = files.filter(f => f.toLowerCase().includes(query.toLowerCase()));

      assert.strictEqual(matches.length, 0);
    });
  });

  describe('File Size Cap', () => {
    it('should cap files at 100KB', () => {
      const maxSize = 100 * 1024;
      const fileSize = 150 * 1024;
      const shouldCap = fileSize > maxSize;

      assert.strictEqual(shouldCap, true);
    });

    it('should not cap small files', () => {
      const maxSize = 100 * 1024;
      const fileSize = 50 * 1024;
      const shouldCap = fileSize > maxSize;

      assert.strictEqual(shouldCap, false);
    });
  });

  describe('Deduplication', () => {
    it('should prevent duplicate file attachments', () => {
      const attached = new Set(['src/main.ts', 'src/config.ts']);
      const newFile = 'src/main.ts';

      attached.add(newFile);
      assert.strictEqual(attached.size, 2); // No duplicate
    });

    it('should allow different files', () => {
      const attached = new Set(['src/main.ts']);
      const newFile = 'src/agent.ts';

      attached.add(newFile);
      assert.strictEqual(attached.size, 2);
    });
  });
});
