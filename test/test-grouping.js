/**
 * Test the anchor-based grouping of Word comments.
 * Verifies that comments 35 and 36 (same anchor "Source") get merged.
 */

const { parseDocx } = require('../out/test-parser.js');
const docxPath = 'C:\\Users\\jinqishen\\OneDrive - Microsoft\\Documents\\UMS_Documentation\\Metric\\dogfood\\UMS_Dogfood_Production_Design_export.docx';

async function run() {
    const model = await parseDocx(docxPath);
    const allWordComments = model.comments;
    
    const rootComments = allWordComments.filter(c => !c.parentId);
    const replyComments = allWordComments.filter(c => c.parentId);
    
    // Build word comments (same as preview.ts)
    const wordComments = rootComments.map(wc => {
        const wordReplies = replyComments
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
    
    console.log('Before grouping:', wordComments.length, 'root comments');
    
    // Group by anchor (same logic as preview.ts)
    const groupedWordComments = [];
    const anchorMap = new Map();
    for (const wc of wordComments) {
        const key = `${wc.elementId}::${wc.blockPreview}`;
        const existing = anchorMap.get(key);
        if (existing) {
            existing.replies.push({
                id: wc.id,
                role: 'user',
                text: `[${wc._wordAuthor}] ${wc.comment}`,
                timestamp: wc.timestamp,
            });
            existing.replies.push(...wc.replies);
        } else {
            anchorMap.set(key, wc);
            groupedWordComments.push(wc);
        }
    }
    
    console.log('After grouping:', groupedWordComments.length, 'root comments\n');
    
    groupedWordComments.forEach(wc => {
        console.log(`Thread ${wc.id} [${wc._wordAuthor}]:`);
        console.log(`  Block: "${wc.blockPreview}"`);
        console.log(`  Comment: "${wc.comment.substring(0, 60)}"`);
        console.log(`  Replies: ${wc.replies.length}`);
        wc.replies.forEach((r, i) => {
            console.log(`    [${i}] ${r.text.substring(0, 70)}`);
        });
    });
    
    // Verify comments 35 and 36 are merged
    const c35 = groupedWordComments.find(c => c.id === 'word_35');
    const c36standalone = groupedWordComments.find(c => c.id === 'word_36');
    const c36asReply = c35?.replies?.find(r => r.id === 'word_36');
    
    console.log('\n=== Verification ===');
    console.log('Comment 35 exists as root?', !!c35);
    console.log('Comment 36 exists as root?', !!c36standalone, '(should be false)');
    console.log('Comment 36 folded as reply under 35?', !!c36asReply, '(should be true)');
    
    // Also check comments 12 and 13 (both anchor "Participant Recruitment")
    const c12 = groupedWordComments.find(c => c.id === 'word_12');
    const c13standalone = groupedWordComments.find(c => c.id === 'word_13');
    const c13asReply = c12?.replies?.find(r => r.id === 'word_13');
    console.log('\nComment 12 exists as root?', !!c12);
    console.log('Comment 13 exists as root?', !!c13standalone, '(should be false)');
    console.log('Comment 13 folded as reply under 12?', !!c13asReply, '(should be true)');
}

run().catch(e => console.error(e));
