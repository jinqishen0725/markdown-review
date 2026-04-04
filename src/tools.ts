import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CommentsManager, Comment } from './comments';
import { PreviewPanel } from './preview';

// ---------- helpers ----------

function resolveDocumentPath(explicitPath?: string): string | undefined {
    // 1. Use explicit path if provided
    if (explicitPath) {
        if (path.isAbsolute(explicitPath)) {
            if (fs.existsSync(explicitPath)) return explicitPath;
        }
        for (const folder of vscode.workspace.workspaceFolders || []) {
            const abs = path.join(folder.uri.fsPath, explicitPath);
            if (fs.existsSync(abs)) return abs;
        }
        if (explicitPath.endsWith('.md') || explicitPath.endsWith('.docx')) return explicitPath;
    }
    // 2. Active text editor (markdown only — .docx isn't a TextDocument)
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'markdown') {
        return editor.document.uri.fsPath;
    }
    // 3. Any open preview panel (supports both .md and .docx)
    for (const [key] of PreviewPanel.currentPanels) {
        return key;
    }
    return undefined;
}

function getCommentsManagerFor(filePath?: string): { mgr: CommentsManager; mdPath: string } | undefined {
    const mdPath = resolveDocumentPath(filePath);
    if (!mdPath) return undefined;
    return { mgr: new CommentsManager(mdPath), mdPath };
}

function getMarkdownContext(mdPath: string, startOffset: number, linesAround: number = 5): string {
    try {
        const text = fs.readFileSync(mdPath, 'utf-8');
        const clean = text.replace(/<!--@c\d+-->\r?\n?/g, '');
        // Find the line at startOffset
        const before = clean.substring(0, startOffset);
        const lineNum = before.split('\n').length - 1;
        const lines = clean.split('\n');
        const startLine = Math.max(0, lineNum - linesAround);
        const endLine = Math.min(lines.length, lineNum + linesAround + 1);
        return lines.slice(startLine, endLine).join('\n');
    } catch {
        return '(unable to read file)';
    }
}

// ---------- List Comments ----------

interface IListParams { filePath?: string; }

export class ListCommentsTool implements vscode.LanguageModelTool<IListParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IListParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const resolved = getCommentsManagerFor(options.input?.filePath);
        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No markdown document found. Please retry with the filePath parameter set to the absolute path of the markdown file.')
            ]);
        }
        const { mgr, mdPath } = resolved;
        const comments = mgr.getComments();
        if (comments.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No review comments found on ${path.basename(mdPath)} (${mdPath}). If you expected comments on a different file, retry with the correct filePath parameter.`)
            ]);
        }
        const fileName = path.basename(mdPath);
        const summary = comments.map((c, i) => {
            const status = c.resolved ? 'RESOLVED' : 'OPEN';
            const replyCount = c.replies ? c.replies.length : 0;
            const eidInfo = c.elementId ? ` | elementId=${c.elementId}` : '';
            return `${i + 1}. [${status}] id=${c.id}${eidInfo} | ${c.blockType}: "${c.blockPreview.substring(0, 60)}" | "${c.comment.substring(0, 80)}" | ${replyCount} replies`;
        }).join('\n');
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`${comments.length} review comments on ${fileName} (${mdPath}):\n${summary}`)
        ]);
    }
}

// ---------- Read Comment ----------

interface IReadCommentParams { commentId: string; filePath?: string; }

export class ReadCommentTool implements vscode.LanguageModelTool<IReadCommentParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IReadCommentParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const resolved = getCommentsManagerFor(options.input.filePath);
        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No markdown document found. Please retry with the filePath parameter.')
            ]);
        }
        const { mgr, mdPath } = resolved;
        const comment = mgr.getComments().find(c => c.id === options.input.commentId);
        if (!comment) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment ${options.input.commentId} not found in ${path.basename(mdPath)}. This may be the wrong file — retry with the filePath parameter set to the correct markdown file path.`)
            ]);
        }
        const context = getMarkdownContext(mdPath, comment.startOffset);
        const repliesText = comment.replies && comment.replies.length > 0
            ? '\n\nReplies:\n' + comment.replies.map((r, i) =>
                `  ${i + 1}. [${r.role || 'user'}] "${r.text}" (${new Date(r.timestamp).toLocaleString()})`
            ).join('\n')
            : '\n\nNo replies.';
        const eidLine = comment.elementId ? `\nElement ID (paraId): ${comment.elementId} — use this with readElementXml/writeElementXml to read or edit this element's XML` : '';
        const result =
            `Comment ${comment.id}:\n` +
            `Status: ${comment.resolved ? 'RESOLVED' : 'OPEN'}\n` +
            `Role: ${comment.role || 'user'}\n` +
            `Block type: ${comment.blockType}${eidLine}\n` +
            `Comment: "${comment.comment}"\n` +
            `Posted: ${new Date(comment.timestamp).toLocaleString()}` +
            repliesText +
            `\n\nSurrounding context:\n\`\`\`markdown\n${context}\n\`\`\``;
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(result)
        ]);
    }
}

