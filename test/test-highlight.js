const fs = require('fs');
const text = fs.readFileSync('c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md', 'utf-8');
const cleanText = text.replace(/<!--@c\d+-->\n?/g, '');

const idx = cleanText.indexOf('## Executive Summary');
console.log('Clean offset of "## Executive Summary":', idx);

const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');
const remarkMath = require('remark-math').default || require('remark-math');
const { unified } = require('unified');
const remarkRehype = require('remark-rehype').default || require('remark-rehype');
const rehypeStringify = require('rehype-stringify').default || require('rehype-stringify');
const rehypeRaw = require('rehype-raw').default || require('rehype-raw');

// Collect remark AST heading offsets
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const tree = parser.parse(cleanText);
(function walk(node) {
    if (node.type === 'heading' && node.position) {
        const preview = cleanText.substring(node.position.start.offset, node.position.start.offset + 60).replace(/\n/g, ' ');
        console.log('Remark heading at offset', node.position.start.offset, ':', preview);
    }
    if (node.children) node.children.forEach(walk);
})(tree);

// Check rehype data-start-offset values
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

const proc = unified()
    .use(remarkParse).use(remarkGfm).use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSourcePositions)
    .use(rehypeStringify, { allowDangerousHtml: true });

const html = String(proc.processSync(cleanText));

// Find all h2 elements and their data-start-offset
const re = /data-start-offset="(\d+)"[^>]*data-end-offset="(\d+)"[^>]*>([^<]{0,60})/g;
let m;
const h2re = /<h2[^>]*data-start-offset="(\d+)"[^>]*>/g;
while ((m = h2re.exec(html)) !== null) {
    const off = parseInt(m[1]);
    const after = html.substring(m.index, m.index + 120).replace(/\n/g, ' ');
    console.log('H2 at data-start-offset', off, ':', after);
}

// Comments stored offsets
console.log('\n--- Comments stored startOffsets ---');
console.log('c1773342489625: startOffset=198 (should match Executive Summary)');
console.log('c1773342511455: startOffset=687 (should match Primary Metric paragraph)');
console.log('c1773342531377: startOffset=3523 (should match 1.2 heading)');
