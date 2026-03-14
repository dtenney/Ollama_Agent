# OllamaPilot Test Suite

Comprehensive test suite for OllamaPilot extension covering unit and integration tests.

## Test Structure

```
src/test/
├── unit/                      # Unit tests (no VS Code API)
│   ├── config.test.ts         # Configuration module tests
│   ├── chatStorage.test.ts    # Chat storage tests
│   ├── promptTemplates.test.ts # Template system tests
│   ├── memoryCore.test.ts     # Memory tier system tests
│   ├── smartContext.test.ts   # Smart context selection tests
│   ├── symbolProvider.test.ts # Symbol indexing tests
│   ├── multiWorkspace.test.ts # Multi-workspace tests
│   └── chatExporter.test.ts   # Export functionality tests
├── integration/               # Integration tests (with VS Code API)
│   ├── extension.test.ts      # Extension activation tests
│   └── index.ts              # Test runner
└── runTests.ts               # Main test entry point
```

## Running Tests

### All Tests
```bash
npm test
```

### Unit Tests Only
```bash
npm run test:unit
```

### Integration Tests
```bash
npm test
```

## Test Coverage

### Unit Tests (8 modules)
- ✅ **config.test.ts** - Configuration loading, presets, validation
- ✅ **chatStorage.test.ts** - Session CRUD, sorting, ID generation
- ✅ **promptTemplates.test.ts** - Variable substitution, built-in templates
- ✅ **memoryCore.test.ts** - Tier system, promotion/demotion, statistics
- ✅ **smartContext.test.ts** - Import parsing, file resolution, relevance scoring
- ✅ **symbolProvider.test.ts** - Symbol indexing, fuzzy search, caching
- ✅ **multiWorkspace.test.ts** - Workspace isolation, context management
- ✅ **chatExporter.test.ts** - Markdown/JSON export, filename sanitization

### Integration Tests (1 module)
- ✅ **extension.test.ts** - Extension activation, command registration, views

## Test Framework

- **Mocha** - Test runner
- **Sinon** - Mocking and stubbing
- **@vscode/test-electron** - VS Code extension testing
- **Node Assert** - Assertions

## Writing Tests

### Unit Test Template
```typescript
import * as assert from 'assert';
import * as sinon from 'sinon';

describe('Module Name', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should do something', () => {
    // Test implementation
    assert.strictEqual(actual, expected);
  });
});
```

### Integration Test Template
```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Integration Test', () => {
  it('should test VS Code integration', async () => {
    const ext = vscode.extensions.getExtension('dtenney.ollamapilot');
    assert.ok(ext);
  });
});
```

## CI/CD Integration

Tests run automatically on:
- Pre-commit hooks (optional)
- Pull requests
- Release builds

## Test Philosophy

1. **Fast** - Unit tests run in milliseconds
2. **Isolated** - No external dependencies (Ollama, Qdrant)
3. **Comprehensive** - Cover core functionality and edge cases
4. **Maintainable** - Clear test names and structure
5. **Reliable** - No flaky tests

## Coverage Goals

- **Unit Tests**: 80%+ code coverage
- **Integration Tests**: All commands and views
- **E2E Tests**: Critical user workflows (future)

## Known Limitations

- Integration tests require VS Code Extension Host
- No tests for webview UI (requires browser environment)
- Ollama client tests are mocked (no live API calls)
- MCP client tests are mocked (no external servers)

## Future Enhancements

- [ ] E2E tests with Playwright
- [ ] Webview UI tests
- [ ] Performance benchmarks
- [ ] Code coverage reporting
- [ ] Automated test generation
