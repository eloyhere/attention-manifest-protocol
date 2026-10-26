import type { Handle } from "../types/common.ts";
import { sha256Hex } from "../semantic/sha256.ts";

export interface HandlePage {
    text: string;
    next: number | null;
    totalPages: number;
    tokens: number;
}

interface StoredHandle {
    handle: Handle;
    content: string;
    createdAt: number;
}

const CharsPerToken: number = 4;

/**
 * Content-addressed handle store.
 *
 * Handles are opaque names, not capabilities: possession of an id must not be
 * sufficient to read it in a real host (scope + session binding live outside
 * this reference implementation, see architecture §11.1 T5).
 */
export class HandleStore {
    private records: Map<string, StoredHandle> = new Map();
    private seq = 0;

    put(content: string, kind: Handle["kind"], tokens: number, scope: Handle["scope"] = "session", ttlMs = 900_000): Handle {
        this.seq += 1;
        const id: string = `h.${sha256Hex(`${kind}:${this.seq}:${content.length}`).slice(0, 10)}`;
        const handle: Handle = { id, kind, tokens, scope, ttl_ms: ttlMs };
        this.records.set(id, { handle, content, createdAt: Date.now() });
        return handle;
    }

    has(id: string): boolean {
        return this.records.has(id);
    }

    get(id: string): Handle | undefined {
        return this.records.get(id)?.handle;
    }

    /**
     * Deterministic paging: same cursor always returns the same window.
     */
    read(id: string, cursor: number, limitTokens = 240): HandlePage {
        const record: StoredHandle | undefined = this.records.get(id);
        if (!record) {
            throw new Error(`unknown handle: ${id}`);
        }
        const window: number = Math.max(1, limitTokens * CharsPerToken);
        const start: number = Math.max(0, Math.min(cursor, record.content.length));
        const end: number = Math.min(record.content.length, start + window);
        const text: string = record.content.slice(start, end);
        return {
            text,
            next: end < record.content.length ? end : null,
            totalPages: Math.ceil(record.content.length / window),
            tokens: Math.ceil(text.length / CharsPerToken),
        };
    }
}
