import type { Database } from "../database/service/database.ts";
import { database } from "./context.ts";
import { EntityCache } from "./cache.ts";

/**
 * Bind one cache to the current `Database`. When `configureStore` replaces the
 * database, the next access rebuilds the cache instead of serving stale rows.
 */
export const bindCache = <T>(factory: (db: Database) => EntityCache<T>): (() => EntityCache<T>) => {
    let cache: EntityCache<T> | undefined;
    let bound: Database | undefined;
    return (): EntityCache<T> => {
        const db: Database = database();
        if (cache === undefined || bound !== db) {
            cache = factory(db);
            bound = db;
        }
        return cache;
    };
};
