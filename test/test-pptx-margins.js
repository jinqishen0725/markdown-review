/**
 * Analyze slide 3's text box - the one with bullet points that overflows.
 * Compare actual XML margins with what the library should use.
 */
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const fs = require('fs');
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

async function run() {
    const zip = await JSZip.loadAsync(fs.readFileSync('test/UMS_Experiment_Proposal.pptx'));
    
    // Check slide 2 (Background & Motivation) - the text-heavy slide
    console.log('=== Slide 2: TextBox with bullets ===');
    const slide2 = await zip.file('ppt/slides/slide2.xml').async('string');
    const dom2 = new DOMParser().parseFromString(slide2, 'text/xml');
    const shapes2 = dom2.getElementsByTagNameNS(P, 'sp');
    
    for (let i = 0; i < shapes2.length; i++) {
        const sp = shapes2[i];
        const cNvPr = sp.getElementsByTagNameNS(P, 'cNvPr')[0];
        const name = cNvPr?.getAttribute('name') || '';
        if (!name.includes('TextBox')) continue;
        
        const off = sp.getElementsByTagNameNS(A, 'off')[0];
        const ext = sp.getElementsByTagNameNS(A, 'ext')[0];
        console.log(`\n${name}:`);
        console.log(`  Position: x=${parseInt(off?.getAttribute('x')||0)/914400}" y=${parseInt(off?.getAttribute('y')||0)/914400}"`);
        console.log(`  Size: w=${parseInt(ext?.getAttribute('cx')||0)/914400}" h=${parseInt(ext?.getAttribute('cy')||0)/914400}"`);
        
        // Body properties
        const bodyPr = sp.getElementsByTagNameNS(A, 'bodyPr')[0];
        if (bodyPr) {
            console.log(`  bodyPr: lIns=${bodyPr.getAttribute('lIns')} tIns=${bodyPr.getAttribute('tIns')} rIns=${bodyPr.getAttribute('rIns')} bIns=${bodyPr.getAttribute('bIns')} wrap=${bodyPr.getAttribute('wrap')}`);
        }
        
        // Each paragraph's properties
        const txBody = sp.getElementsByTagNameNS(P, 'txBody')[0] || sp.getElementsByTagNameNS(A, 'txBody')[0];
        if (!txBody) continue;
        const paras = txBody.getElementsByTagNameNS(A, 'p');
        for (let j = 0; j < paras.length; j++) {
            const p = paras[j];
            if (p.parentNode !== txBody) continue;
            
            const pPr = p.getElementsByTagNameNS(A, 'pPr')[0];
            const marL = pPr?.getAttribute('marL');
            const indent = pPr?.getAttribute('indent');
            const lvl = pPr?.getAttribute('lvl');
            const algn = pPr?.getAttribute('algn');
            const spcBef = pPr?.getElementsByTagNameNS(A, 'spcBef')[0];
            const spcAft = pPr?.getElementsByTagNameNS(A, 'spcAft')[0];
            const lnSpc = pPr?.getElementsByTagNameNS(A, 'lnSpc')[0];
            const buChar = pPr?.getElementsByTagNameNS(A, 'buChar')[0];
            const buNone = pPr?.getElementsByTagNameNS(A, 'buNone')[0];
            
            // Get spc values
            let spcBefVal = '';
            if (spcBef) {
                const pts = spcBef.getElementsByTagNameNS(A, 'spcPts')[0];
                const pct = spcBef.getElementsByTagNameNS(A, 'spcPct')[0];
                spcBefVal = pts ? pts.getAttribute('val') + 'pts' : pct ? pct.getAttribute('val') + '%' : '';
            }
            let lnSpcVal = '';
            if (lnSpc) {
                const pts = lnSpc.getElementsByTagNameNS(A, 'spcPts')[0];
                const pct = lnSpc.getElementsByTagNameNS(A, 'spcPct')[0];
                lnSpcVal = pts ? pts.getAttribute('val') + 'pts' : pct ? pct.getAttribute('val') + '%' : '';
            }
            
            // defRPr font size
            const defRPr = pPr?.getElementsByTagNameNS(A, 'defRPr')[0];
            const defSz = defRPr?.getAttribute('sz');
            
            // Get text
            const ts = p.getElementsByTagNameNS(A, 't');
            let text = '';
            for (let k = 0; k < ts.length; k++) text += ts[k].textContent;
            
            const bullet = buChar ? 'buChar=' + buChar.getAttribute('char') : buNone ? 'buNone' : '';
            
            console.log(`  P[${j}]: marL=${marL||'null'} indent=${indent||'null'} lvl=${lvl||'0'} ${bullet} spcBef=${spcBefVal} lnSpc=${lnSpcVal} sz=${defSz||'?'}`);
            console.log(`         "${text.substring(0, 60)}"`);
        }
    }
    
    // Also check slide master for default text properties
    console.log('\n\n=== Slide Master default text styles ===');
    const master = await zip.file('ppt/slideMasters/slideMaster1.xml').async('string');
    const masterDom = new DOMParser().parseFromString(master, 'text/xml');
    const txStyles = masterDom.getElementsByTagNameNS(P, 'txStyles')[0];
    if (txStyles) {
        const bodyStyle = txStyles.getElementsByTagNameNS(P, 'bodyStyle')[0];
        if (bodyStyle) {
            const lvlPPrs = bodyStyle.childNodes;
            for (let i = 0; i < lvlPPrs.length; i++) {
                const n = lvlPPrs[i];
                if (n.nodeType !== 1) continue;
                const marL = n.getAttribute('marL');
                const indent = n.getAttribute('indent');
                const defRPr = n.getElementsByTagNameNS(A, 'defRPr')[0];
                const sz = defRPr?.getAttribute('sz');
                const buChar = n.getElementsByTagNameNS(A, 'buChar')[0];
                console.log(`  ${n.localName}: marL=${marL} indent=${indent} sz=${sz} ${buChar ? 'buChar=' + buChar.getAttribute('char') : ''}`);
            }
        }
    }
    
    // Slide dimensions
    const presXml = await zip.file('ppt/presentation.xml').async('string');
    const presDom = new DOMParser().parseFromString(presXml, 'text/xml');
    const sldSz = presDom.getElementsByTagNameNS(P, 'sldSz')[0];
    console.log(`\nSlide: ${parseInt(sldSz?.getAttribute('cx'))/914400}" x ${parseInt(sldSz?.getAttribute('cy'))/914400}"`);
    console.log(`In px at 96dpi: ${parseInt(sldSz?.getAttribute('cx'))/914400*96} x ${parseInt(sldSz?.getAttribute('cy'))/914400*96}`);
}

run().catch(e => console.error(e));
