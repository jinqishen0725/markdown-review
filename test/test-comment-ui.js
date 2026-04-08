/**
 * Tests for src/comment-ui.ts — shared comment UI module.
 * Run: node test/test-comment-ui.js
 */

// Build the module first so we can require it
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Compile comment-ui.ts to a temp JS file for testing
const srcFile = path.join(__dirname, '..', 'src', 'comment-ui.ts');
const outFile = path.join(__dirname, '..', 'out', 'comment-ui-test.js');

execSync(`npx esbuild "${srcFile}" --bundle --outfile="${outFile}" --format=cjs --platform=node`, {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe',
});

const {
    commentUiCss,
    commentUiJs,
    sidebarHtml,
    buildSinglePrompt,
    buildBatchPromptText,
    buildMergedNativeComment,
} = require(outFile);

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error('FAIL:', msg);
    }
}

function assertIncludes(haystack, needle, msg) {
    if (haystack.includes(needle)) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${msg}\n  Expected to find: "${needle.substring(0, 80)}..."\n  In string of length ${haystack.length}`);
    }
}

function assertNotIncludes(haystack, needle, msg) {
    if (!haystack.includes(needle)) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${msg}\n  Did NOT expect to find: "${needle.substring(0, 80)}..."`);
    }
}

// ============================================================
// 1. commentUiCss()
// ============================================================
console.log('\n--- commentUiCss() ---');

const css = commentUiCss();
assert(typeof css === 'string' && css.length > 100, 'returns a non-trivial CSS string');
assertIncludes(css, '#comment-badge', 'includes badge styles');
assertIncludes(css, '#comment-popover', 'includes popover styles');
assertIncludes(css, '#comment-dialog', 'includes dialog styles');
assertIncludes(css, '.role-badge', 'includes role badge styles');
assertIncludes(css, '.role-user', 'includes user role');
assertIncludes(css, '.role-agent', 'includes agent role');
assertIncludes(css, '.role-word', 'includes word role');
assertIncludes(css, '.role-pptx', 'includes pptx role');
assertIncludes(css, '.clist-item', 'includes comment list item styles');
assertIncludes(css, '.inline-edit-btn', 'includes inline edit button styles');
assertIncludes(css, '.reply-delete-btn', 'includes reply delete button styles');
assertIncludes(css, '.btn-copilot', 'includes copilot button styles');
assertIncludes(css, '.pop-reply-input', 'includes popover reply input styles');

// ============================================================
// 2. commentUiJs()
// ============================================================
console.log('\n--- commentUiJs() ---');

const js = commentUiJs();
assert(typeof js === 'string' && js.length > 500, 'returns a non-trivial JS string');
assertIncludes(js, 'window.resolveComment', 'includes resolveComment');
assertIncludes(js, 'window.unresolveComment', 'includes unresolveComment');
assertIncludes(js, 'window.deleteComment', 'includes deleteComment');
assertIncludes(js, 'window.submitReply', 'includes submitReply');
assertIncludes(js, 'window.submitListReply', 'includes submitListReply');
assertIncludes(js, 'window.askCopilotThread', 'includes askCopilotThread');
assertIncludes(js, 'window.copyComment', 'includes copyComment');
assertIncludes(js, 'function showPopover', 'includes showPopover');
assertIncludes(js, 'window.startEditComment', 'includes startEditComment');
assertIncludes(js, 'window.startEditReply', 'includes startEditReply');
assertIncludes(js, 'window.saveEditComment', 'includes saveEditComment');
assertIncludes(js, 'window.saveEditReply', 'includes saveEditReply');
assertIncludes(js, 'window.deleteReply', 'includes deleteReply');
assertIncludes(js, 'window.setFilter', 'includes setFilter');
assertIncludes(js, 'window.resolveAll', 'includes resolveAll');
assertIncludes(js, 'window.deleteAllResolved', 'includes deleteAllResolved');
assertIncludes(js, 'window.sendAllToCopilot', 'includes sendAllToCopilot');
assertIncludes(js, 'window.copyAllToClipboard', 'includes copyAllToClipboard');
assertIncludes(js, 'function updateBadge', 'includes updateBadge');
assertIncludes(js, 'function buildList', 'includes buildList');
assertIncludes(js, 'function handleCommentMessage', 'includes handleCommentMessage');
assertIncludes(js, '__nativePrefix', 'references __nativePrefix');
assertIncludes(js, '__nativeSource', 'references __nativeSource');
assertIncludes(js, '__onListItemClick', 'references __onListItemClick hook');
assertIncludes(js, '__findAnchorForComment', 'references __findAnchorForComment hook');
assertIncludes(js, '__onCommentChange', 'references __onCommentChange hook');

