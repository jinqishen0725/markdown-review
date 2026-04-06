/**
 * Diagnose: Why comment 36's paraId doesn't match the commentsExtended entry.
 * Hypothesis: comments with multiple paragraphs — we pick the first paraId 
 * but commentsExtended references a different one.
 */

const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const fs = require('fs');

const docxPath = 'C:\\Users\\jinqishen\\OneDrive - Microsoft\\Documents\\UMS_Documentation\\Metric\\dogfood\\UMS_Dogfood_Production_Design_export.docx';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';

async function run() {
    const zip = await JSZip.loadAsync(fs.readFileSync(docxPath));
    
    // Parse ALL paraIds from each comment (not just the first)
    const commentsXml = await zip.file('word/comments.xml').async('string');
    const commentsDom = new DOMParser().parseFromString(commentsXml, 'text/xml');
    const commentNodes = commentsDom.getElementsByTagNameNS(W, 'comment');
    
    console.log('=== All paraIds per comment ===\n');
    const allParaIds = new Map(); // paraId → commentId
    
    for (let i = 0; i < commentNodes.length; i++) {
        const el = commentNodes[i];
        const cid = el.getAttribute('w:id');
        const author = el.getAttribute('w:author');
        const tNodes = el.getElementsByTagNameNS(W, 't');
        let text = '';
        for (let j = 0; j < tNodes.length; j++) text += tNodes[j].textContent || '';
        
        const paras = el.getElementsByTagNameNS(W, 'p');
        const paraIds = [];
        for (let p = 0; p < paras.length; p++) {
            const pid = paras[p].getAttributeNS(W14, 'paraId')
                || paras[p].getAttribute('w14:paraId');
            if (pid) {
                paraIds.push(pid);
                allParaIds.set(pid, cid);
            }
        }
        
        if (paraIds.length > 1) {
            console.log(`Comment ${cid} [${author}] has ${paraIds.length} paragraphs!`);
            console.log(`  paraIds: ${paraIds.join(', ')}`);
            console.log(`  Current parser picks: ${paraIds[0]} (first)`);
            console.log(`  text: "${text.substring(0, 60)}"`);
        }
    }
    
    // Now check commentsExtended — which paraIds does it use?
    console.log('\n=== commentsExtended unmatched entries ===\n');
    const extFile = zip.file('word/commentsExtended.xml');
    const extXml = new DOMParser().parseFromString(await extFile.async('string'), 'text/xml');
    const exts = extXml.getElementsByTagNameNS(W15, 'commentEx');
    
    for (let i = 0; i < exts.length; i++) {
        const paraId = exts[i].getAttributeNS(W15, 'paraId')
            || exts[i].getAttribute('w15:paraId') || '';
        const parentParaId = exts[i].getAttributeNS(W15, 'paraIdParent')
            || exts[i].getAttribute('w15:paraIdParent') || '';
        
        const commentId = allParaIds.get(paraId);
        
        if (!commentId) {
            console.log(`ORPHAN: paraId=${paraId} not found in ANY comment paragraph!`);
        } else {
            // Check if this was the FIRST paraId we'd pick
            const commentEl = commentsDom.querySelectorAll ?
                null : null; // Can't use querySelectorAll with xmldom
            
            // Just report which comment it maps to using allParaIds
            console.log(`paraId=${paraId} → comment ${commentId}${parentParaId ? ' (parent paraId=' + parentParaId + ' → comment ' + (allParaIds.get(parentParaId) || '?') + ')' : ' (root)'}`);
        }
    }
    
    // Key question: for comments 36 and 13, does commentsExtended reference 
    // a paraId that's NOT the first paragraph?
    console.log('\n=== Specific check for comments 13 and 36 ===\n');
    
    for (const cid of ['13', '36']) {
        let commentEl = null;
        for (let i = 0; i < commentNodes.length; i++) {
            if (commentNodes[i].getAttribute('w:id') === cid) {
                commentEl = commentNodes[i];
                break;
            }
        }
        if (!commentEl) continue;
        
        const paras = commentEl.getElementsByTagNameNS(W, 'p');
        const paraIds = [];
        for (let p = 0; p < paras.length; p++) {
            const pid = paras[p].getAttributeNS(W14, 'paraId')
                || paras[p].getAttribute('w14:paraId');
            if (pid) paraIds.push(pid);
        }
        
        console.log(`Comment ${cid}: ${paras.length} paragraphs, paraIds = [${paraIds.join(', ')}]`);
        console.log(`  Parser picks first: ${paraIds[0]}`);
        
        // Check which paraId commentsExtended uses for this comment
        for (let e = 0; e < exts.length; e++) {
            const ePid = exts[e].getAttributeNS(W15, 'paraId')
                || exts[e].getAttribute('w15:paraId') || '';
            if (paraIds.includes(ePid)) {
                const parentPid = exts[e].getAttributeNS(W15, 'paraIdParent')
                    || exts[e].getAttribute('w15:paraIdParent') || '';
                console.log(`  commentsExtended uses paraId=${ePid} (index ${paraIds.indexOf(ePid)}) → parent=${parentPid || '(root)'}`);
                if (paraIds.indexOf(ePid) !== 0) {
                    console.log(`  *** BUG: Parser picks index 0 (${paraIds[0]}) but threading uses index ${paraIds.indexOf(ePid)} (${ePid})`);
                }
            }
        }
    }
}

run().catch(e => console.error(e));
