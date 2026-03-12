// Simulate sequential comment insertion to find the drift
const fs = require('fs');
const raw = fs.readFileSync('c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md', 'utf-8');

// Start with a CLEAN file (no anchors)
let vscText = raw.replace(/\r\n/g, '\n').replace(/<!--@c\d+-->\n?/g, '');

console.log('Starting with clean file, length:', vscText.length);
console.log('');

// The comments were added in timestamp order:
const commentsInOrder = [
    { id: 'c1773348143590', cleanOffset: 198, blockType: 'heading', target: '## Executive Summary' },
    { id: 'c1773348157527', cleanOffset: 2735, blockType: 'heading', target: '### 1.1 What is UMS?' },
    { id: 'c1773348166509', cleanOffset: 5482, blockType: 'heading', target: '### 2.1 B-Cubed Precision' },
    // Skip the rest, focus on early ones
];

// Wait - but the actual cleanOffset stored is from the INITIAL clean text before any anchors.
// But after each anchor is inserted, the VS Code document changes.
// The NEXT comment's cleanOffset is computed from the CURRENT document (with anchors).
// renderMarkdown strips anchors, so blocks are always in clean space.
// But insertAnchorViaApi reads this.document.getText() which HAS the previously inserted anchors!

// Let's simulate step by step:

function simulateInsert(vscText, cleanOffset, id) {
    // Step 1: map cleanOffset to docOffset (skip existing anchors in vscText)
    const anchorRe = /<!--@c\d+-->\n?/g;
    const anchors = [];
    let m;
    while ((m = anchorRe.exec(vscText)) !== null) {
        anchors.push({ start: m.index, length: m[0].length });
    }
    
    let docOffset = 0;
    let clean = 0;
    let anchorIdx = 0;
    while (clean < cleanOffset && docOffset < vscText.length) {
        if (anchorIdx < anchors.length && docOffset === anchors[anchorIdx].start) {
            docOffset += anchors[anchorIdx].length;
            anchorIdx++;
            continue;
        }
        docOffset++;
        clean++;
    }
    while (anchorIdx < anchors.length && docOffset === anchors[anchorIdx].start) {
        docOffset += anchors[anchorIdx].length;
        anchorIdx++;
    }

    // Step 2: snap to line start
    let lineStart = docOffset;
    while (lineStart > 0 && vscText[lineStart - 1] !== '\n') {
        lineStart--;
    }

    // Step 3: insert anchor
    const anchorText = `<!--@${id}-->\n`;
    const newText = vscText.substring(0, lineStart) + anchorText + vscText.substring(lineStart);
    
    const insertedLine = vscText.substring(0, lineStart).split('\n').length;
    const nextContent = vscText.substring(lineStart, lineStart + 50).replace(/\n/g, '\\n');
    
    return { newText, lineStart, docOffset, insertedLine, nextContent };
}

// Comment 1: c1773348143590 targeting "## Executive Summary" at cleanOffset 198
// But wait - the comments.json shows cleanOffset=198 which is 8 chars INTO "## Executive Summary" 
// "## Executive Summary" starts at offset 190 in clean text
// Hmm - but cleanOffset should be from blocks[].startOffset which IS the remark offset = 190
// The stored value 198 might be wrong. Let's check:

const execSumIdx = vscText.indexOf('## Executive Summary');
console.log('"## Executive Summary" at offset:', execSumIdx, '(expected 190)');
console.log('At 198:', JSON.stringify(vscText.substring(198, 220)));
console.log('At 190:', JSON.stringify(vscText.substring(190, 220)));

// Wait, the comment was stored with startOffset=198, not 190
// Let me check what remark gives:
const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');
const remarkMath = require('remark-math').default || require('remark-math');
const { unified } = require('unified');
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const tree = parser.parse(vscText);
(function walk(n) {
    if (n.type === 'heading' && n.position && n.position.start.offset < 300) {
        console.log(`Remark heading at offset ${n.position.start.offset}: "${vscText.substring(n.position.start.offset, n.position.start.offset + 30)}"`);
    }
    if (n.children) n.children.forEach(walk);
})(tree);

console.log('');
console.log('The stored startOffset=198 means it was NOT the remark block startOffset (190).');
console.log('Where did 198 come from? updateContent() updated it from anchorMap.');
console.log('');

// Let me just simulate with the CORRECT cleanOffset (190 from remark blocks)
console.log('=== Simulating with correct remark offsets ===\n');

// Insert first comment at cleanOffset 190 (heading ## Executive Summary)
let result = simulateInsert(vscText, 190, 'c9990000000001');
console.log('Insert 1: cleanOffset=190');
console.log(`  docOffset=${result.docOffset}, lineStart=${result.lineStart}`);
console.log(`  Inserted on line ${result.insertedLine}, before: "${result.nextContent}"`);
vscText = result.newText;

// Insert second comment at cleanOffset 212 (paragraph "This document consolidates...")
// Actually, what's at 212 in original clean text?
const origClean = raw.replace(/\r\n/g, '\n').replace(/<!--@c\d+-->\n?/g, '');
console.log('\nAt cleanOffset 212:', JSON.stringify(origClean.substring(212, 260)));

result = simulateInsert(vscText, 212, 'c9990000000002');
console.log('\nInsert 2: cleanOffset=212 (after first anchor exists)');
console.log(`  docOffset=${result.docOffset}, lineStart=${result.lineStart}`);
console.log(`  Inserted on line ${result.insertedLine}, before: "${result.nextContent}"`);

// Show lines around insertion
const lines = result.newText.split('\n');
for (let i = Math.max(0, result.insertedLine - 3); i < Math.min(lines.length, result.insertedLine + 3); i++) {
    const marker = (i + 1 === result.insertedLine) ? '>>>' : '   ';
    console.log(`  ${marker} Line ${i + 1}: "${lines[i].substring(0, 60)}"`);
}
