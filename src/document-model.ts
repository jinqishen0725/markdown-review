/**
 * Document model — the core abstraction between raw Office XML and the UI/tools.
 */

export type DocFormat = 'docx' | 'pptx';

export type ElementType = 'heading' | 'paragraph' | 'table' | 'image' | 'list-item' | 'formula' | 'code-block';

export interface DocElement {
    id: string;
    type: ElementType;
    level?: number;
    content: string;        // plain text
    htmlContent: string;    // rendered HTML
    xmlSnippet: string;     // original XML for write-back reference
    commentIds: string[];   // Word comment IDs on this element
    children?: DocElement[];
}

export interface WordComment {
    id: string;
    author: string;
    date: string;
    text: string;
    parentId?: string;      // for threading (reply to which comment)
    elementId?: string;     // which DocElement this is anchored to
}

export interface DocumentModel {
    filePath: string;
    format: DocFormat;
    elements: DocElement[];
    comments: WordComment[];
    relationships: Map<string, string>;
    media: Map<string, Buffer>;
    rawZip: any; // JSZip instance for write-back
    tempDir?: string; // temp directory with extracted XML files for direct editing
    documentXmlPath?: string; // path to extracted document.xml for direct agent editing
}

export interface ReviewComment {
    id: string;
    elementId: string;
    text: string;
    role: 'user' | 'agent';
    timestamp: string;
    resolved: boolean;
    replies: ReviewReply[];
}

export interface ReviewReply {
    id: string;
    text: string;
    role: 'user' | 'agent';
    timestamp: string;
}

export interface ReviewCommentsFile {
    file: string;
    comments: ReviewComment[];
}
