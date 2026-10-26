import type { ThreadEntity } from "../database/entity/thread.ts";
import { EntityCache } from "./cache.ts";
import { bindCache } from "./bindCache.ts";

const cacheFor: () => EntityCache<ThreadEntity> = bindCache(
    (db) =>
        new EntityCache<ThreadEntity>({
            load: (key) => db.threadService.byId(Number(key)),
            keyOf: (value) => `${value.tid}`,
            capacity: 256,
            ttlMs: 2000,
        }),
);

export const threadStore = {
    get(tid: number): ThreadEntity | undefined {
        return cacheFor().get(tid);
    },
    put(value: ThreadEntity): void {
        cacheFor().put(value);
    },
    invalidate(tid?: number): void {
        cacheFor().invalidate(tid);
    },
    stats(): ReturnType<EntityCache<ThreadEntity>["stats"]> {
        return cacheFor().stats();
    },
    get entities(): Record<string, ThreadEntity> {
        return cacheFor().entities;
    },
};
