/**
 * The seven-phase workflow with approvals (spec section 11).
 *
 * The workflow is the only place that decides whether a phase may advance. It
 * enforces three rules that the rest of the protocol depends on:
 *   - an approval cannot be issued by the perspective that requested it;
 *   - a phase gate needs its artefacts and its approvals, not just a mood;
 *   - execution cannot start without a triple-signed switch credential.
 *
 * The phase table is data, so a change to a step is reviewable as a diff.
 */
import type { Id, Timestamp } from "../types/common.ts";
import type { ApprovalGrant, ApprovalSubject, ModeWeights, PerspectiveId, ScenarioId, Signoff, SignoffRole } from "./types.ts";
import { GovernanceError } from "./types.ts";
import type { CredentialVerdict, SwitchCredential } from "./credential.ts";
import { verifyCredential } from "./credential.ts";
import { canApprove, escalationTarget } from "./perspectives.ts";
import { resolveScenarioModes } from "./matrix.ts";
import type { ScenarioModePlan } from "./matrix.ts";

export type PhaseId = "intake" | "planning" | "preparation" | "execution" | "audit" | "escalation" | "archive";

export const PhaseOrder: readonly PhaseId[] = ["intake", "planning", "preparation", "execution", "audit", "escalation", "archive"];

export type EscalationType = "audit" | "strategy" | "final" | "compliance";

/**
 * One step of a phase: who acts, what they do, what they produce.
 */
export interface StepSpec {
    id: string;
    phase: PhaseId;
    owner: PerspectiveId;
    action: string;
    produces: string;
    optional?: boolean;
}

export interface Artifact {
    id: Id;
    kind: string;
    by: PerspectiveId;
    at: Timestamp;
    signoffs?: SignoffRole[];
    digest?: string;
    note?: string;
}

export interface WorkflowApproval extends ApprovalGrant {
    requestedBy: PerspectiveId;
}

export interface PhaseTransition {
    from: PhaseId | "none";
    to: PhaseId;
    by: PerspectiveId;
    at: Timestamp;
    note: string;
}

export interface EscalationRecord {
    type: EscalationType;
    reason: string;
    evidenceRefs: number;
    by: PerspectiveId;
    at: Timestamp;
    target: PerspectiveId;
    returnPhase: PhaseId;
}

export interface WorkflowState {
    id: Id;
    scenario: ScenarioId;
    modes: ModeWeights;
    phase: PhaseId;
    status: "open" | "blocked" | "complete" | "terminated";
    completedSteps: string[];
    artifacts: Artifact[];
    approvals: WorkflowApproval[];
    manifest?: { id: Id; version: number; };
    credential?: { id: Id; signoffs: SignoffRole[]; expires: Timestamp; digest: string; };
    escalation?: EscalationRecord;
    history: PhaseTransition[];
    blockedReason?: string;
}

export interface StartInput {
    id: Id;
    scenario: ScenarioId;
    modes?: Partial<ModeWeights>;
    at: Timestamp;
}

/**
 * The phase table. Actions are short because the artefacts carry the detail.
 */