// ---------- Reply to Comment ----------

interface IReplyParams { commentId: string; text: string; filePath?: string; }

export class ReplyToCommentTool implements vscode.LanguageModelTool<IReplyParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IReplyParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const resolved = getCommentsManagerFor(options.input.filePath);
        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No markdown document found. Please retry with the filePath parameter.')
            ]);
        }
        const { mgr } = resolved;
        const reply = mgr.addReply(options.input.commentId, options.input.text, 'agent');
        if (!reply) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment ${options.input.commentId} not found. The active file may not be the one containing this comment — retry with the filePath parameter set to the correct markdown file path.`)
            ]);
        }
        // Trigger preview refresh without full re-render
        this.refreshPreview(options.input.commentId);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Reply added to comment ${options.input.commentId}.`)
        ]);
    }

    private refreshPreview(commentId: string) {
        for (const [, panel] of PreviewPanel.currentPanels) {
            panel.refreshComment(commentId);
        }
    }
}

// ---------- Resolve Comment ----------

interface IResolveParams { commentId: string; filePath?: string; }

export class ResolveCommentTool implements vscode.LanguageModelTool<IResolveParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IResolveParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const resolved = getCommentsManagerFor(options.input.filePath);
        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No markdown document found. Please retry with the filePath parameter.')
            ]);
        }
        const { mgr } = resolved;
        mgr.resolveComment(options.input.commentId);
        this.refreshPreview(options.input.commentId);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Comment ${options.input.commentId} marked as resolved.`)
        ]);
    }

    private refreshPreview(commentId: string) {
        for (const [, panel] of PreviewPanel.currentPanels) {
            panel.refreshComment(commentId);
        }
    }
}

// ---------- Delete Comment ----------

interface IDeleteParams { commentId: string; filePath?: string; }

export class DeleteCommentTool implements vscode.LanguageModelTool<IDeleteParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDeleteParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const mdPath = resolveDocumentPath(options.input.filePath);
        if (!mdPath) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No markdown document found. Please retry with the filePath parameter.')
            ]);
        }
        // Use the PreviewPanel if available (it handles anchor removal via VS Code API)
        const panel = PreviewPanel.currentPanels.get(mdPath);
        if (panel) {
            await panel.deleteCommentFromTool(options.input.commentId);
        } else {
            // Fallback: just remove from JSON
            const mgr = new CommentsManager(mdPath);
            mgr.deleteComment(options.input.commentId);
        }
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Comment ${options.input.commentId} deleted.`)
        ]);
    }
}

// ---------- Scroll to Comment ----------

interface IScrollParams { commentId: string; filePath?: string; }

export class ScrollToCommentTool implements vscode.LanguageModelTool<IScrollParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IScrollParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const mdPath = resolveDocumentPath(options.input.filePath);
        if (!mdPath) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No markdown document found. Please retry with the filePath parameter.')
            ]);
        }
        const mgr = new CommentsManager(mdPath);
        const comment = mgr.getComments().find(c => c.id === options.input.commentId);
        if (!comment) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment ${options.input.commentId} not found in ${path.basename(mdPath)}. This may be the wrong file — retry with the filePath parameter.`)
            ]);
        }
        const panel = PreviewPanel.currentPanels.get(mdPath);
        if (panel) {
            panel.scrollToOffset(comment.startOffset);
        }
        // Also reveal in editor
        const doc = await vscode.workspace.openTextDocument(mdPath);
        const pos = doc.positionAt(comment.startOffset);
        await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            selection: new vscode.Range(pos, pos),
            preserveFocus: true,
        });
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Scrolled to comment ${options.input.commentId}.`)
        ]);
    }
}

// ---------- Capture Screenshot ----------

interface ICaptureParams { filePath?: string; }

export class CaptureScreenshotTool implements vscode.LanguageModelTool<ICaptureParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ICaptureParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const mdPath = resolveDocumentPath(options.input?.filePath);
        if (!mdPath) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active markdown document found.')
            ]);
        }
        const panel = PreviewPanel.currentPanels.get(mdPath);
        if (!panel) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No preview panel open. Open the markdown review preview first.')
            ]);
        }
        const screenshotPath = path.join(path.dirname(mdPath), '.review-screenshot.html');
        try {
            await panel.captureScreenshot(screenshotPath);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Screenshot saved to: ${screenshotPath}`)
            ]);
        } catch (e: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Failed to capture screenshot: ${e.message}`)
            ]);
        }
    }
}

