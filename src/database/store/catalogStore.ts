import { catalogKey } from "../entity/catalog.ts";
import type { CatalogEntryEntity, CatalogRecord } from "../entity/catalog.ts";
import type { CatalogService } from "../service/catalogService.ts";
import { Store } from "./store.ts";
import type { StoreOptions } from "./store.ts";

/** Instance-owned read-through cache of stable catalog key to database row. */
export class CatalogStore extends Store<CatalogEntryEntity, string, CatalogService> {
    private readonly unsubscribe: () => void;
    private readonly generations = new Map<string, number>();

    constructor(service: CatalogService, options: StoreOptions = {}) {
        super(service, options);
        this.unsubscribe = service.onChange(() => this.clear());
    }

    /** Observe commits made by approved repositories or another connection. */
    private observeGeneration(key: string): boolean {
        let tuple: unknown;
        try { tuple = JSON.parse(key); } catch { return false; }
        if (!Array.isArray(tuple) || tuple.length !== 3 ||
            !tuple.every((part) => typeof part === "string" && part.trim().length > 0) || JSON.stringify(tuple) !== key) return false;
        const namespace = tuple[0] as string;
        const generation = this.service.state(namespace).generation;
        if (this.generations.get(namespace) !== generation) {
            super.clear();
            this.generations.clear();
            this.generations.set(namespace, generation);
        }
        return true;
    }

    override findById(key: string): CatalogEntryEntity | undefined {
        const current = !this.service.inTransaction && this.observeGeneration(key);
        // A SAVEPOINT release may still be inside an outer transaction. Never
        // retain its uncommitted rows: a later rollback cannot notify this store.
        const row = current ? super.findById(key) : this.service.findById(key);
        return row === undefined ? undefined : { ...row };
    }

    override requireById(key: string, entityName?: string): CatalogEntryEntity {
        const current = !this.service.inTransaction && this.observeGeneration(key);
        const row = current ? super.requireById(key, entityName) : this.service.requireById(key, entityName);
        return { ...row };
    }

    override contains(key: string): boolean {
        return !this.service.inTransaction && this.observeGeneration(key) && super.contains(key);
    }

    override clear(): void {
        super.clear();
        this.generations.clear();
    }

    override put(key: string, row: CatalogEntryEntity): void {
        if (!this.service.inTransaction) {
            super.put(key, { ...row });
        }
    }

    /** Store's base class reserves its private read method for cache lookups. */
    readRecord(namespace: string, kind: string, id: string): CatalogRecord | undefined {
        for (const value of [namespace, kind, id]) {
            if (typeof value !== "string" || value.trim().length === 0) {
                throw new TypeError("namespace, kind and id must be nonempty strings");
            }
        }
        const row = this.findById(catalogKey(namespace, kind, id));
        return row === undefined ? undefined : this.service.recordFromEntry(row);
    }

    dispose(): void {
        this.unsubscribe();
        this.clear();
    }
}
