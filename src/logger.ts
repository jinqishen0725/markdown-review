import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Markdown Review');
    }
    return outputChannel;
}

export function log(message: string): void {
    getChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(message: string, error?: any): void {
    const errMsg = error ? `: ${error.message || error}` : '';
    getChannel().appendLine(`[${new Date().toISOString()}] ERROR: ${message}${errMsg}`);
}

export function showChannel(): void {
    getChannel().show(true);
}

export function disposeChannel(): void {
    if (outputChannel) {
        outputChannel.dispose();
        outputChannel = undefined;
    }
}
