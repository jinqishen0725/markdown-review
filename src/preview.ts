import * as vscode from 'vscode';
import * as path from 'path';
import { CommentsManager, Comment } from './comments';

// Remark/unified ecosystem for precise source mapping
const { unified } = require('unified');
const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkMath = require('remark-math').default || require('remark-math');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');
const remarkRehype = require('remark-rehype').default || require('remark-rehype');
const rehypeKatex = require('rehype-katex').default || require('rehype-katex');
const rehypeStringify = require('rehype-stringify').default || require('rehype-stringify');
const rehypeRaw = require('rehype-raw').default || require('rehype-raw');

/**
 * Custom rehype plugin that injects data-start-offset and data-end-offset
 * attributes on every HTML element that has position info from the AST.
 */
function rehypeSourcePositions() {
    return (tree: any) => {
        visit(tree);
    };
    function visit(node: any) {
        if (node.type === 'element' && node.position) {
            if (!node.properties) node.properties = {};
            node.properties['data-start-offset'] = node.position.start.offset;
            node.properties['data-end-offset'] = node.position.end.offset;
            node.properties['data-start-line'] = node.position.start.line;
            node.properties['data-end-line'] = node.position.end.line;
        }
        if (node.children) {
            for (const child of node.children) {
                visit(child);
            }
        }
    }
}

