/**
 * PowerPoint (.pptx) parser.
 * Extracts slides, shapes, text, images, comments, and notes from a .pptx file.
 */

import * as fs from 'fs';
import * as path from 'path';

// Namespaces
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P188 = 'http://schemas.microsoft.com/office/powerpoint/2018/8/main';
const PC = 'http://schemas.microsoft.com/office/powerpoint/2013/main/command';

// ---------- Model ----------

export interface PptxShape {
    id: string;
    name: string;
    type: 'text' | 'picture' | 'table' | 'group' | 'chart' | 'other';
    x: number;  // EMU
    y: number;
    cx: number; // width in EMU
    cy: number;
    text: string;
    htmlContent: string;
    paragraphs: PptxParagraph[];
    placeholderType?: string; // title, body, subTitle, etc.
    geometry?: string;        // preset geometry: rect, roundRect, rightArrow, downArrow, etc.
    imageData?: string;       // base64 data URI
    tableHtml?: string;
    fillColor?: string;
    borderColor?: string;
    bodyInsets?: { l: number; t: number; r: number; b: number }; // EMU insets from bodyPr
    fontScale?: number;       // normAutofit fontScale percentage (e.g., 90 = 90%)
}

export interface PptxParagraph {
    text: string;
    level: number;      // indent level (0-based)
    alignment?: string; // l, ctr, r
    isBullet: boolean;
    fontSize?: number;  // in hundredths of a point
    bold?: boolean;
    runs: PptxRun[];
}

export interface PptxRun {
    text: string;
    bold?: boolean;
    italic?: boolean;
    fontSize?: number;
    color?: string;
    underline?: boolean;
}

export interface PptxSlide {
    index: number;      // 1-based
    slideId: string;    // from presentation.xml
    shapes: PptxShape[];
    notes: string;      // speaker notes text
    notesHtml: string;
}

export interface PptxComment {
    id: string;
    authorId: string;
    authorName: string;
    created: string;
    text: string;
    slideId: string;     // sldId from presentation.xml
    slideIndex: number;  // 1-based
    shapeId?: string;
    parentId?: string;   // for threaded replies
}

export interface PptxModel {
    filePath: string;
    slides: PptxSlide[];
    comments: PptxComment[];
    authors: Map<string, string>;  // authorId → name
    dimensions: { cx: number; cy: number }; // EMU
    rawZip: any;  // JSZip instance for re-zipping
}

// ---------- Parser ----------

