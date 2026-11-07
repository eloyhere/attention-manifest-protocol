import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { createEntityCache } from "../cache/index.ts";
import type { EntityCache } from "../cache/types.ts";
import { createConnectionPool } from "../connection/index.ts";
import type { Connection, ConnectionPool, Transaction } from "../connection/types.ts";
import { ENTITY_REGISTRY, descriptorFor, entityKey } from "../entity/index.ts";
import type {
    Association,
    EntityDescriptor,
    EntityFilter,
    EntityKind,
    EntityState,
    EventRecord,
} from "../entity/types.ts";
import { appendEvent as appendRepositoryEvent, createSqliteRepository, readEvents } from "../repository/index.ts";
import type { Repository } from "../repository/types.ts";
import { migrate, openSqlite, schemaVersion } from "../sql/index.ts";
import type { SqlDriver, SqlRow } from "../sql/types.ts";
import {
    associationCascades,
    CascadeError,
    cascadeDepthOf,
    entityReferences,
    joinPropertiesOf,
    referenceIds,
    removeCascadeOf,
    saveCascadeOf,
} from "./cascade.ts";
import type {
    EventQuery,
    RemoveOptions,
    RemoveReport,
    SaveOptions,
    StoreOptions,
    StoreStats,
} from "./types.ts";

/** Default hidden directory under the current working directory. */
export const DEFAULT_STORE_DIRECTORY = ".attention-manifest-protocol";
/** Default SQLite file name inside {@link DEFAULT_STORE_DIRECTORY}. */
export const DEFAULT_STORE_FILE = "store.sqlite";

