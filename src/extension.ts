import * as vscode from 'vscode';
import { PreviewPanel } from './preview';
import { registerTools } from './tools';

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
        })
    );

    // Register Copilot tools
    registerTools(context);
}

export function deactivate() {}
