/**
 * Perspective and mode switching orchestration (spec section 12).
 *
 * The primitives already exist: credentials, manifests, context layers and the
 * budget. This module sequences them into the flows the description names:
 * peer switch, downgrade, mode switch and scenario switch. It also builds the
 * escalation plan, including the independent strategic context that must not
 * inherit the execution reasoning chain.
 */
import type { Budget, Ref, Timestamp } from "../types/common.ts";
import type {
    ApprovalGrant,
    BehaviorConstraints,
    Elasticity,
    EvidenceFloor,
    ModeWeights,
    PerspectiveId,
    ScenarioId,
    SignerInput,
    VerificationVerdict,
} from "./types.ts";
import { GovernanceError } from "./types.ts";
import type { AttentionManifest } from "./attentionManifest.ts";
import { loadAttentionManifest, rederiveAttentionManifest, verifyAttentionManifest } from "./attentionManifest.ts";
import type { BudgetBinding, RederivePatch } from "./attentionManifest.ts";
import type { CredentialVerdict, SwitchCredential } from "./credential.ts";
import { issueCredential, verifyCredential } from "./credential.ts";
import { canApprove, escalationTarget, perspective, requiresEscalation } from "./perspectives.ts";
import { driftRequiresApproval, normalizeModeWeights, resolveScenarioModes } from "./matrix.ts";
import type { ScenarioModePlan } from "./matrix.ts";
import { updateAttentionManifest } from "./attentionManifest.ts";
import type { ManifestPatch } from "./attentionManifest.ts";

/**
 * The three-party approval set for a switch. HR, legal and finance each own one
 * subject; the general manager issues.
 */
export interface SwitchApprovals {
    generalManager: ApprovalGrant;
    legal: ApprovalGrant;
    finance: ApprovalGrant;
    humanResources: ApprovalGrant;
}

export interface PeerSwitchInput {
    /**
     * The perspective that asked for the switch.
     */
    requester: PerspectiveId;
    to: PerspectiveId;
    reason: string;
    scenario: ScenarioId;
    modes?: Partial<ModeWeights>;
    targetManifest: AttentionManifest;
    visibleScope: Ref[];
    payloadRefs?: Ref[];
    quota: Budget;
    elasticity: Elasticity;
    constraints: BehaviorConstraints;
    issuedAt: Timestamp;
    ttlMs?: number;
    at: Timestamp;
    approvals: SwitchApprovals;
    signers: readonly SignerInput[];
}

export interface PeerSwitchResult {
    credential: SwitchCredential;
    verdict: CredentialVerdict;
    target: AttentionManifest;
    steps: string[];
}

type SlotCode = "credential-invalid" | "approval-not-permitted";

type RequireSlot = (approval: ApprovalGrant, subject: string, department: PerspectiveId, requester: PerspectiveId, code: SlotCode) => void;

const requireSlot: RequireSlot = (approval, subject, department, requester, code) => {
    if (approval.granted !== true) {
        throw new GovernanceError(code, `${subject} was not granted`);
    }
    if (approval.subject !== subject) {
        throw new GovernanceError(code, `${subject} approval carries subject ${approval.subject}`);
    }
    if (approval.by !== department || !canApprove(department, approval.subject)) {
        throw new GovernanceError(code, `${subject} must be approved by ${department}`);
    }
    if (approval.by === requester) {
        throw new GovernanceError("approval-self", `${requester} cannot approve its own switch`);
    }
};

/**
 * Peer switch: HR confirms the target, legal clears the scope, finance freezes
 * the quota, the general manager issues the credential, and the target loads
 * its own manifest after the credential verifies.
 */
