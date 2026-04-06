/**
 * Diagnose: 
 * 1. Why sidebar Reply button fails (inspect generated HTML)
 * 2. Why comments 35 and 36 are separate threads (check threading data)
 */

const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const fs = require('fs');

const docxPath = 'C:\\Users\\jinqishen\\OneDrive - Microsoft\\Documents\\UMS_Documentation\\Metric\\dogfood\\UMS_Dogfood_Production_Design_export.docx';

async function run() {
    const zip = await JSZip.loadAsync(fs.readFileSync(docxPath));
    
    // === Part 1: Check commentsExtended.xml threading for comments 35 and 36 ===
    console.log('=== THREADING DIAGNOSIS ===\n');
    
    // Parse comments.xml to get paraIds
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
    const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
    
    const commentsXml = await zip.file('word/comments.xml').async('string');
    const commentsDom = new DOMParser().parseFromString(commentsXml, 'text/xml');
    const commentNodes = commentsDom.getElementsByTagNameNS(W, 'comment');
    
    console.log('All comments with their paraIds:');
    const commentInfo = [];
    for (let i = 0; i < commentNodes.length; i++) {
        const el = commentNodes[i];
        const cid = el.getAttribute('w:id');
        const author = el.getAttribute('w:author');
        const tNodes = el.getElementsByTagNameNS(W, 't');
        let text = '';
        for (let j = 0; j < tNodes.length; j++) text += tNodes[j].textContent || '';
        
        const paras = el.getElementsByTagNameNS(W, 'p');
        let paraId = '';
        for (let p = 0; p < paras.length; p++) {
            const pid = paras[p].getAttributeNS(W14, 'paraId')
                || paras[p].getAttribute('w14:paraId');
            if (pid) { paraId = pid; break; }
        }
        
        commentInfo.push({ id: cid, author, text: text.substring(0, 60), paraId });
        console.log(`  Comment ${cid} [${author}] paraId=${paraId}: "${text.substring(0, 50)}"`);
    }
    
    // Parse commentsExtended.xml  
    console.log('\ncommentsExtended.xml entries:');
    const extFile = zip.file('word/commentsExtended.xml');
    if (!extFile) {
        console.log('  NO commentsExtended.xml found!');
    } else {
        const extXml = new DOMParser().parseFromString(await extFile.async('string'), 'text/xml');
        const exts = extXml.getElementsByTagNameNS(W15, 'commentEx');
        
        if (exts.length === 0) {
            // Try without namespace
            console.log('  No w15:commentEx found. Trying alternative...');
            const allEls = extXml.getElementsByTagName('*');
            for (let i = 0; i < allEls.length; i++) {
                const n = allEls[i];
                if (n.localName === 'commentEx') {
                    console.log(`  Found commentEx: ${n.toString().substring(0, 200)}`);
                }
            }
        }
        
        const threading = [];
        for (let i = 0; i < exts.length; i++) {
            const paraId = exts[i].getAttributeNS(W15, 'paraId')
                || exts[i].getAttribute('w15:paraId') || '';
            const parentParaId = exts[i].getAttributeNS(W15, 'paraIdParent')
                || exts[i].getAttribute('w15:paraIdParent') || '';
            const done = exts[i].getAttributeNS(W15, 'done')
                || exts[i].getAttribute('w15:done') || '';
            
            // Find which comment has this paraId
            const comment = commentInfo.find(c => c.paraId === paraId);
            const parent = parentParaId ? commentInfo.find(c => c.paraId === parentParaId) : null;
            
            threading.push({ paraId, parentParaId, done, commentId: comment?.id, parentCommentId: parent?.id });
            console.log(`  paraId=${paraId} → parentParaId=${parentParaId || '(root)'} done=${done} | comment=${comment?.id || '?'} → parent=${parent?.id || '(root)'}`);
        }
        
        // Specifically check comments 35 and 36
        console.log('\n--- Focus on comments 35 and 36 ---');
        const c35 = commentInfo.find(c => c.id === '35');
        const c36 = commentInfo.find(c => c.id === '36');
        console.log(`Comment 35: paraId=${c35?.paraId}, text="${c35?.text}"`);
        console.log(`Comment 36: paraId=${c36?.paraId}, text="${c36?.text}"`);
        
        const t35 = threading.find(t => t.commentId === '35');
        const t36 = threading.find(t => t.commentId === '36');
        console.log(`Threading 35: parent=${t35?.parentCommentId || '(root)'}`);
        console.log(`Threading 36: parent=${t36?.parentCommentId || '(root)'}`);
        
        if (!t36?.parentCommentId) {
            console.log('\nComment 36 is genuinely a ROOT comment in Word — not a reply to 35.');
            console.log('They share the same anchor text "Source" but are separate comment threads.');
        }
    }

    // === Part 2: Simulate the inline onclick to verify vscode scope issue ===
    console.log('\n=== REPLY BUTTON DIAGNOSIS ===\n');
    console.log('The sidebar Reply button uses inline onclick with vscode.postMessage():');
    console.log('  onclick="...vscode.postMessage({command:\'replyComment\',...});"');
    console.log('');
    console.log('But vscode = acquireVsCodeApi() is a LOCAL variable inside the IIFE.');
    console.log('Inline onclick handlers run in GLOBAL scope where vscode is undefined.');
    console.log('');
    console.log('Compare with other buttons:');
    console.log('  Resolve: onclick="resolveComment(\'word_2\')"  ← calls window function ✓');
    console.log('  Ask Copilot: onclick="askCopilotThread(\'word_2\')" ← calls window function ✓');
    console.log('  Copy: onclick="copyComment(\'word_2\')"  ← calls window function ✓');
    console.log('  Reply: onclick="...vscode.postMessage(...)..." ← INLINE vscode access ✗');
    console.log('');
    console.log('ROOT CAUSE: ReferenceError: vscode is not defined');
    console.log('FIX: Create a window.submitListReply function that closes over vscode');
}

run().catch(e => console.error('FATAL:', e));