export const PhaseSteps: Record<PhaseId, readonly StepSpec[]> = {
    intake: [
        {
            id: "intake.requirement",
            phase: "intake",
            owner: "customer-service",
            action: "clarify the request, judge the scenario, propose modes",
            produces: "requirement-summary",
        },
        {
            id: "intake.research",
            phase: "intake",
            owner: "marketing",
            action: "run pre-task research if the scenario needs it",
            produces: "environment-summary",
            optional: true,
        },
        { id: "intake.complexity", phase: "intake", owner: "general-manager", action: "accept the summary and grade complexity", produces: "complexity-grade" },
        { id: "intake.budget", phase: "intake", owner: "finance", action: "set the initial budget by scenario", produces: "initial-budget" },
        { id: "intake.strategy", phase: "intake", owner: "board", action: "issue the strategy summary", produces: "strategy-summary" },
        {
            id: "intake.log",
            phase: "intake",
            owner: "administration",
            action: "initialise logs, blackboard, evidence store and version chain",
            produces: "log-init",
        },
    ],
    planning: [
        { id: "planning.route", phase: "planning", owner: "strategy", action: "decompose the task and name risks", produces: "execution-route" },
        {
            id: "planning.staffing",
            phase: "planning",
            owner: "human-resources",
            action: "assign perspectives and confirm capabilities",
            produces: "perspective-plan",
        },
        { id: "planning.research", phase: "planning", owner: "marketing", action: "set the research intensity", produces: "research-plan", optional: true },
        { id: "planning.budget", phase: "planning", owner: "finance", action: "split the three ledgers and set elasticity", produces: "budget-plan" },
        {
            id: "planning.constraints",
            phase: "planning",
            owner: "legal",
            action: "inject constraints and set evidence floors",
            produces: "behavior-constraints",
        },
        { id: "planning.state", phase: "planning", owner: "operations", action: "design the state machine", produces: "state-machine" },
        { id: "planning.manifest", phase: "planning", owner: "general-manager", action: "derive the initial manifest", produces: "attention-manifest" },
    ],
    preparation: [
        {
            id: "preparation.credential",
            phase: "preparation",
            owner: "general-manager",
            action: "issue the switch credential and the manifest",
            produces: "switch-credential",
        },
        { id: "preparation.compliance", phase: "preparation", owner: "legal", action: "gate the credential for compliance", produces: "compliance-verdict" },
        {
            id: "preparation.freeze",
            phase: "preparation",
            owner: "finance",
            action: "freeze the budget and arm elasticity triggers",
            produces: "budget-freeze",
        },
        { id: "preparation.readiness", phase: "preparation", owner: "human-resources", action: "confirm the perspectives are ready", produces: "readiness" },
        {
            id: "preparation.context",
            phase: "preparation",
            owner: "administration",
            action: "prepare context, evidence store and version chain",
            produces: "context-ready",
        },
        { id: "preparation.tools", phase: "preparation", owner: "technology", action: "confirm the tools are ready", produces: "tools-ready" },
        { id: "preparation.state", phase: "preparation", owner: "operations", action: "initialise the state machine", produces: "state-ready" },
    ],
    execution: [
        { id: "execution.tools", phase: "execution", owner: "technology", action: "execute tool calls under the manifest", produces: "execution-receipt" },
        {
            id: "execution.research",
            phase: "execution",
            owner: "marketing",
            action: "research under the scenario and mode",
            produces: "research-receipt",
            optional: true,
        },
        { id: "execution.state", phase: "execution", owner: "operations", action: "advance the state machine", produces: "state-advance" },
        { id: "execution.legal", phase: "execution", owner: "legal", action: "gate key nodes; freeze or break the circuit", produces: "legal-checkpoint" },
        { id: "execution.finance", phase: "execution", owner: "finance", action: "charge in real time and approve top-ups", produces: "budget-charge" },
        {
            id: "execution.manager",
            phase: "execution",
            owner: "general-manager",
            action: "monitor, switch modes and reassess ignored items",
            produces: "mode-decision",
        },
        {
            id: "execution.log",
            phase: "execution",
            owner: "administration",
            action: "record receipts, logs and the mode-switch audit chain",
            produces: "audit-log",
        },
    ],
    audit: [
        { id: "audit.evidence", phase: "audit", owner: "supervisory", action: "independently audit the evidence trail", produces: "audit-evidence" },
        { id: "audit.behavior", phase: "audit", owner: "legal", action: "audit behaviour compliance", produces: "audit-behavior" },
        { id: "audit.budget", phase: "audit", owner: "finance", action: "audit the budget against elasticity", produces: "audit-budget" },
        {
            id: "audit.satisfaction",
            phase: "audit",
            owner: "customer-service",
            action: "confirm requirement satisfaction",
            produces: "satisfaction",
            optional: true,
        },
        {
            id: "audit.decision",
            phase: "audit",
            owner: "general-manager",
            action: "decide pass, rework or escalate with three audit receipts",
            produces: "audit-decision",
        },
    ],
    escalation: [
        {
            id: "escalation.initiate",
            phase: "escalation",
            owner: "general-manager",
            action: "initiate with reasons and evidence refs",
            produces: "escalation-request",
        },
        { id: "escalation.reserve", phase: "escalation", owner: "finance", action: "allocate from the escalation reserve", produces: "reserve-approval" },
        {
            id: "escalation.readiness",
            phase: "escalation",
            owner: "human-resources",
            action: "confirm the strategic perspective is ready",
            produces: "strategic-readiness",
        },
        {
            id: "escalation.authorize",
            phase: "escalation",
            owner: "general-manager",
            action: "obtain the type-specific authorisation",
            produces: "escalation-authorization",
        },
        {
            id: "escalation.arbitrate",
            phase: "escalation",
            owner: "supervisory",
            action: "audit or arbitrate in an independent context",
            produces: "arbitration",
        },
        {
            id: "escalation.requirement",
            phase: "escalation",
            owner: "customer-service",
            action: "state the demand-side opinion",
            produces: "requirement-opinion",
            optional: true,
        },
        {
            id: "escalation.apply",
            phase: "escalation",
            owner: "general-manager",
            action: "apply the outcome to manifest, scenario or modes",
            produces: "escalation-outcome",
        },
    ],
    archive: [
        {
            id: "archive.logs",
            phase: "archive",
            owner: "administration",
            action: "archive logs, receipts, audit chain and version chains",
            produces: "archive-package",
        },
        { id: "archive.settlement", phase: "archive", owner: "finance", action: "settle the cost", produces: "budget-settlement" },
        { id: "archive.audit", phase: "archive", owner: "supervisory", action: "audit the archive", produces: "archive-audit" },
        { id: "archive.compliance", phase: "archive", owner: "legal", action: "archive compliance", produces: "compliance-archive" },
        {
            id: "archive.feedback",
            phase: "archive",
            owner: "customer-service",
            action: "archive user feedback including the emotional trace",
            produces: "user-feedback",
        },
        { id: "archive.close", phase: "archive", owner: "general-manager", action: "decide complete, terminate or hand over", produces: "closing-decision" },
        { id: "archive.retro-board", phase: "archive", owner: "board", action: "review the strategy and the scenario judgement", produces: "strategy-retro" },
        {
            id: "archive.capability",
            phase: "archive",
            owner: "human-resources",
            action: "update capability statistics and matching priors",
            produces: "capability-priors",
        },
        { id: "archive.retro-ops", phase: "archive", owner: "strategy", action: "review the process and the mode weights", produces: "process-retro" },
    ],
};

