import type { ObjectEntity } from "../database/entity/object.ts";
import { EntityCache } from "./cache.ts";
import { bindCache } from "./bindCache.ts";

const cacheFor: () => EntityCache<ObjectEntity> = bindCache(
    (db) =>
        new EntityCache<ObjectEntity>({
            load: (key) => db.objectService.byId(Number(key)),
            keyOf: (value) => `${value.seq}`,
            capacity: 512,
            ttlMs: 5000,
        }),
);

export const ObjectStore = {
    get(seq: number): ObjectEntity | undefined {
        return cacheFor().get(seq);
    },
    put(value: ObjectEntity): void {
        cacheFor().put(value);
    },
    invalidate(seq?: number): void {
        cacheFor().invalidate(seq);
    },
    stats(): ReturnType<EntityCache<ObjectEntity>["stats"]> {
        return cacheFor().stats();
    },
    get entities(): Record<string, ObjectEntity> {
        return cacheFor().entities;
    },
};
