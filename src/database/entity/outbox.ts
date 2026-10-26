import type { TableMeta } from "./meta.ts";

export interface OutboxEntity {
    id: number;
    topic: string;
    payload: string;
    created_at: string;
    dispatched_at: string | null;
}

export const OutboxTable: TableMeta = {
    table: "outbox",
    primaryKey: "id",
    columns: ["id", "topic", "payload", "created_at", "dispatched_at"],
};
