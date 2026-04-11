#!/usr/bin/env node
/**
 * MCP Server for Document Review tools.
 * Exposes 11 tools for reviewing markdown and Word documents via the Model Context Protocol
 * so they work in Claude Code, Cursor, Windsurf, and any MCP-compatible AI client.
 *
 * Usage: node mcp-server.js [--document-path <path>]
 * Also supports legacy --markdown-path flag and MARKDOWN_REVIEW_PATH env var.
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

// ---------- Find active document file ----------

function findDocumentPath(): string | undefined {
    // Check command line arg
    const argIdx = process.argv.indexOf('--document-path');
    if (argIdx >= 0 && process.argv[argIdx + 1]) {
        return process.argv[argIdx + 1];
    }
    // Legacy arg
    const legacyIdx = process.argv.indexOf('--markdown-path');
    if (legacyIdx >= 0 && process.argv[legacyIdx + 1]) {
        return process.argv[legacyIdx + 1];
    }
    // Check environment variable
    if (process.env.DOC_REVIEW_PATH) {
        return process.env.DOC_REVIEW_PATH;
    }
    if (process.env.MARKDOWN_REVIEW_PATH) {
        return process.env.MARKDOWN_REVIEW_PATH;
    }
    // Look for .md or .docx files in CWD
    const cwd = process.cwd();
    const docFiles = fs.readdirSync(cwd).filter(f => f.endsWith('.md') || f.endsWith('.docx'));
    if (docFiles.length === 1) {
        return path.join(cwd, docFiles[0]);
    }
    const readme = docFiles.find(f => f.toLowerCase() === 'readme.md');
    if (readme) {
        return path.join(cwd, readme);
    }
    return docFiles.length > 0 ? path.join(cwd, docFiles[0]) : undefined;
}

// ---------- Word XML helpers ----------

function findDocxXmlDir(docxPath: string): string | undefined {
    const dir = path.dirname(docxPath);
    const base = path.basename(docxPath, path.extname(docxPath));
    const xmlDir = path.join(dir, `.${base}_xml`);
    if (fs.existsSync(xmlDir)) return xmlDir;
    return undefined;
}

function readDocumentXml(docxPath: string): string | undefined {
    const xmlDir = findDocxXmlDir(docxPath);
    if (!xmlDir) return undefined;
    const xmlPath = path.join(xmlDir, 'document.xml');
    if (fs.existsSync(xmlPath)) return fs.readFileSync(xmlPath, 'utf-8');
    return undefined;
}

function writeDocumentXml(docxPath: string, content: string): boolean {
    const xmlDir = findDocxXmlDir(docxPath);
    if (!xmlDir) return false;
    const xmlPath = path.join(xmlDir, 'document.xml');
    fs.writeFileSync(xmlPath, content, 'utf-8');
    return true;
}

// ---------- MCP Server ----------

const server = new McpServer({
    name: 'doc-review',
    version: '4.5.0',
});

// Tool 1: List Comments
server.tool(
    'docReview_list_comments',
    'List all review comments on the active document (markdown or Word) with status, context, and reply count',
    {
        filePath: z.string().optional().describe('Path to the document file (markdown or docx). If omitted, auto-detected.'),
    },
    async ({ filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath || !fs.existsSync(docPath)) {
            return { content: [{ type: 'text', text: 'No document found. Provide filePath.' }] };
        }
        const data = loadComments(docPath);
        if (data.comments.length === 0) {
            return { content: [{ type: 'text', text: 'No review comments on this document.' }] };
        }
        const summary = data.comments.map((c, i) => {
            const status = c.resolved ? 'RESOLVED' : 'OPEN';
            const replyCount = c.replies ? c.replies.length : 0;
            const eidInfo = (c as any).elementId ? ` | elementId=${(c as any).elementId}` : '';
            return `${i + 1}. [${status}] id=${c.id}${eidInfo} | ${c.blockType}: "${c.blockPreview.substring(0, 60)}" | "${c.comment.substring(0, 80)}" | ${replyCount} replies`;
        }).join('\n');
        return { content: [{ type: 'text', text: `${data.comments.length} review comments on ${path.basename(docPath)}:\n${summary}` }] };
    }
);

// Tool 2: Read Comment
server.tool(
    'docReview_read_comment',
    'Read a specific review comment with replies and surrounding document context',
    {
        commentId: z.string().describe('The comment ID to read'),
        filePath: z.string().optional().describe('Path to the document file'),
    },
    async ({ commentId, filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath || !fs.existsSync(docPath)) {
            return { content: [{ type: 'text', text: 'No document found.' }] };
        }
        const data = loadComments(docPath);
        const comment = data.comments.find(c => c.id === commentId);
        if (!comment) {
            return { content: [{ type: 'text', text: `Comment ${commentId} not found.` }] };
        }
        const context = docPath.endsWith('.md') ? getMarkdownContext(docPath, comment.startOffset) : '';
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
            ((comment as any).elementId ? `Element ID: ${(comment as any).elementId}\n` : '') +
            `Comment: "${comment.comment}"\n` +
            `Posted: ${new Date(comment.timestamp).toLocaleString()}` +
            repliesText +
            (context ? `\n\nSurrounding context:\n\`\`\`\n${context}\n\`\`\`` : '');
        return { content: [{ type: 'text', text: result }] };
    }
);

// Tool 3: Reply to Comment
server.tool(
    'docReview_reply_to_comment',
    'Reply to a review comment as the agent role',
    {
        commentId: z.string().describe('The comment ID to reply to'),
        text: z.string().describe('The reply text'),
        filePath: z.string().optional().describe('Path to the document file'),
    },
    async ({ commentId, text, filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath || !fs.existsSync(docPath)) {
            return { content: [{ type: 'text', text: 'No document found.' }] };
        }
        const data = loadComments(docPath);
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
        saveComments(docPath, data);
        return { content: [{ type: 'text', text: `Reply added to comment ${commentId}.` }] };
    }
);

// Tool 4: Resolve Comment
server.tool(
    'docReview_resolve_comment',
    'Mark a review comment as resolved',
    {
        commentId: z.string().describe('The comment ID to resolve'),
        filePath: z.string().optional().describe('Path to the document file'),
    },
    async ({ commentId, filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath || !fs.existsSync(docPath)) {
            return { content: [{ type: 'text', text: 'No document found.' }] };
        }
        const data = loadComments(docPath);
        const comment = data.comments.find(c => c.id === commentId);
        if (!comment) {
            return { content: [{ type: 'text', text: `Comment ${commentId} not found.` }] };
        }
        comment.resolved = true;
        saveComments(docPath, data);
        return { content: [{ type: 'text', text: `Comment ${commentId} marked as resolved.` }] };
    }
);

// Tool 5: Delete Comment
server.tool(
    'docReview_delete_comment',
    'Delete a review comment and remove its anchor from the document',
    {
        commentId: z.string().describe('The comment ID to delete'),
        filePath: z.string().optional().describe('Path to the document file'),
    },
    async ({ commentId, filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath || !fs.existsSync(docPath)) {
            return { content: [{ type: 'text', text: 'No document found.' }] };
        }
        const data = loadComments(docPath);
        const idx = data.comments.findIndex(c => c.id === commentId);
        if (idx < 0) {
            return { content: [{ type: 'text', text: `Comment ${commentId} not found.` }] };
        }
        data.comments.splice(idx, 1);
        saveComments(docPath, data);
        // Remove anchor from markdown file (only for .md)
        if (docPath.endsWith('.md')) {
            try {
                let mdText = fs.readFileSync(docPath, 'utf-8');
                const anchorPattern = new RegExp(`<!--@${commentId}-->\\r?\\n?`, 'g');
                mdText = mdText.replace(anchorPattern, '');
                fs.writeFileSync(docPath, mdText, 'utf-8');
            } catch { /* ignore */ }
        }
        return { content: [{ type: 'text', text: `Comment ${commentId} deleted.` }] };
    }
);