export const planPeerSwitch: (input: PeerSwitchInput) => PeerSwitchResult = (input: PeerSwitchInput): PeerSwitchResult => {
    const steps: string[] = [];
    if (input.requester === input.to) {
        throw new GovernanceError("credential-target", "a perspective cannot switch to itself");
    }
    if (perspective(input.to).layer !== "execution" || requiresEscalation(input.to)) {
        throw new GovernanceError("credential-target", `${input.to} is not a same-level execution target`);
    }
    if (input.targetManifest.perspective !== input.to) {
        throw new GovernanceError("credential-target", `manifest belongs to ${input.targetManifest.perspective}, not ${input.to}`);
    }
    if (input.targetManifest.scenario !== input.scenario) {
        throw new GovernanceError("manifest-scope", `target manifest scenario is ${input.targetManifest.scenario}`);
    }
    requireSlot(input.approvals.humanResources, "perspective.assignment", "human-resources", input.requester, "credential-invalid");
    steps.push("human-resources confirms the target perspective");
    requireSlot(input.approvals.legal, "credential.compliance", "legal", input.requester, "credential-invalid");
    steps.push("legal clears the credential scope");
    requireSlot(input.approvals.finance, "budget.elasticity", "finance", input.requester, "credential-invalid");
    steps.push("finance freezes the quota and elasticity");
    requireSlot(input.approvals.generalManager, "credential.issue", "general-manager", input.requester, "credential-invalid");
    steps.push("general manager issues the credential");
    const targetVerdict: VerificationVerdict = verifyAttentionManifest(input.targetManifest, input.at);
    if (!targetVerdict.ok) {
        throw new GovernanceError("manifest-unsigned", targetVerdict.detail ?? "target manifest is not valid");
    }
    const credential: SwitchCredential = issueCredential(
        {
            from: "general-manager",
            to: input.to,
            reason: input.reason,
            visibleScope: input.visibleScope,
            payloadRefs: input.payloadRefs ?? [],
            budget: { quota: input.quota, elasticity: input.elasticity },
            constraints: input.constraints,
            manifest: { id: input.targetManifest.id, version: input.targetManifest.version },
            scenario: input.scenario,
            modes: input.modes,
            issuedAt: input.issuedAt,
            ...(input.ttlMs === (void 0) ? {} : { ttlMs: input.ttlMs }),
        },
        input.signers,
    );
    const verdict: CredentialVerdict = verifyCredential(credential, {
        at: input.at,
        to: input.to,
        manifest: { id: input.targetManifest.id, version: input.targetManifest.version },
        readRefs: input.payloadRefs ?? [],
    });
    if (!verdict.valid) {
        throw new GovernanceError("credential-scope", verdict.detail);
    }
    steps.push("credential verifies; previous perspective's private context seals");
    loadAttentionManifest(input.targetManifest, { perspective: input.to, scenario: input.scenario, at: input.at });
    steps.push("target loads its manifest; previous budget settles");
    return { credential, verdict, target: input.targetManifest, steps };
};

export interface DowngradeInput {
    requester: PerspectiveId;
    /**
     * The strategic perspective being left behind (board or supervisory).
     */
    from: PerspectiveId;
    to: PerspectiveId;
    reason: string;
    targetManifest: AttentionManifest;
    visibleScope: Ref[];
    quota: Budget;
    elasticity: Elasticity;
    constraints: BehaviorConstraints;
    issuedAt: Timestamp;
    ttlMs?: number;
    at: Timestamp;
    approvals: {
        generalManager: ApprovalGrant;
        legal: ApprovalGrant;
        finance: ApprovalGrant;
        humanResources: ApprovalGrant;
    };
    signers: readonly SignerInput[];
}

/**
 * Downgrade: the strategic layer returns authority to an execution
 * perspective. Finance approves the budget recovery, legal approves the
 * post-downgrade behaviour constraints, HR confirms the target is available.
 */
