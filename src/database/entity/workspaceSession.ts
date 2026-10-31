/**
 * SQLite rows for the workspace session domain.
 *
 * The row shapes mirror `schema.ts`; domain types live in `src/session`. The
 * repository converts between them and never lets a raw row leave this layer.
 */
import type { TableMeta } from "./meta.ts";

/**
 * One workspace session. `token_hash` is `sha256:<hex>`; the bearer secret is
 * never persisted in any form.
 */
export interface WorkspaceSessionRow {
    session_id: string;
    agent_id: string;
    label: string;
    status: string;
    token_hash: string;
    permissions_json: string;
    created_at: string;
    expires_at: string;
    idle_expires_at: string;
    revision: number;
    parent_id: string | null;
    metadata_json: string;
}

export const WorkspaceSessionTable: TableMeta = {
    table: "workspace_sessions",
    primaryKey: "session_id",
    columns: [
        "session_id",
        "agent_id",
        "label",
        "status",
        "token_hash",
        "permissions_json",
        "created_at",
        "expires_at",
        "idle_expires_at",
        "revision",
        "parent_id",
        "metadata_json",
    ],
};

/**
 * One authorized root. `root_id` is globally unique so a repository can load
 * it without the session key, while the unique `(session_id, path)` constraint
 * keeps a session from naming the same directory twice.
 */
export interface SessionRootRow {
    root_id: string;
    session_id: string;
    path: string;
    writable: number;
    excludes_json: string;
}

export const SessionRootTable: TableMeta = {
    table: "session_roots",
    primaryKey: "root_id",
    columns: ["root_id", "session_id", "path", "writable", "excludes_json"],
};

/**
 * One namespaced context entry. `entry_id` is deterministic, which makes the
 * generated upsert path a primary-key operation.
 */
export interface SessionContextRow {
    entry_id: string;
    session_id: string;
    namespace: string;
    context_key: string;
    value_json: string;
    bytes: number;
    updated_at: string;
}

export const SessionContextTable: TableMeta = {
    table: "session_context",
    primaryKey: "entry_id",
    columns: ["entry_id", "session_id", "namespace", "context_key", "value_json", "bytes", "updated_at"],
};