/**
 * What a phase must have before it can advance.
 */
interface PhaseGate {
    approvals: ApprovalSubject[];
    artifacts: string[];
    note: string;
}

const PhaseGates: Record<PhaseId, PhaseGate> = {
    intake: {
        approvals: ["requirement.complete", "scenario.judgement", "complexity.grade", "budget.initial"],
        artifacts: ["requirement-summary", "complexity-grade", "initial-budget", "strategy-summary", "log-init"],
        note: "a confirmed requirement, an approved scenario and complexity, an initial budget and a strategy digest",
    },
    planning: {
        approvals: ["manifest.derive", "perspective.routing", "budget.allocation", "manifest.constraints"],
        artifacts: ["execution-route", "perspective-plan", "budget-plan", "behavior-constraints", "state-machine", "attention-manifest"],
        note: "a signed manifest plus the route, staffing, budget, constraints and state machine",
    },
    preparation: {
        approvals: ["credential.issue", "credential.compliance", "budget.freeze", "perspective.readiness"],
        artifacts: ["switch-credential", "compliance-verdict", "budget-freeze", "readiness", "context-ready", "tools-ready", "state-ready"],
        note: "a triple-signed credential, a compliance verdict and a frozen budget",
    },
    execution: {
        approvals: [],
        artifacts: ["execution-receipt", "legal-checkpoint", "budget-charge", "mode-decision", "audit-log"],
        note: "at least one executed receipt with legal, budget and mode records",
    },
    audit: {
        approvals: ["audit.evidence", "audit.behavior", "audit.budget", "requirement.satisfaction"],
        artifacts: ["audit-evidence", "audit-behavior", "audit-budget", "audit-decision"],
        note: "the three independent audit receipts precede the general manager's decision",
    },
    escalation: {
        approvals: ["escalation.initiate", "budget.reserve", "perspective.readiness"],
        artifacts: ["escalation-request", "reserve-approval", "strategic-readiness", "escalation-authorization", "arbitration", "escalation-outcome"],
        note: "a reserve draw, a ready strategic perspective and a type-specific authorisation",
    },
    archive: {
        approvals: ["budget.settlement", "audit.archive", "requirement.satisfaction"],
        artifacts: [
            "archive-package",
            "budget-settlement",
            "archive-audit",
            "compliance-archive",
            "closing-decision",
            "strategy-retro",
            "capability-priors",
            "process-retro",
        ],
        note: "a settled budget, an audited archive and the closing decision",
    },
};