export async function parsePptx(filePath: string): Promise<PptxModel> {
    const JSZip = require('jszip');
    const { DOMParser } = require('@xmldom/xmldom');

    const data = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(data);

    // Parse presentation.xml
    const presXml = await zip.file('ppt/presentation.xml').async('string');
    const presDom = new DOMParser().parseFromString(presXml, 'text/xml');

    // Slide dimensions
    const sldSz = presDom.getElementsByTagNameNS(P, 'sldSz')[0];
    const dimensions = {
        cx: parseInt(sldSz?.getAttribute('cx') || '12192000'),
        cy: parseInt(sldSz?.getAttribute('cy') || '6858000'),
    };

    // Slide order from presentation.xml
    const sldIdNodes = presDom.getElementsByTagNameNS(P, 'sldId');
    const slideOrder: { id: string; rId: string }[] = [];
    for (let i = 0; i < sldIdNodes.length; i++) {
        slideOrder.push({
            id: sldIdNodes[i].getAttribute('id') || '',
            rId: sldIdNodes[i].getAttributeNS(R, 'id') || sldIdNodes[i].getAttribute('r:id') || '',
        });
    }

    // Presentation relationships → map rId to slide file
    const presRelsXml = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
    const presRelsDom = new DOMParser().parseFromString(presRelsXml || '<Relationships/>', 'text/xml');
    const rIdToFile = new Map<string, string>();
    const relNodes = presRelsDom.getElementsByTagName('Relationship');
    for (let i = 0; i < relNodes.length; i++) {
        const id = relNodes[i].getAttribute('Id') || '';
        const target = relNodes[i].getAttribute('Target') || '';
        rIdToFile.set(id, target);
    }

    // Parse authors
    const authors = await parseAuthors(zip, DOMParser);

    // Parse comments
    const comments = await parseComments(zip, DOMParser, authors, slideOrder);

    // Parse each slide in order
    const slides: PptxSlide[] = [];
    for (let idx = 0; idx < slideOrder.length; idx++) {
        const { id, rId } = slideOrder[idx];
        const slideFile = rIdToFile.get(rId);
        if (!slideFile) continue;

        const slideXmlPath = `ppt/${slideFile}`;
        const slideXml = await zip.file(slideXmlPath)?.async('string');
        if (!slideXml) continue;

        const slideDom = new DOMParser().parseFromString(slideXml, 'text/xml');

        // Parse shapes from shape tree
        const shapes = parseShapeTree(slideDom, zip, slideFile);

        // Parse per-slide relationships for images and notes
        const slideBaseName = path.basename(slideFile, '.xml');
        const slideRelsPath = `ppt/slides/_rels/${slideBaseName}.xml.rels`;
        const slideRels = await zip.file(slideRelsPath)?.async('string');
        const slideRelsDom = slideRels ? new DOMParser().parseFromString(slideRels, 'text/xml') : null;

        // Resolve images
        if (slideRelsDom) {
            await resolveImages(shapes, slideDom, slideRelsDom, zip);
        }

        // Parse notes
        let notes = '';
        let notesHtml = '';
        if (slideRelsDom) {
            const result = await parseNotes(slideRelsDom, zip, DOMParser);
            notes = result.text;
            notesHtml = result.html;
        }

        slides.push({
            index: idx + 1,
            slideId: id,
            shapes,
            notes,
            notesHtml,
        });
    }

    // Link comments to slide indices
    const sldIdToIndex = new Map<string, number>();
    slideOrder.forEach((s, i) => sldIdToIndex.set(s.id, i + 1));
    for (const c of comments) {
        c.slideIndex = sldIdToIndex.get(c.slideId) || 0;
    }

    return { filePath, slides, comments, authors, dimensions, rawZip: zip };
}

// ---------- Authors ----------

async function parseAuthors(zip: any, DOMParser: any): Promise<Map<string, string>> {
    const authors = new Map<string, string>();

    // Modern format: ppt/authors.xml
    const authorsFile = zip.file('ppt/authors.xml');
    if (authorsFile) {
        const xml = await authorsFile.async('string');
        const dom = new DOMParser().parseFromString(xml, 'text/xml');
        const authorNodes = dom.getElementsByTagName('*');
        for (let i = 0; i < authorNodes.length; i++) {
            if (authorNodes[i].localName === 'author') {
                const id = authorNodes[i].getAttribute('id') || '';
                const name = authorNodes[i].getAttribute('name') || '';
                if (id && name) authors.set(id, name);
            }
        }
    }

    // Legacy format: ppt/commentAuthors.xml
    const legacyFile = zip.file('ppt/commentAuthors.xml');
    if (legacyFile) {
        const xml = await legacyFile.async('string');
        const dom = new DOMParser().parseFromString(xml, 'text/xml');
        const authorNodes = dom.getElementsByTagNameNS(P, 'cmAuthor');
        for (let i = 0; i < authorNodes.length; i++) {
            const id = authorNodes[i].getAttribute('id') || '';
            const name = authorNodes[i].getAttribute('name') || '';
            if (id && name) authors.set(id, name);
        }
    }

    return authors;
}

// ---------- Comments ----------