// Verify the JS uses esc() helper
assertIncludes(js, 'function esc(s)', 'includes esc() html escaper');

// Verify message handler returns boolean
assertIncludes(js, 'return true', 'handleCommentMessage returns true for handled messages');
assertIncludes(js, 'return false', 'handleCommentMessage returns false for unhandled messages');

// ============================================================
// 3. sidebarHtml()
// ============================================================
console.log('\n--- sidebarHtml() ---');

const sidebar = sidebarHtml({ containerId: 'comment-list', toggleFn: 'toggleSidebar' });
assertIncludes(sidebar, 'id="comment-search"', 'includes search input');
assertIncludes(sidebar, 'id="filter-all"', 'includes All filter');
assertIncludes(sidebar, 'id="filter-open"', 'includes Open filter');
assertIncludes(sidebar, 'id="filter-resolved"', 'includes Resolved filter');
assertIncludes(sidebar, 'sendAllToCopilot()', 'includes Send All to Copilot');
assertIncludes(sidebar, 'copyAllToClipboard()', 'includes Copy All');
assertIncludes(sidebar, 'resolveAll()', 'includes Resolve All');
assertIncludes(sidebar, 'deleteAllResolved()', 'includes Delete Resolved');
assertIncludes(sidebar, 'id="comment-list"', 'includes container with correct ID');

// Custom filters
const sidebar2 = sidebarHtml({ containerId: 'my-list', toggleFn: 'toggle', filters: ['all', 'open', 'resolved', 'user', 'agent'] });
assertIncludes(sidebar2, 'id="filter-user"', 'custom filters include user');
assertIncludes(sidebar2, 'id="filter-agent"', 'custom filters include agent');
assertIncludes(sidebar2, 'id="my-list"', 'custom container ID works');

// ============================================================
// 4. buildSinglePrompt() — Markdown
// ============================================================
console.log('\n--- buildSinglePrompt() — Markdown ---');

const mdConfig = {
    format: 'markdown',
    filePath: '/repo/README.md',
    fileName: 'README.md',
    toolPrefix: '#',
};

const mdComment = {
    id: 'c123',
    comment: 'Fix this typo',
    blockPreview: 'Hello wrold',
    elementId: null,
    resolved: false,
    replies: [],
};

const mdNew = buildSinglePrompt(mdConfig, mdComment, 'new');
assertIncludes(mdNew, 'README.md', 'markdown prompt includes filename');
assertIncludes(mdNew, 'c123', 'markdown prompt includes comment id');
assertIncludes(mdNew, 'Fix this typo', 'markdown prompt includes comment text');
assertIncludes(mdNew, '#readReviewComment', 'markdown prompt includes tool reference');
assertIncludes(mdNew, '#replyToReviewComment', 'markdown prompt includes reply tool');
assertNotIncludes(mdNew, 'XML EDITING', 'markdown prompt does NOT include XML rules');
assertNotIncludes(mdNew, 'w14:paraId', 'markdown prompt does NOT include Word terms');
assertIncludes(mdNew, 'A new review comment', 'new mode uses correct action text');

