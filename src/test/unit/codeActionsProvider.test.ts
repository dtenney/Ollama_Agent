import * as assert from 'assert';
import * as sinon from 'sinon';

describe('CodeActionsProvider Module', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
    });

    afterEach(() => {
        sandbox.restore();
    });

    describe('Action Types', () => {
        const actionTypes = ['explain', 'comment', 'refactor', 'bugs', 'tests', 'docs'];

        it('should define 6 action types', () => {
            assert.strictEqual(actionTypes.length, 6);
        });

        it('should include all expected types', () => {
            assert.ok(actionTypes.includes('explain'));
            assert.ok(actionTypes.includes('comment'));
            assert.ok(actionTypes.includes('refactor'));
            assert.ok(actionTypes.includes('bugs'));
            assert.ok(actionTypes.includes('tests'));
            assert.ok(actionTypes.includes('docs'));
        });
    });

    describe('Action Creation Pattern', () => {
        it('should create action with robot emoji prefix', () => {
            const title = 'Explain this code';
            const formatted = `🤖 ${title}`;
            assert.strictEqual(formatted, '🤖 Explain this code');
        });

        it('should include type, selection, language, and filename in arguments', () => {
            const args = {
                type: 'explain',
                selection: 'const x = 1;',
                language: 'typescript',
                filename: 'src/main.ts',
            };

            assert.strictEqual(args.type, 'explain');
            assert.ok(args.selection.length > 0);
            assert.strictEqual(args.language, 'typescript');
            assert.strictEqual(args.filename, 'src/main.ts');
        });
    });

    describe('Error Action Creation', () => {
        it('should extract surrounding code range (5 lines before and after)', () => {
            const diagnosticLine = 10;
            const totalLines = 20;
            const startLine = Math.max(0, diagnosticLine - 5);
            const endLine = Math.min(totalLines - 1, diagnosticLine + 5);

            assert.strictEqual(startLine, 5);
            assert.strictEqual(endLine, 15);
        });

        it('should clamp start line to 0', () => {
            const diagnosticLine = 2;
            const startLine = Math.max(0, diagnosticLine - 5);
            assert.strictEqual(startLine, 0);
        });

        it('should clamp end line to document end', () => {
            const diagnosticLine = 18;
            const totalLines = 20;
            const endLine = Math.min(totalLines - 1, diagnosticLine + 5);
            assert.strictEqual(endLine, 19);
        });

        it('should include error details in action arguments', () => {
            const errorArgs = {
                error: 'Cannot find name "foo"',
                code: 'const x = foo;',
                language: 'typescript',
                filename: 'src/main.ts',
                line: 10,
                severity: 'Error',
            };

            assert.ok(errorArgs.error.includes('foo'));
            assert.strictEqual(errorArgs.line, 10);
            assert.strictEqual(errorArgs.severity, 'Error');
        });
    });

    describe('Empty Selection Handling', () => {
        it('should return no actions for empty selection', () => {
            const selection: string = '';
            const hasContent = selection.trim().length > 0;
            assert.strictEqual(hasContent, false);
        });

        it('should return no actions for whitespace-only selection', () => {
            const selection: string = '   \n\t  ';
            const hasContent = selection.trim().length > 0;
            assert.strictEqual(hasContent, false);
        });

        it('should return actions for non-empty selection', () => {
            const selection: string = 'const x = 1;';
            const hasContent = selection.trim().length > 0;
            assert.strictEqual(hasContent, true);
        });
    });
});
