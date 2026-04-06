/**
 * Analyze font sizes and shape geometries to understand rendering issues.
 */
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const fs = require('fs');
const path = require('path');

const pptxPath = path.join(__dirname, 'UMS_Experiment_Proposal.pptx');
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

async function run() {
    const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
    
    // Slide 2 (Background) - text overflow issue
    console.log('=== Slide 2: Font sizes & shape bounds ===');
    const slide2 = await zip.file('ppt/slides/slide2.xml').async('string');
    const dom2 = new DOMParser().parseFromString(slide2, 'text/xml');
    const shapes2 = dom2.getElementsByTagNameNS(P, 'sp');
    
    for (let i = 0; i < shapes2.length; i++) {
        const sp = shapes2[i];
        const cNvPr = sp.getElementsByTagNameNS(P, 'cNvPr')[0];
        const name = cNvPr?.getAttribute('name') || '';
        
        // Shape bounds
        const off = sp.getElementsByTagNameNS(A, 'off')[0];
        const ext = sp.getElementsByTagNameNS(A, 'ext')[0];
        const cx = parseInt(ext?.getAttribute('cx') || '0');
        const cy = parseInt(ext?.getAttribute('cy') || '0');
        
        // All font sizes in this shape
        const rPrs = sp.getElementsByTagNameNS(A, 'rPr');
        const defRPrs = sp.getElementsByTagNameNS(A, 'defRPr');
        const sizes = new Set();
        for (let j = 0; j < rPrs.length; j++) {
            const sz = rPrs[j].getAttribute('sz');
            if (sz) sizes.add(sz);
        }
        for (let j = 0; j < defRPrs.length; j++) {
            const sz = defRPrs[j].getAttribute('sz');
            if (sz) sizes.add(sz);
        }
        
        // Text autofit settings
        const bodyPr = sp.getElementsByTagNameNS(A, 'bodyPr')[0];
        const autoFit = bodyPr?.getElementsByTagNameNS(A, 'spAutoFit')[0];
        const normAutofit = bodyPr?.getElementsByTagNameNS(A, 'normAutofit')[0];
        const noAutofit = bodyPr?.getElementsByTagNameNS(A, 'noAutofit')[0];
        const wrap = bodyPr?.getAttribute('wrap') || '';
        const lIns = bodyPr?.getAttribute('lIns') || '';
        const tIns = bodyPr?.getAttribute('tIns') || '';
        
        // Paragraph indent levels
        const pPrs = sp.getElementsByTagNameNS(A, 'pPr');
        const levels = new Set();
        for (let j = 0; j < pPrs.length; j++) {
            const lvl = pPrs[j].getAttribute('lvl');
            if (lvl) levels.add(lvl);
            // Check for bullet character
            const buChar = pPrs[j].getElementsByTagNameNS(A, 'buChar')[0];
            if (buChar) levels.add('buChar:' + buChar.getAttribute('char'));
        }
        
        const EMU = 914400;
        console.log(`\n  "${name}" size=${(cx/EMU).toFixed(1)}"x${(cy/EMU).toFixed(1)}"`);
        console.log(`    fontSizes: ${[...sizes].join(', ')} (hundredths pt)`);
        console.log(`    autofit: ${autoFit ? 'spAutoFit' : normAutofit ? 'normAutofit fontScale=' + (normAutofit.getAttribute('fontScale') || '?') : noAutofit ? 'noAutofit' : 'default'}`);
        console.log(`    wrap=${wrap} lIns=${lIns} tIns=${tIns}`);
        console.log(`    levels: ${[...levels].join(', ')}`);
    }
    
    // Slide 6 - arrow shapes
    console.log('\n\n=== Slide 6: Shape geometries ===');
    const slide6 = await zip.file('ppt/slides/slide6.xml').async('string');
    const dom6 = new DOMParser().parseFromString(slide6, 'text/xml');
    const shapes6 = dom6.getElementsByTagNameNS(P, 'sp');
    
    for (let i = 0; i < shapes6.length; i++) {
        const sp = shapes6[i];
        const cNvPr = sp.getElementsByTagNameNS(P, 'cNvPr')[0];
        const name = cNvPr?.getAttribute('name') || '';
        
        const ext = sp.getElementsByTagNameNS(A, 'ext')[0];
        const cx = parseInt(ext?.getAttribute('cx') || '0');
        const cy = parseInt(ext?.getAttribute('cy') || '0');
        
        // Preset geometry
        const prstGeom = sp.getElementsByTagNameNS(A, 'prstGeom')[0];
        const prst = prstGeom?.getAttribute('prst') || '(none)';
        
        // Fill
        const solidFill = sp.getElementsByTagNameNS(A, 'solidFill')[0];
        const srgb = solidFill?.getElementsByTagNameNS(A, 'srgbClr')[0];
        const fill = srgb?.getAttribute('val') || '';
        
        const EMU = 914400;
        console.log(`  "${name}" geom=${prst} size=${(cx/EMU).toFixed(2)}"x${(cy/EMU).toFixed(2)}" fill=#${fill || 'none'}`);
    }
    
    // Also check all unique preset geometries across all slides  
    console.log('\n\n=== All unique preset geometries ===');
    const allGeoms = new Map();
    for (let s = 1; s <= 12; s++) {
        const slideXml = await zip.file(`ppt/slides/slide${s}.xml`)?.async('string');
        if (!slideXml) continue;
        const dom = new DOMParser().parseFromString(slideXml, 'text/xml');
        const prstGeoms = dom.getElementsByTagNameNS(A, 'prstGeom');
        for (let i = 0; i < prstGeoms.length; i++) {
            const prst = prstGeoms[i].getAttribute('prst') || '';
            allGeoms.set(prst, (allGeoms.get(prst) || 0) + 1);
        }
    }
    allGeoms.forEach((count, geom) => console.log(`  ${geom}: ${count} shapes`));
}

run().catch(e => console.error(e));
