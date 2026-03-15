#!/usr/bin/env node
/**
 * MCP Server for Markdown Review tools.
 * Exposes the same 7 tools as the VS Code extension, but via the Model Context Protocol
 * so they work in Cursor, Windsurf, and any MCP-compatible AI client.
 *
 * Usage: node mcp-server.js [--markdown-path <path>]
 * If --markdown-path is not provided, it looks for the active markdown file from env.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

// ---------- Comments Manager (standalone, no vscode dependency) ----------

interface Reply {
    id: string;
    role: 'user' | 'agent';
    text: string;
    timestamp: string;
}

interface Comment {
    id: string;
    anchor: string;
    startOffset: number;
    endOffset: number;
    blockType: string;
    blockPreview: string;
    comment: string;
    role: 'user' | 'agent';
    timestamp: string;
    resolved: boolean;
    replies?: Reply[];
}

interface CommentsFile {
    file: string;
    comments: Comment[];
}

function getCommentsPath(mdPath: string): string {
    const dir = path.dirname(mdPath);
    const base = path.basename(mdPath);
    return path.join(dir, '.' + base + '.comments.json');
}

function loadComments(mdPath: string): CommentsFile {
    const commentsPath = getCommentsPath(mdPath);
    if (fs.existsSync(commentsPath)) {
        return JSON.parse(fs.readFileSync(commentsPath, 'utf-8'));
    }
    return { file: path.basename(mdPath), comments: [] };
}

function saveComments(mdPath: string, data: CommentsFile): void {
    const commentsPath = getCommentsPath(mdPath);
    fs.writeFileSync(commentsPath, JSON.stringify(data, null, 2), 'utf-8');
}

function getMarkdownContext(mdPath: string, startOffset: number, linesAround: number = 5): string {
    try {
        const text = fs.readFileSync(mdPath, 'utf-8');
        const clean = text.replace(/<!--@c\d+-->\r?\n?/g, '');
        const before = clean.substring(0, startOffset);
        const lineNum = before.split('\n').length - 1;
        const lines = clean.split('\n');
        const startLine = Math.max(0, lineNum - linesAround);
        const endLine = Math.min(lines.length, lineNum + linesAround + 1);
        return lines.slice(startLine, endLine).join('\n');
    } catch {
        return '(unable to read file)';
    }
}

// ---------- Find active markdown file ----------

function findMarkdownPath(): string | undefined {
    // Check command line arg
    const argIdx = process.argv.indexOf('--markdown-path');
    if (argIdx >= 0 && process.argv[argIdx + 1]) {
        return process.argv[argIdx + 1];
    }
    // Check environment variable
    if (process.env.MARKDOWN_REVIEW_PATH) {
        return process.env.MARKDOWN_REVIEW_PATH;
    }
    // Look for .md files in CWD
    const cwd = process.cwd();
    const mdFiles = fs.readdirSync(cwd).filter(f => f.endsWith('.md'));
    if (mdFiles.length === 1) {
        return path.join(cwd, mdFiles[0]);
    }
    // Look for README.md
    const readme = mdFiles.find(f => f.toLowerCase() === 'readme.md');
    if (readme) {
        return path.join(cwd, readme);
    }
    return mdFiles.length > 0 ? path.join(cwd, mdFiles[0]) : undefined;
}

// ---------- MCP Server ----------

const server = new McpServer({
    name: 'markdown-review',
    version: '4.0.1',
});

// Tool 1: List Comments
server.tool(
    'listReviewComments',
    'List all review comments on the active markdown document with status, context, and reply count',
    {
        markdownPath: z.string().optional().describe('Path to the markdown file. If omitted, auto-detected.'),
    },
    async ({ markdownPath }) => {
        const mdPath = markdownPath || findMarkdownPath();
        if (!mdPath || !fs.existsSync(mdPath)) {
            return { content: [{ type: 'text', text: 'No markdown file found. Provide markdownPath or open a markdown file.' }] };
        }
        const data = loadComments(mdPath);
        if (data.comments.length === 0) {
            return { content: [{ type: 'text', text: 'No review comments on this document.' }] };
        }
        const summary = data.comments.map((c, i) => {
            const status = c.resolved ? 'RESOLVED' : 'OPEN';
            const replyCount = c.replies ? c.replies.length : 0;
            return `${i + 1}. [${status}] id=${c.id} | ${c.blockType}: "${c.blockPreview.substring(0, 60)}" | "${c.comment.substring(0, 80)}" | ${replyCount} replies`;
        }).join('\n');
        return { content: [{ type: 'text', text: `${data.comments.length} review comments:\n${summary}` }] };
    }
);

// Tool 2: Read Comment
server.tool(
    'readReviewComment',
    'Read a specific review comment with replies and surrounding markdown context',
    {
        commentId: z.string().describe('The comment ID to read'),
        markdownPath: z.string().optional().describe('Path to the markdown file'),
    },
    async ({ commentId, markdownPath }) => {
        const mdPath = markdownPath || findMarkdownPath();
        if (!mdPath || !fs.existsSync(mdPath)) {
            return { content: [{ type: 'text', text: 'No markdown file found.' }] };
        }
        const data = loadComments(mdPath);
        const comment = data.comments.find(c => c.id === commentId);
        if (!comment) {
            return { content: [{ type: 'text', text: `Comment ${commentId} not found.` }] };
        }
        const context = getMarkdownContext(mdPath, comment.startOffset);
        const repliesText = comment.replies && comment.replies.length > 0
            ? '\n\nReplies:\n' + comment.replies.map((r, i) =>
                `  ${i + 1}. [${r.role || 'user'}] "${r.text}" (${new Date(r.timestamp).toLocaleString()})`
            ).join('\n')
            : '\n\nNo replies.';
        const result =
            `Comment ${comment.id}:\n` +
            `Status: ${comment.resolved ? 'RESOLVED' : 'OPEN'}\n` +
            `Role: ${comment.role || 'user'}\n` +
            `Block type: ${comment.blockType}\n` +
            `Comment: "${comment.comment}"\n` +
            `Posted: ${new Date(comment.timestamp).toLocaleString()}` +
            repliesText +
            `\n\nSurrounding context:\n\`\`\`markdown\n${context}\n\`\`\``;
        return { content: [{ type: 'text', text: result }] };
    }
);

// Tool 3: Reply to Comment
server.tool(
    'replyToReviewComment',
    'Reply to a review comment as the agent role',
    {
        commentId: z.string().describe('The comment ID to reply to'),
        text: z.string().describe('The reply text'),
        markdownPath: z.string().optional().describe('Path to the markdown file'),
    },
    async ({ commentId, text, markdownPath }) => {
        const mdPath = markdownPath || findMarkdownPath();
        if (!mdPath || !fs.existsSync(mdPath)) {
            return { content: [{ type: 'text', text: 'No markdown file found.' }] };
        }
        const data = loadComments(mdPath);
        const comment = data.comments.find(c => c.id === commentId);
        if (!comment) {
            return { content: [{ type: 'text', text: `Comment ${commentId} not found.` }] };
        }
        if (!comment.replies) { comment.replies = []; }
        comment.replies.push({
            id: 'r' + Date.now(),
            role: 'agent',
            text,
            timestamp: new Date().toISOString(),
        });
        saveComments(mdPath, data);
        return { content: [{ type: 'text', text: `Reply added to comment ${commentId}.` }] };
    }
);

// Tool 4: Resolve Comment
server.tool(
    'resolveReviewComment',
    'Mark a review comment as resolved',
    {
        commentId: z.string().describe('The comment ID to resolve'),
        markdownPath: z.string().optional().describe('Path to the markdown file'),
    },
    async ({ commentId, markdownPath }) => {
        const mdPath = markdownPath || findMarkdownPath();
        if (!mdPath || !fs.existsSync(mdPath)) {
            return { content: [{ type: 'text', text: 'No markdown file found.' }] };
        }
        const data = loadComments(mdPath);
        const comment = data.comments.find(c => c.id === commentId);
        if (!comment) {
            return { content: [{ type: 'text', text: `Comment ${commentId} not found.` }] };
        }
        comment.resolved = true;
        saveComments(mdPath, data);
        return { content: [{ type: 'text', text: `Comment ${commentId} marked as resolved.` }] };
    }
);

// Tool 5: Delete Comment
server.tool(
    'deleteReviewComment',
    'Delete a review comment and remove its anchor from the markdown file',
    {
        commentId: z.string().describe('The comment ID to delete'),
        markdownPath: z.string().optional().describe('Path to the markdown file'),
    },
    async ({ commentId, markdownPath }) => {
        const mdPath = markdownPath || findMarkdownPath();
        if (!mdPath || !fs.existsSync(mdPath)) {
            return { content: [{ type: 'text', text: 'No markdown file found.' }] };
        }
        const data = loadComments(mdPath);
        const idx = data.comments.findIndex(c => c.id === commentId);
        if (idx < 0) {
            return { content: [{ type: 'text', text: `Comment ${commentId} not found.` }] };
        }
        data.comments.splice(idx, 1);
        saveComments(mdPath, data);
        // Remove anchor from markdown file
        try {
            let mdText = fs.readFileSync(mdPath, 'utf-8');
            const anchorPattern = new RegExp(`<!--@${commentId}-->\\r?\\n?`, 'g');
            mdText = mdText.replace(anchorPattern, '');
            fs.writeFileSync(mdPath, mdText, 'utf-8');
        } catch { /* ignore */ }
        return { content: [{ type: 'text', text: `Comment ${commentId} deleted.` }] };
    }
);

