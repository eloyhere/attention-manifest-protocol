/**
 * AMP v0.1 — settlement objects: receipt | event.
 * Mirrors docs/schemas/receipt.schema.json.
 *
 * Receipts are the only ground truth for calibration; events are the append-only log.
 */
import type { Confidence, Digest, Handle, Id, Ref, Timestamp, Usage } from "../types/common.ts";

export type ReceiptOp = "attend" | "act" | "ask" | "note" | "plan" | "reflect" | "read";
export type Outcome = "success" | "partial" | "failure" | "blocked";

export interface Receipt {
    amp: "0.1";
    kind: "receipt";
    id: Id;
    op: ReceiptOp;
    target?: Ref;
    at: Timestamp;
    ms?: number;
    usage: Usage;
    outcome: Outcome;
    /**
     * Recorded before the action; compared with realized_voi to calibrate the controller.
     */
    predicted_voi?: Confidence;
    realized_voi?: Confidence;
    handle?: Handle;
    note?: string;
}

/**
 * Named AmpEvent to avoid shadowing the DOM `Event`.
 */
export interface AmpEvent {
    amp: "0.1";
    kind: "event";
    id: Id;
    at: Timestamp;
    actor: Ref;
    type: string;
    caused_by?: Id;
    refs?: Ref[];
    digest: Digest;
    payload?: Record<string, unknown>;
}

export type SettlementObject = Receipt | AmpEvent;
