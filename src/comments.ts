import * as fs from 'fs';
import * as path from 'path';

export interface Comment {
    id: string;
    anchor: string;
    selectedText: string;
    comment: string;
    sourceLine: number;
    startOffset: number;
    endOffset: number;
    contextBefore: string;
    contextAfter: string;
    anchorLocation: 'inline' | 'before-block' | 'fallback';
    timestamp: string;
    resolved: boolean;
}

export interface CommentsFile {
    file: string;
    comments: Comment[];
}

export class CommentsManager {
    private commentsPath: string;
    private markdownPath: string;
    private data: CommentsFile;

    constructor(markdownFilePath: string) {
        this.markdownPath = markdownFilePath;
        this.commentsPath = markdownFilePath + '.comments.json';
        this.data = this.load();
    }

    private load(): CommentsFile {
        try {
            if (fs.existsSync(this.commentsPath)) {
                const raw = fs.readFileSync(this.commentsPath, 'utf-8');
                return JSON.parse(raw);
            }
        } catch {
            // corrupted file, start fresh
        }
        return { file: path.basename(this.commentsPath.replace('.comments.json', '')), comments: [] };
    }

    private save(): void {
        fs.writeFileSync(this.commentsPath, JSON.stringify(this.data, null, 2), 'utf-8');
    }

    getComments(): Comment[] {
        return this.data.comments;
    }

    addComment(
        selectedText: string,
        comment: string,
        sourceLine: number,
        contextBefore: string = '',
        contextAfter: string = '',
        startOffset: number = -1,
        endOffset: number = -1
    ): Comment {
        const id = 'c' + Date.now();
        const anchor = `<!--@${id}-->`;

        // Try to insert anchor into the markdown source
        const anchorLocation = this.insertAnchor(id, selectedText, sourceLine, contextBefore, contextAfter, startOffset, endOffset);

        const newComment: Comment = {
            id,
            anchor,
            selectedText,
            comment,
            sourceLine,
            startOffset,
            endOffset,
            contextBefore,
            contextAfter,
            anchorLocation,
            timestamp: new Date().toISOString(),
            resolved: false,
        };
        this.data.comments.push(newComment);
        this.save();
        return newComment;
    }

    /**
     * Check if text looks like rendered formula content (Unicode math symbols
     * that wouldn't appear in raw LaTeX source).
     */
    private looksLikeRenderedFormula(text: string): boolean {
        // Unicode math italic letters (U+1D400-U+1D7FF), common KaTeX output chars
        const mathUnicodePattern = /[\u2200-\u22FF\u2190-\u21FF\u1D400-\u1D7FF\u2211\u220F\u222B\u2202\u2207\u221E\u221A\u2229\u222A\u2208\u2209\u2282\u2283\u2264\u2265\u2260\u2248\u2261\u2227\u2228]/;
        return mathUnicodePattern.test(text);
    }

    /**
     * Check if a given offset range falls inside a formula ($..$ or $$...$$).
     */
    private isOffsetInsideFormula(source: string, start: number, end: number): boolean {
        // Check display math $$...$$
        let idx = 0;
        let insideDisplay = false;
        let displayStart = -1;
        while (idx < source.length) {
            const pos = source.indexOf('$$', idx);
            if (pos === -1) break;
            if (!insideDisplay) {
                displayStart = pos;
                insideDisplay = true;
            } else {
                if (start >= displayStart && start <= pos + 2) return true;
                if (end >= displayStart && end <= pos + 2) return true;
                insideDisplay = false;
            }
            idx = pos + 2;
        }

        // Check inline math $...$
        // Find all $...$ pairs (not $$) on the line containing our offset
        const lineStart = source.lastIndexOf('\n', start) + 1;
        const lineEnd = source.indexOf('\n', end);
        const line = source.substring(lineStart, lineEnd !== -1 ? lineEnd : source.length);
        const lineOffset = lineStart;

        let i = 0;
        while (i < line.length) {
            // Skip $$ (already handled above)
            if (line[i] === '$' && i + 1 < line.length && line[i + 1] === '$') {
                i += 2;
                continue;
            }
            if (line[i] === '$' && (i === 0 || line[i - 1] !== '\\')) {
                // Found opening $, look for closing $
                const openPos = lineOffset + i;
                let j = i + 1;
                while (j < line.length && line[j] !== '$') j++;
                if (j < line.length) {
                    const closePos = lineOffset + j;
                    // Check if our range overlaps with this $...$ span
                    if (start >= openPos && start <= closePos + 1) return true;
                    if (end >= openPos && end <= closePos + 1) return true;
                    i = j + 1;
                    continue;
                }
            }
            i++;
        }

        return false;
    }