async function parseComments(
    zip: any, DOMParser: any,
    authors: Map<string, string>,
    slideOrder: { id: string; rId: string }[]
): Promise<PptxComment[]> {
    const comments: PptxComment[] = [];

    // Modern comments: ppt/comments/modernComment_*.xml
    const commentFiles = Object.keys(zip.files).filter(f =>
        f.startsWith('ppt/comments/') && f.endsWith('.xml')
    );

    for (const cf of commentFiles) {
        const xml = await zip.file(cf).async('string');
        const dom = new DOMParser().parseFromString(xml, 'text/xml');

        // Find all <p188:cm> or <cm> elements
        const allElements = dom.getElementsByTagName('*');
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            if (el.localName !== 'cm') continue;

            const id = el.getAttribute('id') || '';
            const authorId = el.getAttribute('authorId') || '';
            const created = el.getAttribute('created') || '';

            // Extract text from txBody
            const tNodes = el.getElementsByTagNameNS(A, 't');
            let text = '';
            for (let j = 0; j < tNodes.length; j++) {
                text += (tNodes[j].textContent || '');
            }

            // Find which slide this comment is on via sldMk
            let slideId = '';
            let shapeId = '';
            const sldMkNodes = el.getElementsByTagName('*');
            for (let j = 0; j < sldMkNodes.length; j++) {
                if (sldMkNodes[j].localName === 'sldMk') {
                    slideId = sldMkNodes[j].getAttribute('sldId') || '';
                }
                if (sldMkNodes[j].localName === 'spMk') {
                    shapeId = sldMkNodes[j].getAttribute('id') || '';
                }
            }

            comments.push({
                id,
                authorId,
                authorName: authors.get(authorId) || 'Unknown',
                created,
                text,
                slideId,
                slideIndex: 0, // filled in later
                shapeId,
            });
        }
    }

    // Legacy comments: ppt/comments/comment*.xml (legacy format)
    // These use <p:cm> elements directly in per-slide comment files
    const legacyFiles = Object.keys(zip.files).filter(f =>
        f.startsWith('ppt/comments/comment') && f.endsWith('.xml')
    );
    for (const cf of legacyFiles) {
        const xml = await zip.file(cf).async('string');
        const dom = new DOMParser().parseFromString(xml, 'text/xml');
        const cmNodes = dom.getElementsByTagNameNS(P, 'cm');
        for (let j = 0; j < cmNodes.length; j++) {
            const cm = cmNodes[j];
            const authorId = cm.getAttribute('authorId') || '';
            const idx = cm.getAttribute('idx') || '';
            const dt = cm.getAttribute('dt') || '';
            const textNode = cm.getElementsByTagNameNS(P, 'text')[0];
            const text = textNode?.textContent || '';
            const posNode = cm.getElementsByTagNameNS(P, 'pos')[0];

            comments.push({
                id: `legacy_${authorId}_${idx}`,
                authorId,
                authorName: authors.get(authorId) || 'Unknown',
                created: dt,
                text,
                slideId: '',
                slideIndex: 0,
                shapeId: '',
            });
        }
    }

    return comments;
}

// ---------- Shape Tree Parser ----------

function parseShapeTree(slideDom: any, zip: any, slideFile: string): PptxShape[] {
    const shapes: PptxShape[] = [];
    const spTree = slideDom.getElementsByTagNameNS(P, 'spTree')[0];
    if (!spTree) return shapes;

    // Parse direct child shapes (p:sp, p:pic, p:grpSp)
    for (let i = 0; i < spTree.childNodes.length; i++) {
        const node = spTree.childNodes[i];
        if (node.nodeType !== 1) continue; // element nodes only

        if (node.localName === 'sp') {
            shapes.push(parseShape(node));
        } else if (node.localName === 'pic') {
            shapes.push(parsePicture(node));
        } else if (node.localName === 'grpSp') {
            // Flatten group shapes
            shapes.push(...parseGroupShape(node));
        } else if (node.localName === 'graphicFrame') {
            shapes.push(parseGraphicFrame(node));
        }
    }

    return shapes;
}

