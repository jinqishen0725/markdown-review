// Trace the anchor placement bug for c1773344971570
const fs = require('fs');
const raw = fs.readFileSync('c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md', 'utf-8');

// Simulate the state BEFORE c1773344971570 was inserted
// (only c1773344850421 and c1773344899147 existed)
let rawBefore = raw.replace(/<!--@c1773344971570-->\r?\n?/g, '');

const vsc = raw.replace(/\r\n/g, '\n');
const clean = vsc.replace(/<!--@c\d+-->\n?/g, '');

// The heading offset in clean text
const headingOffset = clean.indexOf('### 1.1 What is UMS?');
console.log('Heading clean offset:', headingOffset);

// cleanOffsetToActual on rawBefore (CRLF, with 2 existing anchors)
function cleanOffsetToActual(source, cleanOffset) {
    const anchorPattern = /<!--@c\d+-->\r?\n?/g;
    const anchors = [];
    let match;
    while ((match = anchorPattern.exec(source)) !== null) {
        anchors.push({ start: match.index, length: match[0].length });
    }
    let actual = 0;
    let clean = 0;
    let anchorIdx = 0;
    while (clean < cleanOffset && actual < source.length) {
        if (anchorIdx < anchors.length && actual === anchors[anchorIdx].start) {
            actual += anchors[anchorIdx].length;
            anchorIdx++;
            continue;
        }
        if (source[actual] === '\r' && actual + 1 < source.length && source[actual + 1] === '\n') {
            actual++;
            continue;
        }
        actual++;
        clean++;
    }
    while (anchorIdx < anchors.length && actual === anchors[anchorIdx].start) {
        actual += anchors[anchorIdx].length;
        anchorIdx++;
    }
    return actual;
}

const mapped = cleanOffsetToActual(rawBefore, headingOffset);
console.log('Mapped to actual offset:', mapped);
console.log('At that position:', JSON.stringify(rawBefore.substring(mapped, mapped + 40)));

// Check where heading actually is in rawBefore
const rawHeadingOffset = rawBefore.indexOf('### 1.1 What is UMS?');
console.log('\nActual heading position in rawBefore:', rawHeadingOffset);
console.log('At heading:', JSON.stringify(rawBefore.substring(rawHeadingOffset, rawHeadingOffset + 40)));

// Show snap-to-lineStart behavior
let lineStart = mapped;
while (lineStart > 0 && rawBefore[lineStart - 1] !== '\n') {
    lineStart--;
}
console.log('\nlineStart (snap-back):', lineStart);
console.log('At lineStart:', JSON.stringify(rawBefore.substring(lineStart, lineStart + 40)));

// Check if mapped === rawHeadingOffset
console.log('\nMapped matches heading?', mapped === rawHeadingOffset);
console.log('lineStart matches heading?', lineStart === rawHeadingOffset);

// Show the anchors found in rawBefore
const anchorPattern2 = /<!--@c\d+-->\r?\n?/g;
let m2;
while ((m2 = anchorPattern2.exec(rawBefore)) !== null) {
    console.log('Existing anchor:', m2[0].trim(), 'at', m2.index, 'len', m2[0].length);
}
