/**
 * The governance audit chain.
 *
 * Every governance act that changes authority or spends budget leaves a
 * record: manifest issue/revision, credential issue/revocation, receipt write,
 * charge/transfer, legal order, workflow transition and a settled turn. The
 * chain is append-only and hash-linked, so deleting, reordering or editing an
 * entry is detectable.
 *
 * The log is deliberately generic: the caller chooses the category and the
 * small payload. Full bodies never enter the audit; ids, digests, codes and
 * amounts are enough to reconstruct authority.
 */
import type { Digest, Timestamp } from "../types/common.ts";
import { AppendLog, MemoryAppendSink } from "../storage/appendLog.ts";
import type { AppendSink, LogEntry } from "../storage/appendLog.ts";
import { GovernanceError } from "./types.ts";
import { digestOf } from "../semantic/canonical.ts";
import type { AttentionManifest } from "./attentionManifest.ts";
import type { ChargeResult } from "./budget.ts";
import type { BoardReceipt } from "./context.ts";
import type { SwitchCredential } from "./credential.ts";
import type { LegalVerdict } from "./legal.ts";
import type { WorkflowState } from "./workflow.ts";

export type GovernanceAuditCategory = "manifest" | "credential" | "receipt" | "budget" | "legal" | "workflow" | "switch" | "cooperation" | "control" | "runtime";

export interface GovernanceAuditRecord {
    category: GovernanceAuditCategory;
    /**
     * Stable action name, e.g. `manifest.issued`, `budget.charged`.
     */
    action: string;
    /**
     * Perspective, agent id, or `human`.
     */
    actor: string;
    subject?: string;
    detail: string;
    refs?: string[];
    data?: Record<string, unknown>;
}

export interface GovernanceAuditEntry {
    seq: number;
    at?: Timestamp;
    record: GovernanceAuditRecord;
    prev: Digest;
    digest: Digest;
}

export interface GovernanceAuditOptions {
    sink?: AppendSink;
    now?: () => Timestamp;
}

export interface GovernanceAuditCheckpoint {
    count: number;
    tip: Digest;
    at: Timestamp;
    digest: Digest;
}

export interface GovernanceAuditVerdict {
    ok: boolean;
    reasons: string[];
}

const MaxRefs: number = 32;

const Categories: ReadonlySet<string> = new Set<string>([
    "manifest",
    "credential",
    "receipt",
    "budget",
    "legal",
    "workflow",
    "switch",
    "cooperation",
    "control",
    "runtime",
]);

const isRecord: (value: unknown) => value is Record<string, unknown> = (value: unknown): value is Record<string, unknown> =>
    typeof(value) === "object" && value !== null && !Array.isArray(value);

const validateRecord: (value: unknown) => string[] = (value: unknown): string[] => {
    const problems: string[] = [];
    if (!isRecord(value)) {
        return ["audit payload is not an object"];
    }
    if (typeof(value.category) !== "string" || !Categories.has(value.category)) {
        problems.push("audit category is invalid");
    }
    if (typeof(value.action) !== "string" || value.action.length === 0) {
        problems.push("audit action is empty");
    }
    if (typeof(value.actor) !== "string" || value.actor.length === 0) {
        problems.push("audit actor is empty");
    }
    if (typeof(value.detail) !== "string" || value.detail.length === 0) {
        problems.push("audit detail is empty");
    }
    if (value.refs !== (void 0) && (!Array.isArray(value.refs) || value.refs.some((ref) => typeof(ref) !== "string"))) {
        problems.push("audit refs must be strings");
    }
    if (Array.isArray(value.refs) && value.refs.length > MaxRefs) {
        problems.push(`audit refs exceed ${MaxRefs}`);
    }
    if (value.data !== (void 0) && !isRecord(value.data)) {
        problems.push("audit data must be an object");
    }
    return problems;
};

export class GovernanceAuditLog {
    private readonly log: AppendLog;
    private readonly now: () => Timestamp;

    private constructor(log: AppendLog, now: () => Timestamp) {
        this.log = log;
        this.now = now;
    }

    static async open(options: GovernanceAuditOptions = {}): Promise<GovernanceAuditLog> {
        const sink: AppendSink = options.sink ?? new MemoryAppendSink();
        const log: AppendLog = await AppendLog.open(sink);
        return new GovernanceAuditLog(log, options.now ?? (() => new Date().toISOString()));
    }

    get count(): number {
        return this.log.count;
    }

