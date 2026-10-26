import type { ProcessEntity } from "../database/entity/process.ts";
import { EntityCache } from "./cache.ts";
import { bindCache } from "./bindCache.ts";

const cacheFor: () => EntityCache<ProcessEntity> = bindCache(
    (db) =>
        new EntityCache<ProcessEntity>({
            load: (key) => db.processService.byId(Number(key)),
            keyOf: (value) => `${value.pid}`,
            capacity: 256,
            ttlMs: 2000,
        }),
);

export const processStore = {
    get(pid: number): ProcessEntity | undefined {
        return cacheFor().get(pid);
    },
    put(value: ProcessEntity): void {
        cacheFor().put(value);
    },
    invalidate(pid?: number): void {
        cacheFor().invalidate(pid);
    },
    stats(): ReturnType<EntityCache<ProcessEntity>["stats"]> {
        return cacheFor().stats();
    },
    get entities(): Record<string, ProcessEntity> {
        return cacheFor().entities;
    },
};
