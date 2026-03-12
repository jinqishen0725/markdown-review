// Verify v2.0.2 insertAnchorViaApi places anchor on the correct line for fresh comments
const fs = require('fs');
const raw = fs.readFileSync('c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md', 'utf-8');
const vscText = raw.replace(/\r\n/g, '\n'); // VS Code getText()

// File should be clean (no anchors)
const anchorCount = (vscText.match(/<!--@c\d+-->/g) || []).length;
console.log('Anchors in file:', anchorCount);
if (anchorCount > 0) { console.log('WARNING: file not clean!'); }

// Remark parse to get block offsets (same as collectBlocks)
const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');
const remarkMath = require('remark-math').default || require('remark-math');
const { unified } = require('unified');
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const tree = parser.parse(vscText);
const blocks = [];
const TYPES = new Set(['heading', 'paragraph', 'listItem', 'blockquote', 'table', 'math', 'code', 'thematicBreak']);
(function walk(n) {
    if (TYPES.has(n.type) && n.position) {
        blocks.push({ type: n.type, startOffset: n.position.start.offset,
            preview: vscText.substring(n.position.start.offset, n.position.start.offset + 40).replace(/\n/g, ' ') });
    }
    if (n.children) n.children.forEach(walk);
})(tree);

// Simulate insertAnchorViaApi for a few target blocks
function simulateInsert(blockIdx) {
    const block = blocks[blockIdx];
    const cleanOffset = block.startOffset;
    
    // No anchors, so docOffset = cleanOffset
    let docOffset = cleanOffset;
    
    // Snap back to line start
    let lineStart = docOffset;
    while (lineStart > 0 && vscText[lineStart - 1] !== '\n') {
        lineStart--;
    }
    
    // What line is this?
    const anchorLineNum = vscText.substring(0, lineStart).split('\n').length;
    const targetLineNum = vscText.substring(0, docOffset).split('\n').length;
    
    // Check: lineStart should equal docOffset (block should start at column 0)
    const atLineStart = vscText.substring(lineStart, lineStart + 50).replace(/\n/g, '\\n');
    const gap = docOffset - lineStart;
    
    console.log(`Block ${blockIdx}: ${block.type} "${block.preview.substring(0, 35)}"`);
    console.log(`  cleanOffset=${cleanOffset}, lineStart=${lineStart}, gap=${gap}`);
    console.log(`  Anchor on line ${anchorLineNum}, target on line ${targetLineNum}`);
    console.log(`  At lineStart: "${atLineStart}"`);
    console.log(`  ${gap === 0 ? 'OK - anchor right before target' : 'ISSUE - gap of ' + gap + ' chars'}`);
    console.log('');
}

console.log('\n=== Fresh comment placement simulation ===\n');

// Test various block types
const testBlocks = [
    blocks.findIndex(b => b.type === 'heading' && b.preview.includes('Executive Summary')),
    blocks.findIndex(b => b.type === 'heading' && b.preview.includes('1.1 What is UMS')),
    blocks.findIndex(b => b.type === 'heading' && b.preview.includes('2.1 B-Cubed Precision')),
    blocks.findIndex(b => b.type === 'table' && b.preview.includes('Property')),
    blocks.findIndex(b => b.type === 'paragraph' && b.preview.includes('Primary Metric')),
    blocks.findIndex(b => b.type === 'math'),
    blocks.findIndex(b => b.type === 'blockquote'),
    blocks.findIndex(b => b.type === 'listItem'),
];

testBlocks.filter(i => i >= 0).forEach(i => simulateInsert(i));
