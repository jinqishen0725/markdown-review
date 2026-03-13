const fs = require('fs');
const { execFileSync } = require('child_process');

// Create SVG icon
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a73e8"/>
      <stop offset="100%" style="stop-color:#0d47a1"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="20" fill="url(#bg)"/>
  <rect x="30" y="18" width="52" height="68" rx="4" fill="#fff" opacity="0.95"/>
  <rect x="38" y="30" width="28" height="3" rx="1.5" fill="#1a73e8" opacity="0.6"/>
  <rect x="38" y="38" width="36" height="3" rx="1.5" fill="#1a73e8" opacity="0.4"/>
  <rect x="38" y="46" width="32" height="3" rx="1.5" fill="#1a73e8" opacity="0.4"/>
  <rect x="38" y="54" width="36" height="3" rx="1.5" fill="#1a73e8" opacity="0.4"/>
  <rect x="38" y="62" width="24" height="3" rx="1.5" fill="#1a73e8" opacity="0.4"/>
  <g transform="translate(62,58)">
    <rect x="0" y="0" width="48" height="36" rx="8" fill="#ffc107"/>
    <polygon points="8,36 16,46 20,36" fill="#ffc107"/>
    <rect x="8" y="9" width="24" height="2.5" rx="1" fill="#fff" opacity="0.9"/>
    <rect x="8" y="15" width="32" height="2.5" rx="1" fill="#fff" opacity="0.7"/>
    <rect x="8" y="21" width="18" height="2.5" rx="1" fill="#fff" opacity="0.7"/>
  </g>
  <circle cx="98" cy="54" r="12" fill="#6a1b9a"/>
  <text x="98" y="58" text-anchor="middle" fill="#fff" font-size="11" font-family="Arial" font-weight="bold">AI</text>
</svg>`;

// Write SVG to temp HTML for Chrome screenshot
const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:0;}</style></head><body>${svg}</body></html>`;
const htmlPath = require('path').resolve(__dirname, 'icon-temp.html');
const pngPath = require('path').resolve(__dirname, 'icon.png');

fs.writeFileSync(htmlPath, html, 'utf-8');

// Use Chrome headless to screenshot
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
try {
    execFileSync(chromePath, [
        '--headless=new', '--disable-gpu',
        `--screenshot=${pngPath}`,
        '--window-size=128,128',
        `file:///${htmlPath.replace(/\\/g, '/')}`
    ], { timeout: 15000, cwd: __dirname });
    console.log('Icon generated:', pngPath);
    console.log('Size:', fs.statSync(pngPath).size, 'bytes');
} catch (e) {
    console.error('Chrome failed:', e.message);
}

// Cleanup
try { fs.unlinkSync(htmlPath); } catch {}
try { fs.unlinkSync(require('path').resolve(__dirname, 'icon.svg.html')); } catch {}
