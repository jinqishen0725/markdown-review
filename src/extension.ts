import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { PreviewPanel } from './preview';
import { registerTools } from './tools';
import { disposeChannel, log } from './logger';

const MARKDOWN_REVIEW_VIEW_TYPE = 'markdownReview.previewEditor';
const MARKDOWN_FILE_PATTERN = '*.md';
const DEFAULT_EDITOR_PROMPT_KEY = 'markdownReview.defaultEditorPrompt.v1';

function isCursor(): boolean {
    return vscode.env.appName?.toLowerCase().includes('cursor') || false;
}

async function setAsDefaultMarkdownEditor(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('workbench');
    const inspected = configuration.inspect<Record<string, string>>('editorAssociations');
    const userAssociations = { ...(inspected?.globalValue || {}) };
    userAssociations[MARKDOWN_FILE_PATTERN] = MARKDOWN_REVIEW_VIEW_TYPE;
    await configuration.update(
        'editorAssociations',
        userAssociations,
        vscode.ConfigurationTarget.Global,
    );
    vscode.window.showInformationMessage(
        'Markdown Review is now the default editor for Markdown files.',
    );
}

async function promptForDefaultMarkdownEditor(context: vscode.ExtensionContext): Promise<void> {
    if (context.globalState.get<boolean>(DEFAULT_EDITOR_PROMPT_KEY)) {
        return;
    }

    const associations = vscode.workspace
        .getConfiguration('workbench')
        .get<Record<string, string>>('editorAssociations', {});
    if (associations[MARKDOWN_FILE_PATTERN] === MARKDOWN_REVIEW_VIEW_TYPE) {
        await context.globalState.update(DEFAULT_EDITOR_PROMPT_KEY, true);
        return;
    }

    await context.globalState.update(DEFAULT_EDITOR_PROMPT_KEY, true);
    const choice = await vscode.window.showInformationMessage(
        'Open Markdown files with Markdown Review by default? You can switch back anytime with Reopen Editor With.',
        'Set as Default',
        'Keep Current Default',
    );
    if (choice === 'Set as Default') {
        try {
            await setAsDefaultMarkdownEditor();
        } catch (error) {
            log(`Failed to set Markdown Review as the default editor: ${error}`);
            vscode.window.showErrorMessage('Could not update the default Markdown editor setting.');
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            MARKDOWN_REVIEW_VIEW_TYPE,
            {
                resolveCustomTextEditor(document, panel) {
                    PreviewPanel.createInCustomEditor(context, document, panel);
                },
            },
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            },
        ),

        vscode.commands.registerCommand('markdownReview.openPreview', async (uri?: vscode.Uri) => {
            let document: vscode.TextDocument | undefined;
            if (uri?.scheme === 'file' && uri.fsPath.toLowerCase().endsWith('.md')) {
                document = await vscode.workspace.openTextDocument(uri);
            } else {
                const editor = vscode.window.activeTextEditor;
                if (editor?.document.languageId === 'markdown') {
                    document = editor.document;
                }
            }
            if (!document) {
                vscode.window.showWarningMessage('Open or select a Markdown file first.');
                return;
            }
            PreviewPanel.createOrShow(context, document);
        }),

        vscode.commands.registerCommand('markdownReview.setAsDefaultEditor', async () => {
            try {
                await setAsDefaultMarkdownEditor();
                await context.globalState.update(DEFAULT_EDITOR_PROMPT_KEY, true);
            } catch (error) {
                log(`Failed to set Markdown Review as the default editor: ${error}`);
                vscode.window.showErrorMessage('Could not update the default Markdown editor setting.');
            }
        }),

        vscode.commands.registerCommand('markdownReview.openWordPreview', async (uri?: vscode.Uri) => {
            let docxPath: string | undefined;
            if (uri) {
                docxPath = uri.fsPath;
            } else {
                const files = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectMany: false,
                    filters: { 'Word Documents': ['docx'] },
                });
                if (files && files.length > 0) docxPath = files[0].fsPath;
            }
            if (!docxPath) return;
            if (!docxPath.toLowerCase().endsWith('.docx')) {
                vscode.window.showWarningMessage('Only .docx files are supported.');
                return;
            }
            PreviewPanel.createOrShowDocx(context, docxPath);
        }),

        vscode.commands.registerCommand('markdownReview.openPptxPreview', async (uri?: vscode.Uri) => {
            let pptxPath: string | undefined;
            if (uri) {
                pptxPath = uri.fsPath;
            } else {
                const files = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectMany: false,
                    filters: { 'PowerPoint Presentations': ['pptx'] },
                });
                if (files && files.length > 0) pptxPath = files[0].fsPath;
            }
            if (!pptxPath) return;
            if (!pptxPath.toLowerCase().endsWith('.pptx')) {
                vscode.window.showWarningMessage('Only .pptx files are supported.');
                return;
            }
            PreviewPanel.createOrShowPptx(context, pptxPath);
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
        void promptForDefaultMarkdownEditor(context);
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
