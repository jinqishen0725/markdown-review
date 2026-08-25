const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

function loadCanvasRuntime(directory) {
    const outputPath = path.join(directory, 'canvas-runtime.js');
    esbuild.buildSync({
        entryPoints: [path.resolve(__dirname, '..', 'src', 'canvas-runtime.ts')],
        outfile: outputPath,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        legalComments: 'none',
    });
    return require(outputPath);
}

async function loadCanvasDeclaration(directory) {
    const mockSdkPath = path.join(directory, 'mock-copilot-sdk.ts');
    const outputPath = path.join(directory, 'canvas-extension.mjs');
    fs.writeFileSync(mockSdkPath, `
export class CanvasError extends Error {}
export function createCanvas(config) {
    config.declaration = {};
    return config;
}
export async function joinSession(config) {
    globalThis.__markdownReviewCanvasRegistration = config;
    return {
        workspacePath: undefined,
        on() {},
        log() {},
        send() {},
    };
}
`, 'utf8');
    await esbuild.build({
        entryPoints: [path.resolve(__dirname, '..', 'src', 'canvas-extension.ts')],
        outfile: outputPath,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        alias: { '@github/copilot-sdk/extension': mockSdkPath },
        legalComments: 'none',
    });
    await import(`${pathToFileURL(outputPath).href}?test=${Date.now()}`);
    const registration = globalThis.__markdownReviewCanvasRegistration;
    delete globalThis.__markdownReviewCanvasRegistration;
    return registration;
}

async function post(url, message) {
    const actionUrl = new URL('/action', url);
    actionUrl.searchParams.set('token', new URL(url).searchParams.get('token'));
    const response = await fetch(actionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
    });
    return { status: response.status, body: await response.json() };
}

async function run() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown review canvas '));
    const registration = await loadCanvasDeclaration(tempRoot);
    assert.equal(registration.canvases.length, 1);
    const canvas = registration.canvases[0];
    assert.equal(canvas.id, 'markdown-review');
    assert.equal(canvas.displayName, 'Markdown Review');
    assert.equal(canvas.declaration.icon, 'assets/icon.png');
    assert.equal(typeof canvas.open, 'function');
    assert.equal(typeof canvas.onClose, 'function');
    assert.deepEqual(canvas.actions.map(action => action.name), ['get_state', 'open_file', 'refresh']);

    const {
        buildCanvasState,
        closeInstanceServer,
        createInstanceServer,
        resolveInitialMarkdownPath,
    } = loadCanvasRuntime(tempRoot);
    const markdownPath = path.join(tempRoot, 'review canvas.md');
    fs.writeFileSync(markdownPath, '# Canvas review\n\nA paragraph for feedback.\n', 'utf8');
    const prompts = [];
    const record = await createInstanceServer({
        instanceId: 'canvas-test',
        filePath: markdownPath,
        workingDirectory: tempRoot,
        directPromptAvailable: true,
        sendPrompt: prompt => prompts.push(prompt),
    });

    try {
        assert.equal(resolveInitialMarkdownPath(markdownPath, tempRoot), markdownPath);
        const initialState = buildCanvasState(record);
        assert.equal(initialState.ok, true);
        assert.equal(initialState.fileName, 'review canvas.md');
        assert.equal(initialState.blocks.length, 2);
        assert.equal(initialState.directPromptAvailable, true);
        assert.match(initialState.html, /data-start-offset="0"/);

        const unauthorized = await fetch(new URL('/state', record.url));
        assert.equal(unauthorized.status, 403);

        const panelResponse = await fetch(record.url);
        assert.equal(panelResponse.status, 200);
        const panelHtml = await panelResponse.text();
        assert.match(panelHtml, /Markdown Review/);
        assert.match(panelHtml, /Add Review Comment/);
        assert.match(panelHtml, /Ask Copilot/);

        const paragraph = initialState.blocks.find(block => block.type === 'paragraph');
        const added = await post(record.url, {
            command: 'addComment',
            startOffset: paragraph.startOffset,
            comment: 'Make this paragraph more concrete.',
        });
        assert.equal(added.status, 200);
        assert.equal(added.body.state.comments.length, 1);
        const commentId = added.body.state.comments[0].id;
        assert.match(fs.readFileSync(markdownPath, 'utf8'), new RegExp(`<!--@${commentId}-->\\r?\\nA paragraph`));

        const copied = await post(record.url, { command: 'copyPromptThread', id: commentId });
        assert.equal(copied.status, 200);
        assert.match(copied.body.clipboardText, /docReview_read_comment/);
        assert.match(copied.body.clipboardText, /Make this paragraph more concrete/);

        const asked = await post(record.url, { command: 'askCopilotThread', id: commentId });
        assert.equal(asked.status, 200);
        assert.equal(prompts.length, 1);
        assert.match(prompts[0], /docReview_reply_to_comment/);

        record.sendPrompt = async () => ({ delivered: false, reason: 'empty-session' });
        record.directPromptAvailable = false;
        const emptySessionAsk = await post(record.url, { command: 'askCopilotThread', id: commentId });
        assert.equal(emptySessionAsk.status, 200);
        assert.match(emptySessionAsk.body.message, /Copy it from the panel/);
        assert.match(emptySessionAsk.body.manualCopyText, /docReview_reply_to_comment/);
        assert.equal(emptySessionAsk.body.state, undefined);

        const emptyState = buildCanvasState(record);
        assert.equal(emptyState.directPromptAvailable, false);
        assert.match(panelHtml, /id="new-comment-prompt"/);
        assert.match(panelHtml, /Copy to Start Chat/);
        assert.match(panelHtml, /id="manual-copy-overlay"/);
        assert.match(panelHtml, /Canvas cannot prefill an untouched chat/);

        const replied = await post(record.url, { command: 'replyComment', id: commentId, text: 'I agree.' });
        assert.equal(replied.body.state.comments[0].replies[0].role, 'user');
        assert.equal(replied.body.state.comments[0].replies[0].text, 'I agree.');

        const resolved = await post(record.url, { command: 'resolveComment', id: commentId });
        assert.equal(resolved.body.state.comments[0].resolved, true);
        const deleted = await post(record.url, { command: 'deleteAllResolved' });
        assert.equal(deleted.body.state.comments.length, 0);
        assert.doesNotMatch(fs.readFileSync(markdownPath, 'utf8'), new RegExp(`<!--@${commentId}-->`));
    } finally {
        await closeInstanceServer(record);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    console.log('Agent Plugin Canvas integration tests passed.');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});