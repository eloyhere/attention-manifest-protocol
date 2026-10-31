/**
 * Repository abstraction over one {@link Sql} table adapter.
 *
 * A repository exposes row-shaped operations and never touches `node:sqlite`
 * directly. Concrete repositories extend this class, add table-specific
 * queries through the protected `sql` adapter, and keep their public methods
 * focused on the aggregate that the service consumes.
 *
 * @typeParam TEntity - Row shape returned by the repository.
 * @typeParam TKey - Primary-key type.
 * @typeParam TSql - Concrete SQL adapter used by the repository.
 */
import type { PrimaryKey } from "../entity/entity.ts";
import { assertSqlIdentifier } from "../sql/sql.ts";
import type { MutationResult, Sql, SqlParameter } from "../sql/sql.ts";

/**
 * Sort direction, using the JPA/Spring Data spelling.
 */
export type SortDirection = "Ascend" | "Descend";

/**
 * Null-ordering option for a sort order.
 */
export type SortNullHandling = "Native" | "NullsFirst" | "NullsLast";

/**
 * One property in a sort.
 */
export interface SortOrder {
    /**
     * Entity property (column) to sort by.
     */
    readonly property: string;
    /**
     * Sort direction.
     */
    readonly direction: SortDirection;
    /**
     * Whether to compare case-insensitively.
     */
    readonly ignoreCase?: boolean;
    /**
     * Null placement for databases that support it.
     */
    readonly nullHandling?: SortNullHandling;
}

/**
 * Immutable sort specification, modelled on Spring Data's `Sort`.
 *
 * A sort is a list of property/direction pairs. Property names are validated
 * as SQL identifiers when the sort is built, so a caller cannot smuggle an
 * expression through the ordering API.
 */
export class Sort {
    private static readonly Unsorted: Sort = new Sort([]);
    readonly orders: readonly SortOrder[];

    /**
     * Create a sort from already-validated orders.
     *
     * @param orders - Sort orders.
     */
    private constructor(orders: readonly SortOrder[]) {
        this.orders = [...orders];
    }

    /**
     * Build a sort with one direction for several properties.
     *
     * @param direction - Sort direction.
     * @param properties - Entity property names.
     * @returns A sort; empty property lists produce an unsorted value.
     */
    static by(direction: SortDirection, ...properties: string[]): Sort {
        if (properties.length === 0) {
            return Sort.unsorted();
        }
        const orders: SortOrder[] = [];
        for (let index: number = 0; index < properties.length; index += 1) {
            const property: string = assertSqlIdentifier(properties[index]);
            orders.push({ property, direction });
        }
        return new Sort(orders);
    }

    /**
     * Build an Ascendending sort.
     *
     * @param properties - Entity property names.
     * @returns An Ascendending sort.
     */
    static Ascend(...properties: string[]): Sort {
        return Sort.by("Ascend", ...properties);
    }

    /**
     * Build a Descendending sort.
     *
     * @param properties - Entity property names.
     * @returns A Descendending sort.
     */
    static Descend(...properties: string[]): Sort {
        return Sort.by("Descend", ...properties);
    }

    /**
     * Return the canonical unsorted value.
     *
     * @returns An empty sort.
     */
    static unsorted(): Sort {
        return Sort.Unsorted;
    }

    /**
     * Append another sort.
     *
     * @param other - Sort appended after this one.
     * @returns A new combined sort.
     */
    and(other: Sort): Sort {
        if (!other.isSorted()) {
            return this;
        }
        if (!this.isSorted()) {
            return other;
        }
        return new Sort([...this.orders, ...other.orders]);
    }

    /**
     * Whether this sort contains at least one order.
     *
     * @returns `true` when sorted.
     */
    isSorted(): boolean {
        return this.orders.length > 0;
    }

    /**
     * Reverse every order while preserving ignore-case and null handling.
     *
     * @returns A reversed sort.
     */
    reverse(): Sort {
        const orders: SortOrder[] = [];
        for (let index: number = 0; index < this.orders.length; index += 1) {
            const order: SortOrder = this.orders[index];
            orders.push({
                property: order.property,
                direction: order.direction === "Ascend" ? "Descend" : "Ascend",
                ignoreCase: order.ignoreCase,
                nullHandling: order.nullHandling,
            });
        }
        return new Sort(orders);
    }

