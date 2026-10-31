import { defineEntity, toTableMeta } from "./entity.ts";
import type { Entity } from "./entity.ts";
import type { TableMeta } from "./meta.ts";

/**
 * Row shape of the capability/handle table.
 */
export interface HandleEntity {
    hid: number;
    id: string;
    subject_kind: string;
    subject_id: string;
    subject_pid: number | null;
    resource_kind: string;
    resource_id: string;
    owner_pid: number | null;
    rights: string;
    scope: string;
    parent_hid: number | null;
    refcount: number;
    expires_at: string | null;
    revoked_at: string | null;
    granted_by: string | null;
    created_at: string;
}

/**
 * JPA metadata for the handle/capability table.
 */
export const HandleEntityMeta: Entity = defineEntity({
    name: "Handle",
    table: {
        name: "handles",
        uniqueConstraints: [{ columnNames: ["id"] }],
    },
    fields: [
        { name: "hid", id: true, generated: { strategy: "Identity" } },
        { name: "id" },
        { name: "subject_kind" },
        { name: "subject_id" },
        { name: "subject_pid" },
        { name: "resource_kind" },
        { name: "resource_id" },
        { name: "owner_pid" },
        { name: "rights" },
        { name: "scope" },
        { name: "parent_hid" },
        { name: "refcount" },
        { name: "expires_at" },
        { name: "revoked_at" },
        { name: "granted_by" },
        { name: "created_at" },
    ],
    relations: [
        {
            name: "parent",
            target: "Handle",
            optional: true,
            joinColumns: [{ name: "parent_hid" }],
        },
        {
            name: "subjectProcess",
            target: "Process",
            optional: true,
            joinColumns: [{ name: "subject_pid" }],
        },
        {
            name: "ownerProcess",
            target: "Process",
            optional: true,
            joinColumns: [{ name: "owner_pid" }],
        },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const HandleTable: TableMeta = toTableMeta(HandleEntityMeta);
