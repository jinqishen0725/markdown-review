/**
 * Word (.docx) XML parser.
 * Unzips a .docx file and parses document.xml into a DocumentModel.
 */

import * as path from 'path';
import * as fs from 'fs';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { DocumentModel, DocElement, WordComment } from './document-model';
import { ommlToLatex } from './omml-to-latex';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const MONO_FONTS = ['consolas', 'courier new', 'courier', 'lucida console', 'monaco', 'menlo', 'source code pro', 'fira code', 'cascadia code', 'cascadia mono'];

export async function parseDocx(filePath: string): Promise<DocumentModel> {
    const data = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(data);

    // Parse relationships
    const relationships = new Map<string, string>();
    const relsFile = zip.file('word/_rels/document.xml.rels');
    if (relsFile) {
        const relsXml = new DOMParser().parseFromString(await relsFile.async('string'), 'text/xml');
        const rels = relsXml.getElementsByTagNameNS(RELS_NS, 'Relationship');
        for (let i = 0; i < rels.length; i++) {
            relationships.set(rels[i].getAttribute('Id')!, rels[i].getAttribute('Target')!);
        }
    }

    // Load media files
    const media = new Map<string, Buffer>();
    for (const [name, file] of Object.entries(zip.files)) {
        if (name.startsWith('word/media/') && !file.dir) {
            const buf = await file.async('nodebuffer');
            media.set(name.replace('word/', ''), buf);
        }
    }

    // Parse comments
    const comments = await parseComments(zip);

    // Parse document body
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('No word/document.xml found in the docx file');
    const docXml = new DOMParser().parseFromString(await docFile.async('string'), 'text/xml');
    const body = docXml.getElementsByTagNameNS(W, 'body')[0];
    if (!body) throw new Error('No w:body found in document.xml');

    // Build comment anchor map: commentId → elementId (filled during parsing)
    const commentAnchors = new Map<string, string>();

    const elements = parseBody(body, relationships, media, comments, commentAnchors);

    // Assign elementIds to comments based on anchors
    for (const c of comments) {
        const eid = commentAnchors.get(c.id);
        if (eid) c.elementId = eid;
    }

    return {
        filePath,
        format: 'docx',
        elements,
        comments,
        relationships,
        media,
        rawZip: zip,
    };
}

// ---------- Comment Parser ----------

async function parseComments(zip: JSZip): Promise<WordComment[]> {
    const comments: WordComment[] = [];
    const commentsFile = zip.file('word/comments.xml');
    if (!commentsFile) return comments;

    const xml = new DOMParser().parseFromString(await commentsFile.async('string'), 'text/xml');
    const nodes = xml.getElementsByTagNameNS(W, 'comment');
    for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const tNodes = el.getElementsByTagNameNS(W, 't');
        let text = '';
        for (let j = 0; j < tNodes.length; j++) text += tNodes[j].textContent || '';
        comments.push({
            id: el.getAttribute('w:id') || String(i),
            author: el.getAttribute('w:author') || '',
            date: el.getAttribute('w:date') || '',
            text,
        });
    }

    // Parse threading from commentsExtended.xml
    const extFile = zip.file('word/commentsExtended.xml');
    if (extFile) {
        try {
            const extXml = new DOMParser().parseFromString(await extFile.async('string'), 'text/xml');
            const extNs = 'http://schemas.microsoft.com/office/word/2012/wordml';
            const infos = extXml.getElementsByTagNameNS(extNs, 'commentEx');
            for (let i = 0; i < infos.length; i++) {
                const paraId = infos[i].getAttribute('w15:paraId');
                const parentParaId = infos[i].getAttribute('w15:paraIdParent');
                if (parentParaId) {
                    // Find the comment with this paraId and set its parent
                    // (simplified — full implementation would use paraId mapping)
                }
            }
        } catch {
            // commentsExtended parsing is optional
        }
    }

    return comments;
}

// ---------- Body Parser ----------

function parseBody(
    body: any,
    rels: Map<string, string>,
    media: Map<string, Buffer>,
    comments: WordComment[],
    commentAnchors: Map<string, string>
): DocElement[] {
    const elements: DocElement[] = [];
    let elementCount = 0;
    const activeCommentIds = new Set<string>();

    for (let i = 0; i < body.childNodes.length; i++) {
        const node = body.childNodes[i];
        if (node.nodeType !== 1) continue;
        const tag = node.localName;

        if (tag === 'p') {
            elementCount++;
            const el = parseParagraph(node, `p${elementCount}`, rels, media, activeCommentIds, commentAnchors);
            if (el) elements.push(el);
        } else if (tag === 'tbl') {
            elementCount++;
            const el = parseTable(node, `t${elementCount}`, rels, media);
            if (el) elements.push(el);
        } else if (tag === 'sdt') {
            // Structured document tag — recurse
            const sdtContent = node.getElementsByTagNameNS(W, 'sdtContent');
            if (sdtContent.length > 0) {
                const inner = parseBody(sdtContent[0], rels, media, comments, commentAnchors);
                elements.push(...inner);
            }
        }
    }

    return elements;
}

// ---------- Paragraph Parser ----------

