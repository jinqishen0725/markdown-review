import { basename } from 'node:path';
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import {
    buildCanvasState,
    closeInstanceServer,
    createInstanceServer,
    resolveInitialMarkdownPath,
    setCanvasFile,
} from './canvas-runtime';

const instances = new Map<string, Awaited<ReturnType<typeof createInstanceServer>>>();
let sessionRef: any;
let lastWorkingDirectory: string | undefined;

const canvas = createCanvas({
    id: 'markdown-review',
    displayName: 'Markdown Review',
    description: 'Review a local Markdown document with rendered content, anchored comments, threads, and agent handoff.',
    inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
            filePath: {
                type: 'string',
                description: 'Absolute path, or a workspace-relative path, to the Markdown document to review.',
            },
        },
    },
    actions: [
        {
            name: 'get_state',
            description: 'Return the current Markdown review canvas state, including blocks and comments.',
            handler: async (ctx: any) => {
                const record = instances.get(ctx.instanceId);
                if (!record) {
                    throw new CanvasError('not_open', 'Markdown Review is not open.');
                }
                return buildCanvasState(record);
            },
        },
        {
            name: 'open_file',
            description: 'Open a Markdown file in the existing review canvas instance.',
            inputSchema: {
                type: 'object',
                required: ['filePath'],
                additionalProperties: false,
                properties: {
                    filePath: { type: 'string', description: 'Absolute or workspace-relative Markdown path.' },
                },
            },
            handler: async (ctx: any) => {
                const record = instances.get(ctx.instanceId);
                if (!record) {
                    throw new CanvasError('not_open', 'Markdown Review is not open.');
                }
                setCanvasFile(record, ctx.input.filePath);
                return buildCanvasState(record);
            },
        },
        {
            name: 'refresh',
            description: 'Refresh the open Markdown review canvas from disk.',
            handler: async (ctx: any) => {
                const record = instances.get(ctx.instanceId);
                if (!record) {
                    throw new CanvasError('not_open', 'Markdown Review is not open.');
                }
                record.broadcast({ type: 'refresh' });
                return buildCanvasState(record);
            },
        },
    ],
    open: async (ctx: any) => {
        const workingDirectory = ctx.session?.workingDirectory || lastWorkingDirectory || sessionRef.workspacePath;
        if (workingDirectory) {
            lastWorkingDirectory = workingDirectory;
        }
        const filePath = resolveInitialMarkdownPath(ctx.input?.filePath, workingDirectory);
        let record = instances.get(ctx.instanceId);
        if (!record) {
            const events = await sessionRef.getEvents();
            const directPromptAvailable = events.some((event: any) =>
                event.type === 'user.message' || event.type === 'assistant.message',
            );
            record = await createInstanceServer({
                instanceId: ctx.instanceId,
                filePath,
                workingDirectory,
                directPromptAvailable,
                sendPrompt: async (prompt: string) => {
                    if (!record?.directPromptAvailable) {
                        return { delivered: false, reason: 'empty-session' as const };
                    }
                    await sessionRef.send({ prompt });
                    return { delivered: true };
                },
                log: log,
            });
            instances.set(ctx.instanceId, record);
        } else if (filePath) {
            setCanvasFile(record, filePath);
        }
        return {
            title: filePath ? `Review: ${basename(filePath)}` : 'Markdown Review',
            status: filePath ? basename(filePath) : 'Choose a Markdown file',
            url: record.url,
        };
    },
    onClose: async (ctx: any) => {
        const record = instances.get(ctx.instanceId);
        if (record) {
            instances.delete(ctx.instanceId);
            await closeInstanceServer(record);
        }
    },
});

canvas.declaration.icon = 'assets/icon.png';
sessionRef = await joinSession({ canvases: [canvas] });

if (sessionRef.workspacePath) {
    lastWorkingDirectory = sessionRef.workspacePath;
}

sessionRef.on('session.idle', () => {
    for (const record of instances.values()) {
        record.broadcast({ type: 'refresh' });
    }
});

sessionRef.on('user.message', () => {
    for (const record of instances.values()) {
        if (!record.directPromptAvailable) {
            record.directPromptAvailable = true;
            record.broadcast({ type: 'refresh' });
        }
    }
});

function log(message: string, options?: object): void {
    try {
        sessionRef.log(message, options);
    } catch {
        // Canvas logging is best effort.
    }
}