    /**
     * Insert an anchor tag into the markdown source file.
     * Returns the anchor location type.
     */
    private insertAnchor(
        id: string,
        selectedText: string,
        sourceLine: number,
        contextBefore: string,
        contextAfter: string,
        startOffset: number = -1,
        endOffset: number = -1
    ): 'inline' | 'before-block' | 'fallback' {
        try {
            let source = fs.readFileSync(this.markdownPath, 'utf-8');
            const anchor = `<!--@${id}-->`;

            // Strategy 0 (best): Use exact source offset from remark AST
            if (startOffset >= 0 && startOffset < source.length) {
                const blockEnd = endOffset >= 0 ? Math.min(endOffset, source.length) : source.length;
                const blockText = source.substring(startOffset, blockEnd);

                // Check if this block is inside or contains a $$ formula
                const isInsideFormula = this.isOffsetInsideFormula(source, startOffset, blockEnd);
                // Only treat display $$ blocks as formula blocks to avoid
                // Inline $...$ is handled by the word-boundary and offset checks
                const blockContainsDisplayFormula = blockText.includes('$$');

                if (!isInsideFormula && !blockContainsDisplayFormula) {
                    // Try to find the exact selectedText within this block
                    const idx = blockText.indexOf(selectedText);
                    if (idx !== -1) {
                        const insertPos = startOffset + idx;
                        // Safety: don't insert if it would split a word
                        if (insertPos > 0 && /[a-zA-Z0-9]/.test(source[insertPos - 1]) && /[a-zA-Z0-9]/.test(source[insertPos])) {
                            // Would split a word — find the beginning of this word instead
                            let wordStart = insertPos;
                            while (wordStart > 0 && /[a-zA-Z0-9_\-]/.test(source[wordStart - 1])) wordStart--;
                            source = source.substring(0, wordStart) + anchor + source.substring(wordStart);
                        } else {
                            source = source.substring(0, insertPos) + anchor + source.substring(insertPos);
                        }
                        fs.writeFileSync(this.markdownPath, source, 'utf-8');
                        return 'inline';
                    }
                }

                // Text not found verbatim, or inside/contains formula
                // For display formulas ($$...$$): insert anchor INSIDE the formula
                // using LaTeX % comment so KaTeX ignores it: %<!--@ID-->
                if (isInsideFormula || blockContainsDisplayFormula) {
                    // Find the opening $$ 
                    let dollarPos = source.lastIndexOf('$$', Math.max(startOffset, blockEnd));
                    // Make sure we find the OPENING $$, not closing
                    // Search backward from startOffset to find the opening $$
                    let openingDollar = source.lastIndexOf('$$', startOffset);
                    if (openingDollar === -1) {
                        openingDollar = source.indexOf('$$', startOffset);
                    }
                    if (openingDollar !== -1) {
                        // Find the end of the $$ line (right after $$)
                        const afterDollar = openingDollar + 2;
                        // Check if this is a single-line $$ formula ($$...$$)
                        const nextDollar = source.indexOf('$$', afterDollar);
                        const nextNewline = source.indexOf('\n', afterDollar);
                        
                        if (nextNewline !== -1 && (nextDollar === -1 || nextNewline < nextDollar)) {
                            // Multi-line formula: insert %anchor as new line after opening $$
                            const insertPos = nextNewline + 1;
                            const formulaAnchor = `%${anchor}\n`;
                            source = source.substring(0, insertPos) + formulaAnchor + source.substring(insertPos);
                        } else {
                            // Single-line formula $$...$$: insert anchor before the $$
                            source = source.substring(0, openingDollar) + anchor + source.substring(openingDollar);
                        }
                        fs.writeFileSync(this.markdownPath, source, 'utf-8');
                        return 'inline';
                    }
                    
                    // Check for inline $...$ formula
                    const inlineDollarBefore = source.lastIndexOf('$', startOffset);
                    if (inlineDollarBefore !== -1 && source[inlineDollarBefore - 1] !== '$' &&
                        (inlineDollarBefore + 1 >= source.length || source[inlineDollarBefore + 1] !== '$')) {
                        // Place anchor right before the opening $
                        source = source.substring(0, inlineDollarBefore) + anchor + source.substring(inlineDollarBefore);
                        fs.writeFileSync(this.markdownPath, source, 'utf-8');
                        return 'inline';
                    }
                }

                // For headings/tables/other blocks: use startOffset directly
                // remark AST gives us the exact start of the block element
                const charBefore = startOffset > 0 ? source[startOffset - 1] : '\n';
                if (charBefore === '\n' || startOffset === 0) {
                    // Already at line start — insert directly
                    source = source.substring(0, startOffset) + anchor + source.substring(startOffset);
                } else {
                    // Mid-line — go to line start
                    const lineStart = source.lastIndexOf('\n', startOffset);
                    const insertPos = lineStart !== -1 ? lineStart + 1 : 0;
                    source = source.substring(0, insertPos) + anchor + source.substring(insertPos);
                }
                fs.writeFileSync(this.markdownPath, source, 'utf-8');
                return 'before-block';
            }

            // If the selected text looks like rendered formula output, skip text matching
            if (this.looksLikeRenderedFormula(selectedText)) {
                return this.anchorNearBlock(source, anchor, sourceLine, contextBefore);
            }

            // Strategy 1: Find exact selectedText with context + sourceLine disambiguation
            const position = this.findTextPosition(source, selectedText, contextBefore, contextAfter, sourceLine);

            if (position !== -1) {
                source = source.substring(0, position) + anchor + source.substring(position);
                fs.writeFileSync(this.markdownPath, source, 'utf-8');
                return 'inline';
            }

            // Strategy 2: Block-level anchoring
            return this.anchorNearBlock(source, anchor, sourceLine, contextBefore);

        } catch {
            return 'fallback';
        }
    }

