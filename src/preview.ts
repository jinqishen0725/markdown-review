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

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isColorDark(hex: string): boolean {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return (r * 0.299 + g * 0.587 + b * 0.114) < 128;
}

interface Block {
    type: string;
    startOffset: number;
    endOffset: number;
    startLine: number;
    preview: string;
    eid?: string;  // Word element ID (paraId) — used instead of offsets for .docx
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
    private commentsWatcher: ReturnType<typeof import('fs').watch> | null = null;
    private commentsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Word-specific fields
    public isDocx: boolean = false;
    private docxPath: string = '';
    private docxModel: any = null; // DocumentModel from docx-parser
    private docxXmlWatcher: ReturnType<typeof import('fs').watch> | null = null;
    private docxXmlDebounce: ReturnType<typeof setTimeout> | null = null;
    private docxXmlExtractTime: number = 0; // timestamp when XML was first extracted

    // PowerPoint-specific fields
    public isPptx: boolean = false;
    private pptxPath: string = '';
    private pptxModel: any = null; // PptxModel from pptx-parser

    private constructor(
        panel: vscode.WebviewPanel,
        document: vscode.TextDocument,
        extensionUri: vscode.Uri,
        skipInitialRender: boolean = false,
    ) {
        this.panel = panel;
        this.document = document;
        this.extensionUri = extensionUri;
        this.commentsManager = new CommentsManager(document.uri.fsPath);

        this.panel.webview.options = { enableScripts: true };

        // Skip initial render for docx — caller will call updateDocxContent() after setting isDocx
        if (!skipInitialRender) {
            this.updateContent();
        }

        this.panel.webview.onDidReceiveMessage(
            (msg) => this.handleMessage(msg),
            null,
            this.disposables,
        );

        // Debounced re-render on any text change (1s delay) — skip for docx mode
        vscode.workspace.onDidChangeTextDocument(
            (e) => {
                if (this.isDocx || this.isPptx) return; // docx/pptx don't use TextDocument
                if (e.document.uri.fsPath === this.document.uri.fsPath) {
                    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
                    this.debounceTimer = setTimeout(() => {
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

        // Watch .comments.json for external changes (e.g., MCP server replies)
        this.setupCommentsFileWatcher();

        // Source → Preview: scroll preview to match editor cursor — skip for docx/pptx
        vscode.window.onDidChangeTextEditorSelection(
            (e) => {
                if (this.isDocx || this.isPptx) return;
                if (e.textEditor.document.uri.fsPath !== this.document.uri.fsPath) { return; }
                if (e.kind === vscode.TextEditorSelectionChangeKind.Command) { return; }
                const cursorOffset = this.document.offsetAt(e.selections[0].active);
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

    public static async createOrShowDocx(context: vscode.ExtensionContext, docxPath: string) {
        const key = docxPath;
        const existing = PreviewPanel.currentPanels.get(key);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Active);
            // Force re-parse from the .docx to pick up new/modified comments
            existing.docxModel = null;
            await existing.updateDocxContent();
            return;
        }

        // Create a dummy TextDocument by opening a blank untitled file (we won't use its content)
        // The actual content comes from the .docx parser
        const dummyDoc = await vscode.workspace.openTextDocument({ content: '', language: 'plaintext' });

        const panel = vscode.window.createWebviewPanel(
            'markdownReview',
            '📄 ' + path.basename(docxPath),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media'),
                    vscode.Uri.file(path.dirname(docxPath)),
                ],
            },
        );
        const p = new PreviewPanel(panel, dummyDoc, context.extensionUri, true /* skipInitialRender */);
        p.isDocx = true;
        p.docxPath = docxPath;
        p.commentsManager = new CommentsManager(docxPath);
        await p.updateDocxContent();
        PreviewPanel.currentPanels.set(key, p);
    }

    public static async createOrShowPptx(context: vscode.ExtensionContext, pptxPath: string) {
        const key = pptxPath;
        const existing = PreviewPanel.currentPanels.get(key);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Active);
            existing.pptxModel = null;
            await existing.updatePptxContent();
            return;
        }

        const dummyDoc = await vscode.workspace.openTextDocument({ content: '', language: 'plaintext' });
        const panel = vscode.window.createWebviewPanel(
            'markdownReview',
            '📊 ' + path.basename(pptxPath),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media'),
                    vscode.Uri.file(path.dirname(pptxPath)),
                ],
            },
        );
        const p = new PreviewPanel(panel, dummyDoc, context.extensionUri, true /* skipInitialRender */);
        p.isPptx = true;
        p.pptxPath = pptxPath;
        p.commentsManager = new CommentsManager(pptxPath);
        await p.updatePptxContent();
        PreviewPanel.currentPanels.set(key, p);
    }

    // ---------- message handling ----------

