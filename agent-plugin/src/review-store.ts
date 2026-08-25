import * as fs from 'node:fs';
import * as path from 'node:path';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';

export interface ReviewReply {
    id: string;
    role: 'user' | 'agent';
    text: string;
    timestamp: string;
}

export interface ReviewComment {
    id: string;
    anchor: string;
    startOffset: number;
    endOffset: number;
    blockType: string;
    blockPreview: string;
    comment: string;
    role: 'user' | 'agent';
    timestamp: string;
    resolved: boolean;
    replies?: ReviewReply[];
}

interface CommentsFile {
    file: string;
    comments: ReviewComment[];
}

export interface ReviewCommentView extends ReviewComment {
    prompt: string;
}

export interface ReviewBlock {
    type: string;
    startOffset: number;
    endOffset: number;
    startLine: number;
    preview: string;
    commentIds: string[];
}

export interface ReviewSnapshot {
    filePath: string;
    fileName: string;
    blocks: ReviewBlock[];
    comments: ReviewCommentView[];
}

const BLOCK_TYPES = new Set([
    'heading',
    'paragraph',
    'listItem',
    'blockquote',
    'table',
    'math',
    'code',
    'thematicBreak',
]);

function cleanMarkdown(markdown: string): string {
    return markdown.replace(/<!--@c\d+-->\r?\n?/g, '');
}

function collectBlocks(markdown: string, comments: ReviewComment[]): ReviewBlock[] {
    const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
    const blocks: ReviewBlock[] = [];

    function walk(node: any): void {
        if (BLOCK_TYPES.has(node.type) && node.position) {
            const startOffset = node.position.start.offset as number;
            const endOffset = node.position.end.offset as number;
            const raw = markdown.slice(startOffset, Math.min(endOffset, startOffset + 120));
            blocks.push({
                type: node.type,
                startOffset,
                endOffset,
                startLine: node.position.start.line,
                preview: raw.replace(/\n/g, ' ').trim().slice(0, 80),
                commentIds: comments
                    .filter(comment => comment.startOffset === startOffset)
                    .map(comment => comment.id),
            });
        }
        for (const child of node.children || []) walk(child);
    }

    walk(tree);
    return blocks;
}

function cleanOffsetToDocumentOffset(markdown: string, cleanOffset: number): number {
    const anchorPattern = /<!--@c\d+-->\r?\n?/g;
    let documentOffset = 0;
    let currentCleanOffset = 0;
    let match: RegExpExecArray | null;
    const anchors: Array<{ start: number; length: number }> = [];
    while ((match = anchorPattern.exec(markdown)) !== null) {
        anchors.push({ start: match.index, length: match[0].length });
    }

    let anchorIndex = 0;
    while (currentCleanOffset < cleanOffset && documentOffset < markdown.length) {
        if (anchorIndex < anchors.length && documentOffset === anchors[anchorIndex].start) {
            documentOffset += anchors[anchorIndex].length;
            anchorIndex++;
            continue;
        }
        documentOffset++;
        currentCleanOffset++;
    }
    while (anchorIndex < anchors.length && documentOffset === anchors[anchorIndex].start) {
        documentOffset += anchors[anchorIndex].length;
        anchorIndex++;
    }
    return documentOffset;
}

function createCommentId(data: CommentsFile): string {
    let timestamp = Date.now();
    let id = `c${timestamp}`;
    while (data.comments.some(comment => comment.id === id)) {
        id = `c${++timestamp}`;
    }
    return id;
}

export function resolveMarkdownPath(filePath: string): string {
    if (!path.isAbsolute(filePath)) {
        throw new Error('filePath must be an absolute path.');
    }
    const resolved = path.resolve(filePath);
    if (path.extname(resolved).toLowerCase() !== '.md') {
        throw new Error('Only Markdown (.md) files are supported in this Agent Plugin preview.');
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`Markdown file not found: ${resolved}`);
    }
    return resolved;
}

export function getCommentsPath(filePath: string): string {
    return path.join(path.dirname(filePath), `.${path.basename(filePath)}.comments.json`);
}

