import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// E2E-style tests that exercise real module code (not mocks).
// Only modules without vscode dependency can be tested here.
// Modules with vscode dependency are tested via @vscode/test-electron integration tests.

describe('E2E: Workspace Module', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-e2e-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should detect Python project type', () => {
        const { detectProjectType } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==2.0\n');
        assert.strictEqual(detectProjectType(tmpDir), 'Python');
    });

    it('should detect Python environment with ruff and pytest', async () => {
        const { detectPythonEnvironment } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask\n');
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[tool.ruff]\nline-length = 88\n[tool.pytest]\n');
        fs.mkdirSync(path.join(tmpDir, 'venv'));
        fs.writeFileSync(path.join(tmpDir, 'venv', 'pyvenv.cfg'), 'home = /usr/bin\n');

        const env = await detectPythonEnvironment(tmpDir);
        assert.ok(env);
        assert.strictEqual(env.linter, 'ruff');
        assert.strictEqual(env.testFramework, 'pytest');
        assert.ok(env.venvPath);
        assert.strictEqual(env.packageManager, 'pip');
    });

    it('should detect poetry package manager', async () => {
        const { detectPythonEnvironment } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[tool.poetry]\nname = "test"\n');
        fs.writeFileSync(path.join(tmpDir, 'poetry.lock'), '');
        const env = await detectPythonEnvironment(tmpDir);
        assert.ok(env);
        assert.strictEqual(env.packageManager, 'poetry');
    });

    it('should detect mypy type checker', async () => {
        const { detectPythonEnvironment } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'mypy\n');
        fs.writeFileSync(path.join(tmpDir, 'mypy.ini'), '[mypy]\n');
        const env = await detectPythonEnvironment(tmpDir);
        assert.ok(env);
        assert.strictEqual(env.typeChecker, 'mypy');
    });

    it('should return null for non-Python projects', async () => {
        const { detectPythonEnvironment } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        const env = await detectPythonEnvironment(tmpDir);
        assert.strictEqual(env, null);
    });

    it('should detect Node.js project type', () => {
        const { detectProjectType } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        assert.strictEqual(detectProjectType(tmpDir), 'Node.js / TypeScript');
    });

    it('should detect Rust project type', () => {
        const { detectProjectType } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\n');
        assert.strictEqual(detectProjectType(tmpDir), 'Rust');
    });

    it('should detect Go project type', () => {
        const { detectProjectType } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\n');
        assert.strictEqual(detectProjectType(tmpDir), 'Go');
    });

    it('should build file tree with correct structure', () => {
        const { buildFileTree } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'index.js'), '');
        fs.mkdirSync(path.join(tmpDir, 'src'));
        fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), '');

        const tree = buildFileTree(tmpDir, 2);
        assert.ok(tree.includes('src/'));
        assert.ok(tree.includes('index.js'));
        assert.ok(tree.includes('app.js'));
    });

    it('should skip node_modules in file tree', () => {
        const { buildFileTree } = require('../../workspace');
        fs.mkdirSync(path.join(tmpDir, 'node_modules'));
        fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), '');
        fs.writeFileSync(path.join(tmpDir, 'index.js'), '');

        const tree = buildFileTree(tmpDir, 2);
        assert.ok(!tree.includes('node_modules'));
        assert.ok(tree.includes('index.js'));
    });

    it('should build workspace summary with Python environment', async () => {
        const { buildWorkspaceSummary } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask\n');
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[tool.ruff]\n[tool.pytest]\n');

        const summary = await buildWorkspaceSummary(tmpDir);
        assert.ok(summary.includes('Python'));
        assert.ok(summary.includes('Python environment'));
        assert.ok(summary.includes('ruff'));
        assert.ok(summary.includes('pytest'));
    });

    it('should get recently modified files', () => {
        const { getRecentlyModifiedFiles } = require('../../workspace');
        fs.writeFileSync(path.join(tmpDir, 'old.txt'), 'old');
        fs.writeFileSync(path.join(tmpDir, 'new.txt'), 'new');

        const recent = getRecentlyModifiedFiles(tmpDir, 5);
        assert.ok(recent.length >= 2);
        assert.ok(recent.includes('old.txt'));
        assert.ok(recent.includes('new.txt'));
    });

    it('should format Python environment details', () => {
        const { formatPythonEnvironment } = require('../../workspace');
        const env = {
            pythonVersion: 'Python 3.11.0',
            venvPath: '/tmp/venv',
            packageManager: 'poetry',
            linter: 'ruff',
            typeChecker: 'mypy',
            testFramework: 'pytest',
            formatter: 'black',
        };
        const formatted = formatPythonEnvironment(env);
        assert.ok(formatted.includes('Python 3.11.0'));
        assert.ok(formatted.includes('poetry'));
        assert.ok(formatted.includes('ruff'));
        assert.ok(formatted.includes('mypy'));
        assert.ok(formatted.includes('pytest'));
        assert.ok(formatted.includes('black'));
    });
});