    private async handleMessage(message: any) {
        switch (message.command) {
            case 'addComment': {
                if ((this.isDocx || this.isPptx) && message.eid) {
                    const c = this.commentsManager.addDocxComment(
                        message.eid,
                        message.blockType || '',
                        message.blockPreview || '',
                        message.comment,
                    );
                    if (this.isPptx) {
                        this.panel.webview.postMessage({ command: 'commentAdded', comment: c });
                        if (message.askCopilot) {
                            this.openCopilotForThread(c);
                        }
                    } else {
                        this.updateDocxContent();
                        this.panel.webview.postMessage({ command: 'openPopover', commentId: c.id });
                    }
                    return;
                }
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
                // Create sidecar entry for imported comments on first resolve
                this.ensureSidecarForImportedComment(message.id);
                this.commentsManager.resolveComment(message.id);
                this.sendImportedCommentUpdate(message.id);
                return;
            case 'deleteComment': {
                const delAnswer = await vscode.window.showWarningMessage(
                    'Delete this comment and all its replies?',
                    { modal: true },
                    'Delete'
                );
                if (delAnswer === 'Delete') {
                    if (!this.isDocx && !this.isPptx) {
                        await this.removeAnchorViaApi(message.id);
                    }
                    this.commentsManager.deleteComment(message.id);
                    if (this.isPptx) {
                        this.panel.webview.postMessage({ command: 'commentDeleted', id: message.id });
                    } else if (this.isDocx) {
                        try { await this.updateDocxContent(); } catch (e: any) { log('deleteComment re-render failed: ' + e.message); }
                    } else {
                        this.immediateRender();
                    }
                }
                return;
            }
            case 'unresolveComment':
                this.commentsManager.unresolveComment(message.id);
                this.sendImportedCommentUpdate(message.id);
                return;
            case 'replyComment': {
                // For imported comments, create sidecar on first interaction
                this.ensureSidecarForImportedComment(message.id);
                this.commentsManager.addReply(message.id, message.text);
                this.sendImportedCommentUpdate(message.id);
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
                const delReplyAnswer = await vscode.window.showWarningMessage(
                    'Delete this reply?',
                    { modal: true },
                    'Delete'
                );
                if (delReplyAnswer === 'Delete') {
                    this.commentsManager.deleteReply(message.commentId, message.replyId);
                    this.panel.webview.postMessage({ command: 'commentUpdated', comment: this.commentsManager.getComments().find((c: any) => c.id === message.commentId) });
                }
                return;
            }
            case 'refresh':
                this.commentsManager.reload();
                this.updateContent();
                return;
            case 'resolveAll': {
                const openCount = this.commentsManager.getComments().filter((c: any) => !c.resolved).length;
                if (openCount === 0) {
                    vscode.window.showInformationMessage('No open comments to resolve.');
                    return;
                }
                const resolveAnswer = await vscode.window.showWarningMessage(
                    `Resolve all ${openCount} open comment(s)?`,
                    { modal: true },
                    'Resolve All'
                );
                if (resolveAnswer === 'Resolve All') {
                    for (const c of this.commentsManager.getComments()) {
                        if (!c.resolved) { c.resolved = true; }
                    }
                    this.commentsManager.persist();
                    if (this.isPptx) {
                        this.panel.webview.postMessage({ command: 'refreshComments', comments: this.getMergedComments() });
                    } else {
                        this.immediateRender();
                    }
                }
                return;
            }
            case 'deleteAllResolved': {
                const resolvedComments = this.commentsManager.getComments().filter((c: any) => c.resolved);
                if (resolvedComments.length === 0) {
                    vscode.window.showInformationMessage('No resolved comments to delete.');
                    return;
                }
                const deleteAnswer = await vscode.window.showWarningMessage(
                    `Delete all ${resolvedComments.length} resolved comment(s) and their anchors?`,
                    { modal: true },
                    'Delete All Resolved'
                );
                if (deleteAnswer === 'Delete All Resolved') {
                    for (const c of resolvedComments) {
                        if (!this.isPptx && !this.isDocx) {
                            await this.removeAnchorViaApi(c.id);
                        }
                        this.commentsManager.deleteComment(c.id);
                    }
                    if (this.isPptx) {
                        this.panel.webview.postMessage({ command: 'refreshComments', comments: this.getMergedComments() });
                    } else {
                        this.immediateRender();
                    }
                }
                return;
            }
            case 'exportPdf': {
                this.exportAsHtml();
                return;
            }
            case 'exportDocx': {
                this.exportAsDocx();
                return;
            }
            case 'saveDocxFile': {
                if (!this.isDocx || !this.docxModel) {
                    vscode.window.showWarningMessage('No Word document open.');
                    return;
                }
                try {
                    const { saveDocx } = require('./docx-parser');
                    const ext = path.extname(this.docxPath);
                    const defaultName = path.basename(this.docxPath, ext) + '_reviewed' + ext;
                    const defaultUri = vscode.Uri.file(path.join(path.dirname(this.docxPath), defaultName));

                    const saveUri = await vscode.window.showSaveDialog({
                        defaultUri,
                        filters: { 'Word Documents': ['docx'] },
                        title: 'Save Word Document',
                    });
                    if (!saveUri) return;

                    await saveDocx(this.docxModel, saveUri.fsPath);
                    vscode.window.showInformationMessage(`Document saved to: ${path.basename(saveUri.fsPath)}`);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to save: ${e.message}`);
                }
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
                let ca: Comment;
                if (this.isDocx && message.eid) {
                    ca = this.commentsManager.addDocxComment(
                        message.eid,
                        message.blockType || '',
                        message.blockPreview || '',
                        message.comment,
                    );
                    this.updateDocxContent();
                    this.panel.webview.postMessage({ command: 'openPopover', commentId: ca.id });
                    this.openCopilotForComment(ca);
                } else {
                    ca = this.commentsManager.addComment(
                        message.startOffset,
                        message.endOffset,
                        message.blockType || '',
                        message.blockPreview || '',
                        message.comment,
                    );
                    this.insertAnchorViaApi(ca.id, message.startOffset).then(() => {
                        this.immediateRender();
                        this.panel.webview.postMessage({ command: 'openPopover', commentId: ca.id });
                        this.openCopilotForComment(ca);
                    });
                }
                return;
            }
            case 'askCopilotThread': {
                // Reply was already saved by the replyComment message; just reload data for the prompt
                if (message.pendingReply) {
                    this.commentsManager.reload();
                }
                let comment = this.commentsManager.getComments().find((c: any) => c.id === message.id);
                // For Word comments, build a compatible comment object from the Word model
                if (!comment && message.id.startsWith('word_') && this.docxModel) {
                    const wcId = message.id.replace('word_', '');
                    const wc = this.docxModel.comments.find((w: any) => w.id === wcId);
                    if (wc) {
                        const sidecar = this.commentsManager.getComments().find((c: any) => c.id === message.id);
                        comment = {
                            id: message.id,
                            comment: wc.text,
                            blockPreview: (wc as any)._anchorText || wc.text.substring(0, 60),
                            resolved: sidecar?.resolved || false,
                            replies: sidecar?.replies || [],
                            elementId: wc.elementId,
                        };
                    }
                }
                // For PPTX comments, build from pptx model
                if (!comment && message.id.startsWith('pptx_') && this.pptxModel) {
                    const pcId = message.id.replace('pptx_', '');
                    const pc = this.pptxModel.comments.find((c: any) => c.id === pcId);
                    if (pc) {
                        const sidecar = this.commentsManager.getComments().find((c: any) => c.id === message.id);
                        comment = {
                            id: message.id,
                            comment: pc.text,
                            blockPreview: `Slide ${pc.slideIndex}`,
                            resolved: sidecar?.resolved || false,
                            replies: sidecar?.replies || [],
                            elementId: `slide_${pc.slideIndex}`,
                        };
                    }
                }
                if (comment) {
                    this.openCopilotForThread(comment);
                }
                return;
            }
            case 'sendAllToCopilot': {
                const allComments = (this.isPptx ? this.getMergedComments() : this.commentsManager.getComments()).filter((c: any) => !c.resolved);
                if (allComments.length === 0) {
                    vscode.window.showInformationMessage('No open comments to send.');
                    return;
                }
                const prompt = this.buildBatchPrompt(allComments);
                this.sendToChat(prompt);
                return;
            }
            case 'copyAllToClipboard': {
                const allOpen = (this.isPptx ? this.getMergedComments() : this.commentsManager.getComments()).filter((c: any) => !c.resolved);
                if (allOpen.length === 0) {
                    vscode.window.showInformationMessage('No open comments to copy.');
                    return;
                }
                const batchPrompt = this.buildBatchPrompt(allOpen);
                vscode.env.clipboard.writeText(batchPrompt);
                vscode.window.showInformationMessage(`${allOpen.length} comment(s) copied to clipboard.`);
                return;
            }
            case 'copyComment': {
                const cmt = this.commentsManager.getComments().find((c: any) => c.id === message.id);
                if (cmt) {
                    const singlePrompt = this.buildBatchPrompt([cmt]);
                    vscode.env.clipboard.writeText(singlePrompt);
                    vscode.window.showInformationMessage('Comment copied to clipboard.');
                }
                return;
            }
        }
    }

    // ---------- Ask Copilot helpers ----------

    private isCursor(): boolean {
        return vscode.env.appName?.toLowerCase().includes('cursor') || false;
    }

    private async sendToChat(prompt: string) {
        if (this.isCursor()) {
            await vscode.env.clipboard.writeText(prompt);
            const commands = await vscode.commands.getCommands(true);
            if (commands.includes('composer.focusComposer')) {
                await vscode.commands.executeCommand('composer.focusComposer');
            }
            vscode.window.showInformationMessage(
                'Review prompt copied to clipboard — paste in Cursor Agent (Ctrl+V) and press Enter',
                { modal: true }
            );
        } else {
            vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
        }
    }

    private openCopilotForComment(comment: any) {
        const filePath = this.isDocx ? this.docxPath : this.document.uri.fsPath;
        const fileName = path.basename(filePath);
        const toolPrefix = this.isCursor() ? '' : '#';

        let prompt: string;
        if (this.isDocx) {
            const xmlInfo = this.docxModel?.documentXmlPath ? `\nThe extracted document.xml is at: ${this.docxModel.documentXmlPath}` : '';
            prompt = `I'm reviewing a Word document "${fileName}" (${filePath}). A new review comment was just added:\n\n` +
                `- Comment #${comment.id}: "${comment.comment}"\n` +
                `- On element (paraId=${comment.elementId || 'unknown'}): "${comment.blockPreview || '(unknown)'}"\n\n` +
                `This is a Word (.docx) document stored as XML. You have these tools available:\n` +
                `- ${toolPrefix}listElements — get a compact text outline of the entire document (use this first if you need general context)\n` +
                `- ${toolPrefix}readElementXml — read the raw XML of a specific element to understand its structure\n` +
                `- ${toolPrefix}writeElementXml — replace an element's XML to make changes (for single-element edits)\n` +
                `- ${toolPrefix}saveDocument — save the modified document back to .docx\n` +
                `For substantial multi-element edits, you can directly edit the XML file at the path returned by readElementXml.${xmlInfo}\n` +
                `XML EDITING RULES:\n` +
                `1. PRESERVE all w14:paraId attributes on <w:p> elements — review comments are anchored to these IDs\n` +
                `2. When adding NEW <w:p> paragraphs, include w14:paraId with a unique 8-char hex (e.g. w14:paraId="A1B2C3D4" w14:textId="77777777")\n` +
                `3. Do NOT modify <w:commentRangeStart/> or <w:commentRangeEnd/> — those are existing Word comments from other reviewers\n\n` +
                `To edit this element: use ${toolPrefix}readElementXml(elementId="${comment.elementId || 'unknown'}") to see its XML, ` +
                `then ${toolPrefix}writeElementXml to replace it, then ${toolPrefix}saveDocument to save.\n` +
                `In the XML, find the <w:p> tag with w14:paraId="${comment.elementId || 'unknown'}" — that's the target element.\n\n` +
                `Please use ${toolPrefix}readReviewComment (with commentId="${comment.id}" and filePath="${filePath}") to get the full context, ` +
                `then address the comment by making the requested change and using ${toolPrefix}replyToReviewComment to explain what you changed.`;
        } else {
            prompt = `I'm reviewing "${fileName}" (${filePath}). A new review comment was just added:\n\n` +
                `- Comment #${comment.id}: "${comment.comment}"\n` +
                `- On block: "${comment.blockPreview || '(unknown)'}"\n\n` +
                `Please use ${toolPrefix}readReviewComment to get the full context of comment "${comment.id}", ` +
                `then use ${toolPrefix}replyToReviewComment to post a helpful response addressing this comment.`;
        }
        this.sendToChat(prompt);
    }

    private openCopilotForThread(comment: any) {
        const filePath = this.isPptx ? this.pptxPath : this.isDocx ? this.docxPath : this.document.uri.fsPath;
        const fileName = path.basename(filePath);
        const toolPrefix = this.isCursor() ? '' : '#';
        let repliesText = '';
        if (comment.replies && comment.replies.length > 0) {
            repliesText = '\n- Existing replies:\n' +
                comment.replies.map((r: any) => `  [${r.role || 'user'}] ${r.text}`).join('\n');
        }

        let prompt: string;
        if (this.isDocx) {
            const xmlInfo = this.docxModel?.documentXmlPath ? `\nThe extracted document.xml is at: ${this.docxModel.documentXmlPath}` : '';
            prompt = `I'm reviewing a Word document "${fileName}" (${filePath}). Please respond to this comment thread:\n\n` +
                `- Comment #${comment.id}: "${comment.comment}"\n` +
                `- On element (paraId=${comment.elementId || 'unknown'}): "${comment.blockPreview || '(unknown)'}"\n` +
                `- Status: ${comment.resolved ? 'Resolved' : 'Open'}` +
                repliesText + '\n\n' +
                `This is a Word (.docx) document stored as XML. You have these tools:\n` +
                `- ${toolPrefix}listElements — get a compact text outline of the document (use first for general context)\n` +
                `- ${toolPrefix}readElementXml — read raw XML of a specific element\n` +
                `- ${toolPrefix}writeElementXml — replace an element's XML\n` +
                `- ${toolPrefix}saveDocument — save changes back to .docx\n` +
                `For substantial edits, you can directly edit the XML file.${xmlInfo}\n` +
                `XML EDITING RULES:\n` +
                `1. PRESERVE all w14:paraId attributes on <w:p> elements — review comments are anchored to these IDs\n` +
                `2. When adding NEW <w:p> paragraphs, include w14:paraId with a unique 8-char hex (e.g. w14:paraId="A1B2C3D4" w14:textId="77777777")\n` +
                `3. Do NOT modify <w:commentRangeStart/> or <w:commentRangeEnd/> — those are existing Word comments\n\n` +
                `To edit this element: use ${toolPrefix}readElementXml(elementId="${comment.elementId || 'unknown'}") to see its XML, ` +
                `then ${toolPrefix}writeElementXml to replace it, then ${toolPrefix}saveDocument to save.\n` +
                `In the XML, find the <w:p> tag with w14:paraId="${comment.elementId || 'unknown'}" — that's the target element.\n\n` +
                `Please use ${toolPrefix}readReviewComment (with commentId="${comment.id}" and filePath="${filePath}") to understand the comment, ` +
                `then make the requested changes and use ${toolPrefix}replyToReviewComment to explain what you did.`;
        } else if (this.isPptx) {
            const extractInfo = this.pptxModel?.extractDir ? `\nExtracted slide XMLs are at: ${this.pptxModel.extractDir}` : '';
            const slideNum = (comment.elementId || '').match(/slide_(\d+)/)?.[1] || '?';
            const shapeId = (comment.elementId || '').split('_shape_')[1] || '';
            prompt = `I'm reviewing a PowerPoint presentation "${fileName}" (${filePath}). Please respond to this comment thread:\n\n` +
                `- Comment #${comment.id}: "${comment.comment}"\n` +
                `- On: "${comment.blockPreview || '(unknown)'}"\n` +
                `- Slide: ${slideNum}, Shape cNvPr id: ${shapeId || 'N/A'}\n` +
                `- Status: ${comment.resolved ? 'Resolved' : 'Open'}` +
                repliesText + '\n\n' +
                `This is a .pptx file (Office Open XML). Slide XMLs have been extracted for editing.${extractInfo}\n` +
                (shapeId ? `To find this shape, open slide${slideNum}.xml and search for: <p:cNvPr id="${shapeId}"\n` : '') +
                `\nPPTX XML EDITING GUIDE:\n` +
                `- Position: <a:off x="EMU" y="EMU"/> (914400 EMU = 1 inch)\n` +
                `- Size: <a:ext cx="EMU" cy="EMU"/>\n` +
                `- Font size: <a:rPr sz="N"/> (hundredths of a point, e.g. sz="1600" = 16pt)\n` +
                `- Bold/Italic: <a:rPr b="1" i="1"/>\n` +
                `- Text color: <a:solidFill><a:srgbClr val="RRGGBB"/></a:solidFill> inside <a:rPr>\n` +
                `- Shape fill: <a:solidFill><a:srgbClr val="RRGGBB"/></a:solidFill> inside <p:spPr>\n` +
                `- Geometry: <a:prstGeom prst="roundRect"/> (rect, roundRect, rightArrow, etc.)\n` +
                `- Text content: <a:r><a:rPr .../><a:t>text here</a:t></a:r>\n\n` +
                `XML EDITING RULES:\n` +
                `1. PRESERVE all <p:cNvPr id="N"> attributes — comments and references depend on these IDs\n` +
                `2. Do NOT modify or remove <p188:cm> elements or comment marker nodes — those are existing PowerPoint comments\n` +
                `3. Do NOT modify <mc:AlternateContent> blocks — those contain compatibility fallbacks\n` +
                `4. When changing text, keep the <a:rPr> attributes (font, size, color) unless explicitly asked to change them\n\n` +
                `Available tools:\n` +
                `- ${toolPrefix}listReviewComments — list all comments\n` +
                `- ${toolPrefix}readReviewComment — read full comment with replies\n` +
                `- ${toolPrefix}replyToReviewComment — post a reply\n` +
                `- ${toolPrefix}resolveReviewComment — mark as resolved\n\n` +
                `Please use ${toolPrefix}readReviewComment (commentId="${comment.id}", filePath="${filePath}") first, ` +
                `then use ${toolPrefix}replyToReviewComment to respond.`;
        } else {
            prompt = `I'm reviewing "${fileName}" (${filePath}). Please respond to this comment thread:\n\n` +
                `- Comment #${comment.id}: "${comment.comment}"\n` +
                `- On block: "${comment.blockPreview || '(unknown)'}"\n` +
                `- Status: ${comment.resolved ? 'Resolved' : 'Open'}` +
                repliesText + '\n\n' +
                `Please use ${toolPrefix}readReviewComment to get the full context of comment "${comment.id}", ` +
                `then use ${toolPrefix}replyToReviewComment to post a helpful response continuing this thread.`;
        }
        this.sendToChat(prompt);
    }

    private buildBatchPrompt(comments: any[]): string {
        const filePath = this.isPptx ? this.pptxPath : this.isDocx ? this.docxPath : this.document.uri.fsPath;
        const fileName = path.basename(filePath);
        const toolPrefix = this.isCursor() ? '' : '#';
        const parts: string[] = [];

        if (this.isDocx) {
            const xmlInfo = this.docxModel?.documentXmlPath ? ` The extracted document.xml is at: ${this.docxModel.documentXmlPath}` : '';
            parts.push(`Review comments on Word document "${fileName}" (${filePath}):`);
            parts.push(`This is a .docx file (XML-based). Available tools for editing:`);
            parts.push(`- ${toolPrefix}listElements — get a compact text outline of the document (use first for general context)`);
            parts.push(`- ${toolPrefix}readElementXml — read raw XML of a specific element`);
            parts.push(`- ${toolPrefix}writeElementXml — replace an element's XML to make changes`);
            parts.push(`- ${toolPrefix}saveDocument — save all changes back to .docx`);
            parts.push(`For substantial multi-element edits, you can directly edit the document.xml file.${xmlInfo}`);
            parts.push(`XML EDITING RULES:`);
            parts.push(`1. PRESERVE all w14:paraId attributes on <w:p> elements — review comments are anchored to these IDs`);
            parts.push(`2. When adding NEW <w:p> paragraphs, include w14:paraId with a unique 8-char hex (e.g. w14:paraId="A1B2C3D4" w14:textId="77777777")`);
            parts.push(`3. Do NOT modify <w:commentRangeStart/> or <w:commentRangeEnd/> — those are existing Word comments from other reviewers\n`);
        } else if (this.isPptx) {
            const extractInfo = this.pptxModel?.extractDir ? ` Extracted slide XMLs at: ${this.pptxModel.extractDir}` : '';
            parts.push(`Review comments on PowerPoint "${fileName}" (${filePath}):${extractInfo}`);
            parts.push(`This is a .pptx file. Each shape has <p:cNvPr id="N" name="..."/>. The shapeId in comments matches this id.`);
            parts.push(`XML EDITING: Position=<a:off x/y EMU>, Size=<a:ext cx/cy>, Font=<a:rPr sz="hundredths-pt">, Color=<a:solidFill><a:srgbClr val="hex"/>`);
            parts.push(`RULES: 1) PRESERVE <p:cNvPr id> attributes. 2) Do NOT modify <p188:cm> comment elements. 3) Keep <a:rPr> unless asked to change.`);
            parts.push(`Available tools: ${toolPrefix}listReviewComments, ${toolPrefix}readReviewComment, ${toolPrefix}replyToReviewComment, ${toolPrefix}resolveReviewComment\n`);
        } else {
            parts.push(`Review comments on "${fileName}" (${filePath}):\n`);
        }

        for (const c of comments) {
            const eidInfo = c.elementId ? ` (paraId=${c.elementId})` : '';
            let entry = `- Comment #${c.id} [${c.resolved ? 'RESOLVED' : 'OPEN'}]${eidInfo}: "${c.comment}"\n  Block: "${c.blockPreview || '(unknown)'}"`;
            if (c.replies && c.replies.length > 0) {
                entry += '\n  Replies:\n' + c.replies.map((r: any) => `    [${r.role || 'user'}] ${r.text}`).join('\n');
            }
            parts.push(entry);
        }
        parts.push(`\nPlease review and respond to each open comment above. For each comment:\n` +
            `1. Use ${toolPrefix}readReviewComment (with commentId and filePath="${filePath}") to get the full context\n` +
            `2. Use ${toolPrefix}replyToReviewComment (with commentId, text, and filePath="${filePath}") to post your response\n` +
            `3. Use ${toolPrefix}resolveReviewComment (with commentId and filePath="${filePath}") to mark it resolved after addressing it`);
        return parts.join('\n');
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
        if (this.isDocx) {
            this.updateDocxContent();
        } else {
            this.updateContent();
        }
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

    /**
     * Build a merged Word comment object with all metadata for targeted webview updates.
     * Combines native Word comment data with sidecar replies/resolved status.
     */
    private buildMergedWordComment(wordCommentId: string): any | undefined {
        if (!this.docxModel) return undefined;
        const wcId = wordCommentId.replace('word_', '');
        const allWordComments = this.docxModel.comments || [];
        const wc = allWordComments.find((c: any) => c.id === wcId && !c.parentId);
        if (!wc) return undefined;

        const replyComments = allWordComments.filter((c: any) => c.parentId === wcId);
        const wordReplies = replyComments.map((r: any) => ({
            id: `wr_${r.id}`,
            role: 'user' as const,
            text: `[${r.author}] ${r.text}`,
            timestamp: r.date || new Date().toISOString(),
        }));

        const sidecar = this.commentsManager.getComments().find((c: any) => c.id === wordCommentId);
        const sidecarReplies = sidecar?.replies || [];

        return {
            id: wordCommentId,
            anchor: '',
            startOffset: 0,
            endOffset: 0,
            blockType: 'paragraph',
            blockPreview: (wc as any)._anchorText || '(document text)',
            comment: wc.text,
            role: 'user' as const,
            timestamp: wc.date || new Date().toISOString(),
            resolved: sidecar?.resolved || false,
            elementId: wc.elementId,
            replies: [...wordReplies, ...sidecarReplies],
            _wordAuthor: wc.author,
            _source: 'word',
        };
    }

    private buildMergedPptxComment(pptxCommentId: string): any | undefined {
        if (!this.pptxModel) return undefined;
        const pcId = pptxCommentId.replace('pptx_', '');
        const pc = this.pptxModel.comments.find((c: any) => c.id === pcId);
        if (!pc) return undefined;

        const sidecar = this.commentsManager.getComments().find((c: any) => c.id === pptxCommentId);
        const sidecarReplies = sidecar?.replies || [];

        return {
            id: pptxCommentId,
            anchor: '',
            startOffset: 0,
            endOffset: 0,
            blockType: 'slide',
            blockPreview: `Slide ${pc.slideIndex}` + (pc.shapeId ? ` (shape ${pc.shapeId})` : ''),
            comment: pc.text,
            role: 'user' as const,
            timestamp: pc.created || new Date().toISOString(),
            resolved: sidecar?.resolved || false,
            elementId: `slide_${pc.slideIndex}`,
            replies: [...sidecarReplies],
            _wordAuthor: pc.authorName,
            _source: 'pptx',
        };
    }

    /** Create sidecar entry for imported comments on first interaction */
    private ensureSidecarForImportedComment(id: string): void {
        if (!this.commentsManager.getComments().find((c: any) => c.id === id)) {
            if (id.startsWith('word_') && this.docxModel) {
                const wc = this.docxModel.comments.find((w: any) => `word_${w.id}` === id);
                this.commentsManager.addDocxComment(wc?.elementId || '', 'paragraph', wc?.text?.substring(0, 60) || '', wc?.text || '');
            } else if (id.startsWith('pptx_') && this.pptxModel) {
                const pc = this.pptxModel.comments.find((c: any) => `pptx_${c.id}` === id);
                this.commentsManager.addDocxComment(`slide_${pc?.slideIndex || 0}`, 'slide', `Slide ${pc?.slideIndex || '?'}`, pc?.text || '');
            } else {
                return; // not an imported comment
            }
            const added = this.commentsManager.getComments();
            added[added.length - 1].id = id;
            this.commentsManager.persist();
        }
    }

    /** Send targeted update for imported or sidecar comments */
    private sendImportedCommentUpdate(id: string): void {
        let merged: any;
        if (id.startsWith('word_')) {
            merged = this.buildMergedWordComment(id);
        } else if (id.startsWith('pptx_')) {
            merged = this.buildMergedPptxComment(id);
        } else {
            merged = this.commentsManager.getComments().find((c: any) => c.id === id);
        }
        if (merged) {
            this.panel.webview.postMessage({ command: 'commentUpdated', comment: merged });
        }
    }

    private getMergedComments(): any[] {
        const sidecarComments = this.commentsManager.getComments();
        if (this.isPptx && this.pptxModel) {
            const pptxCommentObjs = this.pptxModel.comments.map((c: any) => ({
                id: `pptx_${c.id}`,
                blockType: 'slide',
                blockPreview: `Slide ${c.slideIndex}` + (c.shapeId ? ` (shape ${c.shapeId})` : ''),
                comment: c.text,
                role: 'user' as const,
                timestamp: c.created || new Date().toISOString(),
                resolved: false,
                elementId: `slide_${c.slideIndex}`,
                replies: [] as any[],
                _wordAuthor: c.authorName,
                _source: 'pptx',
            }));
            for (const pc of pptxCommentObjs) {
                const sidecar = sidecarComments.find((sc: any) => sc.id === pc.id);
                if (sidecar) {
                    if (sidecar.replies) pc.replies = [...pc.replies, ...sidecar.replies];
                    pc.resolved = sidecar.resolved;
                }
            }
            const reviewOnly = sidecarComments.filter((c: any) => !c.id.startsWith('pptx_'));
            return [...reviewOnly, ...pptxCommentObjs];
        }
        return sidecarComments;
    }

    private async updateDocxContent() {
        if (!this.isDocx || !this.docxPath) return;
        try {
            const { parseDocx, reparseFromExtractedXml } = require('./docx-parser');

            if (!this.docxModel) {
                // First load — parse from the original .docx
                this.docxModel = await parseDocx(this.docxPath);
                this.docxXmlExtractTime = Date.now();

                // Warn if agent edits were overwritten because .docx was newer
                if (this.docxModel.xmlWasOverwritten) {
                    vscode.window.showWarningMessage(
                        'The .docx file was modified since last review. The extracted XML has been refreshed — any previous agent edits to document.xml were overwritten.',
                        'Open XML File'
                    ).then(choice => {
                        if (choice === 'Open XML File' && this.docxModel?.documentXmlPath) {
                            vscode.workspace.openTextDocument(this.docxModel.documentXmlPath).then(doc => {
                                vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                            });
                        }
                    });
                }
            } else if (this.docxModel.documentXmlPath) {
                // Subsequent loads — re-parse from the extracted (possibly edited) document.xml
                this.docxModel = await reparseFromExtractedXml(this.docxModel);
            }

            // Build blocks from parsed elements
            const blocks: Block[] = this.docxModel.elements.map((el: any) => ({
                type: el.type,
                startOffset: 0,
                endOffset: 0,
                startLine: 0,
                preview: el.content.substring(0, 80),
                eid: el.id,
            }));

            // Build HTML body from elements
            let bodyHtml = '';
            for (const el of this.docxModel.elements) {
                const hasWordComments = el.commentIds.length > 0;
                const commentClass = hasWordComments ? ' word-commented-block' : '';
                const eidAttr = `data-eid="${el.id}"`;
                // Store comment IDs as data attribute for click handling
                const commentIdsAttr = hasWordComments ? ` data-word-comment-ids="${el.commentIds.join(',')}"` : '';
                switch (el.type) {
                    case 'heading': {
                        const lvl = Math.min(el.level || 1, 6);
                        bodyHtml += `<h${lvl} ${eidAttr}${commentIdsAttr} class="${commentClass}">${el.htmlContent}</h${lvl}>\n`;
                        break;
                    }
                    case 'table':
                        bodyHtml += `<div ${eidAttr}${commentIdsAttr} class="table-wrapper${commentClass}">${el.htmlContent}</div>\n`;
                        break;
                    case 'list-item': {
                        const indent = (el.level || 0) * 24 + 24;
                        bodyHtml += `<div ${eidAttr}${commentIdsAttr} class="list-item${commentClass}" style="padding-left:${indent}px">• ${el.htmlContent}</div>\n`;
                        break;
                    }
                    case 'code-block':
                        bodyHtml += `<pre ${eidAttr}${commentIdsAttr} class="code-block${commentClass}"><code>${el.htmlContent}</code></pre>\n`;
                        break;
                    default:
                        if (!el.content.trim() && !el.htmlContent.trim()) {
                            bodyHtml += `<p ${eidAttr} class="empty-para">&nbsp;</p>\n`;
                        } else {
                            bodyHtml += `<p ${eidAttr}${commentIdsAttr} class="${commentClass}">${el.htmlContent}</p>\n`;
                        }
                }
            }

            // Merge review comments from sidecar — reconcile elementIds
            const comments = this.commentsManager.getComments();
            const elementIds = new Set(this.docxModel.elements.map((e: any) => e.id));
            let reconciled = false;
            for (const c of comments) {
                if (!c.elementId) continue;
                if (!elementIds.has(c.elementId)) {
                    // Element ID not found — try contentHash fallback
                    if (c.contentHash) {
                        const hashMatch = this.docxModel.elements.find((e: any) => {
                            const crypto = require('crypto');
                            const h = crypto.createHash('sha256').update(e.content).digest('hex').substring(0, 16);
                            return h === c.contentHash;
                        });
                        if (hashMatch) {
                            log(`Comment ${c.id}: reconciled elementId ${c.elementId} → ${hashMatch.id} (hash match)`);
                            c.elementId = hashMatch.id;
                            reconciled = true;
                            continue;
                        }
                    }
                    // Try blockPreview fuzzy match
                    if (c.blockPreview) {
                        const preview = c.blockPreview.substring(0, 40);
                        const fuzzyMatch = this.docxModel.elements.find((e: any) =>
                            e.content.includes(preview)
                        );
                        if (fuzzyMatch) {
                            log(`Comment ${c.id}: reconciled elementId ${c.elementId} → ${fuzzyMatch.id} (preview match)`);
                            c.elementId = fuzzyMatch.id;
                            reconciled = true;
                            continue;
                        }
                    }
                    log(`Comment ${c.id}: ORPHANED — element ${c.elementId} not found`);
                }
            }
            if (reconciled) {
                this.commentsManager.persist();
            }

            // Merge Word native comments into the display list (threaded)
            const allWordComments = this.docxModel.comments || [];

            // Separate root comments from replies
            const rootComments = allWordComments.filter((wc: any) => !wc.parentId);
            const replyComments = allWordComments.filter((wc: any) => wc.parentId);

            const wordComments = rootComments.map((wc: any) => {
                // Find Word replies to this comment
                const wordReplies = replyComments
                    .filter((r: any) => r.parentId === wc.id)
                    .map((r: any) => ({
                        id: `wr_${r.id}`,
                        role: 'user' as const,
                        text: `[${r.author}] ${r.text}`,
                        timestamp: r.date || new Date().toISOString(),
                    }));

                return {
                    id: `word_${wc.id}`,
                    anchor: '',
                    startOffset: 0,
                    endOffset: 0,
                    blockType: 'paragraph',
                    blockPreview: (wc as any)._anchorText || '(document text)',
                    comment: wc.text,
                    role: 'user' as const,
                    timestamp: wc.date || new Date().toISOString(),
                    resolved: false,
                    elementId: wc.elementId,
                    replies: wordReplies,
                    _wordAuthor: wc.author,
                    _source: 'word',
                };
            });

            // Merge sidecar replies/resolved status for Word comments
            for (const wc of wordComments) {
                const sidecar = comments.find((c: any) => c.id === wc.id);
                if (sidecar) {
                    // Append sidecar replies after Word replies
                    if (sidecar.replies) {
                        wc.replies = [...wc.replies, ...sidecar.replies];
                    }
                    wc.resolved = sidecar.resolved;
                }
            }

            // Filter out sidecar entries that are just placeholders for Word comments
            const reviewOnlyComments = comments.filter((c: any) => !c.id.startsWith('word_'));
            const allComments = [...reviewOnlyComments, ...wordComments];

            this.panel.webview.html = this.getHtml(bodyHtml, blocks, allComments);
            this.lastRenderTime = Date.now();
            log(`Docx preview rendered: ${this.docxModel.elements.length} elements, ${this.docxModel.comments.length} Word comments`);

            // Watch the extracted document.xml for direct agent edits
            this.setupDocxXmlWatcher();
        } catch (e: any) {
            logError('Failed to render docx', e);
            this.panel.webview.html = `<html><body><h1>Error loading document</h1><pre>${e.message}\n${e.stack}</pre></body></html>`;
        }
    }

    // ---------- PowerPoint rendering ----------

    private async updatePptxContent() {
        if (!this.isPptx || !this.pptxPath) return;
        try {
            const { parsePptx } = require('./pptx-parser');
            const fs = require('fs');

            if (!this.pptxModel) {
                this.pptxModel = await parsePptx(this.pptxPath);
            }

            const model = this.pptxModel;

            const pptxFileUri = this.panel.webview.asWebviewUri(
                vscode.Uri.file(this.pptxPath)
            ).toString();
            const pptxViewerUri = this.panel.webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'pptx-viewer.js')
            ).toString();

            // Build notes data
            const notesData = model.slides
                .filter((s: any) => s.notes?.trim())
                .map((s: any) => ({ slideIndex: s.index, notes: s.notes }));

            // Build color fix data from our parser
            const colorFixes: any[] = [];
            for (const slide of model.slides) {
                for (const shape of slide.shapes) {
                    for (const para of shape.paragraphs) {
                        for (const run of para.runs) {
                            if (run.color) {
                                colorFixes.push({
                                    text: run.text.substring(0, 30),
                                    color: '#' + run.color,
                                });
                            }
                        }
                    }
                }
            }

            // Merge comments
            const sidecarComments = this.commentsManager.getComments();
            const pptxCommentObjs = model.comments.map((c: any) => ({
                id: `pptx_${c.id}`,
                blockType: 'slide',
                blockPreview: `Slide ${c.slideIndex}` + (c.shapeId ? ` (shape ${c.shapeId})` : ''),
                comment: c.text,
                role: 'user' as const,
                timestamp: c.created || new Date().toISOString(),
                resolved: false,
                elementId: `slide_${c.slideIndex}`,
                replies: [] as any[],
                _wordAuthor: c.authorName,
                _source: 'pptx',
            }));
            for (const pc of pptxCommentObjs) {
                const sidecar = sidecarComments.find((c: any) => c.id === pc.id);
                if (sidecar) {
                    if (sidecar.replies) pc.replies = [...pc.replies, ...sidecar.replies];
                    pc.resolved = sidecar.resolved;
                }
            }
            const reviewOnly = sidecarComments.filter((c: any) => !c.id.startsWith('pptx_'));
            const allComments = [...reviewOnly, ...pptxCommentObjs];

            // Build shape layout data for element-level comment targets
            const EMU = 914400;
            const slideW = model.dimensions.cx / EMU * 96; // native px width (1280 for 16:9)
            const shapeLayouts: any[] = [];
            for (const slide of model.slides) {
                for (const shape of slide.shapes) {
                    if (shape.cx <= 0 && shape.cy <= 0) continue; // skip zero-size
                    const label = shape.text.trim()
                        ? shape.text.substring(0, 60)
                        : shape.geometry ? `[${shape.geometry}] ${shape.name}` : shape.name;
                    shapeLayouts.push({
                        slideIndex: slide.index,
                        shapeId: shape.id,
                        name: shape.name,
                        text: label,
                        xPct: shape.x / model.dimensions.cx * 100,
                        yPct: shape.y / model.dimensions.cy * 100,
                        wPct: shape.cx / model.dimensions.cx * 100,
                        hPct: shape.cy / model.dimensions.cy * 100,
                    });
                }
            }

            const commentsJson = JSON.stringify(allComments).replace(/</g, '\\u003c');
            const notesJson = JSON.stringify(notesData).replace(/</g, '\\u003c');
            const colorFixesJson = JSON.stringify(colorFixes).replace(/</g, '\\u003c');
            const shapesJson = JSON.stringify(shapeLayouts).replace(/</g, '\\u003c');

            this.panel.webview.html = this.getPptxHtml(commentsJson, notesJson, colorFixesJson, shapesJson, pptxViewerUri, pptxFileUri);
            this.lastRenderTime = Date.now();
            log(`Pptx preview rendered: ${model.slides.length} slides, ${colorFixes.length} color fixes`);
        } catch (e: any) {
            logError('Failed to render pptx', e);
            this.panel.webview.html = `<html><body><h1>Error loading presentation</h1><pre>${e.message}\n${e.stack}</pre></body></html>`;
        }
    }

    private getPptxHtml(commentsJson: string, notesJson: string, colorFixesJson: string, shapesJson: string, pptxViewerUri: string, pptxFileUri: string): string {
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>PowerPoint Review</title>
<style>
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    font-size: 13px; line-height: 1.5;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    margin: 0; padding: 20px;
}
#slides-output { width: 960px; margin: 0 auto; }
#slides-output > div { margin-bottom: 16px; position: relative; }
.slide-label { font-size: 14px; font-weight: bold; color: var(--vscode-foreground, #ccc); margin: 16px 0 6px 0; max-width: 960px; margin-left: auto; margin-right: auto; }
.pptx-notes { margin: 6px auto 0; padding: 8px 12px; background: var(--vscode-textBlockQuote-background, #2d2d30); border-left: 3px solid #888; font-size: 12px; color: var(--vscode-foreground, #ccc); border-radius: 3px; max-width: 960px; }
#loading { text-align: center; padding: 60px; color: #888; font-size: 16px; }
.spinner { display: inline-block; width: 24px; height: 24px; border: 3px solid #555; border-top-color: #0078D4; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 10px; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg); } }
/* Add comment button on each slide */
.slide-add-comment { position: absolute; top: 6px; right: 6px; z-index: 10; background: var(--vscode-button-background, #0078D4); color: #fff; border: none; border-radius: 50%; width: 28px; height: 28px; font-size: 18px; cursor: pointer; opacity: 0.6; transition: opacity 0.2s; line-height: 28px; text-align: center; }
.slide-add-comment:hover { opacity: 1; }
/* Shape overlay targets for element-level comments */
.shape-overlay { position: absolute; border: 2px solid transparent; cursor: pointer; z-index: 5; transition: border-color 0.15s, background 0.15s; border-radius: 3px; }
.shape-overlay:hover { border-color: rgba(0,120,212,0.5); background: rgba(0,120,212,0.08); }
.shape-overlay .shape-add-btn { display: none; position: absolute; top: 2px; right: 2px; background: #0078D4; color: #fff; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 14px; cursor: pointer; line-height: 20px; text-align: center; }
.shape-overlay:hover .shape-add-btn { display: block; }
.shape-overlay.has-comment { border-color: rgba(255,165,0,0.6); background: rgba(255,165,0,0.1); }
.shape-overlay.has-comment::after { content: '\\1F4AC'; position: absolute; top: 2px; left: 2px; font-size: 14px; }
.shape-overlay.all-resolved { border-color: rgba(100,100,100,0.4); background: rgba(100,100,100,0.05); }
.shape-overlay.all-resolved::after { content: '\\2705'; position: absolute; top: 2px; left: 2px; font-size: 14px; }
/* Popover */
#comment-popover { display: none; position: absolute; z-index: 100; background: var(--vscode-editor-background, #252526); border: 1px solid var(--vscode-panel-border, #444); border-radius: 8px; padding: 12px; width: 340px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); max-height: 400px; overflow-y: auto; }
.pop-text { font-size: 13px; margin-bottom: 6px; }
.pop-meta { font-size: 11px; color: #888; margin-bottom: 8px; }
.pop-replies { margin: 8px 0; padding-left: 10px; border-left: 2px solid #555; }
.pop-reply { font-size: 12px; margin-bottom: 4px; }
.pop-reply-meta { font-size: 10px; color: #888; }
.pop-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.pop-actions button { padding: 3px 10px; border: none; border-radius: 3px; cursor: pointer; font-size: 11px; background: var(--vscode-button-background, #0078D4); color: var(--vscode-button-foreground, #fff); }
.pop-reply-input { margin-top: 8px; }
.pop-reply-input textarea { width: 100%; padding: 4px; border: 1px solid #555; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border-radius: 3px; font-size: 12px; resize: none; box-sizing: border-box; }
/* Comment dialog */
#comment-dialog { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 2000; align-items: center; justify-content: center; }
#comment-dialog.open { display: flex; }
.dlg-box { background: var(--vscode-editor-background, #252526); border: 1px solid var(--vscode-panel-border, #444); border-radius: 8px; padding: 20px; width: 500px; max-width: 90vw; }
.dlg-box h3 { margin: 0 0 8px; color: var(--vscode-foreground, #ccc); }
.dlg-preview { font-size: 12px; color: #888; margin-bottom: 8px; padding: 6px; background: var(--vscode-textBlockQuote-background, #2d2d30); border-radius: 4px; }
.dlg-box textarea { width: 100%; min-height: 80px; padding: 8px; border: 1px solid #555; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc); border-radius: 4px; font-family: inherit; font-size: 13px; resize: vertical; box-sizing: border-box; }
.dlg-actions { margin-top: 10px; display: flex; gap: 8px; justify-content: flex-end; }
.dlg-actions button { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
.btn-primary { background: var(--vscode-button-background, #0078D4); color: var(--vscode-button-foreground, #fff); }
.btn-cancel { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); }
.btn-copilot { background: #68217A !important; color: #fff; }
/* Sidebar */
#sidebar { position: fixed; top: 0; right: -360px; width: 350px; height: 100vh; background: var(--vscode-sideBar-background, #252526); border-left: 1px solid var(--vscode-panel-border, #444); z-index: 1000; overflow-y: auto; transition: right 0.2s; padding: 12px; box-sizing: border-box; }
#sidebar.open { right: 0; }
.sidebar-close { position: sticky; top: 0; float: right; background: none; border: none; color: var(--vscode-foreground, #ccc); font-size: 20px; cursor: pointer; z-index: 1001; }
#comment-badge { position: fixed; top: 10px; right: 10px; background: var(--vscode-badge-background, #007acc); color: var(--vscode-badge-foreground, #fff); padding: 6px 14px; border-radius: 20px; cursor: pointer; font-size: 13px; z-index: 999; display: none; }
.clist-item { padding: 10px; margin-bottom: 8px; background: var(--vscode-input-background, #3c3c3c); border-radius: 6px; border-left: 3px solid #007acc; cursor: pointer; }
.clist-item.pptx-comment { border-left-color: #2196F3; }
.clist-item.resolved { opacity: 0.5; border-left-color: #666; }
.item-preview { font-size: 11px; color: #888; margin-bottom: 4px; }
.item-comment { font-size: 13px; margin-bottom: 4px; }
.role-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; margin-right: 6px; font-weight: 600; }
.role-pptx { background: #2196F3; color: #fff; }
.role-word { background: #2e7d32; color: #fff; }
.role-user { background: #0078D4; color: #fff; }
.role-agent { background: #68217A; color: #fff; }
.inline-edit-btn { background: none !important; border: none !important; color: #888 !important; cursor: pointer; font-size: 10px !important; padding: 0 2px !important; text-decoration: underline; }
.inline-edit-btn:hover { color: #ccc !important; }
.reply-delete-btn { background: none !important; border: none !important; color: #888 !important; cursor: pointer; font-size: 14px !important; padding: 0 2px !important; }
.reply-delete-btn:hover { color: #f44 !important; }
.item-meta { font-size: 11px; color: #888; }
.item-replies { margin-top: 6px; padding-left: 12px; border-left: 2px solid #555; }
.item-reply { margin-bottom: 4px; font-size: 12px; }
.item-actions { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.item-actions button, .item-reply-input button { padding: 3px 10px; background: var(--vscode-button-background, #0078D4); color: var(--vscode-button-foreground, #fff); border: none; border-radius: 3px; cursor: pointer; font-size: 11px; }
</style>
<script src="${pptxViewerUri}"></script>
</head>
<body>
<div id="comment-badge" onclick="toggleSidebar()">&#x1F4AC; <span id="badge-count">0</span></div>
<div id="sidebar">
    <button class="sidebar-close" onclick="toggleSidebar()">&#x00D7;</button>
    <h3>&#x1F4AC; Review Comments</h3>
    <div class="panel-toolbar">
        <input type="text" id="comment-search" placeholder="Search comments..." oninput="buildList()" style="width:100%;padding:4px 8px;margin-bottom:6px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:3px;font-size:12px;box-sizing:border-box;">
        <div class="panel-filters" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">
            <button id="filter-all" class="active" onclick="setFilter('all')" style="padding:2px 8px;font-size:11px;border:1px solid #555;border-radius:3px;cursor:pointer;background:var(--vscode-button-background,#0078D4);color:#fff;">All</button>
            <button id="filter-open" onclick="setFilter('open')" style="padding:2px 8px;font-size:11px;border:1px solid #555;border-radius:3px;cursor:pointer;background:transparent;color:#ccc;">Open</button>
            <button id="filter-resolved" onclick="setFilter('resolved')" style="padding:2px 8px;font-size:11px;border:1px solid #555;border-radius:3px;cursor:pointer;background:transparent;color:#ccc;">Resolved</button>
        </div>
        <div class="panel-bulk" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">
            <button onclick="sendAllToCopilot()" style="padding:2px 8px;font-size:11px;border:none;border-radius:3px;cursor:pointer;background:var(--vscode-button-background,#0078D4);color:#fff;">&#x2728; Send All to Copilot</button>
            <button onclick="copyAllToClipboard()" style="padding:2px 8px;font-size:11px;border:none;border-radius:3px;cursor:pointer;background:var(--vscode-button-background,#0078D4);color:#fff;">&#x1F4CB; Copy All</button>
            <button onclick="resolveAll()" style="padding:2px 8px;font-size:11px;border:none;border-radius:3px;cursor:pointer;background:var(--vscode-button-background,#0078D4);color:#fff;">Resolve All</button>
            <button onclick="deleteAllResolved()" style="padding:2px 8px;font-size:11px;border:none;border-radius:3px;cursor:pointer;background:var(--vscode-button-background,#0078D4);color:#fff;">Delete Resolved</button>
        </div>
    </div>
    <div id="comment-list"></div>
</div>
<div id="comment-dialog">
    <div class="dlg-box">
        <h3>Add Comment</h3>
        <div class="dlg-preview" id="dlg-preview"></div>
        <textarea id="dlg-text" placeholder="Write your comment..."></textarea>
        <div class="dlg-actions">
            <button class="btn-cancel" onclick="closeDialog()">Cancel</button>
            <button class="btn-primary" onclick="submitComment()">Add Comment</button>
            <button class="btn-copilot" onclick="submitAndAskCopilot()">&#x2728; Ask Copilot</button>
        </div>
    </div>
</div>
<div id="loading"><span class="spinner"></span>Rendering presentation...</div>
<div id="comment-popover"></div>
<div id="slides-output"></div>
<script>
(function() {
    window.onerror = function(msg, url, line, col, err) {
        document.getElementById('loading').innerHTML = '<b>Error:</b> ' + msg + '<br><pre>' + (err && err.stack || '') + '</pre>';
        return true;
    };
    window.addEventListener('unhandledrejection', function(e) {
        document.getElementById('loading').innerHTML = '<b>Promise Error:</b><pre>' + (e.reason && e.reason.stack || e.reason || '') + '</pre>';
    });

    var vscode = acquireVsCodeApi();
    var loadingEl = document.getElementById('loading');
    function setStatus(msg) { if (loadingEl) loadingEl.innerHTML = '<span class="spinner"></span>' + msg; }

    setStatus('Parsing comments...');
    var comments = ${commentsJson};
    var notesData = ${notesJson};
    var colorFixes = ${colorFixesJson};
    var shapeLayouts = ${shapesJson};
    setStatus('Loaded ' + comments.length + ' comments, initializing...');
    var pendingSlideIndex = null;
    var pendingShapeId = null;
    var pendingShapeName = null;
    function esc(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }

    // Build color fix lookup
    var colorFixMap = {};
    colorFixes.forEach(function(f) { colorFixMap[f.text] = f.color; });

    function fixColors(root) {
        var spans = root.querySelectorAll('span');
        for (var i = 0; i < spans.length; i++) {
            var span = spans[i];
            if (!span.style || span.style.color !== 'rgb(255, 255, 255)') continue;
            var text = (span.textContent || '').trim();
            if (!text) continue;
            var fix = colorFixMap[text.substring(0, 30)];
            if (fix && fix !== '#FFFFFF' && fix !== '#ffffff') span.style.color = fix;
        }
    }

    // === Comment dialog ===
    var pendingShapeText = null;

    window.openCommentDialog = function(slideIndex, shapeId, shapeName, shapeText) {
        pendingSlideIndex = slideIndex;
        pendingShapeId = shapeId || null;
        pendingShapeName = shapeName || null;
        pendingShapeText = shapeText || null;
        var preview = 'Slide ' + slideIndex;
        if (shapeText) preview += ': "' + shapeText.substring(0, 80) + '"';
        else if (shapeName) preview += ' > ' + shapeName;
        else if (shapeName) preview += ' > ' + shapeName;
        document.getElementById('dlg-preview').textContent = preview;
        document.getElementById('dlg-text').value = '';
        document.getElementById('comment-dialog').classList.add('open');
        setTimeout(function() { document.getElementById('dlg-text').focus(); }, 100);
    };
    window.closeDialog = function() {
        document.getElementById('comment-dialog').classList.remove('open');
        pendingSlideIndex = null;
    };
    window.submitComment = function() {
        var text = document.getElementById('dlg-text').value.trim();
        if (!text || !pendingSlideIndex) return;
        var eid = pendingShapeId ? 'slide_' + pendingSlideIndex + '_shape_' + pendingShapeId : 'slide_' + pendingSlideIndex;
        var preview = 'Slide ' + pendingSlideIndex;
        if (pendingShapeId) preview += ' (shapeId=' + pendingShapeId + ')';
        if (pendingShapeText) preview += ': "' + pendingShapeText.substring(0, 80) + '"';
        else if (pendingShapeName) preview += ' > ' + pendingShapeName;
        vscode.postMessage({ command: 'addComment', eid: eid, blockType: 'slide', blockPreview: preview, comment: text });
        closeDialog();
    };
    window.submitAndAskCopilot = function() {
        var text = document.getElementById('dlg-text').value.trim();
        if (!text || !pendingSlideIndex) return;
        var eid = pendingShapeId ? 'slide_' + pendingSlideIndex + '_shape_' + pendingShapeId : 'slide_' + pendingSlideIndex;
        var preview = 'Slide ' + pendingSlideIndex;
        if (pendingShapeId) preview += ' (shapeId=' + pendingShapeId + ')';
        if (pendingShapeText) preview += ': "' + pendingShapeText.substring(0, 80) + '"';
        else if (pendingShapeName) preview += ' > ' + pendingShapeName;
        vscode.postMessage({ command: 'addComment', eid: eid, blockType: 'slide', blockPreview: preview, comment: text, askCopilot: true });
        closeDialog();
    };
    // Ctrl+Enter to submit
    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 'Enter' && document.getElementById('comment-dialog').classList.contains('open')) {
            submitComment();
        }
        if (e.key === 'Escape') closeDialog();
    });

    // === Comment actions ===
    window.resolveComment = function(id) { vscode.postMessage({ command: 'resolveComment', id: id }); };
    window.unresolveComment = function(id) { vscode.postMessage({ command: 'unresolveComment', id: id }); };
    window.deleteComment = function(id) { vscode.postMessage({ command: 'deleteComment', id: id }); };
    window.submitReply = function(id) {
        var inp = document.getElementById('pop-reply-input');
        var t = inp ? inp.value.trim() : '';
        if (!t) return;
        vscode.postMessage({ command: 'replyComment', id: id, text: t });
        inp.value = '';
    };
    window.submitListReply = function(id) {
        var inp = document.getElementById('list-reply-' + id);
        var t = inp ? inp.value.trim() : '';
        if (!t) return;
        vscode.postMessage({ command: 'replyComment', id: id, text: t });
        inp.value = '';
    };
    window.askCopilotThread = function(id) {
        var inp = document.getElementById('pop-reply-input');
        if (!inp) inp = document.getElementById('list-reply-' + id);
        var replyText = inp ? inp.value.trim() : '';
        if (replyText) {
            vscode.postMessage({ command: 'replyComment', id: id, text: replyText });
            inp.value = '';
        }
        vscode.postMessage({ command: 'askCopilotThread', id: id, pendingReply: replyText });
    };
    window.copyComment = function(id) {
        var c = comments.find(function(x) { return x.id === id; });
        if (!c) return;
        var text = c.blockPreview + '\\n' + c.comment;
        if (c.replies) c.replies.forEach(function(r) { text += '\\n  [' + (r.role||'user') + '] ' + r.text; });
        navigator.clipboard.writeText(text);
    };

    // === Popover ===
    function showPopover(comment, anchorEl) {
        var pop = document.getElementById('comment-popover');
        var isPptx = comment._source === 'pptx';
        var authorBadge = isPptx
            ? '<span class="role-badge role-pptx">' + esc(comment._wordAuthor || 'PPT') + '</span>'
            : '<span class="role-badge role-' + (comment.role||'user') + '">' + (comment.role||'user') + '</span>';
        var resolveBtn = comment.resolved
            ? '<button onclick="unresolveComment(\\'' + comment.id + '\\')">Reopen</button>'
            : '<button onclick="resolveComment(\\'' + comment.id + '\\')">Resolve</button>';
        var repliesHtml = '';
        if (comment.replies && comment.replies.length) {
            repliesHtml = '<div class="pop-replies">';
            comment.replies.forEach(function(r) {
                var isNativeReply = r.id && r.id.startsWith('pptx_');
                var editBtn = isNativeReply ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditReply(\\'' + comment.id + '\\',\\'' + r.id + '\\')">edit</button>';
                var delBtn = isNativeReply ? '' : ' <button class="reply-delete-btn" onclick="event.stopPropagation();deleteReply(\\'' + comment.id + '\\',\\'' + r.id + '\\')">\u00d7</button>';
                repliesHtml += '<div class="pop-reply" id="pop-reply-' + r.id + '"><div class="pop-reply-text"><span class="role-badge role-' + (r.role||'user') + '">' + (r.role||'user') + '</span>' + esc(r.text) +
                    editBtn + delBtn + '</div>' +
                    '<div class="pop-reply-meta">' + new Date(r.timestamp).toLocaleString() + '</div></div>';
            });
            repliesHtml += '</div>';
        }
        var editBtn = isPptx ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditComment(\\'' + comment.id + '\\')">edit</button>';
        pop.innerHTML =
            '<div class="pop-text" id="pop-comment-' + comment.id + '">' + authorBadge + esc(comment.comment) + editBtn + '</div>' +
            '<div class="pop-meta">' + new Date(comment.timestamp).toLocaleString() + (comment.resolved ? ' &#x2705;' : '') + '</div>' +
            repliesHtml +
            '<div class="pop-reply-input"><textarea id="pop-reply-input" placeholder="Reply..." rows="2"></textarea>' +
            '<button onclick="submitReply(\\'' + comment.id + '\\')" style="margin-top:4px;">Reply</button>' +
            '<button class="btn-copilot" onclick="askCopilotThread(\\'' + comment.id + '\\')" style="margin-top:4px;">&#x2728; Ask Copilot</button></div>' +
            '<div class="pop-actions">' + resolveBtn +
            '<button onclick="copyComment(\\'' + comment.id + '\\')">&#x1F4CB; Copy</button>' +
            (isPptx ? '' : '<button onclick="deleteComment(\\'' + comment.id + '\\')">Delete</button>') + '</div>';
        var rect = anchorEl.getBoundingClientRect();
        pop.style.top = (rect.bottom + window.scrollY + 5) + 'px';
        pop.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 360) + 'px';
        pop.style.display = 'block';
    }
    document.addEventListener('click', function(e) {
        var pop = document.getElementById('comment-popover');
        if (pop && pop.style.display === 'block' && !pop.contains(e.target) && !e.target.classList.contains('shape-overlay')) {
            pop.style.display = 'none';
        }
    });

    // === Shape overlays ===
    var allOverlays = []; // {el, slideIdx, shapeId, shapeEid}

    function addShapeOverlays(slideEl, slideIdx) {
        var slideShapes = shapeLayouts.filter(function(s) { return s.slideIndex === slideIdx; });
        slideShapes.forEach(function(shape) {
            if (shape.wPct < 1 || shape.hPct < 1) return;
            var overlay = document.createElement('div');
            overlay.className = 'shape-overlay';
            var shapeEid = 'slide_' + slideIdx + '_shape_' + shape.shapeId;
            overlay.setAttribute('data-shape-eid', shapeEid);

            overlay.style.left = shape.xPct + '%';
            overlay.style.top = shape.yPct + '%';
            overlay.style.width = shape.wPct + '%';
            overlay.style.height = shape.hPct + '%';

            // "+" button on hover
            var addBtn = document.createElement('button');
            addBtn.className = 'shape-add-btn';
            addBtn.textContent = '+';
            addBtn.title = shape.name + ': ' + shape.text.substring(0, 30);
            addBtn.onclick = function(e) { e.stopPropagation(); openCommentDialog(slideIdx, shape.shapeId, shape.name, shape.text); };
            overlay.appendChild(addBtn);

            // Click overlay to show popover for existing comments or add new
            (function(eid, si, sid, sname, stext) {
                overlay.onclick = function(e) {
                    if (e.target.classList.contains('shape-add-btn')) return;
                    var sc = comments.filter(function(c) { return c.elementId === eid; });
                    if (sc.length > 0) {
                        showPopover(sc[0], overlay);
                    } else {
                        openCommentDialog(si, sid, sname, stext);
                    }
                };
            })(shapeEid, slideIdx, shape.shapeId, shape.name, shape.text);

            allOverlays.push({ el: overlay, shapeEid: shapeEid });
            slideEl.appendChild(overlay);
        });
    }

    // Refresh overlay highlighting based on current comments
    function refreshOverlays() {
        allOverlays.forEach(function(ov) {
            var shapeComments = comments.filter(function(c) { return c.elementId === ov.shapeEid; });
            var hasUnresolved = shapeComments.some(function(c) { return !c.resolved; });
            var hasResolved = shapeComments.some(function(c) { return c.resolved; });
            if (hasUnresolved) {
                ov.el.classList.add('has-comment');
                ov.el.classList.remove('all-resolved');
            } else if (hasResolved) {
                ov.el.classList.remove('has-comment');
                ov.el.classList.add('all-resolved');
            } else {
                ov.el.classList.remove('has-comment');
                ov.el.classList.remove('all-resolved');
            }
        });
    }

    // === Render slides ===
    var output = document.getElementById('slides-output');

    setStatus('Fetching presentation file...');
    fetch('${pptxFileUri}')
        .then(function(resp) {
            if (!resp.ok) throw new Error('Fetch failed: ' + resp.status + ' ' + resp.statusText);
            setStatus('Rendering slides...');
            return resp.arrayBuffer();
        })
        .then(function(buffer) {
            return PptxLib.PptxViewer.open(buffer, output, {
                renderMode: 'list',
                listOptions: { windowed: true, batchSize: 4, initialSlides: 3 },
                fitMode: 'contain',
                width: 960,
                onSlideRendered: function(idx) {
                    // Fix colors on each slide as it renders
                    var slides = output.children;
                    if (slides[idx]) fixColors(slides[idx]);
                },
            });
        })
        .then(function(viewer) {
            loadingEl.style.display = 'none';
            fixColors(output);

            // Add slide labels and + buttons
            setTimeout(function() {
                var slideEls = Array.from(output.children);
                for (var i = slideEls.length - 1; i >= 0; i--) {
                    var slideIdx = i + 1;
                    // Slide label
                    var label = document.createElement('div');
                    label.className = 'slide-label';
                    label.textContent = 'Slide ' + slideIdx;
                    output.insertBefore(label, slideEls[i]);

                    // Add comment button
                    var wrapper = slideEls[i];
                    wrapper.style.position = 'relative';
                    var addBtn = document.createElement('button');
                    addBtn.className = 'slide-add-comment';
                    addBtn.textContent = '+';
                    addBtn.title = 'Add comment on Slide ' + slideIdx;
                    (function(si) { addBtn.onclick = function(e) { e.stopPropagation(); openCommentDialog(si); }; })(slideIdx);
                    wrapper.appendChild(addBtn);

                    // Add shape overlays for element-level comments
                    (function(el, si) { addShapeOverlays(el, si); })(wrapper, slideIdx);
                }

                // Add notes after each slide
                notesData.forEach(function(nd) {
                    var labels = output.querySelectorAll('.slide-label');
                    for (var j = 0; j < labels.length; j++) {
                        if (labels[j].textContent === 'Slide ' + nd.slideIndex && labels[j].nextElementSibling) {
                            var notesDiv = document.createElement('div');
                            notesDiv.className = 'pptx-notes';
                            notesDiv.innerHTML = '<b>Speaker Notes:</b> ' + esc(nd.notes);
                            labels[j].nextElementSibling.after(notesDiv);
                            break;
                        }
                    }
                });

                // Color fix again for any lazy-loaded slides
                setTimeout(function() { fixColors(output); }, 1000);
                setTimeout(function() { fixColors(output); }, 3000);
            }, 500);

            updateBadge();
        })
        .catch(function(err) {
            document.getElementById('loading').innerHTML = '<b>Error:</b> ' + esc(err.message || String(err)) + '<pre>' + esc(err.stack || '') + '</pre>';
        });

    // === Badge & Sidebar ===
    function updateBadge() {
        var badge = document.getElementById('comment-badge');
        var span = document.getElementById('badge-count');
        var unresolved = comments.filter(function(c) { return !c.resolved; });
        badge.style.display = comments.length > 0 ? 'block' : 'none';
        span.textContent = unresolved.length + ' / ' + comments.length;
    }
    var sidebarOpen = false;
    window.toggleSidebar = function() {
        sidebarOpen = !sidebarOpen;
        document.getElementById('sidebar').classList.toggle('open', sidebarOpen);
        if (sidebarOpen) buildList();
    };

    // === Filter & Bulk actions ===
    var currentFilter = 'all';
    window.setFilter = function(filter) {
        currentFilter = filter;
        var btns = document.querySelectorAll('.panel-filters button');
        btns.forEach(function(btn) {
            btn.style.background = 'transparent';
            btn.style.color = '#ccc';
        });
        var active = document.getElementById('filter-' + filter);
        if (active) { active.style.background = 'var(--vscode-button-background,#0078D4)'; active.style.color = '#fff'; }
        buildList();
    };
    window.resolveAll = function() {
        vscode.postMessage({ command: 'resolveAll' });
    };
    window.deleteAllResolved = function() {
        vscode.postMessage({ command: 'deleteAllResolved' });
    };
    window.sendAllToCopilot = function() {
        vscode.postMessage({ command: 'sendAllToCopilot' });
    };
    window.copyAllToClipboard = function() {
        vscode.postMessage({ command: 'copyAllToClipboard' });
    };

    // === Edit/Delete functions ===
    window.startEditComment = function(id) {
        var c = comments.find(function(x) { return x.id === id; });
        if (!c) return;
        var el = document.getElementById('pop-comment-' + id) || document.getElementById('list-comment-' + id);
        if (!el) return;
        el.innerHTML =
            '<textarea id="edit-input" style="width:100%;min-height:60px;padding:6px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:4px;font-family:inherit;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc(c.comment) + '</textarea>' +
            '<div style="margin-top:6px;display:flex;gap:6px;">' +
            '<button onclick="saveEditComment(\\'' + id + '\\')">Save</button>' +
            '<button onclick="cancelEdit()">Cancel</button></div>';
        var ta = document.getElementById('edit-input');
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    };
    window.saveEditComment = function(id) {
        var input = document.getElementById('edit-input');
        var text = input ? input.value.trim() : '';
        if (!text) return;
        vscode.postMessage({ command: 'editComment', id: id, text: text });
    };
    window.cancelEdit = function() {
        document.getElementById('comment-popover').style.display = 'none';
        buildList();
    };
    window.startEditReply = function(commentId, replyId) {
        var c = comments.find(function(x) { return x.id === commentId; });
        if (!c || !c.replies) return;
        var r = c.replies.find(function(x) { return x.id === replyId; });
        if (!r) return;
        var el = document.getElementById('pop-reply-' + replyId) || document.getElementById('list-reply-item-' + replyId);
        if (!el) return;
        var textEl = el.querySelector('.pop-reply-text') || el.querySelector('.item-reply-text') || el;
        textEl.innerHTML =
            '<textarea id="edit-reply-input" style="width:100%;min-height:40px;padding:4px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:3px;font-family:inherit;font-size:12px;resize:vertical;box-sizing:border-box;">' + esc(r.text) + '</textarea>' +
            '<div style="margin-top:4px;display:flex;gap:4px;">' +
            '<button onclick="saveEditReply(\\'' + commentId + '\\',\\'' + replyId + '\\')">Save</button>' +
            '<button onclick="cancelEdit()">Cancel</button></div>';
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
        vscode.postMessage({ command: 'deleteReply', commentId: commentId, replyId: replyId });
    };

    function buildList() {
        var list = document.getElementById('comment-list');
        list.innerHTML = '';
        var searchInput = document.getElementById('comment-search');
        var searchText = searchInput ? searchInput.value.trim().toLowerCase() : '';
        var filtered = comments.filter(function(c) {
            if (currentFilter === 'open' && c.resolved) return false;
            if (currentFilter === 'resolved' && !c.resolved) return false;
            if (searchText) {
                var haystack = (c.comment + ' ' + (c.blockPreview || '') + ' ' +
                    (c.replies || []).map(function(r) { return r.text; }).join(' ')).toLowerCase();
                if (haystack.indexOf(searchText) < 0) return false;
            }
            return true;
        });
        if (!filtered.length) { list.innerHTML = '<div style="padding:20px;color:#888;text-align:center;">' + (comments.length === 0 ? 'No comments' : 'No matching comments') + '</div>'; return; }
        filtered.forEach(function(c) {
            var div = document.createElement('div');
            var isPptx = c._source === 'pptx';
            div.className = 'clist-item' + (c.resolved ? ' resolved' : '') + (isPptx ? ' pptx-comment' : '');

            var authorBadge = isPptx
                ? '<span class="role-badge role-pptx">' + esc(c._wordAuthor || 'PPT') + '</span>'
                : '<span class="role-badge role-' + (c.role||'user') + '">' + (c.role||'user') + '</span>';

            var editBtn = isPptx ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditComment(\\'' + c.id + '\\')">edit</button>';

            var repliesHtml = '';
            if (c.replies && c.replies.length) {
                repliesHtml = '<div class="item-replies">';
                c.replies.forEach(function(r) {
                    var isNativeReply = r.id && r.id.startsWith('pptx_');
                    var rEditBtn = isNativeReply ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditReply(\\'' + c.id + '\\',\\'' + r.id + '\\')">edit</button>';
                    var rDelBtn = isNativeReply ? '' : ' <button class="reply-delete-btn" onclick="event.stopPropagation();deleteReply(\\'' + c.id + '\\',\\'' + r.id + '\\')">\u00d7</button>';
                    repliesHtml += '<div class="item-reply" id="list-reply-item-' + r.id + '"><div class="item-reply-text"><span class="role-badge role-' + (r.role||'user') + '">' + (r.role||'user') + '</span>' + esc(r.text) +
                        rEditBtn + rDelBtn + '</div>' +
                        '<div class="item-reply-meta" style="font-size:10px;color:#888;">' + new Date(r.timestamp).toLocaleString() + '</div></div>';
                });
                repliesHtml += '</div>';
            }

            var resolveBtn = c.resolved
                ? '<button onclick="event.stopPropagation();unresolveComment(\\'' + c.id + '\\')">Reopen</button>'
                : '<button onclick="event.stopPropagation();resolveComment(\\'' + c.id + '\\')">Resolve</button>';
            var deleteBtn = isPptx ? '' : '<button onclick="event.stopPropagation();deleteComment(\\'' + c.id + '\\')">Delete</button>';

            div.innerHTML =
                '<div class="item-preview">' + esc(c.blockPreview) + '</div>' +
                '<div class="item-comment" id="list-comment-' + c.id + '">' + authorBadge + esc(c.comment) + editBtn + '</div>' +
                '<div class="item-meta">' + new Date(c.timestamp).toLocaleString() + (c.resolved ? ' &#x2705;' : '') + '</div>' +
                repliesHtml +
                '<div class="item-reply-input" onclick="event.stopPropagation()">' +
                '<textarea id="list-reply-' + c.id + '" placeholder="Reply..." rows="1" style="width:100%;margin-top:6px;padding:4px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:3px;font-size:12px;resize:none;box-sizing:border-box;"></textarea>' +
                '<button onclick="event.stopPropagation();submitListReply(\\'' + c.id + '\\')" style="margin-top:4px;">Reply</button>' +
                '<button class="btn-copilot" onclick="event.stopPropagation();askCopilotThread(\\'' + c.id + '\\')" style="margin-top:4px;">&#x2728; Ask Copilot</button></div>' +
                '<div class="item-actions">' + resolveBtn +
                '<button onclick="event.stopPropagation();copyComment(\\'' + c.id + '\\')">&#x1F4CB; Copy</button>' +
                deleteBtn + '</div>';

            div.addEventListener('click', function() {
                var slideNum = (c.elementId || '').replace('slide_', '');
                var labels = output.querySelectorAll('.slide-label');
                for (var j = 0; j < labels.length; j++) {
                    if (labels[j].textContent === 'Slide ' + slideNum) {
                        labels[j].scrollIntoView({ behavior: 'smooth', block: 'start' });
                        break;
                    }
                }
            });
            list.appendChild(div);
        });
    }

    // === Message handler ===
    window.addEventListener('message', function(e) {
        var msg = e.data;
        if (!msg || !msg.command) return;
        switch (msg.command) {
            case 'commentAdded':
                comments.push(msg.comment);
                updateBadge();
                refreshOverlays();
                buildList();
                // Show popover on the shape overlay for the new comment
                var newC = msg.comment;
                var anchor = newC.elementId ? document.querySelector('[data-shape-eid="' + newC.elementId + '"]') : null;
                if (anchor) {
                    showPopover(newC, anchor);
                } else {
                    // Fallback: open sidebar if overlay not found
                    if (!sidebarOpen) {
                        sidebarOpen = true;
                        document.getElementById('sidebar').classList.add('open');
                    }
                }
                break;
            case 'commentUpdated': {
                var idx = comments.findIndex(function(x) { return x.id === msg.comment.id; });
                if (idx >= 0) comments[idx] = msg.comment;
                updateBadge();
                refreshOverlays();
                buildList();
                // Update popover if open for this comment
                var pop = document.getElementById('comment-popover');
                if (pop && pop.style.display === 'block') {
                    var updated = comments.find(function(x) { return x.id === msg.comment.id; });
                    if (updated) {
                        var anchor = document.querySelector('[data-shape-eid="' + updated.elementId + '"]');
                        if (anchor) showPopover(updated, anchor);
                    }
                }
                break;
            }
            case 'commentDeleted':
                comments = comments.filter(function(x) { return x.id !== msg.id; });
                updateBadge();
                refreshOverlays();
                buildList();
                document.getElementById('comment-popover').style.display = 'none';
                break;
            case 'refreshComments':
                comments = msg.comments || [];
                updateBadge();
                refreshOverlays();
                buildList();
                document.getElementById('comment-popover').style.display = 'none';
                break;
            case 'openPopover': {
                var oc = comments.find(function(x) { return x.id === msg.commentId; });
                if (oc) {
                    var oAnchor = oc.elementId ? document.querySelector('[data-shape-eid="' + oc.elementId + '"]') : null;
                    if (oAnchor) showPopover(oc, oAnchor);
                }
                break;
            }
        }
    });

    updateBadge();
})();
</script>
</body>
</html>`;
    }
    /** Rewrite relative image src paths to data URIs or webview URIs */
    private resolveImagePaths(html: string): string {
        const docDir = path.dirname(this.document.uri.fsPath);
        const fs = require('fs');
        return html.replace(/<img\s([^>]*?)src="([^"]+)"/gi, (match, before, src) => {
            // Skip absolute URLs and data URIs
            if (/^(https?:|data:|vscode-resource:)/i.test(src)) { return match; }
            const absPath = path.resolve(docDir, src);
            if (!fs.existsSync(absPath)) { return match; }
            // Use data URI for guaranteed rendering (no CSP/localResourceRoots issues)
            const ext = path.extname(absPath).toLowerCase();
            const mimeMap: Record<string, string> = {
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp',
            };
            const mime = mimeMap[ext] || 'application/octet-stream';
            const base64 = fs.readFileSync(absPath).toString('base64');
            return `<img ${before}src="data:${mime};base64,${base64}"`;
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

        const cspSource = this.panel.webview.cspSource;
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
.word-commented-block { border-left: 4px solid #4caf50; padding-left: 8px; background: rgba(76,175,80,.04); }
.word-commented-block:hover { background: rgba(76,175,80,.08); }

/* ---------- popover ---------- */
#comment-popover {
    display: none; position: absolute;
    background: var(--vscode-editorWidget-background, #252526);
    color: var(--vscode-editorWidget-foreground, #ccc);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 6px; padding: 12px 16px;
    min-width: 250px; max-width: 400px; max-height: 60vh; overflow-y: auto;
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
    z-index: 10;
}
#comment-list-panel .panel-hdr h3 { margin: 0; font-size: 14px; border: none; }
#comment-list-panel .panel-close {
    background: none; border: none; color: #ccc; font-size: 18px; cursor: pointer; padding: 4px 8px;
}
.panel-toolbar {
    padding: 8px 16px; border-bottom: 1px solid #333;
    position: sticky; top: 48px; background: var(--vscode-editorWidget-background, #1e1e1e); z-index: 9;
}
.panel-toolbar input {
    width: 100%; padding: 4px 8px; border: 1px solid #555; background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc); border-radius: 3px; font-size: 12px; box-sizing: border-box;
}
.panel-filters {
    display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap;
}
.panel-filters button {
    padding: 2px 8px; border: 1px solid #555; background: #333; color: #ccc;
    border-radius: 3px; cursor: pointer; font-size: 10px;
}
.panel-filters button:hover { background: #444; }
.panel-filters button.active { background: #0078d4; border-color: #0078d4; color: #fff; }
.panel-bulk {
    display: flex; gap: 4px; margin-top: 6px;
}
.panel-bulk button {
    padding: 2px 8px; border: 1px solid #555; background: #333; color: #ccc;
    border-radius: 3px; cursor: pointer; font-size: 10px;
}
.panel-bulk button:hover { background: #444; }
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
.pop-replies, .item-replies { margin: 8px 0; padding-left: 12px; border-left: 2px solid #555; max-height: 40vh; overflow-y: auto; }
.pop-reply, .item-reply { margin-bottom: 6px; }
.pop-reply-text, .item-reply-text { font-size: 12px; white-space: pre-wrap; }
.pop-reply-meta, .item-reply-meta { font-size: 10px; color: #888; }
.role-badge { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-right: 4px; font-weight: 600; }
.role-user { background: #0078D4; color: #fff; }
.role-agent { background: #68217A; color: #fff; }
.role-word { background: #2e7d32; color: #fff; }
.role-pptx { background: #2196F3; color: #fff; }
.word-comment { border-left: 3px solid #4caf50 !important; }
.word-comment .item-preview { color: #4caf50 !important; }
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
    ${this.isDocx ? `
    <button class="export-btn" onclick="saveDocx()" title="Save changes back to .docx file">&#x1F4BE; Save .docx</button>
    ` : `
    <button class="export-btn" onclick="jumpToSource()" title="Jump to source editor at current scroll position. You can also double-click anywhere in the preview to jump to that block in the source.">&#x2190; Source</button>
    <button class="export-btn" onclick="exportPdf()" title="Export to PDF">&#x1F4C4; PDF</button>
    <button class="export-btn" onclick="exportDocx()" title="Export to DOCX">&#x1F4DD; DOCX</button>
    `}
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
    <div class="panel-toolbar">
        <input type="text" id="comment-search" placeholder="Search comments..." oninput="buildList()">
        <div class="panel-filters">
            <button id="filter-all" class="active" onclick="setFilter('all')">All</button>
            <button id="filter-open" onclick="setFilter('open')">Open</button>
            <button id="filter-resolved" onclick="setFilter('resolved')">Resolved</button>
            <button id="filter-user" onclick="setFilter('user')">User</button>
            <button id="filter-agent" onclick="setFilter('agent')">Agent</button>
        </div>
        <div class="panel-bulk">
            <button onclick="sendAllToCopilot()">&#x2728; Send All to Copilot</button>
            <button onclick="copyAllToClipboard()">&#x1F4CB; Copy All</button>
            <button onclick="resolveAll()">Resolve All</button>
            <button onclick="deleteAllResolved()">Delete Resolved</button>
        </div>
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
    var docMode = '${this.isDocx ? 'docx' : 'markdown'}';
    var pendingBlock = null;   // {startOffset, endOffset, blockType, blockPreview, eid}
    var panelVisible = false;

    // ========== element finder (supports both offset and eid modes) ==========
    function findElement(block) {
        if (block.eid) {
            return document.querySelector('[data-eid="' + block.eid + '"]');
        }
        return document.querySelector('[data-start-offset="' + block.startOffset + '"]');
    }
    function findCommentElement(c) {
        if (c.elementId) {
            return document.querySelector('[data-eid="' + c.elementId + '"]');
        }
        return document.querySelector('[data-start-offset="' + c.startOffset + '"]');
    }

    // ========== gutter "+" buttons ==========
    function placeGutterButtons() {
        var gutter = document.getElementById('gutter');
        var content = document.getElementById('content');
        gutter.innerHTML = '';
        blocks.forEach(function(block) {
            var el = findElement(block);
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
                    blockPreview: block.preview,
                    eid: block.eid || null
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
        // Toggle green Word comment highlights based on resolved state
        document.querySelectorAll('.word-commented-block').forEach(function(el) {
            var wcIds = (el.getAttribute('data-word-comment-ids') || '').split(',');
            // Check if any Word comment on this element is unresolved
            var hasUnresolved = wcIds.some(function(wcId) {
                var wc = comments.find(function(c) { return c.id === 'word_' + wcId; });
                return wc && !wc.resolved;
            });
            if (!hasUnresolved) {
                el.classList.remove('word-commented-block');
                el.classList.add('word-commented-block-resolved');
            } else {
                el.classList.remove('word-commented-block-resolved');
            }
        });
        // Also re-add green class on formerly-resolved blocks that are now unresolved
        document.querySelectorAll('.word-commented-block-resolved').forEach(function(el) {
            var wcIds = (el.getAttribute('data-word-comment-ids') || '').split(',');
            var hasUnresolved = wcIds.some(function(wcId) {
                var wc = comments.find(function(c) { return c.id === 'word_' + wcId; });
                return wc && !wc.resolved;
            });
            if (hasUnresolved) {
                el.classList.remove('word-commented-block-resolved');
                el.classList.add('word-commented-block');
            }
        });
        var content = document.getElementById('content');
        comments.forEach(function(c) {
            if (c.resolved) return;
            if (c._source === 'word') return; // Word comments use green word-commented-block, not yellow
            var el = findCommentElement(c);
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
        // Also attach click handlers for Word-commented blocks
        document.querySelectorAll('.word-commented-block').forEach(function(el) {
            el.onclick = function(e) {
                e.stopPropagation();
                var wcIds = (el.getAttribute('data-word-comment-ids') || '').split(',');
                if (wcIds.length > 0) {
                    var c = comments.find(function(x) { return x.id === 'word_' + wcIds[0]; });
                    if (c) showPopover(c, el);
                }
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
        var isWord = comment._source === 'word';
        var resolveBtn = comment.resolved
            ? '<button onclick="unresolveComment(\\'' + comment.id + '\\')">Reopen</button>'
            : '<button class="btn-resolve" onclick="resolveComment(\\'' + comment.id + '\\')">Resolve</button>';
        var repliesHtml = '';
        if (comment.replies && comment.replies.length > 0) {
            repliesHtml = '<div class="pop-replies">';
            comment.replies.forEach(function(r) {
                var replyBadge = '<span class="role-badge role-' + (r.role || 'user') + '">' + (r.role || 'user') + '</span>';
                var editBtn = isWord ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditReply(\\'' + comment.id + '\\',\\'' + r.id + '\\')">edit</button>';
                var delBtn = isWord ? '' : ' <button class="reply-delete-btn" onclick="event.stopPropagation();deleteReply(\\'' + comment.id + '\\',\\'' + r.id + '\\')">\u00d7</button>';
                repliesHtml += '<div class="pop-reply" id="pop-reply-' + r.id + '"><div class="pop-reply-text">' + replyBadge + esc(r.text) +
                    editBtn + delBtn + '</div>' +
                    '<div class="pop-reply-meta">' + new Date(r.timestamp).toLocaleString() + '</div></div>';
            });
            repliesHtml += '</div>';
        }
        var authorBadge = isWord
            ? '<span class="role-badge role-word">\uD83D\uDCCE ' + esc(comment._wordAuthor || 'Word') + '</span>'
            : '<span class="role-badge role-' + (comment.role || 'user') + '">' + (comment.role || 'user') + '</span>';
        var editBtn = isWord ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditComment(\\'' + comment.id + '\\')">edit</button>';
        pop.innerHTML =
            '<div class="pop-text" id="pop-comment-' + comment.id + '">' + authorBadge + esc(comment.comment) + editBtn + '</div>' +
            '<div class="pop-meta">' + new Date(comment.timestamp).toLocaleString() +
            (comment.resolved ? ' \\u2705 Resolved' : '') + '</div>' +
            repliesHtml +
            '<div class="pop-reply-input"><textarea id="reply-input" placeholder="Reply..." rows="2"></textarea>' +
            '<button onclick="submitReply(\\'' + comment.id + '\\')">Reply</button>' +
            '<button class="btn-copilot" onclick="askCopilotThread(\\'' + comment.id + '\\')">&#x2728; Ask Copilot</button></div>' +
            '<div class="pop-actions">' + resolveBtn +
            '<button onclick="copyComment(\\'' + comment.id + '\\')">&#x1F4CB; Copy</button>' +
            (isWord ? '' : '<button onclick="deleteComment(\\'' + comment.id + '\\')">Delete</button>') + '</div>';
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
            comment: text,
            eid: pendingBlock.eid || null
        });
        hideDialog();
        // optimistic UI: highlight immediately
        var el = findElement(pendingBlock);
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
            comment: text,
            eid: pendingBlock.eid || null
        });
        hideDialog();
        var el = findElement(pendingBlock);
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
            var el = findElement(b);
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
    window.saveDocx = function() {
        vscode.postMessage({ command: 'saveDocxFile' });
    };

    // ========== comment actions ==========
    window.resolveComment = function(id) { vscode.postMessage({ command: 'resolveComment', id: id }); };
    window.deleteComment = function(id) {
        vscode.postMessage({ command: 'deleteComment', id: id });
    };
    window.unresolveComment = function(id) { vscode.postMessage({ command: 'unresolveComment', id: id }); };
    window.submitReply = function(id) {
        var input = document.getElementById('reply-input');
        var text = input ? input.value.trim() : '';
        if (!text) return;
        vscode.postMessage({ command: 'replyComment', id: id, text: text });
    };
    window.submitListReply = function(id) {
        var input = document.getElementById('list-reply-' + id);
        var text = input ? input.value.trim() : '';
        if (!text) return;
        vscode.postMessage({ command: 'replyComment', id: id, text: text });
        input.value = '';
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
        vscode.postMessage({ command: 'deleteReply', commentId: commentId, replyId: replyId });
    };

    // ========== comment list panel ==========
    var currentFilter = 'all';
    window.setFilter = function(filter) {
        currentFilter = filter;
        document.querySelectorAll('.panel-filters button').forEach(function(btn) { btn.classList.remove('active'); });
        document.getElementById('filter-' + filter).classList.add('active');
        buildList();
    };
    window.resolveAll = function() {
        vscode.postMessage({ command: 'resolveAll' });
    };
    window.deleteAllResolved = function() {
        vscode.postMessage({ command: 'deleteAllResolved' });
    };
    window.sendAllToCopilot = function() {
        vscode.postMessage({ command: 'sendAllToCopilot' });
    };
    window.copyAllToClipboard = function() {
        vscode.postMessage({ command: 'copyAllToClipboard' });
    };
    window.copyComment = function(id) {
        vscode.postMessage({ command: 'copyComment', id: id });
    };
    window.togglePanel = function() {
        panelVisible = !panelVisible;
        document.getElementById('comment-list-panel').style.display = panelVisible ? 'block' : 'none';
        if (panelVisible) buildList();
    };
    function buildList() {
        var container = document.getElementById('comment-list-body');
        container.innerHTML = '';
        var searchInput = document.getElementById('comment-search');
        var searchText = searchInput ? searchInput.value.trim().toLowerCase() : '';
        var filtered = comments.filter(function(c) {
            // Status filter
            if (currentFilter === 'open' && c.resolved) return false;
            if (currentFilter === 'resolved' && !c.resolved) return false;
            if (currentFilter === 'user' && c.role === 'agent') return false;
            if (currentFilter === 'agent' && (c.role || 'user') !== 'agent') return false;
            // Search filter
            if (searchText) {
                var haystack = (c.comment + ' ' + (c.blockPreview || '') + ' ' +
                    (c.replies || []).map(function(r) { return r.text; }).join(' ')).toLowerCase();
                if (haystack.indexOf(searchText) < 0) return false;
            }
            return true;
        });
        if (filtered.length === 0) {
            container.innerHTML = '<div style="padding:20px;color:#888;text-align:center;">' +
                (comments.length === 0 ? 'No comments yet' : 'No matching comments') + '</div>';
            return;
        }
        filtered.forEach(function(c) {
            var div = document.createElement('div');
            var isWordComment = c._source === 'word';
            div.className = 'clist-item' + (c.resolved ? ' resolved' : '') + (isWordComment ? ' word-comment' : '');
            var resolveBtn = c.resolved
                ? '<button onclick="event.stopPropagation();unresolveComment(\\'' + c.id + '\\')">Reopen</button>'
                : '<button onclick="event.stopPropagation();resolveComment(\\'' + c.id + '\\')">Resolve</button>';
            var repliesHtml = '';
            if (c.replies && c.replies.length > 0) {
                repliesHtml = '<div class="item-replies">';
                c.replies.forEach(function(r) {
                    repliesHtml += '<div class="item-reply" id="list-reply-' + r.id + '"><div class="item-reply-text"><span class="role-badge role-' + (r.role || 'user') + '">' + (r.role || 'user') + '</span>' + esc(r.text) +
                        (isWordComment ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditReply(\\'' + c.id + '\\',\\'' + r.id + '\\')">edit</button>') +
                        (isWordComment ? '' : ' <button class="reply-delete-btn" onclick="event.stopPropagation();deleteReply(\\'' + c.id + '\\',\\'' + r.id + '\\')">\u00d7</button>') +
                        '</div>' +
                        '<div class="item-reply-meta">' + new Date(r.timestamp).toLocaleString() + '</div></div>';
                });
                repliesHtml += '</div>';
            }
            var authorBadge = isWordComment
                ? '<span class="role-badge role-word">\uD83D\uDCCE ' + esc(c._wordAuthor || 'Word') + '</span>'
                : '<span class="role-badge role-' + (c.role || 'user') + '">' + (c.role || 'user') + '</span>';
            var editBtn = isWordComment ? '' : ' <button class="inline-edit-btn" onclick="event.stopPropagation();startEditComment(\\'' + c.id + '\\')">edit</button>';
            div.innerHTML =
                '<div class="item-preview">' + esc(c.blockPreview || '(block)') + '</div>' +
                '<div class="item-comment" id="list-comment-' + c.id + '">' + authorBadge + esc(c.comment) + editBtn + '</div>' +
                '<div class="item-meta">' + new Date(c.timestamp).toLocaleString() +
                (c.resolved ? ' \\u2705' : '') + '</div>' +
                repliesHtml +
                '<div class="item-reply-input" onclick="event.stopPropagation()">' +
                '<textarea id="list-reply-' + c.id + '" placeholder="Reply..." rows="1" style="width:100%;margin-top:6px;padding:4px;border:1px solid #555;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border-radius:3px;font-family:inherit;font-size:12px;resize:none;box-sizing:border-box;"></textarea>' +
                '<button onclick="event.stopPropagation();submitListReply(\\'' + c.id + '\\')" style="margin-top:4px;">Reply</button>' +
                '<button class="btn-copilot" onclick="event.stopPropagation();askCopilotThread(\\'' + c.id + '\\')" style="margin-top:4px;">&#x2728; Ask Copilot</button></div>' +
                '<div class="item-actions">' + resolveBtn +
                '<button onclick="event.stopPropagation();copyComment(\\'' + c.id + '\\')">&#x1F4CB; Copy</button>' +
                (isWordComment ? '' : '<button onclick="event.stopPropagation();deleteComment(\\'' + c.id + '\\')">Delete</button>') + '</div>';
            div.addEventListener('click', function() {
                var el = findCommentElement(c);
                if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            });
            container.appendChild(div);
        });
    }
    window.buildList = buildList;

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
                        var anchorEl = findCommentElement(updatedComment);
                        if (anchorEl) { showPopover(updatedComment, anchorEl); }
                    }
                }
                break;
            }
            case 'openPopover': {
                var oc = comments.find(function(x) { return x.id === msg.commentId; });
                if (oc) {
                    var ocAnchor = findCommentElement(oc);
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
                var el = findElement(best);
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
        if (commentId.startsWith('word_') && this.isDocx) {
            const merged = this.buildMergedWordComment(commentId);
            if (merged) {
                this.panel.webview.postMessage({ command: 'commentUpdated', comment: merged });
            }
            return;
        }
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

        const refDocPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'reference.docx').fsPath;
        const args = [
            cleanMdPath,
            '-o', docxPath,
            '--from=markdown+tex_math_dollars',
            '--to=docx',
            '--resource-path=' + path.dirname(this.document.uri.fsPath),
        ];
        if (fs.existsSync(refDocPath)) {
            args.push('--reference-doc=' + refDocPath);
        }

        const docDir = path.dirname(this.document.uri.fsPath);
        execFile(pandocPath, args, { timeout: 30000, cwd: docDir }, (err: any) => {
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
        // Check for unsaved XML edits before closing (Word mode only)
        if (this.isDocx && this.docxModel?.documentXmlPath) {
            try {
                const fsModule = require('fs');
                if (fsModule.existsSync(this.docxModel.documentXmlPath)) {
                    const xmlMtime = fsModule.statSync(this.docxModel.documentXmlPath).mtimeMs;
                    if (xmlMtime > this.docxXmlExtractTime) {
                        // XML was modified after extraction — warn about unsaved edits
                        vscode.window.showWarningMessage(
                            'The extracted document.xml has been modified. If you haven\'t saved, your edits may be lost when this preview is reopened.',
                            'Save Document Now',
                            'Open XML File'
                        ).then(async choice => {
                            if (choice === 'Save Document Now') {
                                try {
                                    const { saveDocx } = require('./docx-parser');
                                    const ext = path.extname(this.docxPath);
                                    const defaultPath = this.docxPath.slice(0, -ext.length) + '_reviewed' + ext;
                                    const saveUri = await vscode.window.showSaveDialog({
                                        defaultUri: vscode.Uri.file(defaultPath),
                                        filters: { 'Word Documents': ['docx'] },
                                    });
                                    if (saveUri) {
                                        await saveDocx(this.docxModel, saveUri.fsPath);
                                        vscode.window.showInformationMessage(`Saved to: ${path.basename(saveUri.fsPath)}`);
                                    }
                                } catch (e: any) {
                                    vscode.window.showErrorMessage(`Failed to save: ${e.message}`);
                                }
                            } else if (choice === 'Open XML File') {
                                vscode.workspace.openTextDocument(this.docxModel.documentXmlPath).then(doc => {
                                    vscode.window.showTextDocument(doc);
                                });
                            }
                        });
                    }
                }
            } catch {
                // Don't block dispose on errors
            }
        }

        // Remove from currentPanels using the correct key
        const key = this.isPptx ? this.pptxPath : this.isDocx ? this.docxPath : this.document.uri.fsPath;
        PreviewPanel.currentPanels.delete(key);
        if (this.commentsWatcher) {
            this.commentsWatcher.close();
            this.commentsWatcher = null;
        }
        if (this.commentsDebounceTimer) {
            clearTimeout(this.commentsDebounceTimer);
        }
        if (this.docxXmlWatcher) {
            this.docxXmlWatcher.close();
            this.docxXmlWatcher = null;
        }
        if (this.docxXmlDebounce) {
            clearTimeout(this.docxXmlDebounce);
        }
        this.panel.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    /** Watch extracted document.xml for direct agent edits and refresh preview */
    private setupDocxXmlWatcher() {
        if (!this.isDocx || !this.docxModel?.documentXmlPath) return;
        // Close existing watcher if any (avoid duplicate watchers on re-render)
        if (this.docxXmlWatcher) {
            this.docxXmlWatcher.close();
            this.docxXmlWatcher = null;
        }
        const fsModule = require('fs');
        const xmlPath = this.docxModel.documentXmlPath;
        try {
            this.docxXmlWatcher = fsModule.watch(xmlPath, () => {
                // Debounce — agent may write multiple times quickly
                if (this.docxXmlDebounce) clearTimeout(this.docxXmlDebounce);
                this.docxXmlDebounce = setTimeout(() => {
                    this.docxXmlDebounce = null;
                    // Skip if we just rendered (avoid loop with writeElementXml)
                    if (Date.now() - this.lastRenderTime < 1000) return;
                    log(`[Docx] document.xml changed externally — re-parsing and refreshing preview`);
                    this.updateDocxContent();
                }, 1500);
            });
        } catch {
            // File may not exist yet — that's OK
        }
    }

    /** Watch .comments.json for external changes and update webview */
    private setupCommentsFileWatcher() {
        const fs = require('fs');
        const commentsPath = this.commentsManager.getCommentsPath();
        try {
            this.commentsWatcher = fs.watch(commentsPath, () => {
                // Ignore changes from our own writes (within 1s)
                if (Date.now() - this.commentsManager.lastSaveTime < 1000) {
                    return;
                }
                // Debounce external changes (500ms)
                if (this.commentsDebounceTimer) { clearTimeout(this.commentsDebounceTimer); }
                this.commentsDebounceTimer = setTimeout(() => {
                    this.commentsDebounceTimer = null;
                    // Reload and diff
                    const oldComments = this.commentsManager.getComments().map(c => JSON.stringify(c));
                    this.commentsManager.reload();
                    const newComments = this.commentsManager.getComments();
                    // Send updates for changed/new comments
                    for (const c of newComments) {
                        const oldJson = oldComments.find(o => o.includes(c.id));
                        if (!oldJson || oldJson !== JSON.stringify(c)) {
                            this.panel.webview.postMessage({ command: 'commentUpdated', comment: c });
                        }
                    }
                    // Handle deleted comments — full re-render
                    if (newComments.length < oldComments.length) {
                        if (this.isDocx) {
                            this.updateDocxContent();
                        } else {
                            this.updateContent();
                        }
                    }
                }, 500);
            });
        } catch {
            // File may not exist yet — watch the directory instead
            const dir = path.dirname(commentsPath);
            const basename = path.basename(commentsPath);
            this.commentsWatcher = fs.watch(dir, (eventType: string, filename: string) => {
                if (filename !== basename) { return; }
                if (Date.now() - this.commentsManager.lastSaveTime < 1000) { return; }
                if (this.commentsDebounceTimer) { clearTimeout(this.commentsDebounceTimer); }
                this.commentsDebounceTimer = setTimeout(() => {
                    this.commentsDebounceTimer = null;
                    this.commentsManager.reload();
                    if (this.isDocx) {
                        this.updateDocxContent();
                    } else {
                        this.updateContent();
                    }
                }, 500);
            });
        }
    }
}