// ---------- Word Document: Read Element XML ----------

interface IReadElementXmlParams { elementId: string; filePath?: string; }

export class ReadElementXmlTool implements vscode.LanguageModelTool<IReadElementXmlParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IReadElementXmlParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = resolveDocumentPath(options.input.filePath);
        if (!filePath || !filePath.endsWith('.docx')) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('This tool only works with .docx files. Please provide a filePath to a .docx file.')
            ]);
        }
        // Find the open preview panel for this docx
        const panel = PreviewPanel.currentPanels.get(filePath);
        if (!panel || !panel.isDocx || !(panel as any).docxModel) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No open Word preview found. Open the .docx file with "Open Word Document Preview" first.')
            ]);
        }
        const model = (panel as any).docxModel;
        const element = model.elements.find((e: any) => e.id === options.input.elementId);
        if (!element) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Element "${options.input.elementId}" not found. Use listReviewComments or read the document outline to find valid element IDs.`)
            ]);
        }

        // Read the raw XML from the extracted document.xml
        const docXmlPath = model.documentXmlPath;
        if (!docXmlPath || !fs.existsSync(docXmlPath)) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Extracted document.xml not found.')
            ]);
        }
        const docXml = fs.readFileSync(docXmlPath, 'utf-8');
        // Find the paragraph with matching paraId
        const paraIdPattern = new RegExp(`<w:p[^>]*w14:paraId="${options.input.elementId}"[^>]*>[\\s\\S]*?</w:p>`, 'm');
        const match = docXml.match(paraIdPattern);

        const result = `Element ${options.input.elementId} (${element.type}):\n` +
            `Plain text: "${element.content}"\n\n` +
            `Raw XML:\n\`\`\`xml\n${match ? match[0] : '(XML not found — element may be a table or non-paragraph)'}\n\`\`\`\n\n` +
            `Document XML file location: ${docXmlPath}\n` +
            `You can edit this file directly for complex changes.\n\n` +
            `XML EDITING RULES:\n` +
            `1. PRESERVE all w14:paraId attributes on <w:p> elements — review comments are anchored to these IDs\n` +
            `2. When adding NEW <w:p> paragraphs, include w14:paraId with a unique 8-char hex (e.g. w14:paraId="A1B2C3D4" w14:textId="77777777")\n` +
            `3. Do NOT modify <w:commentRangeStart/> or <w:commentRangeEnd/> — those are existing Word comments from other reviewers`;

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(result)
        ]);
    }
}

// ---------- Word Document: Write Element XML ----------

interface IWriteElementXmlParams { elementId: string; newXml: string; filePath?: string; }

