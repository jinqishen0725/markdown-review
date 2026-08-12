const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const pluginRoot = path.resolve(__dirname, '..');
const dist = path.join(pluginRoot, 'dist');

async function build() {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });

    const appOutput = path.join(dist, 'review-app.js');
    await esbuild.build({
        entryPoints: [path.join(pluginRoot, 'src', 'app.ts')],
        outfile: appOutput,
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        minify: true,
        legalComments: 'none',
    });

    const template = fs.readFileSync(path.join(pluginRoot, 'src', 'review-app.html'), 'utf8');
    const appScript = fs.readFileSync(appOutput, 'utf8').replace(/<\/script/gi, '<\\x2fscript');
    fs.writeFileSync(
        path.join(dist, 'review-app.html'),
        template.replace('/*__APP_SCRIPT__*/', () => appScript),
        'utf8',
    );
    fs.rmSync(appOutput);

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