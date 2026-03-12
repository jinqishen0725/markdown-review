// Trace drift for c1773348313793: targeting paragraph at cleanOffset=222
const fs = require('fs');
const raw = fs.readFileSync('c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md', 'utf-8');
const vscText = raw.replace(/\r\n/g, '\n'); // VS Code getText()

console.log('File line endings: CRLF =', raw.includes('\r\n'));
console.log('VS Code text length:', vscText.length);
console.log('Raw file length:', raw.length);
console.log('');

// Check what's at cleanOffset=222 in anchor-free text
const cleanText = vscText.replace(/<!--@c\d+-->\n?/g, '');
console.log('=== Clean text (no anchors) ===');
console.log('At offset 222:', JSON.stringify(cleanText.substring(222, 280)));

// Show line number at offset 222 in clean text
const cleanLine = cleanText.substring(0, 222).split('\n').length;
console.log('Clean text line at 222:', cleanLine);

console.log('\n=== Now trace insertAnchorViaApi ===');
console.log('VS Code text (with existing anchors):');

// Find all anchors in vscText 
const anchorRe = /<!--@c\d+-->\n?/g;
const anchors = [];
let m;
while ((m = anchorRe.exec(vscText)) !== null) {
    anchors.push({ start: m.index, length: m[0].length, id: m[0].substring(5, m[0].indexOf('-->')) });
}
console.log('Existing anchors in vscText:', anchors.length);
anchors.forEach(a => {
    const line = vscText.substring(0, a.start).split('\n').length;
    console.log(`  ${a.id} at offset ${a.start} (line ${line}), length ${a.length}`);
});

// Simulate cleanOffsetToDocOffset (from insertAnchorViaApi)
const cleanOffset = 222;
let docOffset = 0;
let clean = 0;
let anchorIdx = 0;

// Sort anchors by start position
const sortedAnchors = [...anchors].sort((a, b) => a.start - b.start);

while (clean < cleanOffset && docOffset < vscText.length) {
    // Check if we're at an anchor
    const currentAnchor = sortedAnchors.find(a => a.start === docOffset);
    if (currentAnchor) {
        docOffset += currentAnchor.length;
        continue;
    }
    docOffset++;
    clean++;
}
// Skip any anchor at this exact position
let skippedAnchor = sortedAnchors.find(a => a.start === docOffset);
while (skippedAnchor) {
    docOffset += skippedAnchor.length;
    skippedAnchor = sortedAnchors.find(a => a.start === docOffset);
}

console.log('\ncleanOffset:', cleanOffset, '→ docOffset:', docOffset);
console.log('At docOffset:', JSON.stringify(vscText.substring(docOffset, docOffset + 60)));

// Snap to line start
let lineStart = docOffset;
while (lineStart > 0 && vscText[lineStart - 1] !== '\n') {
    lineStart--;
}
console.log('lineStart:', lineStart);
console.log('At lineStart:', JSON.stringify(vscText.substring(lineStart, lineStart + 60)));

const anchorLine = vscText.substring(0, lineStart).split('\n').length;
console.log('Anchor would go on line:', anchorLine);

// Where SHOULD it go? (right before "This document consolidates...")
const targetIdx = vscText.indexOf('This document consolidates');
const targetLine = vscText.substring(0, targetIdx).split('\n').length;
console.log('\nTarget "This document..." is at offset', targetIdx, 'line', targetLine);
console.log('Expected anchor line:', targetLine); // anchor goes on line before content

// Show the area around the target
console.log('\n=== Lines around target ===');
const lines = vscText.split('\n');
for (let i = Math.max(0, targetLine - 4); i < Math.min(lines.length, targetLine + 2); i++) {
    console.log(`  Line ${i + 1}: "${lines[i].substring(0, 60)}"`);
}