const CLOSED_MESSAGE = "store is closed";
const NOT_FOUND_MESSAGE = "not_found";
/** Marker used to recognise our own proxies without exporting a private symbol. */
const PROXY_MARKER = Symbol.for("attention-manifest-protocol.store.proxy");
const ARRAY_MUTATORS = new Set(["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]);

type AnyEntity = Record<string, unknown>;
type PropertyPath = readonly PropertyKey[];

interface EntitySlot {
    readonly key: string;
    readonly kind: EntityKind;
    readonly id: string;
    proxy: object;
    readonly owners: Set<Store>;
    target: AnyEntity | undefined;
    version: number;
    loaded: boolean;
    missing: boolean;
    state: EntityState;
    closed: boolean;
}

interface IndexReport {
    readonly applied: readonly string[];
    readonly skipped: readonly string[];
}

/** Process-wide identity table: `<absolute database path>#<kind>:<id>`. */
const identities = new Map<string, EntitySlot>();
const poolsByPath = new Map<string, { pool: ConnectionPool; connection: Connection; owners: Set<Store> }>();
let memorySequence = 0;

function isOpenable(value: string): boolean {
    return value.length > 0;
}

/** Canonical absolute file path; a directory receives the default file name. */
function storeFileOf(input: string | undefined): string {
    if (input === undefined || input.length === 0) {
        return join(resolve(process.cwd()), DEFAULT_STORE_DIRECTORY, DEFAULT_STORE_FILE);
    }
    if (input === ":memory:") return input;
    const absolute = resolve(input);
    let existing: ReturnType<typeof statSync> | undefined;
    try {
        existing = statSync(absolute);
    } catch {
        existing = undefined;
    }
    if (existing?.isDirectory() === true) return join(absolute, DEFAULT_STORE_FILE);
    if (existing?.isFile() === true) return absolute;
    if (/\.sqlite$/i.test(absolute)) return absolute;
    return join(absolute, DEFAULT_STORE_FILE);
}

/** Lower-cases only the Windows drive letter, keeping the rest of the path stable. */
function canonicalFile(file: string): string {
    if (file === ":memory:" || process.platform !== "win32") return file;
    return file.charAt(0).toLowerCase() + file.slice(1);
}

function isProxyable(value: unknown): value is object {
    return typeof value === "object" && value !== null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return isProxyable(value) && typeof (value as { then?: unknown }).then === "function";
}

function readAtPath(value: unknown, path: PropertyPath): unknown {
    let current = value;
    for (const key of path) {
        if (current === null || current === undefined) return undefined;
        current = (current as Record<PropertyKey, unknown>)[key];
    }
    return current;
}

function writeAtPath(root: AnyEntity, path: PropertyPath, property: PropertyKey, value: unknown): void {
    const container = path.length === 0 ? root : readAtPath(root, path);
    if (container === null || typeof container !== "object") throw new TypeError("cannot write through a missing container");
    (container as Record<PropertyKey, unknown>)[property] = value;
}

function deleteAtPath(root: AnyEntity, path: PropertyPath, property: PropertyKey): boolean {
    const container = path.length === 0 ? root : readAtPath(root, path);
    if (container === null || typeof container !== "object") return true;
    return Reflect.deleteProperty(container, property);
}

/** Deep copy that unwraps our own proxies and detaches caller-owned objects. */
function plainCopy<T>(value: T): T {
    if (!isProxyable(value)) return value;
    if ((value as Record<symbol, unknown>)[PROXY_MARKER] === true) {
        return plainCopy((value as unknown as { toJSON(): unknown }).toJSON()) as T;
    }
    if (Array.isArray(value)) return value.map((item) => plainCopy(item)) as T;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) output[key] = plainCopy((value as Record<string, unknown>)[key]);
    return output as T;
}

function cloneEntity<T>(entity: T): T {
    try {
        return structuredClone(entity);
    } catch {
        return plainCopy(entity);
    }
}

function versionOf<T>(descriptor: EntityDescriptor<T>, entity: T): number {
    const value = descriptor.versionOf(entity);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function syncArrayTarget(container: unknown, target: unknown[]): void {
    if (!Array.isArray(container)) {
        target.length = 0;
        return;
    }
    target.length = container.length;
    for (let index = 0; index < container.length; index += 1) {
        if (index in container) target[index] = container[index];
        else delete target[index];
    }
}

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function countRows(driver: SqlDriver, table: "entities" | "events"): number {
    const rows = driver.query<SqlRow & { readonly count: number | bigint }>({ sql: `SELECT COUNT(*) AS count FROM ${table}` });
    const value = rows[0]?.count ?? 0;
    return typeof value === "bigint" ? Number(value) : value;
}

/**
 * SQLite-backed service store with a JPA-style persistence context.
 *
 * A single proxy per identity exists for the lifetime of a database path
 * (module-level identity table), even across `Store` instances. Proxies load on
 * first read and write through on every mutation with optimistic
 * compare-and-swap. `transaction` uses the shared connection pool and nested
 * savepoints; writes participate immediately, so a thrown error rolls back rows,
 * cache and loaded proxy state together.
 */
export class Store {
    static open(options: StoreOptions = {}): Store {
        // Validate cascade policy before a database connection is opened.
        cascadeDepthOf(options.cascadeDepth);
        const file = storeFileOf(options.path);
        const identityPath = file === ":memory:" ? `${file}#${++memorySequence}` : canonicalFile(file);
        return new Store(file, identityPath, options);
    }

    readonly path: string;
    private readonly identityPath: string;
    private readonly pool: ConnectionPool;
    private readonly driver: SqlDriver;
    private readonly cache: EntityCache;
    private transactionContext: Transaction | undefined;
    private readonly connection: Connection;
    private readonly now: () => string;
    private readonly cascadeDepth: number;
    private readonly repositories = new Map<EntityKind, Repository<unknown>>();
    private readonly identities = new Set<string>();
    private readonly detachedKeys = new Set<string>();
    private readonly removedKeys = new Set<string>();
    private readonly appliedIndexNames: string[] = [];
    private readonly skippedIndexNames: string[] = [];
    private activeTransactionWrites: Set<string> | undefined;
    private activeTransactionRemovals: Set<string> | undefined;
    private openState: boolean;

    private constructor(path: string, identityPath: string, options: StoreOptions) {
        this.path = path;
        this.identityPath = identityPath;
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        this.now = options.now ?? (() => new Date().toISOString());
        this.cascadeDepth = cascadeDepthOf(options.cascadeDepth);
        const pooled = poolsByPath.get(identityPath);
        if (pooled !== undefined) {
            this.pool = pooled.pool;
            this.connection = pooled.connection;
            this.driver = pooled.connection.driver;
            pooled.owners.add(this);
        } else {
            let connection: Connection | undefined;
            this.pool = createConnectionPool({
                maxConnections: 1,
                open: () => openSqlite({
                    path,
                    wal: options.wal ?? true,
                    foreignKeys: true,
                    busyTimeoutMilliseconds: 5_000,
                }),
            });
            try {
                connection = this.pool.acquire();
                this.connection = connection;
                this.driver = connection.driver;
                migrate(this.driver);
                this.applyJpaIndexes();
            } catch (error) {
                connection?.release();
                this.pool.close();
                throw error;
            }
            poolsByPath.set(identityPath, { pool: this.pool, connection: this.connection, owners: new Set([this]) });
        }
        this.cache = createEntityCache(options.cache);
        this.openState = true;
    }

    get open(): boolean {
        return this.openState;
    }

    /** Declarative index application report (`@Index` / `@UniqueConstraint`). */
    get indexReport(): IndexReport {
        return {
            applied: Object.freeze([...this.appliedIndexNames]),
            skipped: Object.freeze([...this.skippedIndexNames]),
        };
    }

    /** Returns the process-wide unique managed proxy; never reads the database here. */
    load<T>(kind: EntityKind, id: string): T | undefined {
        this.assertOpen();
        if (!isOpenable(id)) throw new TypeError("entity id must be a non-empty string");
        return this.getOrCreateSlot(kind, id).proxy as T;
    }

    /** Eagerly checks existence, then returns the same managed proxy as {@link load}. */
    resolve<T>(kind: EntityKind, id: string): T {
        this.assertOpen();
        if (!isOpenable(id)) throw new TypeError("entity id must be a non-empty string");
        const descriptor = this.descriptor<T>(kind);
        const slot = this.getOrCreateSlot(kind, id);
        const owner = this.liveOwner(slot);
        const entity = owner.repository<T>(kind).get(id);
        if (entity === undefined) {
            slot.loaded = true;
            slot.missing = true;
            slot.target = undefined;
            slot.version = 0;
            throw new Error(NOT_FOUND_MESSAGE);
        }
        owner.hydrate(slot, entity, descriptor);
        return slot.proxy as T;
    }

    /**
     * Saves one aggregate.
     *
     * `cascade` defaults to `"none"`, which keeps the historical single-row
     * write. `"persist"` also saves the entity objects found on associations
     * whose declaration includes `persist`; `"all"` follows every association.
     * The root and every descendant are written in one transaction, so a
     * failing descendant rolls the root back as well. Cycle (`cascade_cycle`)
     * and depth (`cascade_depth`) violations raise a {@link CascadeError}.
     */
    save<T>(kind: EntityKind, entity: T, options: SaveOptions = {}): T {
        this.assertOpen();
        const cascade = saveCascadeOf(options.cascade);
        if (cascade === "none") return this.saveEntity(kind, entity, options);
        if (!isProxyable(entity)) throw new TypeError("entity must be an object");
        const snapshot = cloneEntity(entity) as unknown as Readonly<Record<string, unknown>>;
        const rootKey = entityKey(kind, this.descriptor<T>(kind).keyOf(entity));
        return this.transaction((transaction) => {
            const saved = transaction.saveEntity(kind, entity, options);
            transaction.persistCascade(kind, snapshot, cascade, 0, new Set([rootKey]));
            return saved;
        });
    }

    /** Writes exactly one row; cascade recursion calls this directly inside its transaction. */
    private saveEntity<T>(kind: EntityKind, entity: T, options: SaveOptions = {}): T {
        this.assertOpen();
        if (!isProxyable(entity)) throw new TypeError("entity must be an object");
        const descriptor = this.descriptor<T>(kind);
        const id = descriptor.keyOf(entity);
        if (!isOpenable(id)) throw new Error("entity key is empty");
        const slot = this.getOrCreateSlot(kind, id);
        const owner = this.liveOwner(slot);
        const record = descriptor.encode(entity);
        const canonical = descriptor.decode({
            ...record,
            version: Number.isSafeInteger(record.version) && record.version >= 0 ? record.version : 0,
            updatedAt: typeof record.updatedAt === "string" && record.updatedAt.length > 0 ? record.updatedAt : owner.now(),
        });
        const written = owner.repository<T>(kind).put(canonical, options);
        owner.hydrate(slot, written, descriptor);
        owner.noteWrite(slot.key);
        return slot.proxy as T;
    }

    /**
     * Removes one aggregate.
     *
     * `cascade` defaults to `"none"`, which keeps the historical single-row
     * delete. `"remove"` also deletes children found on associations whose
     * declaration includes `remove` or `orphanRemoval`; `"all"` follows every
     * association. The whole cascade is one transaction, and a graph deeper
     * than `StoreOptions.cascadeDepth` raises `cascade_depth`. Returns whether
     * the root row was deleted; use {@link removeCascade} to receive a count.
     */
    remove(kind: EntityKind, id: string, options: RemoveOptions = {}): boolean {
        this.assertOpen();
        this.assertRemovalTarget(kind, id);
        const cascade = removeCascadeOf(options.cascade);
        if (cascade === "none") return this.removeEntity(kind, id);
        return this.cascadeRemove(kind, id, cascade).removed > 0;
    }

    /**
     * Cascade-aware {@link remove} that reports how many rows were deleted,
     * root included. With `"none"` the call is equivalent to `remove`.
     */
    removeCascade(kind: EntityKind, id: string, options: RemoveOptions = {}): RemoveReport {
        this.assertOpen();
        this.assertRemovalTarget(kind, id);
        const cascade = removeCascadeOf(options.cascade);
        if (cascade === "none") return { removed: this.removeEntity(kind, id) ? 1 : 0 };
        return this.cascadeRemove(kind, id, cascade);
    }

    /** Deletes exactly one row and invalidates its cache and identity. */
    private removeEntity(kind: EntityKind, id: string): boolean {
        const removed = this.repository(kind).delete(id);
        if (!removed) return false;
        const key = this.slotKey(kind, id);
        this.detachedKeys.delete(key);
        this.removedKeys.add(key);
        this.activeTransactionRemovals?.add(key);
        const slot = identities.get(key);
        if (slot !== undefined) {
            identities.delete(key);
            slot.state = "removed";
            slot.target = undefined;
            slot.owners.clear();
        }
        this.identities.delete(key);
        return true;
    }

    private assertRemovalTarget(kind: EntityKind, id: string): void {
        if (!isOpenable(id)) throw new TypeError("entity id must be a non-empty string");
        this.descriptor(kind);
    }

    private cascadeRemove(kind: EntityKind, id: string, cascade: "remove" | "all"): RemoveReport {
        return this.transaction((transaction) => {
            const removed = { count: 0 };
            transaction.cascadeRemoveNode(kind, id, cascade, 0, new Set<string>(), removed);
            return { removed: removed.count };
        });
    }

    /**
     * Depth-first removal of one identity and its cascade children. The row is
     * deleted before its descendants are visited so an exceeded depth limit
     * leaves provably deleted rows for the enclosing transaction to roll back.
     */
    private cascadeRemoveNode(
        kind: EntityKind,
        id: string,
        cascade: "remove" | "all",
        depth: number,
        visited: Set<string>,
        removed: { count: number },
    ): boolean {
        const key = entityKey(kind, id);
        if (visited.has(key)) return false;
        visited.add(key);
        if (depth > this.cascadeDepth) {
            throw new CascadeError("cascade_depth", `cascade depth limit ${this.cascadeDepth} exceeded at ${key}`);
        }
        const entity = this.repository<Readonly<Record<string, unknown>>>(kind).get(id);
        if (entity === undefined) return false;
        // Child ids are resolved before the parent row disappears.
        const children = this.cascadeRemovalChildren(kind, id, entity, cascade);
        const deleted = this.removeEntity(kind, id);
        if (deleted) removed.count += 1;
        for (const child of children) {
            this.cascadeRemoveNode(child.kind, child.id, cascade, depth + 1, visited, removed);
        }
        return deleted;
    }

    /**
     * Child identities for one removed aggregate. Both sources are consulted:
     * references embedded in the parent payload (objects or scalar ids) and
     * child rows whose declared reverse link equals the parent id. The list is
     * scoped by the parent `sessionId` when the parent payload carries one.
     */
    private cascadeRemovalChildren(
        kind: EntityKind,
        id: string,
        entity: Readonly<Record<string, unknown>>,
        cascade: "remove" | "all",
    ): readonly { readonly kind: EntityKind; readonly id: string }[] {
        const children: { kind: EntityKind; id: string }[] = [];
        const seen = new Set<string>();
        for (const association of ENTITY_REGISTRY[kind].associations) {
            if (!associationCascades(association, cascade, "remove")) continue;
            const target = association.target;
            const descriptor = this.descriptor<unknown>(target);
            const add = (childId: string): void => {
                const childKey = entityKey(target, childId);
                if (seen.has(childKey)) return;
                seen.add(childKey);
                children.push({ kind: target, id: childId });
            };
            const referenced = entity[association.property];
            for (const reference of entityReferences(referenced)) {
                try {
                    add(descriptor.keyOf(reference));
                } catch {
                    // A payload may embed a non-entity reference; it is not a child.
                }
            }
            for (const referenceId of referenceIds(referenced)) add(referenceId);
            // A many-to-many join table is not materialised in the row schema;
            // embedded references above are its only available source.
            if (association.kind === "many_to_many") continue;
            const joinProperties = joinPropertiesOf(association);
            if (joinProperties.length === 0) continue;
            // Session scoping is the primary lookup. Payloads that do not carry
            // a sessionId (or carry a different one) are still found by the
            // declared reverse link through an unscoped pass.
            const parentSession = typeof entity.sessionId === "string" && entity.sessionId.length > 0
                ? entity.sessionId
                : undefined;
            const candidates: readonly unknown[] = parentSession === undefined
                ? this.list<unknown>(target)
                : [...this.list<unknown>(target, { sessionId: parentSession }), ...this.list<unknown>(target)];
            for (const child of candidates) {
                const record = child as Readonly<Record<string, unknown>>;
                if (joinProperties.some(property => record[property] === id)) add(descriptor.keyOf(child));
            }
        }
        return children;
    }

    /**
     * Recursive save for one aggregate's cascade children. `path` holds the
     * identities of the current branch so a payload cycle is rejected instead
     * of recursing forever; `depth` counts edges below the transaction root.
     */
    private persistCascade(
        kind: EntityKind,
        entity: Readonly<Record<string, unknown>>,
        cascade: "persist" | "all",
        depth: number,
        path: Set<string>,
    ): void {
        if (depth > this.cascadeDepth) {
            throw new CascadeError("cascade_depth", `cascade depth limit ${this.cascadeDepth} exceeded at ${kind}`);
        }
        for (const association of ENTITY_REGISTRY[kind].associations) {
            if (!associationCascades(association, cascade, "persist")) continue;
            const childKind = association.target;
            for (const child of entityReferences(entity[association.property])) {
                const childId = this.descriptor<unknown>(childKind).keyOf(child);
                const childKey = entityKey(childKind, childId);
                if (path.has(childKey)) {
                    throw new CascadeError("cascade_cycle", `cascade path revisits ${childKey}`);
                }
                const childDepth = depth + 1;
                if (childDepth > this.cascadeDepth) {
                    throw new CascadeError("cascade_depth", `cascade depth limit ${this.cascadeDepth} exceeded at ${childKey}`);
                }
                this.saveEntity(childKind, child, {});
                path.add(childKey);
                try {
                    this.persistCascade(childKind, child, cascade, childDepth, path);
                } finally {
                    path.delete(childKey);
                }
            }
        }
    }

    list<T>(kind: EntityKind, filter?: EntityFilter): readonly T[] {
        this.assertOpen();
        const descriptor = this.descriptor<T>(kind);
        const entities = this.repository<T>(kind).list(filter);
        return entities.map((entity) => {
            const slot = this.getOrCreateSlot(kind, descriptor.keyOf(entity));
            this.liveOwner(slot).hydrate(slot, entity, descriptor);
            return slot.proxy as T;
        });
    }

    appendEvent(kind: string, payload: unknown, entityId?: string): void {
        this.assertOpen();
        if (typeof kind !== "string" || kind.length === 0) throw new TypeError("event kind must be a non-empty string");
        appendRepositoryEvent(this.driver, {
            kind,
            payload,
            ...(entityId === undefined ? {} : { entityId }),
            recordedAt: this.now(),
        });
    }

    events(options: EventQuery = {}): readonly EventRecord[] {
        this.assertOpen();
        return readEvents(this.driver, options);
    }

    /** JPA lifecycle state for an identity in this persistence context. */
    state(kind: EntityKind, id: string): EntityState {
        this.assertOpen();
        if (!isOpenable(id)) throw new TypeError("entity id must be a non-empty string");
        this.descriptor(kind);
        const key = this.slotKey(kind, id);
        const slot = identities.get(key);
        if (slot !== undefined) return slot.state;
        if (this.removedKeys.has(key)) return "removed";
        if (this.detachedKeys.has(key)) return "detached";
        return this.repository(kind).get(id) === undefined ? "new" : "detached";
    }

    /**
     * Detaches an identity from the persistence context. The old proxy keeps
     * serving its local snapshot but subsequent writes stay local and are not
     * written through; `load`/`resolve` create a fresh managed proxy.
     */
    detach(kind: EntityKind, id: string): void {
        this.assertOpen();
        if (!isOpenable(id)) throw new TypeError("entity id must be a non-empty string");
        this.descriptor(kind);
        const key = this.slotKey(kind, id);
        this.removedKeys.delete(key);
        this.detachedKeys.add(key);
        this.cache.delete(entityKey(kind, id));
        const slot = identities.get(key);
        if (slot !== undefined) {
            identities.delete(key);
            slot.state = "detached";
            slot.owners.add(this);
        }
        this.identities.delete(key);
    }

    /** Forces a re-read from the repository and replaces the managed snapshot. */
    refresh<T>(kind: EntityKind, id: string): T {
        this.assertOpen();
        if (!isOpenable(id)) throw new TypeError("entity id must be a non-empty string");
        const descriptor = this.descriptor<T>(kind);
        const slot = this.getOrCreateSlot(kind, id);
        const owner = this.liveOwner(slot);
        for (const holder of slot.owners) holder.cache.delete(entityKey(kind, id));
        const entity = owner.repository<T>(kind).get(id);
        if (entity === undefined) {
            slot.loaded = true;
            slot.missing = true;
            slot.target = undefined;
            slot.version = 0;
            throw new Error(NOT_FOUND_MESSAGE);
        }
        owner.hydrate(slot, entity, descriptor);
        return slot.proxy as T;
    }

    /**
     * Association declarations of a kind. The metadata drives the opt-in
     * cascades of {@link save}/{@link remove}; this method exposes it for
     * inspection without executing anything.
     */
    cascadePlan(kind: EntityKind, id: string): readonly Association[] {
        this.assertOpen();
        if (!isOpenable(id)) throw new TypeError("entity id must be a non-empty string");
        this.descriptor(kind);
        void id;
        return Object.freeze([...ENTITY_REGISTRY[kind].associations]);
    }

    /**
     * Runs `work` inside a pooled writer transaction. Writes use the same
     * connection, so they participate in the transaction; on failure the SQL
     * transaction rolls back, the cache is cleared and every entity touched by
     * the transaction is marked unloaded so the next read re-reads the database.
     */
    transaction<T>(work: (store: Store) => T): T {
        this.assertOpen();
        const outermost = this.activeTransactionWrites === undefined;
        if (outermost) {
            this.activeTransactionWrites = new Set();
            this.activeTransactionRemovals = new Set();
        }
        const transaction = outermost ? this.connection.startTransaction() : this.transactionContext;
        if (transaction === undefined) throw new Error("transaction context is unavailable");
        const savePoint = outermost ? undefined : transaction.savePoint();
        const previousTransaction = this.transactionContext;
        this.transactionContext = transaction;
        try {
            const result = work(this);
            if (isThenable(result)) throw new TypeError("transaction work must be synchronous");
            if (savePoint !== undefined) savePoint.release();
            else transaction.commit();
            return result;
        } catch (error) {
            if (savePoint !== undefined) savePoint.rollback();
            else if (transaction.state === "active") transaction.rollback();
            this.cache.clear();
            for (const key of this.activeTransactionWrites ?? []) this.invalidateSlot(key);
            for (const key of this.activeTransactionRemovals ?? []) {
                this.removedKeys.delete(key);
                this.detachedKeys.delete(key);
            }
            this.activeTransactionWrites?.clear();
            this.activeTransactionRemovals?.clear();
            throw error;
        } finally {
            this.transactionContext = previousTransaction;
            if (outermost) {
                this.activeTransactionWrites = undefined;
                this.activeTransactionRemovals = undefined;
            }
        }
    }

    stats(): StoreStats {
        this.assertOpen();
        return {
            entities: countRows(this.driver, "entities"),
            events: countRows(this.driver, "events"),
            identity: this.identities.size,
            cache: this.cache.stats(),
            schemaVersion: schemaVersion(this.driver),
        };
    }

    close(): void {
        if (!this.openState) return;
        this.openState = false;
        for (const key of this.identities) {
            const slot = identities.get(key);
            if (slot === undefined) continue;
            slot.owners.delete(this);
            if (slot.owners.size === 0) {
                identities.delete(key);
                slot.closed = true;
                slot.target = undefined;
                slot.version = 0;
                slot.loaded = false;
            }
        }
        this.identities.clear();
        this.detachedKeys.clear();
        this.removedKeys.clear();
        this.repositories.clear();
        this.cache.clear();
        const pooled = poolsByPath.get(this.identityPath);
        if (pooled !== undefined && pooled.owners.has(this)) {
            pooled.owners.delete(this);
            if (pooled.owners.size === 0) {
                poolsByPath.delete(this.identityPath);
                this.connection.release();
                this.pool.close();
            }
        }
    }

    private assertOpen(): void {
        if (!this.openState) throw new Error(CLOSED_MESSAGE);
    }

    private slotKey(kind: EntityKind, id: string): string {
        return `${this.identityPath}#${entityKey(kind, id)}`;
    }

    private descriptor<T>(kind: EntityKind): EntityDescriptor<T> {
        return descriptorFor(kind) as EntityDescriptor<T>;
    }

    private repository<T>(kind: EntityKind): Repository<T> {
        const existing = this.repositories.get(kind);
        if (existing !== undefined) return existing as unknown as Repository<T>;
        const descriptor = this.descriptor<T>(kind);
        const repository = createSqliteRepository<T>(descriptor, { driver: this.driver, cache: this.cache, now: this.now });
        this.repositories.set(kind, repository as unknown as Repository<unknown>);
        return repository;
    }

    private getOrCreateSlot(kind: EntityKind, id: string): EntitySlot {
        this.descriptor(kind);
        const key = this.slotKey(kind, id);
        const existing = identities.get(key);
        if (existing !== undefined && existing.state === "managed") {
            existing.owners.add(this);
            this.identities.add(key);
            return existing;
        }
        this.detachedKeys.delete(key);
        this.removedKeys.delete(key);
        const slot: EntitySlot = {
            key,
            kind,
            id,
            proxy: {},
            owners: new Set<Store>(),
            target: undefined,
            version: 0,
            loaded: false,
            missing: false,
            state: "managed",
            closed: false,
        };
        slot.proxy = new Proxy({}, this.handler(slot, []));
        slot.owners.add(this);
        identities.set(key, slot);
        this.identities.add(key);
        return slot;
    }

    private liveOwner(slot: EntitySlot): Store {
        if (slot.state === "removed") throw new Error(NOT_FOUND_MESSAGE);
        if (slot.closed) throw new Error(CLOSED_MESSAGE);
        for (const owner of slot.owners) {
            if (owner.openState) return owner;
        }
        slot.closed = true;
        throw new Error(CLOSED_MESSAGE);
    }

    private hydrate<T>(slot: EntitySlot, entity: T, descriptor: EntityDescriptor<T>): void {
        slot.target = cloneEntity(entity) as AnyEntity;
        slot.version = versionOf(descriptor, entity);
        slot.loaded = true;
        slot.missing = false;
        slot.state = "managed";
    }

    private loadSlot(slot: EntitySlot, owner: Store): void {
        const descriptor = owner.descriptor<AnyEntity>(slot.kind);
        const entity = owner.repository<AnyEntity>(slot.kind).get(slot.id);
        if (entity === undefined) {
            slot.loaded = true;
            slot.missing = true;
            slot.target = undefined;
            slot.version = 0;
            return;
        }
        owner.hydrate(slot, entity, descriptor);
    }

    private containerOf(slot: EntitySlot, path: PropertyPath): unknown {
        const owner = this.liveOwner(slot);
        if (slot.state === "managed" && !slot.loaded) owner.loadSlot(slot, owner);
        if (path.length === 0) return slot.target;
        return readAtPath(slot.target, path);
    }

    private toPlainSnapshot(slot: EntitySlot, path: PropertyPath): unknown {
        const owner = this.liveOwner(slot);
        if (slot.state === "managed" && !slot.loaded) owner.loadSlot(slot, owner);
        return plainCopy(path.length === 0 ? slot.target : readAtPath(slot.target, path));
    }

    /** Applies one mutation to a copy, bumps the version and writes through with CAS. */
    private commit<T>(slot: EntitySlot, mutate: (root: AnyEntity) => T): T {
        const owner = this.liveOwner(slot);
        if (slot.state === "managed" && !slot.loaded) owner.loadSlot(slot, owner);
        if (slot.target === undefined) throw new Error(NOT_FOUND_MESSAGE);
        const next = cloneEntity(slot.target);
        const result = mutate(next);
        if (slot.state === "detached") {
            // Detached entities keep a local snapshot; writes never reach SQLite.
            slot.target = next;
            return result;
        }
        const descriptor = owner.descriptor(slot.kind);
        const record = descriptor.encode(next);
        const version = slot.version + 1;
        const updatedAt = owner.now();
        const canonical = descriptor.decode({
            ...record,
            version,
            updatedAt,
        });
        const written = owner.repository<AnyEntity>(slot.kind).put(canonical as AnyEntity, { expectedVersion: slot.version });
        owner.hydrate(slot, written, descriptor);
        owner.noteWrite(slot.key);
        return result;
    }

    private writeProperty(slot: EntitySlot, path: PropertyPath, property: PropertyKey, value: unknown): boolean {
        if (typeof property === "symbol") throw new TypeError("symbol properties are not persisted");
        this.commit(slot, (root) => writeAtPath(root, path, property, plainCopy(value)));
        return true;
    }

    private removeProperty(slot: EntitySlot, path: PropertyPath, property: PropertyKey): boolean {
        if (typeof property === "symbol") return true;
        const owner = this.liveOwner(slot);
        if (slot.state === "managed" && !slot.loaded) owner.loadSlot(slot, owner);
        const container = path.length === 0 ? slot.target : readAtPath(slot.target, path);
        if (container === undefined || container === null) return true;
        if (!Reflect.has(container, property)) return true;
        this.commit(slot, (root) => deleteAtPath(root, path, property));
        return true;
    }

    private mutateArray(slot: EntitySlot, path: PropertyPath, method: string, args: readonly unknown[]): unknown {
        const plainArgs = args.map((argument) => plainCopy(argument));
        return this.commit(slot, (root) => {
            const array = readAtPath(root, path);
            if (!Array.isArray(array)) throw new TypeError("array mutator called on a non-array value");
            const operation = (Array.prototype as unknown as Record<string, (...values: unknown[]) => unknown>)[method];
            return operation.apply(array, plainArgs);
        });
    }

    private handler(slot: EntitySlot, path: PropertyPath, arrayTarget?: unknown[]): ProxyHandler<object> {
        const array = arrayTarget !== undefined;
        return {
            get: (target, property) => {
                if (property === PROXY_MARKER) return true;
                if (property === "toJSON") return () => this.toPlainSnapshot(slot, path);
                const container = this.containerOf(slot, path);
                if (arrayTarget !== undefined) syncArrayTarget(container, arrayTarget);
                if (array && Array.isArray(container) && typeof property === "string" && ARRAY_MUTATORS.has(property)) {
                    return (...args: unknown[]) => this.mutateArray(slot, path, property, args);
                }
                if (array && property === "length") return arrayTarget.length;
                if (container === null || container === undefined) return undefined;
                const value = (container as Record<PropertyKey, unknown>)[property];
                if (isProxyable(value)) return this.nestedProxy(slot, [...path, property], value);
                void target;
                return value;
            },
            set: (_target, property, value) => this.writeProperty(slot, path, property, value),
            deleteProperty: (_target, property) => this.removeProperty(slot, path, property),
            has: (_target, property) => {
                const container = this.containerOf(slot, path);
                return isProxyable(container) && property in container;
            },
            ownKeys: (target) => {
                const container = this.containerOf(slot, path);
                if (arrayTarget !== undefined) {
                    syncArrayTarget(container, arrayTarget);
                    return Reflect.ownKeys(target);
                }
                return isProxyable(container) ? Reflect.ownKeys(container) : [];
            },
            getOwnPropertyDescriptor: (target, property) => {
                if (arrayTarget !== undefined && property === "length") {
                    return Object.getOwnPropertyDescriptor(target, "length");
                }
                const container = this.containerOf(slot, path);
                if (arrayTarget !== undefined) syncArrayTarget(container, arrayTarget);
                if (!isProxyable(container)) return undefined;
                const descriptor = Object.getOwnPropertyDescriptor(container, property);
                if (descriptor === undefined) return undefined;
                return { ...descriptor, configurable: true };
            },
        };
    }

    private nestedProxy(slot: EntitySlot, path: PropertyPath, value: object): object {
        if (!Array.isArray(value)) return new Proxy({}, this.handler(slot, path));
        const target: unknown[] = [];
        syncArrayTarget(value, target);
        return new Proxy(target, this.handler(slot, path, target));
    }

    private noteWrite(key: string): void {
        this.activeTransactionWrites?.add(key);
    }

    private invalidateSlot(key: string): void {
        const slot = identities.get(key);
        if (slot === undefined) return;
        slot.loaded = false;
        slot.missing = false;
        slot.target = undefined;
        slot.version = 0;
    }

    private applyJpaIndexes(): void {
        const columns = new Set<string>();
        for (const row of this.driver.query<SqlRow & { readonly name?: unknown }>({ sql: "PRAGMA table_info(entities)" })) {
            if (typeof row.name === "string") columns.add(row.name);
        }
        const declared = new Set<string>();
        for (const metadata of Object.values(ENTITY_REGISTRY)) {
            for (const index of metadata.indexes) {
                this.applyIndex(index.name, index.columns, index.unique, columns, declared);
            }
            for (const constraint of metadata.uniqueConstraints) {
                this.applyIndex(constraint.name, constraint.columns, true, columns, declared);
            }
        }
    }

    private applyIndex(
        name: string,
        indexColumns: readonly string[],
        unique: boolean,
        available: ReadonlySet<string>,
        declared: Set<string>,
    ): void {
        if (declared.has(name)) return;
        if (name.length === 0 || indexColumns.length === 0 || !indexColumns.every((column) => available.has(column))) {
            this.skippedIndexNames.push(name);
            return;
        }
        declared.add(name);
        try {
            this.driver.exec(
                `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdentifier(name)} `
                + `ON entities (${indexColumns.map(quoteIdentifier).join(", ")})`,
            );
            this.appliedIndexNames.push(name);
        } catch {
            this.skippedIndexNames.push(name);
        }
    }
}
