/**
 * Inter-process mailbox.
 *
 * Cross-process traffic is messages only: a bounded queue, one delivery, a
 * receipt in the object chain, and a condition notification that wakes a
 * thread blocked on `mailbox:<pid>`. Sending requires a `send` capability on
 * the recipient's mailbox, so two processes do not share anything by default.
 */
import type { DatabaseSync } from "node:sqlite";

import type { MessageEntity } from "../database/entity/message.ts";
import type { MessageService } from "../database/service/messageService.ts";
import { once } from "../concurrency/idempotency.ts";
import { MailboxError } from "../error/mailboxError.ts";
import { requirePermission } from "../authz/authz.ts";
import type { Subject } from "../authz/authz.ts";
import { putObject } from "../database/store/database.ts";
import { notifyCondition } from "../thread/thread.ts";
import type { Receipt } from "../receipt/receipt.ts";

export interface MailboxOptions {
    capacity?: number;
}

/**
 * Process row resolved from a pid.
 */
type ProcessRow = {
    id: string;
};

/**
 * Row returned by the sequence counter query.
 */
type CountRow = {
    n: number;
};

export interface MailboxSendInput {
    toPid: number;
    kind: "request" | "response" | "event" | "signal";
    body: unknown;
    fromPid?: number;
    fromTid?: number;
    correlationId?: string;
    id?: string;
}

export interface MailboxDelivery {
    message: MessageEntity;
    receiptId: string;
}

export const mailboxCondition: (pid: number) => string = (pid: number): string => `mailbox:${pid}`;

export class Mailbox {
    private readonly db: DatabaseSync;
    private readonly messages: MessageService;
    private readonly capacity: number;

    constructor(db: DatabaseSync, messages: MessageService, options: MailboxOptions = {}) {
        this.db = db;
        this.messages = messages;
        this.capacity = options.capacity ?? 64;
    }

    send(subject: Subject, input: MailboxSendInput, at: string): MessageEntity {
        const fromPid: number | undefined = input.fromPid ?? subject.pid;
        if (fromPid === (void 0)) {
            throw new MailboxError("unknown_recipient", ["sender has no pid"]);
        }
        const recipient: ProcessRow | undefined = this.db.prepare("SELECT id FROM processes WHERE pid = ?").get(input.toPid) as ProcessRow | undefined;
        if (recipient === (void 0)) {
            throw new MailboxError("unknown_recipient", [`pid ${input.toPid}`]);
        }
        requirePermission(this.db, subject, "send", { kind: "mailbox", id: `${input.toPid}`, ownerPid: input.toPid }, at);
        if (this.messages.pendingCount(input.toPid) >= this.capacity) {
            throw new MailboxError("mailbox_full", [`pid ${input.toPid} has ${this.capacity} undelivered messages`]);
        }

        const send: () => MessageEntity = (): MessageEntity => {
            const seq: CountRow = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_pid = ?").get(fromPid) as CountRow;
            return this.messages.send({
                id: input.id ?? `m.${fromPid}.${seq.n + 1}`,
                fromPid,
                fromTid: input.fromTid ?? subject.tid ?? 0,
                toPid: input.toPid,
                kind: input.kind,
                body: input.body,
                correlationId: input.correlationId,
                at,
            });
        };

        const message: MessageEntity = input.correlationId === (void 0) ? send() : once(this.db, `msg:${fromPid}:${input.correlationId}`, at, send).value;
        notifyCondition(this.db, mailboxCondition(input.toPid));
        return message;
    }

    receive(subject: Subject, at: string): MailboxDelivery | undefined {
        const pid: number | undefined = subject.pid;
        if (pid === (void 0)) {
            throw new MailboxError("unknown_recipient", ["receiver has no pid"]);
        }
        requirePermission(this.db, subject, "receive", { kind: "mailbox", id: `${pid}`, ownerPid: pid }, at);
        const pending: MessageEntity[] = this.messages.pending(pid, 1);
        const message: MessageEntity | undefined = pending[0];
        if (message === (void 0)) {
            return undefined;
        }

        const recipient: ProcessRow | undefined = this.db.prepare("SELECT id FROM processes WHERE pid = ?").get(pid) as ProcessRow | undefined;
        if (recipient === (void 0)) {
            throw new MailboxError("unknown_recipient", [`pid ${pid}`]);
        }
        const receiptId: string = `rc.msg.${message.msg_id}`;
        const receipt: Receipt = {
            amp: "0.1",
            kind: "receipt",
            id: receiptId,
            op: "read",
            target: { kind: "process", id: recipient.id },
            at,
            usage: { tokens: 0, calls: 0 },
            outcome: "success",
            note: `message ${message.id} delivered`,
        };
        putObject(this.db, "receipt", receipt.id, receipt, at);
        this.messages.markDelivered(message.msg_id, receiptId, at);
        return { message, receiptId };
    }
}