// Tool 6: Scroll to Comment (returns location info)
server.tool(
    'docReview_scroll_to_comment',
    'Get the location of a review comment in the document',
    {
        commentId: z.string().describe('The comment ID to locate'),
        filePath: z.string().optional().describe('Path to the document file'),
    },
    async ({ commentId, filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath || !fs.existsSync(docPath)) {
            return { content: [{ type: 'text', text: 'No document found.' }] };
        }
        const data = loadComments(docPath);
        const comment = data.comments.find(c => c.id === commentId);
        if (!comment) {
            return { content: [{ type: 'text', text: `Comment ${commentId} not found.` }] };
        }
        if (docPath.endsWith('.md')) {
            const context = getMarkdownContext(docPath, comment.startOffset, 3);
            return { content: [{ type: 'text', text: `Comment ${commentId} is at offset ${comment.startOffset} in ${docPath}.\n\nContext:\n\`\`\`\n${context}\n\`\`\`` }] };
        }
        return { content: [{ type: 'text', text: `Comment ${commentId} targets element ${(comment as any).elementId || '(unknown)'} in ${docPath}.` }] };
    }
);

// Tool 7: Capture Screenshot
server.tool(
    'docReview_capture_screenshot',
    'Export the rendered document preview as HTML for visual inspection',
    {
        filePath: z.string().optional().describe('Path to the document file'),
    },
    async ({ filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath || !fs.existsSync(docPath)) {
            return { content: [{ type: 'text', text: 'No document found.' }] };
        }
        return { content: [{ type: 'text', text: `To capture a screenshot, use the VS Code extension UI: open the document and use the PDF export button. File: ${docPath}` }] };
    }
);

