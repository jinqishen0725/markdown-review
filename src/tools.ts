import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CommentsManager, Comment } from './comments';
import { PreviewPanel } from './preview';

// ---------- helpers ----------

function getActiveMarkdownPath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'markdown') {
        return editor.document.uri.fsPath;
    }
    // Fallback: check if a preview panel is open
    for (const [key] of PreviewPanel.currentPanels) {
        return key;
    }
    return undefined;
}

function getCommentsManager(): CommentsManager | undefined {
    const mdPath = getActiveMarkdownPath();
    if (!mdPath) { return undefined; }
    return new CommentsManager(mdPath);
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

export class ListCommentsTool implements vscode.LanguageModelTool<{}> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<{}>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const mgr = getCommentsManager();
        if (!mgr) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active markdown document found. Open a markdown file first.')
            ]);
        }
        const comments = mgr.getComments();
        if (comments.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No review comments on this document.')
            ]);
        }
        const summary = comments.map((c, i) => {
            const status = c.resolved ? 'RESOLVED' : 'OPEN';
            const replyCount = c.replies ? c.replies.length : 0;
            return `${i + 1}. [${status}] id=${c.id} | ${c.blockType}: "${c.blockPreview.substring(0, 60)}" | "${c.comment.substring(0, 80)}" | ${replyCount} replies`;
        }).join('\n');
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`${comments.length} review comments:\n${summary}`)
        ]);
    }
}

// ---------- Read Comment ----------

interface IReadCommentParams { commentId: string; }

export class ReadCommentTool implements vscode.LanguageModelTool<IReadCommentParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IReadCommentParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const mgr = getCommentsManager();
        const mdPath = getActiveMarkdownPath();
        if (!mgr || !mdPath) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active markdown document found.')
            ]);
        }
        const comment = mgr.getComments().find(c => c.id === options.input.commentId);
        if (!comment) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment ${options.input.commentId} not found.`)
            ]);
        }
        const context = getMarkdownContext(mdPath, comment.startOffset);
        const repliesText = comment.replies && comment.replies.length > 0
            ? '\n\nReplies:\n' + comment.replies.map((r, i) =>
                `  ${i + 1}. [${r.role || 'user'}] "${r.text}" (${new Date(r.timestamp).toLocaleString()})`
            ).join('\n')
            : '\n\nNo replies.';
        const result =
            `Comment ${comment.id}:\n` +
            `Status: ${comment.resolved ? 'RESOLVED' : 'OPEN'}\n` +
            `Role: ${comment.role || 'user'}\n` +
            `Block type: ${comment.blockType}\n` +
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

interface IReplyParams { commentId: string; text: string; }

export class ReplyToCommentTool implements vscode.LanguageModelTool<IReplyParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IReplyParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const mgr = getCommentsManager();
        if (!mgr) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active markdown document found.')
            ]);
        }
        const reply = mgr.addReply(options.input.commentId, options.input.text, 'agent');
        if (!reply) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment ${options.input.commentId} not found.`)
            ]);
        }
        // Trigger preview refresh
        this.refreshPreview();
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Reply added to comment ${options.input.commentId}.`)
        ]);
    }

    private refreshPreview() {
        for (const [, panel] of PreviewPanel.currentPanels) {
            panel.refresh();
        }
    }
}

// ---------- Resolve Comment ----------

interface IResolveParams { commentId: string; }

export class ResolveCommentTool implements vscode.LanguageModelTool<IResolveParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IResolveParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const mgr = getCommentsManager();
        if (!mgr) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active markdown document found.')
            ]);
        }
        mgr.resolveComment(options.input.commentId);
        this.refreshPreview();
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Comment ${options.input.commentId} marked as resolved.`)
        ]);
    }

    private refreshPreview() {
        for (const [, panel] of PreviewPanel.currentPanels) {
            panel.refresh();
        }
    }
}

// ---------- Delete Comment ----------

interface IDeleteParams { commentId: string; }

export class DeleteCommentTool implements vscode.LanguageModelTool<IDeleteParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDeleteParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const mdPath = getActiveMarkdownPath();
        if (!mdPath) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active markdown document found.')
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

interface IScrollParams { commentId: string; }

export class ScrollToCommentTool implements vscode.LanguageModelTool<IScrollParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IScrollParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const mdPath = getActiveMarkdownPath();
        if (!mdPath) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No active markdown document found.')
            ]);
        }
        const mgr = new CommentsManager(mdPath);
        const comment = mgr.getComments().find(c => c.id === options.input.commentId);
        if (!comment) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Comment ${options.input.commentId} not found.`)
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

export class CaptureScreenshotTool implements vscode.LanguageModelTool<{}> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<{}>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const mdPath = getActiveMarkdownPath();
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
    );
}