const mdThread = buildSinglePrompt(mdConfig, { ...mdComment, resolved: false, replies: [{ role: 'agent', text: 'I will fix it' }] }, 'thread');
assertIncludes(mdThread, 'Please respond to this comment thread', 'thread mode uses correct action text');
assertIncludes(mdThread, 'Status: Open', 'thread prompt includes status');
assertIncludes(mdThread, '[agent] I will fix it', 'thread prompt includes replies');

// ============================================================
// 5. buildSinglePrompt() — Word
// ============================================================
console.log('\n--- buildSinglePrompt() — Word ---');

const docxConfig = {
    format: 'docx',
    filePath: '/repo/doc.docx',
    fileName: 'doc.docx',
    toolPrefix: '#',
    docxXmlPath: '/repo/doc.docx_xml/document.xml',
};

const docxComment = {
    id: 'word_42',
    comment: 'Rephrase this paragraph',
    blockPreview: 'Lorem ipsum dolor sit amet...',
    elementId: 'AABBCCDD',
    resolved: false,
    replies: [],
};

const docxPrompt = buildSinglePrompt(docxConfig, docxComment, 'thread');
assertIncludes(docxPrompt, 'Word document', 'docx prompt mentions Word');
assertIncludes(docxPrompt, 'paraId=AABBCCDD', 'docx prompt includes paraId');
assertIncludes(docxPrompt, 'w14:paraId', 'docx prompt includes XML editing rules');
assertIncludes(docxPrompt, '#listElements', 'docx prompt includes listElements tool');
assertIncludes(docxPrompt, '#readElementXml', 'docx prompt includes readElementXml tool');
assertIncludes(docxPrompt, '#writeElementXml', 'docx prompt includes writeElementXml tool');
assertIncludes(docxPrompt, '#saveDocument', 'docx prompt includes saveDocument tool');
assertIncludes(docxPrompt, 'document.xml', 'docx prompt includes XML path');
assertIncludes(docxPrompt, 'commentRangeStart', 'docx prompt warns about comment markers');

// ============================================================
// 6. buildSinglePrompt() — PPTX
// ============================================================
console.log('\n--- buildSinglePrompt() — PPTX ---');

const pptxConfig = {
    format: 'pptx',
    filePath: '/repo/deck.pptx',
    fileName: 'deck.pptx',
    toolPrefix: '#',
    pptxExtractDir: '/repo/deck.pptx_xml/',
};

const pptxComment = {
    id: 'pptx_7',
    comment: 'Make this title bigger',
    blockPreview: 'Slide 2 (shapeId=5): "Introduction"',
    elementId: 'slide_2_shape_5',
    resolved: false,
    replies: [],
};

const pptxPrompt = buildSinglePrompt(pptxConfig, pptxComment, 'thread');
assertIncludes(pptxPrompt, 'PowerPoint presentation', 'pptx prompt mentions PowerPoint');
assertIncludes(pptxPrompt, 'Slide: 2', 'pptx prompt extracts slide number');
assertIncludes(pptxPrompt, 'Shape cNvPr id: 5', 'pptx prompt extracts shape id');
assertIncludes(pptxPrompt, '914400 EMU', 'pptx prompt includes EMU explanation');
assertIncludes(pptxPrompt, 'sz="1600"', 'pptx prompt includes font size example');
assertIncludes(pptxPrompt, 'p:cNvPr', 'pptx prompt warns about cNvPr preservation');
assertIncludes(pptxPrompt, 'p188:cm', 'pptx prompt warns about comment markers');
assertIncludes(pptxPrompt, '#readReviewComment', 'pptx prompt includes review tools');
assertIncludes(pptxPrompt, 'slide2.xml', 'pptx prompt includes shape search instruction');
assertIncludes(pptxPrompt, 'deck.pptx_xml', 'pptx prompt includes extract dir');