    tip(): Digest {
        return this.log.tip;
    }

    /**
     * Append one record. The record is validated before it reaches the chain;
     * an invalid record is a caller bug, not a policy denial.
     */
    async record(record: GovernanceAuditRecord): Promise<GovernanceAuditEntry> {
        const problems: string[] = validateRecord(record);
        if (problems.length > 0) {
            throw new GovernanceError("registry-invalid", `invalid audit record: ${problems.join("; ")}`);
        }
        const payload: GovernanceAuditRecord = {
            category: record.category,
            action: record.action,
            actor: record.actor,
            detail: record.detail,
            ...(record.subject === (void 0) ? {} : { subject: record.subject }),
            ...(record.refs === (void 0) ? {} : { refs: [...record.refs] }),
            ...(record.data === (void 0) ? {} : { data: { ...record.data } }),
        };
        const entry: LogEntry = await this.log.append("event", payload, { at: this.now() });
        return {
            seq: entry.seq,
            ...(entry.at === (void 0) ? {} : { at: entry.at }),
            record: entry.payload as GovernanceAuditRecord,
            prev: entry.prev,
            digest: entry.hash,
        };
    }

    /**
     * Defensive copies. Callers cannot mutate the chain through this view.
     */
    entries(): GovernanceAuditEntry[] {
        return this.log.entries().map((entry) => ({
            seq: entry.seq,
            ...(entry.at === (void 0) ? {} : { at: entry.at }),
            record: JSON.parse(JSON.stringify(entry.payload)) as GovernanceAuditRecord,
            prev: entry.prev,
            digest: entry.hash,
        }));
    }

    /**
     * Chain and payload verification. A mutation after append makes this fail.
     */
    verify(): GovernanceAuditVerdict {
        const chain: { ok: boolean; reasons: string[]; } = this.log.verify();
        const reasons: string[] = [...chain.reasons];
        const entries: readonly LogEntry[] = this.log.entries();
        for (let index: number = 0; index < entries.length; index += 1) {
            const problems: string[] = validateRecord(entries[index].payload);
            for (let problem: number = 0; problem < problems.length; problem += 1) {
                reasons.push(`entry ${index}: ${problems[problem]}`);
            }
        }
        return { ok: reasons.length === 0, reasons };
    }

    /**
     * Seal the current tip. A checkpoint lets a retained segment be verified
     * without replaying entries older than `count`.
     */
    checkpoint(at: Timestamp = this.now()): GovernanceAuditCheckpoint {
        const tip: Digest = this.log.tip;
        const count: number = this.log.count;
        return { count, tip, at, digest: digestOf({ count, tip, at }) };
    }

    /**
     * A checkpoint is valid when its digest is intact, its count is not ahead
     * of the chain, and the entry at that position has the recorded tip.
     */
    verifyCheckpoint(checkpoint: GovernanceAuditCheckpoint): GovernanceAuditVerdict {
        const reasons: string[] = [];
        if (checkpoint.digest !== digestOf({ count: checkpoint.count, tip: checkpoint.tip, at: checkpoint.at })) {
            reasons.push("checkpoint digest does not verify");
        }
        if (!Number.isInteger(checkpoint.count) || checkpoint.count < 0 || checkpoint.count > this.log.count) {
            reasons.push("checkpoint count is outside the chain");
        }
        if (checkpoint.count > 0 && checkpoint.count <= this.log.count) {
            const entries: readonly LogEntry[] = this.log.entries();
            if (entries[checkpoint.count - 1].hash !== checkpoint.tip) {
                reasons.push("checkpoint tip does not match the chain");
            }
        }
        return { ok: reasons.length === 0, reasons };
    }

    entriesAfter(seq: number): GovernanceAuditEntry[] {
        return this.entries().filter((entry) => entry.seq >= seq);
    }

    byCategory(category: GovernanceAuditCategory): GovernanceAuditEntry[] {
        return this.entries().filter((entry) => entry.record.category === category);
    }

    bySubject(subject: string): GovernanceAuditEntry[] {
        return this.entries().filter((entry) => entry.record.subject === subject);
    }

