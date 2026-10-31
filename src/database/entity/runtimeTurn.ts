import type { TableMeta } from "./meta.ts";

export interface RuntimeTurnRow {
    id: string;
    pid: number;
    session_id: string | null;
    data: string;
    created_at: string;
}

export const RuntimeTurnTable: TableMeta = {
    table: "runtime_turns",
    primaryKey: "id",
    columns: ["id", "pid", "session_id", "data", "created_at"],
};
