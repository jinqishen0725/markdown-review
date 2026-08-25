declare module '@github/copilot-sdk/extension' {
    export class CanvasError extends Error {
        constructor(code: string, message: string);
    }

    export function createCanvas(config: any): any;
    export function joinSession(config: any): Promise<any>;
}