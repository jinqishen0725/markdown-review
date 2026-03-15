import * as vscode from 'vscode';
import * as path from 'path';
import { PreviewPanel } from './preview';
import { registerTools } from './tools';
import { disposeChannel, log } from './logger';

function isCursor(): boolean {
    return vscode.env.appName?.toLowerCase().includes('cursor') || false;
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('markdownReview.openPreview', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'markdown') {
                vscode.window.showWarningMessage('Open a Markdown file first.');
                return;
            }
            PreviewPanel.createOrShow(context, editor.document);
        }),

        vscode.commands.registerCommand('markdownReview.exportComments', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const commentsUri = vscode.Uri.file(editor.document.uri.fsPath + '.comments.json');
            try {
                const doc = await vscode.workspace.openTextDocument(commentsUri);
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            } catch {
                vscode.window.showInformationMessage('No comments file found for this document.');
            }
        }),

        vscode.commands.registerCommand('markdownReview.jumpToSource', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'markdown') {
                const panel = PreviewPanel.currentPanels.get(editor.document.uri.fsPath);
                if (panel) {
                    const cursorOffset = editor.document.offsetAt(editor.selection.active);
                    panel.scrollToOffset(cursorOffset);
                } else {
                    vscode.window.showInformationMessage('Open the review preview first.');
                }
            }
        }),

        vscode.commands.registerCommand('markdownReview.jumpToPreview', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'markdown') {
                const panel = PreviewPanel.currentPanels.get(editor.document.uri.fsPath);
                if (panel) {
                    const cursorOffset = editor.document.offsetAt(editor.selection.active);
                    panel.scrollToOffset(cursorOffset);
                    panel.reveal();
                } else {
                    // Open preview first, then it auto-syncs
                    PreviewPanel.createOrShow(context, editor.document);
                }
            }
        }),
    );

    if (isCursor()) {
        log('Detected Cursor IDE — registering MCP server');
        registerMcpInCursor(context);
    } else {
        log('Detected VS Code — registering Copilot tools');
        registerTools(context);
    }
}

function registerMcpInCursor(context: vscode.ExtensionContext) {
    try {
        const mcpServerPath = path.join(context.extensionPath, 'out', 'mcp-server.js');
        const cursorApi = (vscode as any).cursor;
        if (cursorApi && cursorApi.mcp && cursorApi.mcp.registerServer) {
            cursorApi.mcp.registerServer({
                name: 'markdown-review',
                server: {
                    command: 'node',
                    args: [mcpServerPath],
                },
            });
            log('MCP server registered via vscode.cursor.mcp.registerServer');
        } else {
            // Fallback: try registering Copilot tools anyway (some Cursor versions may support it)
            log('vscode.cursor.mcp not available, falling back to Copilot tools registration');
            try {
                registerTools(context);
            } catch (e) {
                log('Copilot tools registration failed in Cursor: ' + e);
            }
        }
    } catch (e) {
        log('MCP registration error: ' + e);
    }
}

export function deactivate() {
    disposeChannel();
}
