/**
 * The legal behaviour-norms layer (spec section 7).
 *
 * Legal is not a reviewer at the end of the task: it injects constraints into
 * manifests and credentials, gates tool calls, board writes and escalations,
 * and owns freeze, downgrade and breaker orders. Freeze and breaker orders do
 * not need the general manager's approval, and the general manager can appeal
 * but not revoke them; only the board or a human can lift them.
 *
 * The layer is independent from the supervisory evidence audit: legal checks
 * behaviour compliance, supervisory checks evidence truth.
 */
import type { EffectClass } from "../policy/policy.ts";
import { EffectClasses } from "../policy/policy.ts";
import type { Timestamp, Tier } from "../types/common.ts";
import type { ApprovalGrant, BehaviorConstraints, EvidenceFloor, GateStrictness, PerspectiveId, ScenarioId } from "./types.ts";
import { FloorRank, FloorTier, GovernanceError, TierRank } from "./types.ts";
import { gateStrictnessFor } from "./matrix.ts";

/**
 * Violation severity, ordered from lightest to heaviest.
 */
export type ViolationLevel = "minor" | "moderate" | "severe" | "emergency";

/**
 * The disposition attached to a verdict.
 */
export type LegalAction = "allow" | "warn" | "freeze" | "downgrade" | "breaker";

/**
 * Machine-readable violation reasons.
 */
export type ViolationCode =
    | "behavior-forbidden"
    | "tool-unapproved"
    | "evidence-below-floor"
    | "receipt-incomplete"
    | "board-unapproved"
    | "escalation-unsigned"
    | "credential-self-signed"
    | "credential-missing-signoff"
    | "context-unauthorized"
    | "injection-detected"
    | "unknown-effect"| "injection-detected"
    | "malicious-tool"
    | "repeat-violation";

export interface Violation {
    code: ViolationCode;
    level: ViolationLevel;
    detail: string;
}

/**
 * A behaviour-code row for one scenario (spec 7.2).
 */
export interface BehaviorCode {
    scenario: ScenarioId;
    allowed: string[];
    forbidden: string[];
    obligations: string[];
    escalation: string[];
    evidence: EvidenceFloor;
}

/**
 * Default codes. They are intentionally short: a code list that nobody can
 * read is not a control.
 */
export const DefaultBehaviorCodes: Record<ScenarioId, BehaviorCode> = {
    chat: {
        scenario: "chat",
        allowed: ["respond", "clarify", "validate", "support", "label-uncertainty"],
        forbidden: ["diagnose", "induce-dependency", "fabricate-evidence", "bypass-gate", "self-sign", "exfiltrate"],
        obligations: ["label-uncertainty", "invite-user-agency"],
        escalation: ["self-harm-risk", "acute-crisis", "manipulation-request"],
        evidence: "F3",
    },
    writing: {
        scenario: "writing",
        allowed: ["draft", "revise", "structure", "select-material", "cite"],
        forbidden: ["fabricate-citation", "plagiarize", "bypass-gate", "self-sign", "exfiltrate"],
        obligations: ["cite-sources", "preserve-author-voice", "mark-uncertainty"],
        escalation: ["fabricated-source", "rights-violation"],
        evidence: "F3",
    },
    office: {
        scenario: "office",
        allowed: ["draft", "schedule", "summarize", "route", "record"],
        forbidden: ["send-without-approval", "delete-without-approval", "bypass-gate", "self-sign", "exfiltrate"],
        obligations: ["record-recipients", "respect-data-scope"],
        escalation: ["sensitive-data", "unauthorized-send"],
        evidence: "F2",
    },
    research: {
        scenario: "research",
        allowed: ["search", "read", "compare", "hypothesize", "cite", "record-unknown"],
        forbidden: ["fabricate-evidence", "hide-contradiction", "bypass-gate", "self-sign", "exfiltrate"],
        obligations: ["cite-sources", "record-unknowns", "surface-contradictions"],
        escalation: ["irreproducible-result", "fabricated-source"],
        evidence: "F2",
    },
    engineering: {
        scenario: "engineering",
        allowed: ["read", "patch", "test", "rollback", "deploy-with-approval"],
        forbidden: ["unapproved-write", "disable-audit", "bypass-gate", "self-sign", "exfiltrate"],
        obligations: ["record-rollback", "run-tests", "preserve-audit-trail"],
        escalation: ["irreversible-write", "sensitive-data", "test-bypass"],
        evidence: "F2",
    },
};

