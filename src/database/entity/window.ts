import { defineEntity, toTableMeta } from "./entity.ts";
import type { Entity } from "./entity.ts";
import type { TableMeta } from "./meta.ts";

/**
 * Row shape of a thread's context window.
 */
export interface WindowEntity {
    tid: number;
    capacity_tokens: number;
    used_tokens: number;
    updated_at: string;
}

/**
 * JPA metadata for context windows.
 */
export const WindowEntityMeta: Entity = defineEntity({
    name: "Window",
    table: {
        name: "windows",
    },
    fields: [{ name: "tid", id: true }, { name: "capacity_tokens" }, { name: "used_tokens" }, { name: "updated_at" }],
    relations: [
        {
            name: "thread",
            target: "Thread",
            joinColumns: [{ name: "tid" }],
        },
        {
            name: "pages",
            target: "WindowPage",
            mappedBy: "tid",
        },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const WindowTable: TableMeta = toTableMeta(WindowEntityMeta);

/**
 * Row shape of one resident window page.
 */
export interface WindowPageEntity {
    tid: number;
    page_id: string;
    object_kind: string;
    object_id: string;
    tokens: number;
    pinned: number;
    last_used: number;
}

/**
 * JPA metadata for window pages.
 */
export const WindowPageEntityMeta: Entity = defineEntity({
    name: "WindowPage",
    table: {
        name: "window_pages",
    },
    fields: [
        { name: "tid" },
        { name: "page_id", id: true },
        { name: "object_kind" },
        { name: "object_id" },
        { name: "tokens" },
        { name: "pinned" },
        { name: "last_used" },
    ],
    relations: [
        {
            name: "window",
            target: "Window",
            joinColumns: [{ name: "tid" }],
        },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const WindowPageTable: TableMeta = toTableMeta(WindowPageEntityMeta);
