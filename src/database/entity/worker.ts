import { defineEntity, toTableMeta } from "./entity.ts";
import type { Entity } from "./entity.ts";
import type { TableMeta } from "./meta.ts";

/**
 * Row shape of the worker heartbeat registry.
 */
export interface WorkerEntity {
    worker_id: string;
    host: string | null;
    pid: number | null;
    started_at: string;
    heartbeat_at: string;
    expires_at: string;
}

/**
 * JPA metadata for the worker registry.
 */
export const WorkerEntityMeta: Entity = defineEntity({
    name: "Worker",
    table: {
        name: "workers",
    },
    fields: [{ name: "worker_id", id: true }, { name: "host" }, { name: "pid" }, { name: "started_at" }, { name: "heartbeat_at" }, { name: "expires_at" }],
    relations: [
        {
            name: "process",
            target: "Process",
            optional: true,
            joinColumns: [{ name: "pid" }],
        },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const WorkerTable: TableMeta = toTableMeta(WorkerEntityMeta);

/**
 * Row shape of one execution step.
 */
export interface StepEntity {
    step_id: number;
    pid: number;
    tid: number;
    at: string;
    outcome: string;
    usage: string;
    note: string | null;
    receipt_id: string | null;
}

/**
 * JPA metadata for execution steps.
 */
export const StepEntityMeta: Entity = defineEntity({
    name: "Step",
    table: {
        name: "steps",
    },
    fields: [
        { name: "step_id", id: true, generated: { strategy: "Identity" } },
        { name: "pid" },
        { name: "tid" },
        { name: "at" },
        { name: "outcome" },
        { name: "usage" },
        { name: "note" },
        { name: "receipt_id" },
    ],
    relations: [
        {
            name: "process",
            target: "Process",
            joinColumns: [{ name: "pid" }],
        },
        {
            name: "thread",
            target: "Thread",
            joinColumns: [{ name: "tid" }],
        },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const StepTable: TableMeta = toTableMeta(StepEntityMeta);
