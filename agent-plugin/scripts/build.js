const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const dist = path.join(pluginRoot, 'dist');

async function build() {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });

    await esbuild.build({
        entryPoints: [path.join(pluginRoot, 'src', 'server.ts')],
        outfile: path.join(dist, 'server.js'),
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        legalComments: 'none',
    });
}

build().catch(error => {
    console.error(error);
    process.exitCode = 1;
});