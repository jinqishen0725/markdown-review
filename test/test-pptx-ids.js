const JSZip = require('jszip');
const fs = require('fs');
async function run() {
    const zip = await JSZip.loadAsync(fs.readFileSync('test/UMS_Experiment_Proposal.pptx'));
    const slide3 = await zip.file('ppt/slides/slide3.xml').async('string');
    
    // Extract all shape IDs
    const idRegex = /<p:cNvPr\s+id="(\d+)"\s+name="([^"]+)"/g;
    let m;
    console.log('=== Slide 3 shape cNvPr IDs ===');
    while ((m = idRegex.exec(slide3)) !== null) {
        console.log('  id=' + m[1] + ' name="' + m[2] + '"');
    }
    
    // Check for creationId GUIDs (unique persistent IDs)
    const guidRegex = /creationId[^>]*id="\{([^}]+)\}"/g;
    console.log('\n=== creationId GUIDs ===');
    while ((m = guidRegex.exec(slide3)) !== null) {
        console.log('  ' + m[1]);
    }
    
    // Check for spMk (shape marker used by modern comments)
    console.log('\n=== Shape structure snippet (first shape) ===');
    const firstSp = slide3.match(/<p:sp>[\s\S]*?<\/p:sp>/);
    if (firstSp) {
        // Just show the nvSpPr part
        const nvSpPr = firstSp[0].match(/<p:nvSpPr>[\s\S]*?<\/p:nvSpPr>/);
        if (nvSpPr) console.log(nvSpPr[0].substring(0, 500));
    }
    
    // The key question: can we use cNvPr id to locate shapes in XML?
    console.log('\n=== Answer ===');
    console.log('Yes! Each shape has <p:cNvPr id="N" name="..."/>');
    console.log('These are unique per slide and can be used to locate shapes.');
    console.log('Agent can search for: <p:cNvPr id="10" to find "Rectangle: Rounded Corners 9"');
}
run();
