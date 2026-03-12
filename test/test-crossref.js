// Test: cleanOffsetToDocOffset and docOffsetToCleanOffset round-trip
// Also verifies cross-reference jump mapping accuracy
const fs = require('fs');
const filepath = 'c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md';
const raw = fs.readFileSync(filepath, 'utf-8');
const cleanText = raw.replace(/\r\n/g, '\n').replace(/<!--@c\d+-->\n?/g, '');

// Simulate a document with 2 anchors inserted (CRLF)
const eol = '\r\n';
const heading1 = raw.indexOf('## Executive Summary');
let doc = raw.substring(0, heading1) + `<!--@c999-->${eol}` + raw.substring(heading1);
const heading2Pos = doc.indexOf('### 1.1 What is UMS?');
doc = doc.substring(0, heading2Pos) + `<!--@c998-->${eol}` + doc.substring(heading2Pos);

// Simulate VS Code getText() — normalize to LF
const vscDoc = doc.replace(/\r\n/g, '\n');

// --- cleanOffsetToDocOffset ---
function cleanOffsetToDocOffset(text, cleanOffset) {
    const anchorRe = /<!--@c\d+-->\r?\n?/g;
    const anchors = [];
    let m;
    while ((m = anchorRe.exec(text)) !== null) {
        anchors.push({ start: m.index, length: m[0].length });
    }
    let docOff = 0, clean = 0, ai = 0;
    while (clean < cleanOffset && docOff < text.length) {
        if (ai < anchors.length && docOff === anchors[ai].start) {
            docOff += anchors[ai].length;
            ai++;
            continue;
        }
        docOff++;
        clean++;
    }
    while (ai < anchors.length && docOff === anchors[ai].start) {
        docOff += anchors[ai].length;
        ai++;
    }
    return docOff;
}

// --- docOffsetToCleanOffset ---
function docOffsetToCleanOffset(text, docOffset) {
    const anchorRe = /<!--@c\d+-->\r?\n?/g;
    let totalAnchorChars = 0;
    let m;
    while ((m = anchorRe.exec(text)) !== null) {
        if (m.index >= docOffset) break;
        const anchorEnd = m.index + m[0].length;
        if (anchorEnd <= docOffset) {
            totalAnchorChars += m[0].length;
        } else {
            totalAnchorChars += docOffset - m.index;
        }
    }
    return docOffset - totalAnchorChars;
}

// Test targets in clean text
const targets = [
    { name: 'Title', text: '# UMS Identity Graph' },
    { name: 'Executive Summary', text: '## Executive Summary' },
    { name: 'This document', text: 'This document consolidates' },
    { name: '1.1 What is UMS?', text: '### 1.1 What is UMS?' },
    { name: 'User Mapping Service', text: 'The User Mapping Service (UMS)' },
    { name: '2.1 B-Cubed', text: '### 2.1 B-Cubed Precision' },
];

let allPassed = true;
console.log('=== clean → doc → clean round-trip (with 2 anchors) ===\n');
targets.forEach(t => {
    const cleanOff = cleanText.indexOf(t.text);
    if (cleanOff === -1) { console.log(`SKIP ${t.name}: not found in clean text`); return; }
    
    // Forward: clean → doc
    const docOff = cleanOffsetToDocOffset(vscDoc, cleanOff);
    const atDoc = vscDoc.substring(docOff, docOff + 30).replace(/\n/g, '\\n');
    
    // Verify it points to the right text
    const expectedText = t.text.substring(0, 20);
    const actualText = vscDoc.substring(docOff, docOff + 20);
    const forwardOk = actualText.startsWith(expectedText);
    
    // Reverse: doc → clean
    const roundTrip = docOffsetToCleanOffset(vscDoc, docOff);
    const rtOk = roundTrip === cleanOff;
    
    const pass = forwardOk && rtOk;
    if (!pass) allPassed = false;
    
    console.log(`${pass ? 'PASS' : 'FAIL'} ${t.name}:`);
    console.log(`  clean=${cleanOff} → doc=${docOff} → clean=${roundTrip} (expected ${cleanOff})`);
    if (!forwardOk) console.log(`  Forward MISMATCH: expected "${expectedText}" got "${actualText.substring(0,20)}"`);
    if (!rtOk) console.log(`  Round-trip MISMATCH: ${roundTrip} !== ${cleanOff}`);
});

// Test: doc offset at an anchor should map to clean offset right after anchor
console.log('\n=== Edge cases ===\n');

// Cursor right at start of an anchor
const anchor1Idx = vscDoc.indexOf('<!--@c999-->');
const cleanAtAnchor = docOffsetToCleanOffset(vscDoc, anchor1Idx);
const cleanAfterAnchor = docOffsetToCleanOffset(vscDoc, anchor1Idx + '<!--@c999-->\n'.length);
console.log(`Cursor at anchor start (${anchor1Idx}): cleanOffset=${cleanAtAnchor}`);
console.log(`Cursor after anchor (${anchor1Idx + 14}): cleanOffset=${cleanAfterAnchor}`);
console.log(`Both should map to same clean position: ${cleanAtAnchor === cleanAfterAnchor ? 'PASS' : 'FAIL'}`);
if (cleanAtAnchor !== cleanAfterAnchor) allPassed = false;

// Cursor in middle of document text (not near any anchor)
const midClean = 1000;
const midDoc = cleanOffsetToDocOffset(vscDoc, midClean);
const midRt = docOffsetToCleanOffset(vscDoc, midDoc);
const midPass = midRt === midClean;
if (!midPass) allPassed = false;
console.log(`Mid-document (clean=${midClean}): doc=${midDoc}, round-trip=${midRt} ${midPass ? 'PASS' : 'FAIL'}`);

console.log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