export const planDowngrade: (input: DowngradeInput) => PeerSwitchResult = (input: DowngradeInput): PeerSwitchResult => {
    const steps: string[] = [];
    if (!requiresEscalation(input.from)) {
        throw new GovernanceError("credential-target", `${input.from} is not a strategic perspective`);
    }
    if (perspective(input.to).layer !== "execution") {
        throw new GovernanceError("credential-target", `${input.to} is not an execution target`);
    }
    if (input.targetManifest.perspective !== input.to) {
        throw new GovernanceError("credential-target", `manifest belongs to ${input.targetManifest.perspective}, not ${input.to}`);
    }
    requireSlot(input.approvals.humanResources, "perspective.readiness", "human-resources", input.requester, "credential-invalid");
    requireSlot(input.approvals.legal, "credential.compliance", "legal", input.requester, "credential-invalid");
    requireSlot(input.approvals.finance, "budget.settlement", "finance", input.requester, "credential-invalid");
    requireSlot(input.approvals.generalManager, "credential.issue", "general-manager", input.requester, "credential-invalid");
    steps.push("downgrade conditions judged", "human resources approves availability", "legal approves post-downgrade constraints");
    steps.push("finance reclaims and refreezes the budget");
    const credential: SwitchCredential = issueCredential(
        {
            from: "general-manager",
            to: input.to,
            reason: input.reason,
            visibleScope: input.visibleScope,
            payloadRefs: [],
            budget: { quota: input.quota, elasticity: input.elasticity },
            constraints: input.constraints,
            manifest: { id: input.targetManifest.id, version: input.targetManifest.version },
            scenario: input.targetManifest.scenario,
            modes: input.targetManifest.modes,
            issuedAt: input.issuedAt,
            ...(input.ttlMs === (void 0) ? {} : { ttlMs: input.ttlMs }),
        },
        input.signers,
    );
    const verdict: CredentialVerdict = verifyCredential(credential, {
        at: input.at,
        to: input.to,
        manifest: { id: input.targetManifest.id, version: input.targetManifest.version },
    });
    if (!verdict.valid) {
        throw new GovernanceError("credential-scope", verdict.detail);
    }
    steps.push("general manager issues the downgrade credential; strategic context seals");
    return { credential, verdict, target: input.targetManifest, steps };
};

export interface ModeSwitchInput {
    manifest: AttentionManifest;
    modes: Partial<ModeWeights>;
    by: PerspectiveId;
    at: Timestamp;
    signoff: SignerInput;
    approvals?: {
        modeWeights?: ApprovalGrant;
        finance?: ApprovalGrant;
        legal?: ApprovalGrant;
    };
    evidenceFloor?: EvidenceFloor;
    budget?: BudgetBinding;
}

export interface ModeSwitchResult {
    manifest: AttentionManifest;
    drift: number;
    approvalRequired: boolean;
    plan: ScenarioModePlan;
    steps: string[];
}

/**
 * Mode switch: update the manifest's weights, floor and elasticity without
 * switching the perspective. Drift above 0.15 needs the general manager; an
 * elasticity change needs finance; a floor change needs legal.
 */
