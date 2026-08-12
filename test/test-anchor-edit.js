const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const output = path.join(repoRoot, 'out', 'anchor-edit-test.js');
esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src', 'anchor-edit.ts')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
});
const { applyAnchorFreeReplacements, computeMinimalReplacement, stripCommentAnchors } = require(output);

const anchored = '# Title\n\n<!--@c100-->\nParagraph one.\n\n<!--@c200-->\nParagraph two.\n';
const projection = stripCommentAnchors(anchored);
assert.equal(projection.cleanText, '# Title\n\nParagraph one.\n\nParagraph two.\n');
assert.deepEqual(projection.anchors, [
    { id: 'c100', cleanOffset: 9 },
    { id: 'c200', cleanOffset: 25 },
]);

const paragraphStart = projection.cleanText.indexOf('Paragraph one.');
const edited = applyAnchorFreeReplacements(anchored, [{
    start: paragraphStart,
    endExclusive: paragraphStart + 'Paragraph one.'.length,
    newText: 'A clearer first paragraph.',
}], '\n');
assert.match(edited, /<!--@c100-->\nA clearer first paragraph\./);
assert.match(edited, /<!--@c200-->\nParagraph two\./);
assert.equal(stripCommentAnchors(edited).cleanText, '# Title\n\nA clearer first paragraph.\n\nParagraph two.\n');

const inserted = applyAnchorFreeReplacements(anchored, [{ start: 0, endExclusive: 0, newText: 'Intro\n\n' }], '\n');
assert.match(inserted, /Intro\n\n# Title\n\n<!--@c100-->\nParagraph one\./);

const minimal = computeMinimalReplacement('abcXYZdef', 'abc123def');
assert.deepEqual(minimal, { start: 3, endExclusive: 6, newText: '123' });

console.log('Anchor-free Markdown editor projection tests passed.');