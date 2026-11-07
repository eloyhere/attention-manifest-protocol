/**
 * Entity mappers: the only place the persistence layer talks to {@link Store}.
 *
 * Every function writes and reads through the store's managed proxies, so an
 * identity is shared process-wide: `persistEntity` returns the proxy that
 * `store.load` will return for the same `<database path, kind, id>`.
 *
 * Lifecycle hooks from `src/entity/lifecycle.ts` fire around the store call:
 * `prePersist`/`postPersist` for a `new` identity, `preUpdate`/`postUpdate`
 * otherwise, `preRemove`/`postRemove` around removal and `postLoad` after an
 * eager load. Hooks observe detached snapshots, never the managed proxy.
 */

import { descriptorFor } from "../entity/index.ts";
import type { EntityFilter, EntityKind, EntityState } from "../entity/types.ts";
import type { Store } from "../service/store.ts";
import type { SaveOptions } from "../service/types.ts";
import { fireEntityLifecycle, lifecycleContext } from "./lifecycle.ts";
import type { Persisted } from "./types.ts";

const NOT_FOUND_MESSAGE = "not_found";

/** True when a store operation failed because the identity has no row. */
export function isMissingEntity(error: unknown): boolean {
    return error instanceof Error && error.message === NOT_FOUND_MESSAGE;
}

/**
 * Detaches a managed proxy into a plain structured-cloneable value.
 *
 * Store proxies expose `toJSON()`; `structuredClone` on a proxy would otherwise
 * clone its empty target instead of the loaded snapshot.
 */
export function plainEntity<T>(entity: T): T {
    const candidate = entity as unknown as { toJSON?: () => unknown } | null;
    if (candidate !== null && typeof candidate === "object" && typeof candidate.toJSON === "function") {
        return structuredClone(candidate.toJSON()) as T;
    }
    return structuredClone(entity);
}

/** Non-negative safe version of an entity, or `0` for versionless records. */
function versionOf(entity: unknown): number {
    if (typeof entity !== "object" || entity === null || Array.isArray(entity)) return 0;
    const version = (entity as Readonly<Record<string, unknown>>).version;
    return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

/**
 * Lifecycle view of one entity.
 *
 * The entity layer's default guards address every aggregate by `id` (with
 * `store_meta` as the sole `key` exception), while several kinds are keyed by
 * `budgetKey`, `manifestId`, ... or a composite key. The hook view therefore
 * carries a synthetic `id` equal to the descriptor key; the persisted entity is
 * untouched. This keeps hooks firing without teaching persistence a second
 * identity scheme.
 */
function lifecycleView<K extends EntityKind>(kind: K, entity: unknown): unknown {
    if (typeof entity !== "object" || entity === null || Array.isArray(entity)) return entity;
    const record = entity as Readonly<Record<string, unknown>>;
    if (typeof record.id === "string" && record.id.length > 0) return entity;
    try {
        return { ...record, id: descriptorFor(kind).keyOf(record as never) };
    } catch {
        return entity;
    }
}

/**
 * Persists one entity and returns the managed proxy.
 *
 * The lifecycle pre-hook is `prePersist` for an identity the store reports as
 * `new` and `preUpdate` otherwise; the matching post-hook runs only after the
 * write-through succeeded. `options.expectedVersion` keeps compare-and-swap.
 */
export function persistEntity<K extends EntityKind>(
    store: Store,
    kind: K,
    entity: Persisted<K>,
    options: SaveOptions = {},
): Persisted<K> {
    const descriptor = descriptorFor<Persisted<K>>(kind);
    const id = descriptor.keyOf(entity);
    const state: EntityState = store.state(kind, id);
    // `removed` means the row is gone from this persistence context, so a new
    // write is a creation rather than an update.
    const creating = state === "new" || state === "removed";
    const snapshot = plainEntity(entity);
    fireEntityLifecycle(
        creating ? "prePersist" : "preUpdate",
        kind,
        lifecycleView(kind, snapshot),
        lifecycleContext(kind, creating ? "new" : state, versionOf(snapshot)),
    );
    const saved = store.save(kind, entity, options);
    const savedSnapshot = plainEntity(saved);
    fireEntityLifecycle(
        creating ? "postPersist" : "postUpdate",
        kind,
        lifecycleView(kind, savedSnapshot),
        lifecycleContext(kind, "managed", versionOf(savedSnapshot)),
    );
    return saved;
}

/** Eagerly loads one entity; `undefined` when the row does not exist. */
export function loadEntity<K extends EntityKind>(store: Store, kind: K, id: string): Persisted<K> | undefined {
    let entity: Persisted<K>;
    try {
        entity = store.resolve<Persisted<K>>(kind, id);
    } catch (error) {
        if (isMissingEntity(error)) return undefined;
        throw error;
    }
    const snapshot = plainEntity(entity);
    fireEntityLifecycle(
        "postLoad",
        kind,
        lifecycleView(kind, snapshot),
        lifecycleContext(kind, "managed", versionOf(snapshot)),
    );
    return entity;
}

/** Lists entities of one kind; results are managed proxies in store order. */
export function listEntities<K extends EntityKind>(
    store: Store,
    kind: K,
    filter?: EntityFilter,
): readonly Persisted<K>[] {
    return store.list<Persisted<K>>(kind, filter);
}

/**
 * Removes one entity after `preRemove`, then fires `postRemove` with a plain
 * snapshot because the managed proxy is unusable once the row is gone.
 */
export function removeEntity<K extends EntityKind>(store: Store, kind: K, id: string): boolean {
    let entity: Persisted<K>;
    try {
        entity = store.resolve<Persisted<K>>(kind, id);
    } catch (error) {
        if (isMissingEntity(error)) return false;
        throw error;
    }
    const snapshot = plainEntity(entity);
    const view = lifecycleView(kind, snapshot);
    fireEntityLifecycle("preRemove", kind, view, lifecycleContext(kind, "managed", versionOf(snapshot)));
    if (!store.remove(kind, id)) return false;
    fireEntityLifecycle("postRemove", kind, view, lifecycleContext(kind, "removed", versionOf(snapshot)));
    return true;
}