const EscalationApproval: Record<EscalationType, ApprovalSubject> = {
    audit: "escalation.audit",
    strategy: "escalation.strategic",
    final: "escalation.final",
    compliance: "credential.compliance",
};

/**
 * The workflow engine. It is deliberately linear: `escalate` side-branches and
 * `resume` returns, and `advance` is the only door to the next phase.
 */
export class Workflow {
    private readonly state: WorkflowState;
    private counter = 0;

    constructor(state: WorkflowState) {
        this.state = state;
    }

    static start(input: StartInput): Workflow {
        if (input.id.length === 0) {
            throw new GovernanceError("workflow-phase", "a workflow needs an id");
        }
        const plan: ScenarioModePlan = resolveScenarioModes(input.scenario, input.modes);
        const state: WorkflowState = {
            id: input.id,
            scenario: input.scenario,
            modes: plan.modes,
            phase: "intake",
            status: "open",
            completedSteps: [],
            artifacts: [],
            approvals: [],
            history: [{ from: "none", to: "intake", by: "general-manager", at: input.at, note: "created" }],
        };
        return new Workflow(state);
    }

    current(): WorkflowState {
        return cloneState(this.state);
    }

    steps(): StepSpec[] {
        return PhaseSteps[this.state.phase].map((step: StepSpec) => ({ ...step }));
    }

    /**
     * Complete one step of the current phase and record its artefact.
     */
    complete(stepId: string, by: PerspectiveId, at: Timestamp, note?: string): WorkflowState {
        if (this.state.status === "terminated" || this.state.status === "complete") {
            throw new GovernanceError("workflow-phase", `workflow is ${this.state.status}`);
        }
        if (this.state.status === "blocked") {
            throw new GovernanceError("workflow-phase", `workflow is blocked: ${this.state.blockedReason ?? "no reason"}`);
        }
        const step: StepSpec | undefined = PhaseSteps[this.state.phase].find((entry: StepSpec) => entry.id === stepId);
        if (step === (void 0)) {
            throw new GovernanceError("workflow-step", `${stepId} is not a step of ${this.state.phase}`);
        }
        if (step.owner !== by) {
            throw new GovernanceError("workflow-step", `${stepId} belongs to ${step.owner}, not ${by}`);
        }
        if (this.state.completedSteps.includes(stepId)) {
            throw new GovernanceError("workflow-step", `${stepId} is already complete`);
        }
        this.state.completedSteps.push(stepId);
        this.counter += 1;
        this.state.artifacts.push({
            id: `art.${this.counter}`,
            kind: step.produces,
            by,
            at,
            ...(note === (void 0) ? {} : { note }),
        });
        return cloneState(this.state);
    }

    /**
     * Complete a step and record a richer artefact in one operation. Use this
     * when the artefact carries sign-offs or a digest (a credential, an audit
     * receipt); `complete` records the plain artefact.
     */
    attach(stepId: string, by: PerspectiveId, artifact: Omit<Artifact, "id" | "by">): WorkflowState {
        if (artifact.kind === "switch-credential") {
            throw new GovernanceError("workflow-artifact", "use attachCredential(): a fabricated credential artefact is not evidence");
        }
        return this.recordArtifact(stepId, by, artifact);
    }

