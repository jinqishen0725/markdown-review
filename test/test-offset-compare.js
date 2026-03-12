// Compare remark block offsets vs rehype data-start-offset values
const fs = require('fs');
const raw = fs.readFileSync('c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md', 'utf-8');
const vsc = raw.replace(/\r\n/g, '\n');
const clean = vsc.replace(/<!--@c\d+-->\n?/g, '');

const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');
const remarkMath = require('remark-math').default || require('remark-math');
const remarkRehype = require('remark-rehype').default || require('remark-rehype');
const rehypeStringify = require('rehype-stringify').default || require('rehype-stringify');
const rehypeRaw = require('rehype-raw').default || require('rehype-raw');
const { unified } = require('unified');

// collectBlocks from remark
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const tree = parser.parse(clean);
const remarkBlocks = [];
const BLOCK_TYPES = new Set(['heading', 'paragraph', 'listItem', 'blockquote', 'table', 'math', 'code', 'thematicBreak']);
(function walk(n) {
    if (BLOCK_TYPES.has(n.type) && n.position) {
        remarkBlocks.push({
            type: n.type,
            startOffset: n.position.start.offset,
            preview: clean.substring(n.position.start.offset, n.position.start.offset + 40).replace(/\n/g, ' ')
        });
    }
    if (n.children) n.children.forEach(walk);
})(tree);

// rehype data-start-offset
function rehypeSourcePositions() {
    return (tree) => {
        (function visit(node) {
            if (node.type === 'element' && node.position) {
                if (!node.properties) node.properties = {};
                node.properties['data-start-offset'] = node.position.start.offset;
            }
            if (node.children) node.children.forEach(visit);
        })(tree);
    };
}
const proc = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeSourcePositions)
    .use(rehypeStringify, { allowDangerousHtml: true });
const html = String(proc.processSync(clean));

// Extract ALL data-start-offset values from HTML
const re = /data-start-offset="(\d+)"/g;
const rehypeOffsets = new Set();
let m;
while ((m = re.exec(html)) !== null) {
    rehypeOffsets.add(parseInt(m[1]));
}

// Check: do remark block offsets exist in rehype HTML?
let matchCount = 0;
let missCount = 0;
console.log('=== First 20 remark blocks: do they have matching data-start-offset in HTML? ===\n');
remarkBlocks.slice(0, 20).forEach(b => {
    const exists = rehypeOffsets.has(b.startOffset);
    if (exists) matchCount++; else missCount++;
    console.log(`${exists ? 'MATCH' : 'MISS '} ${b.type.padEnd(14)} offset=${b.startOffset} "${b.preview}"`);
});
console.log(`\nTotal: ${matchCount} match, ${missCount} miss out of ${Math.min(20, remarkBlocks.length)}`);

// Show what data-start-offset values ARE near the first heading
console.log('\n=== Rehype offsets near first heading (190) ===');
[...rehypeOffsets].filter(o => o >= 185 && o <= 200).sort((a, b) => a - b).forEach(o => {
    const context = html.substring(html.indexOf('data-start-offset="' + o + '"') - 10, html.indexOf('data-start-offset="' + o + '"') + 40);
    console.log('  offset', o, ':', context);
});
