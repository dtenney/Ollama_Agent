import * as assert from 'assert';

// Replicate the pattern definitions from codeLensProvider.ts for testing
const FUNCTION_PATTERNS: Record<string, RegExp[]> = {
    typescript:  [/^\s*(export\s+)?(async\s+)?function\s+\w+/,  /^\s*(public|private|protected|static|async)\s+\w+\s*\(/, /^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/],
    javascript:  [/^\s*(export\s+)?(async\s+)?function\s+\w+/,  /^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/],
    python:      [/^\s*(async\s+)?def\s+\w+/,                   /^\s*class\s+\w+/],
    java:        [/^\s*(public|private|protected|static)\s+[\w<>\[\]]+\s+\w+\s*\(/],
    go:          [/^\s*func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/],
    rust:        [/^\s*(pub\s+)?(async\s+)?fn\s+\w+/,           /^\s*(pub\s+)?struct\s+\w+/],
};

const ALIASES: Record<string, string> = {
    typescriptreact: 'typescript',
    javascriptreact: 'javascript',
};

function getPatternKey(languageId: string): string | undefined {
    return ALIASES[languageId] || (FUNCTION_PATTERNS[languageId] ? languageId : undefined);
}

function matchesAny(line: string, patterns: RegExp[]): boolean {
    return patterns.some(p => p.test(line));
}

describe('CodeLensProvider Module', () => {

    describe('Language Pattern Key Resolution', () => {
        it('should resolve typescript', () => {
            assert.strictEqual(getPatternKey('typescript'), 'typescript');
        });

        it('should resolve typescriptreact to typescript', () => {
            assert.strictEqual(getPatternKey('typescriptreact'), 'typescript');
        });

        it('should resolve javascriptreact to javascript', () => {
            assert.strictEqual(getPatternKey('javascriptreact'), 'javascript');
        });

        it('should return undefined for unsupported languages', () => {
            assert.strictEqual(getPatternKey('markdown'), undefined);
            assert.strictEqual(getPatternKey('json'), undefined);
        });
    });

    describe('TypeScript/JavaScript Patterns', () => {
        const patterns = FUNCTION_PATTERNS.typescript;

        it('should match function declarations', () => {
            assert.ok(matchesAny('function hello() {', patterns));
            assert.ok(matchesAny('export function hello() {', patterns));
            assert.ok(matchesAny('async function fetchData() {', patterns));
            assert.ok(matchesAny('export async function fetchData() {', patterns));
        });

        it('should match arrow functions assigned to const', () => {
            assert.ok(matchesAny('const handler = (req, res) => {', patterns));
            assert.ok(matchesAny('const handler = async (req, res) => {', patterns));
        });

        it('should match class methods', () => {
            assert.ok(matchesAny('  public getData() {', patterns));
            assert.ok(matchesAny('  private _init() {', patterns));
            assert.ok(matchesAny('  async run() {', patterns));
        });

        it('should not match plain variable assignments', () => {
            assert.ok(!matchesAny('const x = 1;', patterns));
            assert.ok(!matchesAny('let name = "hello";', patterns));
        });
    });

    describe('Python Patterns', () => {
        const patterns = FUNCTION_PATTERNS.python;

        it('should match def statements', () => {
            assert.ok(matchesAny('def hello():', patterns));
            assert.ok(matchesAny('async def fetch_data():', patterns));
            assert.ok(matchesAny('    def _private_method(self):', patterns));
        });

        it('should match class statements', () => {
            assert.ok(matchesAny('class MyClass:', patterns));
            assert.ok(matchesAny('class MyClass(Base):', patterns));
        });

        it('should not match comments or strings', () => {
            assert.ok(!matchesAny('# def not_a_function():', patterns));
            assert.ok(!matchesAny('x = "def fake():"', patterns));
        });
    });

    describe('Go Patterns', () => {
        const patterns = FUNCTION_PATTERNS.go;

        it('should match standalone functions', () => {
            assert.ok(matchesAny('func main() {', patterns));
            assert.ok(matchesAny('func handleRequest(w http.ResponseWriter) {', patterns));
        });

        it('should match method receivers', () => {
            assert.ok(matchesAny('func (s *Server) Start() {', patterns));
        });
    });

    describe('Rust Patterns', () => {
        const patterns = FUNCTION_PATTERNS.rust;

        it('should match fn declarations', () => {
            assert.ok(matchesAny('fn main() {', patterns));
            assert.ok(matchesAny('pub fn new() -> Self {', patterns));
            assert.ok(matchesAny('pub async fn fetch() {', patterns));
        });

        it('should match struct declarations', () => {
            assert.ok(matchesAny('struct Config {', patterns));
            assert.ok(matchesAny('pub struct Server {', patterns));
        });
    });
});