    async recordManifest(manifest: AttentionManifest, actor: string): Promise<GovernanceAuditEntry> {
        return this.record({
            category: "manifest",
            action: manifest.version === 1 ? "manifest.issued" : "manifest.revised",
            actor,
            subject: manifest.id,
            detail: `v${manifest.version} ${manifest.scenario} floor=${manifest.evidenceFloor}`,
            refs: [manifest.digest],
            data: {
                id: manifest.id,
                version: manifest.version,
                scenario: manifest.scenario,
                floor: manifest.evidenceFloor,
                expires: manifest.expires,
            },
        });
    }

    async recordCredential(credential: SwitchCredential, action: "issued" | "revoked" = "issued"): Promise<GovernanceAuditEntry> {
        return this.record({
            category: "credential",
            action: `credential.${action}`,
            actor: "general-manager",
            subject: credential.id,
            detail: `${credential.from}->${credential.to} until ${credential.expires}`,
            refs: [credential.digest, credential.manifest.id],
            data: { id: credential.id, to: credential.to, manifest: credential.manifest, expires: credential.expires },
        });
    }

    async recordReceipt(receipt: BoardReceipt): Promise<GovernanceAuditEntry> {
        return this.record({
            category: "receipt",
            action: "receipt.written",
            actor: receipt.from,
            subject: receipt.id,
            detail: `confidence=${receipt.confidence.toFixed(2)}`,
            refs: [receipt.digest, `${receipt.manifest.id}@${receipt.manifest.version}`],
            data: { id: receipt.id, manifest: receipt.manifest, evidence: receipt.evidence.length },
        });
    }

    async recordCharge(charge: ChargeResult, ledgerId: string, actor: string): Promise<GovernanceAuditEntry> {
        return this.record({
            category: "budget",
            action: `budget.${charge.code}`,
            actor,
            subject: ledgerId,
            detail: `ratio=${charge.ratio.toFixed(2)}`,
            data: { code: charge.code, ratio: charge.ratio, used: charge.ledger.used, cap: charge.ledger.cap },
        });
    }

    async recordLegal(verdict: LegalVerdict, actor: string): Promise<GovernanceAuditEntry> {
        return this.record({
            category: "legal",
            action: `legal.${verdict.action}`,
            actor,
            subject: verdict.applied.freeze?.id ?? verdict.applied.downgrade?.id ?? "legal-gate",
            detail: verdict.violations.map((violation) => violation.code).join(", ") || "no violation",
            data: {
                action: verdict.action,
                violations: verdict.violations.length,
                freeze: verdict.applied.freeze?.id ?? null,
                breaker: verdict.applied.breaker?.active ?? false,
            },
        });
    }

    async recordWorkflow(state: WorkflowState, actor: string): Promise<GovernanceAuditEntry> {
        return this.record({
            category: "workflow",
            action: `workflow.${state.status}`,
            actor,
            subject: state.id,
            detail: `phase=${state.phase} steps=${state.completedSteps.length}`,
            data: { id: state.id, phase: state.phase, status: state.status, approvals: state.approvals.length },
        });
    }

    async recordSwitch(credential: SwitchCredential, action: "peer" | "downgrade" | "escalation", actor: string): Promise<GovernanceAuditEntry> {
        return this.record({
            category: "switch",
            action: `switch.${action}`,
            actor,
            subject: credential.id,
            detail: `${credential.from}->${credential.to}`,
            refs: [credential.digest],
            data: { to: credential.to, scenario: credential.scenario, manifest: credential.manifest },
        });
    }

    /**
     * One settled runtime turn: the manifest version, tokens, charge code,
     * control decision and receipt id. Legal violation codes are appended when
     * a tool call was gated.
     */
    async recordTurn(input: {
        turnId: string;
        perspective: string;
        manifest: { id: string; version: number; digest: string; };
        tokens: number;
        charge: ChargeResult;
        control: { action: string; stop: boolean; escalate: boolean; approvalRequired: boolean; };
        receiptId?: string;
        legalCodes?: string[];
    }): Promise<GovernanceAuditEntry> {
        return this.record({
            category: "runtime",
            action: "runtime.turn",
            actor: input.perspective,
            subject: input.turnId,
            detail: `tokens=${input.tokens} charge=${input.charge.code} control=${input.control.action}`,
            refs: [input.manifest.id, input.manifest.digest, ...(input.receiptId === (void 0) ? [] : [input.receiptId])],
            data: {
                manifest: { id: input.manifest.id, version: input.manifest.version },
                tokens: input.tokens,
                charge: input.charge.code,
                control: input.control,
                ...(input.legalCodes === (void 0) ? {} : { legal: input.legalCodes }),
            },
        });
    }
}
