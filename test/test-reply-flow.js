/**
 * Test to diagnose why the Reply button doesn't work for Word comments.
 * 
 * Simulates the exact flow from preview.ts replyComment handler
 * and the ReplyToCommentTool.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- Minimal CommentsManager (copied from comments.ts logic) ----
class CommentsManager {
    constructor(markdownFilePath) {
        const dir = path.dirname(markdownFilePath);
        const base = path.basename(markdownFilePath);
        this.commentsPath = path.join(dir, '.' + base + '.comments.json');
        this.data = this.load();
        this.lastSaveTime = 0;
    }

    load() {
        try {
            if (fs.existsSync(this.commentsPath)) {
                const raw = fs.readFileSync(this.commentsPath, 'utf-8');
                return JSON.parse(raw);
            }
        } catch { }
        return { file: path.basename(this.commentsPath).replace('.comments.json', ''), comments: [] };
    }

    save() {
        fs.writeFileSync(this.commentsPath, JSON.stringify(this.data, null, 2), 'utf-8');
        this.lastSaveTime = Date.now();
    }

    persist() { this.save(); }

    getComments() { return this.data.comments; }

    addDocxComment(elementId, blockType, blockPreview, comment, contentHash) {
        const id = 'c' + Date.now();
        const newComment = {
            id, anchor: '', startOffset: 0, endOffset: 0,
            blockType, blockPreview, comment,
            role: 'user', timestamp: new Date().toISOString(),
            resolved: false, elementId, contentHash,
        };
        this.data.comments.push(newComment);
        this.save();
        return newComment;
    }

    addReply(commentId, text, role = 'user') {
        const c = this.data.comments.find(x => x.id === commentId);
        if (!c) { return null; }
        if (!c.replies) { c.replies = []; }
        const reply = { id: 'r' + Date.now(), role, text, timestamp: new Date().toISOString() };
        c.replies.push(reply);
        this.save();
        return reply;
    }

    reload() { this.data = this.load(); }
}

// ---- Test setup ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-test-'));
const fakeDocPath = path.join(tmpDir, 'test.docx');
fs.writeFileSync(fakeDocPath, 'fake'); // just needs to exist as a path

console.log('=== Test 1: UI Reply flow (replyComment handler) ===');
console.log('Simulates: user clicks Reply on word_2 comment in sidebar\n');

{
    const mgr = new CommentsManager(fakeDocPath);
    const messageId = 'word_2';
    const messageText = 'This is my reply';

    // Simulate: this.docxModel.comments
    const docxModelComments = [
        { id: '2', text: 'Will the employee data be used to train any AI models?', author: 'T.J.', elementId: 'para123' },
    ];

    console.log('Step 1: Check if sidecar exists for word_2');
    const existing = mgr.getComments().find(c => c.id === messageId);
    console.log('  Existing sidecar:', existing ? 'YES' : 'NO');

    if (messageId.startsWith('word_') && !existing) {
        console.log('Step 2: Creating sidecar placeholder...');
        const wordComment = docxModelComments.find(wc => `word_${wc.id}` === messageId);
        console.log('  Found Word comment:', wordComment ? 'YES' : 'NO');
        
        mgr.addDocxComment(
            wordComment?.elementId || '',
            'paragraph',
            wordComment?.text?.substring(0, 60) || '',
            wordComment?.text || '(Word comment)',
        );

        const added = mgr.getComments();
        const last = added[added.length - 1];
        console.log('  Created sidecar with id:', last.id);
        console.log('  Fixing id to:', messageId);
        last.id = messageId;
        mgr.persist();
        console.log('  Persisted. Sidecar comments:', mgr.getComments().map(c => c.id));
    }

    console.log('Step 3: Adding reply with addReply("' + messageId + '", ...)');
    const reply = mgr.addReply(messageId, messageText);
    console.log('  Reply result:', reply ? 'SUCCESS - ' + JSON.stringify(reply) : 'FAILED (null)');

    // Verify the file on disk
    const onDisk = JSON.parse(fs.readFileSync(mgr.commentsPath, 'utf-8'));
    console.log('  On-disk comment IDs:', onDisk.comments.map(c => c.id));
    console.log('  On-disk replies for word_2:', onDisk.comments.find(c => c.id === 'word_2')?.replies?.length || 0);
    console.log('');
}

console.log('=== Test 2: Agent tool flow (ReplyToCommentTool) ===');
console.log('Simulates: Copilot calls markdownReview_reply_to_comment with commentId="word_2"\n');

{
    // The tool creates a NEW CommentsManager from the resolved path
    const mgr2 = new CommentsManager(fakeDocPath);
    const commentId = 'word_2';
    
    console.log('Step 1: Tool creates new CommentsManager, loads from disk');
    console.log('  Loaded comments:', mgr2.getComments().map(c => c.id));
    
    // After Test 1, the sidecar exists
    console.log('Step 2: addReply("word_2", "agent reply")');
    const reply = mgr2.addReply(commentId, 'I can help with that question.', 'agent');
    console.log('  Reply result:', reply ? 'SUCCESS' : 'FAILED (null)');
    console.log('');
}

console.log('=== Test 3: Agent tool when NO sidecar exists (fresh state) ===');
console.log('Simulates: Copilot tries reply_to_comment on a Word comment never interacted with\n');

{
    const fakeDocPath2 = path.join(tmpDir, 'test2.docx');
    fs.writeFileSync(fakeDocPath2, 'fake');
    
    const mgr3 = new CommentsManager(fakeDocPath2);
    const commentId = 'word_2';
    
    console.log('Step 1: Fresh CommentsManager (no sidecar)');
    console.log('  Loaded comments:', mgr3.getComments().map(c => c.id));
    
    console.log('Step 2: addReply("word_2", "agent reply") — no sidecar!');
    const reply = mgr3.addReply(commentId, 'I can help.', 'agent');
    console.log('  Reply result:', reply ? 'SUCCESS' : 'FAILED (null) — THIS IS THE BUG');
    console.log('');
}

console.log('=== Test 4: UI Reply flow — second reply (sidecar already exists) ===');
console.log('Simulates: user clicks Reply again on word_2\n');

{
    const mgr4 = new CommentsManager(fakeDocPath);
    const messageId = 'word_2';
    
    console.log('Step 1: Check if sidecar exists');
    const existing = mgr4.getComments().find(c => c.id === messageId);
    console.log('  Sidecar exists:', existing ? 'YES (id=' + existing.id + ')' : 'NO');
    console.log('  Existing replies:', existing?.replies?.length || 0);
    
    // Won't create a new sidecar since it already exists
    console.log('Step 2: addReply("word_2", "second reply")');
    const reply = mgr4.addReply(messageId, 'Second reply from user');
    console.log('  Reply result:', reply ? 'SUCCESS' : 'FAILED (null)');
    console.log('  Total replies now:', mgr4.getComments().find(c => c.id === messageId)?.replies?.length || 0);
    console.log('');
}

console.log('=== Test 5: Check if updateDocxContent re-render could lose the reply ===');
console.log('Simulates: after addReply, updateDocxContent re-parses and merges\n');

{
    // The updateDocxContent handler re-renders but uses the same commentsManager
    // The Word comments are rebuilt from docxModel, sidecar replies are merged
    const mgr5 = new CommentsManager(fakeDocPath);
    console.log('Step 1: Sidecar on disk has:');
    const comments = mgr5.getComments();
    comments.forEach(c => {
        console.log('  ' + c.id + ': ' + (c.replies?.length || 0) + ' replies');
        (c.replies || []).forEach(r => console.log('    - [' + r.role + '] ' + r.text));
    });
    
    // In updateDocxContent, all Word comments are re-built from docxModel
    // Then sidecar is merged. The key merge code:
    // for (const wc of wordComments) {
    //     const sidecar = comments.find(c => c.id === wc.id);
    //     if (sidecar) { wc.replies = [...wc.replies, ...sidecar.replies]; }
    // }
    
    const wordComments = [
        { id: 'word_2', replies: [{ id: 'wr_3', text: '[Jinqi] Currently we only use it for measurement.' }] }
    ];
    
    const sidecar = comments.find(c => c.id === wordComments[0].id);
    console.log('\nStep 2: Merge sidecar into Word comment:');
    console.log('  Word replies:', wordComments[0].replies.length);
    console.log('  Sidecar replies:', sidecar?.replies?.length || 0);
    if (sidecar?.replies) {
        const merged = [...wordComments[0].replies, ...sidecar.replies];
        console.log('  Merged total:', merged.length);
        merged.forEach(r => console.log('    - ' + (r.role || 'word') + ': ' + r.text));
    }
    console.log('');
}

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('=== SUMMARY ===');
console.log('Test 1 (UI Reply): WORKS — sidecar creation + ID fix + addReply all succeed');
console.log('Test 2 (Agent after UI): WORKS — sidecar already exists on disk');
console.log('Test 3 (Agent fresh): FAILS — no sidecar, addReply returns null');
console.log('Test 4 (UI second reply): WORKS — sidecar already exists');
console.log('Test 5 (Re-render merge): WORKS — sidecar replies merge with Word replies');
console.log('');
console.log('ROOT CAUSE: The ReplyToCommentTool does NOT create sidecar entries for word_* comments.');
console.log('It just calls addReply() which searches the sidecar JSON — Word comments are not there.');
console.log('');
console.log('BUT: The UI reply flow (Test 1) should work! If it doesn\'t, the issue is elsewhere:');
console.log('  - JS error in webview preventing postMessage');
console.log('  - updateDocxContent() failing silently after the reply');
console.log('  - The re-rendered HTML not showing the new reply');
