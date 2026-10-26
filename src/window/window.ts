/**
 * Context window: the per-thread address space.
 *
 * The model never sees the whole ledger. It sees a resident set of pages bounded
 * by tokens; a miss is a `fault` that loads an immutable object, evicts the
 * least-recently-used unpinned page, and records the cost. This is the paging
 * model MemGPT argued for, made explicit: the page table is inspectable, and an
 * eviction is a decision, not a silent truncation.
 */
import type { ObjectRepository } from "../database/repository/objectRepository.ts";
import type { WindowPageInput } from "../database/repository/windowRepository.ts";
import { WindowError } from "../error/windowError.ts";
import { LRUUnorderedMap } from "../structure/lru.ts";
import { UnorderedMap } from "../structure/unordered.ts";
import type { Page } from "./page.ts";
import { pageIdFor, pageKey } from "./page.ts";

export interface ContextWindowOptions {
    capacityTokens: number;
    /** Hard page ceiling; defaults to 128. */
    maxPages?: number;
    now?: () => number;
    /** Optional loader for page content; a miss without it yields a token-only page. */
    objects?: ObjectRepository;
}

export interface WindowStats {
    hits: number;
    faults: number;
    evictions: number;
    usedTokens: number;
    capacityTokens: number;
    pages: number;
}

export class ContextWindow {
    readonly capacityTokens: number;
    readonly maxPages: number;
    private readonly resident: LRUUnorderedMap<string, Page>;
    private readonly table: UnorderedMap<string, string>;
    private readonly now: () => number;
    private readonly objects?: ObjectRepository;
    private used: number = 0;
    private hits: number = 0;
    private faults: number = 0;
    private evictions: number = 0;

    constructor(options: ContextWindowOptions) {
        if (!Number.isSafeInteger(options.capacityTokens) || options.capacityTokens <= 0) {
            throw new RangeError("capacityTokens must be a positive safe integer");
        }
        this.capacityTokens = options.capacityTokens;
        this.maxPages = options.maxPages ?? 128;
        this.resident = new LRUUnorderedMap<string, Page>(this.maxPages);
        this.table = new UnorderedMap<string, string>();
        this.now = options.now ?? (() => Date.now());
        if (options.objects !== undefined) this.objects = options.objects;
    }

    has(kind: string, id: string): boolean {
        return this.table.has(pageKey(kind, id));
    }

    /** Load a page into the resident set, evicting unpinned pages if needed. */
    fault(kind: string, id: string, tokens: number, content?: unknown): Page {
        if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new RangeError("tokens must be a positive safe integer");
        const key: string = pageKey(kind, id);
        const existingId: string | undefined = this.table.get(key);
        if (existingId !== undefined) {
            const existing: Page | undefined = this.resident.get(existingId);
            if (existing !== undefined) {
                this.hits += 1;
                return existing;
            }
            this.table.delete(key);
        }

        if (tokens > this.capacityTokens) {
            throw new WindowError("window_full", [`${key} needs ${tokens} tokens, window holds ${this.capacityTokens}`]);
        }
        this.evictUntil(tokens);
        const page: Page = {
            id: pageIdFor(kind, id),
            objectKind: kind,
            objectId: id,
            tokens,
            pinned: 0,
            lastUsed: this.now(),
        };
        const loaded: unknown = content ?? this.load(kind, id);
        if (loaded !== undefined) page.content = loaded;
        this.resident.set(page.id, page);
        this.table.set(key, page.id);
        this.used += tokens;
        this.faults += 1;
        return page;
    }

    /** Pin a page so eviction cannot remove it; returns the new pin count. */
    pin(kind: string, id: string): number {
        const page: Page | undefined = this.pageOf(kind, id);
        if (page === undefined) throw new WindowError("unknown_page", [pageKey(kind, id)]);
        page.pinned += 1;
        return page.pinned;
    }

    unpin(kind: string, id: string): number {
        const page: Page | undefined = this.pageOf(kind, id);
        if (page === undefined) throw new WindowError("unknown_page", [pageKey(kind, id)]);
        page.pinned = Math.max(0, page.pinned - 1);
        return page.pinned;
    }

    /** Remove a page regardless of pin count (explicit release, not eviction). */
    release(kind: string, id: string): boolean {
        const key: string = pageKey(kind, id);
        const pageId: string | undefined = this.table.get(key);
        if (pageId === undefined) return false;
        const page: Page | undefined = this.resident.get(pageId);
        if (page !== undefined) this.used -= page.tokens;
        this.resident.delete(pageId);
        this.table.delete(key);
        return true;
    }

    pageOf(kind: string, id: string): Page | undefined {
        const pageId: string | undefined = this.table.get(pageKey(kind, id));
        return pageId === undefined ? undefined : this.resident.get(pageId);
    }

    entries(): Page[] {
        return [...this.resident.values()];
    }

    snapshot(): WindowPageInput[] {
        return this.entries().map((page) => ({
            pageId: page.id,
            objectKind: page.objectKind,
            objectId: page.objectId,
            tokens: page.tokens,
            pinned: page.pinned > 0,
            lastUsed: page.lastUsed,
        }));
    }

    restore(pages: readonly WindowPageInput[]): void {
        this.resident.clear();
        this.table.clear();
        this.used = 0;
        for (const page of pages) {
            const restored: Page = {
                id: page.pageId,
                objectKind: page.objectKind,
                objectId: page.objectId,
                tokens: page.tokens,
                pinned: page.pinned ? 1 : 0,
                lastUsed: page.lastUsed,
            };
            this.resident.set(restored.id, restored);
            this.table.set(pageKey(page.objectKind, page.objectId), restored.id);
            this.used += restored.tokens;
        }
    }

    get usedTokens(): number {
        return this.used;
    }

    stats(): WindowStats {
        return {
            hits: this.hits,
            faults: this.faults,
            evictions: this.evictions,
            usedTokens: this.used,
            capacityTokens: this.capacityTokens,
            pages: this.resident.size,
        };
    }

    private evictUntil(incoming: number): void {
        while (this.used + incoming > this.capacityTokens || this.resident.size >= this.maxPages) {
            const victim: Page | undefined = this.leastRecentUnpinned();
            if (victim === undefined) {
                throw new WindowError("window_full", [`no unpinned page can make room for ${incoming} tokens`]);
            }
            this.used -= victim.tokens;
            this.resident.delete(victim.id);
            this.table.delete(pageKey(victim.objectKind, victim.objectId));
            this.evictions += 1;
        }
    }

    private leastRecentUnpinned(): Page | undefined {
        let victim: Page | undefined;
        for (const page of this.resident.values()) {
            if (page.pinned > 0) continue;
            if (victim === undefined || page.lastUsed < victim.lastUsed) victim = page;
        }
        return victim;
    }

    private load(kind: string, id: string): unknown {
        if (this.objects === undefined) return undefined;
        const row = this.objects.find(kind, id);
        if (row === undefined) return undefined;
        try {
            return JSON.parse(row.body) as unknown;
        } catch {
            return row.body;
        }
    }
}