function parseParagraph(
    p: any,
    id: string,
    rels: Map<string, string>,
    media: Map<string, Buffer>,
    activeCommentIds: Set<string>,
    commentAnchors: Map<string, string>
): DocElement | null {
    const pPr = getDirectChild(p, W, 'pPr');
    const headingLevel = detectHeading(pPr);
    const listInfo = detectList(pPr);
    let plainText = '';
    let htmlContent = '';
    let isCode = false;
    const localCommentIds: string[] = [];

    for (let i = 0; i < p.childNodes.length; i++) {
        const child = p.childNodes[i];
        if (child.nodeType !== 1) continue;
        const tag = child.localName;

        if (tag === 'commentRangeStart') {
            const cid = child.getAttribute('w:id');
            if (cid) {
                activeCommentIds.add(cid);
                localCommentIds.push(cid);
                commentAnchors.set(cid, id);
            }
        } else if (tag === 'commentRangeEnd') {
            const cid = child.getAttribute('w:id');
            if (cid) activeCommentIds.delete(cid);
        } else if (tag === 'r') {
            const rPr = getDirectChild(child, W, 'rPr');

            // Check for images
            const drawings = child.getElementsByTagNameNS(W, 'drawing');
            if (drawings.length > 0) {
                const imgHtml = processDrawing(drawings[0], rels, media);
                htmlContent += imgHtml;
                continue;
            }

            // Check if monospace (code)
            if (isMonospaceRun(rPr)) isCode = true;

            const style = runPropsToStyle(rPr);
            const tNodes = child.getElementsByTagNameNS(W, 't');
            for (let j = 0; j < tNodes.length; j++) {
                const text = tNodes[j].textContent || '';
                plainText += text;
                const escaped = escHtml(text);
                if (isCode) {
                    htmlContent += `<code>${escaped.replace(/\$/g, '&#36;')}</code>`;
                } else if (style) {
                    htmlContent += `<span style="${style}">${escaped}</span>`;
                } else {
                    htmlContent += escaped;
                }
            }

            const brs = child.getElementsByTagNameNS(W, 'br');
            if (brs.length > 0) htmlContent += '<br>';
        } else if (tag === 'hyperlink') {
            const rId = child.getAttribute('r:id');
            const href = rels.get(rId || '') || '#';
            const runs = child.getElementsByTagNameNS(W, 't');
            let linkText = '';
            for (let j = 0; j < runs.length; j++) linkText += runs[j].textContent || '';
            plainText += linkText;
            htmlContent += `<a href="${escHtml(href)}" target="_blank">${escHtml(linkText)}</a>`;
        } else if (child.namespaceURI === M) {
            // Inline formula
            const latex = ommlToLatex(child);
            if (latex.trim()) {
                const isBlock = tag === 'oMathPara';
                plainText += latex;
                if (isBlock) {
                    htmlContent += `<span class="math-display">$$${latex}$$</span>`;
                } else {
                    htmlContent += `<span class="math-inline">$${latex}$</span>`;
                }
            }
        }
    }

    // Carry over active comment IDs
    for (const cid of activeCommentIds) {
        if (!localCommentIds.includes(cid)) localCommentIds.push(cid);
    }

    // Determine element type
    let type: DocElement['type'] = 'paragraph';
    let level: number | undefined;
    if (headingLevel > 0) {
        type = 'heading';
        level = headingLevel;
    } else if (listInfo) {
        type = 'list-item';
        level = listInfo.level;
    } else if (isCode) {
        type = 'code-block';
    }

    return {
        id,
        type,
        level,
        content: plainText,
        htmlContent,
        xmlSnippet: '', // Could store for write-back
        commentIds: localCommentIds,
    };
}

// ---------- Table Parser ----------

function parseTable(tbl: any, id: string, rels: Map<string, string>, media: Map<string, Buffer>): DocElement {
    let html = '<table class="word-table">';
    const plainParts: string[] = [];
    const rows = getDirectChildren(tbl, W, 'tr');
    const children: DocElement[] = [];

    rows.forEach((row, ri) => {
        html += '<tr>';
        const cells = getDirectChildren(row, W, 'tc');
        const rowTexts: string[] = [];

        cells.forEach((cell) => {
            const tcPr = getDirectChild(cell, W, 'tcPr');
            let colspan = '';
            if (tcPr) {
                const gridSpan = tcPr.getElementsByTagNameNS(W, 'gridSpan');
                if (gridSpan.length > 0) {
                    const span = gridSpan[0].getAttribute('w:val');
                    if (span && parseInt(span) > 1) colspan = ` colspan="${span}"`;
                }
                const vMerge = tcPr.getElementsByTagNameNS(W, 'vMerge');
                if (vMerge.length > 0 && !vMerge[0].getAttribute('w:val')) return;
            }

            let cellContent = '';
            const paras = getDirectChildren(cell, W, 'p');
            paras.forEach((cp, pi) => {
                const runs = cp.getElementsByTagNameNS(W, 'r');
                for (let r = 0; r < runs.length; r++) {
                    const rPr = getDirectChild(runs[r], W, 'rPr');
                    const style = runPropsToStyle(rPr);
                    const tNodes = runs[r].getElementsByTagNameNS(W, 't');
                    for (let t = 0; t < tNodes.length; t++) {
                        const text = escHtml(tNodes[t].textContent || '');
                        cellContent += style ? `<span style="${style}">${text}</span>` : text;
                    }
                }
                if (pi < paras.length - 1) cellContent += '<br>';
            });

            rowTexts.push(cellContent.replace(/<[^>]+>/g, ''));
            html += `<td${colspan}>${cellContent}</td>`;
        });

        plainParts.push(rowTexts.join(' | '));
        html += '</tr>';
    });

    html += '</table>';

    return {
        id,
        type: 'table',
        content: plainParts.join('\n'),
        htmlContent: html,
        xmlSnippet: '',
        commentIds: [],
        children,
    };
}