// Cursor mode (no # prefix)
const cursorConfig = { ...pptxConfig, toolPrefix: '' };
const cursorPrompt = buildSinglePrompt(cursorConfig, pptxComment, 'thread');
assertNotIncludes(cursorPrompt, '#readReviewComment', 'cursor mode does NOT use # prefix');
assertIncludes(cursorPrompt, 'readReviewComment', 'cursor mode still includes tool name');

// ============================================================
// 7. buildBatchPromptText()
// ============================================================
console.log('\n--- buildBatchPromptText() ---');

const comments = [
    { id: 'c1', comment: 'Fix heading', blockPreview: '# Hello', resolved: false, elementId: null, replies: [] },
    { id: 'c2', comment: 'Add image', blockPreview: 'Paragraph about cats', resolved: true, elementId: null, replies: [{ role: 'agent', text: 'Done' }] },
];

const mdBatch = buildBatchPromptText(mdConfig, comments);
assertIncludes(mdBatch, 'README.md', 'batch includes filename');
assertIncludes(mdBatch, '[OPEN]', 'batch shows OPEN status');
assertIncludes(mdBatch, '[RESOLVED]', 'batch shows RESOLVED status');
assertIncludes(mdBatch, 'Fix heading', 'batch includes first comment');
assertIncludes(mdBatch, 'Add image', 'batch includes second comment');
assertIncludes(mdBatch, '[agent] Done', 'batch includes replies');
assertIncludes(mdBatch, '#readReviewComment', 'batch includes instructions');
assertIncludes(mdBatch, '#resolveReviewComment', 'batch includes resolve instruction');

const docxBatch = buildBatchPromptText(docxConfig, comments);
assertIncludes(docxBatch, 'Word document', 'docx batch mentions Word');
assertIncludes(docxBatch, 'w14:paraId', 'docx batch includes XML rules');

const pptxBatch = buildBatchPromptText(pptxConfig, comments);
assertIncludes(pptxBatch, 'PowerPoint', 'pptx batch mentions PowerPoint');
assertIncludes(pptxBatch, 'p:cNvPr', 'pptx batch includes shape ID rule');

// ============================================================
// 8. buildMergedNativeComment() — Word
// ============================================================
console.log('\n--- buildMergedNativeComment() — Word ---');

const wordCfg = {
    id: '42',
    prefix: 'word_',
    text: 'Original Word comment',
    author: 'Alice',
    date: '2026-04-07T10:00:00Z',
    blockType: 'paragraph',
    blockPreview: 'Some paragraph text',
    elementId: 'AABB1122',
    source: 'word',
    nativeReplies: [
        { id: 'wr_43', role: 'user', text: '[Bob] I agree', timestamp: '2026-04-07T11:00:00Z' },
    ],
};

// No sidecar
const merged1 = buildMergedNativeComment(wordCfg, []);
assert(merged1.id === 'word_42', 'merged id has prefix');
assert(merged1.comment === 'Original Word comment', 'merged has original text');
assert(merged1._wordAuthor === 'Alice', 'merged has author');
assert(merged1._source === 'word', 'merged has source');
assert(merged1.elementId === 'AABB1122', 'merged has elementId');
assert(merged1.resolved === false, 'merged is not resolved without sidecar');
assert(merged1.replies.length === 1, 'merged has native reply');
assert(merged1.replies[0].text === '[Bob] I agree', 'native reply text correct');
assert(merged1.blockType === 'paragraph', 'merged has blockType');
assert(merged1.timestamp === '2026-04-07T10:00:00Z', 'merged has timestamp');

// With sidecar
const sidecar = [
    {
        id: 'word_42',
        resolved: true,
        replies: [
            { id: 'r1', role: 'agent', text: 'Fixed it', timestamp: '2026-04-07T12:00:00Z' },
        ],
    },
];

const merged2 = buildMergedNativeComment(wordCfg, sidecar);
assert(merged2.resolved === true, 'sidecar resolved status applied');
assert(merged2.replies.length === 2, 'merged has native + sidecar replies');
assert(merged2.replies[0].text === '[Bob] I agree', 'native reply first');
assert(merged2.replies[1].text === 'Fixed it', 'sidecar reply second');
assert(merged2.replies[1].role === 'agent', 'sidecar reply has correct role');

