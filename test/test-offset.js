// Test offset adjustment for anchor insertion
const fs = require('fs');
const testMd = 'C:/Users/jinqishen/Documents/test_offset2.md';
fs.writeFileSync(testMd, '# Heading 1\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.\n');

const source0 = fs.readFileSync(testMd, 'utf-8');
console.log('Original:');
console.log(source0);

// Simulates addComment calling insertAnchor with offsets from clean file
function insertAnchor(id, offset) {
    let source = fs.readFileSync(testMd, 'utf-8');
    const anchor = `<!--@${id}-->`;
    
    // Adjust offset for existing anchors
    let adjustedOffset = offset;
    const anchorPattern = /<!--@c\d+-->/g;
    let match;
    while ((match = anchorPattern.exec(source)) !== null) {
        if (match.index <= adjustedOffset) {
            adjustedOffset += match[0].length;
        }
    }
    
    console.log(`  ${id}: original offset=${offset}, adjusted=${adjustedOffset}, char at adj="${source[adjustedOffset]}"`);
    source = source.substring(0, adjustedOffset) + anchor + source.substring(adjustedOffset);
    fs.writeFileSync(testMd, source);
}

// Offsets from the CLEAN file
insertAnchor('c001', 0);   // Before "# Heading 1"
insertAnchor('c002', 14);  // Before "Paragraph one."
insertAnchor('c003', 30);  // Before "Paragraph two."

const final = fs.readFileSync(testMd, 'utf-8');
console.log('\nFinal:');
console.log(final);

const ok1 = final.includes('<!--@c001--># Heading 1');
const ok2 = final.includes('<!--@c002-->Paragraph one.');
const ok3 = final.includes('<!--@c003-->Paragraph two.');
console.log('\nc001 correct:', ok1);
console.log('c002 correct:', ok2);
console.log('c003 correct:', ok3);
console.log(ok1 && ok2 && ok3 ? 'ALL PASS' : 'SOME FAILED');

fs.unlinkSync(testMd);