/**
 * Scenario-scoped code registry.
 */
export class BehaviorRegistry {
    private readonly codes = new Map<ScenarioId, BehaviorCode>();

    constructor(seed: readonly BehaviorCode[] = Object.values(DefaultBehaviorCodes)) {
        for (let index: number = 0; index < seed.length; index += 1) {
            this.codes.set(seed[index].scenario, seed[index]);
        }
    }

    register(code: BehaviorCode): void {
        this.codes.set(code.scenario, code);
    }

    forScenario(scenario: ScenarioId): BehaviorCode {
        const code: BehaviorCode | undefined = this.codes.get(scenario);
        if (code === (void 0)) {
            throw new GovernanceError("registry-invalid", `no behaviour code for ${scenario}`);
        }
        return code;
    }

    scenarios(): ScenarioId[] {
        return [...this.codes.keys()];
    }
}

/**
 * The stricter of two floors; legal may raise a floor, never lower it.
 */
export const strictestFloor: (left: EvidenceFloor, right: EvidenceFloor) => EvidenceFloor = (left: EvidenceFloor, right: EvidenceFloor): EvidenceFloor =>
    FloorRank[left] <= FloorRank[right] ? left : right;

/**
 * Inject a scenario's behaviour code into a manifest or credential.
 */
type ConstraintsFor = (scenario: ScenarioId, registry?: BehaviorRegistry) => BehaviorConstraints;

export const constraintsFor: ConstraintsFor = (scenario, registry = new BehaviorRegistry()) => {
    const code: BehaviorCode = registry.forScenario(scenario);
    return {
        allowed: [...code.allowed],
        forbidden: [...code.forbidden],
        obligations: [...code.obligations],
        escalation: [...code.escalation],
        evidence: code.evidence,
    };
};

export interface FreezeOrder {
    id: string;
    perspective: PerspectiveId;
    level: ViolationLevel;
    reason: string;
    issuedAt: Timestamp;
    issuedBy: "legal";
    active: boolean;
    liftedAt?: Timestamp;
    liftedBy?: "board" | "human";
}

/**
 * The general manager's appeal. It is recorded and does not suspend the order.
 */
export interface FreezeAppeal {
    orderId: string;
    by: PerspectiveId;
    reason: string;
    at: Timestamp;
}

export interface DowngradeOrder {
    id: string;
    perspective: PerspectiveId;
    to: "restricted";
    reason: string;
    at: Timestamp;
    escalatedTo: "board";
}

export interface BreakerState {
    active: boolean;
    reason: string;
    at: Timestamp;
    resetAt?: Timestamp;
    resetBy?: "board" | "human";
}

export interface LegalVerdict {
    ok: boolean;
    action: LegalAction;
    violations: Violation[];
    applied: {
        freeze?: FreezeOrder;
        downgrade?: DowngradeOrder;
        breaker?: BreakerState;
    };
}

export interface ToolCheckInput {
    perspective: PerspectiveId;
    scenario: ScenarioId;
    action: string;
    effect: EffectClass;
    evidenceTier?: Tier;
    evidenceFloor?: EvidenceFloor;
    approval?: ApprovalGrant;
}

export interface BoardWriteInput {
    perspective: PerspectiveId;
    scenario: ScenarioId;
    missing: string[];
    globalCore: boolean;
    approval?: ApprovalGrant;
}

export interface EscalationCheckInput {
    perspective: PerspectiveId;
    scenario: ScenarioId;
    evidenceRefs: number;
    target: PerspectiveId;
    credentialSigned: boolean;
}

export interface ReceiptCheckInput {
    perspective: PerspectiveId;
    scenario: ScenarioId;
    missing: string[];
}

export interface CredentialCheckInput {
    from: PerspectiveId;
    to: PerspectiveId;
    signoffs: string[];
    selfSigned: boolean;
}

export interface LegalGateOptions {
    now: () => Timestamp;
    registry?: BehaviorRegistry;
}

const HighRiskEffects: ReadonlySet<EffectClass> = new Set<EffectClass>(["write-irreversible", "spend", "send", "delete", "deploy", "permission", "publish"]);

