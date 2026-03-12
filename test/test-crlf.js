// Test: does CRLF vs LF mismatch cause wrong anchor placement?
const fs = require('fs');
const path = 'c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md';

const raw = fs.readFileSync(path, 'utf-8');

// Simulate what VS Code TextDocument.getText() returns: \r\n → \n
const vscodeText = raw.replace(/\r\n/g, '\n');

// Simulate what renderMarkdown does: strip anchors from vscode text
const cleanVscode = vscodeText.replace(/<!--@c\d+-->\n?/g, '');

// Simulate what fs.readFileSync gives in insertAnchor: raw CRLF with anchors
const cleanRaw = raw.replace(/<!--@c\d+-->\r?\n?/g, '');

// Find "## Executive Summary" offset in both
const targetText = '## Executive Summary';
const offsetInCleanVscode = cleanVscode.indexOf(targetText);
const offsetInCleanRaw = cleanRaw.indexOf(targetText);

console.log('=== Offset comparison ===');
console.log('Offset in clean VS Code text (LF):', offsetInCleanVscode);
console.log('Offset in clean raw file (CRLF):', offsetInCleanRaw);
console.log('Mismatch:', offsetInCleanVscode !== offsetInCleanRaw);
console.log('Diff:', offsetInCleanRaw - offsetInCleanVscode, 'bytes');

// The comment stores startOffset from the "+" button which uses blocks from clean vscode text
// highlightCommentedBlocks queries data-start-offset which comes from remark parsing clean vscode text
// So both should be in LF-space. Let's verify:
console.log('\n=== Highlight matching test ===');
console.log('Comment stores startOffset:', offsetInCleanVscode, '(from blocks parsed from clean vscode text)');
console.log('HTML has data-start-offset:', offsetInCleanVscode, '(from remark parsing same clean vscode text)');
console.log('These should MATCH for highlighting → YES');

// Now test insertAnchor: it reads raw file, maps cleanOffset → actual offset
// But cleanOffset was computed in LF space, while cleanOffsetToActual works on CRLF raw file
console.log('\n=== insertAnchor offset mapping test ===');

// Simulate cleanOffsetToActual with raw CRLF source
function cleanOffsetToActual(source, cleanOffset) {
    const anchorPattern = /<!--@c\d+-->\n?/g;  // NOTE: no \r handling!
    let actual = 0;
    let clean = 0;
    const anchors = [];
    let match;
    while ((match = anchorPattern.exec(source)) !== null) {
        anchors.push({ start: match.index, length: match[0].length });
    }
    let anchorIdx = 0;
    while (clean < cleanOffset && actual < source.length) {
        if (anchorIdx < anchors.length && actual === anchors[anchorIdx].start) {
            actual += anchors[anchorIdx].length;
            anchorIdx++;
            continue;
        }
        actual++;
        clean++;
    }
    return actual;
}

const actualOffset = cleanOffsetToActual(raw, offsetInCleanVscode);
console.log('cleanOffsetToActual(raw, ' + offsetInCleanVscode + ') =', actualOffset);
console.log('Character at that offset:', JSON.stringify(raw.substring(actualOffset, actualOffset + 30)));
console.log('Expected: "## Executive Summary"');

// Also check: what does the raw file have where we EXPECT the heading?
const rawHeadingIdx = raw.indexOf(targetText);
console.log('\nActual heading position in raw file:', rawHeadingIdx);
console.log('Mismatch between mapped offset and actual:', actualOffset !== rawHeadingIdx);

// Test the anchor regex on CRLF content
console.log('\n=== Anchor regex test on CRLF ===');
const testCrlf = '<!--@c123-->\r\n## Heading\r\n';
const testLf = '<!--@c123-->\n## Heading\n';
console.log('Regex /<!--@c\\d+-->\\n?/ on CRLF strips to:', JSON.stringify(testCrlf.replace(/<!--@c\d+-->\n?/g, '')));
console.log('Regex /<!--@c\\d+-->\\n?/ on LF strips to:', JSON.stringify(testLf.replace(/<!--@c\d+-->\n?/g, '')));
console.log('CRLF leaves stray \\r:', testCrlf.replace(/<!--@c\d+-->\n?/g, '').startsWith('\r'));

// renderMarkdown strip test
console.log('\n=== renderMarkdown anchor strip test ===');
const renderRegex = /<!--@c\d+-->\n?/g;
console.log('Regex used in renderMarkdown: /<!--@c\\d+-->\\n?/g');
const strippedVscode = vscodeText.replace(renderRegex, '');
const execSumInStripped = strippedVscode.indexOf(targetText);
console.log('After stripping from vscode text (LF):', execSumInStripped, '→ correct since LF anchors have \\n');

// But what if vscode text somehow has \r\n? VS Code normalizes, so it shouldn't.
// However the debounced watcher re-reads this.document.getText() which IS normalized.
console.log('\n=== CONCLUSION ===');
console.log('The highlighting flow (blocks + querySelector) is entirely in LF space → should work');
console.log('The insertAnchor flow maps LF-space offset on CRLF file → MISMATCH if \\r counted');
