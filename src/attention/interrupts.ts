import type { Budget, Id, Ref, Timestamp } from "../types/common.ts";
import type { Receipt } from "../receipt/receipt.ts";
import type { AttentionRequest, InterruptClass } from "./socialTypes.ts";
import { AttentionBroker, type AttentionDecision, type AttentionPolicy } from "./social.ts";

/**
 * The Attention Ledger's missing object: an `Interrupt`.
 *
 * `AttentionBroker` makes a grant/defer/deny decision, but the decision is not
 * itself an auditable ledger row and deferred requests never expire unless a
 * caller manually resolves them. This wrapper turns each decision into an
 * `Interrupt` record, emits the matching receipt, and sweeps deferred requests
 * whose response window has elapsed.
 *
 * It deliberately does not replace `AttentionBroker`: policy, quiet hours,
 * cooldowns and debt stay in one place.
 */

export type InterruptStatus = "granted" | "deferred" | "denied" | "answered" | "expired" | "withdrawn";

export interface InterruptRecord {
    amp: "0.1";
    kind: "interrupt";
    id: Id;
    request: Id;
    class: InterruptClass;
    target: Ref;
    urgency: number;
    granted: boolean;
    status: InterruptStatus;
    cost: Budget;
    at: Timestamp;
    expires?: Timestamp;
    debt_weight: number;
    reason: string;
    receipt: Id;
}

export interface AttentionLedgerOptions {
    now: () => Timestamp;
    policy?: Partial<AttentionPolicy>;
    /**
     * Response window for a deferred request that carries no `expires`.
     */
    defaultExpiryMs?: number;
    onReceipt?: (receipt: Receipt) => void;
}

export const MaxExternalShare: number = 0.15;

export interface AdmissionVerdict {
    ok: boolean;
    reason?: string;
}

type ExternalAdmissionInput = {
    role: string;
    share: number;
    goalSlot?: boolean;
    maxShare?: number;
};

/**
 * A-4: external content may be present, but it cannot buy its own salience and
 * cannot occupy the goal slot. The numeric share is the proportion of the
 * assembled context attributable to external content.
 */
export const admitExternal: (input: ExternalAdmissionInput) => AdmissionVerdict = (input: ExternalAdmissionInput): AdmissionVerdict => {
    if (input.goalSlot) {
        return { ok: false, reason: "external content cannot occupy the goal slot" };
    }
    if (!Number.isFinite(input.share) || input.share < 0 || input.share > 1) {
        return { ok: false, reason: `invalid external share: ${`${input.share}`}` };
    }
    const limit: number = input.maxShare ?? MaxExternalShare;
    if (!Number.isFinite(limit) || limit < 0 || limit > 1) {
        throw new RangeError("maxShare must be in [0, 1]");
    }
    if (input.share > limit) {
        return { ok: false, reason: `external share ${input.share} exceeds ${limit}` };
    }
    return { ok: true };
};

type TimestampAdder = (at: Timestamp, ms: number) => Timestamp;

const addTimestamps: TimestampAdder = (at: Timestamp, ms: number): Timestamp => new Date(Date.parse(at) + ms).toISOString();

/**
 * Interrupt-producing facade over `AttentionBroker`.
 *
 * Every submitted request produces exactly one `InterruptRecord` and one
 * `Receipt` (op `ask`). Deferred records own debt until resolved or expired;
 * `sweep()` closes the bookkeeping for elapsed windows.
 */
export class AttentionLedger {
    readonly broker: AttentionBroker;
    private readonly now: () => Timestamp;
    private readonly defaultExpiryMs: number;
    private readonly onReceipt?: (receipt: Receipt) => void;
    private readonly records: InterruptRecord[] = [];
    private readonly byRequest = new Map<Id, InterruptRecord>();
    private seq = 0;

    constructor(options: AttentionLedgerOptions) {
        this.now = options.now;
        this.defaultExpiryMs = options.defaultExpiryMs ?? 60_000;
        this.onReceipt = options.onReceipt;
        this.broker = new AttentionBroker({ now: options.now, policy: options.policy });
    }

    submit(request: AttentionRequest): {
        interrupt: InterruptRecord;
        decision: AttentionDecision;
        receipt: Receipt;
    } {
        if (this.byRequest.has(request.id)) {
            throw new Error(`duplicate interrupt request: ${request.id}`);
        }
        const decision: AttentionDecision = this.broker.submit(request);
        const status: InterruptStatus = statusOf(decision);
        this.seq += 1;
        const id: Id = `int.${this.seq}`;
        const expires: Timestamp | undefined = status === "deferred" ? (request.expires ?? addTimestamps(decision.at, this.defaultExpiryMs)) : request.expires;
        const interrupt: InterruptRecord = {
            amp: "0.1",
            kind: "interrupt",
            id,
            request: request.id,
            class: request.class,
            target: request.target,
            urgency: request.urgency,
            granted: status === "granted",
            status,
            cost: request.cost,
            at: decision.at,
            expires,
            debt_weight: request.urgency,
            reason: decision.reason,
            receipt: `rc.ask.${this.seq}`,
        };
        const receipt: Receipt = {
            amp: "0.1",
            kind: "receipt",
            id: interrupt.receipt,
            op: "ask",
            target: request.target,
            at: decision.at,
            usage: { interrupts: status === "granted" ? 1 : 0, ...request.cost },
            outcome: status === "denied" ? "blocked" : status === "deferred" ? "partial" : "success",
            note: `${request.class}:${status}:${decision.reason}`,
        };
        this.records.push(interrupt);
        this.byRequest.set(request.id, interrupt);
        this.onReceipt?.(receipt);
        return { interrupt, decision, receipt };
    }

    /**
     * Resolve a deferred request. Returns the updated record or undefined.
     */
    resolve(requestId: Id, outcome: "answered" | "expired" | "withdrawn" = "answered"): InterruptRecord | undefined {
        const record: InterruptRecord | undefined = this.byRequest.get(requestId);
        if (!record || record.status !== "deferred") {
            return undefined;
        }
        try {
            this.broker.resolve(requestId, outcome);
        } catch {
            /**
             * The broker may already have closed the debt through a prior sweep.
             */
        }
        record.status = outcome;
        return record;
    }

    /**
     * Expire deferred requests whose response window has elapsed.
     * Idempotent: already-resolved/expired records are skipped.
     */
    sweep(at: Timestamp = this.now()): InterruptRecord[] {
        const now: number = Date.parse(at);
        const expired: InterruptRecord[] = [];
        for (let index: number = 0; index < this.records.length; index += 1) {
            const record: InterruptRecord = this.records[index];
            if (record.status !== "deferred" || record.expires === (void 0)) {
                continue;
            }
            if (Date.parse(record.expires) > now) {
                continue;
            }
            this.resolve(record.request, "expired");
            expired.push(record);
        }
        return expired;
    }

    all(): readonly InterruptRecord[] {
        return this.records;
    }

    get(requestId: Id): InterruptRecord | undefined {
        return this.byRequest.get(requestId);
    }

    open(): InterruptRecord[] {
        return this.records.filter((record) => record.status === "deferred");
    }

    grantedCount(): number {
        return this.records.filter((record) => record.status === "granted").length;
    }

    debtScore(at: Timestamp = this.now()): number {
        return this.broker.debtScore(at);
    }
}

const statusOf: (decision: AttentionDecision) => InterruptStatus = (decision: AttentionDecision): InterruptStatus => {
    if (decision.decision === "grant") {
        return "granted";
    }
    if (decision.decision === "defer") {
        return "deferred";
    }
    return "denied";
};
