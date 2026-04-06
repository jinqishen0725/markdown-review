/**
 * Explore the internal structure of a .pptx file to understand the format.
 */
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const pptxPath = path.join(__dirname, 'UMS_Experiment_Proposal.pptx');

async function run() {
    const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
    
    // List all files
    console.log('=== ZIP Contents ===');
    const files = Object.keys(zip.files).sort();
    files.forEach(f => {
        const file = zip.files[f];
        if (!file.dir) {
            console.log(`  ${f} (${file._data ? file._data.uncompressedSize || '?' : '?'} bytes)`);
        } else {
            console.log(`  ${f} [DIR]`);
        }
    });
    
    // Parse presentation.xml for slide dimensions and slide list
    console.log('\n=== presentation.xml ===');
    const presXml = await zip.file('ppt/presentation.xml').async('string');
    // Slide size
    const sldSzMatch = presXml.match(/<p:sldSz[^>]*\/>/);
    console.log('Slide size:', sldSzMatch ? sldSzMatch[0] : 'not found');
    // Slide list
    const sldIdMatches = presXml.match(/<p:sldId[^>]*\/>/g) || [];
    console.log('Slide count:', sldIdMatches.length);
    sldIdMatches.forEach(s => console.log('  ', s));
    
    // Check for comments
    console.log('\n=== Comments ===');
    const commentFiles = files.filter(f => f.includes('comment'));
    console.log('Comment-related files:', commentFiles.length ? commentFiles.join(', ') : 'NONE');
    
    if (zip.file('ppt/commentAuthors.xml')) {
        const authorsXml = await zip.file('ppt/commentAuthors.xml').async('string');
        console.log('commentAuthors.xml:', authorsXml.substring(0, 500));
    }
    
    // Parse first slide
    console.log('\n=== Slide 1 ===');
    const slide1 = await zip.file('ppt/slides/slide1.xml')?.async('string');
    if (slide1) {
        console.log('Length:', slide1.length);
        // Count shapes
        const spCount = (slide1.match(/<p:sp[\s>]/g) || []).length;
        const picCount = (slide1.match(/<p:pic[\s>]/g) || []).length;
        const grpCount = (slide1.match(/<p:grpSp[\s>]/g) || []).length;
        const tblCount = (slide1.match(/<a:tbl[\s>]/g) || []).length;
        console.log(`Shapes: ${spCount} sp, ${picCount} pic, ${grpCount} grpSp, ${tblCount} tbl`);
        
        // Extract text from first slide
        const texts = slide1.match(/<a:t>([^<]*)<\/a:t>/g) || [];
        console.log('Text runs:', texts.length);
        texts.forEach(t => {
            const content = t.replace(/<[^>]+>/g, '');
            if (content.trim()) console.log('  "' + content + '"');
        });
    }
    
    // Check slide relationships
    console.log('\n=== Slide 1 Relationships ===');
    const slide1Rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')?.async('string');
    if (slide1Rels) {
        const rels = slide1Rels.match(/<Relationship[^>]*\/>/g) || [];
        rels.forEach(r => console.log('  ', r.substring(0, 150)));
    }
    
    // Check how many slides have notes
    console.log('\n=== Notes ===');
    const noteFiles = files.filter(f => f.startsWith('ppt/notesSlides/'));
    console.log('Notes slides:', noteFiles.length ? noteFiles.join(', ') : 'NONE');
    
    // Check media files
    console.log('\n=== Media ===');
    const mediaFiles = files.filter(f => f.startsWith('ppt/media/'));
    console.log(`Media files: ${mediaFiles.length}`);
    mediaFiles.forEach(f => console.log('  ', f));
    
    // Parse a few slides to understand shape structure
    const slideFiles = files.filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => {
        return parseInt(a.match(/\d+/)?.[0] || '0') - parseInt(b.match(/\d+/)?.[0] || '0');
    });
    console.log(`\n=== All ${slideFiles.length} Slides Summary ===`);
    for (const sf of slideFiles) {
        const xml = await zip.file(sf).async('string');
        const spCount = (xml.match(/<p:sp[\s>]/g) || []).length;
        const picCount = (xml.match(/<p:pic[\s>]/g) || []).length;
        const tblCount = (xml.match(/<a:tbl[\s>]/g) || []).length;
        const texts = (xml.match(/<a:t>([^<]*)<\/a:t>/g) || [])
            .map(t => t.replace(/<[^>]+>/g, '').trim())
            .filter(t => t);
        const firstText = texts.slice(0, 3).join(' | ');
        console.log(`  ${path.basename(sf)}: ${spCount} shapes, ${picCount} pics, ${tblCount} tables — "${firstText}"`);
    }
    
    // Dump first shape XML from slide 1 for detailed analysis
    console.log('\n=== First Shape XML (Slide 1, truncated) ===');
    if (slide1) {
        const firstSpMatch = slide1.match(/<p:sp>[\s\S]*?<\/p:sp>/);
        if (firstSpMatch) {
            console.log(firstSpMatch[0].substring(0, 800));
        }
    }
}

run().catch(e => console.error(e));
