/**
 * Store context: one `Database` (and therefore one set of services) per process.
 *
 * Caches are bound to the current database instance; `configureStore` closes the
 * previous one, and every store factory notices the change and rebuilds.
 */
import { Database } from "../database/service/database.ts";

let Current: Database | undefined;

export const configureStore: (path: string) => Database = (path: string): Database => {
    if (Current !== (void 0)) {
        Current.close();
    }
    Current = new Database(path);
    return Current;
};

export const database: () => Database = (): Database => {
    if (Current === (void 0)) {
        throw new Error("configureStore(path) must be called before using a store");
    }
    return Current;
};

export const shutdownStore: () => void = (): void => {
    if (Current !== (void 0)) {
        Current.close();
    }
    Current = undefined;
};