    /**
     * Internal artefact recorder. The public `attach` guards the credential
     * kind; `attachCredential` enters here only after verifying a real one.
     */
    private recordArtifact(stepId: string, by: PerspectiveId, artifact: Omit<Artifact, "id" | "by">): WorkflowState {
        if (this.state.status === "terminated" || this.state.status === "complete" || this.state.status === "blocked") {
            throw new GovernanceError("workflow-phase", `workflow is ${this.state.status}`);
        }
        const step: StepSpec | undefined = PhaseSteps[this.state.phase].find((entry: StepSpec) => entry.id === stepId);
        if (step === (void 0) || step.owner !== by) {
            throw new GovernanceError("workflow-step", `${stepId} is not ${by}'s step in ${this.state.phase}`);
        }
        if (this.state.completedSteps.includes(stepId)) {
            throw new GovernanceError("workflow-step", `${stepId} is already complete`);
        }
        this.state.completedSteps.push(stepId);
        this.counter += 1;
        this.state.artifacts.push({ ...artifact, id: `art.${this.counter}`, by });
        return cloneState(this.state);
    }

    /**
     * Attach a real, verified switch credential to the preparation phase and
     * bind it to the state. The workflow never trusts a caller-supplied digest
     * string.
     */
    attachCredential(credential: SwitchCredential, at: Timestamp): WorkflowState {
        if (this.state.phase !== "preparation") {
            throw new GovernanceError("workflow-phase", "a credential is attached in the preparation phase");
        }
        const verdict: CredentialVerdict = verifyCredential(credential, { at, to: credential.to, manifest: credential.manifest });
        if (!verdict.valid) {
            throw new GovernanceError("workflow-artifact", `credential rejected: ${verdict.detail}`);
        }
        this.recordArtifact("preparation.credential", "general-manager", {
            kind: "switch-credential",
            at,
            signoffs: credential.signoffs.map((signoff: Signoff) => signoff.role),
            digest: credential.digest,
        });
        this.state.credential = {
            id: credential.id,
            signoffs: credential.signoffs.map((signoff: Signoff) => signoff.role),
            expires: credential.expires,
            digest: credential.digest,
        };
        return cloneState(this.state);
    }

    /**
     * Record an approval. The approver must own the subject and must differ
     * from the requester.
     */
    approve(input: {
        subject: ApprovalSubject;
        by: PerspectiveId;
        at: Timestamp;
        requestedBy: PerspectiveId;
        granted?: boolean;
        note?: string;
    }): WorkflowState {
        if (!canApprove(input.by, input.subject)) {
            throw new GovernanceError("approval-not-permitted", `${input.by} may not approve ${input.subject}`);
        }
        if (input.by === input.requestedBy) {
            throw new GovernanceError("approval-self", `${input.by} cannot approve its own request`);
        }
        this.counter += 1;
        this.state.approvals.push({
            id: `apv.${this.counter}`,
            subject: input.subject,
            by: input.by,
            at: input.at,
            granted: input.granted ?? true,
            requestedBy: input.requestedBy,
            ...(input.note === (void 0) ? {} : { note: input.note }),
        });
        return cloneState(this.state);
    }

    hasApproval(subject: ApprovalSubject): boolean {
        return this.state.approvals.some((approval: WorkflowApproval) => approval.subject === subject && approval.granted);
    }

