const esbuild = require('esbuild');

const production = process.argv.includes('--production');

esbuild.build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    outfile: 'dist/main.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'es2020',
    sourcemap: !production,
    minify: production,
    // Keep readable class/function names even when minified
    keepNames: true,
}).then(() => {
    console.log('✓ Extension bundled → dist/main.js');
}).catch(() => process.exit(1));
