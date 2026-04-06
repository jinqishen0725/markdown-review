/**
 * Analyze the pptx-renderer source to find text color resolution logic.
 */
const fs = require('fs');
const src = fs.readFileSync('node_modules/@aiden0z/pptx-renderer/dist/aiden0z-pptx-renderer.es.js', 'utf-8');

// Find all .style.color = assignments
const regex = /\.style\.color\s*=\s*[^;]+;/g;
let match;
let i = 0;
while ((match = regex.exec(src)) !== null) {
    i++;
    const start = Math.max(0, match.index - 150);
    const pre = src.substring(start, match.index);
    const lastLines = pre.split('\n').slice(-3).join('\n');
    console.log(`\n=== Match ${i} at offset ${match.index} ===`);
    console.log('...' + lastLines);
    console.log(match[0]);
}

// Also find where the run color (J variable) gets resolved
console.log('\n\n=== Looking for run color resolution ===');
const runColorIdx = src.indexOf('J ? I.style.color = J');
if (runColorIdx >= 0) {
    const ctx = src.substring(Math.max(0, runColorIdx - 1500), runColorIdx + 300);
    console.log(ctx);
}
