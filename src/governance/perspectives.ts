/**
 * The perspective registry (spec section 4, section 12.1).
 *
 * A perspective is a governed attention stance with a manifest, a budget and
 * an approval role. The registry is deliberately data-only: the manifest,
 * credential and workflow modules read it instead of hard-coding a role name.
 *
 * Finance, human resources and administration are rule modules or
 * infrastructure, not switchable perspectives; they remain addressable so
 * their approval and accounting duties can be expressed.
 */
import type { Activation, ApprovalSubject, PerspectiveId, PerspectiveLayer, ScenarioId } from "./types.ts";
import { GovernanceError, PerspectiveIds } from "./types.ts";
import type { ScenarioPerspectives } from "./matrix.ts";
import { PerspectiveActivationTable } from "./matrix.ts";

/**
 * One registry row.
 */
export interface PerspectiveDefinition {
    id: PerspectiveId;
    labelZh: string;
    labelEn: string;
    layer: PerspectiveLayer;
    /**
     * What this perspective attends to when its manifest is loaded.
     */
    focus: string[];
    /**
     * Activation cadence in prose; the scenario table decides per task.
     */
    frequency: string;
    switchable: boolean;
    /**
     * May this perspective be the target of a same-level switch credential?
     * Strategic perspectives require the escalation path instead.
     */
    directSwitch: boolean;
    /**
     * May this perspective counter-sign a switch credential?
     */
    signsCredentials: boolean;
    /**
     * Approval subjects this perspective owns.
     */
    approve: ApprovalSubject[];
    /**
     * True for the independent evidence audit path.
     */
    independentAudit: boolean;
}

/**
 * The canonical registry. Order follows the governance template.
 */
