/**
 * Test parser renders: verify geometry and font fixes.
 */
const { parsePptx } = require('../out/test-pptx-parser.js');
const path = require('path');

async function run() {
    const model = await parsePptx(path.join(__dirname, 'UMS_Experiment_Proposal.pptx'));
    
    // Check slide 2 font sizes
    console.log('=== Slide 2 font check ===');
    const s2 = model.slides[1];
    for (const sh of s2.shapes) {
        const sizes = sh.paragraphs.map(p => p.fontSize || p.runs[0]?.fontSize).filter(Boolean);
        console.log(`  "${sh.name}" geom=${sh.geometry||'rect'} fontScale=${sh.fontScale||'none'}`);
        console.log(`    insets: l=${sh.bodyInsets?.l} t=${sh.bodyInsets?.t}`);
        console.log(`    font sizes (hundredths): ${sizes.join(', ')} → px: ${sizes.map(s => Math.round(s/100)).join(', ')}`);
    }
    
    // Check slide 6 arrows
    console.log('\n=== Slide 6 geometry check ===');
    const s6 = model.slides[5];
    for (const sh of s6.shapes) {
        console.log(`  "${sh.name}" geom=${sh.geometry||'(none)'} fill=${sh.fillColor||'none'}`);
    }
    
    // Verify no more 1.33x factor in HTML
    console.log('\n=== Slide 2 HTML font-size check ===');
    const htmlSizes = s2.shapes[1].htmlContent.match(/font-size:\d+px/g) || [];
    console.log(`  HTML sizes found: ${htmlSizes.join(', ')}`);
    console.log(`  Expected: font-size:20px (for sz=2000) and font-size:16px (for sz=1600)`);
}

run().catch(e => console.error(e));
