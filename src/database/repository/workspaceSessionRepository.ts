/**
 * SQLite repository for workspace sessions, their authorized roots and their
 * private context.
 *
 * The descriptor lives in `workspace_sessions`; roots are normalized into
 * `session_roots` so an authorization query never parses JSON, and context
 * entries use the deterministic `sessionId + "\0" + namespace + "\0" + key`
 * entry id. Multi-row writes run in a transaction, so a reader never observes a
 * session with half of its roots or a half-replaced context.
 */
import type { DatabaseSync } from "node:sqlite";

import { canonical } from "../../semantic/canonical.ts";
import type { SessionContextEntry, SessionDescriptor, SessionId, SessionJson, SessionPermissions, SessionRoot, SessionStatus } from "../../session/types.ts";
import type { TableMeta } from "../entity/meta.ts";
import type { SessionContextRow, SessionRootRow, WorkspaceSessionRow } from "../entity/workspaceSession.ts";
import { SessionContextTable, SessionRootTable, WorkspaceSessionTable } from "../entity/workspaceSession.ts";
import { assertSqlIdentifier, TableSql } from "../sql/sql.ts";
import { transaction } from "../store/database.ts";
import { BaseRepository } from "./base.ts";

/**
 * Quote a column that is declared by the table metadata.
 *
 * Custom statements must never invent identifiers: the column is checked
 * against {@link TableMeta.columns} before it reaches the SQL string.
 *
 * @param meta - Table metadata.
 * @param column - Column name.
 * @returns Double-quoted column name.
 */
const quoted: (meta: TableMeta, column: string) => string = (meta: TableMeta, column: string): string => {
    if (!meta.columns.includes(column)) {
        throw new Error(`unknown column for ${meta.table}: ${column}`);
    }
    return `"${assertSqlIdentifier(column)}"`;
};

/**
 * Build a bound `column = ?` conjunction from declared columns.
 *
 * @param meta - Table metadata.
 * @param columns - Column names in bind order.
 * @returns SQL fragment with one placeholder per column.
 */
const conditions: (meta: TableMeta, columns: readonly string[]) => string = (meta: TableMeta, columns: readonly string[]): string =>
    columns.map((column: string): string => `${quoted(meta, column)} = ?`).join(" AND ");

/**
 * Validate the persisted lifecycle status against the closed set.
 *
 * @param value - Stored status text.
 * @returns The validated status.
 * @throws Error when the row holds a status the domain does not know.
 */
const parseStatus: (value: string) => SessionStatus = (value: string): SessionStatus => {
    if (value === "active" || value === "suspended" || value === "revoked" || value === "expired") {
        return value;
    }
    throw new Error(`invalid workspace session status: ${value}`);
};

/**
 * Deterministic context primary key.
 *
 * NUL is the separator, so a component that contains NUL would alias another
 * `(namespace, key)` pair on the primary key while differing on the unique
 * triple. Such a component is rejected instead of silently renaming a row.
 *
 * @param sessionId - Session handle.
 * @param namespace - Context namespace.
 * @param key - Namespace-local key.
 * @returns `sessionId\0namespace\0key`.
 * @throws Error when a component contains NUL.
 */
const entryId: (sessionId: string, namespace: string, key: string) => string = (sessionId: string, namespace: string, key: string): string => {
    if (sessionId.includes("\u0000") || namespace.includes("\u0000") || key.includes("\u0000")) {
        throw new Error("session context components must not contain U+0000");
    }
    return `${sessionId}\u0000${namespace}\u0000${key}`;
};

/**
 * Reject a context byte count that cannot be a canonical size.
 *
 * @param value - Caller-supplied canonical UTF-8 size.
 * @throws RangeError when the value is not a non-negative integer.
 */
const assertBytes: (value: number) => void = (value: number): void => {
    if (!Number.isInteger(value) || value < 0) {
        throw new RangeError("context bytes must be a non-negative integer");
    }
};

/**
 * Parse the persisted permission object.
 *
 * The row is written by this repository, so the shape is trusted on read; the
 * cast keeps the column boundary in one place.
 *
 * @param json - Canonical JSON text.
 * @returns Permission set.
 */
const parsePermissions: (json: string) => SessionPermissions = (json: string): SessionPermissions => JSON.parse(json) as SessionPermissions;

/**
 * Parse the persisted metadata object.
 *
 * @param json - Canonical JSON text.
 * @returns Host metadata.
 */
const parseMetadata: (json: string) => Readonly<Record<string, string>> = (json: string): Readonly<Record<string, string>> =>
    JSON.parse(json) as Readonly<Record<string, string>>;

/**
 * Parse the persisted exclusion list.
 *
 * @param json - Canonical JSON text.
 * @returns Excluded sub-paths.
 */
