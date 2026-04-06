/**
 * Test the pptx parser with the example presentation.
 */
const { parsePptx } = require('../out/test-pptx-parser.js');
const path = require('path');

const pptxPath = path.join(__dirname, 'UMS_Experiment_Proposal.pptx');

async function run() {
    console.log('Parsing:', pptxPath);
    const model = await parsePptx(pptxPath);
    
    console.log(`\nDimensions: ${model.dimensions.cx} x ${model.dimensions.cy} EMU`);
    console.log(`  = ${model.dimensions.cx / 914400} x ${model.dimensions.cy / 914400} inches`);
    console.log(`Slides: ${model.slides.length}`);
    console.log(`Comments: ${model.comments.length}`);
    console.log(`Authors: ${model.authors.size}`);
    model.authors.forEach((name, id) => console.log(`  ${id}: ${name}`));
    
    console.log('\n=== Slides ===');
    for (const slide of model.slides) {
        console.log(`\nSlide ${slide.index} (id=${slide.slideId}):`);
        console.log(`  Shapes: ${slide.shapes.length}`);
        for (const shape of slide.shapes) {
            const pos = `(${Math.round(shape.x/914400*100)/100}", ${Math.round(shape.y/914400*100)/100}")`;
            const size = `${Math.round(shape.cx/914400*100)/100}" x ${Math.round(shape.cy/914400*100)/100}"`;
            const ph = shape.placeholderType ? ` [ph:${shape.placeholderType}]` : '';
            const fill = shape.fillColor ? ` fill:${shape.fillColor}` : '';
            console.log(`    ${shape.type} id=${shape.id} "${shape.name}"${ph}${fill}`);
            console.log(`      pos=${pos} size=${size}`);
            console.log(`      text: "${shape.text.substring(0, 80).replace(/\n/g, '\\n')}"`);
        }
        if (slide.notes) {
            console.log(`  Notes: "${slide.notes.substring(0, 100)}"`);
        }
    }
    
    console.log('\n=== Comments ===');
    for (const c of model.comments) {
        console.log(`  [Slide ${c.slideIndex}] ${c.authorName}: "${c.text.substring(0, 80)}"`);
        console.log(`    id=${c.id}, shapeId=${c.shapeId}, slideId=${c.slideId}`);
    }
    
    // Summary stats
    const totalShapes = model.slides.reduce((sum, s) => sum + s.shapes.length, 0);
    const totalText = model.slides.reduce((sum, s) => sum + s.shapes.reduce((ss, sh) => ss + sh.text.length, 0), 0);
    const slidesWithNotes = model.slides.filter(s => s.notes).length;
    console.log('\n=== Summary ===');
    console.log(`Total shapes: ${totalShapes}`);
    console.log(`Total text chars: ${totalText}`);
    console.log(`Slides with notes: ${slidesWithNotes}`);
}

run().catch(e => console.error(e));
