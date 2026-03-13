// Standalone PNG trimmer using pngjs (pure JS, no native deps)
// Usage: node trim-png.js <input.png> <output.png>
const fs = require('fs');
const { PNG } = require('pngjs');

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
    console.error('Usage: node trim-png.js <input.png> <output.png>');
    process.exit(1);
}

const data = fs.readFileSync(inputPath);
const png = PNG.sync.read(data);
const { width, height } = png;

// Find bounding box of non-white pixels
let top = height, bottom = 0, left = width, right = 0;
for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
        const idx = (width * y + x) << 2;
        const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2];
        if (r < 250 || g < 250 || b < 250) {
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
        }
    }
}

if (top > bottom || left > right) {
    fs.copyFileSync(inputPath, outputPath);
    console.log(JSON.stringify({ width, height, trimmed: false }));
    process.exit(0);
}

// Add padding
const pad = 20;
top = Math.max(0, top - pad);
bottom = Math.min(height - 1, bottom + pad);
left = Math.max(0, left - pad);
right = Math.min(width - 1, right + pad);

const newWidth = right - left + 1;
const newHeight = bottom - top + 1;

const out = new PNG({ width: newWidth, height: newHeight });
for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
        const srcIdx = (width * (y + top) + (x + left)) << 2;
        const dstIdx = (newWidth * y + x) << 2;
        out.data[dstIdx] = png.data[srcIdx];
        out.data[dstIdx + 1] = png.data[srcIdx + 1];
        out.data[dstIdx + 2] = png.data[srcIdx + 2];
        out.data[dstIdx + 3] = png.data[srcIdx + 3];
    }
}

const outBuf = PNG.sync.write(out);
fs.writeFileSync(outputPath, outBuf);
console.log(JSON.stringify({ width: newWidth, height: newHeight, trimmed: true }));
