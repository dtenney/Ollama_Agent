/**
 * vscode-mock.ts
 *
 * Preload script for headless agent tests.
 * The actual vscode stub lives in node_modules/vscode/index.js so Node
 * can resolve it naturally. This file is a no-op placeholder kept for
 * documentation purposes — the --require flag just ensures the stub is
 * loaded before test code imports agent.ts.
 *
 * Usage:
 *   mocha --require dist/test/vscode-mock.js --timeout 30000 dist/test/unit/agentHarness.test.js
 */

// Force-load the stub so it's in require.cache before anything else
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('vscode');