// Tool 7b: Capture Slide (PPTX)
server.tool(
    'docReview_capture_slide',
    'Capture a specific PowerPoint slide as a PNG image. Requires the PPTX preview panel to be open in VS Code.',
    {
        slideNumber: z.number().describe('The 1-based slide number to capture'),
        filePath: z.string().optional().describe('Path to the .pptx file'),
    },
    async ({ slideNumber, filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath) {
            return { content: [{ type: 'text', text: 'No PPTX file found.' }] };
        }
        return { content: [{ type: 'text', text: `Slide capture requires the VS Code PPTX preview panel. Open the file in VS Code and use #captureSlide to capture slide ${slideNumber}. File: ${docPath}` }] };
    }
);

// Tool 8: Read Element XML (Word .docx)
server.tool(
    'docReview_read_element_xml',
    'Read the raw XML of a specific element (paragraph, heading, etc.) from a Word document. Returns text content and raw XML.',
    {
        elementId: z.string().describe('The element ID (paraId) to read, e.g. "77FE7CF5"'),
        filePath: z.string().optional().describe('Path to the .docx file'),
    },
    async ({ elementId, filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath) {
            return { content: [{ type: 'text', text: 'No document found.' }] };
        }
        const xmlContent = readDocumentXml(docPath);
        if (!xmlContent) {
            return { content: [{ type: 'text', text: 'No extracted document.xml found. Open the .docx in VS Code with the preview extension first.' }] };
        }
        // Find the element by paraId
        const regex = new RegExp(`<w:p[^>]*w14:paraId="${elementId}"[^>]*>([\\s\\S]*?)</w:p>`, 'i');
        const match = xmlContent.match(regex);
        if (!match) {
            return { content: [{ type: 'text', text: `Element ${elementId} not found in document.xml.` }] };
        }
        const fullXml = match[0];
        // Extract text content
        const textMatch = fullXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
        const text = textMatch ? textMatch.map(t => t.replace(/<[^>]+>/g, '')).join('') : '(no text)';
        const xmlDir = findDocxXmlDir(docPath);
        return { content: [{ type: 'text', text: `Element ${elementId}:\nText: "${text}"\nXML file: ${xmlDir ? path.join(xmlDir, 'document.xml') : '(unknown)'}\n\nRaw XML:\n\`\`\`xml\n${fullXml}\n\`\`\`` }] };
    }
);