// ---------- Image Handler ----------

function processDrawing(drawing: any, rels: Map<string, string>, media: Map<string, Buffer>): string {
    const blips = drawing.getElementsByTagNameNS(A, 'blip');
    if (blips.length === 0) return '<span class="img-placeholder">[Image]</span>';

    const rId = blips[0].getAttribute('r:embed');
    const target = rels.get(rId || '');
    if (!target) return '<span class="img-placeholder">[Image]</span>';

    const mediaPath = target.startsWith('media/') ? target : `media/${target}`;
    const imageData = media.get(mediaPath);
    if (!imageData) return `<span class="img-placeholder">[Image: ${target}]</span>`;

    const ext = path.extname(target).toLowerCase().replace('.', '');
    const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    const b64 = imageData.toString('base64');
    return `<img src="data:${mime};base64,${b64}" style="max-width:100%;height:auto;" alt="${escHtml(target)}">`;
}

// ---------- Helpers ----------

function detectHeading(pPr: any): number {
    if (!pPr) return 0;
    const pStyle = pPr.getElementsByTagNameNS(W, 'pStyle');
    if (pStyle.length === 0) return 0;
    const val = pStyle[0].getAttribute('w:val') || '';
    const m = val.match(/^Heading(\d)$/i);
    if (m) return parseInt(m[1]);
    if (val === 'Title') return 1;
    if (val === 'Subtitle') return 2;
    return 0;
}

function detectList(pPr: any): { level: number; numId: string } | null {
    if (!pPr) return null;
    const numPr = pPr.getElementsByTagNameNS(W, 'numPr');
    if (numPr.length === 0) return null;
    const ilvl = numPr[0].getElementsByTagNameNS(W, 'ilvl');
    const numId = numPr[0].getElementsByTagNameNS(W, 'numId');
    return {
        level: ilvl.length > 0 ? parseInt(ilvl[0].getAttribute('w:val') || '0') : 0,
        numId: numId.length > 0 ? (numId[0].getAttribute('w:val') || '0') : '0',
    };
}

function isMonospaceRun(rPr: any): boolean {
    if (!rPr) return false;
    const fonts = rPr.getElementsByTagNameNS(W, 'rFonts');
    if (fonts.length === 0) return false;
    const ascii = (fonts[0].getAttribute('w:ascii') || '').toLowerCase();
    return MONO_FONTS.some(f => ascii.includes(f));
}

function runPropsToStyle(rPr: any): string {
    if (!rPr) return '';
    const styles: string[] = [];
    if (rPr.getElementsByTagNameNS(W, 'b').length > 0) styles.push('font-weight:bold');
    if (rPr.getElementsByTagNameNS(W, 'i').length > 0) styles.push('font-style:italic');
    if (rPr.getElementsByTagNameNS(W, 'u').length > 0) styles.push('text-decoration:underline');
    if (rPr.getElementsByTagNameNS(W, 'strike').length > 0) styles.push('text-decoration:line-through');
    const sz = rPr.getElementsByTagNameNS(W, 'sz');
    if (sz.length > 0) {
        const val = sz[0].getAttribute('w:val');
        if (val) styles.push(`font-size:${parseInt(val) / 2}pt`);
    }
    const color = rPr.getElementsByTagNameNS(W, 'color');
    if (color.length > 0) {
        const val = color[0].getAttribute('w:val');
        if (val && val !== 'auto') styles.push(`color:#${val}`);
    }
    const highlight = rPr.getElementsByTagNameNS(W, 'highlight');
    if (highlight.length > 0) {
        const val = highlight[0].getAttribute('w:val');
        if (val) styles.push(`background-color:${val}`);
    }
    return styles.join(';');
}

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getDirectChild(parent: any, ns: string, localName: string): any {
    for (let i = 0; i < parent.childNodes.length; i++) {
        const c = parent.childNodes[i];
        if (c.nodeType === 1 && c.localName === localName && c.namespaceURI === ns) return c;
    }
    return null;
}

function getDirectChildren(parent: any, ns: string, localName: string): any[] {
    const result: any[] = [];
    for (let i = 0; i < parent.childNodes.length; i++) {
        const c = parent.childNodes[i];
        if (c.nodeType === 1 && c.localName === localName && c.namespaceURI === ns) result.push(c);
    }
    return result;
}
