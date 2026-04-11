/**
 * Minimal E2E test: Does clicking a comment list item trigger __onListItemClick?
 * Run: node test/test-scroll-debug.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Build comment-ui
require('child_process').execSync(
    'npx esbuild src/comment-ui.ts --bundle --outfile=out/comment-ui-test.js --format=cjs --platform=node',
    { cwd: path.join(__dirname, '..'), stdio: 'pipe' }
);
const { commentUiCss, commentUiJs, sidebarHtml } = require(path.join(__dirname, '..', 'out', 'comment-ui-test.js'));

const comments = [
    { id: 'c1', comment: 'Test comment', blockPreview: 'Slide 1: Title', elementId: 'slide_1', resolved: false, replies: [], _source: '', role: 'user', timestamp: new Date().toISOString() },
    { id: 'c2', comment: 'Another', blockPreview: 'Slide 5 (shape 3)', elementId: 'slide_5_shape_3', resolved: false, replies: [], _source: '', role: 'user', timestamp: new Date().toISOString() },
];

const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
body { background: #1e1e1e; color: #ccc; height: 5000px; margin: 20px; }
${commentUiCss()}
#sidebar { position: fixed; top: 0; right: 0; width: 350px; height: 100vh; background: #252526; padding: 12px; overflow-y: auto; z-index: 1000; }
.panel-filters button { padding: 2px 8px; font-size: 11px; border: 1px solid #555; border-radius: 3px; cursor: pointer; background: transparent; color: #ccc; }
.panel-filters button.active { background: #0078D4; color: #fff; }
.panel-bulk button { padding: 2px 8px; font-size: 11px; border: none; border-radius: 3px; cursor: pointer; background: #0078D4; color: #fff; }
.slide-label { font-size: 18px; font-weight: bold; color: #ccc; margin: 20px 0 10px; }
.slide-box { width: 960px; height: 540px; background: #333; display: flex; align-items: center; justify-content: center; font-size: 32px; margin-bottom: 20px; }
</style></head><body>
<div id="comment-popover"></div>
<div id="sidebar">
    <h3>Comments</h3>
    ${sidebarHtml({ containerId: 'comment-list', toggleFn: 'toggle', filters: ['all', 'open', 'resolved'] })}
</div>
<div id="slides-output">
${Array.from({length: 12}, (_, i) => `<div class="slide-label">Slide ${i+1}</div><div class="slide-box" id="slide-${i+1}">Slide ${i+1}</div>`).join('\n')}
</div>
<script>
(function() {
    var vscode = { postMessage: function(msg) { console.log('vscode.postMessage:', JSON.stringify(msg)); } };
    var output = document.getElementById('slides-output');
    var comments = ${JSON.stringify(comments)};
    var __nativePrefix = 'pptx_';
    var __nativeSource = 'pptx';

    ${commentUiJs()}

    // PPTX-specific hooks
    window.__onListItemClick = function(c) {
        console.log('__onListItemClick called with elementId:', c.elementId);
        var match = (c.elementId || '').match(/slide_(\\d+)/);
        var slideNum = match ? match[1] : '';
        if (!slideNum) { console.log('No slideNum extracted!'); return; }
        var labels = output.querySelectorAll('.slide-label');
        console.log('Looking for Slide', slideNum, 'in', labels.length, 'labels');
        for (var j = 0; j < labels.length; j++) {
            if (labels[j].textContent === 'Slide ' + slideNum) {
                labels[j].scrollIntoView({ behavior: 'instant', block: 'start' });
                window._scrolledTo = slideNum;
                console.log('Scrolled to Slide', slideNum);
                break;
            }
        }
    };
    window.__findAnchorForComment = function(c) { return null; };
    window.__onCommentChange = function() {};

    buildList();
    updateBadge();
    console.log('Init complete. Items:', document.querySelectorAll('.clist-item').length);
    window._ready = true;
})();
</script></body></html>`;

async function main() {
    console.log('=== Click-to-Scroll Debug Test ===\n');
    
    const testPath = path.join(__dirname, '_debug_scroll.html');
    fs.writeFileSync(testPath, html);

    const server = http.createServer((req, res) => {
        const fp = path.join(__dirname, '..', decodeURIComponent(req.url.split('?')[0]));
        if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200); fs.createReadStream(fp).pipe(res);
    });
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;

    const browser = await chromium.launch({ headless: false }); // visible for debugging
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => { logs.push(m.text()); console.log('  [browser]', m.text()); });
    page.on('pageerror', e => { logs.push('ERROR: ' + e.message); console.log('  [ERROR]', e.message); });

    try {
        await page.goto(`http://localhost:${port}/test/_debug_scroll.html`);
        for (let i = 0; i < 30; i++) {
            await page.waitForTimeout(200);
            if (await page.evaluate(() => window._ready).catch(() => false)) break;
        }

        const items = await page.evaluate(() => document.querySelectorAll('.clist-item').length);
        console.log('\nComment items:', items);

        // Click the first item's preview text (should bubble to .clist-item)
        console.log('\n--- Clicking first comment item ---');
        await page.evaluate(() => { window._scrolledTo = null; });
        await page.click('.clist-item:first-child .item-preview');
        await page.waitForTimeout(500);
        const result1 = await page.evaluate(() => window._scrolledTo);
        console.log('Result:', result1, result1 === '1' ? 'PASS' : 'FAIL');

        // Click second item
        console.log('\n--- Clicking second comment item ---');
        await page.evaluate(() => { window._scrolledTo = null; });
        await page.click('.clist-item:nth-child(2) .item-preview');
        await page.waitForTimeout(500);
        const result2 = await page.evaluate(() => window._scrolledTo);
        console.log('Result:', result2, result2 === '5' ? 'PASS' : 'FAIL');

    } finally {
        await browser.close();
        server.close();
        fs.unlinkSync(testPath);
    }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
