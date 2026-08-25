import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { commentUiCss, commentUiJs, sidebarHtml, buildBatchPromptText, buildSinglePrompt } from '../../src/comment-ui';
import { renderMarkdownDocument } from '../../src/markdown-render';
import {
    addComment,
    addReply,
    deleteComment,
    deleteReply,
    deleteResolved,
    editComment,
    editReply,
    getCommentsPath,
    listComments,
    resolveAll,
    resolveMarkdownPath,
    setResolved,
} from './review-store';

interface CanvasDependencies {
    sendPrompt?: (prompt: string) => Promise<PromptDeliveryResult | unknown> | PromptDeliveryResult | unknown;
    log?: (message: string, options?: object) => void;
}

interface PromptDeliveryResult {
    delivered: boolean;
    reason?: 'empty-session';
}

export interface CanvasRecord extends CanvasDependencies {
    instanceId: string;
    workingDirectory?: string;
    filePath: string | null;
    directPromptAvailable: boolean;
    token: string;
    url: string;
    server: http.Server;
    clients: Set<http.ServerResponse>;
    watcher: fs.FSWatcher | null;
    watchTimer: ReturnType<typeof setTimeout> | null;
    broadcast: (payload: object) => void;
}

interface CreateInstanceOptions extends CanvasDependencies {
    instanceId: string;
    filePath: string | null;
    workingDirectory?: string;
    directPromptAvailable?: boolean;
}

function resolveCanvasPath(filePathInput: string, workingDirectory?: string): string {
    const candidate = path.isAbsolute(filePathInput)
        ? filePathInput
        : path.resolve(workingDirectory || process.cwd(), filePathInput);
    return resolveMarkdownPath(candidate);
}

export function resolveInitialMarkdownPath(filePathInput?: string, workingDirectory?: string): string | null {
    if (filePathInput?.trim()) {
        return resolveCanvasPath(filePathInput.trim(), workingDirectory);
    }
    if (!workingDirectory) {
        return null;
    }
    if (path.extname(workingDirectory).toLowerCase() === '.md' && fs.existsSync(workingDirectory)) {
        return resolveMarkdownPath(workingDirectory);
    }
    const readmePath = path.join(workingDirectory, 'README.md');
    return fs.existsSync(readmePath) ? resolveMarkdownPath(readmePath) : null;
}

function liveCommentOffsets(
    comments: any[],
    blocks: ReturnType<typeof renderMarkdownDocument>['blocks'],
    anchorMap: Map<string, number>,
): any[] {
    return comments.map(comment => {
        const anchorOffset = anchorMap.get(comment.id);
        if (anchorOffset === undefined) {
            return comment;
        }
        const block = blocks.find(candidate => candidate.type === comment.blockType && candidate.startOffset >= anchorOffset)
            || blocks.find(candidate => candidate.startOffset >= anchorOffset);
        return block
            ? { ...comment, startOffset: block.startOffset, endOffset: block.endOffset, blockPreview: block.preview }
            : comment;
    });
}

