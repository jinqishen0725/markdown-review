/**
 * Deep dive into comments, shapes, and notes structure.
 */
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const fs = require('fs');
const path = require('path');

const pptxPath = path.join(__dirname, 'UMS_Experiment_Proposal.pptx');

async function run() {
    const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
    
    // === Comments (modern format) ===
    console.log('=== Modern Comment ===');
    const commentFile = zip.file('ppt/comments/modernComment_109_0.xml');
    if (commentFile) {
        const xml = await commentFile.async('string');
        console.log(xml);
    }
    
    // === Authors ===
    console.log('\n=== Authors ===');
    const authorsFile = zip.file('ppt/authors.xml');
    if (authorsFile) {
        const xml = await authorsFile.async('string');
        console.log(xml);
    }
    
    // === Notes Slide 1 ===
    console.log('\n=== Notes Slide 1 ===');
    const noteFile = zip.file('ppt/notesSlides/notesSlide1.xml');
    if (noteFile) {
        const xml = await noteFile.async('string');
        console.log(xml.substring(0, 800));
    }
    
    // === Slide 3 (complex - 12 shapes) ===
    console.log('\n=== Slide 3 Shape Analysis ===');
    const slide3 = await zip.file('ppt/slides/slide3.xml').async('string');
    const dom = new DOMParser().parseFromString(slide3, 'text/xml');
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    
    // Find all shapes 
    const shapes = dom.getElementsByTagNameNS(P, 'sp');
    console.log(`Total shapes: ${shapes.length}`);
    
    for (let i = 0; i < shapes.length; i++) {
        const sp = shapes[i];
        const cNvPr = sp.getElementsByTagNameNS(P, 'cNvPr')[0];
        const id = cNvPr?.getAttribute('id') || '?';
        const name = cNvPr?.getAttribute('name') || '?';
        
        // Position/size
        const off = sp.getElementsByTagNameNS(A, 'off')[0];
        const ext = sp.getElementsByTagNameNS(A, 'ext')[0];
        const x = off?.getAttribute('x') || '?';
        const y = off?.getAttribute('y') || '?';
        const cx = ext?.getAttribute('cx') || '?';
        const cy = ext?.getAttribute('cy') || '?';
        
        // Text content
        const tNodes = sp.getElementsByTagNameNS(A, 't');
        let text = '';
        for (let j = 0; j < tNodes.length; j++) {
            text += (tNodes[j].textContent || '') + ' ';
        }
        text = text.trim().substring(0, 80);
        
        // Placeholder type
        const ph = sp.getElementsByTagNameNS(P, 'ph')[0];
        const phType = ph?.getAttribute('type') || '';
        
        console.log(`  [${i}] id=${id} "${name}" pos=(${x},${y}) size=(${cx},${cy}) ph=${phType || 'none'}`);
        console.log(`      text: "${text}"`);
    }
    
    // === Slide 12 rels (has images) ===
    console.log('\n=== Slide 12 Relationships ===');
    const slide12Rels = await zip.file('ppt/slides/_rels/slide12.xml.rels')?.async('string');
    if (slide12Rels) {
        console.log(slide12Rels);
    }
    
    // === Presentation rels (to get slide numbering) ===
    console.log('\n=== Presentation Relationships ===');
    const presRels = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
    if (presRels) {
        const rels = presRels.match(/<Relationship[^>]*\/>/g) || [];
        rels.filter(r => r.includes('slide')).forEach(r => console.log('  ', r.substring(0, 150)));
    }
}

run().catch(e => console.error(e));
