// Trace why anchors are placed several lines before the target block
// Simulates insertAnchorViaApi logic on the VS Code normalized text

const fs = require('fs');
const raw = fs.readFileSync('c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md', 'utf-8');
const vscText = raw.replace(/\r\n/g, '\n'); // simulate VS Code getText()

// Strip all anchors to get clean text (same as renderMarkdown does)
const cleanText = vscText.replace(/<!--@c\d+-->\n?/g, '');

// Load comments
const comments = JSON.parse(
    fs.readFileSync('c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md.comments.json', 'utf-8')
).comments;

// Simulate insertAnchorViaApi: map cleanOffset to docOffset (vscText with anchors)
function cleanOffsetToDocOffset(text, cleanOffset) {
    const anchorRe = /<!--@c\d+-->\n?/g;
    const anchors = [];
    let m;
    while ((m = anchorRe.exec(text)) !== null) {
        anchors.push({ start: m.index, length: m[0].length });
    }
    let docOffset = 0;
    let clean = 0;
    let anchorIdx = 0;
    while (clean < cleanOffset && docOffset < text.length) {
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
    return docOffset;
}

// Simulate snap-back to line start
function snapToLineStart(text, offset) {
    let lineStart = offset;
    while (lineStart > 0 && text[lineStart - 1] !== '\n') {
        lineStart--;
    }
    return lineStart;
}

console.log('=== Anchor placement trace ===\n');

for (const c of comments) {
    const cleanOffset = c.startOffset;
    
    // What's at cleanOffset in the clean text?
    const targetInClean = cleanText.substring(cleanOffset, cleanOffset + 50).replace(/\n/g, '\\n');
    
    // Map to docOffset (vscText which has existing anchors)
    const docOffset = cleanOffsetToDocOffset(vscText, cleanOffset);
    const lineStart = snapToLineStart(vscText, docOffset);
    
    // What's at docOffset?
    const atDocOffset = vscText.substring(docOffset, docOffset + 50).replace(/\n/g, '\\n');
    const atLineStart = vscText.substring(lineStart, lineStart + 50).replace(/\n/g, '\\n');
    
    // How many lines between lineStart and docOffset?
    const gap = vscText.substring(lineStart, docOffset);
    const blankLines = (gap.match(/\n/g) || []).length;
    
    // What line number is the anchor on vs the target?
    const anchorLine = vscText.substring(0, lineStart).split('\n').length;
    const targetLine = vscText.substring(0, docOffset).split('\n').length;
    
    console.log(`Comment ${c.id}:`);
    console.log(`  Target: ${c.blockType} "${c.blockPreview.substring(0, 40)}"`);
    console.log(`  cleanOffset: ${cleanOffset} → "${targetInClean}"`);
    console.log(`  docOffset:   ${docOffset} → "${atDocOffset}"`);
    console.log(`  lineStart:   ${lineStart} → "${atLineStart}"`);
    console.log(`  Anchor would go on line ${anchorLine}, target on line ${targetLine}, gap: ${blankLines} blank lines`);
    console.log(`  Gap content: "${gap.replace(/\n/g, '\\n')}"`);
    console.log('');
}