// ============================================================
// 9. buildMergedNativeComment() — PPTX
// ============================================================
console.log('\n--- buildMergedNativeComment() — PPTX ---');

const pptxCfg = {
    id: '7',
    prefix: 'pptx_',
    text: 'Native PPTX comment',
    author: 'Charlie',
    date: '2026-04-07T09:00:00Z',
    blockType: 'slide',
    blockPreview: 'Slide 3 (shape 10)',
    elementId: 'slide_3',
    source: 'pptx',
    // PPTX has no native replies
};

const mergedP1 = buildMergedNativeComment(pptxCfg, []);
assert(mergedP1.id === 'pptx_7', 'pptx merged id has prefix');
assert(mergedP1._source === 'pptx', 'pptx merged has source');
assert(mergedP1._wordAuthor === 'Charlie', 'pptx merged has author');
assert(mergedP1.replies.length === 0, 'pptx merged has no replies without sidecar');

// With sidecar reply
const pptxSidecar = [
    {
        id: 'pptx_7',
        resolved: false,
        replies: [
            { id: 'r2', role: 'user', text: 'Will fix', timestamp: '2026-04-07T10:00:00Z' },
        ],
    },
];

const mergedP2 = buildMergedNativeComment(pptxCfg, pptxSidecar);
assert(mergedP2.replies.length === 1, 'pptx sidecar reply added');
assert(mergedP2.replies[0].text === 'Will fix', 'pptx sidecar reply text correct');
assert(mergedP2.resolved === false, 'pptx not resolved');

// ============================================================
// 10. buildMergedNativeComment() — missing sidecar (no match)
// ============================================================
console.log('\n--- buildMergedNativeComment() — no sidecar match ---');

const unmatched = buildMergedNativeComment(wordCfg, [{ id: 'word_99', resolved: true, replies: [] }]);
assert(unmatched.resolved === false, 'no sidecar match → not resolved');
assert(unmatched.replies.length === 1, 'only native replies remain');

// ============================================================
// 11. buildMergedNativeComment() — missing date
// ============================================================
console.log('\n--- buildMergedNativeComment() — missing date ---');

const noDate = buildMergedNativeComment({ ...pptxCfg, date: '' }, []);
assert(noDate.timestamp.length > 0, 'fallback timestamp generated when date empty');
assert(noDate.timestamp.includes('T'), 'fallback timestamp is ISO format');

// ============================================================
// 12. Edge cases
// ============================================================
console.log('\n--- Edge cases ---');

// Empty comment for prompt
const emptyComment = { id: 'c0', comment: '', blockPreview: '', elementId: '', resolved: false, replies: [] };
const emptyPrompt = buildSinglePrompt(mdConfig, emptyComment, 'new');
assert(typeof emptyPrompt === 'string', 'handles empty comment without error');
assertIncludes(emptyPrompt, 'c0', 'empty comment prompt still includes id');

// Batch with no comments
const emptyBatch = buildBatchPromptText(mdConfig, []);
assert(typeof emptyBatch === 'string', 'handles empty batch without error');
assertIncludes(emptyBatch, 'README.md', 'empty batch still includes filename');

// PPTX comment with no shape ID
const noShapeComment = { id: 'c5', comment: 'Note', blockPreview: 'Slide 1', elementId: 'slide_1', resolved: false, replies: [] };
const noShapePrompt = buildSinglePrompt(pptxConfig, noShapeComment, 'thread');
assertIncludes(noShapePrompt, 'Slide: 1', 'slide-only comment extracts slide number');
assertIncludes(noShapePrompt, 'Shape cNvPr id: N/A', 'no shape id shown as N/A');

// ============================================================
// Summary
// ============================================================
console.log(`\n========================================`);
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`========================================`);
process.exit(failed > 0 ? 1 : 0);