export const switchMode: (input: ModeSwitchInput) => ModeSwitchResult = (input: ModeSwitchInput): ModeSwitchResult => {
    const steps: string[] = [];
    const next: ModeWeights = normalizeModeWeights({ ...input.manifest.modes, ...input.modes });
    const drift: number = Math.max(
        Math.abs(next.affect - input.manifest.modes.affect),
        Math.abs(next.think - input.manifest.modes.think),
        Math.abs(next.diverge - input.manifest.modes.diverge),
        Math.abs(next.converge - input.manifest.modes.converge),
    );
    const approvalRequired: boolean = driftRequiresApproval(input.manifest.modes, next);
    if (approvalRequired) {
        const approval: ApprovalGrant | undefined = input.approvals?.modeWeights;
        if (approval === (void 0) || approval.granted !== true || approval.subject !== "mode.weights" || approval.by !== "general-manager") {
            throw new GovernanceError("approval-required", `mode drift ${drift.toFixed(2)} exceeds 0.15`);
        }
        steps.push("general manager approves the mode drift");
    }
    const plan: ScenarioModePlan = resolveScenarioModes(input.manifest.scenario, next);
    const elasticityChanged: boolean = plan.elasticity !== input.manifest.elasticity;
    if (elasticityChanged) {
        const approval: ApprovalGrant | undefined = input.approvals?.finance;
        if (approval === (void 0) || approval.granted !== true || approval.subject !== "budget.elasticity" || approval.by !== "finance") {
            throw new GovernanceError("approval-required", "an elasticity change needs a finance approval");
        }
        steps.push("finance approves the elasticity change");
    }
    const floorChanged: boolean = input.evidenceFloor !== (void 0) && input.evidenceFloor !== input.manifest.evidenceFloor;
    if (floorChanged) {
        const approval: ApprovalGrant | undefined = input.approvals?.legal;
        if (approval === (void 0) || approval.granted !== true || approval.subject !== "manifest.evidence-floor" || approval.by !== "legal") {
            throw new GovernanceError("approval-required", "an evidence-floor change needs a legal approval");
        }
        steps.push("legal approves the evidence-floor change");
    }
    const patch: ManifestPatch = {
        modes: next,
        ...(input.evidenceFloor === (void 0) ? {} : { evidenceFloor: input.evidenceFloor }),
        ...(input.budget === (void 0) ? {} : { budget: input.budget }),
        ...(elasticityChanged && input.budget === (void 0)
            ? { budget: { ...input.manifest.budget, elasticity: plan.elasticity } }
            : {}),
    };
    const updated: AttentionManifest = updateAttentionManifest(input.manifest, patch, {
        by: input.by,
        at: input.at,
        signoff: input.signoff,
        approvals: {
            ...(input.approvals?.modeWeights === (void 0) ? {} : { modeWeights: input.approvals.modeWeights }),
            ...(input.approvals?.finance === (void 0) ? {} : { budget: input.approvals.finance }),
            ...(input.approvals?.legal === (void 0) ? {} : { evidenceFloor: input.approvals.legal }),
        },
    });
    steps.push(`manifest v${updated.version} keeps the perspective; weights updated`);
    return { manifest: updated, drift, approvalRequired, plan, steps };
};

export interface ScenarioSwitchInput {
    manifest: AttentionManifest;
    scenario: ScenarioId;
    modes?: Partial<ModeWeights>;
    at: Timestamp;
    signers: readonly SignerInput[];
    approvals: {
        scenario: ApprovalGrant;
        board?: ApprovalGrant;
        finance?: ApprovalGrant;
        legal?: ApprovalGrant;
    };
    patch?: Omit<RederivePatch, "scenario" | "modes">;
    /**
     * Set when the new scenario is entered through the escalation path.
     */
    crossScenarioEscalation?: boolean;
}

export interface ScenarioSwitchResult {
    manifest: AttentionManifest;
    plan: ScenarioModePlan;
    steps: string[];
}

/**
 * Scenario switch: re-derive the manifest (version increments, parent digest
 * recorded) instead of patching weights. A cross-scenario escalation also needs
 * the board.
 */
export const switchScenario: (input: ScenarioSwitchInput) => ScenarioSwitchResult = (input: ScenarioSwitchInput): ScenarioSwitchResult => {
    const steps: string[] = [];
    const scenarioApproval: ApprovalGrant = input.approvals.scenario;
    if (scenarioApproval.granted !== true || scenarioApproval.subject !== "scenario.judgement" || scenarioApproval.by !== "general-manager") {
        throw new GovernanceError("approval-required", "a scenario switch needs the general manager's scenario.judgement approval");
    }
    steps.push("general manager approves the new scenario");
    if (input.crossScenarioEscalation === true) {
        const board: ApprovalGrant | undefined = input.approvals.board;
        if (board === (void 0) || board.granted !== true || board.subject !== "strategy.version" || board.by !== "board") {
            throw new GovernanceError("approval-required", "a cross-scenario escalation also needs the board");
        }
        steps.push("board approves the cross-scenario escalation");
    }
    if (input.patch?.budget !== (void 0) && input.approvals.finance === (void 0)) {
        throw new GovernanceError("approval-required", "a budget change in a scenario switch needs finance");
    }
    if (input.patch?.constraints !== (void 0) && input.approvals.legal === (void 0)) {
        throw new GovernanceError("approval-required", "a constraint change in a scenario switch needs legal");
    }
    const manifest: AttentionManifest = rederiveAttentionManifest(
        input.manifest,
        { ...input.patch, scenario: input.scenario, ...(input.modes === (void 0) ? {} : { modes: input.modes }) },
        input.signers,
        input.at,
    );
    const plan: ScenarioModePlan = resolveScenarioModes(manifest.scenario, manifest.modes);
    steps.push(`scenario ${input.manifest.scenario} -> ${input.scenario}; manifest v${manifest.version} re-derived`);
    return { manifest, plan, steps };
};

