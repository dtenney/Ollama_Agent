import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
    buildFileTree,
    detectProjectType,
    getKeyFilesSummary,
    getRecentlyModifiedFiles,
    buildWorkspaceSummary,
    SKIP_DIRS,
} from '../../workspace';

describe('Workspace Module', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollamapilot-ws-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('SKIP_DIRS', () => {
        it('should contain common build/dependency directories', () => {
            assert.ok(SKIP_DIRS.has('node_modules'));
            assert.ok(SKIP_DIRS.has('.git'));
            assert.ok(SKIP_DIRS.has('dist'));
            assert.ok(SKIP_DIRS.has('__pycache__'));
            assert.ok(SKIP_DIRS.has('coverage'));
        });
    });

    describe('buildFileTree', () => {
        it('should build tree for empty directory', () => {
            const tree = buildFileTree(tmpDir);
            assert.ok(tree.includes(path.basename(tmpDir)));
        });

        it('should include files and directories', () => {
            fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'content');
            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'content');

            const tree = buildFileTree(tmpDir);
            assert.ok(tree.includes('src/'));
            assert.ok(tree.includes('file.ts'));
            assert.ok(tree.includes('main.ts'));
        });

        it('should skip node_modules and .git', () => {
            fs.mkdirSync(path.join(tmpDir, 'node_modules'));
            fs.mkdirSync(path.join(tmpDir, '.git'));
            fs.writeFileSync(path.join(tmpDir, 'index.ts'), '');

            const tree = buildFileTree(tmpDir);
            assert.ok(!tree.includes('node_modules'));
            assert.ok(!tree.includes('.git'));
            assert.ok(tree.includes('index.ts'));
        });

        it('should respect maxDepth', () => {
            fs.mkdirSync(path.join(tmpDir, 'a'));
            fs.mkdirSync(path.join(tmpDir, 'a', 'b'));
            fs.mkdirSync(path.join(tmpDir, 'a', 'b', 'c'));
            fs.writeFileSync(path.join(tmpDir, 'a', 'b', 'c', 'deep.ts'), '');

            const shallow = buildFileTree(tmpDir, 1);
            assert.ok(shallow.includes('a/'));
            assert.ok(shallow.includes('b/'));
            // depth=1 means we see a/ and a/b/ but not a/b/c/
            const deep = buildFileTree(tmpDir, 3);
            assert.ok(deep.includes('deep.ts'));
        });
    });

    describe('detectProjectType', () => {
        it('should detect Node.js project', () => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            assert.strictEqual(detectProjectType(tmpDir), 'Node.js / TypeScript');
        });

        it('should detect Python project', () => {
            fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '');
            assert.strictEqual(detectProjectType(tmpDir), 'Python');
        });

        it('should detect Rust project', () => {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '');
            assert.strictEqual(detectProjectType(tmpDir), 'Rust');
        });

        it('should detect Go project', () => {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), '');
            assert.strictEqual(detectProjectType(tmpDir), 'Go');
        });

        it('should return Unknown for empty directory', () => {
            assert.strictEqual(detectProjectType(tmpDir), 'Unknown');
        });
    });

    describe('getKeyFilesSummary', () => {
        it('should parse package.json', () => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                name: 'test-project',
                version: '1.0.0',
                description: 'A test project',
                scripts: { build: 'tsc', test: 'mocha' },
                dependencies: { express: '^4.0.0' },
            }));

            const summary = getKeyFilesSummary(tmpDir);
            assert.ok(summary.includes('test-project'));
            assert.ok(summary.includes('A test project'));
            assert.ok(summary.includes('build'));
            assert.ok(summary.includes('express'));
        });

        it('should include README first lines', () => {
            fs.writeFileSync(path.join(tmpDir, 'README.md'), '# My Project\n\nThis is a test.\nLine 3\n');
            const summary = getKeyFilesSummary(tmpDir);
            assert.ok(summary.includes('# My Project'));
            assert.ok(summary.includes('README.md'));
        });

        it('should note presence of tsconfig', () => {
            fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
            const summary = getKeyFilesSummary(tmpDir);
            assert.ok(summary.includes('tsconfig.json: present'));
        });

        it('should return fallback for empty directory', () => {
            const summary = getKeyFilesSummary(tmpDir);
            assert.ok(summary.includes('no key files found'));
        });
    });

    describe('getRecentlyModifiedFiles', () => {
        it('should return recently modified files sorted by mtime', () => {
            fs.writeFileSync(path.join(tmpDir, 'old.ts'), 'old');
            // Small delay to ensure different mtimes
            const now = Date.now();
            fs.utimesSync(path.join(tmpDir, 'old.ts'), new Date(now - 10000), new Date(now - 10000));
            fs.writeFileSync(path.join(tmpDir, 'new.ts'), 'new');

            const recent = getRecentlyModifiedFiles(tmpDir, 10);
            assert.ok(recent.length === 2);
            assert.strictEqual(recent[0], 'new.ts');
            assert.strictEqual(recent[1], 'old.ts');
        });

        it('should respect maxFiles limit', () => {
            for (let i = 0; i < 20; i++) {
                fs.writeFileSync(path.join(tmpDir, `file${i}.ts`), '');
            }
            const recent = getRecentlyModifiedFiles(tmpDir, 5);
            assert.strictEqual(recent.length, 5);
        });

        it('should skip node_modules', () => {
            fs.mkdirSync(path.join(tmpDir, 'node_modules'));
            fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), '');
            fs.writeFileSync(path.join(tmpDir, 'app.ts'), '');

            const recent = getRecentlyModifiedFiles(tmpDir);
            assert.ok(!recent.some(f => f.includes('node_modules')));
            assert.ok(recent.includes('app.ts'));
        });
    });

    describe('buildWorkspaceSummary', () => {
        it('should include project type and file tree', async () => {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'index.ts'), '');

            const summary = await buildWorkspaceSummary(tmpDir);
            assert.ok(summary.includes('Node.js / TypeScript'));
            assert.ok(summary.includes('File tree'));
            assert.ok(summary.includes('index.ts'));
        });

        it('should cache results for 30 seconds', async () => {
            fs.writeFileSync(path.join(tmpDir, 'a.ts'), '');
            const first = await buildWorkspaceSummary(tmpDir);

            // Add a new file — cached result should NOT include it
            fs.writeFileSync(path.join(tmpDir, 'b.ts'), '');
            const second = await buildWorkspaceSummary(tmpDir);

            assert.strictEqual(first, second);
        });
    });
});
