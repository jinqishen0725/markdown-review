// Check what anchorMap produces for the current file state
const fs = require('fs');
const raw = fs.readFileSync('c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md', 'utf-8');
const vscText = raw.replace(/\r\n/g, '\n'); // VS Code getText()

// Simulate renderMarkdown's anchor stripping and anchorMap building
const anchorMap = new Map();
let cleanText = '';
let lastEnd = 0;
const anchorRe = /<!--@(c\d+)-->\r?\n?/g;
let m;
while ((m = anchorRe.exec(vscText)) !== null) {
    cleanText += vscText.substring(lastEnd, m.index);
    anchorMap.set(m[1], cleanText.length);
    lastEnd = m.index + m[0].length;
}
cleanText += vscText.substring(lastEnd);

console.log('=== anchorMap positions ===\n');
for (const [id, pos] of anchorMap) {
    const context = cleanText.substring(pos, pos + 50).replace(/\n/g, '\\n');
    const line = cleanText.substring(0, pos).split('\n').length;
    console.log(`${id}: cleanPos=${pos} (line ${line}) → "${context}"`);
}

// Show where the actual blocks are in clean text
console.log('\n=== First few blocks in clean text ===\n');
const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');
const remarkMath = require('remark-math').default || require('remark-math');
const { unified } = require('unified');
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const tree = parser.parse(cleanText);
const blocks = [];
const TYPES = new Set(['heading', 'paragraph']);
(function walk(n) {
    if (TYPES.has(n.type) && n.position && n.position.start.offset < 1000) {
        blocks.push({ type: n.type, offset: n.position.start.offset,
            preview: cleanText.substring(n.position.start.offset, n.position.start.offset + 40).replace(/\n/g, ' ') });
    }
    if (n.children) n.children.forEach(walk);
})(tree);
blocks.forEach(b => console.log(`${b.type.padEnd(12)} offset=${b.offset} "${b.preview}"`));
