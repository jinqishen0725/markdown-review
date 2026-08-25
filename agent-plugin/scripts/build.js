const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const dist = path.join(pluginRoot, 'dist');
const extensionRoot = path.join(pluginRoot, 'extensions', 'markdown-review');
const repositoryRoot = path.resolve(pluginRoot, '..');

async function build() {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });
    fs.mkdirSync(path.join(extensionRoot, 'assets'), { recursive: true });
    const previewPath = path.join(pluginRoot, 'assets', 'preview.png');
    if (!fs.existsSync(previewPath)) {
        throw new Error(`Missing Canvas preview asset: ${previewPath}`);
    }

    await esbuild.build({
        entryPoints: [path.join(pluginRoot, 'src', 'server.ts')],
        outfile: path.join(dist, 'server.js'),
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        legalComments: 'none',
    });

    await esbuild.build({
        entryPoints: [path.join(pluginRoot, 'src', 'canvas-extension.ts')],
        outfile: path.join(extensionRoot, 'extension.mjs'),
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        external: ['@github/copilot-sdk/extension'],
        minify: true,
        supported: { 'template-literal': false },
        legalComments: 'none',
    });

    fs.copyFileSync(path.join(repositoryRoot, 'icon.png'), path.join(extensionRoot, 'assets', 'icon.png'));
}

build().catch(error => {
    console.error(error);
    process.exitCode = 1;
});