export class WriteElementXmlTool implements vscode.LanguageModelTool<IWriteElementXmlParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IWriteElementXmlParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = resolveDocumentPath(options.input.filePath);
        if (!filePath || !filePath.endsWith('.docx')) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('This tool only works with .docx files.')
            ]);
        }
        const panel = PreviewPanel.currentPanels.get(filePath);
        if (!panel || !panel.isDocx || !(panel as any).docxModel) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No open Word preview found.')
            ]);
        }
        const model = (panel as any).docxModel;
        const docXmlPath = model.documentXmlPath;
        if (!docXmlPath || !fs.existsSync(docXmlPath)) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Extracted document.xml not found.')
            ]);
        }

        // Read current XML
        let docXml = fs.readFileSync(docXmlPath, 'utf-8');

        // Find and replace the element
        const paraIdPattern = new RegExp(`<w:p[^>]*w14:paraId="${options.input.elementId}"[^>]*>[\\s\\S]*?</w:p>`, 'm');
        const match = docXml.match(paraIdPattern);
        if (!match) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Element "${options.input.elementId}" not found in document.xml. Cannot replace.`)
            ]);
        }

        // Validate new XML is well-formed
        try {
            const { DOMParser: DP } = require('@xmldom/xmldom');
            new DP().parseFromString(`<root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${options.input.newXml}</root>`, 'text/xml');
        } catch (e: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Invalid XML: ${e.message}. Please fix and retry.`)
            ]);
        }

        // Ensure replacement XML preserves the original paraId
        let newXml = options.input.newXml;
        const eid = options.input.elementId;
        if (!newXml.includes(`w14:paraId="${eid}"`)) {
            // Try to inject paraId into the <w:p> tag
            if (newXml.startsWith('<w:p ')) {
                newXml = newXml.replace('<w:p ', `<w:p w14:paraId="${eid}" w14:textId="77777777" `);
            } else if (newXml.startsWith('<w:p>')) {
                newXml = newXml.replace('<w:p>', `<w:p w14:paraId="${eid}" w14:textId="77777777">`);
            }
        }

        const oldText = model.elements.find((e: any) => e.id === eid)?.content || '';
        docXml = docXml.replace(match[0], newXml);
        fs.writeFileSync(docXmlPath, docXml, 'utf-8');

        // Refresh the preview
        (panel as any).updateDocxContent();

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Element "${options.input.elementId}" updated.\nBefore: "${oldText.substring(0, 100)}..."\nThe preview has been refreshed. Use saveDocument to write the changes back to a .docx file.`)
        ]);
    }
}

// ---------- Word Document: Save Document ----------

interface ISaveDocumentParams { filePath?: string; outputPath?: string; }

export class SaveDocumentTool implements vscode.LanguageModelTool<ISaveDocumentParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ISaveDocumentParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = resolveDocumentPath(options.input?.filePath);
        if (!filePath || !filePath.endsWith('.docx')) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('This tool only works with .docx files.')
            ]);
        }
        const panel = PreviewPanel.currentPanels.get(filePath);
        if (!panel || !panel.isDocx || !(panel as any).docxModel) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No open Word preview found.')
            ]);
        }

        const model = (panel as any).docxModel;
        const { saveDocx } = require('./docx-parser');

        // Determine output path
        let outputPath = options.input?.outputPath;
        if (!outputPath) {
            const ext = path.extname(filePath);
            const base = filePath.slice(0, -ext.length);
            outputPath = `${base}_reviewed${ext}`;
        }

        try {
            const saved = await saveDocx(model, outputPath);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Document saved to: ${saved}\nAll existing Word comments preserved. All images and formatting preserved.`)
            ]);
        } catch (e: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Failed to save: ${e.message}`)
            ]);
        }
    }
}

// ---------- Word Document: List Elements (compact text outline) ----------

interface IListElementsParams { filePath?: string; }

export class ListElementsTool implements vscode.LanguageModelTool<IListElementsParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IListElementsParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const filePath = resolveDocumentPath(options.input?.filePath);
        if (!filePath || !filePath.endsWith('.docx')) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('This tool only works with .docx files. Pass the filePath to a .docx file.')
            ]);
        }
        const panel = PreviewPanel.currentPanels.get(filePath);
        if (!panel || !panel.isDocx || !(panel as any).docxModel) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No open Word preview found. Open the .docx file with "Open Word Document Preview" first.')
            ]);
        }
        const model = (panel as any).docxModel;
        const fileName = path.basename(filePath);

        const typeLabels: Record<string, string> = {
            heading: 'H', paragraph: 'P', table: 'TABLE', image: 'IMG',
            'list-item': 'LI', formula: 'FORMULA', 'code-block': 'CODE',
        };

        const lines: string[] = [];
        lines.push(`Document: ${fileName} (${model.elements.length} elements, ${model.comments.length} Word comments)\n`);

        for (const el of model.elements) {
            const label = typeLabels[el.type] || el.type.toUpperCase();
            const level = el.level ? `${el.level}` : '';
            const tag = el.type === 'heading' ? `${label}${level}` : label;
            const preview = el.content.substring(0, 80).replace(/\n/g, ' ');
            const commentCount = el.commentIds?.length || 0;
            const commentMark = commentCount > 0 ? ` 💬${commentCount}` : '';
            lines.push(`[${tag} id=${el.id}] "${preview}"${commentMark}`);
        }

        lines.push(`\nUse readElementXml(elementId="<id>") to see the raw XML of any element.`);
        lines.push(`Use writeElementXml(elementId, newXml) to edit an element.`);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n'))
        ]);
    }
}

// ---------- Registration ----------

export function registerTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('markdownReview_list_comments', new ListCommentsTool()),
        vscode.lm.registerTool('markdownReview_read_comment', new ReadCommentTool()),
        vscode.lm.registerTool('markdownReview_reply_to_comment', new ReplyToCommentTool()),
        vscode.lm.registerTool('markdownReview_resolve_comment', new ResolveCommentTool()),
        vscode.lm.registerTool('markdownReview_delete_comment', new DeleteCommentTool()),
        vscode.lm.registerTool('markdownReview_scroll_to_comment', new ScrollToCommentTool()),
        vscode.lm.registerTool('markdownReview_capture_screenshot', new CaptureScreenshotTool()),
        vscode.lm.registerTool('markdownReview_read_element_xml', new ReadElementXmlTool()),
        vscode.lm.registerTool('markdownReview_write_element_xml', new WriteElementXmlTool()),
        vscode.lm.registerTool('markdownReview_save_document', new SaveDocumentTool()),
        vscode.lm.registerTool('markdownReview_list_elements', new ListElementsTool()),
    );
}