export const PerspectiveRegistry: Record<PerspectiveId, PerspectiveDefinition> = {
    shareholders: {
        id: "shareholders",
        labelZh: "股东大会",
        labelEn: "Shareholders",
        layer: "strategic",
        focus: ["goal authority", "final arbitration", "liability"],
        frequency: "final arbitration only",
        switchable: false,
        directSwitch: false,
        signsCredentials: false,
        approve: ["goal.change", "liability.attribution", "final.ruling", "escalation.final"],
        independentAudit: false,
    },
    board: {
        id: "board",
        labelZh: "董事会",
        labelEn: "Board",
        layer: "strategic",
        focus: ["strategic goals", "risk appetite", "capability declarations"],
        frequency: "low frequency or on demand",
        switchable: false,
        directSwitch: false,
        signsCredentials: false,
        approve: ["strategy.version", "capability.change", "budget.major-top-up", "arbitration.major", "escalation.strategic", "board.write"],
        independentAudit: false,
    },
    supervisory: {
        id: "supervisory",
        labelZh: "监事会",
        labelEn: "Supervisory board",
        layer: "strategic",
        focus: ["evidence traceability", "receipt self-consistency"],
        frequency: "sampled per scenario",
        switchable: false,
        directSwitch: false,
        signsCredentials: false,
        approve: ["audit.evidence", "audit.archive"],
        independentAudit: true,
    },
    "general-manager": {
        id: "general-manager",
        labelZh: "总经理",
        labelEn: "General manager",
        layer: "management",
        focus: ["switch triggers", "budget consumption", "conflict detection", "scenario and mode approvals"],
        frequency: "resident, high frequency",
        switchable: true,
        directSwitch: true,
        signsCredentials: true,
        approve: [
            "credential.issue",
            "manifest.derive",
            "manifest.focus",
            "scenario.judgement",
            "complexity.grade",
            "mode.weights",
            "escalation.initiate",
            "escalation.audit",
            "arbitration.major",
        ],
        independentAudit: false,
    },
    "customer-service": {
        id: "customer-service",
        labelZh: "客服部",
        labelEn: "Customer service",
        layer: "execution",
        focus: ["user intent", "ambiguities", "constraints", "acceptance criteria", "emotional signals"],
        frequency: "task entry and closing",
        switchable: true,
        directSwitch: true,
        signsCredentials: false,
        approve: ["requirement.complete", "requirement.change", "requirement.satisfaction", "acceptance.criteria"],
        independentAudit: false,
    },
    writing: {
        id: "writing",
        labelZh: "写作视角",
        labelEn: "Writing desk",
        layer: "execution",
        focus: ["structure", "voice", "material selection", "revision"],
        frequency: "activated by the writing scenario",
        switchable: true,
        directSwitch: true,
        signsCredentials: false,
        approve: [],
        independentAudit: false,
    },
    strategy: {
        id: "strategy",
        labelZh: "战略部",
        labelEn: "Strategy",
        layer: "execution",
        focus: ["task decomposition", "dependency structure", "risk points"],
        frequency: "complex tasks",
        switchable: true,
        directSwitch: true,
        signsCredentials: false,
        approve: [],
        independentAudit: false,
    },
    "human-resources": {
        id: "human-resources",
        labelZh: "人力资源部",
        labelEn: "Human resources",
        layer: "rule",
        focus: ["capability fit", "perspective availability", "reliability priors"],
        frequency: "planning and preparation",
        switchable: false,
        directSwitch: false,
        signsCredentials: false,
        approve: ["perspective.assignment", "perspective.routing", "perspective.readiness"],
        independentAudit: false,
    },
    marketing: {
        id: "marketing",
        labelZh: "市场部",
        labelEn: "Market research",
        layer: "execution",
        focus: ["external information needs", "environment assumptions", "competitor, user and policy signals"],
        frequency: "per scenario and mode",
        switchable: true,
        directSwitch: true,
        signsCredentials: false,
        approve: [],
        independentAudit: false,
    },
    technology: {
        id: "technology",
        labelZh: "技术部",
        labelEn: "Technology",
        layer: "execution",
        focus: ["current subgoal", "tool returns", "error logs"],
        frequency: "on demand",
        switchable: true,
        directSwitch: true,
        signsCredentials: false,
        approve: [],
        independentAudit: false,
    },
    legal: {
        id: "legal",
        labelZh: "法务部",
        labelEn: "Legal",
        layer: "execution",
        focus: ["behaviour-code compliance", "boundary signals", "injection traces"],
        frequency: "pre-rules plus on demand",
        switchable: true,
        directSwitch: true,
        signsCredentials: true,
        approve: ["credential.compliance", "manifest.constraints", "manifest.evidence-floor", "manifest.waiver", "tool.high-risk", "board.write", "audit.behavior"],
        independentAudit: false,
    },
    finance: {
        id: "finance",
        labelZh: "财务部",
        labelEn: "Finance",
        layer: "rule",
        focus: ["three-ledger balances", "overrun signals", "elasticity use"],
        frequency: "rule module",
        switchable: false,
        directSwitch: false,
        signsCredentials: true,
        approve: [
            "budget.initial",
            "budget.allocation",
            "budget.freeze",
            "budget.elasticity",
            "budget.top-up",
            "budget.settlement",
            "budget.reserve",
            "budget.major-top-up",
            "audit.budget",
        ],
        independentAudit: false,
    },
    administration: {
        id: "administration",
        labelZh: "行政部",
        labelEn: "Administration",
        layer: "rule",
        focus: ["log integrity", "archive state", "version chains"],
        frequency: "infrastructure",
        switchable: false,
        directSwitch: false,
        signsCredentials: false,
        approve: ["audit.archive"],
        independentAudit: false,
    },
    operations: {
        id: "operations",
        labelZh: "运营部",
        labelEn: "Operations",
        layer: "execution",
        focus: ["phase transitions", "rollback triggers", "timeouts"],
        frequency: "resident during execution",
        switchable: true,
        directSwitch: true,
        signsCredentials: false,
        approve: [],
        independentAudit: false,
    },
};

/**
 * The standing perspectives of section 12.1 (the writing desk is a
 * scenario-specific view and is excluded from the standing count).
 */
export const StandingPerspectives: readonly PerspectiveId[] = [
    "board",
    "supervisory",
    "general-manager",
    "customer-service",
    "strategy",
    "marketing",
    "technology",
    "legal",
    "operations",
];

/**
 * Look up a perspective, failing closed for unknown ids.
 */
export const perspective: (id: string) => PerspectiveDefinition = (id: string): PerspectiveDefinition => {
    if (!PerspectiveIds.includes(id as PerspectiveId)) {
        throw new GovernanceError("unknown-perspective", `${id} is not a registered perspective`);
    }
    return PerspectiveRegistry[id as PerspectiveId];
};

export const isKnownPerspective: (id: string) => id is PerspectiveId = (id: string): id is PerspectiveId => PerspectiveIds.includes(id as PerspectiveId);