export type EscalationKind = "audit" | "strategy" | "final" | "compliance";

export interface EscalationInput {
    from: PerspectiveId;
    kind: EscalationKind;
    reason: string;
    evidence: Ref[];
    at: Timestamp;
    goal: string;
    strategySummary: string;
    approvals: {
        initiate: ApprovalGrant;
        reserve: ApprovalGrant;
        readiness: ApprovalGrant;
        authorization: ApprovalGrant;
    };
}

export interface IndependentContext {
    goal: string;
    strategySummary: string;
    evidence: Ref[];
    request: string;
    /**
     * Always false: the strategic layer does not inherit the execution chain.
     */
    inheritsPrivateReasoning: false;
}

export interface EscalationPlan {
    target: PerspectiveId;
    independent: IndependentContext;
    approvals: ApprovalGrant[];
    authorization: string;
    steps: string[];
}

/**
 * Escalation plan: the finance reserve and HR readiness gates are the same for
 * every type; the type decides who signs the authorisation. The strategic layer
 * receives global core, evidence refs and the request summary only.
 */
export const planEscalation: (input: EscalationInput) => EscalationPlan = (input: EscalationInput): EscalationPlan => {
    const steps: string[] = [];
    const target: PerspectiveId = escalationTarget(input.kind);
    if (input.evidence.length === 0) {
        throw new GovernanceError("approval-required", "an escalation must cite evidence");
    }
    if (input.approvals.initiate.granted !== true || input.approvals.initiate.subject !== "escalation.initiate" || input.approvals.initiate.by !== "general-manager") {
        throw new GovernanceError("approval-required", "escalation.initiate needs the general manager");
    }
    steps.push("general manager initiates the escalation");
    if (input.approvals.reserve.granted !== true || input.approvals.reserve.subject !== "budget.reserve" || input.approvals.reserve.by !== "finance") {
        throw new GovernanceError("approval-required", "the reserve draw needs finance");
    }
    steps.push("finance approves the reserve draw");
    if (input.approvals.readiness.granted !== true || input.approvals.readiness.subject !== "perspective.readiness" || input.approvals.readiness.by !== "human-resources") {
        throw new GovernanceError("approval-required", "strategic readiness needs human resources");
    }
    steps.push("human resources confirms the strategic perspective is ready");
    const authorizer: PerspectiveId = input.kind === "audit" ? "general-manager" : input.kind === "strategy" ? "board" : input.kind === "final" ? "shareholders" : "legal";
    const subject: string = input.kind === "audit" ? "escalation.audit" : input.kind === "strategy" ? "escalation.strategic" : input.kind === "final" ? "escalation.final" : "credential.compliance";
    const authorization: ApprovalGrant = input.approvals.authorization;
    if (authorization.granted !== true || authorization.by !== authorizer || authorization.subject !== subject || !canApprove(authorizer, authorization.subject)) {
        throw new GovernanceError("approval-required", `${input.kind} escalation must be authorised by ${authorizer} via ${subject}`);
    }
    steps.push(`${authorizer} authorises the ${input.kind} escalation`);
    const independent: IndependentContext = {
        goal: input.goal,
        strategySummary: input.strategySummary,
        evidence: input.evidence.map((ref: Ref) => ({ ...ref })),
        request: input.reason,
        inheritsPrivateReasoning: false,
    };
    steps.push(`strategic layer opens an independent context for ${target}; execution chain stays sealed`);
    return {
        target,
        independent,
        approvals: [input.approvals.initiate, input.approvals.reserve, input.approvals.readiness, input.approvals.authorization],
        authorization: input.approvals.authorization.id,
        steps,
    };
};