const ActionForLevel: Record<ViolationLevel, LegalAction> = {
    minor: "warn",
    moderate: "freeze",
    severe: "downgrade",
    emergency: "breaker",
};

const Severities: ViolationLevel[] = ["minor", "moderate", "severe", "emergency"];

/**
 * The gate itself. `check*` methods are pure; `enforce*` methods apply orders.
 */
export class LegalGate {
    private readonly now: () => Timestamp;
    private readonly registry: BehaviorRegistry;
    private readonly orders: FreezeOrder[] = [];
    private readonly appeals: FreezeAppeal[] = [];
    private readonly downgrades: DowngradeOrder[] = [];
    private readonly violations: Violation[] = [];
    private readonly counters = new Map<PerspectiveId, number>();
    private breaker: BreakerState | undefined;
    private counter = 0;

    constructor(options: LegalGateOptions) {
        if (typeof(options.now) !== "function") {
            throw new TypeError("LegalGate requires a clock");
        }
        this.now = options.now;
        this.registry = options.registry ?? new BehaviorRegistry();
    }

    /**
     * Strictness per scenario (spec 7.3).
     */
    strictness(scenario: ScenarioId): GateStrictness {
        return gateStrictnessFor(scenario);
    }

    checkTool(input: ToolCheckInput): LegalVerdict {
        const violations: Violation[] = [];
        const code: BehaviorCode = this.registry.forScenario(input.scenario);
        if (!EffectClasses.includes(input.effect)) {
            violations.push({ code: "unknown-effect", level: "moderate", detail: `${`${input.effect}`} is not an effect class` });
        }
        if (code.forbidden.includes(input.action)) {
            violations.push({ code: "behavior-forbidden", level: "severe", detail: `${input.action} is forbidden in ${input.scenario}` });
        }
        if (HighRiskEffects.has(input.effect) && !this.approved(input.approval, "tool.high-risk", "legal")) {
            violations.push({ code: "tool-unapproved", level: "moderate", detail: `${input.effect} needs a legal tool.high-risk approval` });
        }
        if (input.evidenceTier !== (void 0) && input.evidenceFloor !== (void 0)) {
            if (TierRank[input.evidenceTier] < TierRank[FloorTier[input.evidenceFloor]]) {
                const level: ViolationLevel = this.strictness(input.scenario) === "strict" ? "moderate" : "minor";
                violations.push({
                    code: "evidence-below-floor",
                    level,
                    detail: `${input.evidenceTier} is below the ${input.evidenceFloor} floor (needs ${FloorTier[input.evidenceFloor]})`,
                });
            }
        }
        return this.verdict("allow", violations);
    }

    checkBoardWrite(input: BoardWriteInput): LegalVerdict {
        const violations: Violation[] = [];
        if (input.missing.length > 0) {
            violations.push({ code: "receipt-incomplete", level: "minor", detail: `missing fields: ${input.missing.join(", ")}` });
        }
        if (input.globalCore && !this.approved(input.approval, "board.write", "board")) {
            violations.push({ code: "board-unapproved", level: "severe", detail: "writing the global core needs a board approval" });
        }
        return this.verdict("allow", violations);
    }

    checkEscalation(input: EscalationCheckInput): LegalVerdict {
        const violations: Violation[] = [];
        if (input.evidenceRefs <= 0) {
            violations.push({ code: "escalation-unsigned", level: "moderate", detail: "an escalation must cite at least one evidence reference" });
        }
        if (!input.credentialSigned && input.target !== "general-manager" && input.target !== "legal") {
            violations.push({ code: "escalation-unsigned", level: "moderate", detail: "an escalation target needs a signed credential" });
        }
        return this.verdict("allow", violations);
    }

    checkReceipt(input: ReceiptCheckInput): LegalVerdict {
        const violations: Violation[] = [];
        if (input.missing.length > 0) {
            violations.push({ code: "receipt-incomplete", level: "minor", detail: `receipt missing: ${input.missing.join(", ")}` });
        }
        return this.verdict("allow", violations);
    }

    checkCredential(input: CredentialCheckInput): LegalVerdict {
        const violations: Violation[] = [];
        if (input.selfSigned) {
            violations.push({ code: "credential-self-signed", level: "moderate", detail: `${input.from} signed its own credential` });
        }
        const required: string[] = ["issuer", "legal", "finance"];
        for (let index: number = 0; index < required.length; index += 1) {
            if (!input.signoffs.includes(required[index])) {
                violations.push({ code: "credential-missing-signoff", level: "moderate", detail: `missing ${required[index]} sign-off` });
            }
        }
        return this.verdict("allow", violations);
    }

