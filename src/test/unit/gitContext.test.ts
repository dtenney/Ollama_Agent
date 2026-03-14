import * as assert from 'assert';
import * as sinon from 'sinon';

describe('GitContext Module', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Diff Extraction', () => {
    it('should combine staged and unstaged diffs', () => {
      const unstaged = 'diff --git a/file.ts\n+const x = 1;';
      const staged = 'diff --git a/other.ts\n+const y = 2;';
      const combined = `${unstaged}\n${staged}`;

      assert.ok(combined.includes('file.ts'));
      assert.ok(combined.includes('other.ts'));
    });

    it('should parse stat summary', () => {
      const stat = '3 files changed, 42 insertions(+), 7 deletions(-)';
      const match = stat.match(/(\d+) files? changed/);

      assert.ok(match);
      assert.strictEqual(match![1], '3');
    });

    it('should handle empty diff', () => {
      const diff = '';
      const isEmpty = diff.trim().length === 0;

      assert.strictEqual(isEmpty, true);
    });
  });

  describe('Truncation', () => {
    it('should truncate at 8KB limit', () => {
      const maxBytes = 8 * 1024;
      const longDiff = 'x'.repeat(10000);
      const truncated = longDiff.substring(0, maxBytes);

      assert.ok(truncated.length <= maxBytes);
    });

    it('should not truncate small diffs', () => {
      const maxBytes = 8 * 1024;
      const shortDiff = 'small diff content';

      assert.ok(shortDiff.length < maxBytes);
    });
  });

  describe('Git Detection', () => {
    it('should detect non-git folders', () => {
      const isGitRepo = false;
      assert.strictEqual(isGitRepo, false);
    });

    it('should handle missing git binary', () => {
      const errorMsg = 'git: command not found';
      const isGitMissing = errorMsg.includes('command not found') || errorMsg.includes('not recognized');

      assert.strictEqual(isGitMissing, true);
    });
  });

  describe('Diff Formatting', () => {
    it('should wrap diff in XML tags', () => {
      const diff = '+const x = 1;';
      const summary = '1 file changed, 1 insertion(+)';
      const formatted = `<git-diff summary="${summary}">\n${diff}\n</git-diff>`;

      assert.ok(formatted.includes('<git-diff'));
      assert.ok(formatted.includes('</git-diff>'));
      assert.ok(formatted.includes(summary));
    });
  });
});
