/**
 * Shared vocabulary for the attention-governance layer.
 *
 * The governance layer implements the nine constructs described by the
 * Attention Manifest Protocol: the attention manifest, three-layer context,
 * perspective registry, switch credential, Bayesian control, legal behaviour
 * norms, three-ledger budget, scenario x interaction-mode matrix, and the
 * seven-phase workflow with approvals.
 *
 * This module holds only value types, constants and the shared error. Every
 * other governance module depends on it; it depends on none of them, which
 * keeps the layer acyclic.
 */
import type { Budget, Digest, Id, Ref, Tier, Timestamp } from "../types/common.ts";

export type { Budget, Digest, Id, Ref, Tier, Timestamp } from "../types/common.ts";

/**
 * The five canonical scenarios. They replace the earlier eight-kind mix as the
 * governance label; `src/governance/matrix.ts` keeps an explicit adapter for
 * the legacy kinds so context profiling still works.
 */
export type ScenarioId = "chat" | "writing" | "office" | "research" | "engineering";

export const ScenarioIds: readonly ScenarioId[] = ["chat", "writing", "office", "research", "engineering"];

/**
 * The four interaction modes. `diverge` is the governance name for the
 * existing `inspire` interaction mode; they are bridged, not duplicated.
 */
export type ModeId = "affect" | "think" | "diverge" | "converge";

export const ModeIds: readonly ModeId[] = ["affect", "think", "diverge", "converge"];

/**
 * A normalized weight vector: every entry is in [0, 1] and the sum is 1.
 */
export type ModeWeights = Record<ModeId, number>;

/**
 * The thirteen perspectives of the governance template.
 *
 * Finance, human resources and administration are rule modules or
 * infrastructure, not switchable perspectives; they are still addressable as
 * approving or signing departments.
 */
export type PerspectiveId =
    | "shareholders"
    | "board"
    | "supervisory"
    | "general-manager"
    | "customer-service"
    | "writing"
    | "strategy"
    | "human-resources"
    | "marketing"
    | "technology"
    | "legal"
    | "finance"
    | "administration"
    | "operations";

export const PerspectiveIds: readonly PerspectiveId[] = [
    "shareholders",
    "board",
    "supervisory",
    "general-manager",
    "customer-service",
    "writing",
    "strategy",
    "human-resources",
    "marketing",
    "technology",
    "legal",
    "finance",
    "administration",
    "operations",
];

/**
 * Strategic and management layers are dormant or resident; execution
 * perspectives are activated per task; rule modules are always on.
 */
export type PerspectiveLayer = "strategic" | "management" | "execution" | "rule";

/**
 * How a perspective participates in a scenario (spec section 9.8).
 */
export type Activation = "default" | "on-demand" | "dormant";

/**
 * Attention budget elasticity (spec section 9.6).
 */
export type Elasticity = "low" | "medium" | "high";

/**
 * Escalation trigger sensitivity (spec section 9.7).
 */
export type Sensitivity = "very-low" | "low" | "medium" | "high";

export const SensitivityRank: Record<Sensitivity, number> = { "very-low": 0, low: 1, medium: 2, high: 3 };

/**
 * Legal gate strictness per scenario (spec section 7.3).
 */
export type GateStrictness = "loose" | "medium" | "medium-strict" | "strict";

/**
 * Which ledger a budget binding or charge belongs to (spec section 8).
 * `agent` is a sub-agent's own quota, funded by a transfer from its parent.
 */
export type LedgerScope = "global" | "perspective" | "agent" | "reserve";

/**
 * Governance evidence floors use their own order (F1 strongest) so the
 * description's "T1/T2/T3" never collides with the protocol's T0-T4 strength
 * order. `FloorTier` maps them onto the existing tier system.
 */
export type EvidenceFloor = "F1" | "F2" | "F3";

export const EvidenceFloorIds: readonly EvidenceFloor[] = ["F1", "F2", "F3"];

/**
 * Minimum protocol tier that satisfies each governance floor.
 *
 * The description uses T1 as the strictest floor, while AMP's T0-T4 axis is
 * strictly increasing in strength (T1 sourced, T2 observed, T3 tested). The
 * mapping keeps the description's intent: F1 demands tested evidence, F2
 * observed evidence, F3 sourced evidence.
 */
export const FloorTier: Record<EvidenceFloor, Tier> = {
    F1: "T3",
    F2: "T2",
    F3: "T1",
};

export const TierRank: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };

export const FloorRank: Record<EvidenceFloor, number> = { F1: 0, F2: 1, F3: 2 };

/**
 * Elasticity limits. The specification fixes the high (auto +50%, post audit)
 * and low (freeze beyond +20%) cases; medium is an explicit engineering
 * choice: approval-gated up to +35% and audited afterwards.
 */
export interface ElasticityLimit {
    /**
     * Fraction of the cap that may be appended without an approval.
     */
    autoRatio: number;
    /**
     * Hard ceiling; beyond it the ledger freezes.
     */
    hardRatio: number;
    /**
     * Whether spending between cap and hardRatio needs a finance approval.
     */
    requiresApproval: boolean;
    /**
     * Whether appended spend is settled by a post-hoc audit.
     */
    postAudit: boolean;
}

export const ElasticityLimits: Record<Elasticity, ElasticityLimit> = {
    low: { autoRatio: 0.2, hardRatio: 0.2, requiresApproval: false, postAudit: false },
    medium: { autoRatio: 0, hardRatio: 0.35, requiresApproval: true, postAudit: true },
    high: { autoRatio: 0.5, hardRatio: 0.5, requiresApproval: false, postAudit: true },
};

/**
 * Behaviour constraints injected by the legal department into a manifest or a
 * switch credential (spec section 7.2).
 */