function parseShape(sp: any): PptxShape {
    const cNvPr = findChild(sp, 'nvSpPr', P)
        ? findDescendant(findChild(sp, 'nvSpPr', P), 'cNvPr', P)
        : null;

    const id = cNvPr?.getAttribute('id') || '';
    const name = cNvPr?.getAttribute('name') || '';

    // Position and size
    const { x, y, cx, cy } = parseTransform(sp);

    // Placeholder type
    const nvPr = findDescendant(sp, 'nvPr', P);
    const ph = nvPr ? findDescendant(nvPr, 'ph', P) : null;
    const placeholderType = ph?.getAttribute('type') || '';

    // Text body — extract body insets and autofit settings
    const txBody = findChild(sp, 'txBody', P);
    const paragraphs = txBody ? parseParagraphs(txBody) : [];
    const text = paragraphs.map(p => p.text).join('\n');
    const htmlContent = paragraphsToHtml(paragraphs);

    // Body insets from bodyPr (default: 91440 EMU = 0.1" for L/R, 45720 = 0.05" for T/B)
    const bodyPr = txBody ? findChild(txBody, 'bodyPr', A) : null;
    const bodyInsets = {
        l: parseInt(bodyPr?.getAttribute('lIns') ?? '91440'),
        t: parseInt(bodyPr?.getAttribute('tIns') ?? '45720'),
        r: parseInt(bodyPr?.getAttribute('rIns') ?? '91440'),
        b: parseInt(bodyPr?.getAttribute('bIns') ?? '45720'),
    };

    // normAutofit fontScale (percentage, e.g. 90000 = 90%)
    const normAutofit = bodyPr ? findDescendant(bodyPr, 'normAutofit', A) : null;
    const fontScaleRaw = parseInt(normAutofit?.getAttribute('fontScale') || '0');
    const fontScale = fontScaleRaw > 0 ? fontScaleRaw / 1000 : undefined;

    // Fill color & geometry
    const spPr = findChild(sp, 'spPr', P);
    const fillColor = extractFillColor(spPr);
    const borderColor = extractBorderColor(spPr);
    const prstGeom = spPr ? findDescendant(spPr, 'prstGeom', A) : null;
    const geometry = prstGeom?.getAttribute('prst') || undefined;

    return {
        id, name,
        type: 'text',
        x, y, cx, cy,
        text, htmlContent,
        paragraphs,
        placeholderType: placeholderType || undefined,
        geometry,
        fillColor, borderColor,
        bodyInsets,
        fontScale,
    };
}

function parsePicture(pic: any): PptxShape {
    const cNvPr = findDescendant(pic, 'cNvPr', P);
    const id = cNvPr?.getAttribute('id') || '';
    const name = cNvPr?.getAttribute('name') || '';
    const { x, y, cx, cy } = parseTransform(pic);

    // Image ref is in blipFill → blip → r:embed
    const blip = findDescendant(pic, 'blip', A);
    const embedId = blip?.getAttributeNS(R, 'embed') || blip?.getAttribute('r:embed') || '';

    return {
        id, name,
        type: 'picture',
        x, y, cx, cy,
        text: `[Image: ${name}]`,
        htmlContent: `<div class="pptx-image-placeholder">[Image: ${escapeHtml(name)}]</div>`,
        paragraphs: [],
        imageData: embedId, // will be resolved later with actual data
    };
}

function parseGroupShape(grpSp: any): PptxShape[] {
    const shapes: PptxShape[] = [];
    // Get group transform for offset calculation
    const grpXfrm = findDescendant(grpSp, 'xfrm', A);
    const grpOffX = parseInt(grpXfrm?.getElementsByTagNameNS(A, 'off')[0]?.getAttribute('x') || '0');
    const grpOffY = parseInt(grpXfrm?.getElementsByTagNameNS(A, 'off')[0]?.getAttribute('y') || '0');

    for (let i = 0; i < grpSp.childNodes.length; i++) {
        const node = grpSp.childNodes[i];
        if (node.nodeType !== 1) continue;
        if (node.localName === 'sp') {
            const shape = parseShape(node);
            // Group children positions are relative to group
            // Keep as-is since we use the group's transform
            shapes.push(shape);
        } else if (node.localName === 'pic') {
            shapes.push(parsePicture(node));
        } else if (node.localName === 'grpSp') {
            shapes.push(...parseGroupShape(node));
        }
    }
    return shapes;
}

