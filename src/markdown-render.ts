const { unified } = require('unified');
const remarkParse = require('remark-parse').default || require('remark-parse');
const remarkMath = require('remark-math').default || require('remark-math');
const remarkGfm = require('remark-gfm').default || require('remark-gfm');
const remarkRehype = require('remark-rehype').default || require('remark-rehype');
const rehypeKatex = require('rehype-katex').default || require('rehype-katex');
const rehypeStringify = require('rehype-stringify').default || require('rehype-stringify');
const rehypeRaw = require('rehype-raw').default || require('rehype-raw');

export interface Block {
    type: string;
    startOffset: number;
    endOffset: number;
    startLine: number;
    preview: string;
    eid?: string;
}

export interface MarkdownRenderResult {
    html: string;
    blocks: Block[];
    anchorMap: Map<string, number>;
    cleanText: string;
}

const BLOCK_TYPES = new Set([
    'heading', 'paragraph', 'listItem', 'blockquote', 'table', 'math', 'code', 'thematicBreak',
]);

function collectBlocks(tree: any, source: string): Block[] {
    const blocks: Block[] = [];
    function walk(node: any) {
        if (BLOCK_TYPES.has(node.type) && node.position) {
            const startOffset = node.position.start.offset as number;
            const endOffset = node.position.end.offset as number;
            const raw = source.substring(startOffset, Math.min(endOffset, startOffset + 120));
            blocks.push({
                type: node.type,
                startOffset,
                endOffset,
                startLine: node.position.start.line,
                preview: raw.replace(/\n/g, ' ').trim().substring(0, 80),
            });
        }
        for (const child of node.children || []) {
            walk(child);
        }
    }
    walk(tree);
    return blocks;
}

function rehypeSourcePositions() {
    return (tree: any) => visit(tree);

    function visit(node: any) {
        if (node.type === 'element' && node.position) {
            node.properties ||= {};
            node.properties['data-start-offset'] = node.position.start.offset;
            node.properties['data-end-offset'] = node.position.end.offset;
        }
        for (const child of node.children || []) {
            visit(child);
        }
    }
}

export function renderMarkdownDocument(text: string): MarkdownRenderResult {
    const anchorMap = new Map<string, number>();
    let cleanText = '';
    let lastEnd = 0;
    const anchorPattern = /<!--@(c\d+)-->\r?\n?/g;
    let match: RegExpExecArray | null;
    while ((match = anchorPattern.exec(text)) !== null) {
        cleanText += text.substring(lastEnd, match.index);
        anchorMap.set(match[1], cleanText.length);
        lastEnd = match.index + match[0].length;
    }
    cleanText += text.substring(lastEnd);

    const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
    const blocks = collectBlocks(parser.parse(cleanText), cleanText);
    const processor = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkMath)
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehypeRaw)
        .use(rehypeKatex, { throwOnError: false })
        .use(rehypeSourcePositions)
        .use(rehypeStringify, { allowDangerousHtml: true });

    return {
        html: String(processor.processSync(cleanText)),
        blocks,
        anchorMap,
        cleanText,
    };
}