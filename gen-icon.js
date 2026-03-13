const sharp = require('sharp');
const path = require('path');

// Super simple icon — just basic shapes, no text, no complex paths
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <!-- Blue rounded background -->
  <rect width="256" height="256" rx="40" fill="#0078d4"/>
  
  <!-- White document shape -->
  <rect x="40" y="30" width="120" height="160" rx="8" fill="#ffffff"/>
  
  <!-- Document lines -->
  <rect x="56" y="56" width="60" height="6" rx="3" fill="#0078d4" opacity="0.5"/>
  <rect x="56" y="72" width="88" height="6" rx="3" fill="#0078d4" opacity="0.35"/>
  <rect x="56" y="88" width="72" height="6" rx="3" fill="#0078d4" opacity="0.35"/>
  <rect x="56" y="104" width="88" height="6" rx="3" fill="#0078d4" opacity="0.35"/>
  <rect x="56" y="120" width="56" height="6" rx="3" fill="#0078d4" opacity="0.35"/>
  <rect x="56" y="136" width="80" height="6" rx="3" fill="#0078d4" opacity="0.35"/>
  <rect x="56" y="152" width="48" height="6" rx="3" fill="#0078d4" opacity="0.35"/>
  
  <!-- Yellow comment bubble -->
  <rect x="120" y="120" width="110" height="76" rx="16" fill="#ffc107"/>
  <polygon points="134,196 146,218 160,196" fill="#ffc107"/>
  
  <!-- Dots in bubble (typing indicator) -->
  <circle cx="152" cy="158" r="8" fill="#ffffff"/>
  <circle cx="175" cy="158" r="8" fill="#ffffff"/>
  <circle cx="198" cy="158" r="8" fill="#ffffff"/>
  
  <!-- Purple circle badge (AI) -->
  <circle cx="218" cy="116" r="28" fill="#7c4dff"/>
  <!-- Simple star/sparkle for AI (no text needed) -->
  <polygon points="218,100 222,112 234,112 224,120 228,132 218,124 208,132 212,120 202,112 214,112" fill="#ffffff"/>
</svg>`);

sharp(svg)
    .png()
    .toFile(path.join(__dirname, 'icon.png'))
    .then(info => console.log('Icon created:', info))
    .catch(err => console.error('Error:', err));
