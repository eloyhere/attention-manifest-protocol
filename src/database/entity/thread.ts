import { defineEntity, toTableMeta } from "./entity.ts";
import type { Entity } from "./entity.ts";
import type { TableMeta } from "./meta.ts";

/**
 * Row shape of `threads`: one task/goal an agent is executing.
 */
export interface ThreadEntity {
    tid: number;
    id: string;
    pid: number;
    goal: string;
    statement: string;
    success: string;
    state: string;
    priority: number;
    quantum_ms: number;
    slice_used_ms: number;
    budget: string;
    used: string;
    blocked_on: string | null;
    wake_at: string | null;
    created_at: string;
    finished_at: string | null;
    exit_note: string | null;
    owner_worker: string | null;
    lease: number;
    version: number;
}

/**
 * JPA metadata for the thread/task table.
 */
export const ThreadEntityMeta: Entity = defineEntity({
    name: "Thread",
    table: {
        name: "threads",
        uniqueConstraints: [{ columnNames: ["id"] }],
    },
    fields: [
        { name: "tid", id: true, generated: { strategy: "Identity" } },
        { name: "id" },
        { name: "pid" },
        { name: "goal" },
        { name: "statement" },
        { name: "success" },
        { name: "state" },
        { name: "priority" },
        { name: "quantum_ms" },
        { name: "slice_used_ms" },
        { name: "budget" },
        { name: "used" },
        { name: "blocked_on" },
        { name: "wake_at" },
        { name: "created_at" },
        { name: "finished_at" },
        { name: "exit_note" },
        { name: "owner_worker" },
        { name: "lease" },
        { name: "version", version: true },
    ],
    relations: [
        {
            name: "process",
            target: "Process",
            joinColumns: [{ name: "pid" }],
        },
        {
            name: "steps",
            target: "Step",
            mappedBy: "tid",
        },
        {
            name: "ownerWorker",
            target: "Worker",
            optional: true,
            joinColumns: [{ name: "owner_worker" }],
        },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const ThreadTable: TableMeta = toTableMeta(ThreadEntityMeta);