    /**
     * Render the ORDER BY fragment.
     *
     * @returns An empty string for an unsorted value, otherwise `ORDER BY ...`.
     */
    toSql(): string {
        if (!this.isSorted()) {
            return "";
        }
        const fragments: string[] = [];
        for (let index: number = 0; index < this.orders.length; index += 1) {
            const order: SortOrder = this.orders[index];
            const column: string = `"${assertSqlIdentifier(order.property)}"`;
            const expression: string = order.ignoreCase === true ? `LOWER(${column})` : column;
            let fragment: string = `${expression} ${order.direction}`;
            if (order.nullHandling === "NullsFirst") {
                fragment += " NULLS FIRST";
            } else if (order.nullHandling === "NullsLast") {
                fragment += " NULLS LAST";
            }
            fragments.push(fragment);
        }
        return `ORDER BY ${fragments.join(", ")}`;
    }
}

/**
 * Query Descendriptor for a typed repository read.
 *
 * The WHERE fragment is trusted SQL, matching the repository layer's existing
 * boundary; values belong in `params`. The generic parameter keeps optional
 * column projections tied to the entity shape.
 *
 * @typeParam TEntity - Row shape returned by the query.
 */
export interface Query<TEntity> {
    /**
     * Optional SQL after WHERE.
     */
    readonly where?: string;
    /**
     * Bound values for the WHERE fragment.
     */
    readonly params?: readonly SqlParameter[];
    /**
     * Optional ordering.
     */
    readonly sort?: Sort;
    /**
     * Maximum row count.
     */
    readonly limit?: number;
    /**
     * Number of rows to skip.
     */
    readonly offset?: number;
    /**
     * Optional entity-column projection.
     */
    readonly columns?: readonly Extract<keyof TEntity, string>[];
}

/**
 * Page of repository rows, modelled on Spring Data's `Page`.
 *
 * @typeParam TEntity - Row shape in the page.
 */
export interface Page<TEntity> {
    /**
     * Rows on this page.
     */
    readonly content: readonly TEntity[];
    /**
     * Total rows across all pages.
     */
    readonly totalElements: number;
    /**
     * Total number of pages.
     */
    readonly totalPages: number;
    /**
     * Zero-based page index.
     */
    readonly number: number;
    /**
     * Requested page size.
     */
    readonly size: number;
    /**
     * Whether this is the first page.
     */
    readonly first: boolean;
    /**
     * Whether this is the last page.
     */
    readonly last: boolean;
    /**
     * Whether another page follows.
     */
    readonly hasNext: boolean;
    /**
     * Whether a previous page exists.
     */
    readonly hasPrevious: boolean;
}

/**
 * Factory signature for {@link pageOf}.
 *
 * @typeParam TEntity - Row shape in the page.
 */
type PageOf = <TEntity>(content: readonly TEntity[], totalElements: number, number: number, size: number) => Page<TEntity>;

/**
 * Build a page and derive its navigation flags.
 *
 * @typeParam TEntity - Row shape in the page.
 * @param content - Rows on this page.
 * @param totalElements - Total row count.
 * @param number - Zero-based page index.
 * @param size - Page size.
 * @returns A complete page Descendriptor.
 */
export const pageOf: PageOf = <TEntity>(content: readonly TEntity[], totalElements: number, number: number, size: number): Page<TEntity> => {
    if (!Number.isInteger(totalElements) || totalElements < 0) {
        throw new RangeError("totalElements must be a non-negative integer");
    }
    if (!Number.isInteger(number) || number < 0) {
        throw new RangeError("page number must be a non-negative integer");
    }
    if (!Number.isInteger(size) || size <= 0) {
        throw new RangeError("page size must be a positive integer");
    }
    const totalPages: number = Math.ceil(totalElements / size);
    return {
        content: [...content],
        totalElements,
        totalPages,
        number,
        size,
        first: number === 0,
        last: totalPages === 0 || number >= totalPages - 1,
        hasNext: number + 1 < totalPages,
        hasPrevious: number > 0,
    };
};

export abstract class Repository<TEntity extends object, TKey extends PrimaryKey = PrimaryKey, TSql extends Sql<TEntity, TKey> = Sql<TEntity, TKey>> {
    protected readonly sql: TSql;

    /**
     * Create a repository.
     *
     * @param sql - Table adapter that owns all SQL statements.
     */
    protected constructor(sql: TSql) {
        this.sql = sql;
    }

    /**
     * Access the table adapter for concrete repository queries.
     */
    protected get queries(): TSql {
        return this.sql;
    }

    /**
     * Find one row by primary key.
     *
     * @param id - Primary-key value.
     * @returns The row, or `undefined`.
     */
    findById(id: TKey): TEntity | undefined {
        return this.sql.findById(id);
    }

