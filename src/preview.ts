import * as vscode from 'vscode';
import * as path from 'path';
import { CommentsManager, Comment } from './comments';
import { log, logError } from './logger';

const { unified } = require('unified');
const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkMath = require('remark-math').default || require('remark-math');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');
const remarkRehype = require('remark-rehype').default || require('remark-rehype');
const rehypeKatex = require('rehype-katex').default || require('rehype-katex');
const rehypeStringify = require('rehype-stringify').default || require('rehype-stringify');
const rehypeRaw = require('rehype-raw').default || require('rehype-raw');

// ---------- AST helpers ----------

interface Block {
    type: string;
    startOffset: number;
    endOffset: number;
    startLine: number;
    preview: string;
}

const BLOCK_TYPES = new Set([
    'heading', 'paragraph', 'listItem', 'blockquote', 'table', 'math', 'code', 'thematicBreak',
]);

function collectBlocks(tree: any, source: string): Block[] {
    const blocks: Block[] = [];
    function walk(node: any) {
        if (BLOCK_TYPES.has(node.type) && node.position) {
            const start = node.position.start.offset as number;
            const end = node.position.end.offset as number;
            const raw = source.substring(start, Math.min(end, start + 120));
            const preview = raw.replace(/\n/g, ' ').trim().substring(0, 80);
            blocks.push({
                type: node.type,
                startOffset: start,
                endOffset: end,
                startLine: node.position.start.line,
                preview,
            });
        }
        if (node.children) {
            for (const child of node.children) {
                walk(child);
            }
        }
    }
    walk(tree);
    return blocks;
}

// ---------- rehype plugin: inject data-start-offset / data-end-offset ----------

function rehypeSourcePositions() {
    return (tree: any) => {
        visitHast(tree);
    };
    function visitHast(node: any) {
        if (node.type === 'element' && node.position) {
            if (!node.properties) { node.properties = {}; }
            node.properties['data-start-offset'] = node.position.start.offset;
            node.properties['data-end-offset'] = node.position.end.offset;
        }
        if (node.children) {
            for (const child of node.children) {
                visitHast(child);
            }
        }
    }
}

// ---------- PreviewPanel ----------

