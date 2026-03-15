import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
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
    const mcpServerPath = path.join(context.extensionPath, 'out', 'mcp-server.js');
    log('MCP server path: ' + mcpServerPath);

    // Method 1: Try vscode.cursor.mcp.registerServer API
    try {
        const cursorApi = (vscode as any).cursor;
        if (cursorApi && cursorApi.mcp && cursorApi.mcp.registerServer) {
            cursorApi.mcp.registerServer({
                name: 'markdown-review',
                server: { command: 'node', args: [mcpServerPath] },
            });
            log('MCP server registered via vscode.cursor.mcp.registerServer');
        }
    } catch (e) {
        log('cursor.mcp.registerServer error: ' + e);
    }

    // Method 2: Write ~/.cursor/mcp.json for reliable registration
    try {
        const cursorDir = path.join(os.homedir(), '.cursor');
        const mcpJsonPath = path.join(cursorDir, 'mcp.json');
        if (!fs.existsSync(cursorDir)) {
            fs.mkdirSync(cursorDir, { recursive: true });
        }
        let config: any = { mcpServers: {} };
        if (fs.existsSync(mcpJsonPath)) {
            try {
                config = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
                if (!config.mcpServers) { config.mcpServers = {}; }
            } catch { config = { mcpServers: {} }; }
        }
        // Only write if not already configured or path changed
        const existing = config.mcpServers['markdown-review'];
        if (!existing || (existing.args && existing.args[0] !== mcpServerPath)) {
            config.mcpServers['markdown-review'] = {
                command: 'node',
                args: [mcpServerPath],
            };
            fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), 'utf-8');
            log('Wrote MCP config to ' + mcpJsonPath);
            vscode.window.showInformationMessage(
                'Markdown Review MCP tools installed. Reload Cursor and switch to Agent mode to use them.',
                'Reload Now'
            ).then(choice => {
                if (choice === 'Reload Now') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        } else {
            log('MCP config already up-to-date in ' + mcpJsonPath);
        }
    } catch (e) {
        log('Failed to write mcp.json: ' + e);
    }

    // Also try registering Copilot tools as fallback
    try {
        registerTools(context);
    } catch (e) {
        log('Copilot tools registration skipped in Cursor: ' + e);
    }
}

export function deactivate() {
    disposeChannel();
}