    /**
     * Tool checkpoint: check and, when needed, freeze or trip the breaker.
     */
    enforceTool(input: ToolCheckInput): LegalVerdict {
        return this.enforce(input.perspective, this.checkTool(input));
    }

    enforceBoardWrite(input: BoardWriteInput): LegalVerdict {
        return this.enforce(input.perspective, this.checkBoardWrite(input));
    }

    enforceEscalation(input: EscalationCheckInput): LegalVerdict {
        return this.enforce(input.perspective, this.checkEscalation(input));
    }

    enforceReceipt(input: ReceiptCheckInput): LegalVerdict {
        return this.enforce(input.perspective, this.checkReceipt(input));
    }

    enforceCredential(input: CredentialCheckInput): LegalVerdict {
        return this.enforce(input.from, this.checkCredential(input));
    }

    /**
     * Report an out-of-band signal (injection traces, malicious tool return).
     */
    reportEmergency(perspective: PerspectiveId, detail: string, code: ViolationCode): LegalVerdict {
        const violation: Violation = { code, level: "emergency", detail };
        return this.enforce(perspective, this.verdict("allow", [violation]));
    }

    /**
     * Moderation counter; three moderate findings escalate to severe
     * (spec 7.2: repeated boundary crossing).
     */
    private enforce(perspective: PerspectiveId, verdict: LegalVerdict): LegalVerdict {
        const appraisals: LegalVerdict = this.record(perspective, verdict);
        if (appraisals.violations.length === 0) {
            return appraisals;
        }
        let worst: ViolationLevel = "minor";
        for (let index: number = 0; index < appraisals.violations.length; index += 1) {
            const level: ViolationLevel = appraisals.violations[index].level;
            if (Severities.indexOf(level) > Severities.indexOf(worst)) {
                worst = level;
            }
        }
        const action: LegalAction = ActionForLevel[worst];
        const applied: LegalVerdict["applied"] = {};
        if (worst === "moderate" || worst === "severe" || worst === "emergency") {
            applied.freeze = this.freezeInternal(perspective, worst, appraisals.violations.map((violation: Violation) => violation.detail).join("; "));
        }
        if (worst === "severe" || worst === "emergency") {
            applied.downgrade = this.downgradeInternal(perspective, worst, "repeated or severe boundary crossing");
        }
        if (worst === "emergency") {
            this.breaker = { active: true, reason: appraisals.violations.map((violation: Violation) => violation.detail).join("; "), at: this.now() };
            applied.breaker = { ...this.breaker };
        }
        return { ...appraisals, ok: false, action, applied };
    }

    private record(perspective: PerspectiveId, verdict: LegalVerdict): LegalVerdict {
        const violations: Violation[] = [...verdict.violations];
        for (let index: number = 0; index < violations.length; index += 1) {
            const violation: Violation = violations[index];
            this.violations.push(violation);
            if (violation.level === "moderate" || violation.level === "severe") {
                const next: number = (this.counters.get(perspective) ?? 0) + 1;
                this.counters.set(perspective, next);
                if (next >= 3 && violation.level === "moderate") {
                    violations[index] = { ...violation, level: "severe", detail: `${violation.detail} (repeated boundary crossing)` };
                    violations.push({ code: "repeat-violation", level: "severe", detail: `${perspective} crossed a boundary ${next} times` });
                }
            }
        }
        return { ok: violations.length === 0, action: violations.length === 0 ? "allow" : "warn", violations, applied: {} };
    }

    private freezeInternal(perspective: PerspectiveId, level: ViolationLevel, reason: string): FreezeOrder {
        const active: FreezeOrder | undefined = this.orders.find((order: FreezeOrder) => order.perspective === perspective && order.active);
        if (active !== (void 0)) {
            return active;
        }
        this.counter += 1;
        const order: FreezeOrder = {
            id: `frz.${this.counter}`,
            perspective,
            level,
            reason,
            issuedAt: this.now(),
            issuedBy: "legal",
            active: true,
        };
        this.orders.push(order);
        return order;
    }

