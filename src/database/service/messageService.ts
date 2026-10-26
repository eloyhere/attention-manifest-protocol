import type { PrimaryKey } from "../entity/entity.ts";
import type { MessageEntity } from "../entity/message.ts";
import { MessageRepository } from "../repository/messageRepository.ts";
import type { MutationResult } from "../sql/sql.ts";
import { Service } from "./service.ts";

export interface SendMessageInput {
    id: string;
    fromPid: number;
    fromTid: number;
    toPid: number;
    toTid?: number;
    kind: "request" | "response" | "event" | "signal";
    body: unknown;
    correlationId?: string;
    at: string;
}

/**
 * One service per entity: `messages`.
 */
export class MessageService extends Service<MessageEntity, PrimaryKey, MessageRepository> {
    constructor(messages: MessageRepository) {
        super(messages, "Message");
    }

    byId(msgId: number): MessageEntity | undefined {
        return this.findById(msgId);
    }

    pending(pid: number, limit = 64): MessageEntity[] {
        return this.repository.pending(pid, limit);
    }

    pendingCount(pid: number): number {
        return this.repository.pendingCount(pid);
    }

    send(input: SendMessageInput): MessageEntity {
        const result: MutationResult = this.repository.insert({
            id: input.id,
            from_pid: input.fromPid,
            from_tid: input.fromTid,
            to_pid: input.toPid,
            to_tid: input.toTid ?? null,
            kind: input.kind,
            body: JSON.stringify(input.body),
            correlation_id: input.correlationId ?? null,
            at: input.at,
        });
        const row: MessageEntity | undefined = this.byId(Number(result.lastInsertRowid));
        if (row === (void 0)) {
            throw new Error(`message ${input.id} was not stored`);
        }
        return row;
    }

    markDelivered(msgId: number, receiptId: string, at: string): number {
        return this.repository.markDelivered(msgId, receiptId, at);
    }
}
