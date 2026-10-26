/**
 * Store context: one `Database` (and therefore one set of services) per process.
 *
 * Caches are bound to the current database instance; `configureStore` closes the
 * previous one, and every store factory notices the change and rebuilds.
 */
import { Database } from "../database/service/database.ts";

let current: Database | undefined;

export const configureStore = (path: string): Database => {
    if (current !== undefined) current.close();
    current = new Database(path);
    return current;
};

export const database = (): Database => {
    if (current === undefined) throw new Error("configureStore(path) must be called before using a store");
    return current;
};

export const shutdownStore = (): void => {
    if (current !== undefined) current.close();
    current = undefined;
};
