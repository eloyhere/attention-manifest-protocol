/**
 * Table metadata shared by entities and repositories.
 *
 * This is the compact JPA `@Table` analogue used by the repository and SQL
 * layers; rich metadata lives in `entity.ts`.
 */
export interface TableMeta {
    table: string;
    primaryKey: string;
    columns: readonly string[];
}