    private downgradeInternal(perspective: PerspectiveId, level: ViolationLevel, reason: string): DowngradeOrder {
        this.counter += 1;
        const order: DowngradeOrder = {
            id: `dwn.${this.counter}`,
            perspective,
            to: "restricted",
            reason: `${level}: ${reason}`,
            at: this.now(),
            escalatedTo: "board",
        };
        this.downgrades.push(order);
        return order;
    }

    /**
     * The general manager may appeal, never revoke.
     */
    appeal(orderId: string, by: PerspectiveId, reason: string): FreezeAppeal {
        if (by !== "general-manager") {
            throw new GovernanceError("approval-not-permitted", "only the general manager may appeal a freeze");
        }
        const order: FreezeOrder | undefined = this.orders.find((entry: FreezeOrder) => entry.id === orderId);
        if (order === (void 0)) {
            throw new GovernanceError("legal-frozen", `unknown freeze order ${orderId}`);
        }
        const appeal: FreezeAppeal = { orderId, by, reason, at: this.now() };
        this.appeals.push(appeal);
        return appeal;
    }

    /**
     * Only the board or a human can lift a freeze.
     */
    lift(orderId: string, by: "board" | "human"): FreezeOrder {
        if (by !== "board" && by !== "human") {
            throw new GovernanceError("approval-not-permitted", "only the board or a human can lift a freeze");
        }
        const order: FreezeOrder | undefined = this.orders.find((entry: FreezeOrder) => entry.id === orderId);
        if (order === (void 0)) {
            throw new GovernanceError("legal-frozen", `unknown freeze order ${orderId}`);
        }
        order.active = false;
        order.liftedAt = this.now();
        order.liftedBy = by;
        return { ...order };
    }

    isFrozen(perspective: PerspectiveId): boolean {
        return this.orders.some((order: FreezeOrder) => order.perspective === perspective && order.active);
    }

    activeFreezes(): FreezeOrder[] {
        return this.orders.filter((order: FreezeOrder) => order.active).map((order: FreezeOrder) => ({ ...order }));
    }

    /**
     * Trip the global breaker. Only the board or a human can reset it.
     */
    tripBreaker(reason: string): BreakerState {
        if (this.breaker !== (void 0) && this.breaker.active) {
            return { ...this.breaker };
        }
        this.breaker = { active: true, reason, at: this.now() };
        return { ...this.breaker };
    }

    resetBreaker(by: "board" | "human"): BreakerState {
        if (by !== "board" && by !== "human") {
            throw new GovernanceError("approval-not-permitted", "only the board or a human can reset the breaker");
        }
        if (this.breaker === (void 0)) {
            throw new GovernanceError("legal-breaker", "the breaker is not tripped");
        }
        this.breaker = { active: false, reason: this.breaker.reason, at: this.breaker.at, resetAt: this.now(), resetBy: by };
        return { ...this.breaker };
    }

    breakerState(): BreakerState | undefined {
        return this.breaker === (void 0) ? undefined : { ...this.breaker };
    }

    isBlocked(): boolean {
        return this.breaker !== (void 0) && this.breaker.active;
    }

    appealsFor(orderId: string): FreezeAppeal[] {
        return this.appeals.filter((appeal: FreezeAppeal) => appeal.orderId === orderId);
    }

    downgradesFor(perspective: PerspectiveId): DowngradeOrder[] {
        return this.downgrades.filter((order: DowngradeOrder) => order.perspective === perspective);
    }

    auditTrail(): { orders: FreezeOrder[]; appeals: FreezeAppeal[]; downgrades: DowngradeOrder[]; violations: Violation[]; } {
        return {
            orders: this.orders.map((order: FreezeOrder) => ({ ...order })),
            appeals: this.appeals.map((appeal: FreezeAppeal) => ({ ...appeal })),
            downgrades: this.downgrades.map((order: DowngradeOrder) => ({ ...order })),
            violations: this.violations.map((violation: Violation) => ({ ...violation })),
        };
    }

    private approved(approval: ApprovalGrant | undefined, subject: string, by: PerspectiveId): boolean {
        return approval !== (void 0) && approval.granted === true && approval.subject === subject && approval.by === by;
    }

    private verdict(action: LegalAction, violations: Violation[]): LegalVerdict {
        return { ok: violations.length === 0, action: violations.length === 0 ? action : "warn", violations, applied: {} };
    }
}
