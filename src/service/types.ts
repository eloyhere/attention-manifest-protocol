/** Service-layer contracts for the persistence store and its JPA-style facade. */

import type { CacheStats, EntityCacheOptions } from "../cache/types.ts";
import type { CascadeType, FetchType } from "../entity/types.ts";

export interface StoreOptions {
    /** A directory (the store file is created inside it) or an explicit `.sqlite` file. */
    readonly path?: string;
    readonly cache?: Partial<EntityCacheOptions>;
    readonly now?: () => string;
    readonly wal?: boolean;
}

export interface StoreStats {
    /** Total number of persisted entity rows, across every entity kind. */
    readonly entities: number;
    /** Total number of persisted events. */
    readonly events: number;
    /** Number of entity identities currently registered by this store instance. */
    readonly identity: number;
    readonly cache: CacheStats;
    readonly schemaVersion: number;
}

/** Options for {@link Store.save}; `expectedVersion` enables compare-and-swap. */
export interface SaveOptions {
    readonly expectedVersion?: number;
}

/** Options for {@link Store.events}. */
export interface EventQuery {
    readonly kind?: string;
    readonly limit?: number;
}

/**
 * Cascade policy projected from `EntityMetadata.associations`.
 *
 * The JPA entity metadata already declares `cascade`, `fetch`, `orphanRemoval`
 * and `optional` for every association. This release deliberately does **not**
 * execute cascades: `persist`/`merge`/`remove`/`refresh`/`detach` remain
 * declarative metadata (reported as a known gap), because cascading deletes or
 * refreshes across aggregates needs explicit ownership and transaction policy.
 * Keeping the shape here documents the reserved seam; `implemented` is always
 * `false` until a later release wires it into `Store`.
 */
export interface CascadePolicy {
    readonly type: CascadeType;
    readonly fetch: FetchType;
    readonly orphanRemoval: boolean;
    readonly optional: boolean;
    readonly implemented: false;
}
