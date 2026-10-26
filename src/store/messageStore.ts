import type { MessageEntity } from "../database/entity/message.ts";
import { EntityCache } from "./cache.ts";
import { bindCache } from "./bindCache.ts";

const cacheFor: () => EntityCache<MessageEntity> = bindCache(
    (db) =>
        new EntityCache<MessageEntity>({
            load: (key) => db.messageService.byId(Number(key)),
            keyOf: (value) => `${value.msg_id}`,
            capacity: 256,
            ttlMs: 1000,
        }),
);

export const MessageStore = {
    get(msgId: number): MessageEntity | undefined {
        return cacheFor().get(msgId);
    },
    put(value: MessageEntity): void {
        cacheFor().put(value);
    },
    invalidate(msgId?: number): void {
        cacheFor().invalidate(msgId);
    },
    stats(): ReturnType<EntityCache<MessageEntity>["stats"]> {
        return cacheFor().stats();
    },
    get entities(): Record<string, MessageEntity> {
        return cacheFor().entities;
    },
};