    /**
     * Place anchor near a block element ($$, paragraph) at or near sourceLine.
     */
    private anchorNearBlock(
        source: string,
        anchor: string,
        sourceLine: number,
        contextBefore: string
    ): 'before-block' | 'fallback' {
        if (sourceLine >= 0) {
            const lines = source.split('\n');
            if (sourceLine < lines.length) {
                // Look for a $$ block within ±10 lines
                let blockStart = -1;
                for (let i = sourceLine; i >= Math.max(0, sourceLine - 10); i--) {
                    if (lines[i].trim().startsWith('$$')) {
                        blockStart = i;
                        break;
                    }
                }
                if (blockStart === -1) {
                    for (let i = sourceLine; i <= Math.min(lines.length - 1, sourceLine + 5); i++) {
                        if (lines[i].trim().startsWith('$$')) {
                            blockStart = i;
                            break;
                        }
                    }
                }
                if (blockStart !== -1) {
                    const insertPos = lines.slice(0, blockStart).join('\n').length + (blockStart > 0 ? 1 : 0);
                    let s = source.substring(0, insertPos) + anchor + '\n' + source.substring(insertPos);
                    fs.writeFileSync(this.markdownPath, s, 'utf-8');
                    return 'before-block';
                }

                // No $$ block found — anchor at beginning of sourceLine
                const insertPos = lines.slice(0, sourceLine).join('\n').length + (sourceLine > 0 ? 1 : 0);
                let s = source.substring(0, insertPos) + anchor + source.substring(insertPos);
                fs.writeFileSync(this.markdownPath, s, 'utf-8');
                return 'before-block';
            }
        }

        // sourceLine not available — try to find location from contextBefore
        if (contextBefore) {
            // Extract identifiable text from contextBefore (strip rendered formatting)
            const cleanCtx = contextBefore.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            if (cleanCtx.length > 10) {
                const lastChunk = cleanCtx.substring(Math.max(0, cleanCtx.length - 30));
                const idx = source.indexOf(lastChunk);
                if (idx !== -1) {
                    const insertPos = idx + lastChunk.length;
                    let s = source.substring(0, insertPos) + anchor + source.substring(insertPos);
                    fs.writeFileSync(this.markdownPath, s, 'utf-8');
                    return 'before-block';
                }
            }
        }

        return 'fallback';
    }

