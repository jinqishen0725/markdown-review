/**
 * Test: Reproduce EXACT webview PPTX structure to find scroll bug.
 * This mirrors the real getPptxHtml() template as closely as possible.
 * 
 * Run: node test/test-scroll-exact.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Build real comment-ui
require('child_process').execSync(
    'npx esbuild src/comment-ui.ts --bundle --outfile=out/comment-ui-test.js --format=cjs --platform=node',
    { cwd: path.join(__dirname, '..'), stdio: 'pipe' }
);
const { commentUiCss, commentUiJs, sidebarHtml } = require(path.join(__dirname, '..', 'out', 'comment-ui-test.js'));

// Fake comments that match real PPTX comment structure
const comments = [
    { id: 'c1', comment: 'Fix title', blockPreview: 'Slide 1 (shapeId=2): "Title Text"', elementId: 'slide_1_shape_2', resolved: false, replies: [], _source: '', role: 'user', timestamp: new Date().toISOString(), blockType: 'slide' },
    { id: 'pptx_7', comment: 'Native PPTX comment', blockPreview: 'Slide 5 (shape 3)', elementId: 'slide_5', resolved: false, replies: [], _source: 'pptx', _wordAuthor: 'Alice', role: 'user', timestamp: new Date().toISOString(), blockType: 'slide' },
];

// This HTML mirrors getPptxHtml() exactly — same structure, same variable order
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Test PPTX Structure</title>
<style>
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    font-size: 13px; line-height: 1.5;
    background: #1e1e1e; color: #d4d4d4;
    margin: 0; padding: 20px;
}
#slides-output { width: 960px; margin: 0 auto; }
#slides-output > div { margin-bottom: 16px; position: relative; }
.slide-label { font-size: 14px; font-weight: bold; color: #ccc; margin: 16px 0 6px 0; max-width: 960px; }
.slide-box { width: 960px; height: 540px; background: #333; display: flex; align-items: center; justify-content: center; font-size: 32px; position: relative; }
${commentUiCss()}
/* Sidebar - same as real getPptxHtml */
#sidebar { position: fixed; top: 0; right: -360px; width: 350px; height: 100vh; background: #252526; border-left: 1px solid #444; z-index: 1000; overflow-y: auto; transition: right 0.2s; padding: 12px; box-sizing: border-box; }
#sidebar.open { right: 0; }
.sidebar-close { position: sticky; top: 0; float: right; background: none; border: none; color: #ccc; font-size: 20px; cursor: pointer; z-index: 1001; }
.panel-filters button { padding: 2px 8px; font-size: 11px; border: 1px solid #555; border-radius: 3px; cursor: pointer; background: transparent; color: #ccc; }
.panel-filters button.active { background: #0078D4; color: #fff; }
.panel-bulk button { padding: 2px 8px; font-size: 11px; border: none; border-radius: 3px; cursor: pointer; background: #0078D4; color: #fff; }
#test-results { position: fixed; bottom: 0; left: 0; right: 350px; background: #111; color: #0f0; padding: 10px; font-family: monospace; font-size: 12px; z-index: 2000; max-height: 200px; overflow-y: auto; }
</style>
</head>
<body>
<div id="comment-badge" onclick="toggleSidebar()">&#x1F4AC; <span id="badge-count">0</span></div>
<div id="sidebar" class="open">
    <button class="sidebar-close" onclick="toggleSidebar()">&#x00D7;</button>
    <h3>&#x1F4AC; Review Comments</h3>
    ${sidebarHtml({ containerId: 'comment-list', toggleFn: 'toggleSidebar', filters: ['all', 'open', 'resolved'] })}
</div>
<div id="comment-dialog"><!-- ... dialog ... --></div>
<div id="loading" style="display:none;"></div>
<div id="comment-popover"></div>
<div id="slides-output"></div>
<div id="test-results"></div>
<script>
(function() {
    // === Same structure as getPptxHtml() ===
    var vscode = { postMessage: function(msg) { logResult('vscode.postMessage: ' + JSON.stringify(msg)); } };
    var loadingEl = document.getElementById('loading');

    var comments = ${JSON.stringify(comments)};
    var notesData = [];
    var colorFixes = [];
    var shapeLayouts = [];
    var pendingSlideIndex = null;
    var pendingShapeId = null;
    var pendingShapeName = null;

    // === Comment dialog (simplified) ===
    window.openCommentDialog = function() {};
    window.closeDialog = function() {};
    window.submitComment = function() {};
    window.submitAndAskCopilot = function() {};

    // === Shared comment UI ===
    var __nativePrefix = 'pptx_';
    var __nativeSource = 'pptx';
    ${commentUiJs()}

    // === PPTX-specific hooks ===
    window.__onListItemClick = function(c) {
        logResult('__onListItemClick called! elementId=' + c.elementId);
        var match = (c.elementId || '').match(/slide_(\\d+)/);
        var slideNum = match ? match[1] : '';
        if (!slideNum) { logResult('ERROR: No slideNum extracted'); return; }
        logResult('Looking for "Slide ' + slideNum + '" in ' + output.querySelectorAll('.slide-label').length + ' labels');
        var labels = output.querySelectorAll('.slide-label');
        var found = false;
        for (var j = 0; j < labels.length; j++) {
            logResult('  Label ' + j + ': "' + labels[j].textContent + '"');
            if (labels[j].textContent === 'Slide ' + slideNum) {
                labels[j].scrollIntoView({ behavior: 'instant', block: 'start' });
                window._scrolledTo = slideNum;
                logResult('SUCCESS: Scrolled to Slide ' + slideNum);
                found = true;
                break;
            }
        }
        if (!found) logResult('ERROR: Label "Slide ' + slideNum + '" not found!');
    };
    window.__findAnchorForComment = function(c) { return null; };
    window.__onCommentChange = function() {};

    // Close popover handler
    document.addEventListener('click', function(e) {
        var pop = document.getElementById('comment-popover');
        if (pop && pop.style.display === 'block' && !pop.contains(e.target)) {
            pop.style.display = 'none';
        }
    });

    // === NOTE: In real code, output is declared HERE, AFTER hooks ===
    var output = document.getElementById('slides-output');

    // Simulate slide rendering (instead of pptx-renderer)
    // In real code, this happens asynchronously after fetch()
    setTimeout(function() {
        // Create slide elements (same as real code does)
        for (var i = 0; i < 12; i++) {
            var slideEl = document.createElement('div');
            slideEl.className = 'slide-box';
            slideEl.textContent = 'Slide ' + (i + 1) + ' Content';
            slideEl.id = 'rendered-slide-' + (i + 1);
            output.appendChild(slideEl);
        }

        // Add labels and overlays (same setTimeout pattern as real code)
        setTimeout(function() {
            var slideEls = Array.from(output.children);
            for (var i = slideEls.length - 1; i >= 0; i--) {
                var slideIdx = i + 1;
                var label = document.createElement('div');
                label.className = 'slide-label';
                label.textContent = 'Slide ' + slideIdx;
                output.insertBefore(label, slideEls[i]);
            }

            updateBadge();
            logResult('Slides rendered: ' + output.querySelectorAll('.slide-label').length + ' labels');
            window._rendered = true;
        }, 500);
    }, 100);

    // === Sidebar toggle ===
    var sidebarOpen = true; // Start open for testing
    window.toggleSidebar = function() {
        sidebarOpen = !sidebarOpen;
        document.getElementById('sidebar').classList.toggle('open', sidebarOpen);
        if (sidebarOpen) buildList();
    };

    // === Logging ===
    function logResult(msg) {
        console.log('[TEST] ' + msg);
        var el = document.getElementById('test-results');
        if (el) el.textContent += msg + '\\n';
    }

    // Build list immediately (sidebar is open)
    buildList();
    logResult('Init complete. Comment items: ' + document.querySelectorAll('.clist-item').length);
    logResult('output var is: ' + (output ? output.tagName + '#' + output.id : 'NULL/UNDEFINED'));
    window._initDone = true;
})();
</script>
</body>
</html>`;

async function main() {
    console.log('=== Exact PPTX Structure Scroll Test ===\n');

    const testPath = path.join(__dirname, '_test_exact.html');
    fs.writeFileSync(testPath, html);

    const server = http.createServer((req, res) => {
        const fp = path.join(__dirname, '..', decodeURIComponent(req.url.split('?')[0]));
        if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200);
        fs.createReadStream(fp).pipe(res);
    });
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('console', m => console.log('  [browser]', m.text()));
    page.on('pageerror', e => console.log('  [PAGE ERROR]', e.message));

    try {
        await page.goto(`http://localhost:${port}/test/_test_exact.html`);

        // Wait for slides to render
        for (let i = 0; i < 30; i++) {
            await page.waitForTimeout(200);
            if (await page.evaluate(() => window._rendered).catch(() => false)) break;
        }

        const items = await page.evaluate(() => document.querySelectorAll('.clist-item').length);
        const labels = await page.evaluate(() => document.querySelectorAll('.slide-label').length);
        console.log(`\nItems: ${items}, Labels: ${labels}`);

        // Test 1: Click first comment item's text area (not a button)
        console.log('\n=== Test 1: Click comment for slide_1_shape_2 ===');
        await page.evaluate(() => { window._scrolledTo = null; });
        // Click on the .item-comment area (the comment text, not a button)
        const clickTarget = await page.$('.clist-item:first-child .item-comment');
        if (clickTarget) {
            await clickTarget.click();
            await page.waitForTimeout(500);
        } else {
            console.log('  ERROR: .item-comment not found');
            // Try clicking the whole item
            await page.click('.clist-item:first-child');
            await page.waitForTimeout(500);
        }
        let result = await page.evaluate(() => window._scrolledTo);
        console.log('  scrolledTo:', result, result === '1' ? 'PASS' : 'FAIL');

        // Test 2: Click second comment's preview
        console.log('\n=== Test 2: Click comment for slide_5 ===');
        await page.evaluate(() => { window._scrolledTo = null; });
        const clickTarget2 = await page.$('.clist-item:nth-child(2) .item-preview');
        if (clickTarget2) {
            await clickTarget2.click();
            await page.waitForTimeout(500);
        }
        result = await page.evaluate(() => window._scrolledTo);
        console.log('  scrolledTo:', result, result === '5' ? 'PASS' : 'FAIL');

        // Test 3: Check if buttons swallow clicks
        console.log('\n=== Test 3: Click directly on Reply button (should NOT scroll) ===');
        await page.evaluate(() => { window._scrolledTo = null; });
        const replyBtn = await page.$('.clist-item:first-child .item-reply-input button');
        if (replyBtn) {
            await replyBtn.click();
            await page.waitForTimeout(300);
        }
        result = await page.evaluate(() => window._scrolledTo);
        console.log('  scrolledTo:', result, result === null ? 'PASS (correctly blocked)' : 'FAIL (leaked through)');

        // Test 4: Programmatic scroll test
        console.log('\n=== Test 4: Direct __onListItemClick call ===');
        await page.evaluate(() => {
            window._scrolledTo = null;
            window.__onListItemClick({ elementId: 'slide_10_shape_7' });
        });
        await page.waitForTimeout(300);
        result = await page.evaluate(() => window._scrolledTo);
        console.log('  scrolledTo:', result, result === '10' ? 'PASS' : 'FAIL');

        // Dump test results panel
        const testResults = await page.evaluate(() => document.getElementById('test-results').textContent);
        console.log('\n=== Full log ===');
        console.log(testResults);

    } finally {
        await browser.close();
        server.close();
        fs.unlinkSync(testPath);
    }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