function parseGraphicFrame(gf: any): PptxShape {
    const cNvPr = findDescendant(gf, 'cNvPr', P);
    const id = cNvPr?.getAttribute('id') || '';
    const name = cNvPr?.getAttribute('name') || '';
    const { x, y, cx, cy } = parseTransform(gf);

    // Check for table
    const tbl = findDescendant(gf, 'tbl', A);
    if (tbl) {
        return {
            id, name,
            type: 'table',
            x, y, cx, cy,
            text: '[Table]',
            htmlContent: parseTable(tbl),
            paragraphs: [],
            tableHtml: parseTable(tbl),
        };
    }

    // Chart or other graphic
    return {
        id, name,
        type: 'chart',
        x, y, cx, cy,
        text: `[Chart: ${name}]`,
        htmlContent: `<div class="pptx-chart-placeholder">[Chart: ${escapeHtml(name)}]</div>`,
        paragraphs: [],
    };
}

// ---------- Transform ----------

function parseTransform(el: any): { x: number; y: number; cx: number; cy: number } {
    // Try p:spPr → a:xfrm first, then directly under the element
    const spPr = findChild(el, 'spPr', P);
    const xfrm = spPr
        ? findChild(spPr, 'xfrm', A)
        : findDescendant(el, 'xfrm', A);

    if (!xfrm) return { x: 0, y: 0, cx: 0, cy: 0 };

    const off = findChild(xfrm, 'off', A);
    const ext = findChild(xfrm, 'ext', A);

    return {
        x: parseInt(off?.getAttribute('x') || '0'),
        y: parseInt(off?.getAttribute('y') || '0'),
        cx: parseInt(ext?.getAttribute('cx') || '0'),
        cy: parseInt(ext?.getAttribute('cy') || '0'),
    };
}

// ---------- Paragraphs ----------

function parseParagraphs(txBody: any): PptxParagraph[] {
    const paragraphs: PptxParagraph[] = [];
    const pNodes = txBody.getElementsByTagNameNS(A, 'p');

    for (let i = 0; i < pNodes.length; i++) {
        const p = pNodes[i];
        // Only process direct children of txBody
        if (p.parentNode !== txBody) continue;

        const pPr = findChild(p, 'pPr', A);
        const level = parseInt(pPr?.getAttribute('lvl') || '0');
        const alignment = pPr?.getAttribute('algn') || '';
        const isBullet = !!pPr?.getElementsByTagNameNS(A, 'buChar')[0]
            || !!pPr?.getElementsByTagNameNS(A, 'buAutoNum')[0]
            || level > 0;

        const runs: PptxRun[] = [];
        for (let j = 0; j < p.childNodes.length; j++) {
            const child = p.childNodes[j];
            if (child.nodeType !== 1) continue;
            if (child.localName === 'r') {
                const rPr = findChild(child, 'rPr', A);
                const tNode = findChild(child, 't', A);
                runs.push({
                    text: tNode?.textContent || '',
                    bold: rPr?.getAttribute('b') === '1',
                    italic: rPr?.getAttribute('i') === '1',
                    underline: !!rPr?.getAttribute('u'),
                    fontSize: parseInt(rPr?.getAttribute('sz') || '0') || undefined,
                    color: extractRunColor(rPr),
                });
            } else if (child.localName === 'br') {
                runs.push({ text: '\n' });
            }
        }

        const text = runs.map(r => r.text).join('');
        // Get font size from paragraph default if not on runs
        const defRPr = pPr ? findChild(pPr, 'defRPr', A) : null;
        const fontSize = parseInt(defRPr?.getAttribute('sz') || '0') || undefined;
        const bold = defRPr?.getAttribute('b') === '1';

        paragraphs.push({ text, level, alignment, isBullet, fontSize, bold, runs });
    }

    return paragraphs;
}