export class PreviewPanel {
    public static currentPanels: Map<string, PreviewPanel> = new Map();
    private panel: vscode.WebviewPanel;
    private document: vscode.TextDocument;
    private commentsManager: CommentsManager;
    private extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private lastRenderTime: number = 0;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    private constructor(
        panel: vscode.WebviewPanel,
        document: vscode.TextDocument,
        extensionUri: vscode.Uri,
    ) {
        this.panel = panel;
        this.document = document;
        this.extensionUri = extensionUri;
        this.commentsManager = new CommentsManager(document.uri.fsPath);

        this.panel.webview.options = { enableScripts: true };
        this.updateContent();

        this.panel.webview.onDidReceiveMessage(
            (msg) => this.handleMessage(msg),
            null,
            this.disposables,
        );

        // Debounced re-render on any text change (1s delay)
        vscode.workspace.onDidChangeTextDocument(
            (e) => {
                if (e.document.uri.fsPath === this.document.uri.fsPath) {
                    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
                    this.debounceTimer = setTimeout(() => {
                        // Skip if a render happened very recently (e.g., from comment operation)
                        if (Date.now() - this.lastRenderTime > 800) {
                            this.commentsManager.reload();
                            this.updateContent();
                        }
                        this.debounceTimer = null;
                    }, 1000);
                }
            },
            null,
            this.disposables,
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Source → Preview: scroll preview to match editor cursor
        vscode.window.onDidChangeTextEditorSelection(
            (e) => {
                if (e.textEditor.document.uri.fsPath !== this.document.uri.fsPath) { return; }
                if (e.kind === vscode.TextEditorSelectionChangeKind.Command) { return; }
                const cursorOffset = this.document.offsetAt(e.selections[0].active);
                // Convert doc offset to clean offset
                const text = this.document.getText();
                const cleanOff = this.docOffsetToCleanOffset(text, cursorOffset);
                this.panel.webview.postMessage({ command: 'scrollToOffset', cleanOffset: cleanOff });
            },
            null,
            this.disposables,
        );
    }

    public static createOrShow(context: vscode.ExtensionContext, document: vscode.TextDocument) {
        const key = document.uri.fsPath;
        const existing = PreviewPanel.currentPanels.get(key);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Active);
            existing.updateContent();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'markdownReview',
            'Review: ' + path.basename(document.uri.fsPath),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media'),
                    vscode.Uri.file(path.dirname(document.uri.fsPath)),
                ],
            },
        );
        const p = new PreviewPanel(panel, document, context.extensionUri);
        PreviewPanel.currentPanels.set(key, p);
    }

    // ---------- message handling ----------

    private handleMessage(message: any) {
        switch (message.command) {
            case 'addComment': {
                const c = this.commentsManager.addComment(
                    message.startOffset,
                    message.endOffset,
                    message.blockType || '',
                    message.blockPreview || '',
                    message.comment,
                );
                this.insertAnchorViaApi(c.id, message.startOffset).then(() => {
                    this.immediateRender();
                    this.panel.webview.postMessage({ command: 'openPopover', commentId: c.id });
                });
                return;
            }
            case 'resolveComment':
                this.commentsManager.resolveComment(message.id);
                this.panel.webview.postMessage({ command: 'commentUpdated', comment: this.commentsManager.getComments().find((c: any) => c.id === message.id) });
                return;
            case 'deleteComment':
                this.removeAnchorViaApi(message.id).then(() => {
                    this.commentsManager.deleteComment(message.id);
                    this.immediateRender();
                });
                return;
            case 'unresolveComment':
                this.commentsManager.unresolveComment(message.id);
                this.panel.webview.postMessage({ command: 'commentUpdated', comment: this.commentsManager.getComments().find((c: any) => c.id === message.id) });
                return;
            case 'replyComment': {
                this.commentsManager.addReply(message.id, message.text);
                this.panel.webview.postMessage({ command: 'commentUpdated', comment: this.commentsManager.getComments().find((c: any) => c.id === message.id) });
                return;
            }
            case 'editComment': {
                this.commentsManager.editComment(message.id, message.text);
                this.panel.webview.postMessage({ command: 'commentUpdated', comment: this.commentsManager.getComments().find((c: any) => c.id === message.id) });
                return;
            }
            case 'editReply': {
                this.commentsManager.editReply(message.commentId, message.replyId, message.text);
                this.panel.webview.postMessage({ command: 'commentUpdated', comment: this.commentsManager.getComments().find((c: any) => c.id === message.commentId) });
                return;
            }
            case 'deleteReply': {
                this.commentsManager.deleteReply(message.commentId, message.replyId);
                this.panel.webview.postMessage({ command: 'commentUpdated', comment: this.commentsManager.getComments().find((c: any) => c.id === message.commentId) });
                return;
            }
            case 'refresh':
                this.commentsManager.reload();
                this.updateContent();
                return;
            case 'exportPdf': {
                this.exportAsHtml();
                return;
            }
            case 'exportDocx': {
                this.exportAsDocx();
                return;
            }
            case 'jumpToSource': {
                // Map clean-text offset to document position and reveal
                const text = this.document.getText();
                const docOff = this.cleanOffsetToDocOffset(text, message.cleanOffset);
                const pos = this.document.positionAt(docOff);
                vscode.window.showTextDocument(this.document, {
                    viewColumn: vscode.ViewColumn.One,
                    selection: new vscode.Range(pos, pos),
                    preserveFocus: false,
                });
                return;
            }
            case 'addCommentAndAsk': {
                const c = this.commentsManager.addComment(
                    message.startOffset,
                    message.endOffset,
                    message.blockType || '',
                    message.blockPreview || '',
                    message.comment,
                );
                this.insertAnchorViaApi(c.id, message.startOffset).then(() => {
                    this.immediateRender();
                    // Open the popover for the new comment
                    this.panel.webview.postMessage({ command: 'openPopover', commentId: c.id });
                    this.openCopilotForComment(c);
                });
                return;
            }
            case 'askCopilotThread': {
                // Reply was already saved by the replyComment message; just reload data for the prompt
                if (message.pendingReply) {
                    this.commentsManager.reload();
                }
                const comment = this.commentsManager.getComments().find((c: any) => c.id === message.id);
                if (comment) {
                    this.openCopilotForThread(comment);
                }
                return;
            }
        }
    }

    // ---------- Ask Copilot helpers ----------

    private openCopilotForComment(comment: any) {
        const fileName = path.basename(this.document.uri.fsPath);
        const filePath = this.document.uri.fsPath;
        const prompt = `I'm reviewing "${fileName}" (${filePath}). A new review comment was just added:\n\n` +
            `- Comment #${comment.id}: "${comment.comment}"\n` +
            `- On block: "${comment.blockPreview || '(unknown)'}"\n\n` +
            `Please use #readReviewComment to get the full context of comment "${comment.id}", ` +
            `then use #replyToReviewComment to post a helpful response addressing this comment.`;
        vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    }

    private openCopilotForThread(comment: any) {
        const fileName = path.basename(this.document.uri.fsPath);
        const filePath = this.document.uri.fsPath;
        let repliesText = '';
        if (comment.replies && comment.replies.length > 0) {
            repliesText = '\n- Existing replies:\n' +
                comment.replies.map((r: any) => `  [${r.role || 'user'}] ${r.text}`).join('\n');
        }
        const prompt = `I'm reviewing "${fileName}" (${filePath}). Please respond to this comment thread:\n\n` +
            `- Comment #${comment.id}: "${comment.comment}"\n` +
            `- On block: "${comment.blockPreview || '(unknown)'}"\n` +
            `- Status: ${comment.resolved ? 'Resolved' : 'Open'}` +
            repliesText + '\n\n' +
            `Please use #readReviewComment to get the full context of comment "${comment.id}", ` +
            `then use #replyToReviewComment to post a helpful response continuing this thread.`;
        vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    }

    // ---------- anchor operations via VS Code API ----------

    /**
     * Insert an anchor on its own line before the block at cleanOffset.
     * Uses vscode.workspace.applyEdit so the document buffer stays in sync.
     */
    private async insertAnchorViaApi(id: string, cleanOffset: number): Promise<void> {
        const text = this.document.getText();
        const docOffset = this.cleanOffsetToDocOffset(text, cleanOffset);
        // Snap back to beginning of line
        let lineStart = docOffset;
        while (lineStart > 0 && text[lineStart - 1] !== '\n') {
            lineStart--;
        }
        const pos = this.document.positionAt(lineStart);
        const eol = this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const edit = new vscode.WorkspaceEdit();
        edit.insert(this.document.uri, pos, `<!--@${id}-->${eol}`);
        await vscode.workspace.applyEdit(edit);
    }

    /** Map clean-text offset (anchor-free) to document offset (with anchors). */
    private cleanOffsetToDocOffset(text: string, cleanOffset: number): number {
        const anchorRe = /<!--@c\d+-->\r?\n?/g;
        const anchors: { start: number; length: number }[] = [];
        let m: RegExpExecArray | null;
        while ((m = anchorRe.exec(text)) !== null) {
            anchors.push({ start: m.index, length: m[0].length });
        }
        let docOffset = 0;
        let clean = 0;
        let anchorIdx = 0;
        while (clean < cleanOffset && docOffset < text.length) {
            if (anchorIdx < anchors.length && docOffset === anchors[anchorIdx].start) {
                docOffset += anchors[anchorIdx].length;
                anchorIdx++;
                continue;
            }
            docOffset++;
            clean++;
        }
        // If we landed exactly on an anchor, skip past it
        while (anchorIdx < anchors.length && docOffset === anchors[anchorIdx].start) {
            docOffset += anchors[anchorIdx].length;
            anchorIdx++;
        }
        return docOffset;
    }

    /** Map document offset (with anchors) to clean-text offset (anchor-free). */
    private docOffsetToCleanOffset(text: string, docOffset: number): number {
        const anchorRe = /<!--@c\d+-->\r?\n?/g;
        let totalAnchorChars = 0;
        let m: RegExpExecArray | null;
        while ((m = anchorRe.exec(text)) !== null) {
            if (m.index >= docOffset) { break; }
            const anchorEnd = m.index + m[0].length;
            if (anchorEnd <= docOffset) {
                totalAnchorChars += m[0].length;
            } else {
                // Cursor is inside an anchor — count up to docOffset
                totalAnchorChars += docOffset - m.index;
            }
        }
        return docOffset - totalAnchorChars;
    }

    /**
     * Remove an anchor (and its trailing newline) from the document.
     */
    private async removeAnchorViaApi(id: string): Promise<void> {
        const text = this.document.getText();
        const anchor = `<!--@${id}-->`;
        const idx = text.indexOf(anchor);
        if (idx === -1) { return; }
        // Find the full range including trailing line ending (CRLF or LF)
        let endIdx = idx + anchor.length;
        if (endIdx < text.length && text[endIdx] === '\r') {
            endIdx++;
        }
        if (endIdx < text.length && text[endIdx] === '\n') {
            endIdx++;
        }
        const startPos = this.document.positionAt(idx);
        const endPos = this.document.positionAt(endIdx);
        const edit = new vscode.WorkspaceEdit();
        edit.delete(this.document.uri, new vscode.Range(startPos, endPos));
        await vscode.workspace.applyEdit(edit);
    }

    // ---------- rendering ----------

    private renderMarkdown(text: string): { html: string; blocks: Block[]; anchorMap: Map<string, number> } {
        // Strip anchors, building a map of anchorId → clean-text offset
        const anchorMap = new Map<string, number>();
        let cleanText = '';
        let lastEnd = 0;
        const anchorRe = /<!--@(c\d+)-->\r?\n?/g;
        let m: RegExpExecArray | null;
        while ((m = anchorRe.exec(text)) !== null) {
            cleanText += text.substring(lastEnd, m.index);
            anchorMap.set(m[1], cleanText.length); // offset in clean text where the next block starts
            lastEnd = m.index + m[0].length;
        }
        cleanText += text.substring(lastEnd);

        const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
        const tree = parser.parse(cleanText);
        const blocks = collectBlocks(tree, cleanText);

        const processor = unified()
            .use(remarkParse)
            .use(remarkGfm)
            .use(remarkMath)
            .use(remarkRehype, { allowDangerousHtml: true })
            .use(rehypeRaw)
            .use(rehypeKatex, { throwOnError: false })
            .use(rehypeSourcePositions)
            .use(rehypeStringify, { allowDangerousHtml: true });

        const html = String(processor.processSync(cleanText));
        return { html, blocks, anchorMap };
    }

    private immediateRender() {
        // Cancel any pending debounce so we don't double-render
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.commentsManager.reload();
        this.updateContent();
    }

    private updateContent() {
        const text = this.document.getText();
        const { html, blocks, anchorMap } = this.renderMarkdown(text);
        // Update comment offsets from live anchor positions using blockType-aware matching
        const comments = this.commentsManager.getComments();
        let offsetsChanged = false;
        for (const c of comments) {
            const anchorPos = anchorMap.get(c.id);
            if (anchorPos === undefined) { continue; }
            // Find the first block with matching blockType at or after the anchor position
            // (anchor is always placed on the line before the target block)
            let bestBlock: Block | null = null;
            for (const b of blocks) {
                if (b.type === c.blockType && b.startOffset >= anchorPos) {
                    bestBlock = b;
                    break; // blocks are in order, first match is closest
                }
            }
            // Fallback: first block at or after anchor position (any type)
            if (!bestBlock) {
                for (const b of blocks) {
                    if (b.startOffset >= anchorPos) {
                        bestBlock = b;
                        break;
                    }
                }
            }
            const liveOffset = bestBlock ? bestBlock.startOffset : anchorPos;
            if (liveOffset !== c.startOffset) {
                c.startOffset = liveOffset;
                offsetsChanged = true;
            }
        }
        if (offsetsChanged) {
            this.commentsManager.persist();
        }
        this.panel.webview.html = this.getHtml(this.resolveImagePaths(html), blocks, comments);
        this.lastRenderTime = Date.now();
    }

    /** Rewrite relative image src paths to webview URIs */
    private resolveImagePaths(html: string): string {
        const docDir = path.dirname(this.document.uri.fsPath);
        return html.replace(/<img\s([^>]*?)src="([^"]+)"/gi, (match, before, src) => {
            // Skip absolute URLs and data URIs
            if (/^(https?:|data:|vscode-resource:)/i.test(src)) { return match; }
            const absPath = path.resolve(docDir, src);
            const webviewUri = this.panel.webview.asWebviewUri(vscode.Uri.file(absPath));
            return `<img ${before}src="${webviewUri}"`;
        });
    }

    // ---------- full webview HTML ----------

    private getMermaidUri(): vscode.Uri {
        const onDiskPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'mermaid.min.js');
        return this.panel.webview.asWebviewUri(onDiskPath);
    }

    private getHtml(body: string, blocks: Block[], comments: Comment[]): string {
        const blocksJson = JSON.stringify(blocks).replace(/</g, '\\u003c');
        const commentsJson = JSON.stringify(comments).replace(/</g, '\\u003c');
        const mermaidUri = this.getMermaidUri();

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Markdown Review</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="${mermaidUri}"></script>
<style>
/* ---------- layout ---------- */
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.6;
    color: var(--vscode-editor-foreground, #24292e);
    background: var(--vscode-editor-background, #fff);
    margin: 0; padding: 0;
}
#wrapper { display: flex; min-height: 100vh; }
#gutter {
    width: 40px; min-width: 40px; position: relative;
    border-right: 1px solid var(--vscode-editorWidget-border, #e1e4e8);
    user-select: none;
}
#content {
    flex: 1; padding: 20px 40px; max-width: 860px;
    position: relative;
}

/* ---------- markdown styles ---------- */
h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: .3em; margin-top: 24px; }
h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: .3em; margin-top: 24px; }
h3 { font-size: 1.25em; margin-top: 24px; }
h4 { font-size: 1em; margin-top: 24px; }
code { background: var(--vscode-textCodeBlock-background, #f6f8fa); padding: .2em .4em; border-radius: 3px; font-size: 85%; }
pre { background: var(--vscode-textCodeBlock-background, #f6f8fa); padding: 16px; border-radius: 6px; overflow: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #dfe2e5; padding: 0 16px; margin: 0 0 16px 0; color: #6a737d; }
table { border-collapse: collapse; width: auto; margin-bottom: 16px; }
th, td { border: 1px solid #dfe2e5; padding: 6px 13px; }
th { font-weight: 600; background: var(--vscode-textCodeBlock-background, #f6f8fa); }
tr:nth-child(2n) { background: var(--vscode-textCodeBlock-background, #f6f8fa50); }
hr { border: none; border-top: 1px solid #eaecef; margin: 24px 0; }
img { max-width: 100%; }
.katex-display { overflow-x: auto; margin: 16px 0; }
.comment-anchor { display: none; }

/* ---------- "+" gutter buttons ---------- */
.gutter-btn {
    position: absolute; left: 6px;
    width: 24px; height: 24px; border-radius: 50%;
    background: #0078d4; color: #fff; border: none;
    font-size: 16px; line-height: 24px; text-align: center;
    cursor: pointer; opacity: 0; transition: opacity .15s;
    z-index: 10; padding: 0;
}
#wrapper:hover .gutter-btn { opacity: .35; }
.gutter-btn:hover { opacity: 1 !important; transform: scale(1.15); }

/* ---------- commented block highlight ---------- */
.commented-block { border-left: 4px solid #ffc107; padding-left: 8px; cursor: pointer; }
.commented-block:hover { background: rgba(255,193,7,.08); }

/* ---------- popover ---------- */
#comment-popover {
    display: none; position: absolute;
    background: var(--vscode-editorWidget-background, #252526);
    color: var(--vscode-editorWidget-foreground, #ccc);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 6px; padding: 12px 16px;
    min-width: 250px; max-width: 400px;
    box-shadow: 0 4px 12px rgba(0,0,0,.4); z-index: 1000; font-size: 13px;
}
#comment-popover .pop-text { white-space: pre-wrap; margin-bottom: 6px; }
#comment-popover .pop-meta { font-size: 11px; color: #888; margin-bottom: 8px; }
#comment-popover .pop-actions { display: flex; gap: 6px; margin-top: 8px; }
#comment-popover button {
    padding: 3px 10px; border: 1px solid #555; background: #333;
    color: #ccc; border-radius: 3px; cursor: pointer; font-size: 11px;
}
#comment-popover button:hover { background: #444; }
#comment-popover button.btn-resolve { border-color: #4caf50; }
.btn-copilot { background: #7c3aed !important; color: #fff !important; border-color: #7c3aed !important; padding: 3px 10px !important; font-size: 11px !important; line-height: normal !important; box-sizing: border-box !important; }
.btn-copilot:hover { background: #6d28d9 !important; }

/* ---------- comment dialog ---------- */
#dialog-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,.4); z-index: 1999;
}
#comment-dialog {
    display: none; position: fixed; top: 50%; left: 50%;
    transform: translate(-50%,-50%);
    background: var(--vscode-editorWidget-background, #252526);
    color: var(--vscode-editorWidget-foreground, #ccc);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 8px; padding: 20px; min-width: 400px;
    box-shadow: 0 4px 20px rgba(0,0,0,.5); z-index: 2000;
}
#comment-dialog h3 { margin: 0 0 8px; border: none; font-size: 14px; }
#comment-dialog .preview-text {
    background: rgba(255,213,79,.2); padding: 8px; border-radius: 4px;
    margin-bottom: 12px; font-style: italic; max-height: 60px; overflow: auto; font-size: 12px;
}
#comment-dialog textarea {
    width: 100%; min-height: 80px; padding: 8px; border: 1px solid #555;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border-radius: 4px; font-family: inherit; font-size: 13px;
    resize: vertical; box-sizing: border-box;
}
#comment-dialog .dlg-actions { margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; }
#comment-dialog button { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
#comment-dialog .btn-primary { background: #0078d4; color: #fff; }
#comment-dialog .btn-primary:hover { background: #106ebe; }
#comment-dialog .btn-cancel { background: #333; color: #ccc; border: 1px solid #555; }

/* ---------- comment badge + list panel ---------- */
.comment-badge {
    position: fixed; top: 10px; right: 10px; background: #0078d4; color: #fff;
    border-radius: 12px; padding: 4px 12px; font-size: 12px; z-index: 100; cursor: pointer;
}
.comment-badge:hover { background: #106ebe; }

#comment-list-panel {
    display: none; position: fixed; top: 0; right: 0; width: 350px; height: 100%;
    background: var(--vscode-editorWidget-background, #1e1e1e);
    border-left: 1px solid var(--vscode-editorWidget-border, #454545);
    box-shadow: -4px 0 12px rgba(0,0,0,.3); z-index: 1500; overflow-y: auto;
}
#comment-list-panel .panel-hdr {
    position: sticky; top: 0; padding: 12px 16px;
    background: var(--vscode-editorWidget-background, #1e1e1e);
    border-bottom: 1px solid #454545; display: flex; justify-content: space-between; align-items: center;
}
#comment-list-panel .panel-hdr h3 { margin: 0; font-size: 14px; border: none; }
#comment-list-panel .panel-close {
    background: none; border: none; color: #ccc; font-size: 18px; cursor: pointer;
}
.clist-item {
    padding: 12px 16px; border-bottom: 1px solid #333; cursor: pointer;
}
.clist-item:hover { background: rgba(255,255,255,.05); }
.clist-item.resolved { opacity: .5; }
.clist-item .item-preview { font-size: 12px; color: #e8a317; margin-bottom: 4px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.clist-item .item-comment { font-size: 13px; white-space: pre-wrap; margin-bottom: 4px; }
.clist-item .item-meta { font-size: 11px; color: #888; }
.clist-item .item-actions { margin-top: 8px; display: flex; gap: 6px; }
.clist-item button {
    padding: 2px 8px; border: 1px solid #555; background: #333;
    color: #ccc; border-radius: 3px; cursor: pointer; font-size: 11px;
}
.clist-item button:hover { background: #444; }

/* ---------- reply styles ---------- */
.pop-replies, .item-replies { margin: 8px 0; padding-left: 12px; border-left: 2px solid #555; }
.pop-reply, .item-reply { margin-bottom: 6px; }
.pop-reply-text, .item-reply-text { font-size: 12px; white-space: pre-wrap; }
.pop-reply-meta, .item-reply-meta { font-size: 10px; color: #888; }
.role-badge { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-right: 4px; }
.role-user { background: #0e639c; color: #fff; }
.role-agent { background: #6a1b9a; color: #fff; }
.pop-reply-input { margin-top: 8px; }
.pop-reply-input textarea {
    width: 100%; padding: 4px; border: 1px solid #555;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border-radius: 3px; font-family: inherit; font-size: 12px;
    resize: none; box-sizing: border-box;
}
.pop-reply-input button {
    margin-top: 4px; padding: 3px 10px; border: 1px solid #555; background: #333;
    color: #ccc; border-radius: 3px; cursor: pointer; font-size: 11px;
}
.pop-reply-input button:hover { background: #444; }
.reply-delete-btn {
    font-size: 10px; padding: 0 4px; border: 1px solid #555; background: #333;
    color: #ccc; border-radius: 2px; cursor: pointer; margin-left: 4px;
}
.reply-delete-btn:hover { background: #633; border-color: #c44; }
.inline-edit-btn {
    font-size: 10px; padding: 0 4px; border: 1px solid #555; background: #333;
    color: #ccc; border-radius: 2px; cursor: pointer; margin-left: 4px;
}
.inline-edit-btn:hover { background: #444; }

/* ---------- export buttons ---------- */
.export-buttons {
    position: fixed; top: 10px; right: 220px; z-index: 100;
    display: flex; gap: 6px;
}
.export-btn {
    padding: 4px 10px; border-radius: 12px; border: 1px solid #555;
    background: #333; color: #ccc; font-size: 12px; cursor: pointer;
}
.export-btn:hover { background: #444; }
</style>
</head>
<body>

<div class="comment-badge" id="comment-badge" style="display:none" onclick="togglePanel()">
    &#x1F4AC; <span id="badge-count">0</span> comments
</div>
<div class="export-buttons">
    <button class="export-btn" onclick="jumpToSource()" title="Jump to source editor at current scroll position. You can also double-click anywhere in the preview to jump to that block in the source.">&#x2190; Source</button>
    <button class="export-btn" onclick="exportPdf()" title="Export to PDF">&#x1F4C4; PDF</button>
    <button class="export-btn" onclick="exportDocx()" title="Export to DOCX">&#x1F4DD; DOCX</button>
</div>

<div id="wrapper">
    <div id="gutter"></div>
    <div id="content">${body}</div>
</div>

<div id="comment-popover"></div>

<div id="comment-list-panel">
    <div class="panel-hdr">
        <h3>&#x1F4AC; Review Comments</h3>
        <button class="panel-close" onclick="togglePanel()">&times;</button>
    </div>
    <div id="comment-list-body"></div>
</div>

<div id="dialog-overlay" onclick="hideDialog()"></div>
<div id="comment-dialog">
    <h3>Add Review Comment</h3>
    <div class="preview-text" id="dlg-preview"></div>
    <textarea id="dlg-input" placeholder="Type your comment..."></textarea>
    <div class="dlg-actions">
        <button class="btn-cancel" onclick="hideDialog()">Cancel</button>
        <button class="btn-primary" onclick="submitComment()">Add Comment</button>
        <button class="btn-primary btn-copilot" onclick="submitCommentAndAsk()">&#x2728; Ask Copilot</button>
    </div>
</div>

<script>
(function() {
    var vscode = acquireVsCodeApi();
    var blocks = ${blocksJson};
    var comments = ${commentsJson};
    var pendingBlock = null;   // {startOffset, endOffset, blockType, blockPreview}
    var panelVisible = false;

    // ========== gutter "+" buttons ==========
    function placeGutterButtons() {
        var gutter = document.getElementById('gutter');
        var content = document.getElementById('content');
        gutter.innerHTML = '';
        blocks.forEach(function(block) {
            var el = content.querySelector('[data-start-offset="' + block.startOffset + '"]');
            if (!el) return;
            var rect = el.getBoundingClientRect();
            var btn = document.createElement('button');
            btn.className = 'gutter-btn';
            btn.textContent = '+';
            btn.style.top = (rect.top + window.scrollY) + 'px';
            btn.title = block.type + ': ' + block.preview.substring(0, 40);
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                pendingBlock = {
                    startOffset: block.startOffset,
                    endOffset: block.endOffset,
                    blockType: block.type,
                    blockPreview: block.preview
                };
                showDialog(block.preview);
            });
            gutter.appendChild(btn);
        });
    }

    // Reposition on scroll / resize
    var repositionTimer = null;
    function scheduleReposition() {
        if (repositionTimer) return;
        repositionTimer = setTimeout(function() { repositionTimer = null; placeGutterButtons(); }, 60);
    }
    window.addEventListener('scroll', scheduleReposition, { passive: true });
    window.addEventListener('resize', scheduleReposition);

    // ========== comment highlighting ==========
    function highlightCommentedBlocks() {
        // Remove old highlights
        document.querySelectorAll('.commented-block').forEach(function(el) {
            el.classList.remove('commented-block');
        });
        var content = document.getElementById('content');
        comments.forEach(function(c) {
            if (c.resolved) return;
            var el = content.querySelector('[data-start-offset="' + c.startOffset + '"]');
            if (!el) return;
            el.classList.add('commented-block');
            el.setAttribute('data-comment-id', c.id);
        });
        updateBadge();
    }

    function attachBlockClickHandlers() {
        document.querySelectorAll('.commented-block').forEach(function(el) {
            el.onclick = function(e) {
                e.stopPropagation();
                var cid = el.getAttribute('data-comment-id');
                var c = comments.find(function(x) { return x.id === cid; });
                if (c) showPopover(c, el);
            };
        });
    }

    // ========== badge ==========
    function updateBadge() {
        var badge = document.getElementById('comment-badge');
        var span = document.getElementById('badge-count');
        var unresolved = comments.filter(function(c) { return !c.resolved; });
        if (comments.length > 0) {
            badge.style.display = 'block';
            span.textContent = unresolved.length + ' / ' + comments.length;
        } else {
            badge.style.display = 'none';
        }
    }

    // ========== popover ==========
    function showPopover(comment, anchorEl) {
        var pop = document.getElementById('comment-popover');
        var resolveBtn = comment.resolved
            ? '<button onclick="unresolveComment(\\'' + comment.id + '\\')">Reopen</button>'
            : '<button class="btn-resolve" onclick="resolveComment(\\'' + comment.id + '\\')">Resolve</button>';
        var repliesHtml = '';
        if (comment.replies && comment.replies.length > 0) {
            repliesHtml = '<div class="pop-replies">';
            comment.replies.forEach(function(r) {
                repliesHtml += '<div class="pop-reply" id="pop-reply-' + r.id + '"><div class="pop-reply-text"><span class="role-badge role-' + (r.role || 'user') + '">' + (r.role || 'user') + '</span>' + esc(r.text) +
                    ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditReply(\\'' + comment.id + '\\',\\'' + r.id + '\\')">edit</button>' +
                    ' <button class="reply-delete-btn" onclick="event.stopPropagation();deleteReply(\\'' + comment.id + '\\',\\'' + r.id + '\\')">\u00d7</button></div>' +
                    '<div class="pop-reply-meta">' + new Date(r.timestamp).toLocaleString() + '</div></div>';
            });
            repliesHtml += '</div>';
        }
        pop.innerHTML =
            '<div class="pop-text" id="pop-comment-' + comment.id + '"><span class="role-badge role-' + (comment.role || 'user') + '">' + (comment.role || 'user') + '</span>' + esc(comment.comment) +
            ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditComment(\\'' + comment.id + '\\')">edit</button></div>' +
            '<div class="pop-meta">' + new Date(comment.timestamp).toLocaleString() +
            (comment.resolved ? ' \\u2705 Resolved' : '') + '</div>' +
            repliesHtml +
            '<div class="pop-reply-input"><textarea id="reply-input" placeholder="Reply..." rows="2"></textarea>' +
            '<button onclick="submitReply(\\'' + comment.id + '\\')">Reply</button>' +
            '<button class="btn-copilot" onclick="askCopilotThread(\\'' + comment.id + '\\')">&#x2728; Ask Copilot</button></div>' +
            '<div class="pop-actions">' + resolveBtn +
            '<button onclick="deleteComment(\\'' + comment.id + '\\')">Delete</button></div>';
        var rect = anchorEl.getBoundingClientRect();
        pop.style.top = (rect.bottom + window.scrollY + 5) + 'px';
        pop.style.left = (rect.left + window.scrollX) + 'px';
        pop.style.display = 'block';
    }
    document.addEventListener('click', function(e) {
        var pop = document.getElementById('comment-popover');
        if (pop.style.display === 'block' && !pop.contains(e.target) && !e.target.classList.contains('commented-block')) {
            pop.style.display = 'none';
        }
    });

    // ========== dialog ==========
    function showDialog(preview) {
        document.getElementById('dlg-preview').textContent = preview;
        document.getElementById('dlg-input').value = '';
        document.getElementById('comment-dialog').style.display = 'block';
        document.getElementById('dialog-overlay').style.display = 'block';
        document.getElementById('dlg-input').focus();
    }
    window.hideDialog = function() {
        document.getElementById('comment-dialog').style.display = 'none';
        document.getElementById('dialog-overlay').style.display = 'none';
    };
    window.submitComment = function() {
        var text = document.getElementById('dlg-input').value.trim();
        if (!text || !pendingBlock) return;
        vscode.postMessage({
            command: 'addComment',
            startOffset: pendingBlock.startOffset,
            endOffset: pendingBlock.endOffset,
            blockType: pendingBlock.blockType,
            blockPreview: pendingBlock.blockPreview,
            comment: text
        });
        hideDialog();
        // optimistic UI: highlight immediately
        var content = document.getElementById('content');
        var el = content.querySelector('[data-start-offset="' + pendingBlock.startOffset + '"]');
        if (el) { el.classList.add('commented-block'); }
    };
    document.getElementById('dlg-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { submitComment(); }
    });

    // ========== Ask Copilot ==========
    window.submitCommentAndAsk = function() {
        var text = document.getElementById('dlg-input').value.trim();
        if (!text || !pendingBlock) return;
        vscode.postMessage({
            command: 'addCommentAndAsk',
            startOffset: pendingBlock.startOffset,
            endOffset: pendingBlock.endOffset,
            blockType: pendingBlock.blockType,
            blockPreview: pendingBlock.blockPreview,
            comment: text
        });
        hideDialog();
        var content = document.getElementById('content');
        var el = content.querySelector('[data-start-offset="' + pendingBlock.startOffset + '"]');
        if (el) { el.classList.add('commented-block'); }
    };
    window.askCopilotThread = function(id) {
        // Check for typed reply in popover or sidebar textarea
        var replyText = '';
        var popInput = document.getElementById('reply-input');
        if (popInput && popInput.value.trim()) {
            replyText = popInput.value.trim();
            popInput.value = '';
        } else {
            var listInput = document.getElementById('list-reply-' + id);
            if (listInput && listInput.value.trim()) {
                replyText = listInput.value.trim();
                listInput.value = '';
            }
        }
        // If user typed a reply, save it first, then ask Copilot
        if (replyText) {
            vscode.postMessage({ command: 'replyComment', id: id, text: replyText });
        }
        vscode.postMessage({ command: 'askCopilotThread', id: id, pendingReply: replyText });
    };

    // ========== export actions ==========
    window.jumpToSource = function() {
        // Find the block closest to the current scroll position
        var scrollTop = window.scrollY;
        var best = null;
        var bestDist = Infinity;
        var content = document.getElementById('content');
        blocks.forEach(function(b) {
            var el = content.querySelector('[data-start-offset="' + b.startOffset + '"]');
            if (!el) return;
            var rect = el.getBoundingClientRect();
            var dist = Math.abs(rect.top);
            if (dist < bestDist) { bestDist = dist; best = b; }
        });
        if (best) {
            vscode.postMessage({ command: 'jumpToSource', cleanOffset: best.startOffset });
        }
    };
    window.exportPdf = function() {
        vscode.postMessage({ command: 'exportPdf' });
    };
    window.exportDocx = function() {
        vscode.postMessage({ command: 'exportDocx' });
    };

    // ========== comment actions ==========
    window.resolveComment = function(id) { vscode.postMessage({ command: 'resolveComment', id: id }); };
    window.deleteComment = function(id) {
        if (confirm('Delete this comment and all its replies?')) {
            vscode.postMessage({ command: 'deleteComment', id: id });
        }
    };
    window.unresolveComment = function(id) { vscode.postMessage({ command: 'unresolveComment', id: id }); };
    window.submitReply = function(id) {
        var input = document.getElementById('reply-input');
        var text = input ? input.value.trim() : '';
        if (!text) return;
        vscode.postMessage({ command: 'replyComment', id: id, text: text });
    };
    window.startEditComment = function(id) {
        var c = comments.find(function(x) { return x.id === id; });
        if (!c) return;
        var el = document.getElementById('pop-comment-' + id) || document.getElementById('list-comment-' + id);
        if (!el) return;
        el.innerHTML =
            '<textarea id="edit-input" style="width:100%;min-height:60px;padding:6px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:4px;font-family:inherit;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc(c.comment) + '</textarea>' +
            '<div style="margin-top:6px;display:flex;gap:6px;">' +
            '<button onclick="saveEditComment(\\'' + id + '\\')">Save</button>' +
            '<button onclick="cancelEditComment()">Cancel</button></div>';
        var ta = document.getElementById('edit-input');
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    };
    window.saveEditComment = function(id) {
        var input = document.getElementById('edit-input');
        var text = input ? input.value.trim() : '';
        if (!text) return;
        vscode.postMessage({ command: 'editComment', id: id, text: text });
    };
    window.cancelEditComment = function() {
        document.getElementById('comment-popover').style.display = 'none';
    };
    window.startEditReply = function(commentId, replyId) {
        var c = comments.find(function(x) { return x.id === commentId; });
        if (!c || !c.replies) return;
        var r = c.replies.find(function(x) { return x.id === replyId; });
        if (!r) return;
        var el = document.getElementById('pop-reply-' + replyId) || document.getElementById('list-reply-' + replyId);
        if (!el) return;
        var textEl = el.querySelector('.pop-reply-text') || el.querySelector('.item-reply-text') || el;
        textEl.innerHTML =
            '<textarea id="edit-reply-input" style="width:100%;min-height:40px;padding:4px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:3px;font-family:inherit;font-size:12px;resize:vertical;box-sizing:border-box;">' + esc(r.text) + '</textarea>' +
            '<div style="margin-top:4px;display:flex;gap:4px;">' +
            '<button onclick="saveEditReply(\\'' + commentId + '\\',\\'' + replyId + '\\')">Save</button>' +
            '<button onclick="cancelEditComment()">Cancel</button></div>';
        var ta = document.getElementById('edit-reply-input');
        if (ta) { ta.focus(); }
    };
    window.saveEditReply = function(commentId, replyId) {
        var input = document.getElementById('edit-reply-input');
        var text = input ? input.value.trim() : '';
        if (!text) return;
        vscode.postMessage({ command: 'editReply', commentId: commentId, replyId: replyId, text: text });
    };
    window.deleteReply = function(commentId, replyId) {
        if (confirm('Delete this reply?')) {
            vscode.postMessage({ command: 'deleteReply', commentId: commentId, replyId: replyId });
        }
    };

    // ========== comment list panel ==========
    window.togglePanel = function() {
        panelVisible = !panelVisible;
        document.getElementById('comment-list-panel').style.display = panelVisible ? 'block' : 'none';
        if (panelVisible) buildList();
    };
    function buildList() {
        var container = document.getElementById('comment-list-body');
        container.innerHTML = '';
        if (comments.length === 0) {
            container.innerHTML = '<div style="padding:20px;color:#888;text-align:center;">No comments yet</div>';
            return;
        }
        comments.forEach(function(c) {
            var div = document.createElement('div');
            div.className = 'clist-item' + (c.resolved ? ' resolved' : '');
            var resolveBtn = c.resolved
                ? '<button onclick="event.stopPropagation();unresolveComment(\\'' + c.id + '\\')">Reopen</button>'
                : '<button onclick="event.stopPropagation();resolveComment(\\'' + c.id + '\\')">Resolve</button>';
            var repliesHtml = '';
            if (c.replies && c.replies.length > 0) {
                repliesHtml = '<div class="item-replies">';
                c.replies.forEach(function(r) {
                    repliesHtml += '<div class="item-reply" id="list-reply-' + r.id + '"><div class="item-reply-text"><span class="role-badge role-' + (r.role || 'user') + '">' + (r.role || 'user') + '</span>' + esc(r.text) +
                        ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditReply(\\'' + c.id + '\\',\\'' + r.id + '\\')">edit</button>' +
                        ' <button class="reply-delete-btn" onclick="event.stopPropagation();deleteReply(\\'' + c.id + '\\',\\'' + r.id + '\\')">\u00d7</button></div>' +
                        '<div class="item-reply-meta">' + new Date(r.timestamp).toLocaleString() + '</div></div>';
                });
                repliesHtml += '</div>';
            }
            div.innerHTML =
                '<div class="item-preview">' + esc(c.blockPreview || '(block)') + '</div>' +
                '<div class="item-comment" id="list-comment-' + c.id + '"><span class="role-badge role-' + (c.role || 'user') + '">' + (c.role || 'user') + '</span>' + esc(c.comment) +
                ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditComment(\\'' + c.id + '\\')">edit</button></div>' +
                '<div class="item-meta">' + new Date(c.timestamp).toLocaleString() +
                (c.resolved ? ' \\u2705' : '') + '</div>' +
                repliesHtml +
                '<div class="item-reply-input" onclick="event.stopPropagation()">' +
                '<textarea id="list-reply-' + c.id + '" placeholder="Reply..." rows="1" style="width:100%;margin-top:6px;padding:4px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:3px;font-family:inherit;font-size:12px;resize:none;box-sizing:border-box;"></textarea>' +
                '<button onclick="event.stopPropagation();var inp=document.getElementById(\\'list-reply-' + c.id + '\\');var t=inp.value.trim();if(t){vscode.postMessage({command:\\'replyComment\\',id:\\'' + c.id + '\\',text:t});}" style="margin-top:4px;">Reply</button>' +
                '<button class="btn-copilot" onclick="event.stopPropagation();askCopilotThread(\\'' + c.id + '\\')" style="margin-top:4px;">&#x2728; Ask Copilot</button></div>' +
                '<div class="item-actions">' + resolveBtn +
                '<button onclick="event.stopPropagation();deleteComment(\\'' + c.id + '\\')">Delete</button></div>';
            div.addEventListener('click', function() {
                var content = document.getElementById('content');
                var el = content.querySelector('[data-start-offset="' + c.startOffset + '"]');
                if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            });
            container.appendChild(div);
        });
    }

    // ========== optimistic UI from extension host ==========
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!msg || !msg.command) return;
        switch (msg.command) {
            case 'commentAdded':
                comments.push(msg.comment);
                highlightCommentedBlocks();
                attachBlockClickHandlers();
                if (panelVisible) buildList();
                break;
            case 'commentResolved': {
                var el = document.querySelector('[data-comment-id="' + msg.id + '"]');
                if (el) el.classList.remove('commented-block');
                var ci = comments.find(function(x) { return x.id === msg.id; });
                if (ci) ci.resolved = true;
                updateBadge();
                if (panelVisible) buildList();
                document.getElementById('comment-popover').style.display = 'none';
                break;
            }
            case 'commentDeleted': {
                var el2 = document.querySelector('[data-comment-id="' + msg.id + '"]');
                if (el2) { el2.classList.remove('commented-block'); el2.removeAttribute('data-comment-id'); }
                comments = comments.filter(function(x) { return x.id !== msg.id; });
                updateBadge();
                if (panelVisible) buildList();
                document.getElementById('comment-popover').style.display = 'none';
                break;
            }
            case 'commentUnresolved': {
                var ci2 = comments.find(function(x) { return x.id === msg.id; });
                if (ci2) ci2.resolved = false;
                highlightCommentedBlocks();
                attachBlockClickHandlers();
                if (panelVisible) buildList();
                document.getElementById('comment-popover').style.display = 'none';
                break;
            }
            case 'commentUpdated': {
                var idx = comments.findIndex(function(x) { return x.id === msg.comment.id; });
                if (idx >= 0) { comments[idx] = msg.comment; }
                highlightCommentedBlocks();
                attachBlockClickHandlers();
                updateBadge();
                if (panelVisible) buildList();
                // Re-show popover if it was open for this comment
                var pop = document.getElementById('comment-popover');
                if (pop.style.display === 'block') {
                    var updatedComment = comments.find(function(x) { return x.id === msg.comment.id; });
                    if (updatedComment) {
                        var content = document.getElementById('content');
                        var anchorEl = content.querySelector('[data-start-offset="' + updatedComment.startOffset + '"]');
                        if (anchorEl) { showPopover(updatedComment, anchorEl); }
                    }
                }
                break;
            }
            case 'openPopover': {
                var oc = comments.find(function(x) { return x.id === msg.commentId; });
                if (oc) {
                    var ocContent = document.getElementById('content');
                    var ocAnchor = ocContent.querySelector('[data-start-offset="' + oc.startOffset + '"]');
                    if (ocAnchor) { showPopover(oc, ocAnchor); }
                }
                break;
            }
        }
    });

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    // ========== init ==========
    placeGutterButtons();
    highlightCommentedBlocks();
    attachBlockClickHandlers();

    // ========== Mermaid rendering ==========
    var mermaidSources = []; // stores { index, source } for SVG collection
    mermaid.initialize({ startOnLoad: false, theme: 'dark' });
    document.querySelectorAll('pre > code.language-mermaid').forEach(function(codeEl, i) {
        var pre = codeEl.parentElement;
        var source = codeEl.textContent;
        mermaidSources.push({ index: i, source: source });
        var container = document.createElement('div');
        container.className = 'mermaid';
        container.id = 'mermaid-' + i;
        container.textContent = source;
        pre.parentElement.replaceChild(container, pre);
    });
    mermaid.run({ querySelector: '.mermaid' });

    // ========== Preview → Source: double-click to jump ==========
    document.getElementById('content').addEventListener('dblclick', function(e) {
        // Find the closest element with data-start-offset
        var target = e.target;
        while (target && target !== this) {
            if (target.getAttribute && target.getAttribute('data-start-offset') !== null) {
                var offset = parseInt(target.getAttribute('data-start-offset'));
                vscode.postMessage({ command: 'jumpToSource', cleanOffset: offset });
                return;
            }
            target = target.parentElement;
        }
    });

    // ========== Source → Preview: scroll to matching block ==========
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!msg) return;
        if (msg.command === 'scrollToOffset') {
            // Find the block closest to cleanOffset
            var best = null;
            var bestDist = Infinity;
            blocks.forEach(function(b) {
                var dist = Math.abs(b.startOffset - msg.cleanOffset);
                if (dist < bestDist) { bestDist = dist; best = b; }
            });
            if (best) {
                var content = document.getElementById('content');
                var el = content.querySelector('[data-start-offset=\"' + best.startOffset + '\"]');
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    // Brief highlight flash
                    el.style.outline = '2px solid #0078d4';
                    setTimeout(function() { el.style.outline = ''; }, 1500);
                }
            }
        }
        if (msg.command === 'captureScreenshot') {
            try {
                // Capture the full rendered HTML including styles
                var styles = Array.from(document.querySelectorAll('style')).map(function(s){return s.outerHTML;}).join('\\n');
                var links = Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(function(l){return l.outerHTML;}).join('\\n');
                var contentEl = document.getElementById('content');
                var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' + links + styles + '</head><body style="padding:20px;max-width:860px;margin:auto;">' + (contentEl ? contentEl.innerHTML : '') + '</body></html>';
                vscode.postMessage({ command: 'screenshotResult', html: html });
            } catch(err) {
                vscode.postMessage({ command: 'screenshotResult', error: err.message || 'Unknown error' });
            }
        }
        if (msg.command === 'collectMermaidSvgs') {
            var results = [];
            mermaidSources.forEach(function(item) {
                var el = document.getElementById('mermaid-' + item.index);
                var svgEl = el ? el.querySelector('svg') : null;
                results.push({
                    source: item.source,
                    svg: svgEl ? svgEl.outerHTML : null
                });
            });
            vscode.postMessage({ command: 'mermaidSvgsResult', svgs: results });
        }
    });
})();
</script>
</body>
</html>`;
    }

    // ---------- public methods for Copilot tools ----------

    /** Refresh the preview (reload comments + re-render) */
    public refresh() {
        this.commentsManager.reload();
        this.updateContent();
    }

    /** Send updated comment to webview without full re-render (keeps popover open) */
    public refreshComment(commentId: string) {
        this.commentsManager.reload();
        const comment = this.commentsManager.getComments().find((c: any) => c.id === commentId);
        if (comment) {
            this.panel.webview.postMessage({ command: 'commentUpdated', comment });
        }
    }

    /** Collect rendered Mermaid SVGs from the webview */
    private collectMermaidSvgs(): Promise<Array<{ source: string; svg: string | null }>> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve([]), 5000);
            const disposable = this.panel.webview.onDidReceiveMessage((msg) => {
                if (msg.command === 'mermaidSvgsResult') {
                    clearTimeout(timeout);
                    disposable.dispose();
                    resolve(msg.svgs || []);
                }
            });
            this.panel.webview.postMessage({ command: 'collectMermaidSvgs' });
        });
    }

    /** Find Chrome path */
    private findChrome(): string | undefined {
        const fs = require('fs');
        const chromePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.CHROME_PATH || '',
        ];
        return chromePaths.find(p => p && fs.existsSync(p));
    }

    /**
     * Render Mermaid source code to PNG files using Chrome headless.
     * Each mermaid block gets its own temp HTML with CDN Mermaid, rendered by Chrome.
     * Returns array of { source, pngPath } for replacement.
     */
    private async renderMermaidToPng(mermaidBlocks: Array<{ source: string }>, tempDir: string): Promise<Array<{ source: string; pngPath: string }>> {
        const fs = require('fs');
        const { execFileSync } = require('child_process');
        const chromePath = this.findChrome();
        if (!chromePath) {
            logError('Chrome not found — cannot render Mermaid diagrams');
            return [];
        }

        log(`Rendering ${mermaidBlocks.length} Mermaid diagram(s) to PNG`);
        const results: Array<{ source: string; pngPath: string }> = [];
        for (let i = 0; i < mermaidBlocks.length; i++) {
            const { source } = mermaidBlocks[i];
            const pngPath = path.join(tempDir, `mermaid-export-${i}.png`);
            const tempHtmlPath = path.join(tempDir, `mermaid-export-${i}.html`);

            // HTML that renders mermaid with same layout as PDF export (max-width:860px)
            const tempHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
html { margin: 0; padding: 0; background: white; }
body { margin: 0; padding: 20px 40px; background: white; max-width: 860px; }
</style>
</head><body>
<div id="diagram" class="mermaid">${source.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
<script>
mermaid.initialize({ startOnLoad: false, theme: 'default' });
mermaid.run({ querySelector: '.mermaid' }).then(function() {
    // After render, shrink body to fit the SVG for tight screenshot
    var svg = document.querySelector('#diagram svg');
    if (svg) {
        var bbox = svg.getBoundingClientRect();
        document.body.style.width = Math.ceil(bbox.width + 80) + 'px';
        document.body.style.height = Math.ceil(bbox.height + 40) + 'px';
    }
});
</script>
</body></html>`;

            fs.writeFileSync(tempHtmlPath, tempHtml, 'utf-8');
            log(`Diagram ${i}: Rendering with Chrome...`);
            try {
                // Use a large window so the diagram isn't clipped during render,
                // but body is inline-block so Chrome screenshots only the content area
                execFileSync(chromePath, [
                    '--headless=new', '--disable-gpu',
                    `--screenshot=${pngPath}`,
                    '--window-size=1600,4000',
                    '--force-device-scale-factor=2',
                    '--virtual-time-budget=8000',
                    `file:///${tempHtmlPath.replace(/\\/g, '/')}`
                ], { timeout: 25000 });
                const rawSize = fs.statSync(pngPath).size;
                log(`Diagram ${i}: Raw PNG ${rawSize} bytes`);

                // Trim whitespace using bundled pngjs trim script (no native deps)
                log(`Diagram ${i}: Trimming whitespace...`);
                const rawPngPath = pngPath.replace('.png', '-raw.png');
                try {
                    fs.renameSync(pngPath, rawPngPath);
                    const trimScript = path.join(this.extensionUri.fsPath, 'media', 'trim-png-bundled.js');
                    const trimResult = execFileSync('node', [trimScript, rawPngPath, pngPath], {
                        timeout: 30000,
                        encoding: 'utf-8',
                    });
                    log(`Diagram ${i}: Trim result: ${trimResult.trim()}`);
                    try { fs.unlinkSync(rawPngPath); } catch {}
                } catch (trimErr: any) {
                    logError(`Diagram ${i}: Trim failed, using raw`, trimErr);
                    try { fs.renameSync(rawPngPath, pngPath); } catch {}
                }
                results.push({ source, pngPath });
            } catch (chromeErr: any) {
                logError(`Diagram ${i}: Chrome failed`, chromeErr);
            }
            try { fs.unlinkSync(tempHtmlPath); } catch {}
        }
        log(`Rendered ${results.length}/${mermaidBlocks.length} diagrams`);
        return results;
    }

    /** Extract mermaid source blocks from markdown text */
    private extractMermaidBlocks(mdText: string): Array<{ source: string }> {
        const blocks: Array<{ source: string }> = [];
        const re = /```mermaid\s*\n([\s\S]*?)\n\s*```/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(mdText)) !== null) {
            blocks.push({ source: m[1] });
        }
        return blocks;
    }

    /** Replace mermaid code blocks in markdown with image references */
    private replaceMermaidInMarkdown(md: string, pngFiles: Array<{ source: string; pngPath: string }>): string {
        for (const item of pngFiles) {
            const escaped = item.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
            const re = new RegExp('```mermaid\\s*\\n\\s*' + escaped + '\\s*\\n\\s*```', 's');
            md = md.replace(re, `![Diagram](${item.pngPath.replace(/\\/g, '/')})`);
        }
        return md;
    }

    /** Export clean rendered HTML (no comments/anchors) and open in browser for PDF printing */
    private async exportAsHtml() {
        log('PDF Export: Starting...');
        const text = this.document.getText();
        const cleanText = text.replace(/<!--@c\d+-->\r?\n?/g, '');

        const processor = unified()
            .use(remarkParse)
            .use(remarkGfm)
            .use(remarkMath)
            .use(remarkRehype, { allowDangerousHtml: true })
            .use(rehypeRaw)
            .use(rehypeKatex, { throwOnError: false })
            .use(rehypeStringify, { allowDangerousHtml: true });

        const html = String(processor.processSync(cleanText));

        // PDF uses CDN Mermaid — Chrome headless renders it natively
        const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${path.basename(this.document.uri.fsPath, '.md')}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #24292e; max-width: 860px; margin: auto; padding: 20px 40px; }
h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
h3 { font-size: 1.25em; }
h4 { font-size: 1em; }
code { background: #f6f8fa; padding: .2em .4em; border-radius: 3px; font-size: 85%; }
pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #dfe2e5; padding: 0 16px; margin: 0 0 16px 0; color: #6a737d; }
table { border-collapse: collapse; width: auto; margin-bottom: 16px; }
th, td { border: 1px solid #dfe2e5; padding: 6px 13px; }
th { font-weight: 600; background: #f6f8fa; }
tr:nth-child(2n) { background: rgba(246,248,250,.5); }
hr { border: none; border-top: 1px solid #eaecef; margin: 24px 0; }
img { max-width: 100%; }
.katex-display { overflow-x: auto; margin: 16px 0; }
@media print { @page { margin: 0.75in; } }
</style>
</head>
<body>
${html}
<script>
mermaid.initialize({ startOnLoad: false, theme: 'default' });
document.querySelectorAll('pre > code.language-mermaid').forEach(function(codeEl, i) {
    var pre = codeEl.parentElement;
    var container = document.createElement('div');
    container.className = 'mermaid';
    container.textContent = codeEl.textContent;
    pre.parentElement.replaceChild(container, pre);
});
mermaid.run({ querySelector: '.mermaid' });
</script>
</body>
</html>`;

        const fs = require('fs');
        const { execFile } = require('child_process');
        const htmlPath = this.document.uri.fsPath.replace(/\.md$/i, '') + '_export.html';
        fs.writeFileSync(htmlPath, fullHtml, 'utf-8');

        // Try Chrome headless for direct PDF generation
        const pdfPath = this.document.uri.fsPath.replace(/\.md$/i, '') + '_export.pdf';
        const chromePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.CHROME_PATH || '',
        ];
        const chromePath = chromePaths.find(p => p && fs.existsSync(p));

        if (chromePath) {
            const args = [
                '--headless=new', '--disable-gpu',
                `--print-to-pdf=${pdfPath}`,
                '--no-pdf-header-footer',
                '--virtual-time-budget=15000',
                htmlPath,
            ];
            execFile(chromePath, args, { timeout: 30000 }, (err: any) => {
                // Clean up temp HTML
                try { fs.unlinkSync(htmlPath); } catch {}
                if (err) {
                    // Fallback: open in browser for manual print
                    vscode.env.openExternal(vscode.Uri.file(htmlPath));
                    vscode.window.showWarningMessage(
                        `Chrome PDF failed. HTML opened in browser — use Ctrl+P → Save as PDF.`
                    );
                } else {
                    vscode.window.showInformationMessage(`PDF exported to: ${path.basename(pdfPath)}`);
                    vscode.env.openExternal(vscode.Uri.file(pdfPath));
                }
            });
        } else {
            // No Chrome found: fallback to browser (keep SVG files for browser rendering)
            vscode.env.openExternal(vscode.Uri.file(htmlPath));
            vscode.window.showInformationMessage(
                `Preview opened in browser. Ctrl+P → uncheck "Headers and footers" → Save as PDF.`
            );
        }
    }

    /** Export clean markdown to DOCX via Pandoc */
    private async exportAsDocx() {
        log('DOCX Export: Starting...');
        const fs = require('fs');
        const { execFile } = require('child_process');

        const text = this.document.getText();
        let cleanText = text.replace(/<!--@c\d+-->\r?\n?/g, '');

        // Render Mermaid blocks to PNGs via Chrome headless and replace in markdown
        const tempDir = path.dirname(this.document.uri.fsPath);
        const mermaidBlocks = this.extractMermaidBlocks(cleanText);
        log(`DOCX Export: Found ${mermaidBlocks.length} mermaid block(s)`);
        const pngFiles = await this.renderMermaidToPng(mermaidBlocks, tempDir);
        cleanText = this.replaceMermaidInMarkdown(cleanText, pngFiles);
        log(`DOCX Export: Replaced ${pngFiles.length} diagram(s) in markdown`);

        // Write clean markdown to temp file
        const cleanMdPath = this.document.uri.fsPath.replace(/\.md$/i, '') + '_clean.md';
        const docxPath = this.document.uri.fsPath.replace(/\.md$/i, '') + '_export.docx';
        fs.writeFileSync(cleanMdPath, cleanText, 'utf-8');

        // Find Pandoc
        const { execFileSync } = require('child_process');
        let pandocPath = 'pandoc';
        try {
            execFileSync('pandoc', ['--version'], { stdio: 'ignore' });
        } catch {
            // Pandoc not in PATH
            const installUrl = 'https://pandoc.org/installing.html';
            vscode.window.showErrorMessage(
                `Pandoc is required for DOCX export but was not found. [Install Pandoc](${installUrl})`,
                'Open Install Page'
            ).then(choice => {
                if (choice === 'Open Install Page') {
                    vscode.env.openExternal(vscode.Uri.parse(installUrl));
                }
            });
            // Clean up temp file
            try { fs.unlinkSync(cleanMdPath); } catch {}
            return;
        }

        const args = [
            cleanMdPath,
            '-o', docxPath,
            '--from=markdown+tex_math_dollars',
            '--to=docx',
        ];

        execFile(pandocPath, args, { timeout: 30000 }, (err: any) => {
            // Clean up temp files
            try { fs.unlinkSync(cleanMdPath); } catch {}
            for (const pf of pngFiles) { try { fs.unlinkSync(pf.pngPath); } catch {} }

            if (err) {
                vscode.window.showErrorMessage(`DOCX export failed: ${err.message}`);
            } else {
                vscode.window.showInformationMessage(`DOCX exported: ${path.basename(docxPath)}`);
                vscode.env.openExternal(vscode.Uri.file(docxPath));
            }
        });
    }

    /** Scroll the preview to a clean-text offset */
    public scrollToOffset(cleanOffset: number) {
        this.panel.webview.postMessage({ command: 'scrollToOffset', cleanOffset });
    }

    /** Bring the preview panel to focus */
    public reveal() {
        this.panel.reveal();
    }

    /** Delete a comment (remove anchor + JSON entry + re-render) */
    public async deleteCommentFromTool(commentId: string) {
        await this.removeAnchorViaApi(commentId);
        this.commentsManager.deleteComment(commentId);
        this.immediateRender();
    }

    /** Capture a screenshot of the preview as a self-contained HTML file */
    public captureScreenshot(savePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Screenshot timed out')), 10000);
            const disposable = this.panel.webview.onDidReceiveMessage((msg) => {
                if (msg.command === 'screenshotResult') {
                    clearTimeout(timeout);
                    disposable.dispose();
                    if (msg.error) {
                        reject(new Error(msg.error));
                        return;
                    }
                    try {
                        const fs = require('fs');
                        fs.writeFileSync(savePath, msg.html, 'utf-8');
                        resolve();
                    } catch (e: any) {
                        reject(e);
                    }
                }
            });
            this.panel.webview.postMessage({ command: 'captureScreenshot' });
        });
    }

    private dispose() {
        PreviewPanel.currentPanels.delete(this.document.uri.fsPath);
        this.panel.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}