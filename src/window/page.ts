/**
 * A page is one addressable segment of context: a frame, a claim, an evidence
 * item, a tool result. It points at an immutable object; the window decides
 * whether the text is resident, and `pinned` protects it from eviction.
 */
export interface Page {
    id: string;
    objectKind: string;
    objectId: string;
    tokens: number;
    pinned: number;
    lastUsed: number;
    content?: unknown;
}

export const pageKey: (kind: string, id: string) => string = (kind: string, id: string): string => `${kind}:${id}`;

export const pageIdFor: (kind: string, id: string) => string = (kind: string, id: string): string => `pg.${kind}.${id}`;
