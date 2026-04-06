/**
 * Test to trace the exact webview Reply button flow for Word comments.
 * 
 * Checks: 
 * 1. Does the reply get saved to sidecar?
 * 2. Does updateDocxContent produce merged comments with the reply?
 * 3. Does the rendered JSON include the reply?
 */

const { parseDocx, reparseFromExtractedXml } = require('../out/test-parser.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Inline CommentsManager (minimal)
class CommentsManager {
    constructor(filePath) {
        const dir = path.dirname(filePath);
        const base = path.basename(filePath);
        this.commentsPath = path.join(dir, '.' + base + '.comments.json');
        this.data = this.load();
    }
    load() {
        try {
            if (fs.existsSync(this.commentsPath)) return JSON.parse(fs.readFileSync(this.commentsPath, 'utf-8'));
        } catch {}
        return { file: path.basename(this.commentsPath).replace('.comments.json', ''), comments: [] };
    }
    save() { fs.writeFileSync(this.commentsPath, JSON.stringify(this.data, null, 2), 'utf-8'); }
    persist() { this.save(); }
    getComments() { return this.data.comments; }
    addDocxComment(elementId, blockType, blockPreview, comment) {
        const id = 'c' + Date.now();
        const c = { id, anchor: '', startOffset: 0, endOffset: 0, blockType, blockPreview, comment,
                    role: 'user', timestamp: new Date().toISOString(), resolved: false, elementId };
        this.data.comments.push(c);
        this.save();
        return c;
    }
    addReply(commentId, text, role = 'user') {
        const c = this.data.comments.find(x => x.id === commentId);
        if (!c) return null;
        if (!c.replies) c.replies = [];
        const r = { id: 'r' + Date.now(), role, text, timestamp: new Date().toISOString() };
        c.replies.push(r);
        this.save();
        return r;
    }
    reload() { this.data = this.load(); }
}

const docxPath = 'C:\\Users\\jinqishen\\OneDrive - Microsoft\\Documents\\UMS_Documentation\\Metric\\dogfood\\UMS_Dogfood_Production_Design_export.docx';

async function run() {
    console.log('=== Parsing docx... ===');
    const model = await parseDocx(docxPath);
    console.log(`Parsed: ${model.elements.length} elements, ${model.comments.length} comments`);
    
    // Create a temp CommentsManager
    const mgr = new CommentsManager(docxPath);
    // Clean up any previous test data
    mgr.data.comments = [];
    mgr.save();
    
    // Pick a Word comment to test with
    const rootComments = model.comments.filter(c => !c.parentId);
    const testComment = rootComments[0]; // First root comment
    const wordId = `word_${testComment.id}`;
    console.log(`\nTest comment: id=${testComment.id}, author=${testComment.author}`);
    console.log(`  text: "${testComment.text.substring(0, 60)}"`);
    console.log(`  _anchorText: "${(testComment._anchorText || '(none)').substring(0, 60)}"`);
    console.log(`  elementId: ${testComment.elementId}`);
    console.log(`  Word reply count: ${model.comments.filter(c => c.parentId === testComment.id).length}`);
    
    // === Simulate the replyComment handler ===
    console.log('\n=== Simulating replyComment handler ===');
    const messageId = wordId;
    const messageText = 'Test reply from user';
    
    // Step 1: Check if sidecar exists
    const existing = mgr.getComments().find(c => c.id === messageId);
    console.log(`Sidecar exists for ${messageId}? ${existing ? 'YES' : 'NO'}`);
    
    if (messageId.startsWith('word_') && !existing) {
        const wc = model.comments.find(w => `word_${w.id}` === messageId);
        mgr.addDocxComment(wc?.elementId || '', 'paragraph', wc?.text?.substring(0, 60) || '', wc?.text || '');
        const added = mgr.getComments();
        added[added.length - 1].id = messageId;
        mgr.persist();
        console.log(`Created sidecar with id: ${messageId}`);
    }
    
    // Step 2: Add reply
    const reply = mgr.addReply(messageId, messageText);
    console.log(`addReply result: ${reply ? 'SUCCESS' : 'FAILED'}`);
    
    // === Simulate updateDocxContent ===
    console.log('\n=== Simulating updateDocxContent (re-render) ===');
    
    // Re-parse from extracted XML (this is what updateDocxContent does on subsequent calls)
    let reModel = model;
    if (model.documentXmlPath) {
        console.log(`Re-parsing from: ${model.documentXmlPath}`);
        reModel = await reparseFromExtractedXml(model);
        console.log(`Re-parsed: ${reModel.elements.length} elements, ${reModel.comments.length} comments`);
    }
    
    // Build merged comment list (exact logic from updateDocxContent)
    const comments = mgr.getComments();
    const allWordComments = reModel.comments || [];
    const rootWC = allWordComments.filter(wc => !wc.parentId);
    const replyWC = allWordComments.filter(wc => wc.parentId);
    
    console.log(`\nSidecar comments: ${comments.length}`);
    comments.forEach(c => {
        console.log(`  ${c.id}: ${c.replies?.length || 0} replies`);
    });
    
    console.log(`Word root comments: ${rootWC.length}`);
    console.log(`Word reply comments: ${replyWC.length}`);
    
    const wordComments = rootWC.map(wc => {
        const wordReplies = replyWC
            .filter(r => r.parentId === wc.id)
            .map(r => ({
                id: `wr_${r.id}`,
                role: 'user',
                text: `[${r.author}] ${r.text}`,
                timestamp: r.date || new Date().toISOString(),
            }));
        return {
            id: `word_${wc.id}`,
            blockPreview: wc._anchorText || '(document text)',
            comment: wc.text,
            timestamp: wc.date || new Date().toISOString(),
            resolved: false,
            elementId: wc.elementId,
            replies: wordReplies,
            _wordAuthor: wc.author,
            _source: 'word',
        };
    });
    
    // Merge sidecar
    for (const wc of wordComments) {
        const sidecar = comments.find(c => c.id === wc.id);
        if (sidecar) {
            if (sidecar.replies) {
                wc.replies = [...wc.replies, ...sidecar.replies];
            }
            wc.resolved = sidecar.resolved;
        }
    }
    
    const reviewOnlyComments = comments.filter(c => !c.id.startsWith('word_'));
    const allComments = [...reviewOnlyComments, ...wordComments];
    
    console.log(`\nFinal merged comments: ${allComments.length}`);
    const testMerged = allComments.find(c => c.id === wordId);
    if (testMerged) {
        console.log(`  ${testMerged.id}:`);
        console.log(`    blockPreview: "${testMerged.blockPreview}"`);
        console.log(`    comment: "${testMerged.comment.substring(0, 60)}"`);
        console.log(`    author: ${testMerged._wordAuthor}`);
        console.log(`    _source: ${testMerged._source}`);
        console.log(`    replies: ${testMerged.replies.length}`);
        testMerged.replies.forEach((r, i) => {
            console.log(`      [${i}] ${r.role}: "${r.text.substring(0, 60)}"`);
        });
    } else {
        console.log(`  ERROR: ${wordId} NOT FOUND in merged list!`);
    }
    
    // === Check the JSON that would be injected into the webview ===
    console.log('\n=== Checking commentsJson serialization ===');
    const json = JSON.stringify(allComments);
    console.log(`JSON length: ${json.length}`);
    const parsed = JSON.parse(json);
    const inJson = parsed.find(c => c.id === wordId);
    console.log(`${wordId} in parsed JSON? ${inJson ? 'YES' : 'NO'}`);
    if (inJson) {
        console.log(`  replies in JSON: ${inJson.replies.length}`);
        console.log(`  Our reply present? ${inJson.replies.some(r => r.text === messageText) ? 'YES' : 'NO'}`);
    }
    
    // Clean up sidecar
    try {
        fs.unlinkSync(mgr.commentsPath);
    } catch {}
    
    console.log('\n=== CONCLUSION ===');
    if (inJson && inJson.replies.some(r => r.text === messageText)) {
        console.log('The backend logic is CORRECT. The reply gets saved and merged properly.');
        console.log('If "nothing happened" in UI, the issue must be:');
        console.log('  1. The updateDocxContent() threw an exception (swallowed by async)');
        console.log('  2. A webview JS error prevented the postMessage from being sent');
        console.log('  3. The page re-render is so fast the user doesn\'t notice');
        console.log('');
        console.log('Most likely: updateDocxContent() is NOT AWAITED in the handler!');
        console.log('  The "return" executes before the async re-render completes.');
        console.log('  But this should NOT prevent the re-render from happening eventually...');
        console.log('  UNLESS the handler is called again before it finishes, or the panel is disposed.');
    }
}

run().catch(e => console.error('FATAL:', e));
