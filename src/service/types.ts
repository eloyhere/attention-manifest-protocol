/** Service-layer contracts for the persistence store and its JPA-style facade. */

import type { CacheStats, EntityCacheOptions } from "../cache/types.ts";
import type { CascadeType, FetchType } from "../entity/types.ts";

export interface StoreOptions {
    /** A directory (the store file is created inside it) or an explicit `.sqlite` file. */
    readonly path?: string;
    readonly cache?: Partial<EntityCacheOptions>;
    readonly now?: () => string;
    readonly wal?: boolean;
    /**
     * Maximum number of cascade edges below the root aggregate. `Store.save`
     * and `Store.remove`/`removeCascade` refuse deeper graphs with a stable
     * `cascade_depth` error. Defaults to 8.
     */
    readonly cascadeDepth?: number;
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

/**
 * Cascade selection for {@link Store.save}.
 *
 * - `"none"` (default) keeps the historical single-row behaviour.
 * - `"persist"` saves the entities found on associations whose declaration
 *   includes `persist`.
 * - `"all"` saves the entities found on every association, even when the
 *   declaration does not opt in. Only entity objects are followed; scalar ids
 *   embedded in a payload stay references and are not persisted. Because
 *   `"all"` also follows `many_to_one` references, reserve it for aggregate
 *   trees the caller fully owns.
 */
export type SaveCascade = "none" | "persist" | "all";

/**
 * Cascade selection for {@link Store.remove} / {@link Store.removeCascade}.
 *
 * - `"none"` (default) removes only the addressed row.
 * - `"remove"` removes children found on associations whose declaration
 *   includes `remove` or `orphanRemoval`.
 * - `"all"` follows every association, including `many_to_one` references.
 *   Use it only when the caller owns the whole referenced graph; otherwise
 *   declare `remove`/`orphanRemoval` instead.
 */
export type RemoveCascade = "none" | "remove" | "all";

/**
 * Options for {@link Store.save}. `expectedVersion` enables compare-and-swap
 * for the addressed row; it is not applied to cascade descendants, which are
 * written with the `version` carried by their payload.
 */
export interface SaveOptions {
    readonly expectedVersion?: number;
    readonly cascade?: SaveCascade;
}

/** Options for {@link Store.remove} and {@link Store.removeCascade}. */
export interface RemoveOptions {
    readonly cascade?: RemoveCascade;
}

/** Number of rows deleted by one cascade-aware remove call, root included. */
export interface RemoveReport {
    readonly removed: number;
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
 * and `optional` for every association. Cascades never run implicitly:
 * `Store.save` executes `persist` only when the caller passes
 * `{ cascade: "persist" | "all" }`, and `Store.remove`/`removeCascade` execute
 * `remove` only for `{ cascade: "remove" | "all" }` (including associations
 * whose declaration sets `orphanRemoval`). `merge`, `refresh` and `detach`
 * stay declarative. Keeping the shape here documents the metadata seam.
 */
export interface CascadePolicy {
    readonly type: CascadeType;
    readonly fetch: FetchType;
    readonly orphanRemoval: boolean;
    readonly optional: boolean;
    /** True when `Store` can execute this cascade type on request. */
    readonly implemented: boolean;
}
