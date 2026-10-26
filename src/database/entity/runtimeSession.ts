import type { TableMeta } from "./meta.ts";

export interface RuntimeSessionRow {
    pid: number;
    data: string;
    updated_at: string;
}

export const RuntimeSessionTable: TableMeta = {
    table: "runtime_sessions",
    primaryKey: "pid",
    columns: ["pid", "data", "updated_at"],
};