function paragraphsToHtml(paragraphs: PptxParagraph[]): string {
    return paragraphs.map(p => {
        if (!p.text.trim()) return '';

        const runsHtml = p.runs.map(r => {
            let html = escapeHtml(r.text);
            if (r.bold) html = `<b>${html}</b>`;
            if (r.italic) html = `<i>${html}</i>`;
            if (r.underline) html = `<u>${html}</u>`;
            if (r.color) html = `<span style="color:#${r.color}">${html}</span>`;
            return html;
        }).join('');

        const style: string[] = [];
        if (p.alignment === 'ctr') style.push('text-align:center');
        else if (p.alignment === 'r') style.push('text-align:right');
        if (p.level > 0) style.push(`margin-left:${p.level * 20}px`);

        const fontSize = p.fontSize || p.runs[0]?.fontSize;
        if (fontSize) {
            // fontSize is in hundredths of a point. At 72dpi rendering (960px / 13.33in),
            // 1pt = 1px. So px = hundredths / 100.
            const px = Math.round(fontSize / 100);
            if (px > 0) style.push(`font-size:${px}px`);
        }

        const styleAttr = style.length ? ` style="${style.join(';')}"` : '';
        const bullet = p.isBullet ? '• ' : '';
        const boldClass = (p.bold || p.runs.every(r => r.bold)) ? ' class="bold"' : '';

        return `<div${boldClass}${styleAttr}>${bullet}${runsHtml}</div>`;
    }).filter(h => h).join('\n');
}

// ---------- Table ----------

function parseTable(tbl: any): string {
    let html = '<table class="pptx-table">';

    const rows = tbl.getElementsByTagNameNS(A, 'tr');
    for (let r = 0; r < rows.length; r++) {
        // Only direct children
        if (rows[r].parentNode !== tbl) continue;
        html += '<tr>';
        const cells = rows[r].getElementsByTagNameNS(A, 'tc');
        for (let c = 0; c < cells.length; c++) {
            if (cells[c].parentNode !== rows[r]) continue;
            const txBody = findChild(cells[c], 'txBody', A);
            const paragraphs = txBody ? parseParagraphs(txBody) : [];
            const cellText = paragraphs.map(p => escapeHtml(p.text)).join('<br>');
            const isHeader = r === 0;
            const tag = isHeader ? 'th' : 'td';
            html += `<${tag}>${cellText}</${tag}>`;
        }
        html += '</tr>';
    }
    html += '</table>';
    return html;
}

// ---------- Images ----------

