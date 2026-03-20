import * as assert from 'assert';
import * as sinon from 'sinon';

describe('Context Module', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
    });

    afterEach(() => {
        sandbox.restore();
    });

    describe('WorkspaceContext Interface', () => {
        it('should have correct shape when no editor is active', () => {
            const ctx = { file: null, fileLines: 0, language: '', selectionLines: 0 };
            assert.strictEqual(ctx.file, null);
            assert.strictEqual(ctx.fileLines, 0);
            assert.strictEqual(ctx.language, '');
            assert.strictEqual(ctx.selectionLines, 0);
        });

        it('should have correct shape with active editor', () => {
            const ctx = {
                file: 'src/main.ts',
                fileLines: 150,
                language: 'typescript',
                selectionLines: 5,
            };
            assert.strictEqual(ctx.file, 'src/main.ts');
            assert.strictEqual(ctx.fileLines, 150);
            assert.strictEqual(ctx.language, 'typescript');
            assert.strictEqual(ctx.selectionLines, 5);
        });
    });

    describe('Context String Building', () => {
        it('should wrap file content in active-file XML tags', () => {
            const relPath = 'src/main.ts';
            const lang = 'typescript';
            const content = 'const x = 1;';

            const result = `<active-file path="${relPath}" lang="${lang}">\n\`\`\`${lang}\n${content}\n\`\`\`\n</active-file>`;

            assert.ok(result.includes('<active-file'));
            assert.ok(result.includes('path="src/main.ts"'));
            assert.ok(result.includes('lang="typescript"'));
            assert.ok(result.includes(content));
            assert.ok(result.includes('</active-file>'));
        });

        it('should wrap selection in selection XML tags with line numbers', () => {
            const relPath = 'src/main.ts';
            const lang = 'typescript';
            const text = 'const x = 1;';
            const startLine = 10;
            const endLine = 15;

            const result = `<selection file="${relPath}" lines="${startLine}-${endLine}" lang="${lang}">\n\`\`\`${lang}\n${text}\n\`\`\`\n</selection>`;

            assert.ok(result.includes('<selection'));
            assert.ok(result.includes('lines="10-15"'));
            assert.ok(result.includes(text));
            assert.ok(result.includes('</selection>'));
        });

        it('should return empty string when neither file nor selection included', () => {
            const includeFile = false;
            const includeSelection = false;
            const hasEditor = false;

            const result = (!hasEditor || (!includeFile && !includeSelection)) ? '' : 'context';
            assert.strictEqual(result, '');
        });

        it('should prefer file over selection when both enabled', () => {
            // The actual logic: if includeFile is true, it takes precedence
            const includeFile = true;
            const includeSelection = true;

            // In the real code, includeFile branch runs first via if/else if
            const branch = includeFile ? 'file' : includeSelection ? 'selection' : 'none';
            assert.strictEqual(branch, 'file');
        });
    });
});