const parseExcludes: (json: string) => readonly string[] = (json: string): readonly string[] => JSON.parse(json) as readonly string[];

/**
 * Repository for `workspace_sessions`, `session_roots` and `session_context`.
 */
export class WorkspaceSessionRepository extends BaseRepository<WorkspaceSessionRow, string> {
    private readonly rootsSql: TableSql<SessionRootRow>;
    private readonly contextSql: TableSql<SessionContextRow>;

    /**
     * Create the repository.
     *
     * @param db - Open SQLite connection.
     */
    constructor(db: DatabaseSync) {
        super(db, WorkspaceSessionTable);
        this.rootsSql = new TableSql<SessionRootRow>(db, SessionRootTable);
        this.contextSql = new TableSql<SessionContextRow>(db, SessionContextTable);
    }

    /**
     * Insert or replace one session descriptor and its roots in one transaction.
     *
     * `permissions` and `metadata` are persisted as canonical JSON; `status` is
     * validated before the write. Roots are replaced (delete, then insert) so a
     * removed grant cannot survive a resave.
     *
     * @param descriptor - Public session record.
     * @param tokenHash - `sha256:<hex>` bearer digest; never the token itself.
     * @throws Error when the status is outside the closed lifecycle.
     */
    save(descriptor: SessionDescriptor, tokenHash: string): void {
        const status: SessionStatus = parseStatus(descriptor.status);
        const values: Readonly<Record<string, unknown>> = {
            session_id: descriptor.id,
            agent_id: descriptor.agentId,
            label: descriptor.label,
            status,
            token_hash: tokenHash,
            permissions_json: canonical(descriptor.permissions),
            created_at: descriptor.createdAt,
            expires_at: descriptor.expiresAt,
            idle_expires_at: descriptor.idleExpiresAt,
            revision: descriptor.revision,
            parent_id: descriptor.parentId ?? null,
            metadata_json: canonical(descriptor.metadata),
        };
        transaction(this.db, (): void => {
            this.upsert(values);
            this.rootsSql.deleteWhere(conditions(SessionRootTable, ["session_id"]), descriptor.id);
            for (let index: number = 0; index < descriptor.roots.length; index += 1) {
                const root: SessionRoot = descriptor.roots[index];
                this.rootsSql.insert({
                    root_id: root.id,
                    session_id: descriptor.id,
                    path: root.path,
                    writable: root.writable ? 1 : 0,
                    excludes_json: canonical(root.exclude),
                });
            }
        });
    }

    /**
     * Load one descriptor with its roots.
     *
     * @param sessionId - Session handle.
     * @returns Descriptor, or `undefined` when the session is unknown.
     */
    load(sessionId: SessionId): SessionDescriptor | undefined {
        const row: WorkspaceSessionRow | undefined = this.findById(sessionId);
        return row === (void 0) ? undefined : this.toDescriptor(row);
    }

    /**
     * Read the persisted bearer digest for authentication after a restart.
     *
     * @param sessionId - Session handle.
     * @returns Token hash, or `undefined` when the session is unknown.
     */
    loadSecret(sessionId: SessionId): string | undefined {
        const row: WorkspaceSessionRow | undefined = this.findById(sessionId);
        return row === (void 0) ? undefined : row.token_hash;
    }

    /**
     * Delete one session with its roots and context in one transaction.
     *
     * The boolean overload is the domain contract used by {@link SessionStore};
     * the numeric overload mirrors `BaseRepository.delete` so the class remains
     * substitutable for the generated CRUD base.
     *
     * @param sessionId - Session handle.
     * @returns `true` when a session row was removed.
     */
    delete(sessionId: SessionId): boolean;
    /**
     * Base-repository compatible delete overload.
     *
     * @param id - Session handle.
     * @returns Number of removed session rows.
     */
    delete(id: string): number;
    delete(sessionId: string): boolean | number {
        return transaction(this.db, (): boolean => {
            this.deleteContextSession(sessionId);
            this.rootsSql.deleteWhere(conditions(SessionRootTable, ["session_id"]), sessionId);
            return this.queries.delete(sessionId) > 0;
        });
    }

    /**
     * List sessions, optionally narrowed to one agent.
     *
     * @param agentId - Optional host-assigned agent identity.
     * @returns Descriptors ordered by creation time and id.
     */
    list(agentId?: string): SessionDescriptor[] {
        const orderBy: string = `ORDER BY ${quoted(WorkspaceSessionTable, "created_at")} ASC, ${quoted(WorkspaceSessionTable, "session_id")} ASC`;
        const rows: WorkspaceSessionRow[] =
            agentId === (void 0)
                ? this.queries.select({ orderBy })
                : this.queries.select({ where: conditions(WorkspaceSessionTable, ["agent_id"]), params: [agentId], orderBy });
        const descriptors: SessionDescriptor[] = [];
        for (let index: number = 0; index < rows.length; index += 1) {
            descriptors.push(this.toDescriptor(rows[index]));
        }
        return descriptors;
    }

