import type { DatabaseSync } from "node:sqlite";

import { assertJsonValue } from "../../semantic/jsonValue.ts";
import { CatalogEntryTable, CatalogRelationTable, catalogKey } from "../entity/catalog.ts";
import type { CatalogEntryEntity, CatalogRelationEntity, CatalogSyncState, CatalogSyncStateEntity } from "../entity/catalog.ts";
import { TableSql } from "../sql/sql.ts";
import type { MutationResult, SqlParameter } from "../sql/sql.ts";
import { withCatalogWrite } from "../store/catalogGuard.ts";
import { BaseRepository } from "./base.ts";

const nonempty = (value: unknown, label: string): void => {
    if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a nonempty string`);
};

/** Copy plain rows before granting SQL authority; accessors cannot run inside the permit. */
const snapshotRows = <T extends object>(rows: readonly T[], columns: readonly string[], label: string): T[] => {
    if (!Array.isArray(rows)) throw new TypeError(`${label} must be an array`);
    assertJsonValue(rows, label);
    return rows.map((row) => {
        if (row === null || typeof row !== "object" || Array.isArray(row) ||
            Object.keys(row).length !== columns.length || columns.some((column) => !Object.hasOwn(row, column))) {
            throw new TypeError(`${label} must contain complete entities with known metadata fields`);
        }
        return { ...row };
    });
};

const validateEntry = (namespace: string, entry: CatalogEntryEntity): void => {
    if (entry.namespace !== namespace) throw new TypeError("catalog entry namespace does not match snapshot");
    for (const field of ["id", "kind", "name", "updated_at"] as const) nonempty(entry[field], field);
    if (entry.key !== catalogKey(namespace, entry.kind, entry.id)) throw new TypeError("catalog entry key does not match identity");
    if (typeof entry.summary !== "string") throw new TypeError("summary must be a string");
    for (const field of ["project_id", "revision", "source_uri"] as const) {
        if (entry[field] !== null && typeof entry[field] !== "string") throw new TypeError(`${field} must be a string or null`);
    }
    for (const field of ["tags_json", "search_terms_json", "payload_json"] as const) {
        if (typeof entry[field] !== "string") throw new TypeError(`${field} must be JSON text`);
        const value: unknown = JSON.parse(entry[field]);
        assertJsonValue(value, field);
        if (field === "payload_json") {
            if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("payload JSON must decode to an object");
        } else if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
            throw new TypeError(`${field} must decode to an array of strings`);
        }
    }
};

/** Durable SQLite fencing identity. This does not fence Elasticsearch writes. */
export interface CatalogSyncLease {
    namespace: string;
    ownerToken: string;
    revision: number;
}

/** Offline recovery preconditions are host assertions, not an abort receipt. */
export interface CatalogSyncRecovery {
    lease: CatalogSyncLease;
    writerStopped: true;
    remoteWritesQuiesced: true;
}

/** Owns the synchronous transaction boundary for a complete catalog snapshot. */
export class CatalogRepository extends BaseRepository<CatalogEntryEntity, string> {
    private readonly relationSql: TableSql<CatalogRelationEntity, string>;

    constructor(db: DatabaseSync) {
        super(db, CatalogEntryTable);
        this.relationSql = new TableSql(db, CatalogRelationTable);
    }

    listNamespace(namespace: string): CatalogEntryEntity[] {
        return this.queries.select({
            where: "namespace = ?",
            params: [namespace],
            orderBy: "ORDER BY kind ASC, id ASC",
        });
    }

    relationsFor(namespace: string, sourceKey: string): CatalogRelationEntity[] {
        return this.relationSql.select({
            where: "namespace = ? AND source_key = ?",
            params: [namespace, sourceKey],
            orderBy: "ORDER BY rowid ASC",
        });
    }

    relationsInNamespace(namespace: string): CatalogRelationEntity[] {
        return this.relationSql.select({
            where: "namespace = ?",
            params: [namespace],
            orderBy: "ORDER BY rowid ASC",
        });
    }

    state(namespace: string): CatalogSyncState {
        const row = this.queries.queryOne<CatalogSyncStateEntity>(
            "SELECT namespace, generation, synced_generation FROM catalog_sync_state WHERE namespace = ?",
            namespace,
        );
        return { generation: row?.generation ?? 0, syncedGeneration: row?.synced_generation ?? 0 };
    }

    /** Expose transaction state without requiring services to import SQLite. */
    get inTransaction(): boolean {
        return this.db.isTransaction;
    }

    /** A stale operation must not dirty a replacement owner's completed index. */
    invalidateSynced(namespace: string, lease?: CatalogSyncLease): boolean {
        if (lease !== undefined && lease.namespace !== namespace) return false;
        return withCatalogWrite(this.db, () => Number(this.db.prepare(
            "UPDATE catalog_sync_state SET synced_generation = 0 WHERE namespace = ?" +
            (lease === undefined ? "" : " AND EXISTS (SELECT 1 FROM catalog_sync_ownership WHERE namespace = ? AND owner_token = ? AND revision = ?)"),
        ).run(namespace, ...(lease === undefined ? [] : [namespace, lease.ownerToken, lease.revision])).changes) === 1);
    }

    /** Acquire and dirty atomically: even a crash before the first request fails closed. */
    acquireSync(namespace: string, ownerToken: string): CatalogSyncLease | undefined {
        if (this.inTransaction) throw new Error("commit the catalog transaction before synchronization");
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const row = withCatalogWrite(this.db, () => this.db.prepare(
                "INSERT INTO catalog_sync_ownership (namespace, owner_token, revision) " +
                "SELECT namespace, ?, 1 FROM catalog_sync_state WHERE namespace = ? AND generation > 0 " +
                "ON CONFLICT(namespace) DO UPDATE SET owner_token = excluded.owner_token, revision = catalog_sync_ownership.revision + 1 " +
                "WHERE catalog_sync_ownership.owner_token IS NULL RETURNING revision",
            ).get(ownerToken, namespace) as { revision: number } | undefined);
            if (row !== undefined) this.invalidateSynced(namespace);
            this.db.exec("COMMIT");
            return row === undefined ? undefined : { namespace, ownerToken, revision: row.revision };
        } catch (error) {
            try { this.db.exec("ROLLBACK"); } catch { /* Preserve the acquisition failure. */ }
            throw error;
        }
    }

    /** Inspect a crashed/uncertain operation for explicit, compare-and-swap recovery. */
    syncLease(namespace: string): CatalogSyncLease | undefined {
        const row = this.db.prepare(
            "SELECT owner_token, revision FROM catalog_sync_ownership WHERE namespace = ? AND owner_token IS NOT NULL",
        ).get(namespace) as { owner_token: string; revision: number } | undefined;
        return row === undefined ? undefined : { namespace, ownerToken: row.owner_token, revision: row.revision };
    }

    ownsSync(namespace: string, lease: CatalogSyncLease): boolean {
        return lease.namespace === namespace && this.db.prepare(
            "SELECT 1 FROM catalog_sync_ownership WHERE namespace = ? AND owner_token = ? AND revision = ?",
        ).get(namespace, lease.ownerToken, lease.revision) !== undefined;
    }

    /** Read ownership and generation in one SQLite snapshot. Revision survives release. */
    syncStatus(namespace: string): CatalogSyncState & { owned: boolean; revision: number } {
        const row = this.queries.queryOne<CatalogSyncStateEntity & { owned: number; revision: number }>(
            "SELECT s.namespace, s.generation, s.synced_generation, o.owner_token IS NOT NULL AS owned, " +
            "COALESCE(o.revision, 0) AS revision FROM catalog_sync_state s " +
            "LEFT JOIN catalog_sync_ownership o ON o.namespace = s.namespace WHERE s.namespace = ?",
            namespace,
        );
        return { generation: row?.generation ?? 0, syncedGeneration: row?.synced_generation ?? 0,
            owned: row?.owned === 1, revision: row?.revision ?? 0 };
    }

    /** Only release after all writes are known finished; timeout/abort is insufficient. */
    releaseSync(namespace: string, lease: CatalogSyncLease): boolean {
        if (this.inTransaction) throw new Error("commit the catalog transaction before releasing synchronization");
        if (lease.namespace !== namespace) return false;
        return withCatalogWrite(this.db, () => Number(this.db.prepare(
            "UPDATE catalog_sync_ownership SET owner_token = NULL WHERE namespace = ? AND owner_token = ? AND revision = ?",
        ).run(namespace, lease.ownerToken, lease.revision).changes) === 1);
    }

    /** Admin only: stop the original writer AND drain/cancel its server operations.
     * The host asserts those facts; SQLite cannot verify Elasticsearch quiescence.
     * Compare-and-swap prevents a stale recovery request from clearing another lease. */
    recoverSync(namespace: string, recovery: CatalogSyncRecovery): boolean {
        if (recovery?.writerStopped !== true || recovery.remoteWritesQuiesced !== true || recovery.lease?.namespace !== namespace)
            throw new TypeError("recovery requires the expected lease, stopped writer and quiesced remote writes");
        if (this.inTransaction) throw new Error("commit the catalog transaction before synchronization recovery");
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const recovered = this.invalidateSynced(namespace, recovery.lease) && withCatalogWrite(this.db, () => Number(this.db.prepare(
                "UPDATE catalog_sync_ownership SET owner_token = NULL WHERE namespace = ? AND owner_token = ? AND revision = ?",
            ).run(namespace, recovery.lease.ownerToken, recovery.lease.revision).changes) === 1);
            this.db.exec("COMMIT");
            return recovered;
        } catch (error) {
            try { this.db.exec("ROLLBACK"); } catch { /* Preserve the recovery failure. */ }
            throw error;
        }
    }

    /** An owned rebuild requires both fencing fields; a stale operation cannot acknowledge it. */
    markSynced(namespace: string, generation: number, lease?: CatalogSyncLease): boolean {
        if (lease !== undefined && lease.namespace !== namespace) return false;
        const result = withCatalogWrite(this.db, () => this.db.prepare(
            "UPDATE catalog_sync_state SET synced_generation = ? WHERE namespace = ? AND generation = ? AND " +
            (lease === undefined
                ? "NOT EXISTS (SELECT 1 FROM catalog_sync_ownership WHERE namespace = ? AND owner_token IS NOT NULL)"
                : "EXISTS (SELECT 1 FROM catalog_sync_ownership WHERE namespace = ? AND owner_token = ? AND revision = ?)"),
        ).run(generation, namespace, generation, namespace, ...(lease === undefined ? [] : [lease.ownerToken, lease.revision])));
        return Number(result.changes) === 1;
    }

    /** SAVEPOINT also works inside a caller's transaction; never crosses await. */
    replaceSnapshot(namespace: string, entries: readonly CatalogEntryEntity[], relations: readonly CatalogRelationEntity[]): number {
        nonempty(namespace, "namespace");
        const preparedEntries = snapshotRows(entries, CatalogEntryTable.columns, "catalog entries");
        const preparedRelations = snapshotRows(relations, CatalogRelationTable.columns, "catalog relations");
        const sources = new Set<string>();
        for (const entry of preparedEntries) {
            validateEntry(namespace, entry);
            if (sources.has(entry.key)) throw new TypeError(`duplicate catalog record: ${entry.key}`);
            sources.add(entry.key);
        }
        const relationKeys = new Set<string>();
        for (const relation of preparedRelations) {
            if (relation.namespace !== namespace || !sources.has(relation.source_key)) {
                throw new TypeError("catalog relation source does not belong to snapshot");
            }
            nonempty(relation.relation, "relation");
            nonempty(relation.target_id, "target_id");
            if (relation.key !== JSON.stringify([relation.source_key, relation.relation, relation.target_id])) {
                throw new TypeError("catalog relation key does not match identity");
            }
            if (relationKeys.has(relation.key)) throw new TypeError(`duplicate catalog relation: ${relation.key}`);
            relationKeys.add(relation.key);
        }
        return withCatalogWrite(this.db, () => {
            this.db.exec("SAVEPOINT catalog_replace_snapshot");
            try {
                const previous = this.state(namespace);
                const generation = previous.generation + 1;
                if (!Number.isSafeInteger(generation)) {
                    throw new RangeError("catalog generation exceeds the safe integer range");
                }
                super.deleteWhere("namespace = ?", namespace);
                for (const entry of preparedEntries) {
                    super.insert({ ...entry });
                }
                for (const relation of preparedRelations) {
                    this.relationSql.insert({ ...relation });
                }
                this.db.prepare(
                    "INSERT INTO catalog_sync_state (namespace, generation, synced_generation) VALUES (?, ?, 0) " +
                    "ON CONFLICT(namespace) DO UPDATE SET generation = excluded.generation",
                ).run(namespace, generation);
                this.db.exec("RELEASE SAVEPOINT catalog_replace_snapshot");
                return generation;
            } catch (error) {
                try {
                    this.db.exec("ROLLBACK TO SAVEPOINT catalog_replace_snapshot");
                    this.db.exec("RELEASE SAVEPOINT catalog_replace_snapshot");
                } catch {
                    // Preserve the original SQL failure if the connection also failed.
                }
                throw error;
            }
        });
    }

    override insert(_values: Readonly<Record<string, unknown>>): MutationResult {
        throw new Error("CatalogRepository writes require replaceSnapshot");
    }

    insertOrIgnore(_values: Readonly<Record<string, unknown>>): MutationResult {
        throw new Error("CatalogRepository writes require replaceSnapshot");
    }

    override update(_id: string, _values: Readonly<Record<string, unknown>>): number {
        throw new Error("CatalogRepository writes require replaceSnapshot");
    }

    override updateWhere(_clause: string, _values: Readonly<Record<string, unknown>>, ..._params: SqlParameter[]): number {
        throw new Error("CatalogRepository writes require replaceSnapshot");
    }

    override delete(_id: string): number {
        throw new Error("CatalogRepository writes require replaceSnapshot");
    }

    override deleteWhere(_clause: string, ..._params: SqlParameter[]): number {
        throw new Error("CatalogRepository writes require replaceSnapshot");
    }

    override upsert(_values: Readonly<Record<string, unknown>>, _conflictColumns?: readonly string[]): MutationResult {
        throw new Error("CatalogRepository writes require replaceSnapshot");
    }
}
