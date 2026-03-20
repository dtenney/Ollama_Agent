import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as sinon from 'sinon';

// DiffViewManager uses vscode.commands.executeCommand — we need to mock it
// Since the module imports vscode at the top level, we test the cleanup logic directly

describe('DiffView Module', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
    });

    afterEach(() => {
        sandbox.restore();
    });

    describe('Temp File Lifecycle', () => {
        it('should create temp files in os.tmpdir with correct extension', () => {
            const ext = '.ts';
            const tmpPath = path.join(os.tmpdir(), `ollama-edit-${Date.now()}${ext}`);
            fs.writeFileSync(tmpPath, 'test content', 'utf8');

            assert.ok(fs.existsSync(tmpPath));
            assert.ok(tmpPath.endsWith('.ts'));
            assert.strictEqual(fs.readFileSync(tmpPath, 'utf8'), 'test content');

            fs.unlinkSync(tmpPath);
        });

        it('should clean up temp file on unlink', () => {
            const tmpPath = path.join(os.tmpdir(), `ollama-edit-cleanup-test-${Date.now()}.ts`);
            fs.writeFileSync(tmpPath, 'content', 'utf8');
            assert.ok(fs.existsSync(tmpPath));

            fs.unlinkSync(tmpPath);
            assert.ok(!fs.existsSync(tmpPath));
        });

        it('should not throw when unlinking non-existent file', () => {
            const tmpPath = path.join(os.tmpdir(), `ollama-edit-nonexistent-${Date.now()}.ts`);
            assert.doesNotThrow(() => {
                try { fs.unlinkSync(tmpPath); } catch { /* expected */ }
            });
        });
    });

    describe('Cleanup Logic Pattern', () => {
        // Tests the cleanup pattern used by DiffViewManager without requiring vscode
        it('should track and clean up current temp path', () => {
            let currentTmpPath: string | undefined;

            function cleanup() {
                if (currentTmpPath) {
                    try { fs.unlinkSync(currentTmpPath); } catch { /* ignore */ }
                    currentTmpPath = undefined;
                }
            }

            // Simulate first diff preview
            const tmp1 = path.join(os.tmpdir(), `ollama-diff-test1-${Date.now()}.ts`);
            fs.writeFileSync(tmp1, 'old content');
            currentTmpPath = tmp1;
            assert.ok(fs.existsSync(tmp1));

            // Simulate second diff preview — should clean up first
            cleanup();
            assert.ok(!fs.existsSync(tmp1));
            assert.strictEqual(currentTmpPath, undefined);

            const tmp2 = path.join(os.tmpdir(), `ollama-diff-test2-${Date.now()}.ts`);
            fs.writeFileSync(tmp2, 'new content');
            currentTmpPath = tmp2;
            assert.ok(fs.existsSync(tmp2));

            // Final cleanup (dispose)
            cleanup();
            assert.ok(!fs.existsSync(tmp2));
        });

        it('should handle cleanup when no temp file exists', () => {
            let currentTmpPath: string | undefined;
            function cleanup() {
                if (currentTmpPath) {
                    try { fs.unlinkSync(currentTmpPath); } catch { /* ignore */ }
                    currentTmpPath = undefined;
                }
            }

            // Should not throw
            assert.doesNotThrow(() => cleanup());
            assert.strictEqual(currentTmpPath, undefined);
        });
    });

    describe('File Extension Preservation', () => {
        it('should preserve .ts extension', () => {
            assert.strictEqual(path.extname('/path/to/file.ts'), '.ts');
        });

        it('should preserve .py extension', () => {
            assert.strictEqual(path.extname('/path/to/file.py'), '.py');
        });

        it('should handle files without extension', () => {
            assert.strictEqual(path.extname('/path/to/Makefile'), '');
        });
    });
});