    /**
     * Read the authorized roots of one session.
     *
     * @param sessionId - Session handle.
     * @returns Roots ordered by host path.
     */
    findRoots(sessionId: SessionId): SessionRoot[] {
        const rows: SessionRootRow[] = this.rootsSql.select({
            where: conditions(SessionRootTable, ["session_id"]),
            params: [sessionId],
            orderBy: `ORDER BY ${quoted(SessionRootTable, "path")} ASC`,
        });
        const roots: SessionRoot[] = [];
        for (let index: number = 0; index < rows.length; index += 1) {
            const row: SessionRootRow = rows[index];
            roots.push({
                id: row.root_id,
                path: row.path,
                writable: row.writable === 1,
                exclude: parseExcludes(row.excludes_json),
            });
        }
        return roots;
    }

    /**
     * Read every context entry of one session.
     *
     * @param sessionId - Session handle.
     * @returns Entries ordered by namespace and key.
     */
    loadContext(sessionId: SessionId): SessionContextEntry[] {
        const rows: SessionContextRow[] = this.contextSql.select({
            where: conditions(SessionContextTable, ["session_id"]),
            params: [sessionId],
            orderBy: `ORDER BY ${quoted(SessionContextTable, "namespace")} ASC, ${quoted(SessionContextTable, "context_key")} ASC`,
        });
        const entries: SessionContextEntry[] = [];
        for (let index: number = 0; index < rows.length; index += 1) {
            const row: SessionContextRow = rows[index];
            entries.push({
                namespace: row.namespace,
                key: row.context_key,
                value: JSON.parse(row.value_json) as SessionJson,
                bytes: row.bytes,
                updatedAt: row.updated_at,
            });
        }
        return entries;
    }

    /**
     * Insert or replace one context entry.
     *
     * The value is stored as canonical JSON; `bytes` is the caller's canonical
     * size and is persisted as given so quota accounting stays reproducible.
     *
     * @param sessionId - Session handle.
     * @param entry - Context entry.
     * @throws Error when the session id, namespace or key contains NUL.
     * @throws RangeError when `bytes` is not a non-negative integer.
     * @throws TypeError when the value cannot round-trip through canonical JSON.
     */
    putContext(sessionId: SessionId, entry: SessionContextEntry): void {
        assertBytes(entry.bytes);
        this.contextSql.upsert({
            entry_id: entryId(sessionId, entry.namespace, entry.key),
            session_id: sessionId,
            namespace: entry.namespace,
            context_key: entry.key,
            value_json: canonical(entry.value),
            bytes: entry.bytes,
            updated_at: entry.updatedAt,
        });
    }

    /**
     * Delete one context entry.
     *
     * @param sessionId - Session handle.
     * @param namespace - Context namespace.
     * @param key - Namespace-local key.
     * @returns `true` when an entry was removed.
     */
    deleteContext(sessionId: SessionId, namespace: string, key: string): boolean {
        return this.contextSql.deleteWhere(conditions(SessionContextTable, ["session_id", "namespace", "context_key"]), sessionId, namespace, key) > 0;
    }

    /**
     * Delete every context entry of one session.
     *
     * @param sessionId - Session handle.
     */
    deleteContextSession(sessionId: SessionId): void {
        this.contextSql.deleteWhere(conditions(SessionContextTable, ["session_id"]), sessionId);
    }

    /**
     * Atomically replace the whole context of one session.
     *
     * @param sessionId - Session handle.
     * @param entries - Complete new entry set.
     */
    replaceContext(sessionId: SessionId, entries: readonly SessionContextEntry[]): void {
        transaction(this.db, (): void => {
            this.deleteContextSession(sessionId);
            for (let index: number = 0; index < entries.length; index += 1) {
                this.putContext(sessionId, entries[index]);
            }
        });
    }

    /**
     * Convert one row plus its roots into the public descriptor.
     *
     * @param row - Session row.
     * @returns Descriptor; `parentId` is present only when the row has a parent.
     */
    private toDescriptor(row: WorkspaceSessionRow): SessionDescriptor {
        const base: SessionDescriptor = {
            id: row.session_id,
            agentId: row.agent_id,
            label: row.label,
            status: parseStatus(row.status),
            roots: this.findRoots(row.session_id),
            permissions: parsePermissions(row.permissions_json),
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            idleExpiresAt: row.idle_expires_at,
            revision: row.revision,
            metadata: parseMetadata(row.metadata_json),
        };
        return row.parent_id === null ? base : { ...base, parentId: row.parent_id };
    }
}
