/**
 * Service abstraction over one repository.
 *
 * Services own use-case policy: they translate application input into
 * repository operations, return domain-shaped rows, and turn a missing row
 * into a stable error. They never import `node:sqlite` or construct SQL.
 *
 * @typeParam TEntity - Row shape returned by the service.
 * @typeParam TKey - Primary-key type.
 * @typeParam TRepository - Concrete repository used by the service.
 */
import type { PrimaryKey } from "../entity/entity.ts";
import type { Page, Query, Repository } from "../repository/repository.ts";
import type { MutationResult, SqlParameter } from "../sql/sql.ts";

/**
 * Error raised when a service requires a row that does not exist.
 */
export class EntityNotFoundError extends Error {
    /**
     * Entity label used in the message.
     */
    readonly entityName: string;
    /**
     * Missing primary-key value.
     */
    readonly id: PrimaryKey;

    constructor(entityName: string, id: PrimaryKey) {
        super(`${entityName} not found: ${id}`);
        this.name = "EntityNotFoundError";
        this.entityName = entityName;
        this.id = id;
    }
}

export abstract class Service<TEntity extends object, TKey extends PrimaryKey = PrimaryKey, TRepository extends Repository<TEntity, TKey> = Repository<TEntity, TKey>> {
    protected readonly repository: TRepository;
    protected readonly entityName: string;

    /**
     * Create a service.
     *
     * @param repository - Repository used for all persistence.
     * @param entityName - Label used in missing-row errors.
     */
    protected constructor(repository: TRepository, entityName: string = "entity") {
        this.repository = repository;
        this.entityName = entityName;
    }

    /**
     * Find one row by primary key.
     *
     * @param id - Primary-key value.
     * @returns The row, or `undefined`.
     */
    findById(id: TKey): TEntity | undefined {
        return this.repository.findById(id);
    }

    /**
     * Find one row or throw.
     *
     * @param id - Primary-key value.
     * @param entityName - Optional label override.
     * @returns The row.
     * @throws EntityNotFoundError when the row is absent.
     */
    requireById(id: TKey, entityName: string = this.entityName): TEntity {
        const row: TEntity | undefined = this.repository.findById(id);
        if (row === (void 0)) {
            throw new EntityNotFoundError(entityName, id);
        }
        return row;
    }

    /**
     * Read rows in unspecified order.
     *
     * @param limit - Maximum row count.
     * @returns Matching rows.
     */
    all(limit: number = 1000): TEntity[] {
        return this.repository.all(limit);
    }

    /**
     * Read rows with a typed query descriptor.
     *
     * @param query - Filter, ordering and pagination options.
     * @returns Matching rows.
     */
    findAll(query: Query<TEntity>): TEntity[] {
        return this.repository.findAll(query);
    }

    /**
     * Read one page of rows.
     *
     * @param query - Filter and ordering options.
     * @param pageNumber - Zero-based page index.
     * @param pageSize - Requested page size.
     * @returns A page descriptor.
     */
    page(query: Query<TEntity>, pageNumber: number = 0, pageSize: number = 20): Page<TEntity> {
        return this.repository.page(query, pageNumber, pageSize);
    }

    /**
     * Read rows with a trusted WHERE fragment.
     *
     * @param clause - SQL after `WHERE`.
     * @param params - Bound values.
     * @returns Matching rows.
     */
    where(clause: string, ...params: SqlParameter[]): TEntity[] {
        return this.repository.where(clause, ...params);
    }

    /**
     * Count rows.
     *
     * @param clause - Optional SQL after `WHERE`.
     * @param params - Bound values.
     * @returns Number of rows.
     */
    count(clause?: string, ...params: SqlParameter[]): number {
        return this.repository.count(clause, ...params);
    }

    /**
     * Test whether a row exists.
     *
     * @param id - Primary-key value.
     * @returns `true` when present.
     */
    exists(id: TKey): boolean {
        return this.repository.exists(id);
    }

    /**
     * Insert one row.
     *
     * @param values - Column values.
     * @returns Mutation metadata.
     */
    insert(values: Readonly<Record<string, unknown>>): MutationResult {
        return this.repository.insert(values);
    }

    /**
     * Update one row by primary key.
     *
     * @param id - Primary-key value.
     * @param values - Column values.
     * @returns Number of changed rows.
     */
    update(id: TKey, values: Readonly<Record<string, unknown>>): number {
        return this.repository.update(id, values);
    }

    /**
     * Delete one row by primary key.
     *
     * @param id - Primary-key value.
     * @returns Number of deleted rows.
     */
    delete(id: TKey): number {
        return this.repository.delete(id);
    }

    /**
     * Insert or update according to unique columns.
     *
     * @param values - Column values.
     * @param conflictColumns - Unique columns; defaults to the primary key.
     * @returns Mutation metadata.
     */
    upsert(values: Readonly<Record<string, unknown>>, conflictColumns?: readonly string[]): MutationResult {
        return this.repository.upsert(values, conflictColumns);
    }
}
