import * as fs from 'fs';
import * as path from 'path';

export type Role = 'user' | 'agent';

export interface Reply {
    id: string;
    role: Role;
    text: string;
    timestamp: string;
}

export interface Comment {
    id: string;
    anchor: string;
    startOffset: number;
    endOffset: number;
    blockType: string;
    blockPreview: string;
    comment: string;
    role: Role;
    timestamp: string;
    resolved: boolean;
    replies?: Reply[];
}

export interface CommentsFile {
    file: string;
    comments: Comment[];
}

/**
 * Manages only the .comments.json sidecar file.
 * Anchor insertion/removal in the markdown file is handled by PreviewPanel
 * via the VS Code workspace edit API.
 */
export class CommentsManager {
    private commentsPath: string;
    private data: CommentsFile;
    public lastSaveTime: number = 0;

    constructor(markdownFilePath: string) {
        const dir = path.dirname(markdownFilePath);
        const base = path.basename(markdownFilePath);
        this.commentsPath = path.join(dir, '.' + base + '.comments.json');
        // Migrate from old path if it exists
        const oldPath = markdownFilePath + '.comments.json';
        if (!fs.existsSync(this.commentsPath) && fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, this.commentsPath);
        }
        this.data = this.load();
    }

    getCommentsPath(): string {
        return this.commentsPath;
    }

    reload(): void {
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
        return { file: path.basename(this.commentsPath).replace('.comments.json', ''), comments: [] };
    }

    private save(): void {
        fs.writeFileSync(this.commentsPath, JSON.stringify(this.data, null, 2), 'utf-8');
        this.lastSaveTime = Date.now();
    }

    /** Public save for when offsets are updated externally */
    persist(): void {
        this.save();
    }

    getComments(): Comment[] {
        return this.data.comments;
    }

    addComment(
        startOffset: number,
        endOffset: number,
        blockType: string,
        blockPreview: string,
        comment: string
    ): Comment {
        const id = 'c' + Date.now();
        const anchor = `<!--@${id}-->`;
        const newComment: Comment = {
            id,
            anchor,
            startOffset,
            endOffset,
            blockType,
            blockPreview,
            comment,
            role: 'user',
            timestamp: new Date().toISOString(),
            resolved: false,
        };
        this.data.comments.push(newComment);
        this.save();
        return newComment;
    }

    resolveComment(id: string): void {
        const c = this.data.comments.find(x => x.id === id);
        if (c) {
            c.resolved = true;
            this.save();
        }
    }

    deleteComment(id: string): void {
        this.data.comments = this.data.comments.filter(x => x.id !== id);
        this.save();
    }

    editComment(id: string, newText: string): void {
        const c = this.data.comments.find(x => x.id === id);
        if (c) {
            c.comment = newText;
            this.save();
        }
    }

    editReply(commentId: string, replyId: string, newText: string): void {
        const c = this.data.comments.find(x => x.id === commentId);
        if (c && c.replies) {
            const r = c.replies.find(x => x.id === replyId);
            if (r) {
                r.text = newText;
                this.save();
            }
        }
    }

    deleteReply(commentId: string, replyId: string): void {
        const c = this.data.comments.find(x => x.id === commentId);
        if (c && c.replies) {
            c.replies = c.replies.filter(x => x.id !== replyId);
            this.save();
        }
    }

    unresolveComment(id: string): void {
        const c = this.data.comments.find(x => x.id === id);
        if (c) {
            c.resolved = false;
            this.save();
        }
    }

    addReply(commentId: string, text: string, role: Role = 'user'): Reply | null {
        const c = this.data.comments.find(x => x.id === commentId);
        if (!c) { return null; }
        if (!c.replies) { c.replies = []; }
        const reply: Reply = {
            id: 'r' + Date.now(),
            role,
            text,
            timestamp: new Date().toISOString(),
        };
        c.replies.push(reply);
        this.save();
        return reply;
    }
}