    /**
     * Advance to the next phase. Only the general manager may call this, and
     * only when the gate is satisfied.
     */
    advance(by: PerspectiveId, at: Timestamp): WorkflowState {
        if (by !== "general-manager") {
            throw new GovernanceError("workflow-phase", "only the general manager may advance a phase");
        }
        if (this.state.status === "terminated" || this.state.status === "complete") {
            throw new GovernanceError("workflow-phase", `workflow is ${this.state.status}`);
        }
        if (this.state.status === "blocked") {
            throw new GovernanceError("workflow-phase", `workflow is blocked: ${this.state.blockedReason ?? "no reason"}`);
        }
        const gate: PhaseGate = PhaseGates[this.state.phase];
        const missingSteps: string[] = PhaseSteps[this.state.phase]
            .filter((step: StepSpec) => step.optional !== true && !this.state.completedSteps.includes(step.id))
            .map((step: StepSpec) => step.id);
        if (missingSteps.length > 0) {
            throw new GovernanceError("workflow-step", `incomplete steps: ${missingSteps.join(", ")}`);
        }
        const missingApprovals: ApprovalSubject[] = gate.approvals.filter((subject: ApprovalSubject) => !this.hasApproval(subject));
        if (missingApprovals.length > 0) {
            throw new GovernanceError("approval-required", `missing approvals: ${missingApprovals.join(", ")}`);
        }
        const missingArtifacts: string[] = gate.artifacts.filter((kind: string) => !this.hasArtifact(kind));
        if (missingArtifacts.length > 0) {
            throw new GovernanceError("workflow-artifact", `missing artifacts: ${missingArtifacts.join(", ")}`);
        }
        if (this.state.phase === "preparation") {
            const credential: WorkflowState["credential"] = this.state.credential;
            const required: SignoffRole[] = ["issuer", "legal", "finance"];
            const expires: number = credential === (void 0) ? Number.NaN : Date.parse(credential.expires);
            if (
                credential === (void 0) ||
                credential.digest.length === 0 ||
                !required.every((role: SignoffRole) => credential.signoffs.includes(role)) ||
                !Number.isFinite(expires) ||
                expires <= Date.parse(at)
            ) {
                throw new GovernanceError("workflow-artifact", "the switch credential must be issued, triple-signed and unexpired before execution");
            }
        }
        if (this.state.phase === "escalation" && this.state.escalation !== (void 0)) {
            const subject: ApprovalSubject = EscalationApproval[this.state.escalation.type];
            if (!this.hasApproval(subject)) {
                throw new GovernanceError("approval-required", `escalation type ${this.state.escalation.type} needs ${subject}`);
            }
        }
        const from: PhaseId = this.state.phase;
        const next: PhaseId = PhaseOrder[PhaseOrder.indexOf(from) + 1];
        this.state.phase = next;
        this.state.history.push({ from, to: next, by, at, note: gate.note });
        return cloneState(this.state);
    }

    /**
     * Enter the escalation branch from any phase except archive.
     */
    escalate(input: { by: PerspectiveId; at: Timestamp; type: EscalationType; reason: string; evidenceRefs: number; }): WorkflowState {
        if (input.by !== "general-manager" && input.by !== "legal") {
            throw new GovernanceError("workflow-phase", "only the general manager or legal may escalate");
        }
        if (this.state.phase === "escalation" || this.state.phase === "archive") {
            throw new GovernanceError("workflow-phase", `cannot escalate from ${this.state.phase}`);
        }
        if (input.evidenceRefs <= 0) {
            throw new GovernanceError("workflow-artifact", "an escalation must cite evidence");
        }
        const returnPhase: PhaseId = this.state.phase;
        this.state.escalation = {
            type: input.type,
            reason: input.reason,
            evidenceRefs: input.evidenceRefs,
            by: input.by,
            at: input.at,
            target: escalationTarget(input.type),
            returnPhase,
        };
        this.state.phase = "escalation";
        this.state.history.push({ from: returnPhase, to: "escalation", by: input.by, at: input.at, note: `${input.type}: ${input.reason}` });
        return cloneState(this.state);
    }

    /**
     * Leave the escalation branch for the phase that asked for it.
     */
    resume(by: PerspectiveId, at: Timestamp): WorkflowState {
        if (this.state.phase !== "escalation" || this.state.escalation === (void 0)) {
            throw new GovernanceError("workflow-phase", "not in the escalation branch");
        }
        if (by !== "general-manager") {
            throw new GovernanceError("workflow-phase", "only the general manager may resume");
        }
        const target: PhaseId = this.state.escalation.returnPhase;
        this.state.phase = target;
        this.state.history.push({ from: "escalation", to: target, by, at, note: "escalation resolved" });
        return cloneState(this.state);
    }

    /**
     * Attach the manifest reference the execution phase uses. The credential is
     * bound only through {@link attachCredential}.
     */
    bind(context: { manifest?: { id: Id; version: number; }; }): WorkflowState {
        if (context.manifest !== (void 0)) {
            this.state.manifest = { ...context.manifest };
        }
        return cloneState(this.state);
    }

    block(reason: string): WorkflowState {
        this.state.status = "blocked";
        this.state.blockedReason = reason;
        return cloneState(this.state);
    }

    unblock(): WorkflowState {
        this.state.status = "open";
        delete this.state.blockedReason;
        return cloneState(this.state);
    }

