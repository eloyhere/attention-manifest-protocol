/**
 * SQLite repository and recorder for hook runs.
 *
 * Every `Hook.run` produces one `HookRunEntry`; `SqliteHookRecorder` writes it
 * to `hook_runs` through {@link HookRepository}. The recorder is deliberately
 * best-effort: `record` catches repository failures and returns, because an
 * audit store that is temporarily unavailable must not turn a successful read
 * or write into a failed hook result.
 *
 * `run_id` is `run.` plus 16 hex characters rather than an autoincrement, so a
 * row can be identified before insert and two stores cannot confuse each
 * other's ordering. `list` reads newest first by `started_at` and breaks ties on
 * `run_id`, which keeps the order deterministic for runs in the same
 * millisecond.
 */
import { randomBytes } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import type { HookRecorder, HookRunEntry } from "../../hook/types.ts";
import type { HookRunRow } from "../entity/hook.ts";
import { HookRunTable } from "../entity/hook.ts";
import type { TableMeta } from "../entity/meta.ts";
import type { SqlParameter } from "../sql/sql.ts";
import { assertSqlIdentifier } from "../sql/sql.ts";
import { BaseRepository } from "./base.ts";

/**
 * Quote a column that is declared by the table metadata.
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
 * Generate a run id: `run.` plus 16 random hex characters.
 *
 * @returns Opaque run id.
 */
const newRunId: () => string = (): string => `run.${randomBytes(8).toString("hex")}`;

/**
 * Repository for `hook_runs`.
 */
export class HookRepository extends BaseRepository<HookRunRow, string> {
    /**
     * Create the repository.
     *
     * @param db - Open SQLite connection.
     */
    constructor(db: DatabaseSync) {
        super(db, HookRunTable);
    }

    /**
     * Append one hook run. The row is immutable afterwards; a retry is a new
     * run with a new id, not an update of the old row.
     *
     * @param entry - Run entry produced by `Hook.run`.
     */
    append(entry: HookRunEntry & { sessionId: string; }): void {
        this.insert({
            run_id: newRunId(),
            session_id: entry.sessionId,
            hook: entry.hook,
            path: entry.path ?? null,
            status: entry.status,
            error: entry.error ?? null,
            revision: entry.revision,
            input_digest: entry.inputDigest,
            output_digest: entry.outputDigest,
            started_at: entry.startedAt,
            duration_ms: entry.durationMs,
            meta_json: "{}",
        });
    }

    /**
     * Read one session's runs, newest first.
     *
     * @param sessionId - Session handle.
     * @param limit - Maximum rows; zero is allowed and returns nothing.
     * @returns Run rows.
     */
    list(sessionId: string, limit: number): HookRunRow[] {
        if (!Number.isInteger(limit) || limit < 0) {
            throw new RangeError("limit must be a non-negative integer");
        }
        return this.queries.select({
            where: conditions(HookRunTable, ["session_id"]),
            params: [sessionId],
            orderBy: `ORDER BY ${quoted(HookRunTable, "started_at")} DESC, ${quoted(HookRunTable, "run_id")} DESC`,
            limit,
        });
    }

    /**
     * Count one session's runs. With no argument it counts the whole table.
     * The trailing `params` keeps the inherited `count(clause, ...params)`
     * behaviour available when a caller passes bound values; a lone string is
     * interpreted as a session id because that is this repository's contract.
     *
     * @param sessionId - Session handle, empty for every row, or a WHERE clause
     * when `params` is non-empty.
     * @param params - Bound values for the inherited clause form.
     * @returns Number of matching runs.
     */
    count(sessionId: string = "", ...params: SqlParameter[]): number {
        if (params.length > 0) {
            return super.count(sessionId, ...params);
        }
        if (sessionId.length === 0) {
            return super.count();
        }
        return super.count(`${quoted(HookRunTable, "session_id")} = ?`, sessionId);
    }
}

/**
 * Hook recorder backed by a SQLite repository.
 *
 * A recorder instance owns one repository over the injected connection; it does
 * not open, migrate or close the store. `record` never throws, by contract.
 */
export class SqliteHookRecorder implements HookRecorder {
    private readonly repository: HookRepository;

    /**
     * Create a recorder.
     *
     * @param db - Open SQLite connection with the `hook_runs` table.
     */
    constructor(db: DatabaseSync) {
        this.repository = new HookRepository(db);
    }

    /**
     * Append one entry. A repository failure is swallowed so the hook result is
     * unaffected.
     *
     * @param entry - Run entry.
     */
    record(entry: HookRunEntry): void {
        try {
            this.repository.append(entry);
        } catch {
            return;
        }
    }
}
