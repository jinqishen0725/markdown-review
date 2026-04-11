/**
 * E2E test: Reproduce webview behavior (windowed:true + scroll to render)
 * Run: node test/test-slide-capture-windowed.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const OUTPUT_DIR = path.join(__dirname);

function startServer(rootDir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let filePath = path.join(rootDir, decodeURIComponent(req.url));
            if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
            const ext = path.extname(filePath).toLowerCase();
            const types = { '.html': 'text/html', '.js': 'application/javascript', '.pptx': 'application/octet-stream' };
            res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
            fs.createReadStream(filePath).pipe(res);
        });
        server.listen(0, () => resolve({ server, port: server.address().port }));
    });
}

async function main() {
    console.log('=== Windowed Slide Capture Test ===\n');

    const testHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<script src="/media/pptx-viewer.js"></script>
<script src="/media/html2canvas.min.js"></script>
<style>
body { background: #1e1e1e; color: #ccc; margin: 20px; }
#output { width: 960px; margin: 0 auto; }
#output > div { margin-bottom: 16px; position: relative; }
.slide-label { font-size: 14px; font-weight: bold; color: #ccc; margin: 16px 0 6px; }
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
        setTimeout(function() {
            // Add slide labels like the real extension does
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

    const testHtmlPath = path.join(__dirname, '_test_windowed.html');
    fs.writeFileSync(testHtmlPath, testHtml);
    const { server, port } = await startServer(path.join(__dirname, '..'));

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('console', msg => console.log(`  [browser] ${msg.text()}`));

    try {
        await page.goto(`http://localhost:${port}/test/_test_windowed.html`, { waitUntil: 'networkidle' });
        await page.waitForFunction('window._ready || window._error', { timeout: 30000 });

        const err = await page.evaluate('window._error');
        if (err) { console.log('ERROR:', err); process.exit(1); }

        // Test capturing slides 1, 5, 10 (different lazy-load states)
        for (const slideNum of [1, 5, 10]) {
            console.log(`\n--- Capturing Slide ${slideNum} ---`);

            const result = await page.evaluate(async (num) => {
                // Find slide element (same logic as webview)
                var labels = document.querySelectorAll('.slide-label');
                var targetSlide = null;
                for (var k = 0; k < labels.length; k++) {
                    if (labels[k].textContent === 'Slide ' + num) {
                        targetSlide = labels[k].nextElementSibling;
                        break;
                    }
                }
                if (!targetSlide) return { error: 'Slide ' + num + ' not found' };

                // Check if slide has content before scrolling
                var beforeScroll = {
                    children: targetSlide.children.length,
                    width: targetSlide.offsetWidth,
                    height: targetSlide.offsetHeight,
                    innerHTML: targetSlide.innerHTML.substring(0, 200),
                };

                // Scroll into view (trigger lazy render)
                targetSlide.scrollIntoView({ block: 'center' });

                // Wait for rendering
                await new Promise(res => setTimeout(res, 2000));

                var afterScroll = {
                    children: targetSlide.children.length,
                    width: targetSlide.offsetWidth,
                    height: targetSlide.offsetHeight,
                    canvases: targetSlide.querySelectorAll('canvas').length,
                    svgs: targetSlide.querySelectorAll('svg').length,
                    spans: targetSlide.querySelectorAll('span').length,
                    innerHTML: targetSlide.innerHTML.substring(0, 200),
                };

                // Convert canvases and blob URLs (same as webview code)
                var canvasRestores = [];
                var canvases = targetSlide.querySelectorAll('canvas');
                for (var ci = 0; ci < canvases.length; ci++) {
                    try {
                        var cvs = canvases[ci];
                        var dataUrl = cvs.toDataURL('image/png');
                        var img = document.createElement('img');
                        img.src = dataUrl;
                        img.style.cssText = window.getComputedStyle(cvs).cssText;
                        img.style.width = (cvs.offsetWidth || cvs.width) + 'px';
                        img.style.height = (cvs.offsetHeight || cvs.height) + 'px';
                        cvs.parentNode.insertBefore(img, cvs);
                        cvs.style.display = 'none';
                        canvasRestores.push({ canvas: cvs, img: img });
                    } catch(e) {}
                }

                var blobPromises = [];
                var allEls = targetSlide.querySelectorAll('*');
                for (var i = 0; i < allEls.length; i++) {
                    var bg = window.getComputedStyle(allEls[i]).backgroundImage;
                    if (bg && bg.indexOf('blob:') >= 0) {
                        var match = bg.match(/url\(["']?(blob:[^"')]+)/);
                        if (match) {
                            blobPromises.push(
                                fetch(match[1]).then(r => r.blob())
                                .then(b => new Promise(res => { var fr = new FileReader(); fr.onloadend = () => res(fr.result); fr.readAsDataURL(b); }))
                                .then(du => { allEls[i].style.backgroundImage = 'url(' + du + ')'; })
                                .catch(() => {})
                            );
                        }
                    }
                }
                await Promise.all(blobPromises);

                // Capture with html2canvas
                try {
                    var canvas = await html2canvas(targetSlide, {
                        backgroundColor: null, scale: 2, useCORS: true, allowTaint: true, logging: false,
                        width: targetSlide.offsetWidth, height: targetSlide.offsetHeight,
                    });
                    canvasRestores.forEach(r => { r.canvas.style.display = ''; r.img.parentNode.removeChild(r.img); });

                    var ctx = canvas.getContext('2d');
                    var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    var nonTransparent = 0;
                    for (var p = 3; p < imgData.data.length; p += 4) { if (imgData.data[p] > 0) nonTransparent++; }
                    var total = canvas.width * canvas.height;

                    return {
                        beforeScroll, afterScroll,
                        capture: {
                            width: canvas.width, height: canvas.height,
                            coverage: ((nonTransparent / total) * 100).toFixed(1) + '%',
                            isBlank: nonTransparent < total * 0.01,
                            base64: canvas.toDataURL('image/png').split(',')[1],
                        }
                    };
                } catch(e) {
                    canvasRestores.forEach(r => { r.canvas.style.display = ''; r.img.parentNode.removeChild(r.img); });
                    return { beforeScroll, afterScroll, error: e.message };
                }
            }, slideNum);

            console.log('Before scroll:', JSON.stringify(result.beforeScroll, null, 2));
            console.log('After scroll:', JSON.stringify(result.afterScroll, null, 2));

            if (result.error) {
                console.log('ERROR:', result.error);
            } else if (result.capture) {
                console.log('Capture:', result.capture.width + 'x' + result.capture.height,
                    'coverage:', result.capture.coverage, 'blank:', result.capture.isBlank);
                if (result.capture.base64) {
                    const outPath = path.join(OUTPUT_DIR, `_test_slide${slideNum}_windowed.png`);
                    fs.writeFileSync(outPath, Buffer.from(result.capture.base64, 'base64'));
                    console.log('Saved:', outPath);
                }
            }
        }
    } finally {
        await browser.close();
        server.close();
        try { fs.unlinkSync(testHtmlPath); } catch {}
    }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