async function resolveImages(
    shapes: PptxShape[],
    slideDom: any,
    slideRelsDom: any,
    zip: any
): Promise<void> {
    // Build rId → target map from slide rels
    const rIdMap = new Map<string, string>();
    const relNodes = slideRelsDom.getElementsByTagName('Relationship');
    for (let i = 0; i < relNodes.length; i++) {
        const id = relNodes[i].getAttribute('Id') || '';
        const target = relNodes[i].getAttribute('Target') || '';
        rIdMap.set(id, target);
    }

    for (const shape of shapes) {
        if (shape.type === 'picture' && shape.imageData) {
            const embedId = shape.imageData;
            const target = rIdMap.get(embedId);
            if (target) {
                // Target is relative to ppt/slides/, e.g. "../media/image1.png"
                const imagePath = `ppt/slides/${target}`.replace(/\/\.\.\//g, '/').replace(/ppt\/slides\/\.\./, 'ppt');
                const imageFile = zip.file(imagePath);
                if (imageFile) {
                    const imageData = await imageFile.async('base64');
                    const ext = path.extname(imagePath).toLowerCase();
                    const mime = ext === '.png' ? 'image/png'
                        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                        : ext === '.gif' ? 'image/gif'
                        : ext === '.svg' ? 'image/svg+xml'
                        : 'image/png';
                    shape.imageData = `data:${mime};base64,${imageData}`;
                    shape.htmlContent = `<img src="${shape.imageData}" style="max-width:100%;max-height:100%;" alt="${escapeHtml(shape.name)}">`;
                }
            }
        }
    }
}

// ---------- Notes ----------

async function parseNotes(
    slideRelsDom: any,
    zip: any,
    DOMParser: any
): Promise<{ text: string; html: string }> {
    const relNodes = slideRelsDom.getElementsByTagName('Relationship');
    for (let i = 0; i < relNodes.length; i++) {
        const type = relNodes[i].getAttribute('Type') || '';
        if (type.includes('notesSlide')) {
            const target = relNodes[i].getAttribute('Target') || '';
            const notesPath = `ppt/slides/${target}`.replace(/\/\.\.\//g, '/').replace(/ppt\/slides\/\.\./, 'ppt');
            const notesFile = zip.file(notesPath);
            if (!notesFile) continue;

            const xml = await notesFile.async('string');
            const dom = new DOMParser().parseFromString(xml, 'text/xml');

            // Find the notes placeholder (type="body")
            const spNodes = dom.getElementsByTagNameNS(P, 'sp');
            for (let j = 0; j < spNodes.length; j++) {
                const ph = findDescendant(spNodes[j], 'ph', P);
                if (ph && (ph.getAttribute('type') === 'body' || ph.getAttribute('idx') === '1')) {
                    const txBody = findChild(spNodes[j], 'txBody', P);
                    if (txBody) {
                        const paragraphs = parseParagraphs(txBody);
                        const text = paragraphs.map(p => p.text).filter(t => t.trim()).join('\n');
                        const html = paragraphsToHtml(paragraphs);
                        return { text, html };
                    }
                }
            }
        }
    }
    return { text: '', html: '' };
}

// ---------- Color Helpers ----------

function extractFillColor(spPr: any): string | undefined {
    if (!spPr) return undefined;
    const solidFill = findChild(spPr, 'solidFill', A);
    if (!solidFill) return undefined;
    const srgb = findChild(solidFill, 'srgbClr', A);
    if (srgb) return '#' + srgb.getAttribute('val');
    return undefined;
}

function extractBorderColor(spPr: any): string | undefined {
    if (!spPr) return undefined;
    const ln = findChild(spPr, 'ln', A);
    if (!ln) return undefined;
    const solidFill = findChild(ln, 'solidFill', A);
    if (!solidFill) return undefined;
    const srgb = findChild(solidFill, 'srgbClr', A);
    if (srgb) return '#' + srgb.getAttribute('val');
    return undefined;
}

function extractRunColor(rPr: any): string | undefined {
    if (!rPr) return undefined;
    const solidFill = findChild(rPr, 'solidFill', A);
    if (!solidFill) return undefined;
    const srgb = findChild(solidFill, 'srgbClr', A);
    if (srgb) return srgb.getAttribute('val') || undefined;
    return undefined;
}

// ---------- DOM Helpers ----------

function findChild(parent: any, localName: string, ns?: string): any {
    if (!parent) return null;
    for (let i = 0; i < parent.childNodes.length; i++) {
        const child = parent.childNodes[i];
        if (child.nodeType === 1 && child.localName === localName) {
            if (!ns || child.namespaceURI === ns) return child;
            // Also match if no namespace check needed
            return child;
        }
    }
    return null;
}

function findDescendant(parent: any, localName: string, ns?: string): any {
    if (!parent) return null;
    const elements = ns
        ? parent.getElementsByTagNameNS(ns, localName)
        : parent.getElementsByTagName(localName);
    return elements.length > 0 ? elements[0] : null;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