// Tool 9: Write Element XML (Word .docx)
server.tool(
    'docReview_write_element_xml',
    'Replace the raw XML of a specific element in a Word document. Provide the complete replacement XML including <w:p> tags.',
    {
        elementId: z.string().describe('The element ID (paraId) to replace'),
        newXml: z.string().describe('The complete replacement XML for this element'),
        filePath: z.string().optional().describe('Path to the .docx file'),
    },
    async ({ elementId, newXml, filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath) {
            return { content: [{ type: 'text', text: 'No document found.' }] };
        }
        const xmlContent = readDocumentXml(docPath);
        if (!xmlContent) {
            return { content: [{ type: 'text', text: 'No extracted document.xml found. Open the .docx in VS Code first.' }] };
        }
        const regex = new RegExp(`<w:p[^>]*w14:paraId="${elementId}"[^>]*>[\\s\\S]*?</w:p>`, 'i');
        if (!regex.test(xmlContent)) {
            return { content: [{ type: 'text', text: `Element ${elementId} not found in document.xml.` }] };
        }
        const updated = xmlContent.replace(regex, newXml);
        if (writeDocumentXml(docPath, updated)) {
            return { content: [{ type: 'text', text: `Element ${elementId} updated. Use docReview_save_document to write changes to a .docx file.` }] };
        }
        return { content: [{ type: 'text', text: 'Failed to write document.xml.' }] };
    }
);

// Tool 10: Save Document (Word .docx)
server.tool(
    'docReview_save_document',
    'Save all pending XML edits back to a .docx file. Requires JSZip to be available.',
    {
        filePath: z.string().optional().describe('Path to the source .docx file'),
        outputPath: z.string().optional().describe('Path for the output .docx file. Defaults to filename_reviewed.docx'),
    },
    async ({ filePath, outputPath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath) {
            return { content: [{ type: 'text', text: 'No document found.' }] };
        }
        try {
            const JSZip = require('jszip');
            const zip = await JSZip.loadAsync(fs.readFileSync(docPath));
            const xmlContent = readDocumentXml(docPath);
            if (!xmlContent) {
                return { content: [{ type: 'text', text: 'No extracted document.xml found.' }] };
            }
            zip.file('word/document.xml', xmlContent);
            const output = outputPath || docPath.replace(/\.docx$/, '_reviewed.docx');
            const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
            fs.writeFileSync(output, buf);
            return { content: [{ type: 'text', text: `Document saved to ${output}` }] };
        } catch (e: any) {
            return { content: [{ type: 'text', text: `Save failed: ${e.message}` }] };
        }
    }
);

// Tool 11: List Elements (Word .docx)
server.tool(
    'docReview_list_elements',
    'List all elements (paragraphs, headings, tables) in a Word document with element IDs and text previews.',
    {
        filePath: z.string().optional().describe('Path to the .docx file'),
    },
    async ({ filePath }) => {
        const docPath = filePath || findDocumentPath();
        if (!docPath) {
            return { content: [{ type: 'text', text: 'No document found.' }] };
        }
        const xmlContent = readDocumentXml(docPath);
        if (!xmlContent) {
            return { content: [{ type: 'text', text: 'No extracted document.xml found. Open the .docx in VS Code first.' }] };
        }
        // Extract all paragraphs with paraIds
        const paraRegex = /<w:p[^>]*w14:paraId="([^"]+)"[^>]*>([\s\S]*?)<\/w:p>/gi;
        const elements: string[] = [];
        let m;
        while ((m = paraRegex.exec(xmlContent)) !== null) {
            const eid = m[1];
            const body = m[2];
            // Extract text
            const texts = body.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
            const text = texts ? texts.map(t => t.replace(/<[^>]+>/g, '')).join('') : '';
            // Detect type
            let type = 'paragraph';
            if (/<w:pStyle[^>]*w:val="Heading/i.test(body)) type = 'heading';
            else if (/<w:numPr/i.test(body)) type = 'list-item';
            const preview = text.substring(0, 80) || '(empty)';
            elements.push(`${eid} | ${type} | "${preview}"`);
        }
        return { content: [{ type: 'text', text: `${elements.length} elements in ${path.basename(docPath)}:\n${elements.join('\n')}` }] };
    }
);

// ---------- Start Server ----------

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(console.error);