// Tool 6: Scroll to Comment (returns location info for MCP clients)
server.tool(
    'scrollToReviewComment',
    'Get the location of a review comment in the document',
    {
        commentId: z.string().describe('The comment ID to locate'),
        markdownPath: z.string().optional().describe('Path to the markdown file'),
    },
    async ({ commentId, markdownPath }) => {
        const mdPath = markdownPath || findMarkdownPath();
        if (!mdPath || !fs.existsSync(mdPath)) {
            return { content: [{ type: 'text', text: 'No markdown file found.' }] };
        }
        const data = loadComments(mdPath);
        const comment = data.comments.find(c => c.id === commentId);
        if (!comment) {
            return { content: [{ type: 'text', text: `Comment ${commentId} not found.` }] };
        }
        const context = getMarkdownContext(mdPath, comment.startOffset, 3);
        return { content: [{ type: 'text', text: `Comment ${commentId} is at offset ${comment.startOffset} in ${mdPath}.\n\nContext:\n\`\`\`markdown\n${context}\n\`\`\`` }] };
    }
);

// Tool 7: Capture Screenshot (returns file path info)
server.tool(
    'captureReviewScreenshot',
    'Export the rendered markdown preview as HTML for visual inspection',
    {
        markdownPath: z.string().optional().describe('Path to the markdown file'),
    },
    async ({ markdownPath }) => {
        const mdPath = markdownPath || findMarkdownPath();
        if (!mdPath || !fs.existsSync(mdPath)) {
            return { content: [{ type: 'text', text: 'No markdown file found.' }] };
        }
        return { content: [{ type: 'text', text: `To capture a screenshot, use the VS Code/Cursor extension UI: open the markdown file and use the PDF export button. File: ${mdPath}` }] };
    }
);

// ---------- Start Server ----------

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(console.error);
