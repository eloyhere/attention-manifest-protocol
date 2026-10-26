import { defineEntity, toTableMeta } from "./entity.ts";
import type { Entity } from "./entity.ts";
import type { TableMeta } from "./meta.ts";

/**
 * Row shape of `processes`: a persistent agent, not a task.
 */
export interface ProcessEntity {
    pid: number;
    id: string;
    name: string;
    role: string | null;
    state: string;
    priority: number;
    budget: string;
    used: string;
    parent_pid: number | null;
    created_at: string;
    started_at: string | null;
    terminated_at: string | null;
    exit_code: string | null;
    exit_note: string | null;
    version: number;
}

/**
 * JPA metadata for the process/agent table.
 */
export const ProcessEntityMeta: Entity = defineEntity({
    name: "Process",
    table: {
        name: "processes",
        uniqueConstraints: [{ columnNames: ["id"] }],
    },
    fields: [
        { name: "pid", id: true, generated: { strategy: "Identity" } },
        { name: "id" },
        { name: "name" },
        { name: "role" },
        { name: "state" },
        { name: "priority" },
        { name: "budget" },
        { name: "used" },
        { name: "parent_pid" },
        { name: "created_at" },
        { name: "started_at" },
        { name: "terminated_at" },
        { name: "exit_code" },
        { name: "exit_note" },
        { name: "version", version: true },
    ],
    relations: [
        {
            name: "parent",
            target: "Process",
            optional: true,
            joinColumns: [{ name: "parent_pid" }],
        },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const ProcessTable: TableMeta = toTableMeta(ProcessEntityMeta);
