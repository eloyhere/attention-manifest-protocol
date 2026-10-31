/**
 * SQLite row for one hook run.
 *
 * The table is append-only from the hook layer's point of view: a run writes
 * one row with its status, revision and request/output digests. `path` and
 * `error` are nullable because not every hook is path-scoped and a successful
 * run has no error. `meta_json` is reserved for a future caller-supplied
 * context; the current recorder writes `{}` so the column is always valid JSON.
 */
import type { TableMeta } from "./meta.ts";

/**
 * One `hook_runs` row. Column names mirror the DDL so a repository never has to
 * guess a mapping.
 */
export interface HookRunRow {
    run_id: string;
    session_id: string;
    hook: string;
    path: string | null;
    status: string;
    error: string | null;
    revision: string;
    input_digest: string;
    output_digest: string;
    started_at: string;
    duration_ms: number;
    meta_json: string | null;
}

export const HookRunTable: TableMeta = {
    table: "hook_runs",
    primaryKey: "run_id",
    columns: [
        "run_id",
        "session_id",
        "hook",
        "path",
        "status",
        "error",
        "revision",
        "input_digest",
        "output_digest",
        "started_at",
        "duration_ms",
        "meta_json",
    ],
};
