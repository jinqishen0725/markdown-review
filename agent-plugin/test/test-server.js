const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const sourcePlugin = path.join(repoRoot, 'agent-plugin');

function writeFixture(directory) {
    const markdownPath = path.join(directory, 'review fixture.md');
    fs.writeFileSync(markdownPath, '<!--@c100-->\n# Draft title\n\nA paragraph to revise.\n', 'utf8');
    fs.writeFileSync(
        path.join(directory, '.review fixture.md.comments.json'),
        JSON.stringify({
            file: 'review fixture.md',
            comments: [{
                id: 'c100',
                anchor: '<!--@c100-->',
                startOffset: 0,
                endOffset: 13,
                blockType: 'heading',
                blockPreview: '# Draft title',
                comment: 'Make this title specific.',
                role: 'user',
                timestamp: '2026-08-11T00:00:00.000Z',
                resolved: false,
                replies: [],
            }],
        }, null, 2),
        'utf8',
    );
    return markdownPath;
}

async function run() {
    const pluginManifest = JSON.parse(fs.readFileSync(path.join(sourcePlugin, 'plugin.json'), 'utf8'));
    assert.equal(pluginManifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    assert.equal(pluginManifest.name, 'markdown-review');
    const mcpManifest = JSON.parse(fs.readFileSync(path.join(sourcePlugin, 'mcp.json'), 'utf8'));
    assert.equal(mcpManifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    assert.deepEqual(mcpManifest.mcpServers['markdown-review'].args, ['${PLUGIN_ROOT}/dist/server.js']);
    assert.equal(mcpManifest.mcpServers['markdown-review'].cwd, '${PLUGIN_ROOT}');
    assert.equal(fs.existsSync(path.join(sourcePlugin, 'skills', 'document-review', 'SKILL.md')), true);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown review agent '));
    const stagedPlugin = path.join(tempRoot, 'plugin with spaces');
    fs.mkdirSync(stagedPlugin, { recursive: true });
    for (const name of ['plugin.json', 'mcp.json', 'README.md']) {
        fs.copyFileSync(path.join(sourcePlugin, name), path.join(stagedPlugin, name));
    }
    fs.cpSync(path.join(sourcePlugin, 'dist'), path.join(stagedPlugin, 'dist'), { recursive: true });
    fs.cpSync(path.join(sourcePlugin, 'skills'), path.join(stagedPlugin, 'skills'), { recursive: true });

    const markdownPath = writeFixture(tempRoot);
    const serverPath = path.join(stagedPlugin, 'dist', 'server.js');
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        cwd: stagedPlugin,
        stderr: 'pipe',
    });
    const stderr = [];
    transport.stderr.on('data', chunk => stderr.push(String(chunk)));
    const client = new Client({ name: 'markdown-review-test', version: '1.0.0' });

    try {
        await client.connect(transport);

        const listed = await client.listTools();
        const tools = new Map(listed.tools.map(tool => [tool.name, tool]));
        const expected = [
            'docReview_add_comment',
            'docReview_list_comments',
            'docReview_read_comment',
            'docReview_reply_to_comment',
            'docReview_resolve_comment',
            'docReview_reopen_comment',
            'docReview_delete_comment',
            'docReview_open_review',
        ];
        assert.deepEqual([...tools.keys()].sort(), expected.sort());
        assert.equal(tools.get('docReview_list_comments').annotations.readOnlyHint, true);
        assert.equal(tools.get('docReview_delete_comment').annotations.destructiveHint, true);
        assert.equal(tools.get('docReview_open_review')._meta.ui.resourceUri, 'ui://markdown-review/review-v3.html');

        const openResult = await client.callTool({
            name: 'docReview_open_review',
            arguments: { filePath: markdownPath },
        });
        assert.equal(openResult.structuredContent.fileName, 'review fixture.md');
        assert.equal(openResult.structuredContent.comments[0].id, 'c100');
        assert.match(openResult.structuredContent.comments[0].prompt, /Do not resolve/);
        assert.equal(openResult.structuredContent.blocks.length, 2);
        assert.equal(openResult.structuredContent.blocks[0].type, 'heading');
        assert.deepEqual(openResult.structuredContent.blocks[0].commentIds, ['c100']);
        assert.equal(openResult.structuredContent.blocks[1].type, 'paragraph');

        const addResult = await client.callTool({
            name: 'docReview_add_comment',
            arguments: {
                filePath: markdownPath,
                startOffset: openResult.structuredContent.blocks[1].startOffset,
                text: 'Clarify this paragraph.',
            },
        });
        assert.equal(addResult.structuredContent.comments.length, 2);
        const addedComment = addResult.structuredContent.comments.find(comment => comment.comment === 'Clarify this paragraph.');
        assert.ok(addedComment, 'New comment was not returned.');
        assert.match(fs.readFileSync(markdownPath, 'utf8'), new RegExp(`<!--@${addedComment.id}-->\\r?\\nA paragraph to revise\\.`));
        const persisted = JSON.parse(fs.readFileSync(path.join(tempRoot, '.review fixture.md.comments.json'), 'utf8'));
        assert.equal(persisted.comments.some(comment => comment.id === addedComment.id), true);

        const staleResult = await client.callTool({
            name: 'docReview_add_comment',
            arguments: { filePath: markdownPath, startOffset: 999999, text: 'Stale comment.' },
        });
        assert.equal(staleResult.isError, true);
        assert.match(staleResult.content[0].text, /stale or no longer exists/);

        const resource = await client.readResource({ uri: 'ui://markdown-review/review-v3.html' });
        assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
        assert.match(resource.contents[0].text, /Prepare for Agent/);
        assert.match(resource.contents[0].text, /Copy Prompt/);
        assert.doesNotMatch(resource.contents[0].text, /<script>\/\*__APP_SCRIPT__\*\/<\/script>/);

        const readResult = await client.callTool({
            name: 'docReview_read_comment',
            arguments: { filePath: markdownPath, commentId: 'c100' },
        });
        assert.match(readResult.structuredContent.context, /Draft title/);

        const replyResult = await client.callTool({
            name: 'docReview_reply_to_comment',
            arguments: { filePath: markdownPath, commentId: 'c100', text: 'Updated.', role: 'agent' },
        });
        assert.equal(replyResult.structuredContent.comments[0].replies[0].text, 'Updated.');

        const resolveResult = await client.callTool({
            name: 'docReview_resolve_comment',
            arguments: { filePath: markdownPath, commentId: 'c100' },
        });
        assert.equal(resolveResult.structuredContent.comments[0].resolved, true);

        const reopenResult = await client.callTool({
            name: 'docReview_reopen_comment',
            arguments: { filePath: markdownPath, commentId: 'c100' },
        });
        assert.equal(reopenResult.structuredContent.comments[0].resolved, false);

        const deleteResult = await client.callTool({
            name: 'docReview_delete_comment',
            arguments: { filePath: markdownPath, commentId: 'c100' },
        });
        assert.equal(deleteResult.structuredContent.comments.length, 1);
        assert.doesNotMatch(fs.readFileSync(markdownPath, 'utf8'), /<!--@c100-->/);

        const invalidResult = await client.callTool({
            name: 'docReview_list_comments',
            arguments: { filePath: path.join(tempRoot, 'wrong.txt') },
        });
        assert.equal(invalidResult.isError, true);
        assert.match(invalidResult.content[0].text, /Only Markdown/);
    } finally {
        await client.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    assert.equal(stderr.join('').trim(), '', `Server wrote unexpected stderr: ${stderr.join('')}`);
    console.log('Agent Plugin MCP integration tests passed.');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});