    /**
     * Find the exact character position of selectedText in the source,
     * using contextBefore + contextAfter to disambiguate multiple matches.
     */
    private findTextPosition(
        source: string,
        selectedText: string,
        contextBefore: string,
        contextAfter: string,
        sourceLine: number
    ): number {
        // Find all occurrences
        const matches: number[] = [];
        let searchFrom = 0;
        while (true) {
            const idx = source.indexOf(selectedText, searchFrom);
            if (idx === -1) break;
            matches.push(idx);
            searchFrom = idx + 1;
        }

        if (matches.length === 0) return -1;
        if (matches.length === 1) return matches[0];

        // Multiple matches — score each one
        let bestMatch = -1;
        let bestScore = -Infinity;

        for (const pos of matches) {
            let score = 0;

            // 1. Word boundary check: penalize if match splits a word
            //    (char before match is a letter/digit → likely partial word match)
            if (pos > 0) {
                const charBefore = source[pos - 1];
                if (/[a-zA-Z0-9]/.test(charBefore)) {
                    score -= 5; // Strong penalty for word-splitting
                }
            }
            const charAfterIdx = pos + selectedText.length;
            if (charAfterIdx < source.length) {
                const charAfter = source[charAfterIdx];
                if (/[a-zA-Z0-9]/.test(charAfter)) {
                    score -= 5; // Strong penalty for word-splitting
                }
            }

            // 2. Source line proximity (strongest signal when available)
            if (sourceLine >= 0) {
                const lineAtPos = source.substring(0, pos).split('\n').length - 1;
                const lineDist = Math.abs(lineAtPos - sourceLine);
                if (lineDist === 0) score += 10;
                else if (lineDist <= 2) score += 8;
                else if (lineDist <= 5) score += 5;
                else if (lineDist <= 10) score += 2;
                // else no bonus — far from expected line
            }

            // 3. Context matching
            if (contextBefore) {
                const before = source.substring(Math.max(0, pos - contextBefore.length - 20), pos);
                if (before.includes(contextBefore)) score += 3;
                else {
                    const overlap = this.longestCommonSubstring(before, contextBefore);
                    if (overlap.length > contextBefore.length * 0.5) score += 1;
                }
            }
            if (contextAfter) {
                const after = source.substring(pos + selectedText.length, pos + selectedText.length + contextAfter.length + 20);
                if (after.includes(contextAfter)) score += 3;
                else {
                    const overlap = this.longestCommonSubstring(after, contextAfter);
                    if (overlap.length > contextAfter.length * 0.5) score += 1;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = pos;
            }
        }

        return bestMatch;
    }

    private longestCommonSubstring(a: string, b: string): string {
        if (!a || !b) return '';
        let longest = '';
        for (let i = 0; i < a.length; i++) {
            for (let len = 1; len <= a.length - i && len <= b.length; len++) {
                const sub = a.substring(i, i + len);
                if (b.includes(sub) && sub.length > longest.length) {
                    longest = sub;
                }
                if (!b.includes(sub)) break;
            }
        }
        return longest;
    }

    resolveComment(id: string): void {
        const c = this.data.comments.find(c => c.id === id);
        if (c) {
            c.resolved = true;
            this.save();
            // Remove anchor from source
            this.removeAnchor(id);
        }
    }

    deleteComment(id: string): void {
        this.data.comments = this.data.comments.filter(c => c.id !== id);
        this.save();
        // Remove anchor from source
        this.removeAnchor(id);
    }

    unresolveComment(id: string): void {
        const c = this.data.comments.find(c => c.id === id);
        if (c) {
            c.resolved = false;
            this.save();
            // Re-insert anchor if it was removed on resolve
            this.reinsertAnchorIfMissing(c);
        }
    }

    private removeAnchor(id: string): void {
        try {
            let source = fs.readFileSync(this.markdownPath, 'utf-8');
            const anchor = `<!--@${id}-->`;
            if (source.includes(anchor)) {
                // Remove anchor and any trailing newline it may have added
                source = source.replace(anchor + '\n', '');
                if (source.includes(anchor)) {
                    source = source.replace(anchor, '');
                }
                fs.writeFileSync(this.markdownPath, source, 'utf-8');
            }
        } catch {
            // ignore errors
        }
    }

    private reinsertAnchorIfMissing(comment: Comment): void {
        try {
            const source = fs.readFileSync(this.markdownPath, 'utf-8');
            if (!source.includes(comment.anchor)) {
                // Re-insert using the stored location info
                this.insertAnchor(
                    comment.id,
                    comment.selectedText,
                    comment.sourceLine,
                    comment.contextBefore,
                    comment.contextAfter
                );
            }
        } catch {
            // ignore errors
        }
    }
}