    /**
     * Read rows in unspecified order.
     *
     * @param limit - Maximum row count.
     * @returns Matching rows.
     */
    all(limit: number = 1000): TEntity[] {
        return this.sql.all(limit);
    }

    /**
     * Read rows using a typed query Descendriptor.
     *
     * @param query - Filter, ordering and pagination options.
     * @returns Matching rows.
     */
    findAll(query: Query<TEntity>): TEntity[] {
        const where: string = query.where?.trim() ?? "";
        const params: SqlParameter[] = query.params === (void 0) ? [] : [...query.params];
        return this.sql.select({
            where: where.length === 0 ? (void 0) : where,
            params,
            orderBy: query.sort?.toSql() ?? "",
            limit: query.limit,
            offset: query.offset,
            columns: query.columns,
        });
    }

    /**
     * Read one page and count the full result set.
     *
     * @param query - Filter and ordering options; query limit/offset are ignored.
     * @param pageNumber - Zero-based page index.
     * @param pageSize - Requested page size.
     * @returns A page Descendriptor.
     */
    page(query: Query<TEntity>, pageNumber: number = 0, pageSize: number = 20): Page<TEntity> {
        if (!Number.isInteger(pageNumber) || pageNumber < 0) {
            throw new RangeError("pageNumber must be a non-negative integer");
        }
        if (!Number.isInteger(pageSize) || pageSize <= 0) {
            throw new RangeError("pageSize must be a positive integer");
        }
        const where: string = query.where?.trim() ?? "";
        const params: SqlParameter[] = query.params === (void 0) ? [] : [...query.params];
        const total: number = this.sql.count(where.length === 0 ? (void 0) : where, ...params);
        const content: TEntity[] = this.sql.select({
            where: where.length === 0 ? (void 0) : where,
            params,
            orderBy: query.sort?.toSql() ?? "",
            limit: pageSize,
            offset: pageNumber * pageSize,
            columns: query.columns,
        });
        return pageOf(content, total, pageNumber, pageSize);
    }

    /**
     * Read rows with a trusted WHERE fragment.
     *
     * @param clause - SQL after `WHERE`.
     * @param params - Bound values.
     * @returns Matching rows.
     */
    where(clause: string, ...params: SqlParameter[]): TEntity[] {
        return this.sql.where(clause, ...params);
    }

    /**
     * Count rows.
     *
     * @param clause - Optional SQL after `WHERE`.
     * @param params - Bound values for the clause.
     * @returns Number of rows.
     */
    count(clause?: string, ...params: SqlParameter[]): number {
        return this.sql.count(clause, ...params);
    }

    /**
     * Test whether a primary key exists.
     *
     * @param id - Primary-key value.
     * @returns `true` when present.
     */
    exists(id: TKey): boolean {
        return this.sql.exists(id);
    }

    /**
     * Insert one row.
     *
     * @param values - Column values.
     * @returns Mutation metadata.
     */
    insert(values: Readonly<Record<string, unknown>>): MutationResult {
        return this.sql.insert(values);
    }

    /**
     * Update one row by primary key.
     *
     * @param id - Primary-key value.
     * @param values - Column values.
     * @returns Number of changed rows.
     */
    update(id: TKey, values: Readonly<Record<string, unknown>>): number {
        return this.sql.update(id, values);
    }

    /**
     * Update rows with a trusted WHERE fragment.
     *
     * @param clause - SQL after `WHERE`.
     * @param values - Column values.
     * @param params - Bound values for the clause.
     * @returns Number of changed rows.
     */
    updateWhere(clause: string, values: Readonly<Record<string, unknown>>, ...params: SqlParameter[]): number {
        return this.sql.updateWhere(clause, values, ...params);
    }

    /**
     * Delete one row by primary key.
     *
     * @param id - Primary-key value.
     * @returns Number of deleted rows.
     */
    delete(id: TKey): number {
        return this.sql.delete(id);
    }

    /**
     * Delete rows with a trusted WHERE fragment.
     *
     * @param clause - SQL after `WHERE`.
     * @param params - Bound values for the clause.
     * @returns Number of deleted rows.
     */
    deleteWhere(clause: string, ...params: SqlParameter[]): number {
        return this.sql.deleteWhere(clause, ...params);
    }

    /**
     * Insert or update according to unique columns.
     *
     * @param values - Column values.
     * @param conflictColumns - Unique columns; defaults to the primary key.
     * @returns Mutation metadata.
     */
    upsert(values: Readonly<Record<string, unknown>>, conflictColumns?: readonly string[]): MutationResult {
        return this.sql.upsert(values, conflictColumns);
    }
}
