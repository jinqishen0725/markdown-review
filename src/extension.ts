import * as vscode from 'vscode';
import { PreviewPanel } from './preview';
import { registerTools } from './tools';
import { disposeChannel } from './logger';

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

    // Register Copilot tools
    registerTools(context);
}

export function deactivate() {
    disposeChannel();
}
