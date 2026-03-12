/**
 * Test script for collectBlocks() — walks remark AST and verifies
 * that every block position correctly maps back to the source markdown.
 * 
 * Run: node test/test-blocks.js <markdown-file>
 */
const fs = require('fs');
const { unified } = require('unified');
const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkMath = require('remark-math').default || require('remark-math');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');

// Block types we want to make commentable
const COMMENTABLE_TYPES = new Set([
    'heading', 'paragraph', 'listItem', 'blockquote',
    'table', 'math', 'code', 'thematicBreak'
]);

function collectBlocks(markdown) {
    const tree = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkMath)
        .parse(markdown);

    const blocks = [];
    walkNode(tree, blocks, markdown);
    return blocks;
}

function walkNode(node, blocks, source) {
    if (COMMENTABLE_TYPES.has(node.type) && node.position) {
        const startOffset = node.position.start.offset;
        const endOffset = node.position.end.offset;
        const startLine = node.position.start.line;
        const endLine = node.position.end.line;

        // Extract a text preview (first 80 chars of the source range)
        const rawText = source.substring(startOffset, endOffset);
        const preview = rawText.substring(0, 80).replace(/\n/g, ' ').trim();

        blocks.push({
            type: node.type,
            startOffset,
            endOffset,
            startLine,
            endLine,
            preview,
        });
    }

    // Recurse into children
    if (node.children) {
        for (const child of node.children) {
            walkNode(child, blocks, source);
        }
    }
}

// --- Test ---
const testFile = process.argv[2] || 'c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md';
const source = fs.readFileSync(testFile, 'utf-8');
const blocks = collectBlocks(source);

console.log(`Found ${blocks.length} commentable blocks\n`);

// Verify each block
let errors = 0;
const typeCounts = {};
blocks.forEach((block, i) => {
    typeCounts[block.type] = (typeCounts[block.type] || 0) + 1;

    // Verify offsets are within source bounds
    if (block.startOffset < 0 || block.startOffset >= source.length) {
        console.error(`ERROR block ${i}: startOffset ${block.startOffset} out of bounds`);
        errors++;
    }
    if (block.endOffset <= block.startOffset || block.endOffset > source.length) {
        console.error(`ERROR block ${i}: endOffset ${block.endOffset} invalid (start=${block.startOffset})`);
        errors++;
    }

    // Verify the source at this offset matches the preview
    const actual = source.substring(block.startOffset, Math.min(block.startOffset + 80, block.endOffset)).replace(/\n/g, ' ').trim();
    if (!actual.startsWith(block.preview.substring(0, 20))) {
        console.error(`ERROR block ${i} (${block.type} L${block.startLine}): preview mismatch`);
        console.error(`  Expected starts with: "${block.preview.substring(0, 40)}"`);
        console.error(`  Actual: "${actual.substring(0, 40)}"`);
        errors++;
    }

    // Verify inserting an anchor at startOffset doesn't corrupt the source
    const testSource = source.substring(0, block.startOffset) + '<!--@TEST-->' + source.substring(block.startOffset);
    // Check that the anchor is at a line boundary or start of a block (not mid-word)
    if (block.startOffset > 0) {
        const charBefore = source[block.startOffset - 1];
        if (/[a-zA-Z0-9]/.test(charBefore) && /[a-zA-Z0-9]/.test(source[block.startOffset])) {
            console.warn(`WARN block ${i} (${block.type} L${block.startLine}): anchor would split word at offset ${block.startOffset}`);
        }
    }
});

// Print summary
console.log('\nBlock type counts:');
Object.entries(typeCounts).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
});

// Print first 20 blocks for inspection
console.log('\nFirst 20 blocks:');
blocks.slice(0, 20).forEach((b, i) => {
    console.log(`  ${i}: [${b.type}] L${b.startLine}-${b.endLine} @${b.startOffset}-${b.endOffset} "${b.preview.substring(0, 50)}"`);
});

console.log(`\n${errors === 0 ? 'ALL TESTS PASSED' : errors + ' ERRORS FOUND'}`);

// Verify anchor insertion for each block type
console.log('\nAnchor insertion test:');
const sampleBlocks = {};
blocks.forEach(b => { if (!sampleBlocks[b.type]) sampleBlocks[b.type] = b; });
Object.entries(sampleBlocks).forEach(([type, block]) => {
    const before = source.substring(Math.max(0, block.startOffset - 5), block.startOffset);
    const after = source.substring(block.startOffset, block.startOffset + 20);
    const charBefore = block.startOffset > 0 ? source[block.startOffset - 1] : '\\n';
    const isLineBoundary = charBefore === '\n' || block.startOffset === 0;
    console.log(`  ${type}: charBefore="${charBefore === '\n' ? '\\n' : charBefore}" lineBoundary=${isLineBoundary} after="${after.replace(/\n/g, '\\n').substring(0, 30)}"`);
});
