// Validates the new findChrome() logic actually picks the versioned binary on this machine
const fs = require('fs');
const pathMod = require('path');

function resolveWindowsBrowser(topLevelExe) {
    if (!fs.existsSync(topLevelExe)) { return undefined; }
    try {
        const appDir = pathMod.dirname(topLevelExe);
        const exeName = pathMod.basename(topLevelExe);
        const versionDirs = fs.readdirSync(appDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(d.name))
            .map(d => d.name)
            .sort((a, b) => {
                const pa = a.split('.').map(Number);
                const pb = b.split('.').map(Number);
                for (let i = 0; i < 4; i++) { if (pa[i] !== pb[i]) { return pb[i] - pa[i]; } }
                return 0;
            });
        for (const v of versionDirs) {
            const candidate = pathMod.join(appDir, v, exeName);
            if (fs.existsSync(candidate)) { return candidate; }
        }
    } catch { /* fall through */ }
    return topLevelExe;
}

function findChrome() {
    const windowsTopLevel = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const top of windowsTopLevel) {
        const resolved = resolveWindowsBrowser(top);
        if (resolved) { return resolved; }
    }
    return undefined;
}

const browser = findChrome();
console.log('Resolved browser:', browser);

// End-to-end: run renderMermaidToPng using the resolved binary
if (!browser) { console.error('No browser found'); process.exit(1); }

const os = require('os');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const repoRoot = pathMod.resolve(__dirname, '..');
const mermaidJsUrl = pathToFileURL(pathMod.join(repoRoot, 'media', 'mermaid.min.js')).href;

const tempDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'merm-fix-'));
console.log('tempDir:', tempDir);

const sources = [
    `flowchart LR\n  A[Start] --> B{Decide}\n  B -->|Yes| C[Pass]\n  B -->|No| D[Fail]`,
    `sequenceDiagram\n  Alice->>Bob: Hello\n  Bob->>Alice: Hi`,
];

function waitForFile(filePath, timeoutMs) {
    return new Promise(resolve => {
        const start = Date.now();
        let lastSize = -1;
        const poll = () => {
            if (fs.existsSync(filePath)) {
                const sz = fs.statSync(filePath).size;
                if (sz > 0 && sz === lastSize) { return resolve(); }
                lastSize = sz;
            }
            if (Date.now() - start >= timeoutMs) { return resolve(); }
            setTimeout(poll, 150);
        };
        poll();
    });
}

async function main() {
let ok = 0;
for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const pngPath = pathMod.join(tempDir, `m${i}.png`);
    const htmlPath = pathMod.join(tempDir, `m${i}.html`);
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="${mermaidJsUrl}"></script>
<style>html{margin:0;padding:0;background:white}body{margin:0;padding:20px 40px;background:white;max-width:860px}</style>
</head><body><div class="mermaid">${src}</div>
<script>mermaid.initialize({startOnLoad:false,theme:'default'});
mermaid.run({querySelector:'.mermaid'}).then(function(){var s=document.querySelector('.mermaid svg');if(s){var b=s.getBoundingClientRect();document.body.style.width=Math.ceil(b.width+80)+'px';document.body.style.height=Math.ceil(b.height+40)+'px';}});</script>
</body></html>`;
    fs.writeFileSync(htmlPath, html, 'utf-8');
    try {
        execFileSync(browser, [
            '--headless=new', '--disable-gpu',
            `--screenshot=${pngPath}`,
            '--window-size=1600,4000',
            '--force-device-scale-factor=2',
            '--virtual-time-budget=8000',
            `--user-data-dir=${pathMod.join(tempDir, `profile-${i}`)}`,
            '--no-first-run', '--no-default-browser-check',
            pathToFileURL(htmlPath).href,
        ], { timeout: 25000, stdio: 'pipe' });
    } catch (e) {
        console.log(`Diagram ${i}: ERROR`, e.message);
        continue;
    }
    await waitForFile(pngPath, 10000);
    if (fs.existsSync(pngPath)) {
        const sz = fs.statSync(pngPath).size;
        console.log(`Diagram ${i}: OK ${sz} bytes -> ${pngPath}`);
        ok++;
    } else {
        console.log(`Diagram ${i}: FAIL - no PNG produced`);
    }
}
console.log(`\n${ok}/${sources.length} diagrams rendered successfully.`);
process.exit(ok === sources.length ? 0 : 1);
}
main();