function loadComments(filePath: string): CommentsFile {
    const commentsPath = getCommentsPath(filePath);
    if (!fs.existsSync(commentsPath)) {
        return { file: path.basename(filePath), comments: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(commentsPath, 'utf8')) as Partial<CommentsFile>;
    if (!Array.isArray(parsed.comments)) {
        throw new Error(`Invalid review comments file: ${commentsPath}`);
    }
    return {
        file: typeof parsed.file === 'string' ? parsed.file : path.basename(filePath),
        comments: parsed.comments,
    };
}

function saveComments(filePath: string, data: CommentsFile): void {
    const commentsPath = getCommentsPath(filePath);
    const temporaryPath = `${commentsPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
    try {
        fs.renameSync(temporaryPath, commentsPath);
    } catch (error) {
        fs.rmSync(temporaryPath, { force: true });
        throw error;
    }
}

function requireComment(data: CommentsFile, commentId: string): ReviewComment {
    const comment = data.comments.find(candidate => candidate.id === commentId);
    if (!comment) {
        throw new Error(`Review comment not found: ${commentId}`);
    }
    return comment;
}

function getMarkdownContext(filePath: string, startOffset: number, linesAround = 5): string {
    const markdown = cleanMarkdown(fs.readFileSync(filePath, 'utf8'));
    const lineNumber = markdown.slice(0, Math.max(0, startOffset)).split('\n').length - 1;
    const lines = markdown.split('\n');
    const start = Math.max(0, lineNumber - linesAround);
    const end = Math.min(lines.length, lineNumber + linesAround + 1);
    return lines.slice(start, end).join('\n');
}

export function buildReviewPrompt(filePath: string, comment: ReviewComment): string {
    const replies = (comment.replies || [])
        .map(reply => `- [${reply.role}] ${reply.text}`)
        .join('\n');
    return [
        `Review comment ${comment.id} on ${path.basename(filePath)} (${filePath}).`,
        '',
        `Comment: ${comment.comment}`,
        `Anchored content: ${comment.blockPreview || '(no preview)'}`,
        replies ? `Replies:\n${replies}` : 'Replies: none',
        '',
        `Use docReview_read_comment with filePath and commentId=${comment.id} to inspect the authoritative context.`,
        'Address the feedback in the Markdown file, then use docReview_reply_to_comment to explain the change.',
        'Do not resolve the comment unless I explicitly ask you to resolve it.',
    ].join('\n');
}

export function listComments(filePathInput: string): ReviewSnapshot {
    const filePath = resolveMarkdownPath(filePathInput);
    const data = loadComments(filePath);
    const markdown = cleanMarkdown(fs.readFileSync(filePath, 'utf8'));
    return {
        filePath,
        fileName: path.basename(filePath),
        blocks: collectBlocks(markdown, data.comments),
        comments: data.comments.map(comment => ({
            ...comment,
            replies: comment.replies || [],
            prompt: buildReviewPrompt(filePath, comment),
        })),
    };
}

export function addComment(filePathInput: string, startOffset: number, text: string): ReviewSnapshot {
    const filePath = resolveMarkdownPath(filePathInput);
    const originalMarkdown = fs.readFileSync(filePath, 'utf8');
    const clean = cleanMarkdown(originalMarkdown);
    const data = loadComments(filePath);
    const block = collectBlocks(clean, data.comments).find(candidate => candidate.startOffset === startOffset);
    if (!block) {
        throw new Error('The selected Markdown block is stale or no longer exists. Refresh the review and try again.');
    }

    const id = createCommentId(data);
    const anchor = `<!--@${id}-->`;
    let documentOffset = cleanOffsetToDocumentOffset(originalMarkdown, block.startOffset);
    while (documentOffset > 0 && originalMarkdown[documentOffset - 1] !== '\n') documentOffset--;
    const eol = originalMarkdown.includes('\r\n') ? '\r\n' : '\n';
    const updatedMarkdown = originalMarkdown.slice(0, documentOffset) + anchor + eol + originalMarkdown.slice(documentOffset);
    const comment: ReviewComment = {
        id,
        anchor,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        blockType: block.type,
        blockPreview: block.preview,
        comment: text,
        role: 'user',
        timestamp: new Date().toISOString(),
        resolved: false,
        replies: [],
    };

    fs.writeFileSync(filePath, updatedMarkdown, 'utf8');
    try {
        data.comments.push(comment);
        saveComments(filePath, data);
    } catch (error) {
        fs.writeFileSync(filePath, originalMarkdown, 'utf8');
        throw error;
    }
    return listComments(filePath);
}

export function readComment(filePathInput: string, commentId: string): {
    filePath: string;
    comment: ReviewCommentView;
    context: string;
} {
    const filePath = resolveMarkdownPath(filePathInput);
    const data = loadComments(filePath);
    const comment = requireComment(data, commentId);
    return {
        filePath,
        comment: { ...comment, replies: comment.replies || [], prompt: buildReviewPrompt(filePath, comment) },
        context: getMarkdownContext(filePath, comment.startOffset),
    };
}

export function addReply(
    filePathInput: string,
    commentId: string,
    text: string,
    role: 'user' | 'agent' = 'agent',
): ReviewSnapshot {
    const filePath = resolveMarkdownPath(filePathInput);
    const data = loadComments(filePath);
    const comment = requireComment(data, commentId);
    comment.replies ||= [];
    comment.replies.push({
        id: `r${Date.now()}`,
        role,
        text,
        timestamp: new Date().toISOString(),
    });
    saveComments(filePath, data);
    return listComments(filePath);
}

export function setResolved(filePathInput: string, commentId: string, resolved: boolean): ReviewSnapshot {
    const filePath = resolveMarkdownPath(filePathInput);
    const data = loadComments(filePath);
    requireComment(data, commentId).resolved = resolved;
    saveComments(filePath, data);
    return listComments(filePath);
}

export function editComment(filePathInput: string, commentId: string, text: string): ReviewSnapshot {
    const filePath = resolveMarkdownPath(filePathInput);
    const data = loadComments(filePath);
    requireComment(data, commentId).comment = text;
    saveComments(filePath, data);
    return listComments(filePath);
}

export function editReply(
    filePathInput: string,
    commentId: string,
    replyId: string,
    text: string,
): ReviewSnapshot {
    const filePath = resolveMarkdownPath(filePathInput);
    const data = loadComments(filePath);
    const comment = requireComment(data, commentId);
    const reply = (comment.replies || []).find(candidate => candidate.id === replyId);
    if (!reply) {
        throw new Error(`Review reply not found: ${replyId}`);
    }
    reply.text = text;
    saveComments(filePath, data);
    return listComments(filePath);
}

export function deleteReply(filePathInput: string, commentId: string, replyId: string): ReviewSnapshot {
    const filePath = resolveMarkdownPath(filePathInput);
    const data = loadComments(filePath);
    const comment = requireComment(data, commentId);
    const replies = comment.replies || [];
    const nextReplies = replies.filter(candidate => candidate.id !== replyId);
    if (nextReplies.length === replies.length) {
        throw new Error(`Review reply not found: ${replyId}`);
    }
    comment.replies = nextReplies;
    saveComments(filePath, data);
    return listComments(filePath);
}

export function resolveAll(filePathInput: string): ReviewSnapshot {
    const filePath = resolveMarkdownPath(filePathInput);
    const data = loadComments(filePath);
    for (const comment of data.comments) {
        comment.resolved = true;
    }
    saveComments(filePath, data);
    return listComments(filePath);
}

export function deleteResolved(filePathInput: string): ReviewSnapshot {
    const filePath = resolveMarkdownPath(filePathInput);
    const data = loadComments(filePath);
    const deletedIds = new Set(data.comments.filter(comment => comment.resolved).map(comment => comment.id));
    data.comments = data.comments.filter(comment => !comment.resolved);
    saveComments(filePath, data);

    if (deletedIds.size > 0) {
        const markdown = fs.readFileSync(filePath, 'utf8');
        const withoutAnchors = markdown.replace(/<!--@(c\d+)-->\r?\n?/g, (match, id) =>
            deletedIds.has(id) ? '' : match,
        );
        if (withoutAnchors !== markdown) {
            fs.writeFileSync(filePath, withoutAnchors, 'utf8');
        }
    }
    return listComments(filePath);
}

export function deleteComment(filePathInput: string, commentId: string): ReviewSnapshot {
    const filePath = resolveMarkdownPath(filePathInput);
    const data = loadComments(filePath);
    const index = data.comments.findIndex(comment => comment.id === commentId);
    if (index < 0) {
        throw new Error(`Review comment not found: ${commentId}`);
    }
    data.comments.splice(index, 1);
    saveComments(filePath, data);

    const markdown = fs.readFileSync(filePath, 'utf8');
    const escapedId = commentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const withoutAnchor = markdown.replace(new RegExp(`<!--@${escapedId}-->\\r?\\n?`, 'g'), '');
    if (withoutAnchor !== markdown) {
        fs.writeFileSync(filePath, withoutAnchor, 'utf8');
    }
    return listComments(filePath);
}