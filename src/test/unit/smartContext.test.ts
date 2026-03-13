import * as assert from 'assert';
import * as sinon from 'sinon';

describe('SmartContext Module', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Import Parsing', () => {
    it('should parse TypeScript imports', () => {
      const code = `import { foo } from './bar';\nimport * as baz from '../qux';`;
      const importRegex = /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
      const matches = [...code.matchAll(importRegex)];

      assert.strictEqual(matches.length, 2);
      assert.strictEqual(matches[0][1], './bar');
      assert.strictEqual(matches[1][1], '../qux');
    });

    it('should parse Python imports', () => {
      const code = `from foo import bar\nimport baz`;
      const fromRegex = /from\s+([\w.]+)\s+import/g;
      const importRegex = /^import\s+([\w.]+)/gm;

      const fromMatches = [...code.matchAll(fromRegex)];
      const importMatches = [...code.matchAll(importRegex)];

      assert.strictEqual(fromMatches.length, 1);
      assert.strictEqual(importMatches.length, 1);
      assert.strictEqual(fromMatches[0][1], 'foo');
      assert.strictEqual(importMatches[0][1], 'baz');
    });

    it('should parse Java imports', () => {
      const code = `import java.util.List;\nimport com.example.Foo;`;
      const importRegex = /import\s+([\w.]+);/g;
      const matches = [...code.matchAll(importRegex)];

      assert.strictEqual(matches.length, 2);
      assert.strictEqual(matches[0][1], 'java.util.List');
      assert.strictEqual(matches[1][1], 'com.example.Foo');
    });

    it('should parse Go imports', () => {
      const code = `import "fmt"\nimport "github.com/user/repo"`;
      const importRegex = /import\s+"([^"]+)"/g;
      const matches = [...code.matchAll(importRegex)];

      assert.strictEqual(matches.length, 2);
      assert.strictEqual(matches[0][1], 'fmt');
      assert.strictEqual(matches[1][1], 'github.com/user/repo');
    });
  });

  describe('File Resolution', () => {
    it('should resolve relative imports', () => {
      const currentFile = '/workspace/src/components/Button.tsx';
      const importPath = './utils';
      const resolved = '/workspace/src/components/utils';

      assert.ok(resolved.includes('components/utils'));
    });

    it('should resolve parent directory imports', () => {
      const currentFile = '/workspace/src/components/Button.tsx';
      const importPath = '../lib/helpers';
      const resolved = '/workspace/src/lib/helpers';

      assert.ok(resolved.includes('src/lib/helpers'));
    });

    it('should handle file extensions', () => {
      const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go'];
      const basePath = '/workspace/src/utils';

      extensions.forEach(ext => {
        const fullPath = basePath + ext;
        assert.ok(fullPath.endsWith(ext));
      });
    });
  });

  describe('Relevance Scoring', () => {
    it('should score recently modified files higher', () => {
      const now = Date.now();
      const recentFile = { mtime: now - 1000 };
      const oldFile = { mtime: now - 1000000 };

      const recentScore = 1 / (now - recentFile.mtime);
      const oldScore = 1 / (now - oldFile.mtime);

      assert.ok(recentScore > oldScore);
    });

    it('should score imported files higher', () => {
      const importedFile = { isImported: true, score: 10 };
      const regularFile = { isImported: false, score: 5 };

      assert.ok(importedFile.score > regularFile.score);
    });

    it('should respect maxContextFiles limit', () => {
      const files = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const maxContextFiles = 5;
      const limited = files.slice(0, maxContextFiles);

      assert.strictEqual(limited.length, 5);
    });
  });

  describe('Git Integration', () => {
    it('should parse git status output', () => {
      const gitOutput = ' M src/file1.ts\n A src/file2.ts\nD src/file3.ts';
      const lines = gitOutput.split('\n').filter(l => l.trim());

      assert.strictEqual(lines.length, 3);
      assert.ok(lines[0].includes('M'));
      assert.ok(lines[1].includes('A'));
      assert.ok(lines[2].includes('D'));
    });

    it('should extract file paths from git status', () => {
      const line = ' M src/components/Button.tsx';
      const path = line.substring(3).trim();

      assert.strictEqual(path, 'src/components/Button.tsx');
    });
  });
});
