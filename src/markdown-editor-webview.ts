import {
    EditorController,
    EditorModel,
    EditorView,
    StringValue,
} from '@vscode/markdown-editor';
import '@vscode/markdown-editor/editor.css';
import '@vscode/markdown-editor/themes/vscode-default.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

interface EditorBootstrapData {
    source: string;
    baseline: string;
}

declare global {
    interface Window {
        markdownEditorData: EditorBootstrapData;
    }
}

const vscode = acquireVsCodeApi();
const model = new EditorModel();
model.replaceSourceText(new StringValue(window.markdownEditorData.source));
model.baseline.set(new StringValue(window.markdownEditorData.baseline), undefined, undefined);

const view = new EditorView(model, {
    classNames: ['md-theme-vscode-default'],
    showReadonlyToggle: false,
});
const controller = new EditorController(model, view);
document.getElementById('editor-root')?.appendChild(view.element);
view.autoFocusOnOpen();

model.onWillApplySourceEdit(event => {
    vscode.postMessage({
        command: 'applyMarkdownEditorEdit',
        replacements: event.edit.replacements.map(replacement => ({
            start: replacement.replaceRange.start,
            endExclusive: replacement.replaceRange.endExclusive,
            newText: replacement.newText,
        })),
    });
});

document.getElementById('review-mode')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'exitMarkdownEditor' });
});

window.addEventListener('message', event => {
    if (event.data?.command === 'setMarkdownEditorSource') {
        model.replaceSourceText(new StringValue(event.data.source));
    }
});

window.addEventListener('beforeunload', () => {
    controller.dispose();
    view.dispose();
});