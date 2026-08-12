export interface CleanTextReplacement {
    start: number;
    endExclusive: number;
    newText: string;
}

export interface CommentAnchorPosition {
    id: string;
    cleanOffset: number;
}

export function stripCommentAnchors(text: string): { cleanText: string; anchors: CommentAnchorPosition[] } {
    const anchors: CommentAnchorPosition[] = [];
    const anchorPattern = /<!--@(c\d+)-->\r?\n?/g;
    let cleanText = '';
    let lastEnd = 0;
    let match: RegExpExecArray | null;
    while ((match = anchorPattern.exec(text)) !== null) {
        cleanText += text.slice(lastEnd, match.index);
        anchors.push({ id: match[1], cleanOffset: cleanText.length });
        lastEnd = match.index + match[0].length;
    }
    cleanText += text.slice(lastEnd);
    return { cleanText, anchors };
}

function applyCleanReplacements(text: string, replacements: readonly CleanTextReplacement[]): string {
    let result = text;
    for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
        result = result.slice(0, replacement.start) + replacement.newText + result.slice(replacement.endExclusive);
    }
    return result;
}

function mapOffset(offset: number, replacements: readonly CleanTextReplacement[]): number {
    let delta = 0;
    for (const replacement of [...replacements].sort((a, b) => a.start - b.start)) {
        if (offset < replacement.start) break;
        if (offset <= replacement.endExclusive) {
            const relativeOffset = Math.max(0, offset - replacement.start);
            return replacement.start + delta + Math.min(relativeOffset, replacement.newText.length);
        }
        delta += replacement.newText.length - (replacement.endExclusive - replacement.start);
    }
    return offset + delta;
}

export function applyAnchorFreeReplacements(
    anchoredText: string,
    replacements: readonly CleanTextReplacement[],
    eol: string,
): string {
    const { cleanText, anchors } = stripCommentAnchors(anchoredText);
    const nextCleanText = applyCleanReplacements(cleanText, replacements);
    const mappedAnchors = anchors
        .map(anchor => ({ ...anchor, cleanOffset: mapOffset(anchor.cleanOffset, replacements) }))
        .sort((a, b) => a.cleanOffset - b.cleanOffset);

    let result = '';
    let cursor = 0;
    for (const anchor of mappedAnchors) {
        const offset = Math.max(cursor, Math.min(anchor.cleanOffset, nextCleanText.length));
        result += nextCleanText.slice(cursor, offset);
        result += `<!--@${anchor.id}-->${eol}`;
        cursor = offset;
    }
    return result + nextCleanText.slice(cursor);
}

export function computeMinimalReplacement(before: string, after: string): CleanTextReplacement | undefined {
    if (before === after) return undefined;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
        beforeEnd--;
        afterEnd--;
    }
    return { start, endExclusive: beforeEnd, newText: after.slice(start, afterEnd) };
}