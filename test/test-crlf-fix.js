// Validate the CRLF fix: cleanOffsetToActual with \r skipping
const fs = require('fs');
const filepath = 'c:/Users/jinqishen/source/repos/AdsPipeline/private/Platform/UMS/Lab/jinqishen/UMS_Quality_Metrics_Summary.md';
const raw = fs.readFileSync(filepath, 'utf-8');
const vscodeText = raw.replace(/\r\n/g, '\n');

// Fixed cleanOffsetToActual
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
    // If we landed exactly on an anchor, skip past it
    while (anchorIdx < anchors.length && actual === anchors[anchorIdx].start) {
        actual += anchors[anchorIdx].length;
        anchorIdx++;
    }
    return actual;
}

// Test targets
const targets = [
    { name: 'Executive Summary', text: '## Executive Summary' },
    { name: '1.1 What is UMS?', text: '### 1.1 What is UMS?' },
    { name: '1.2 Why Do We Need', text: '### 1.2 Why Do We Need Quality Metrics?' },
    { name: 'Primary Metric Rec', text: '**Primary Metric Recommendation:**' },
    { name: 'B-Cubed Precision', text: '### 2.1 B-Cubed Precision' },
];

let allPassed = true;
targets.forEach(t => {
    const cleanOffset = vscodeText.indexOf(t.text);
    const mapped = cleanOffsetToActual(raw, cleanOffset);
    const rawOffset = raw.indexOf(t.text);
    const match = mapped === rawOffset;
    if (!match) allPassed = false;
    console.log(`${match ? 'PASS' : 'FAIL'} ${t.name}: clean=${cleanOffset} → mapped=${mapped}, actual=${rawOffset}`);
});

// Test with an anchor present: insert one and re-test
console.log('\n--- With one anchor inserted ---');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const heading = '## Executive Summary';
const headingPos = raw.indexOf(heading);
let modified = raw.substring(0, headingPos) + `<!--@c999-->${eol}` + raw.substring(headingPos);

// Now test: "### 1.1 What is UMS?" should still map correctly
const cleanModified = vscodeText; // VS Code text doesn't change until re-read
const target2 = '### 1.1 What is UMS?';
const cleanOffset2 = vscodeText.indexOf(target2);
const mapped2 = cleanOffsetToActual(modified, cleanOffset2);
const rawOffset2 = modified.indexOf(target2);
const match2 = mapped2 === rawOffset2;
if (!match2) allPassed = false;
console.log(`${match2 ? 'PASS' : 'FAIL'} 1.1 (with anchor before): clean=${cleanOffset2} → mapped=${mapped2}, actual=${rawOffset2}`);

// Test with TWO anchors
const target3text = '### 1.2 Why Do We Need Quality Metrics?';
const pos3 = modified.indexOf(target3text);
modified = modified.substring(0, pos3) + `<!--@c998-->${eol}` + modified.substring(pos3);
const cleanOffset3 = vscodeText.indexOf(target3text);
const mapped3 = cleanOffsetToActual(modified, cleanOffset3);
const rawOffset3 = modified.indexOf(target3text);
const match3 = mapped3 === rawOffset3;
if (!match3) allPassed = false;
console.log(`${match3 ? 'PASS' : 'FAIL'} 1.2 (with 2 anchors before): clean=${cleanOffset3} → mapped=${mapped3}, actual=${rawOffset3}`);

console.log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
