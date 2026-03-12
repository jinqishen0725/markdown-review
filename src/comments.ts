import * as fs from 'fs';
import * as path from 'path';

export interface Comment {
    id: string;
    anchor: string;
    selectedText: string;
    comment: string;
    sourceLine: number;
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
        contextAfter: string = ''
    ): Comment {
        const id = 'c' + Date.now();
        const anchor = `<!--@${id}-->`;

        // Try to insert anchor into the markdown source
        const anchorLocation = this.insertAnchor(id, selectedText, sourceLine, contextBefore, contextAfter);

        const newComment: Comment = {
            id,
            anchor,
            selectedText,
            comment,
            sourceLine,
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
        const mathUnicodePattern = /[\u2200-\u22FF\u2190-\u21FF\u1D400-\u1D7FF∑∏∫∂∇∞√∩∪∈∉⊂⊃≤≥≠≈≡∧∨]/;
        return mathUnicodePattern.test(text);
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
        contextAfter: string
    ): 'inline' | 'before-block' | 'fallback' {
        try {
            let source = fs.readFileSync(this.markdownPath, 'utf-8');
            const anchor = `<!--@${id}-->`;

            // If the selected text looks like rendered formula output, skip text matching
            // and go directly to block-level anchoring
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

            // Strategy 2: Block-level anchoring (for formulas or when text match fails)
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
