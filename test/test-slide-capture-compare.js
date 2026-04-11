/**
 * E2E test: Compare html2canvas vs html-to-image for slide capture.
 * Tests both with windowed rendering to match real webview conditions.
 * Also tests with restrictive CSP to simulate VS Code webview.
 * 
 * Run: node test/test-slide-capture-compare.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

function startServer(rootDir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let filePath = path.join(rootDir, decodeURIComponent(req.url.split('?')[0]));
            if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found: ' + req.url); return; }
            const ext = path.extname(filePath).toLowerCase();
            const types = { '.html': 'text/html', '.js': 'application/javascript', '.pptx': 'application/octet-stream' };
            res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
            fs.createReadStream(filePath).pipe(res);
        });
        server.listen(0, () => resolve({ server, port: server.address().port }));
    });
}

async function main() {
    console.log('=== Slide Capture Library Comparison ===\n');

    // Test HTML with CSP matching VS Code webview
    const testHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: blob:; style-src * 'unsafe-inline'; script-src 'unsafe-inline' http://localhost:*; font-src * data:; connect-src * blob:;">
<script src="/media/pptx-viewer.js"></script>
<script src="/media/html2canvas.min.js"></script>
<script src="/media/html-to-image.min.js"></script>
<style>
body { background: #1e1e1e; color: #ccc; margin: 20px; }
#output { width: 960px; margin: 0 auto; }
#output > div { margin-bottom: 16px; position: relative; }
</style></head><body>
<div id="output"></div>
<script>
var output = document.getElementById('output');

fetch('/test/UMS_Experiment_Proposal.pptx')
    .then(function(r) { return r.arrayBuffer(); })
    .then(function(buf) {
        return PptxLib.PptxViewer.open(buf, output, {
            renderMode: 'list',
            listOptions: { windowed: true, batchSize: 4, initialSlides: 3 },
            fitMode: 'contain',
            width: 960,
        });
    })
    .then(function(viewer) {
        window._viewer = viewer;
        // Add slide labels
        setTimeout(function() {
            var slideEls = Array.from(output.children);
            for (var i = slideEls.length - 1; i >= 0; i--) {
                var label = document.createElement('div');
                label.className = 'slide-label';
                label.textContent = 'Slide ' + (i + 1);
                output.insertBefore(label, slideEls[i]);
            }
            window._ready = true;
        }, 500);
    })
    .catch(function(e) { window._error = e.message; });
</script></body></html>`;

    const testHtmlPath = path.join(__dirname, '_test_compare.html');
    fs.writeFileSync(testHtmlPath, testHtml);
    const { server, port } = await startServer(path.join(__dirname, '..'));

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push('PAGE ERROR: ' + err.message));

    try {
        await page.goto(`http://localhost:${port}/test/_test_compare.html`, { waitUntil: 'networkidle' });
        
        // Poll for ready (can't use waitForFunction due to CSP blocking eval)
        for (let i = 0; i < 60; i++) {
            await page.waitForTimeout(500);
            const ready = await page.evaluate(() => window._ready || window._error).catch(() => null);
            if (ready) break;
        }

        if (await page.evaluate('window._error')) {
            console.log('RENDER ERROR:', await page.evaluate('window._error'));
            process.exit(1);
        }

        // Test slide 5 (not initially rendered due to windowed mode)
        const slideNum = 5;
        console.log(`Testing capture of Slide ${slideNum} (lazy-loaded)\n`);

        // Scroll into view first
        await page.evaluate((num) => {
            var labels = document.querySelectorAll('.slide-label');
            for (var k = 0; k < labels.length; k++) {
                if (labels[k].textContent === 'Slide ' + num) {
                    labels[k].nextElementSibling.scrollIntoView({ block: 'center' });
                    break;
                }
            }
        }, slideNum);
        await page.waitForTimeout(2000); // Wait for lazy render

        // --- Test 1: html2canvas ---
        console.log('--- html2canvas ---');
        const h2cResult = await page.evaluate(async (num) => {
            var labels = document.querySelectorAll('.slide-label');
            var slide = null;
            for (var k = 0; k < labels.length; k++) {
                if (labels[k].textContent === 'Slide ' + num) { slide = labels[k].nextElementSibling; break; }
            }
            if (!slide) return { error: 'slide not found' };

            try {
                var canvas = await html2canvas(slide, {
                    backgroundColor: null, scale: 2, useCORS: true, allowTaint: true, logging: false,
                    width: slide.offsetWidth, height: slide.offsetHeight,
                });
                var ctx = canvas.getContext('2d');
                var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                var nonTransparent = 0;
                for (var p = 3; p < imgData.data.length; p += 4) { if (imgData.data[p] > 0) nonTransparent++; }
                var total = canvas.width * canvas.height;
                return {
                    width: canvas.width, height: canvas.height,
                    coverage: ((nonTransparent / total) * 100).toFixed(1),
                    isBlank: nonTransparent < total * 0.01,
                    base64: canvas.toDataURL('image/png').split(',')[1],
                };
            } catch(e) {
                return { error: e.message };
            }
        }, slideNum);

        if (h2cResult.error) {
            console.log('  ERROR:', h2cResult.error);
        } else {
            console.log(`  Size: ${h2cResult.width}x${h2cResult.height}, Coverage: ${h2cResult.coverage}%, Blank: ${h2cResult.isBlank}`);
            if (h2cResult.base64) {
                const outPath = path.join(__dirname, `_compare_h2c_slide${slideNum}.png`);
                fs.writeFileSync(outPath, Buffer.from(h2cResult.base64, 'base64'));
                console.log(`  Saved: ${outPath} (${Buffer.from(h2cResult.base64, 'base64').length} bytes)`);
            }
        }

        // --- Test 2: html-to-image ---
        console.log('\n--- html-to-image ---');
        const htiResult = await page.evaluate(async (num) => {
            var labels = document.querySelectorAll('.slide-label');
            var slide = null;
            for (var k = 0; k < labels.length; k++) {
                if (labels[k].textContent === 'Slide ' + num) { slide = labels[k].nextElementSibling; break; }
            }
            if (!slide) return { error: 'slide not found' };

            try {
                var dataUrl = await htmlToImage.toPng(slide, {
                    pixelRatio: 2,
                    cacheBust: true,
                    backgroundColor: null,
                });
                // Measure content
                var img = new Image();
                await new Promise(function(resolve, reject) {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = dataUrl;
                });
                var cvs = document.createElement('canvas');
                cvs.width = img.width; cvs.height = img.height;
                var ctx = cvs.getContext('2d');
                ctx.drawImage(img, 0, 0);
                var imgData = ctx.getImageData(0, 0, cvs.width, cvs.height);
                var nonTransparent = 0;
                for (var p = 3; p < imgData.data.length; p += 4) { if (imgData.data[p] > 0) nonTransparent++; }
                var total = cvs.width * cvs.height;
                return {
                    width: img.width, height: img.height,
                    coverage: ((nonTransparent / total) * 100).toFixed(1),
                    isBlank: nonTransparent < total * 0.01,
                    base64: dataUrl.split(',')[1],
                };
            } catch(e) {
                return { error: e.message + (e.stack ? '\n' + e.stack : '') };
            }
        }, slideNum);

        if (htiResult.error) {
            console.log('  ERROR:', htiResult.error);
        } else {
            console.log(`  Size: ${htiResult.width}x${htiResult.height}, Coverage: ${htiResult.coverage}%, Blank: ${htiResult.isBlank}`);
            if (htiResult.base64) {
                const outPath = path.join(__dirname, `_compare_hti_slide${slideNum}.png`);
                fs.writeFileSync(outPath, Buffer.from(htiResult.base64, 'base64'));
                console.log(`  Saved: ${outPath} (${Buffer.from(htiResult.base64, 'base64').length} bytes)`);
            }
        }

        // Print any CSP errors
        if (errors.length > 0) {
            console.log('\n--- CSP / Console Errors ---');
            errors.forEach(e => console.log('  ', e));
        }

        console.log('\n=== Done ===');
    } finally {
        await browser.close();
        server.close();
        try { fs.unlinkSync(testHtmlPath); } catch {}
    }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
