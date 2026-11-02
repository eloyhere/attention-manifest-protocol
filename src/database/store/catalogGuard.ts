import type { DatabaseSync } from "node:sqlite";

/** Connection-local authority stays in this lexical scope, never on the database. */
const writeDepth = new WeakMap<DatabaseSync, number>();
const registered = new WeakSet<DatabaseSync>();

/** Register before schema installation; a separately opened SQLite handle fails closed. */
export const registerCatalogWriteGuard = (db: DatabaseSync): void => {
    if (registered.has(db)) return;
    db.function("amp_catalog_write_allowed", () => (writeDepth.get(db) ?? 0) > 0 ? 1 : 0);
    registered.add(db);
};

/** Internal persistence capability. Authority ends before the first asynchronous continuation. */
export const withCatalogWrite = <T>(db: DatabaseSync, callback: () => T): T => {
    if (!registered.has(db)) throw new Error("catalog write guard is not registered");
    if (typeof callback !== "function" || Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
        throw new TypeError("catalog write callback must be synchronous");
    }
    const previous = writeDepth.get(db) ?? 0;
    writeDepth.set(db, previous + 1);
    try {
        const result = callback();
        if (result !== null && (typeof result === "object" || typeof result === "function") &&
            typeof (result as { then?: unknown }).then === "function") {
            throw new TypeError("catalog write callback must be synchronous");
        }
        return result;
    } finally {
        if (previous === 0) writeDepth.delete(db);
        else writeDepth.set(db, previous);
    }
};
