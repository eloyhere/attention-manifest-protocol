import { defineEntity, toTableMeta } from "./entity.ts";
import type { Entity } from "./entity.ts";
import type { TableMeta } from "./meta.ts";

/**
 * Row shape of the inter-process mailbox table.
 */
export interface MessageEntity {
    msg_id: number;
    id: string;
    from_pid: number;
    from_tid: number;
    to_pid: number;
    to_tid: number | null;
    kind: string;
    body: string;
    correlation_id: string | null;
    at: string;
    delivered_at: string | null;
    receipt_id: string | null;
}

/**
 * JPA metadata for the mailbox table.
 */
export const MessageEntityMeta: Entity = defineEntity({
    name: "Message",
    table: {
        name: "messages",
        uniqueConstraints: [{ columnNames: ["id"] }],
    },
    fields: [
        { name: "msg_id", id: true, generated: { strategy: "Identity" } },
        { name: "id" },
        { name: "from_pid" },
        { name: "from_tid" },
        { name: "to_pid" },
        { name: "to_tid" },
        { name: "kind" },
        { name: "body" },
        { name: "correlation_id" },
        { name: "at" },
        { name: "delivered_at" },
        { name: "receipt_id" },
    ],
    relations: [
        {
            name: "fromProcess",
            target: "Process",
            joinColumns: [{ name: "from_pid" }],
        },
        {
            name: "toProcess",
            target: "Process",
            joinColumns: [{ name: "to_pid" }],
        },
        {
            name: "fromThread",
            target: "Thread",
            joinColumns: [{ name: "from_tid" }],
        },
        {
            name: "toThread",
            target: "Thread",
            optional: true,
            joinColumns: [{ name: "to_tid" }],
        },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const MessageTable: TableMeta = toTableMeta(MessageEntityMeta);
