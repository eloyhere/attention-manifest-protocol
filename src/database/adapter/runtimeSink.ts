import type { DatabaseSync } from "node:sqlite";

import type { StepEvent, StepEventSink } from "../../kernel/index.ts";
import { redactSecrets } from "../../module/tool/redact.ts";
import type { ReceiptSink, RuntimeReceipt } from "../../runtime/cognitiveRuntime.ts";
import { OutboxRepository } from "../repository/outboxRepository.ts";
import { RuntimeApprovalRepository } from "../repository/runtimeApprovalRepository.ts";

/**
 * Transactional kernel event sink: `StepOutcome.events` are written by the
 * outbox repository inside the kernel commit transaction.
 */
export const outboxEventSink: StepEventSink = (db: DatabaseSync, event: StepEvent, at: string): void => {
    let payload = event.payload;
    if (event.topic === "runtime.approval") {
        const raw = event.payload as {
            pid?: number;
            turnId?: string;
            operationId?: string;
            tool?: string;
            risk?: string;
            decision?: string;
            status?: string;
        };
        payload = {
            ...raw,
            tool: redactSecrets(raw.tool ?? "").text,
            decision: redactSecrets(raw.decision ?? "").text,
        };
    }
    new OutboxRepository(db).write(event.topic, payload, at);
    if (event.topic === "runtime.approval") {
        const safe = payload as {
            pid?: number;
            turnId?: string;
            operationId?: string;
            tool?: string;
            risk?: string;
            decision?: string;
            status?: string;
        };
        if (safe.pid !== (void 0) && safe.turnId !== (void 0) && safe.operationId !== (void 0)) {
            new RuntimeApprovalRepository(db).record({
                pid: safe.pid,
                turnId: safe.turnId,
                operationId: safe.operationId,
                tool: safe.tool ?? "",
                risk: safe.risk ?? "",
                decision: safe.decision ?? "",
                status: safe.status ?? "",
                at,
            });
        }
    }
};

/**
 * Persistent runtime receipt sink backed by the transactional outbox.
 * A dispatcher can later consume `runtime.receipt` rows.
 *
 * Prefer `outboxEventSink` + `KernelRuntime` when the receipt must be atomic
 * with the task commit; this standalone sink is for non-kernel turns.
 */
export class OutboxRuntimeReceiptSink implements ReceiptSink {
    private readonly outbox: OutboxRepository;

    constructor(outbox: OutboxRepository) {
        this.outbox = outbox;
    }

    write(receipt: RuntimeReceipt): void {
        this.outbox.write("runtime.receipt", receipt, receipt.at);
    }
}