export class PreviewPanel {
    public static currentPanels: Map<string, PreviewPanel> = new Map();
    private panel: vscode.WebviewPanel;
    private document: vscode.TextDocument;
    private commentsManager: CommentsManager;
    private extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        document: vscode.TextDocument,
        extensionUri: vscode.Uri
    ) {
        this.panel = panel;
        this.document = document;
        this.extensionUri = extensionUri;
        this.commentsManager = new CommentsManager(document.uri.fsPath);

        this.panel.webview.options = { enableScripts: true };
        this.updateContent();

        // Listen for messages from the webview
        this.panel.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
            null,
            this.disposables
        );

        // Auto-refresh on save
        vscode.workspace.onDidSaveTextDocument(
            (doc) => {
                if (doc.uri.fsPath === this.document.uri.fsPath) {
                    this.updateContent();
                }
            },
            null,
            this.disposables
        );

        // Clean up on close
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
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
            }
        );

        const previewPanel = new PreviewPanel(panel, document, context.extensionUri);
        PreviewPanel.currentPanels.set(key, previewPanel);
    }

    private handleMessage(message: any) {
        switch (message.command) {
            case 'addComment':
                const newComment = this.commentsManager.addComment(
                    message.selectedText,
                    message.comment,
                    message.sourceLine,
                    message.contextBefore || '',
                    message.contextAfter || '',
                    message.startOffset ?? -1,
                    message.endOffset ?? -1
                );
                // Optimistic UI: send the new comment back to the webview for instant highlight
                // instead of doing a full re-render
                this.panel.webview.postMessage({
                    command: 'commentAdded',
                    comment: newComment
                });
                return;
            case 'resolveComment':
                this.commentsManager.resolveComment(message.id);
                // Send optimistic update
                this.panel.webview.postMessage({
                    command: 'commentResolved',
                    id: message.id
                });
                return;
            case 'deleteComment':
                this.commentsManager.deleteComment(message.id);
                this.panel.webview.postMessage({
                    command: 'commentDeleted',
                    id: message.id
                });
                return;
            case 'unresolveComment':
                this.commentsManager.unresolveComment(message.id);
                this.panel.webview.postMessage({
                    command: 'commentUnresolved',
                    id: message.id
                });
                return;
        }
    }

    private renderMarkdown(text: string): string {
        const processor = unified()
            .use(remarkParse)
            .use(remarkGfm)
            .use(remarkMath)
            .use(remarkRehype, { allowDangerousHtml: true })
            .use(rehypeRaw)
            .use(rehypeKatex, { throwOnError: false })
            .use(rehypeSourcePositions)
            .use(rehypeStringify, { allowDangerousHtml: true });

        const result = processor.processSync(text);
        let html = String(result);

        // Convert <!--@COMMENT_ID--> anchors into invisible spans with data attributes
        html = html.replace(/<!--@(c\d+)-->/g, '<span class="comment-anchor" data-anchor-id="$1"></span>');

        return html;
    }

    private updateContent() {
        const markdownText = this.document.getText();
        const htmlBody = this.renderMarkdown(markdownText);
        const comments = this.commentsManager.getComments();
        this.panel.webview.html = this.getHtml(htmlBody, comments);
    }

    private getHtml(body: string, comments: Comment[]): string {
        const commentsJson = JSON.stringify(comments).replace(/</g, '\\u003c');
        // KaTeX CSS is loaded from CDN since bundling CSS files is complex with esbuild

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Markdown Review</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
            font-size: 14px;
            line-height: 1.6;
            color: var(--vscode-editor-foreground, #24292e);
            background: var(--vscode-editor-background, #ffffff);
            padding: 20px 40px;
            max-width: 900px;
            margin: 0 auto;
        }
        h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; margin-top: 24px; }
        h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; margin-top: 24px; }
        h3 { font-size: 1.25em; margin-top: 24px; }
        h4 { font-size: 1em; margin-top: 24px; }
        code { background: var(--vscode-textCodeBlock-background, #f6f8fa); padding: 0.2em 0.4em; border-radius: 3px; font-size: 85%; }
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
        .comment-anchor { display: none; } /* Hidden anchor markers */

        /* Comment highlights */
        .comment-highlight {
            background-color: rgba(255, 213, 79, 0.35);
            border-bottom: 2px solid #ffc107;
            cursor: pointer;
        }
        .comment-highlight.resolved {
            background-color: rgba(76, 175, 80, 0.15);
            border-bottom-color: #4caf50;
        }
        .comment-highlight.active {
            background-color: rgba(255, 213, 79, 0.6);
        }

        /* Floating comment popover (shown on click) */
        #comment-popover {
            display: none;
            position: absolute;
            background: var(--vscode-editorWidget-background, #252526);
            color: var(--vscode-editorWidget-foreground, #cccccc);
            border: 1px solid var(--vscode-editorWidget-border, #454545);
            border-radius: 6px;
            padding: 12px 16px;
            min-width: 250px;
            max-width: 400px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            z-index: 1000;
            font-size: 13px;
        }
        #comment-popover .popover-text { white-space: pre-wrap; margin-bottom: 6px; }
        #comment-popover .popover-meta { font-size: 11px; color: #888; margin-bottom: 8px; }
        #comment-popover .popover-actions { display: flex; gap: 6px; }
        #comment-popover button {
            padding: 3px 10px; border: 1px solid #555; background: #333;
            color: #ccc; border-radius: 3px; cursor: pointer; font-size: 11px;
        }
        #comment-popover button:hover { background: #444; }
        #comment-popover button.btn-resolve { border-color: #4caf50; }

        /* Add comment button (floating) */
        #add-comment-btn {
            display: none; position: absolute; background: #0078d4; color: white;
            border: none; border-radius: 4px; padding: 4px 10px; font-size: 12px;
            cursor: pointer; z-index: 999; box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }
        #add-comment-btn:hover { background: #106ebe; }

        /* Comment input dialog */
        #comment-dialog {
            display: none; position: fixed; top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            background: var(--vscode-editorWidget-background, #252526);
            color: var(--vscode-editorWidget-foreground, #cccccc);
            border: 1px solid var(--vscode-editorWidget-border, #454545);
            border-radius: 8px; padding: 20px; min-width: 400px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5); z-index: 2000;
        }
        #comment-dialog h3 { margin: 0 0 8px 0; border: none; font-size: 14px; }
        #comment-dialog .selected-text-preview {
            background: rgba(255, 213, 79, 0.2); padding: 8px; border-radius: 4px;
            margin-bottom: 12px; font-style: italic; max-height: 60px; overflow: auto; font-size: 12px;
        }
        #comment-dialog textarea {
            width: 100%; min-height: 80px; padding: 8px; border: 1px solid #555;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #cccccc);
            border-radius: 4px; font-family: inherit; font-size: 13px;
            resize: vertical; box-sizing: border-box;
        }
        #comment-dialog .dialog-actions { margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; }
        #comment-dialog button { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
        #comment-dialog .btn-primary { background: #0078d4; color: white; }
        #comment-dialog .btn-primary:hover { background: #106ebe; }
        #comment-dialog .btn-cancel { background: #333; color: #ccc; border: 1px solid #555; }

        #dialog-overlay {
            display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.4); z-index: 1999;
        }

        /* Comment badge */
        .comment-count-badge {
            position: fixed; top: 10px; right: 10px; background: #0078d4; color: white;
            border-radius: 12px; padding: 4px 12px; font-size: 12px; z-index: 100; cursor: pointer;
        }
        .comment-count-badge:hover { background: #106ebe; }

        /* Comment list panel */
        #comment-list-panel {
            display: none; position: fixed; top: 0; right: 0; width: 350px; height: 100%;
            background: var(--vscode-editorWidget-background, #1e1e1e);
            border-left: 1px solid var(--vscode-editorWidget-border, #454545);
            box-shadow: -4px 0 12px rgba(0,0,0,0.3); z-index: 1500;
            overflow-y: auto; padding: 0;
        }
        #comment-list-panel .panel-header {
            position: sticky; top: 0; padding: 12px 16px;
            background: var(--vscode-editorWidget-background, #1e1e1e);
            border-bottom: 1px solid #454545; display: flex;
            justify-content: space-between; align-items: center;
        }
        #comment-list-panel .panel-header h3 { margin: 0; font-size: 14px; border: none; }
        #comment-list-panel .panel-close {
            background: none; border: none; color: #ccc; font-size: 18px; cursor: pointer; padding: 0 4px;
        }
        .comment-list-item {
            padding: 12px 16px; border-bottom: 1px solid #333; cursor: pointer;
        }
        .comment-list-item:hover { background: rgba(255,255,255,0.05); }
        .comment-list-item.resolved { opacity: 0.5; }
        .comment-list-item .item-selected-text {
            font-size: 12px; color: #e8a317; margin-bottom: 4px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .comment-list-item .item-comment {
            font-size: 13px; color: var(--vscode-editorWidget-foreground, #ccc);
            white-space: pre-wrap; margin-bottom: 4px;
        }
        .comment-list-item .item-meta { font-size: 11px; color: #888; }
        .comment-list-item .item-actions { margin-top: 6px; display: flex; gap: 6px; }
        .comment-list-item button {
            padding: 2px 8px; border: 1px solid #555; background: #333;
            color: #ccc; border-radius: 3px; cursor: pointer; font-size: 11px;
        }
        .comment-list-item button:hover { background: #444; }
    </style>
</head>
<body>
    <div class="comment-count-badge" id="comment-badge" onclick="toggleCommentList()" style="display:none;">
        &#x1F4AC; <span id="comment-count">0</span> comments
    </div>

    <div id="content">${body}</div>

    <button id="add-comment-btn" onclick="showCommentDialog()">&#x1F4AC; Comment</button>

    <!-- Comment popover (shown on clicking a highlighted comment) -->
    <div id="comment-popover"></div>

    <!-- Comment list panel (slide-out sidebar) -->
    <div id="comment-list-panel">
        <div class="panel-header">
            <h3>&#x1F4AC; Review Comments</h3>
            <button class="panel-close" onclick="toggleCommentList()">&times;</button>
        </div>
        <div id="comment-list-content"></div>
    </div>

    <div id="dialog-overlay" onclick="hideCommentDialog()"></div>
    <div id="comment-dialog">
        <h3>Add Review Comment</h3>
        <div class="selected-text-preview" id="dialog-selected-text"></div>
        <textarea id="comment-input" placeholder="Type your comment..."></textarea>
        <div class="dialog-actions">
            <button class="btn-cancel" onclick="hideCommentDialog()">Cancel</button>
            <button class="btn-primary" onclick="submitComment()">Add Comment</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const comments = ${commentsJson};
        let pendingSelection = { text: '', sourceLine: -1, startOffset: -1, endOffset: -1, contextBefore: '', contextAfter: '' };
        let activePopoverCommentId = null;
        let commentListVisible = false;

        // ---- Comment highlighting ----
        function highlightComments() {
            var badge = document.getElementById('comment-badge');
            var countEl = document.getElementById('comment-count');
            var unresolved = comments.filter(function(c) { return !c.resolved; });
            if (comments.length > 0) {
                badge.style.display = 'block';
                countEl.textContent = unresolved.length + ' / ' + comments.length;
            }
            comments.forEach(function(comment) {
                var highlighted = false;

                // Strategy 1: Find anchor element
                var anchorEl = document.querySelector('[data-anchor-id="' + comment.id + '"]');
                if (anchorEl) {
                    // Find the next text node after the anchor and highlight from there
                    var nextNode = anchorEl.nextSibling;
                    if (nextNode && nextNode.nodeType === 3) {
                        // Text node — highlight the selectedText portion
                        var text = nextNode.textContent || '';
                        var selText = comment.selectedText;
                        var idx = text.indexOf(selText);
                        if (idx !== -1) {
                            var range = document.createRange();
                            range.setStart(nextNode, idx);
                            range.setEnd(nextNode, Math.min(idx + selText.length, text.length));
                            var mark = createHighlightMark(comment);
                            try { range.surroundContents(mark); highlighted = true; } catch(e) {}
                        }
                    }
                    if (!highlighted) {
                        // Anchor exists but text not immediately after — search nearby
                        var parent = anchorEl.parentElement;
                        if (parent) {
                            highlighted = highlightInElement(parent, comment);
                        }
                    }
                }

                // Strategy 2: Fall back to text search in entire content
                if (!highlighted) {
                    highlighted = highlightInElement(document.getElementById('content'), comment);
                }
            });
            buildCommentList();
        }

        function highlightInElement(container, comment) {
            var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
            var node;
            while (node = walker.nextNode()) {
                var idx = node.textContent.indexOf(comment.selectedText);
                if (idx !== -1 && node.parentElement && !node.parentElement.classList.contains('comment-highlight')) {
                    var range = document.createRange();
                    range.setStart(node, idx);
                    range.setEnd(node, Math.min(idx + comment.selectedText.length, node.textContent.length));
                    var mark = createHighlightMark(comment);
                    try { range.surroundContents(mark); return true; } catch(e) {}
                }
            }
            return false;
        }

        function createHighlightMark(comment) {
            var mark = document.createElement('span');
            mark.className = 'comment-highlight' + (comment.resolved ? ' resolved' : '');
            mark.setAttribute('data-comment-id', comment.id);
            mark.addEventListener('click', function(e) {
                e.stopPropagation();
                showCommentPopover(comment, mark);
            });
            return mark;
        }

        // ---- Comment popover (click to show) ----
        function showCommentPopover(comment, anchorEl) {
            var popover = document.getElementById('comment-popover');
            // Remove previous active
            document.querySelectorAll('.comment-highlight.active').forEach(function(el) {
                el.classList.remove('active');
            });
            anchorEl.classList.add('active');

            var resolveBtn = comment.resolved
                ? '<button onclick="unresolveComment(\\''+comment.id+'\\')">Reopen</button>'
                : '<button class="btn-resolve" onclick="resolveComment(\\''+comment.id+'\\')">Resolve</button>';
            popover.innerHTML =
                '<div class="popover-text">' + escapeHtml(comment.comment) + '</div>' +
                '<div class="popover-meta">' + new Date(comment.timestamp).toLocaleString() +
                (comment.resolved ? ' \\u2705 Resolved' : '') + '</div>' +
                '<div class="popover-actions">' + resolveBtn +
                '<button onclick="deleteComment(\\''+comment.id+'\\')">Delete</button></div>';

            var rect = anchorEl.getBoundingClientRect();
            popover.style.top = (rect.bottom + window.scrollY + 5) + 'px';
            popover.style.left = (rect.left + window.scrollX) + 'px';
            popover.style.display = 'block';
            activePopoverCommentId = comment.id;
        }

        // Hide popover when clicking elsewhere
        document.addEventListener('click', function(e) {
            var popover = document.getElementById('comment-popover');
            if (popover.style.display === 'block' && !popover.contains(e.target) &&
                !e.target.classList.contains('comment-highlight')) {
                popover.style.display = 'none';
                document.querySelectorAll('.comment-highlight.active').forEach(function(el) {
                    el.classList.remove('active');
                });
                activePopoverCommentId = null;
            }
        });

        // ---- Comment list panel ----
        function buildCommentList() {
            var container = document.getElementById('comment-list-content');
            container.innerHTML = '';
            if (comments.length === 0) {
                container.innerHTML = '<div style="padding:20px;color:#888;text-align:center;">No comments yet</div>';
                return;
            }
            comments.forEach(function(comment) {
                var div = document.createElement('div');
                div.className = 'comment-list-item' + (comment.resolved ? ' resolved' : '');
                var resolveBtn = comment.resolved
                    ? '<button onclick="event.stopPropagation();unresolveComment(\\''+comment.id+'\\')">Reopen</button>'
                    : '<button onclick="event.stopPropagation();resolveComment(\\''+comment.id+'\\')">Resolve</button>';
                div.innerHTML =
                    '<div class="item-selected-text">"' + escapeHtml(comment.selectedText.substring(0, 80)) + '"</div>' +
                    '<div class="item-comment">' + escapeHtml(comment.comment) + '</div>' +
                    '<div class="item-meta">' + new Date(comment.timestamp).toLocaleString() +
                    (comment.resolved ? ' \\u2705' : '') + '</div>' +
                    '<div class="item-actions">' + resolveBtn +
                    '<button onclick="event.stopPropagation();deleteComment(\\''+comment.id+'\\')">Delete</button></div>';
                div.addEventListener('click', function() {
                    // Scroll to the highlighted text in the preview
                    var highlight = document.querySelector('[data-comment-id="'+comment.id+'"]');
                    if (highlight) {
                        highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        highlight.classList.add('active');
                        setTimeout(function() { highlight.classList.remove('active'); }, 2000);
                    }
                });
                container.appendChild(div);
            });
        }

        function toggleCommentList() {
            var panel = document.getElementById('comment-list-panel');
            commentListVisible = !commentListVisible;
            panel.style.display = commentListVisible ? 'block' : 'none';
        }

        function escapeHtml(text) {
            var div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // ---- Text selection -> Comment button ----
        document.addEventListener('mouseup', function(e) {
            var btn = document.getElementById('add-comment-btn');
            if (e.target.closest('#comment-dialog') || e.target.closest('#comment-list-panel') ||
                e.target.closest('#comment-popover') || e.target.closest('.comment-highlight')) {
                return;
            }
            var selection = window.getSelection();
            if (!selection || selection.isCollapsed || selection.toString().trim().length === 0) {
                setTimeout(function() { btn.style.display = 'none'; }, 200);
                return;
            }
            var text = selection.toString().trim();
            if (text.length > 0 && text.length < 500) {
                // Find the nearest element with source position data
                var startOffset = -1, endOffset = -1, sourceLine = -1;
                var el = selection.anchorNode;
                while (el && el !== document.body) {
                    if (el.nodeType === 1) {
                        var ds = el.dataset;
                        if (ds && ds.startOffset) {
                            startOffset = parseInt(ds.startOffset);
                            endOffset = parseInt(ds.endOffset || '-1');
                            sourceLine = parseInt(ds.startLine || '-1');
                            break;
                        }
                    }
                    el = el.parentElement;
                }
                pendingSelection = {
                    text: text,
                    sourceLine: sourceLine,
                    startOffset: startOffset,
                    endOffset: endOffset,
                    contextBefore: '',
                    contextAfter: ''
                };

                // Capture surrounding text context
                try {
                    var container = selection.anchorNode;
                    var blockEl = container;
                    while (blockEl && blockEl.nodeType !== 1) blockEl = blockEl.parentNode;
                    while (blockEl && !(blockEl.dataset && blockEl.dataset.startOffset) && blockEl !== document.getElementById('content')) blockEl = blockEl.parentElement;
                    if (blockEl) {
                        var fullText = blockEl.textContent || '';
                        var selIdx = fullText.indexOf(text);
                        if (selIdx !== -1) {
                            pendingSelection.contextBefore = fullText.substring(Math.max(0, selIdx - 80), selIdx);
                            pendingSelection.contextAfter = fullText.substring(selIdx + text.length, selIdx + text.length + 80);
                        }
                    }
                } catch(ctxErr) {}
                var rect = selection.getRangeAt(0).getBoundingClientRect();
                btn.style.top = (rect.top + window.scrollY - 30) + 'px';
                btn.style.left = (rect.left + window.scrollX) + 'px';
                btn.style.display = 'block';
            }
        });

        function showCommentDialog() {
            document.getElementById('add-comment-btn').style.display = 'none';
            document.getElementById('dialog-selected-text').textContent = '"' + pendingSelection.text + '"';
            document.getElementById('comment-input').value = '';
            document.getElementById('comment-dialog').style.display = 'block';
            document.getElementById('dialog-overlay').style.display = 'block';
            document.getElementById('comment-input').focus();
        }
        function hideCommentDialog() {
            document.getElementById('comment-dialog').style.display = 'none';
            document.getElementById('dialog-overlay').style.display = 'none';
        }
        function submitComment() {
            var commentText = document.getElementById('comment-input').value.trim();
            if (!commentText) return;
            vscode.postMessage({
                command: 'addComment',
                selectedText: pendingSelection.text,
                comment: commentText,
                sourceLine: pendingSelection.sourceLine,
                startOffset: pendingSelection.startOffset,
                endOffset: pendingSelection.endOffset,
                contextBefore: pendingSelection.contextBefore,
                contextAfter: pendingSelection.contextAfter
            });
            hideCommentDialog();
        }
        document.getElementById('comment-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { submitComment(); }
        });
        function resolveComment(id) { vscode.postMessage({ command: 'resolveComment', id: id }); }
        function deleteComment(id) { vscode.postMessage({ command: 'deleteComment', id: id }); }
        function unresolveComment(id) { vscode.postMessage({ command: 'unresolveComment', id: id }); }

        // Handle optimistic UI updates from extension host
        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (!msg || !msg.command) return;

            switch (msg.command) {
                case 'commentAdded':
                    // Instantly highlight the new comment without full re-render
                    var c = msg.comment;
                    comments.push(c);
                    highlightInElement(document.getElementById('content'), c);
                    updateBadge();
                    buildCommentList();
                    break;
                case 'commentResolved':
                    var mark = document.querySelector('[data-comment-id="' + msg.id + '"]');
                    if (mark) mark.classList.add('resolved');
                    var ci = comments.find(function(x) { return x.id === msg.id; });
                    if (ci) ci.resolved = true;
                    updateBadge();
                    buildCommentList();
                    // Hide popover
                    document.getElementById('comment-popover').style.display = 'none';
                    break;
                case 'commentDeleted':
                    var mark = document.querySelector('[data-comment-id="' + msg.id + '"]');
                    if (mark) {
                        // Unwrap the highlight span
                        var parent = mark.parentNode;
                        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
                        parent.removeChild(mark);
                    }
                    comments = comments.filter(function(x) { return x.id !== msg.id; });
                    updateBadge();
                    buildCommentList();
                    document.getElementById('comment-popover').style.display = 'none';
                    break;
                case 'commentUnresolved':
                    var mark = document.querySelector('[data-comment-id="' + msg.id + '"]');
                    if (mark) mark.classList.remove('resolved');
                    var ci = comments.find(function(x) { return x.id === msg.id; });
                    if (ci) ci.resolved = false;
                    updateBadge();
                    buildCommentList();
                    document.getElementById('comment-popover').style.display = 'none';
                    break;
            }
        });

        function updateBadge() {
            var badge = document.getElementById('comment-badge');
            var countEl = document.getElementById('comment-count');
            var unresolved = comments.filter(function(c) { return !c.resolved; });
            if (comments.length > 0) {
                badge.style.display = 'block';
                countEl.textContent = unresolved.length + ' / ' + comments.length;
            } else {
                badge.style.display = 'none';
            }
        }

        // Initialize
        highlightComments();
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
