/**
 * End-to-end test: Render a real .pptx and capture a slide as PNG.
 * Uses Playwright to run in a real Chromium browser.
 * 
 * Run: node test/test-slide-capture.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PPTX_FILE = path.join(__dirname, 'UMS_Experiment_Proposal.pptx');
const PPTX_VIEWER = path.join(__dirname, '..', 'media', 'pptx-viewer.js');
const HTML2CANVAS = path.join(__dirname, '..', 'media', 'html2canvas.min.js');
const OUTPUT_PNG = path.join(__dirname, '_test_slide_capture.png');

// Simple static file server
function startServer(rootDir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let filePath = path.join(rootDir, decodeURIComponent(req.url));
            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                res.end('Not found: ' + req.url);
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html', '.js': 'application/javascript',
                '.pptx': 'application/octet-stream', '.png': 'image/png',
                '.css': 'text/css',
            };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            fs.createReadStream(filePath).pipe(res);
        });
        server.listen(0, () => {
            resolve({ server, port: server.address().port });
        });
    });
}

async function main() {
    console.log('=== PPTX Slide Capture E2E Test ===\n');

    // Create test HTML page
    const testHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<script src="/media/pptx-viewer.js"></script>
<script src="/media/html2canvas.min.js"></script>
<style>
body { background: #1e1e1e; color: #ccc; font-family: sans-serif; margin: 20px; }
#output { width: 960px; margin: 0 auto; }
#output > div { margin-bottom: 16px; position: relative; }
#status { padding: 10px; color: #888; }
#result { padding: 10px; color: #0f0; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="status">Loading...</div>
<div id="output"></div>
<div id="result"></div>
<script>
var output = document.getElementById('output');
var statusEl = document.getElementById('status');
var resultEl = document.getElementById('result');

function log(msg) {
    statusEl.textContent = msg;
    console.log('[Test]', msg);
}

log('Fetching PPTX...');
fetch('/test/UMS_Experiment_Proposal.pptx')
    .then(function(resp) {
        if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
        log('Rendering slides...');
        return resp.arrayBuffer();
    })
    .then(function(buffer) {
        return PptxLib.PptxViewer.open(buffer, output, {
            renderMode: 'list',
            listOptions: { windowed: false }, // Render ALL slides immediately
            fitMode: 'contain',
            width: 960,
        });
    })
    .then(function(viewer) {
        log('Rendered! Waiting for paint...');
        // Store viewer globally for tests
        window._viewer = viewer;
        window._rendered = true;

        setTimeout(function() {
            // Count what we got
            var children = output.children;
            log('Slides rendered: ' + children.length);

            // Analyze first slide DOM structure
            if (children.length > 0) {
                var slide = children[0];
                var analysis = {
                    tag: slide.tagName,
                    class: slide.className,
                    width: slide.offsetWidth,
                    height: slide.offsetHeight,
                    childCount: slide.children.length,
                    childTags: Array.from(slide.children).map(function(c) { return c.tagName; }).join(', '),
                    canvases: slide.querySelectorAll('canvas').length,
                    svgs: slide.querySelectorAll('svg').length,
                    imgs: slide.querySelectorAll('img').length,
                    blobUrls: 0,
                    textSpans: slide.querySelectorAll('span').length,
                };
                // Count blob URLs
                var allEls = slide.querySelectorAll('*');
                for (var i = 0; i < allEls.length; i++) {
                    var bg = window.getComputedStyle(allEls[i]).backgroundImage;
                    if (bg && bg.indexOf('blob:') >= 0) analysis.blobUrls++;
                }
                var blobImgs = slide.querySelectorAll('img');
                for (var j = 0; j < blobImgs.length; j++) {
                    if (blobImgs[j].src && blobImgs[j].src.indexOf('blob:') === 0) analysis.blobUrls++;
                }
                
                resultEl.textContent = 'Slide 1 DOM analysis:\\n' + JSON.stringify(analysis, null, 2);
                console.log('[DOM]', JSON.stringify(analysis));
                window._slideAnalysis = analysis;
            }
            window._analysisComplete = true;
        }, 2000);
    })
    .catch(function(err) {
        log('ERROR: ' + err.message);
        resultEl.textContent = 'Error: ' + err.stack;
        window._renderError = err.message;
    });
</script>
</body>
</html>`;

    const testHtmlPath = path.join(__dirname, '_test_capture.html');
    fs.writeFileSync(testHtmlPath, testHtml);

    // Start server
    const { server, port } = await startServer(path.join(__dirname, '..'));
    console.log(`Server started on port ${port}`);

    // Launch browser
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Collect console logs
    const consoleLogs = [];
    page.on('console', msg => {
        consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    try {
        // Step 1: Load and render
        console.log('\n--- Step 1: Load and render PPTX ---');
        await page.goto(`http://localhost:${port}/test/_test_capture.html`, { waitUntil: 'networkidle' });
        
        // Wait for rendering
        await page.waitForFunction('window._analysisComplete === true || window._renderError', { timeout: 30000 });

        const error = await page.evaluate('window._renderError');
        if (error) {
            console.log('RENDER ERROR:', error);
            consoleLogs.forEach(l => console.log('  ', l));
            process.exit(1);
        }

        const analysis = await page.evaluate('window._slideAnalysis');
        console.log('Slide 1 DOM:', JSON.stringify(analysis, null, 2));

        // Step 2: Try html2canvas capture
        console.log('\n--- Step 2: Attempt html2canvas capture ---');
        
        const captureResult = await page.evaluate(async () => {
            const slide = document.querySelector('#output > div');
            if (!slide) return { error: 'No slide element found' };

            // Convert canvases to images
            const canvasRestores = [];
            const canvases = slide.querySelectorAll('canvas');
            for (const cvs of canvases) {
                try {
                    const dataUrl = cvs.toDataURL('image/png');
                    const img = document.createElement('img');
                    img.src = dataUrl;
                    img.style.cssText = window.getComputedStyle(cvs).cssText;
                    img.style.position = cvs.style.position;
                    img.style.left = cvs.style.left;
                    img.style.top = cvs.style.top;
                    img.style.width = (cvs.offsetWidth || cvs.width) + 'px';
                    img.style.height = (cvs.offsetHeight || cvs.height) + 'px';
                    cvs.parentNode.insertBefore(img, cvs);
                    cvs.style.display = 'none';
                    canvasRestores.push({ canvas: cvs, img });
                } catch(e) { /* tainted */ }
            }

            // Convert blob URLs
            const allEls = slide.querySelectorAll('*');
            const blobPromises = [];
            for (const el of allEls) {
                const bg = window.getComputedStyle(el).backgroundImage;
                if (bg && bg.indexOf('blob:') >= 0) {
                    const match = bg.match(/url\(["']?(blob:[^"')]+)/);
                    if (match) {
                        blobPromises.push(
                            fetch(match[1]).then(r => r.blob())
                            .then(b => new Promise(res => { const fr = new FileReader(); fr.onloadend = () => res(fr.result); fr.readAsDataURL(b); }))
                            .then(du => { el.style.backgroundImage = `url(${du})`; })
                            .catch(() => {})
                        );
                    }
                }
            }
            for (const img of slide.querySelectorAll('img')) {
                if (img.src && img.src.startsWith('blob:')) {
                    blobPromises.push(
                        fetch(img.src).then(r => r.blob())
                        .then(b => new Promise(res => { const fr = new FileReader(); fr.onloadend = () => res(fr.result); fr.readAsDataURL(b); }))
                        .then(du => { img.src = du; })
                        .catch(() => {})
                    );
                }
            }
            await Promise.all(blobPromises);

            // Capture
            try {
                const canvas = await html2canvas(slide, {
                    backgroundColor: null,
                    scale: 2,
                    useCORS: true,
                    allowTaint: true,
                    logging: false,
                    width: slide.offsetWidth,
                    height: slide.offsetHeight,
                });
                
                // Restore
                canvasRestores.forEach(r => {
                    r.canvas.style.display = '';
                    r.img.parentNode.removeChild(r.img);
                });

                const dataUrl = canvas.toDataURL('image/png');
                // Check if it's actually blank
                const ctx = canvas.getContext('2d');
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                let nonTransparentPixels = 0;
                for (let i = 3; i < imageData.data.length; i += 4) {
                    if (imageData.data[i] > 0) nonTransparentPixels++;
                }
                const totalPixels = canvas.width * canvas.height;
                const coveragePercent = ((nonTransparentPixels / totalPixels) * 100).toFixed(1);

                return {
                    success: true,
                    width: canvas.width,
                    height: canvas.height,
                    dataUrlLength: dataUrl.length,
                    nonTransparentPixels,
                    totalPixels,
                    coveragePercent,
                    isBlank: nonTransparentPixels < totalPixels * 0.01,
                    base64: dataUrl.split(',')[1],
                };
            } catch(e) {
                canvasRestores.forEach(r => {
                    r.canvas.style.display = '';
                    r.img.parentNode.removeChild(r.img);
                });
                return { error: 'html2canvas failed: ' + e.message };
            }
        });

        console.log('Capture result:', JSON.stringify({ ...captureResult, base64: captureResult.base64 ? `[${captureResult.base64.length} chars]` : undefined }, null, 2));

        if (captureResult.success && captureResult.base64) {
            const buf = Buffer.from(captureResult.base64, 'base64');
            fs.writeFileSync(OUTPUT_PNG, buf);
            console.log(`\nPNG saved: ${OUTPUT_PNG} (${buf.length} bytes)`);
            console.log(`Coverage: ${captureResult.coveragePercent}% non-transparent pixels`);
            console.log(`Blank: ${captureResult.isBlank}`);
        }

        // Step 3: Try alternative — Playwright's own screenshot
        console.log('\n--- Step 3: Playwright native screenshot ---');
        const slideEl = await page.$('#output > div');
        if (slideEl) {
            const pwScreenshot = path.join(__dirname, '_test_slide_playwright.png');
            await slideEl.screenshot({ path: pwScreenshot });
            const size = fs.statSync(pwScreenshot).size;
            console.log(`Playwright screenshot: ${pwScreenshot} (${size} bytes)`);
        }

        // Print console logs
        if (consoleLogs.length > 0) {
            console.log('\n--- Browser console ---');
            consoleLogs.forEach(l => console.log('  ', l));
        }

    } finally {
        await browser.close();
        server.close();
        // Cleanup test HTML
        try { fs.unlinkSync(testHtmlPath); } catch {}
    }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
