import type { SchemaMigration, SqlDriver, SqlRow } from "./types.ts";

const CREATE_MIGRATIONS_TABLE = "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)";

/**
 * The baseline schema of the entity/event store. Every statement is
 * idempotent so a partially prepared database is safe to migrate again.
 */
export const CORE_MIGRATIONS: readonly SchemaMigration[] = Object.freeze([
    Object.freeze({
        version: 1,
        name: "core",
        statements: Object.freeze([
            "CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, tenant_id TEXT, session_id TEXT, version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (kind, id));",
            "CREATE INDEX IF NOT EXISTS idx_entities_tenant ON entities(tenant_id, kind);",
            "CREATE INDEX IF NOT EXISTS idx_entities_session ON entities(session_id, kind);",
            "CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT, recorded_at TEXT NOT NULL, payload TEXT NOT NULL);",
            "CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, sequence);",
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
            "CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        ]),
    }),
]);

type VersionRow = SqlRow & { readonly version: number | bigint | null };

/** Current recorded schema version; `0` when the database has no migration table yet. */
export function schemaVersion(driver: SqlDriver): number {
    const tables = driver.query({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        parameters: ["schema_migrations"],
    });
    if (tables.length === 0) return 0;
    const rows = driver.query<VersionRow>({ sql: "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations" });
    const value = rows[0]?.version ?? 0;
    return typeof value === "bigint" ? Number(value) : value;
}

function validateMigrations(migrations: readonly SchemaMigration[]): readonly SchemaMigration[] {
    const versions = new Set<number>();
    for (const migration of migrations) {
        if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
            throw new RangeError(`migration version must be a positive safe integer: ${String(migration.version)}`);
        }
        if (versions.has(migration.version)) throw new TypeError(`duplicate migration version: ${migration.version}`);
        versions.add(migration.version);
    }
    return [...migrations].sort((left, right) => left.version - right.version);
}

/**
 * Applies every migration newer than the recorded schema version, each inside
 * its own writer transaction. Re-running with the same input is a no-op and
 * returns the current version.
 */
export function migrate(driver: SqlDriver, migrations: readonly SchemaMigration[] = CORE_MIGRATIONS): number {
    const ordered = validateMigrations(migrations);
    const current = schemaVersion(driver);
    const pending = ordered.filter((migration) => migration.version > current);
    if (pending.length === 0) return current;
    driver.exec(CREATE_MIGRATIONS_TABLE);
    for (const migration of pending) {
        driver.transaction((tx) => {
            for (const statement of migration.statements) tx.exec(statement);
            tx.run({
                sql: "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                parameters: [migration.version, migration.name, new Date().toISOString()],
            });
        });
    }
    return schemaVersion(driver);
}
