/**
 * JPA `JpaRepository` analogue for the SQLite kernel.
 *
 * Generated CRUD is delegated to {@link TableSql}; a concrete repository only
 * adds aggregate-specific queries. Those queries may use the exposed
 * connection or the protected SQL adapter, but they must not construct SQL for
 * the generated operations that the base class already owns.
 *
 * @typeParam TEntity - Row shape returned by the table.
 * @typeParam TKey - Primary-key type.
 */
import type { DatabaseSync } from "node:sqlite";

import type { PrimaryKey } from "../entity/entity.ts";
import type { TableMeta } from "../entity/meta.ts";
import { TableSql } from "../sql/sql.ts";
import { Repository } from "./repository.ts";

export class BaseRepository<TEntity extends object, TKey extends PrimaryKey = PrimaryKey> extends Repository<TEntity, TKey, TableSql<TEntity, TKey>> {
    protected readonly db: DatabaseSync;
    readonly meta: TableMeta;

    /**
     * Create a repository backed by one table.
     *
     * @param db - Open SQLite connection.
     * @param meta - Table, primary key and column metadata.
     */
    constructor(db: DatabaseSync, meta: TableMeta) {
        super(new TableSql<TEntity, TKey>(db, meta));
        this.db = db;
        this.meta = meta;
    }

    /**
     * Exposed for services that need a transaction or a store helper.
     */
    get connection(): DatabaseSync {
        return this.db;
    }
}
