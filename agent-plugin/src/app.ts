import {
    App,
    applyDocumentTheme,
    applyHostFonts,
    applyHostStyleVariables,
    type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

interface Reply {
    role: 'user' | 'agent';
    text: string;
}

interface CommentView {
    id: string;
    blockPreview: string;
    comment: string;
    resolved: boolean;
    replies: Reply[];
    prompt: string;
}

interface BlockView {
    type: string;
    startOffset: number;
    endOffset: number;
    startLine: number;
    preview: string;
    commentIds: string[];
}

interface Snapshot {
    filePath: string;
    fileName: string;
    blocks: BlockView[];
    comments: CommentView[];
}

const app = new App({ name: 'Markdown Review', version: '0.3.0' });
const title = document.getElementById('document-title')!;
const summary = document.getElementById('review-summary')!;
const blocksRoot = document.getElementById('blocks')!;
const commentsRoot = document.getElementById('comments')!;
const status = document.getElementById('status')!;
const refreshButton = document.getElementById('refresh') as HTMLButtonElement;
const commentDialog = document.getElementById('comment-dialog') as HTMLDialogElement;
const dialogPreview = document.getElementById('dialog-preview')!;
const dialogInput = document.getElementById('dialog-input') as HTMLTextAreaElement;
const dialogCancel = document.getElementById('dialog-cancel') as HTMLButtonElement;
const dialogSubmit = document.getElementById('dialog-submit') as HTMLButtonElement;
let snapshot: Snapshot | undefined;
let pendingBlock: BlockView | undefined;

function setStatus(message: string, isError = false): void {
    status.textContent = message;
    status.classList.toggle('error', isError);
}

function applyHostContext(context: McpUiHostContext): void {
    if (context.theme) applyDocumentTheme(context.theme);
    if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
    if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

function readSnapshot(result: CallToolResult): Snapshot | undefined {
    const content = result.structuredContent as Partial<Snapshot> | undefined;
    if (!content || typeof content.filePath !== 'string' || !Array.isArray(content.blocks) || !Array.isArray(content.comments)) {
        return undefined;
    }
    return content as Snapshot;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
    try {
        setStatus('Updating review...');
        const result = await app.callServerTool({ name, arguments: args });
        const next = readSnapshot(result);
        if (next) {
            snapshot = next;
            render();
        }
        setStatus('Review updated.');
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
    }
}

async function copyPrompt(prompt: string, fallback: HTMLTextAreaElement): Promise<void> {
    try {
        await navigator.clipboard.writeText(prompt);
        setStatus('Prompt copied to clipboard.');
    } catch {
        fallback.hidden = false;
        fallback.value = prompt;
        fallback.focus();
        fallback.select();
        setStatus('Clipboard permission was denied. The prompt is selected for manual copying.', true);
    }
}

async function prepareForAgent(comment: CommentView): Promise<void> {
    if (!snapshot) return;
    try {
        await app.updateModelContext({
            content: [{ type: 'text', text: `Reviewing ${comment.id} in ${snapshot.filePath}` }],
            structuredContent: { filePath: snapshot.filePath, commentId: comment.id },
        });
        const result = await app.sendMessage({
            role: 'user',
            content: [{ type: 'text', text: comment.prompt }],
        });
        if (result.isError) throw new Error('The host rejected the prepared prompt.');
        setStatus('Prompt added to the composer. Review it, then send it.');
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
    }
}

function createButton(label: string, action: () => void | Promise<void>, className = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = className;
    button.addEventListener('click', () => void action());
    return button;
}

function openCommentDialog(block: BlockView): void {
    pendingBlock = block;
    dialogPreview.textContent = `${block.type}, line ${block.startLine}: ${block.preview}`;
    dialogInput.value = '';
    commentDialog.showModal();
    dialogInput.focus();
}

function closeCommentDialog(): void {
    pendingBlock = undefined;
    commentDialog.close();
}

function createBlockRow(block: BlockView): HTMLElement {
    const row = document.createElement('div');
    row.className = 'block-row';
    row.dataset.startOffset = String(block.startOffset);

    const addButton = createButton('+', () => openCommentDialog(block), 'add-comment');
    addButton.title = `Add comment to ${block.type} on line ${block.startLine}`;
    addButton.setAttribute('aria-label', addButton.title);

    const content = document.createElement('div');
    content.className = 'block-content';
    const metadata = document.createElement('div');
    metadata.className = 'block-metadata';
    metadata.textContent = `${block.type} · line ${block.startLine}`;
    const preview = document.createElement('div');
    preview.className = 'block-preview';
    preview.textContent = block.preview || '(Empty block)';
    content.append(metadata, preview);

    if (block.commentIds.length > 0) {
        const count = document.createElement('span');
        count.className = 'comment-count';
        count.textContent = `${block.commentIds.length} comment${block.commentIds.length === 1 ? '' : 's'}`;
        content.appendChild(count);
    }

    row.append(addButton, content);
    return row;
}

function createCommentCard(comment: CommentView): HTMLElement {
    const card = document.createElement('article');
    card.className = `comment${comment.resolved ? ' resolved' : ''}`;

    const heading = document.createElement('div');
    heading.className = 'comment-heading';
    const id = document.createElement('strong');
    id.textContent = comment.id;
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = comment.resolved ? 'Resolved' : 'Open';
    heading.append(id, state);

    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.textContent = comment.blockPreview || '(No anchored preview)';
    const body = document.createElement('p');
    body.textContent = comment.comment;

    card.append(heading, preview, body);

    if (comment.replies.length > 0) {
        const replies = document.createElement('div');
        replies.className = 'replies';
        for (const reply of comment.replies) {
            const row = document.createElement('p');
            row.textContent = `${reply.role}: ${reply.text}`;
            replies.appendChild(row);
        }
        card.appendChild(replies);
    }

    const replyRow = document.createElement('div');
    replyRow.className = 'reply-row';
    const replyInput = document.createElement('textarea');
    replyInput.rows = 2;
    replyInput.placeholder = 'Reply to this comment';
    replyRow.append(
        replyInput,
        createButton('Reply', async () => {
            const text = replyInput.value.trim();
            if (!text || !snapshot) return;
            replyInput.value = '';
            await callTool('docReview_reply_to_comment', {
                filePath: snapshot.filePath,
                commentId: comment.id,
                text,
                role: 'user',
            });
        }),
    );

    const promptFallback = document.createElement('textarea');
    promptFallback.className = 'prompt-fallback';
    promptFallback.hidden = true;
    promptFallback.readOnly = true;

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
        createButton('Prepare for Agent', () => prepareForAgent(comment), 'primary'),
        createButton('Copy Prompt', () => copyPrompt(comment.prompt, promptFallback)),
        createButton(comment.resolved ? 'Reopen' : 'Resolve', () => {
            if (!snapshot) return;
            return callTool(
                comment.resolved ? 'docReview_reopen_comment' : 'docReview_resolve_comment',
                { filePath: snapshot.filePath, commentId: comment.id },
            );
        }),
    );

    card.append(replyRow, actions, promptFallback);
    return card;
}

function render(): void {
    blocksRoot.replaceChildren();
    commentsRoot.replaceChildren();
    if (!snapshot) {
        title.textContent = 'Markdown Review';
        summary.textContent = 'Waiting for document data...';
        return;
    }
    title.textContent = snapshot.fileName;
    const openCount = snapshot.comments.filter(comment => !comment.resolved).length;
    summary.textContent = `${openCount} open / ${snapshot.comments.length} total`;
    if (snapshot.blocks.length === 0) {
        const noBlocks = document.createElement('p');
        noBlocks.className = 'empty';
        noBlocks.textContent = 'No commentable Markdown blocks found.';
        blocksRoot.appendChild(noBlocks);
    } else {
        for (const block of snapshot.blocks) {
            blocksRoot.appendChild(createBlockRow(block));
        }
    }
    if (snapshot.comments.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No review comments on this document.';
        commentsRoot.appendChild(empty);
        return;
    }
    for (const comment of snapshot.comments) {
        commentsRoot.appendChild(createCommentCard(comment));
    }
}

app.ontoolresult = result => {
    const next = readSnapshot(result);
    if (next) {
        snapshot = next;
        render();
        setStatus('Review loaded.');
    }
};
app.ontoolinput = params => {
    const filePath = (params.arguments as { filePath?: unknown } | undefined)?.filePath;
    if (typeof filePath === 'string') {
        void callTool('docReview_list_comments', { filePath });
    }
};
app.onhostcontextchanged = applyHostContext;
app.onerror = error => setStatus(String(error), true);

refreshButton.addEventListener('click', () => {
    if (snapshot) void callTool('docReview_list_comments', { filePath: snapshot.filePath });
});
dialogCancel.addEventListener('click', closeCommentDialog);
commentDialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeCommentDialog();
});
dialogSubmit.addEventListener('click', async () => {
    const text = dialogInput.value.trim();
    if (!snapshot || !pendingBlock || !text) return;
    const block = pendingBlock;
    closeCommentDialog();
    await callTool('docReview_add_comment', {
        filePath: snapshot.filePath,
        startOffset: block.startOffset,
        text,
    });
});
dialogInput.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        dialogSubmit.click();
    }
});

render();
app.connect().then(() => {
    const context = app.getHostContext();
    if (context) applyHostContext(context);
}).catch(error => setStatus(String(error), true));