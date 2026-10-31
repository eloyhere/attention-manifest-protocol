import type { WindowEntity } from "../database/entity/window.ts";
import { EntityCache } from "./cache.ts";
import { bindCache } from "./bindCache.ts";

const cacheFor: () => EntityCache<WindowEntity> = bindCache(
    (db) =>
        new EntityCache<WindowEntity>({
            load: (key) => db.windowService.get(Number(key)),
            keyOf: (value) => `${value.tid}`,
            capacity: 128,
            ttlMs: 1000,
        }),
);

export const WindowStore = {
    get(tid: number): WindowEntity | undefined {
        return cacheFor().get(tid);
    },
    put(value: WindowEntity): void {
        cacheFor().put(value);
    },
    invalidate(tid?: number): void {
        cacheFor().invalidate(tid);
    },
    stats(): ReturnType<EntityCache<WindowEntity>["stats"]> {
        return cacheFor().stats();
    },
    get entities(): Record<string, WindowEntity> {
        return cacheFor().entities;
    },
};
