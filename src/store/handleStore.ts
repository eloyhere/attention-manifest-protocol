import type { HandleEntity } from "../database/entity/handle.ts";
import { EntityCache } from "./cache.ts";
import { bindCache } from "./bindCache.ts";

const cacheFor: () => EntityCache<HandleEntity> = bindCache(
    (db) =>
        new EntityCache<HandleEntity>({
            load: (key) => db.handleService.byId(Number(key)),
            keyOf: (value) => `${value.hid}`,
            capacity: 256,
            ttlMs: 2000,
        }),
);

export const HandleStore = {
    get(hid: number): HandleEntity | undefined {
        return cacheFor().get(hid);
    },
    put(value: HandleEntity): void {
        cacheFor().put(value);
    },
    invalidate(hid?: number): void {
        cacheFor().invalidate(hid);
    },
    stats(): ReturnType<EntityCache<HandleEntity>["stats"]> {
        return cacheFor().stats();
    },
    get entities(): Record<string, HandleEntity> {
        return cacheFor().entities;
    },
};
