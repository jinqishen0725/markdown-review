const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const appHtml = fs.readFileSync(path.resolve(__dirname, '..', 'dist', 'review-app.html'), 'utf8');
const prompt = [
    'Review comment c100 on review.md (C:/work/review.md).',
    '',
    'Comment: Make this title specific.',
    'Do not resolve the comment unless I explicitly ask you to resolve it.',
].join('\n');
const snapshot = {
    filePath: 'C:/work/review.md',
    fileName: 'review.md',
    blocks: [
        {
            type: 'heading',
            startOffset: 0,
            endOffset: 13,
            startLine: 1,
            preview: '# Draft title',
            commentIds: ['c100'],
        },
        {
            type: 'paragraph',
            startOffset: 15,
            endOffset: 37,
            startLine: 3,
            preview: 'A paragraph to revise.',
            commentIds: [],
        },
    ],
    comments: [{
        id: 'c100',
        blockPreview: '# Draft title',
        comment: 'Make this title specific.',
        resolved: false,
        replies: [],
        prompt,
    }],
};

async function run() {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: async text => {
                    window.__copiedPrompt = text;
                },
            },
        });
    });
    const page = await context.newPage();
    const browserLogs = [];
    page.on('console', message => browserLogs.push(`console:${message.type()}: ${message.text()}`));
    page.on('pageerror', error => browserLogs.push(`pageerror: ${error.message}`));

    try {
        await page.setContent('<!doctype html><html><body><iframe id="app" sandbox="allow-scripts allow-same-origin"></iframe></body></html>');
        await page.evaluate(({ snapshot }) => {
            window.__hostMessages = [];
            window.__snapshot = snapshot;
            window.addEventListener('message', event => {
                const message = event.data;
                if (!message || message.jsonrpc !== '2.0') return;
                window.__hostMessages.push(message);

                if (message.method === 'ui/initialize' && message.id !== undefined) {
                    event.source.postMessage({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: '2026-01-26',
                            hostCapabilities: {
                                serverTools: {},
                                sandbox: { permissions: { clipboardWrite: {} } },
                            },
                            hostInfo: { name: 'test-host', version: '1.0.0' },
                            hostContext: {
                                theme: 'light',
                                platform: 'desktop',
                                containerDimensions: { maxWidth: 900, maxHeight: 800 },
                            },
                        },
                    }, '*');
                    return;
                }

                if (message.method === 'ui/notifications/initialized') {
                    event.source.postMessage({
                        jsonrpc: '2.0',
                        method: 'ui/notifications/tool-input',
                        params: { arguments: { filePath: window.__snapshot.filePath } },
                    }, '*');
                    event.source.postMessage({
                        jsonrpc: '2.0',
                        method: 'ui/notifications/tool-result',
                        params: {
                            content: [{ type: 'text', text: 'Review loaded.' }],
                            structuredContent: window.__snapshot,
                        },
                    }, '*');
                    return;
                }

                if (message.method === 'tools/call' && message.id !== undefined) {
                    if (message.params.name === 'docReview_add_comment') {
                        const added = {
                            id: 'c200',
                            blockPreview: 'A paragraph to revise.',
                            comment: message.params.arguments.text,
                            resolved: false,
                            replies: [],
                            prompt: `Review comment c200: ${message.params.arguments.text}`,
                        };
                        window.__snapshot.comments.push(added);
                        window.__snapshot.blocks[1].commentIds.push(added.id);
                    }
                    event.source.postMessage({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            content: [{ type: 'text', text: 'Review updated.' }],
                            structuredContent: window.__snapshot,
                        },
                    }, '*');
                    return;
                }

                if (message.id !== undefined && (
                    message.method === 'ui/update-model-context' ||
                    message.method === 'ui/message'
                )) {
                    event.source.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
                }
            });
        }, { snapshot });

        await page.locator('#app').evaluate((iframe, html) => { iframe.srcdoc = html; }, appHtml);
        const frame = page.frames().find(candidate => candidate !== page.mainFrame());
        assert.ok(frame, 'MCP App iframe was not created.');

        try {
            await frame.getByText('Make this title specific.').waitFor({ timeout: 5000 });
        } catch (error) {
            const hostMessages = await page.evaluate(() => window.__hostMessages);
            const frameHtml = await frame.locator('body').innerHTML().catch(() => '(body unavailable)');
            throw new Error([
                error instanceof Error ? error.message : String(error),
                `Host messages: ${JSON.stringify(hostMessages)}`,
                `Browser logs: ${browserLogs.join(' | ')}`,
                `Frame body: ${frameHtml.slice(0, 1000)}`,
            ].join('\n'));
        }
        assert.equal(await frame.locator('#document-title').textContent(), 'review.md');
        assert.equal(await frame.locator('#review-summary').textContent(), '1 open / 1 total');
        const initialListCall = await page.evaluate(() => window.__hostMessages.find(message =>
            message.method === 'tools/call' && message.params?.name === 'docReview_list_comments'));
        assert.ok(initialListCall, 'MCP App did not self-load from the tool input file path.');
        assert.equal(await frame.getByRole('button', { name: /Add comment to/ }).count(), 2);

        await frame.getByRole('button', { name: 'Add comment to paragraph on line 3' }).click();
        await frame.getByRole('dialog').waitFor();
        await frame.locator('#dialog-input').fill('Clarify this paragraph.');
        await frame.getByRole('button', { name: 'Add comment', exact: true }).click();
        await frame.getByText('Clarify this paragraph.').waitFor();
        assert.equal(await frame.locator('#review-summary').textContent(), '2 open / 2 total');

        const addCall = await page.evaluate(() => window.__hostMessages.find(message =>
            message.method === 'tools/call' && message.params?.name === 'docReview_add_comment'));
        assert.ok(addCall, 'Add comment did not call the MCP tool.');
        assert.deepEqual(addCall.params.arguments, {
            filePath: 'C:/work/review.md',
            startOffset: 15,
            text: 'Clarify this paragraph.',
        });

        await frame.getByRole('button', { name: 'Copy Prompt' }).first().click();
        assert.equal(await frame.evaluate(() => window.__copiedPrompt), prompt);

        await frame.getByRole('button', { name: 'Prepare for Agent' }).first().click();
        await frame.getByText('Prompt added to the composer. Review it, then send it.').waitFor();

        const messages = await page.evaluate(() => window.__hostMessages);
        const contextIndex = messages.findIndex(message => message.method === 'ui/update-model-context');
        const messageIndex = messages.findIndex(message => message.method === 'ui/message');
        assert.ok(contextIndex >= 0, 'Prepare action did not update model context.');
        assert.ok(messageIndex > contextIndex, 'Composer message must follow the context update.');
        assert.equal(messages[messageIndex].params.content[0].text, prompt);

        await page.setViewportSize({ width: 360, height: 700 });
        const widths = await frame.locator('.comment, .block-row').evaluateAll(elements =>
            elements.map(element => element.getBoundingClientRect().width));
        assert.ok(widths.every(width => width <= 360), `Review content overflowed the mobile viewport: ${widths.join(', ')}px`);
    } finally {
        await browser.close();
    }

    console.log('Agent Plugin MCP App bridge tests passed.');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});