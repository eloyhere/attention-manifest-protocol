import type { Digest } from "../../types/common.ts";
import { defineEntity, toTableMeta } from "./entity.ts";
import type { Entity } from "./entity.ts";
import type { TableMeta } from "./meta.ts";

/**
 * Row shape of `objects`; bodies stay canonical JSON strings.
 */
export interface ObjectEntity {
    seq: number;
    kind: string;
    id: string;
    body: string;
    hash: Digest;
    prev: Digest;
    at: string;
}

/**
 * JPA metadata for the append-only object table.
 */
export const ObjectEntityMeta: Entity = defineEntity({
    name: "Object",
    table: {
        name: "objects",
        uniqueConstraints: [{ columnNames: ["kind", "id"] }],
    },
    fields: [
        { name: "seq", id: true, generated: { strategy: "Identity" } },
        { name: "kind" },
        { name: "id" },
        { name: "body" },
        { name: "hash" },
        { name: "prev" },
        { name: "at" },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const ObjectTable: TableMeta = toTableMeta(ObjectEntityMeta);