/**
 * Rule modules and infrastructure are not switchable perspectives.
 */
export const isRuleModule: (id: PerspectiveId) => boolean = (id: PerspectiveId): boolean => PerspectiveRegistry[id].layer === "rule";

/**
 * Strategic perspectives are reached through escalation, never a same-level
 * switch credential.
 */
export const requiresEscalation: (id: PerspectiveId) => boolean = (id: PerspectiveId): boolean => PerspectiveRegistry[id].layer === "strategic";

export const canApprove: (id: PerspectiveId, subject: ApprovalSubject) => boolean = (id: PerspectiveId, subject: ApprovalSubject): boolean =>
    PerspectiveRegistry[id].approve.includes(subject);

/**
 * Who may approve a subject, in registry order (used for routing refusals).
 */
export const approversOf: (subject: ApprovalSubject) => PerspectiveId[] = (subject: ApprovalSubject): PerspectiveId[] =>
    PerspectiveIds.filter((id: PerspectiveId) => PerspectiveRegistry[id].approve.includes(subject));

/**
 * A same-level switch credential is issued by the general manager to a
 * non-strategic, directly switchable perspective.
 */
export const canIssueCredential: (from: PerspectiveId, to: PerspectiveId) => boolean = (from: PerspectiveId, to: PerspectiveId): boolean => {
    if (from === to) {
        return false;
    }
    if (from !== "general-manager") {
        return false;
    }
    const target: PerspectiveDefinition = PerspectiveRegistry[to];
    return target.directSwitch && target.switchable && target.layer === "execution";
};

/**
 * Which strategic target an escalation type may reach.
 */
export const escalationTarget: (type: "audit" | "strategy" | "final" | "compliance") => PerspectiveId = (
    type: "audit" | "strategy" | "final" | "compliance",
): PerspectiveId => {
    switch (type) {
        case "audit":
            return "supervisory";
        case "strategy":
            return "board";
        case "final":
            return "shareholders";
        case "compliance":
            return "legal";
        default:
            return "general-manager";
    }
};

/**
 * Scenario activation for one perspective (spec section 9.8).
 */
export const activationFor: (id: PerspectiveId, scenario: ScenarioId) => Activation = (id: PerspectiveId, scenario: ScenarioId): Activation => {
    const plan: ScenarioPerspectives = PerspectiveActivationTable[scenario];
    if (plan.default.includes(id)) {
        return "default";
    }
    if (plan.onDemand.includes(id)) {
        return "on-demand";
    }
    return "dormant";
};

/**
 * The activation plan for a scenario, with copies so callers cannot mutate the
 * table.
 */
export const perspectivesForScenario: (scenario: ScenarioId) => ScenarioPerspectives = (scenario: ScenarioId): ScenarioPerspectives => {
    const plan: ScenarioPerspectives = PerspectiveActivationTable[scenario];
    return {
        default: [...plan.default],
        onDemand: [...plan.onDemand],
        dormant: [...plan.dormant],
        ...(plan.note === (void 0) ? {} : { note: plan.note }),
    };
};

/**
 * Registry self-check; used by checks and on first import in development.
 */
export const validatePerspectiveRegistry: () => string[] = (): string[] => {
    const problems: string[] = [];
    const seen: Set<string> = new Set<string>();
    for (let index: number = 0; index < PerspectiveIds.length; index += 1) {
        const id: PerspectiveId = PerspectiveIds[index];
        if (seen.has(id)) {
            problems.push(`duplicate perspective id: ${id}`);
        }
        seen.add(id);
        const definition: PerspectiveDefinition | undefined = PerspectiveRegistry[id];
        if (definition === (void 0)) {
            problems.push(`missing registry row: ${id}`);
            continue;
        }
        if (definition.id !== id) {
            problems.push(`registry key ${id} disagrees with row id ${definition.id}`);
        }
        if (definition.layer === "rule" && definition.switchable) {
            problems.push(`rule module ${id} must not be switchable`);
        }
        if (definition.layer === "strategic" && definition.directSwitch) {
            problems.push(`strategic perspective ${id} must not be a direct switch target`);
        }
        if (definition.signsCredentials && !["general-manager", "legal", "finance"].includes(id)) {
            problems.push(`${id} must not counter-sign credentials`);
        }
    }
    if (!PerspectiveIds.includes("general-manager")) {
        problems.push("the registry must contain the general manager");
    }
    return problems;
};
