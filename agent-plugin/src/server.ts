#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
    addComment,
    addReply,
    deleteComment,
    listComments,
    readComment,
    setResolved,
} from './review-store';

function textResult(message: string, structuredContent: object) {
    return {
        content: [{ type: 'text' as const, text: message }],
        structuredContent: { ...structuredContent },
    };
}

export function createServer(): McpServer {
    const server = new McpServer(
        { name: 'markdown-review-agent', version: '0.4.0' },
        {
            instructions: 'Use these tools for Markdown review comments. Read a comment before editing, reply after editing, and never resolve comments unless the user explicitly asks.',
        },
    );

    server.registerTool(
        'docReview_add_comment',
        {
            title: 'Add Markdown Review Comment',
            description: 'Add a review comment to a current Markdown block and insert its anchor into the file.',
            inputSchema: {
                filePath: z.string().describe('Absolute path to a Markdown file.'),
                startOffset: z.number().int().nonnegative().describe('Clean Markdown start offset from the latest review snapshot.'),
                text: z.string().min(1).describe('Review comment text.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async ({ filePath, startOffset, text }) => {
            const snapshot = addComment(filePath, startOffset, text);
            return textResult('Review comment added.', snapshot);
        },
    );

    server.registerTool(
        'docReview_list_comments',
        {
            title: 'List Markdown Review Comments',
            description: 'List review comments and prepared prompts for one Markdown file.',
            inputSchema: { filePath: z.string().describe('Absolute path to a Markdown file.') },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ filePath }) => {
            const snapshot = listComments(filePath);
            return textResult(`${snapshot.comments.length} review comment(s) on ${snapshot.fileName}.`, snapshot);
        },
    );

    server.registerTool(
        'docReview_read_comment',
        {
            title: 'Read Markdown Review Comment',
            description: 'Read one review comment, its thread, and nearby Markdown context.',
            inputSchema: {
                filePath: z.string().describe('Absolute path to a Markdown file.'),
                commentId: z.string().describe('Review comment ID.'),
            },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ filePath, commentId }) => {
            const result = readComment(filePath, commentId);
            return textResult(
                `Comment ${commentId}: ${result.comment.comment}\n\nContext:\n${result.context}`,
                result,
            );
        },
    );

    server.registerTool(
        'docReview_reply_to_comment',
        {
            title: 'Reply To Markdown Review Comment',
            description: 'Add a reply to a Markdown review comment. Agents should use role=agent; the review UI uses role=user.',
            inputSchema: {
                filePath: z.string().describe('Absolute path to a Markdown file.'),
                commentId: z.string().describe('Review comment ID.'),
                text: z.string().min(1).describe('Reply text.'),
                role: z.enum(['user', 'agent']).optional().describe('Reply author role. Defaults to agent.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async ({ filePath, commentId, text, role }) => {
            const snapshot = addReply(filePath, commentId, text, role);
            return textResult(`Reply added to ${commentId}.`, snapshot);
        },
    );

    server.registerTool(
        'docReview_resolve_comment',
        {
            title: 'Resolve Markdown Review Comment',
            description: 'Mark a Markdown review comment resolved. Use only when the user explicitly asks.',
            inputSchema: {
                filePath: z.string().describe('Absolute path to a Markdown file.'),
                commentId: z.string().describe('Review comment ID.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async ({ filePath, commentId }) => {
            const snapshot = setResolved(filePath, commentId, true);
            return textResult(`Comment ${commentId} resolved.`, snapshot);
        },
    );

    server.registerTool(
        'docReview_reopen_comment',
        {
            title: 'Reopen Markdown Review Comment',
            description: 'Mark a resolved Markdown review comment open again.',
            inputSchema: {
                filePath: z.string().describe('Absolute path to a Markdown file.'),
                commentId: z.string().describe('Review comment ID.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async ({ filePath, commentId }) => {
            const snapshot = setResolved(filePath, commentId, false);
            return textResult(`Comment ${commentId} reopened.`, snapshot);
        },
    );

    server.registerTool(
        'docReview_delete_comment',
        {
            title: 'Delete Markdown Review Comment',
            description: 'Permanently delete a review comment and its Markdown anchor.',
            inputSchema: {
                filePath: z.string().describe('Absolute path to a Markdown file.'),
                commentId: z.string().describe('Review comment ID.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
        async ({ filePath, commentId }) => {
            const snapshot = deleteComment(filePath, commentId);
            return textResult(`Comment ${commentId} deleted.`, snapshot);
        },
    );

    return server;
}

async function main(): Promise<void> {
    await createServer().connect(new StdioServerTransport());
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}