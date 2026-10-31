import type { DatabaseSync } from "node:sqlite";

import type { MessageEntity } from "../entity/message.ts";
import { MessageTable } from "../entity/message.ts";
import { BaseRepository } from "./base.ts";

/**
 * Mailbox repository.
 */
export class MessageRepository extends BaseRepository<MessageEntity> {
    constructor(db: DatabaseSync) {
        super(db, MessageTable);
    }

    /**
     * Undelivered messages for one recipient, oldest first.
     *
     * @param pid - Recipient process id.
     * @param limit - Maximum rows.
     * @returns Pending messages.
     */
    pending(pid: number, limit: number = 64): MessageEntity[] {
        return this.queries.select({
            where: "to_pid = ? AND delivered_at IS NULL",
            params: [pid],
            orderBy: "ORDER BY msg_id ASC",
            limit,
        });
    }

    /**
     * Count undelivered messages for one recipient.
     *
     * @param pid - Recipient process id.
     * @returns Pending count.
     */
    pendingCount(pid: number): number {
        return this.count("to_pid = ? AND delivered_at IS NULL", pid);
    }

    /**
     * Mark one message delivered exactly once.
     *
     * @param msgId - Message id.
     * @param receiptId - Delivery receipt id.
     * @param at - Delivery timestamp.
     * @returns Number of changed rows.
     */
    markDelivered(msgId: number, receiptId: string, at: string): number {
        return this.updateWhere("msg_id = ? AND delivered_at IS NULL", { delivered_at: at, receipt_id: receiptId }, msgId);
    }
}
