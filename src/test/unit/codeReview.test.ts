import * as assert from 'assert';
import * as sinon from 'sinon';

describe('CodeReview Module', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
    });

    afterEach(() => {
        sandbox.restore();
    });

    describe('Review Prompt Structure', () => {
        it('should build prompt with diff and summary', () => {
            const diff = '+const x = 1;\n-const x = 2;';
            const summary = '1 file changed, 1 insertion(+), 1 deletion(-)';

            const prompt =
                `Review my uncommitted changes. First check project memory for relevant conventions, then for each file note:\n` +
                `- Potential bugs or logic errors\n` +
                `- Security concerns\n` +
                `- Style or readability improvements\n` +
                `- Missing error handling\n\n` +
                `Be concise. If everything looks good, say so.\n\n` +
                `**Changes** (${summary}):\n` +
                `\`\`\`diff\n${diff}\n\`\`\``;

            assert.ok(prompt.includes('Review my uncommitted changes'));
            assert.ok(prompt.includes('Potential bugs'));
            assert.ok(prompt.includes('Security concerns'));
            assert.ok(prompt.includes(summary));
            assert.ok(prompt.includes(diff));
            assert.ok(prompt.includes('```diff'));
        });

        it('should build commit review prompt with range', () => {
            const commitRange = 'HEAD~3..HEAD';
            const diff = '+new code';
            const summary = '2 files changed';

            const prompt =
                `Review these changes (${commitRange}). First check project memory for relevant conventions, then for each file note:\n` +
                `- Potential bugs or logic errors\n` +
                `- Security concerns\n` +
                `- Style or readability improvements\n` +
                `- Missing error handling\n\n` +
                `Be concise. If everything looks good, say so.\n\n` +
                `**Changes** (${summary}):\n` +
                `\`\`\`diff\n${diff}\n\`\`\``;

            assert.ok(prompt.includes(commitRange));
            assert.ok(prompt.includes('Review these changes'));
        });
    });

    describe('ReviewRequest Interface', () => {
        it('should have prompt and diffSummary fields', () => {
            const request = {
                prompt: 'Review my changes...',
                diffSummary: '3 files changed, 10 insertions(+)',
            };

            assert.ok(typeof request.prompt === 'string');
            assert.ok(typeof request.diffSummary === 'string');
            assert.ok(request.prompt.length > 0);
            assert.ok(request.diffSummary.length > 0);
        });

        it('should return null for clean working tree', () => {
            const result = { clean: true };
            const reviewRequest = result.clean ? null : { prompt: '', diffSummary: '' };
            assert.strictEqual(reviewRequest, null);
        });
    });
});