    terminate(at: Timestamp, reason: string): WorkflowState {
        this.state.status = "terminated";
        this.state.history.push({ from: this.state.phase, to: this.state.phase, by: "general-manager", at, note: `terminated: ${reason}` });
        return cloneState(this.state);
    }

    finish(at: Timestamp): WorkflowState {
        if (this.state.phase !== "archive") {
            throw new GovernanceError("workflow-phase", "only the archive phase can finish a task");
        }
        const problems: string[] = this.archiveGateProblems();
        if (problems.length > 0) {
            throw new GovernanceError("workflow-artifact", `the archive gate is not satisfied: ${problems.join("; ")}`);
        }
        this.state.status = "complete";
        this.state.history.push({ from: "archive", to: "archive", by: "general-manager", at, note: "complete" });
        return cloneState(this.state);
    }

    hasArtifact(kind: string): boolean {
        return this.state.artifacts.some((artifact: Artifact) => artifact.kind === kind);
    }

    /**
     * Invariant report used by checks and by the archive phase.
     */
    verify(): string[] {
        const problems: string[] = [];
        if (this.state.phase !== "escalation" && this.state.phase !== "archive" && this.state.status === "complete") {
            problems.push("a workflow cannot be complete before archive");
        }
        for (let index: number = 0; index < this.state.approvals.length; index += 1) {
            const approval: WorkflowApproval = this.state.approvals[index];
            if (approval.by === approval.requestedBy) {
                problems.push(`${approval.id} was self-approved`);
            }
            if (!canApprove(approval.by, approval.subject)) {
                problems.push(`${approval.id} approved by an unauthorised perspective`);
            }
        }
        if (this.state.phase === "execution" && this.state.credential === (void 0)) {
            problems.push("execution has no bound credential");
        }
        if (this.state.credential !== (void 0)) {
            const required: SignoffRole[] = ["issuer", "legal", "finance"];
            if (this.state.credential.digest.length === 0) {
                problems.push("the bound credential has no digest");
            }
            if (!required.every((role: SignoffRole) => this.state.credential?.signoffs.includes(role) === true)) {
                problems.push("the switch credential is not triple-signed");
            }
        }
        if (this.state.phase === "archive" || this.state.status === "complete") {
            problems.push(...this.archiveGateProblems());
        }
        return problems;
    }

    private archiveGateProblems(): string[] {
        const gate: PhaseGate = PhaseGates.archive;
        const problems: string[] = [];
        const missingSteps: string[] = PhaseSteps.archive
            .filter((step: StepSpec) => step.optional !== true && !this.state.completedSteps.includes(step.id))
            .map((step: StepSpec) => step.id);
        if (missingSteps.length > 0) {
            problems.push(`incomplete archive steps: ${missingSteps.join(", ")}`);
        }
        const missingApprovals: ApprovalSubject[] = gate.approvals.filter((subject: ApprovalSubject) => !this.hasApproval(subject));
        if (missingApprovals.length > 0) {
            problems.push(`missing archive approvals: ${missingApprovals.join(", ")}`);
        }
        const missingArtifacts: string[] = gate.artifacts.filter((kind: string) => !this.hasArtifact(kind));
        if (missingArtifacts.length > 0) {
            problems.push(`missing archive artefacts: ${missingArtifacts.join(", ")}`);
        }
        return problems;
    }
}

const cloneState: (state: WorkflowState) => WorkflowState = (state: WorkflowState): WorkflowState => ({
    ...state,
    modes: { ...state.modes },
    completedSteps: [...state.completedSteps],
    artifacts: state.artifacts.map((artifact: Artifact) => ({
        ...artifact,
        ...(artifact.signoffs === (void 0) ? {} : { signoffs: [...artifact.signoffs] }),
    })),
    approvals: state.approvals.map((approval: WorkflowApproval) => ({ ...approval })),
    ...(state.manifest === (void 0) ? {} : { manifest: { ...state.manifest } }),
    ...(state.credential === (void 0) ? {} : { credential: { ...state.credential, signoffs: [...state.credential.signoffs] } }),
    ...(state.escalation === (void 0) ? {} : { escalation: { ...state.escalation } }),
    history: state.history.map((entry: PhaseTransition) => ({ ...entry })),
});