function rewriteImageSources(html: string, filePath: string, token: string): string {
    return html.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (match, before, source, after) => {
        if (/^(?:[a-z]+:|#|\/\/)/i.test(source)) {
            return match;
        }
        const sourcePath = source.split(/[?#]/, 1)[0];
        const absolutePath = path.resolve(path.dirname(filePath), decodeURIComponent(sourcePath));
        return `${before}/asset?token=${encodeURIComponent(token)}&path=${encodeURIComponent(absolutePath)}${after}`;
    });
}

export function buildCanvasState(record: Pick<CanvasRecord, 'filePath' | 'token' | 'directPromptAvailable'>): any {
    if (!record.filePath) {
        return {
            ok: false,
            needsFile: true,
            filePath: '',
            directPromptAvailable: record.directPromptAvailable,
            error: 'Choose a local Markdown file to begin reviewing.',
        };
    }
    try {
        const markdown = fs.readFileSync(record.filePath, 'utf8');
        const rendered = renderMarkdownDocument(markdown);
        const snapshot = listComments(record.filePath);
        return {
            ok: true,
            filePath: record.filePath,
            fileName: path.basename(record.filePath),
            html: rewriteImageSources(rendered.html, record.filePath, record.token),
            blocks: rendered.blocks,
            comments: liveCommentOffsets(snapshot.comments, rendered.blocks, rendered.anchorMap),
            directPromptAvailable: record.directPromptAvailable,
        };
    } catch (error: any) {
        return {
            ok: false,
            needsFile: true,
            filePath: record.filePath,
            directPromptAvailable: record.directPromptAvailable,
            error: error?.message || String(error),
        };
    }
}

function promptConfig(filePath: string) {
    return {
        format: 'markdown' as const,
        filePath,
        fileName: path.basename(filePath),
        toolPrefix: '#',
        toolStyle: 'mcp' as const,
    };
}

function requireFile(record: CanvasRecord): string {
    if (!record.filePath) {
        throw new Error('Choose a Markdown file first.');
    }
    return record.filePath;
}

async function deliverPrompt(record: CanvasRecord, prompt: string): Promise<{
    message: string;
    manualCopyText?: string;
}> {
    if (!record.sendPrompt) {
        throw new Error('This Copilot session cannot receive prompts from the canvas.');
    }
    const result = await record.sendPrompt(prompt);
    if (result && typeof result === 'object' && 'delivered' in result && !result.delivered) {
        return {
            message: 'Prompt ready. Copy it from the panel, then paste it into chat to start this conversation.',
            manualCopyText: prompt,
        };
    }
    return { message: 'Prompt sent to Copilot.' };
}

export async function dispatchCanvasAction(record: CanvasRecord, message: any): Promise<any> {
    const command = typeof message?.command === 'string' ? message.command : '';
    if (!command) {
        throw new Error('Missing canvas action command.');
    }
    if (command === 'openFile') {
        setCanvasFile(record, String(message.filePath || ''));
        return { ok: true, message: 'Markdown file opened.', state: buildCanvasState(record) };
    }
    if (command === 'refresh') {
        return { ok: true, message: 'Review refreshed.', state: buildCanvasState(record) };
    }

    const filePath = requireFile(record);
    switch (command) {
        case 'addComment':
            addComment(filePath, message.startOffset, message.comment);
            return { ok: true, message: 'Comment added.', state: buildCanvasState(record) };
        case 'addCommentAndAsk': {
            const snapshot = addComment(filePath, message.startOffset, message.comment);
            const comment = snapshot.comments[snapshot.comments.length - 1];
            const delivery = await deliverPrompt(record, buildSinglePrompt(promptConfig(filePath), comment, 'new'));
            return {
                ok: true,
                message: delivery.manualCopyText ? delivery.message : 'Comment added and sent to Copilot.',
                manualCopyText: delivery.manualCopyText,
                state: buildCanvasState(record),
            };
        }
        case 'addCommentAndCopyPrompt': {
            const snapshot = addComment(filePath, message.startOffset, message.comment);
            const comment = snapshot.comments[snapshot.comments.length - 1];
            return {
                ok: true,
                message: 'Comment added and prompt copied.',
                clipboardText: buildSinglePrompt(promptConfig(filePath), comment, 'new'),
                state: buildCanvasState(record),
            };
        }
        case 'resolveComment':
            setResolved(filePath, message.id, true);
            return { ok: true, message: 'Comment resolved.', state: buildCanvasState(record) };
        case 'unresolveComment':
            setResolved(filePath, message.id, false);
            return { ok: true, message: 'Comment reopened.', state: buildCanvasState(record) };
        case 'deleteComment':
            deleteComment(filePath, message.id);
            return { ok: true, message: 'Comment deleted.', state: buildCanvasState(record) };
        case 'replyComment':
            addReply(filePath, message.id, message.text, 'user');
            return { ok: true, message: 'Reply added.', state: buildCanvasState(record) };
        case 'editComment':
            editComment(filePath, message.id, message.text);
            return { ok: true, message: 'Comment updated.', state: buildCanvasState(record) };
        case 'editReply':
            editReply(filePath, message.commentId, message.replyId, message.text);
            return { ok: true, message: 'Reply updated.', state: buildCanvasState(record) };
        case 'deleteReply':
            deleteReply(filePath, message.commentId, message.replyId);
            return { ok: true, message: 'Reply deleted.', state: buildCanvasState(record) };
        case 'resolveAll':
            resolveAll(filePath);
            return { ok: true, message: 'All comments resolved.', state: buildCanvasState(record) };
        case 'deleteAllResolved':
            deleteResolved(filePath);
            return { ok: true, message: 'Resolved comments deleted.', state: buildCanvasState(record) };
        case 'askCopilotThread':
        case 'copyPromptThread': {
            const snapshot = listComments(filePath);
            const comment = snapshot.comments.find(candidate => candidate.id === message.id);
            if (!comment) {
                throw new Error(`Review comment not found: ${message.id}`);
            }
            const prompt = buildSinglePrompt(promptConfig(filePath), comment, 'thread');
            if (command === 'askCopilotThread') {
                const delivery = await deliverPrompt(record, prompt);
                return {
                    ok: true,
                    message: delivery.manualCopyText ? delivery.message : 'Comment thread sent to Copilot.',
                    manualCopyText: delivery.manualCopyText,
                };
            }
            return { ok: true, message: 'Prompt copied.', clipboardText: prompt };
        }
        case 'sendAllToCopilot':
        case 'copyAllToClipboard': {
            const comments = listComments(filePath).comments.filter(comment => !comment.resolved);
            if (comments.length === 0) {
                throw new Error('There are no open comments.');
            }
            const prompt = buildBatchPromptText(promptConfig(filePath), comments);
            if (command === 'sendAllToCopilot') {
                const delivery = await deliverPrompt(record, prompt);
                return {
                    ok: true,
                    message: delivery.manualCopyText ? delivery.message : 'Open comments sent to Copilot.',
                    manualCopyText: delivery.manualCopyText,
                };
            }
            return { ok: true, message: 'Prompt copied.', clipboardText: prompt };
        }
        default:
            throw new Error(`Unknown canvas action: ${command}`);
    }
}

function renderCanvasHtml(token: string): string {
    const boot = JSON.stringify({ token }).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Markdown Review</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<style>
:root {
    color-scheme: light dark;
    --vscode-foreground: var(--text-color-default, #1f2328);
    --vscode-descriptionForeground: var(--text-color-muted, #59636e);
    --vscode-editor-background: var(--background-color-default, #fff);
    --vscode-editorWidget-background: var(--background-color-default, #fff);
    --vscode-editorWidget-foreground: var(--text-color-default, #1f2328);
    --vscode-editorWidget-border: var(--border-color-default, #d1d9e0);
    --vscode-sideBar-background: var(--background-color-default, #fff);
    --vscode-sideBar-foreground: var(--text-color-default, #1f2328);
    --vscode-sideBar-border: var(--border-color-default, #d1d9e0);
    --vscode-input-background: var(--background-color-muted, #f6f8fa);
    --vscode-input-foreground: var(--text-color-default, #1f2328);
    --vscode-input-border: var(--border-color-default, #d1d9e0);
    --vscode-button-background: var(--true-color-blue, #0969da);
    --vscode-button-foreground: #fff;
    --vscode-button-secondaryBackground: var(--background-color-muted, #f6f8fa);
    --vscode-button-secondaryForeground: var(--text-color-default, #1f2328);
    --vscode-list-hoverBackground: var(--background-color-muted, #f6f8fa);
    --vscode-toolbar-hoverBackground: var(--background-color-muted, #f6f8fa);
    --vscode-textCodeBlock-background: var(--background-color-muted, #f6f8fa);
    --vscode-textBlockQuote-background: var(--background-color-muted, #f6f8fa);
    --vscode-textBlockQuote-border: var(--border-color-default, #d1d9e0);
    --vscode-editorWarning-foreground: var(--true-color-orange, #9a6700);
    --vscode-icon-foreground: var(--text-color-muted, #59636e);
    --vscode-badge-background: var(--background-color-muted, #f6f8fa);
    --vscode-badge-foreground: var(--text-color-default, #1f2328);
    --vscode-charts-blue: var(--true-color-blue, #0969da);
    --vscode-charts-purple: #8250df;
    --vscode-widget-shadow: rgba(31, 35, 40, .18);
}
* { box-sizing: border-box; }
html, body { min-height: 100%; }
body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); font-size: 14px; line-height: 1.6; }
#toolbar { position: sticky; top: 0; z-index: 1000; min-height: 46px; display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-editorWidget-border); }
#toolbar strong { white-space: nowrap; font-size: 13px; }
#file-path { min-width: 100px; flex: 1; height: 30px; padding: 0 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
button { font: inherit; }
.toolbar-button { min-height: 30px; padding: 0 10px; color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; cursor: pointer; white-space: nowrap; }
.toolbar-button:hover { background: var(--vscode-toolbar-hoverBackground); }
.toolbar-button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
#status { display: none; margin: 12px auto 0; max-width: 820px; padding: 8px 12px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; }
#wrapper { position: relative; max-width: 900px; margin: 0 auto; padding: 28px 28px 80px 48px; }
#gutter { position: absolute; inset: 28px auto 80px 8px; width: 28px; }
#content { min-width: 0; }
#content h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid var(--vscode-editorWidget-border); }
#content h2 { margin-top: 28px; font-size: 1.5em; padding-bottom: .3em; border-bottom: 1px solid var(--vscode-editorWidget-border); }
#content h3 { margin-top: 26px; font-size: 1.25em; }
#content code { padding: .15em .35em; background: var(--vscode-textCodeBlock-background); border-radius: 3px; font-size: 85%; }
#content pre { max-width: 100%; padding: 16px; overflow: auto; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; }
#content pre code { padding: 0; background: none; }
#content blockquote { margin-left: 0; padding: 2px 14px; color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); border-left: 2px solid var(--vscode-textBlockQuote-border); }
#content table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
#content th, #content td { padding: 6px 13px; border: 1px solid var(--vscode-editorWidget-border); }
#content img { max-width: 100%; }
.gutter-btn { position: absolute; left: 0; width: 26px; height: 26px; padding: 0; color: var(--vscode-icon-foreground); background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; opacity: .35; }
.gutter-btn:hover, .gutter-btn:focus-visible { opacity: 1; color: var(--vscode-button-background); background: var(--vscode-toolbar-hoverBackground); }
.commented-block { padding-left: 12px; border-left: 2px solid var(--vscode-editorWarning-foreground); cursor: pointer; }
.commented-block:hover { background: var(--vscode-list-hoverBackground); }
#comment-list-panel { display: none; position: fixed; inset: 46px 0 0 auto; z-index: 1500; width: min(400px, 94vw); overflow-y: auto; color: var(--vscode-sideBar-foreground); background: var(--vscode-sideBar-background); border-left: 1px solid var(--vscode-sideBar-border); box-shadow: -6px 0 18px var(--vscode-widget-shadow); }
.panel-hdr { position: sticky; top: 0; z-index: 2; height: 42px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px 0 16px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-sideBar-border); }
.panel-hdr h3 { margin: 0; font-size: 13px; }
.panel-close { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 18px; }
#comment-list-panel .panel-toolbar { position: sticky; top: 42px; z-index: 1; padding: 12px 16px !important; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-sideBar-border); }
.panel-filters button, .panel-bulk button { min-height: 26px; padding: 0 8px; color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; cursor: pointer; }
#dialog-overlay { display: none; position: fixed; inset: 0; z-index: 1999; background: rgba(0,0,0,.4); }
#comment-dialog { display: none; position: fixed; top: 50%; left: 50%; z-index: 2000; width: min(500px, 92vw); padding: 20px; transform: translate(-50%, -50%); background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; box-shadow: 0 8px 24px var(--vscode-widget-shadow); }
#comment-dialog h3 { margin: 0 0 8px; }
.preview-text { max-height: 70px; margin-bottom: 10px; padding: 8px; overflow: auto; color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); border-left: 2px solid var(--vscode-textBlockQuote-border); }
#dlg-input { width: 100%; min-height: 88px; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 3px; resize: vertical; }
.dlg-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.dlg-actions button { min-height: 30px; padding: 0 10px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; cursor: pointer; }
#toast { position: fixed; bottom: 18px; left: 50%; z-index: 3000; max-width: 90%; padding: 8px 14px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-radius: 4px; transform: translateX(-50%); opacity: 0; pointer-events: none; transition: opacity .15s; }
#toast.show { opacity: 1; }
#manual-copy-overlay { display: none; position: fixed; inset: 0; z-index: 3500; place-items: center; padding: 16px; background: rgba(0,0,0,.48); }
#manual-copy-overlay.open { display: grid; }
.manual-copy-dialog { width: min(680px, 96vw); max-height: min(720px, 90vh); display: flex; flex-direction: column; gap: 10px; padding: 18px; color: var(--vscode-editorWidget-foreground); background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; box-shadow: 0 12px 36px var(--vscode-widget-shadow); }
.manual-copy-dialog h3 { margin: 0; font-size: 15px; }
.manual-copy-dialog p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
#manual-copy-text { width: 100%; min-height: 260px; flex: 1; padding: 10px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; font: 12px/1.5 var(--font-mono, Consolas, monospace); }
.manual-copy-actions { display: flex; justify-content: flex-end; gap: 8px; }
.manual-copy-actions button { min-height: 30px; padding: 0 11px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; cursor: pointer; }
${commentUiCss()}
@media (max-width: 620px) {
    #toolbar strong { display: none; }
    #file-path { min-width: 0; }
    .toolbar-button { padding: 0 7px; font-size: 12px; }
    #comment-badge span:first-child { display: none; }
    #wrapper { padding-right: 16px; padding-left: 42px; }
}
</style>
</head>
<body>
<header id="toolbar">
    <strong>Markdown Review</strong>
    <input id="file-path" type="text" placeholder="Absolute or workspace-relative .md path" aria-label="Markdown file path">
    <button id="open-file" class="toolbar-button primary">Open</button>
    <button id="refresh" class="toolbar-button" title="Refresh review">Refresh</button>
    <button id="comment-badge" class="toolbar-button" onclick="togglePanel()" aria-label="Review comments"><span>Comments </span><span id="badge-count">0</span></button>
</header>
<div id="status" role="status"></div>
<main id="wrapper"><div id="gutter"></div><article id="content"></article></main>
<div id="comment-popover"></div>
<aside id="comment-list-panel">
    <div class="panel-hdr"><h3>Review comments</h3><button class="panel-close" onclick="togglePanel()" aria-label="Close review comments">×</button></div>
    ${sidebarHtml({ containerId: 'comment-list-body', toggleFn: 'togglePanel', filters: ['all', 'open', 'resolved', 'user', 'agent'], canSendPrompt: true })}
</aside>
<div id="dialog-overlay" onclick="hideDialog()"></div>
<div id="comment-dialog">
    <h3>Add Review Comment</h3>
    <div class="preview-text" id="dlg-preview"></div>
    <textarea id="dlg-input" placeholder="Type your comment..."></textarea>
    <div class="dlg-actions">
        <button onclick="hideDialog()">Cancel</button>
        <button class="btn-primary" onclick="submitComment()">Add Comment</button>
        <button id="new-comment-prompt" class="btn-primary btn-copilot" onclick="submitCommentAndAsk()">Ask Copilot</button>
        <button class="btn-primary" onclick="submitCommentAndCopyPrompt()">Copy Prompt</button>
    </div>
</div>
<div id="toast" role="status" aria-live="polite"></div>
<div id="manual-copy-overlay" role="dialog" aria-modal="true" aria-labelledby="manual-copy-title">
    <div class="manual-copy-dialog">
        <h3 id="manual-copy-title">Start the conversation</h3>
        <p>Canvas cannot prefill an untouched chat. Copy this prompt, paste it into chat, and send it as the first message.</p>
        <textarea id="manual-copy-text" readonly aria-label="Review prompt"></textarea>
        <div class="manual-copy-actions">
            <button onclick="hideManualCopy()">Close</button>
            <button class="btn-primary" onclick="copyManualPrompt()">Copy Prompt</button>
        </div>
    </div>
</div>
<script>
var boot = ${boot};
var blocks = [];
var comments = [];
var pendingBlock = null;
var panelVisible = false;
var directPromptAvailable = true;
var bridgeState = {};
try { bridgeState = JSON.parse(sessionStorage.getItem('markdown-review-state') || '{}'); } catch (e) {}
var actionQueue = Promise.resolve();
var vscode = {
    postMessage: function(message) {
        if ((message.command === 'deleteComment' && !confirm('Delete this comment and all its replies?')) ||
            (message.command === 'deleteReply' && !confirm('Delete this reply?')) ||
            (message.command === 'resolveAll' && !confirm('Resolve all open comments?')) ||
            (message.command === 'deleteAllResolved' && !confirm('Delete all resolved comments and their anchors?'))) return;
        actionQueue = actionQueue.then(function() { return performAction(message); });
    },
    getState: function() { return bridgeState; },
    setState: function(value) { bridgeState = value || {}; sessionStorage.setItem('markdown-review-state', JSON.stringify(bridgeState)); }
};
var __nativePrefix = '';
var __nativeSource = '';
${commentUiJs({ canSendPrompt: true })}

function endpoint(route) {
    var url = new URL(route, location.origin);
    url.searchParams.set('token', boot.token);
    return url.toString();
}
function toast(message, isError) {
    var element = document.getElementById('toast');
    element.textContent = message;
    element.style.background = isError ? 'var(--true-color-red, #cf222e)' : 'var(--vscode-button-background)';
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function() { element.classList.remove('show'); }, 2600);
}
async function copyText(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (error) {
        // Restricted WebViews may expose Clipboard but deny write permission.
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try { copied = document.execCommand('copy'); } catch (error) {}
    area.remove();
    return copied;
}
function showManualCopy(text) {
    var overlay = document.getElementById('manual-copy-overlay');
    var input = document.getElementById('manual-copy-text');
    input.value = text;
    overlay.classList.add('open');
    input.focus();
    input.select();
}
window.hideManualCopy = function() {
    document.getElementById('manual-copy-overlay').classList.remove('open');
};
window.copyManualPrompt = async function() {
    var input = document.getElementById('manual-copy-text');
    if (await copyText(input.value)) {
        hideManualCopy();
        toast('Prompt copied. Paste it into chat.', false);
        return;
    }
    input.focus();
    input.select();
    toast('Clipboard permission is blocked. Press Ctrl+C, then paste into chat.', true);
}
async function performAction(message) {
    try {
        var response = await fetch(endpoint('/action'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message)
        });
        var result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'Action failed.');
        if (result.manualCopyText) {
            showManualCopy(result.manualCopyText);
        } else if (result.clipboardText && !(await copyText(result.clipboardText))) {
            showManualCopy(result.clipboardText);
        }
        if (result.state) renderState(result.state);
        if (result.message) toast(result.message, false);
    } catch (error) {
        toast(error && error.message ? error.message : String(error), true);
    }
}
async function loadState() {
    try {
        var response = await fetch(endpoint('/state'));
        var state = await response.json();
        renderState(state);
    } catch (error) {
        renderState({ ok: false, error: error && error.message ? error.message : String(error) });
    }
}
function renderState(state) {
    var status = document.getElementById('status');
    var wrapper = document.getElementById('wrapper');
    if (state.filePath) document.getElementById('file-path').value = state.filePath;
    directPromptAvailable = state.directPromptAvailable !== false;
    if (!state.ok) {
        status.textContent = state.error || 'Choose a Markdown file.';
        status.style.display = 'block';
        wrapper.style.display = 'none';
        comments = [];
        updateBadge();
        buildList();
        updatePromptActionLabels();
        return;
    }
    status.style.display = 'none';
    wrapper.style.display = 'block';
    document.getElementById('content').innerHTML = state.html;
    blocks = state.blocks || [];
    comments = state.comments || [];
    placeGutterButtons();
    highlightComments();
    attachCommentClicks();
    updateBadge();
    buildList();
    updatePromptActionLabels();
}
function updatePromptActionLabels() {
    document.querySelectorAll('button[onclick*="askCopilotThread"], #new-comment-prompt').forEach(function(button) {
        button.textContent = directPromptAvailable ? 'Ask Copilot' : 'Copy to Start Chat';
        button.title = directPromptAvailable
            ? 'Send this review prompt to the current conversation'
            : 'Copy this prompt, then paste it as the first chat message';
    });
    document.querySelectorAll('button[onclick*="sendAllToCopilot"]').forEach(function(button) {
        button.textContent = directPromptAvailable ? 'Send All to Copilot' : 'Copy All to Start Chat';
        button.title = directPromptAvailable
            ? 'Send all open comments to the current conversation'
            : 'Copy all open comments, then paste them as the first chat message';
    });
}
function findElement(block) {
    return document.querySelector('[data-start-offset="' + block.startOffset + '"]');
}
function findCommentElement(comment) {
    return document.querySelector('[data-start-offset="' + comment.startOffset + '"]');
}
function placeGutterButtons() {
    var gutter = document.getElementById('gutter');
    gutter.innerHTML = '';
    blocks.forEach(function(block) {
        var element = findElement(block);
        if (!element) return;
        var button = document.createElement('button');
        button.className = 'gutter-btn';
        button.textContent = '+';
        button.title = 'Add comment to ' + block.type;
        button.setAttribute('aria-label', button.title);
        button.style.top = (element.offsetTop - document.getElementById('content').offsetTop) + 'px';
        button.onclick = function(event) {
            event.stopPropagation();
            pendingBlock = block;
            document.getElementById('dlg-preview').textContent = block.preview;
            document.getElementById('dlg-input').value = '';
            document.getElementById('comment-dialog').style.display = 'block';
            document.getElementById('dialog-overlay').style.display = 'block';
            document.getElementById('dlg-input').focus();
        };
        gutter.appendChild(button);
    });
}
function highlightComments() {
    document.querySelectorAll('.commented-block').forEach(function(element) {
        element.classList.remove('commented-block');
        element.removeAttribute('data-comment-id');
    });
    comments.filter(function(comment) { return !comment.resolved; }).forEach(function(comment) {
        var element = findCommentElement(comment);
        if (!element) return;
        element.classList.add('commented-block');
        if (!element.getAttribute('data-comment-id')) element.setAttribute('data-comment-id', comment.id);
    });
}
function attachCommentClicks() {
    document.querySelectorAll('.commented-block').forEach(function(element) {
        element.onclick = function(event) {
            event.stopPropagation();
            var comment = comments.find(function(candidate) { return candidate.id === element.getAttribute('data-comment-id'); });
            if (comment) {
                window.showPopover(comment, element);
                updatePromptActionLabels();
            }
        };
    });
}
window.hideDialog = function() {
    document.getElementById('comment-dialog').style.display = 'none';
    document.getElementById('dialog-overlay').style.display = 'none';
};
function submitNewComment(command) {
    var text = document.getElementById('dlg-input').value.trim();
    if (!text || !pendingBlock) return;
    vscode.postMessage({ command: command, startOffset: pendingBlock.startOffset, comment: text });
    hideDialog();
}
window.submitComment = function() { submitNewComment('addComment'); };
window.submitCommentAndAsk = function() { submitNewComment('addCommentAndAsk'); };
window.submitCommentAndCopyPrompt = function() { submitNewComment('addCommentAndCopyPrompt'); };
window.togglePanel = function() {
    panelVisible = !panelVisible;
    document.getElementById('comment-list-panel').style.display = panelVisible ? 'block' : 'none';
    if (panelVisible) buildList();
    _saveState();
};
window.__onListItemClick = function(comment) {
    var element = findCommentElement(comment);
    if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
};
window.__findAnchorForComment = findCommentElement;
window.__onCommentChange = function() { highlightComments(); attachCommentClicks(); };
document.getElementById('open-file').onclick = function() {
    vscode.postMessage({ command: 'openFile', filePath: document.getElementById('file-path').value.trim() });
};
document.getElementById('refresh').onclick = function() { vscode.postMessage({ command: 'refresh' }); };
document.getElementById('file-path').onkeydown = function(event) {
    if (event.key === 'Enter') document.getElementById('open-file').click();
};
document.addEventListener('click', function(event) {
    var popover = document.getElementById('comment-popover');
    if (popover.style.display === 'block' && !popover.contains(event.target) && !event.target.closest('.commented-block')) {
        popover.style.display = 'none';
    }
});
document.getElementById('manual-copy-overlay').addEventListener('click', function(event) {
    if (event.target === event.currentTarget) hideManualCopy();
});
window.addEventListener('resize', placeGutterButtons);
try {
    var events = new EventSource(endpoint('/events'));
    events.onmessage = function() { loadState(); };
} catch (error) {}
loadState().then(function() { _restoreState(); });
</script>
</body>
</html>`;
}

function contentType(filePath: string): string {
    const types: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
    };
    return types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function readRequestBody(request: http.IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        request.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('Request body is too large.'));
                request.destroy();
                return;
            }
            body += chunk;
        });
        request.on('end', () => resolve(body));
        request.on('error', reject);
    });
}

export function makeCanvasHandler(record: CanvasRecord): http.RequestListener {
    return (request, response) => {
        void (async () => {
            const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            if (requestUrl.searchParams.get('token') !== record.token) {
                response.writeHead(403, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ ok: false, error: 'Forbidden.' }));
                return;
            }
            if (request.method === 'GET' && requestUrl.pathname === '/') {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                response.end(renderCanvasHtml(record.token));
                return;
            }
            if (request.method === 'GET' && requestUrl.pathname === '/state') {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(buildCanvasState(record)));
                return;
            }
            if (request.method === 'GET' && requestUrl.pathname === '/events') {
                response.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                });
                response.write('retry: 2000\n\n');
                record.clients.add(response);
                request.on('close', () => record.clients.delete(response));
                return;
            }
            if (request.method === 'GET' && requestUrl.pathname === '/asset') {
                const assetPath = requestUrl.searchParams.get('path') || '';
                const documentDirectory = record.filePath ? path.dirname(record.filePath) : '';
                const relativeAssetPath = documentDirectory ? path.relative(documentDirectory, assetPath) : '..';
                const isInsideDocumentDirectory = relativeAssetPath !== '..'
                    && !relativeAssetPath.startsWith(`..${path.sep}`)
                    && !path.isAbsolute(relativeAssetPath);
                const allowedImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
                if (!path.isAbsolute(assetPath)
                    || !isInsideDocumentDirectory
                    || !allowedImageExtensions.has(path.extname(assetPath).toLowerCase())
                    || !fs.existsSync(assetPath)
                    || !fs.statSync(assetPath).isFile()) {
                    response.writeHead(404);
                    response.end('Not found');
                    return;
                }
                response.writeHead(200, { 'Content-Type': contentType(assetPath) });
                fs.createReadStream(assetPath).pipe(response);
                return;
            }
            if (request.method === 'POST' && requestUrl.pathname === '/action') {
                const body = await readRequestBody(request);
                const result = await dispatchCanvasAction(record, JSON.parse(body || '{}'));
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(result));
                return;
            }
            response.writeHead(404);
            response.end('Not found');
        })().catch(error => {
            record.log?.(`Markdown Review canvas error: ${error?.message || error}`, { level: 'error' });
            if (!response.headersSent) {
                response.writeHead(400, { 'Content-Type': 'application/json' });
            }
            response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
        });
    };
}

function refreshWatcher(record: CanvasRecord): void {
    record.watcher?.close();
    record.watcher = null;
    if (!record.filePath) {
        return;
    }
    const directory = path.dirname(record.filePath);
    const watchedNames = new Set([
        path.basename(record.filePath).toLowerCase(),
        path.basename(getCommentsPath(record.filePath)).toLowerCase(),
    ]);
    record.watcher = fs.watch(directory, (_event, fileName) => {
        if (!fileName || !watchedNames.has(String(fileName).toLowerCase())) {
            return;
        }
        if (record.watchTimer) {
            clearTimeout(record.watchTimer);
        }
        record.watchTimer = setTimeout(() => {
            record.watchTimer = null;
            record.broadcast({ type: 'refresh' });
        }, 120);
    });
}

export function setCanvasFile(record: CanvasRecord, filePathInput: string): void {
    if (!filePathInput.trim()) {
        throw new Error('Enter a Markdown file path.');
    }
    record.filePath = resolveCanvasPath(filePathInput.trim(), record.workingDirectory);
    refreshWatcher(record);
    record.broadcast({ type: 'refresh' });
}

export async function createInstanceServer(options: CreateInstanceOptions): Promise<CanvasRecord> {
    const record = {
        ...options,
        directPromptAvailable: options.directPromptAvailable !== false,
        token: randomBytes(18).toString('hex'),
        url: '',
        server: undefined as unknown as http.Server,
        clients: new Set<http.ServerResponse>(),
        watcher: null,
        watchTimer: null,
        broadcast: (_payload: object) => undefined,
    } as CanvasRecord;
    record.broadcast = payload => {
        const event = `data: ${JSON.stringify(payload)}\n\n`;
        for (const client of record.clients) {
            try {
                client.write(event);
            } catch {
                record.clients.delete(client);
            }
        }
    };
    record.server = http.createServer(makeCanvasHandler(record));
    await new Promise<void>((resolve, reject) => {
        record.server.once('error', reject);
        record.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = record.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    record.url = `http://127.0.0.1:${port}/?token=${record.token}`;
    refreshWatcher(record);
    return record;
}

export async function closeInstanceServer(record: CanvasRecord): Promise<void> {
    if (record.watchTimer) {
        clearTimeout(record.watchTimer);
    }
    record.watcher?.close();
    for (const client of record.clients) {
        client.end();
    }
    record.clients.clear();
    await new Promise<void>(resolve => record.server.close(() => resolve()));
}