export interface BehaviorConstraints {
    allowed: string[];
    forbidden: string[];
    obligations: string[];
    escalation: string[];
    /**
     * Evidence floor the legal department insists on, possibly stricter than
     * the scenario x mode floor.
     */
    evidence: EvidenceFloor;
}

/**
 * A governance sign-off. It is deliberately not a cryptographic signature:
 * the protocol signs the digest of the object and records which department
 * approved it, so a missing counter-signature is visible in an audit.
 */
export type SignoffRole = "issuer" | "legal" | "finance" | "board" | "human";

export interface Signoff {
    role: SignoffRole;
    by: PerspectiveId;
    at: Timestamp;
    digest: Digest;
}

/**
 * An unsigned sign-off as supplied by a caller; `issue*` fills in the digest
 * after computing it, so a caller cannot accidentally sign the wrong body.
 */
export interface SignerInput {
    role: SignoffRole;
    by: PerspectiveId;
    at: Timestamp;
}

/**
 * A versioned manifest reference, safe to copy between layers.
 */
export interface ManifestRef {
    id: Id;
    version: number;
}

/**
 * An escalation request carried by a receipt or a workflow record.
 */
export interface EscalationRef {
    to: PerspectiveId;
    reason: string;
}

/**
 * A verification result. Codes are stable; detail is for humans.
 */
export interface VerificationVerdict {
    ok: boolean;
    code?: string;
    detail?: string;
}

/**
 * A credential's budget quota and elasticity.
 */
export interface CredentialBudget {
    quota: Budget;
    elasticity: Elasticity;
}

/**
 * Approval subjects from the responsibility table (spec section 10).
 */
export type ApprovalSubject =
    | "budget.initial"
    | "budget.allocation"
    | "budget.freeze"
    | "budget.elasticity"
    | "budget.top-up"
    | "budget.settlement"
    | "budget.reserve"
    | "budget.major-top-up"
    | "credential.issue"
    | "credential.compliance"
    | "manifest.derive"
    | "manifest.constraints"
    | "manifest.evidence-floor"
    | "manifest.focus"
    | "manifest.waiver"
    | "mode.weights"
    | "scenario.judgement"
    | "complexity.grade"
    | "perspective.assignment"
    | "perspective.routing"
    | "perspective.readiness"
    | "escalation.initiate"
    | "escalation.audit"
    | "escalation.strategic"
    | "escalation.final"
    | "strategy.version"
    | "capability.change"
    | "arbitration.major"
    | "audit.evidence"
    | "audit.behavior"
    | "audit.budget"
    | "audit.archive"
    | "requirement.complete"
    | "requirement.change"
    | "requirement.satisfaction"
    | "acceptance.criteria"
    | "goal.change"
    | "liability.attribution"
    | "final.ruling"
    | "tool.high-risk"
    | "board.write"
    | "freeze.appeal";

/**
 * A recorded approval. `granted: false` is a rejection, not an absence.
 */
export interface ApprovalGrant {
    id: Id;
    subject: ApprovalSubject;
    by: PerspectiveId;
    at: Timestamp;
    granted: boolean;
    note?: string;
}

/**
 * Budget arithmetic is per dimension; these are the dimensions a ledger can
 * cap. A missing cap means "not metered on this dimension".
 */
export type BudgetDimension = "tokens" | "ms" | "calls" | "interrupts" | "money";

export const BudgetDimensions: readonly BudgetDimension[] = ["tokens", "ms", "calls", "interrupts", "money"];

export type GovernanceCode =
    | "invalid-scenario"
    | "invalid-mode-weights"
    | "unknown-perspective"
    | "manifest-expired"
    | "manifest-scope"
    | "manifest-unsigned"
    | "manifest-self-signed"
    | "manifest-version-conflict"
    | "manifest-rederive-required"
    | "approval-required"
    | "approval-not-permitted"
    | "approval-self"
    | "credential-incomplete"
    | "credential-invalid"
    | "credential-expired"
    | "credential-not-yet-valid"
    | "credential-tampered"
    | "credential-scope"
    | "credential-target"
    | "credential-revoked"
    | "credential-manifest"
    | "budget-frozen"
        | "budget-invalid"| "budget-frozen"
    | "budget-exhausted"
    | "budget-reserve"
    | "legal-frozen"
    | "legal-breaker"
    | "workflow-phase"
    | "workflow-step"
    | "workflow-artifact"
    | "context-denied"
    | "registry-invalid"
    | "probability-invalid";

/**
 * A fail-closed governance rejection: the caller gets a code, not a silently
 * degraded policy.
 */
export class GovernanceError extends Error {
    readonly code: GovernanceCode;

    constructor(code: GovernanceCode, detail: string) {
        super(`${code}: ${detail}`);
        this.name = "GovernanceError";
        this.code = code;
    }
}

/**
 * Stable key for a Ref so scopes can be compared without object identity.
 */
export const refKey: (ref: Ref) => string = (ref: Ref): string => `${ref.kind}:${ref.id}`;

/**
 * A shallow read-only copy of a Budget with every dimension defaulted to zero.
 */
export const budgetTotals: (budget: Budget) => Required<Budget> = (budget: Budget): Required<Budget> => ({
    tokens: budget.tokens ?? 0,
    ms: budget.ms ?? 0,
    calls: budget.calls ?? 0,
    interrupts: budget.interrupts ?? 0,
    money: budget.money ?? 0,
});

/**
 * Description-only digest used when a caller does not have the full object;
 * never used for integrity checks.
 */
export const auditLine: (parts: readonly string[]) => string = (parts: readonly string[]): string => parts.join(" | ");
