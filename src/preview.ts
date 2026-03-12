import * as vscode from 'vscode';
import * as path from 'path';
import { CommentsManager, Comment } from './comments';

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
    }

    public static createOrShow(context: vscode.ExtensionContext, document: vscode.TextDocument) {
        const key = document.uri.fsPath;
        const existing = PreviewPanel.currentPanels.get(key);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Beside);
            existing.updateContent();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'markdownReview',
            'Review: ' + path.basename(document.uri.fsPath),
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
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
                });
                return;
            }
            case 'resolveComment':
                this.commentsManager.resolveComment(message.id);
                // Keep anchor in file — only remove on delete
                this.immediateRender();
                return;
            case 'deleteComment':
                this.removeAnchorViaApi(message.id).then(() => {
                    this.commentsManager.deleteComment(message.id);
                    this.immediateRender();
                });
                return;
            case 'unresolveComment':
                this.commentsManager.unresolveComment(message.id);
                this.immediateRender();
                return;
            case 'refresh':
                this.commentsManager.reload();
                this.updateContent();
                return;
        }
    }

    // ---------- anchor operations via VS Code API ----------

    /**
     * Insert an anchor on its own line before the block at cleanOffset.
     * Uses vscode.workspace.applyEdit so the document buffer stays in sync.
     */
    private async insertAnchorViaApi(id: string, cleanOffset: number): Promise<void> {
        const text = this.document.getText(); // LF-normalized by VS Code
        // Find the target position in the VS Code document text (which has existing anchors)
        // We need to map the clean offset to the document offset (skip existing anchors)
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
        // Skip any anchor at this exact position
        while (anchorIdx < anchors.length && docOffset === anchors[anchorIdx].start) {
            docOffset += anchors[anchorIdx].length;
            anchorIdx++;
        }
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
        this.panel.webview.html = this.getHtml(html, blocks, comments);
        this.lastRenderTime = Date.now();
    }

    // ---------- full webview HTML ----------

    private getHtml(body: string, blocks: Block[], comments: Comment[]): string {
        const blocksJson = JSON.stringify(blocks).replace(/</g, '\\u003c');
        const commentsJson = JSON.stringify(comments).replace(/</g, '\\u003c');

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Markdown Review</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
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
#comment-popover .pop-actions { display: flex; gap: 6px; }
#comment-popover button {
    padding: 3px 10px; border: 1px solid #555; background: #333;
    color: #ccc; border-radius: 3px; cursor: pointer; font-size: 11px;
}
#comment-popover button:hover { background: #444; }
#comment-popover button.btn-resolve { border-color: #4caf50; }

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
.clist-item .item-actions { margin-top: 6px; display: flex; gap: 6px; }
.clist-item button {
    padding: 2px 8px; border: 1px solid #555; background: #333;
    color: #ccc; border-radius: 3px; cursor: pointer; font-size: 11px;
}
.clist-item button:hover { background: #444; }
</style>
</head>
<body>

<div class="comment-badge" id="comment-badge" style="display:none" onclick="togglePanel()">
    &#x1F4AC; <span id="badge-count">0</span> comments
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
        pop.innerHTML =
            '<div class="pop-text">' + esc(comment.comment) + '</div>' +
            '<div class="pop-meta">' + new Date(comment.timestamp).toLocaleString() +
            (comment.resolved ? ' \\u2705 Resolved' : '') + '</div>' +
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

    // ========== comment actions ==========
    window.resolveComment = function(id) { vscode.postMessage({ command: 'resolveComment', id: id }); };
    window.deleteComment = function(id) { vscode.postMessage({ command: 'deleteComment', id: id }); };
    window.unresolveComment = function(id) { vscode.postMessage({ command: 'unresolveComment', id: id }); };

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
            div.innerHTML =
                '<div class="item-preview">' + esc(c.blockPreview || '(block)') + '</div>' +
                '<div class="item-comment">' + esc(c.comment) + '</div>' +
                '<div class="item-meta">' + new Date(c.timestamp).toLocaleString() +
                (c.resolved ? ' \\u2705' : '') + '</div>' +
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
})();
</script>
</body>
</html>`;
    }

    private dispose() {
        PreviewPanel.currentPanels.delete(this.document.uri.fsPath);
        this.panel.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}