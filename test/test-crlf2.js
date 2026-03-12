// Simulate a fresh comment add on a clean CRLF file
const fs = require('fs');
const filepath = 'c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md';
const raw = fs.readFileSync(filepath, 'utf-8');

// VS Code normalizes to LF
const vscodeText = raw.replace(/\r\n/g, '\n');
// No anchors, so clean = vscodeText
const cleanOffset = vscodeText.indexOf('## Executive Summary');
console.log('Clean offset (LF space):', cleanOffset);

// cleanOffsetToActual on raw (no anchors, so it should just return cleanOffset)
// But the raw file has \r\n, so offset 190 in LF != offset 190 in CRLF
function cleanOffsetToActual(source, cleanOffset) {
    const anchorPattern = /<!--@c\d+-->\n?/g;
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

const mapped = cleanOffsetToActual(raw, cleanOffset);
console.log('Mapped to actual offset:', mapped);
console.log('At that position:', JSON.stringify(raw.substring(mapped, mapped + 30)));
console.log('Expected: "## Executive Summary"');

// What does raw.indexOf give?
const rawOffset = raw.indexOf('## Executive Summary');
console.log('\nActual position in CRLF file:', rawOffset);
console.log('Character there:', JSON.stringify(raw.substring(rawOffset, rawOffset + 30)));

// The problem: cleanOffsetToActual counts \r as regular chars but LF-space skipped them
// So in a clean file (no anchors), it just returns cleanOffset unchanged.
// But cleanOffset=190 in LF-space != 190 in CRLF-space because \r\n is 2 bytes vs \n 1 byte.
console.log('\n=== Root cause ===');
console.log('LF offset 190 != CRLF offset 190');
console.log('cleanOffsetToActual does NOT convert LF→CRLF offsets, only skips anchors');
console.log('Need: count \r characters before the target as extra bytes');

// What the CORRECT mapping would be:
function lfOffsetToCrlf(source, lfOffset) {
    // source is CRLF, lfOffset is position in LF-normalized version
    let lf = 0;
    let actual = 0;
    while (lf < lfOffset && actual < source.length) {
        if (source[actual] === '\r' && actual + 1 < source.length && source[actual + 1] === '\n') {
            actual++; // skip \r, the \n will be counted normally
        }
        actual++;
        lf++;
    }
    return actual;
}

const correctOffset = lfOffsetToCrlf(raw, cleanOffset);
console.log('\nCorrect CRLF offset:', correctOffset);
console.log('At that position:', JSON.stringify(raw.substring(correctOffset, correctOffset + 30)));
