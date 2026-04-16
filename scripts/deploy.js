#!/usr/bin/env node
// Deploy the esbuild bundle + webview to the local VS Code extension directory.
// Uses esbuild (not tsc) so all dependencies are bundled into dist/main.js — no node_modules needed.
// Run via: npm run deploy

const fs = require('fs');
const path = require('path');

const extRoot = path.join(process.env.USERPROFILE, '.vscode/extensions/dtenney.ollamapilot-0.4.0');
const srcRoot = path.join(__dirname, '..');

// --- Copy bundled main.js ---
const distDst = path.join(extRoot, 'dist');
fs.mkdirSync(distDst, { recursive: true });

const mainSrc = path.join(srcRoot, 'dist/main.js');
if (!fs.existsSync(mainSrc)) {
    console.error('ERROR: dist/main.js not found. Run "npm run bundle" first.');
    process.exit(1);
}
fs.copyFileSync(mainSrc, path.join(distDst, 'main.js'));
console.log('Deployed dist/main.js');

// --- Copy webview ---
fs.mkdirSync(path.join(extRoot, 'webview'), { recursive: true });
fs.copyFileSync(
    path.join(srcRoot, 'webview/webview.js'),
    path.join(extRoot, 'webview/webview.js')
);
console.log('Deployed webview/webview.js');

// --- Copy root files ---
for (const f of ['package.json', 'mcp.example.json', 'settings.example.json']) {
    const src = path.join(srcRoot, f);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(extRoot, f));
        console.log(`Deployed ${f}`);
    }
}

console.log('\nDeploy complete. Reload the extension host in VS Code.');
