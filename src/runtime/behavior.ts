/**
 * Behavior = durable, context-conditioned policy. It selects/constrains
 * actions; it never executes operations directly.
 */
import type { UserScore } from "../bayes/engine.ts";
import type { ScenarioPlan } from "../scenario/scenario.ts";
import type { InteractionPlan } from "../interaction/interaction.ts";
import type { AttentionPlan } from "../attention/resource.ts";
import type { ActionRisk } from "./action.ts";

export type BehaviorId = string;

export interface BehaviorTrigger {
    scenario?: string[];
    interaction?: string[];
    minUncertainty?: number;
    maxAttentionHealth?: number;
    risk?: "none" | "read" | "write" | "destructive";
    textPattern?: string;
}

export interface BehaviorPolicy {
    preferActions?: string[];
    forbidOperations?: string[];
    requireApproval?: boolean;
    maxActionsPerTurn?: number;
    /**
     * Hard guardrails cannot be outvoted; only their action preference competes.
     */
    hardGuardrail?: boolean;
}

export interface Behavior {
    id: BehaviorId;
    name: string;
    /**
     * Higher wins when two soft/hard behaviors prefer different actions.
     */
    priority: number;
    trigger: BehaviorTrigger;
    policy: BehaviorPolicy;
    guardrails: string[];
    metrics: string[];
    version: number;
}

export interface BehaviorActivation {
    behaviorId: BehaviorId;
    turnId: string;
    trigger: string;
    confidence: number;
    priority: number;
}

export interface BehaviorConflict {
    winner: BehaviorId;
    loser: BehaviorId;
    reason: string;
    winnerPriority: number;
    loserPriority: number;
}

export interface BehaviorPlan {
    activations: BehaviorActivation[];
    guardrails: string[];
    maxActionsPerTurn: number;
    preferredActions: string[];
    winner?: BehaviorId;
    conflicts: BehaviorConflict[];
}

export interface BehaviorContext {
    turnId: string;
    text: string;
    user: UserScore;
    scenario: ScenarioPlan;
    interaction: InteractionPlan;
    attention: AttentionPlan;
    risk?: ActionRisk;
}

export interface BehaviorMatch {
    matched: boolean;
    reason: string;
    confidence: number;
}

export interface BehaviorRule {
    behavior: Behavior;
    match(context: BehaviorContext): BehaviorMatch;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const builtin = (
    id: string,
    name: string,
    priority: number,
    policy: BehaviorPolicy,
    guardrails: string[],
    match: (context: BehaviorContext) => BehaviorMatch,
): BehaviorRule => ({
    behavior: { id, name, priority, trigger: {}, policy, guardrails, metrics: [], version: 1 },
    match,
});

/**
 * Six conservative defaults; they are trace-only until an ActionPlanner uses them.
 */
export const DefaultBehaviors: readonly BehaviorRule[] = [
    builtin(
        "clarify_when_uncertain",
        "Clarify when uncertain",
        75,
        { preferActions: ["clarify"], maxActionsPerTurn: 1 },
        ["ask one focused question when the request is underspecified"],
        (context) => {
            const clarity = context.user.dimensions.clarity.mean;
            const sufficiency = context.user.dimensions.contextSufficiency.mean;
            const shortRequest = context.text.trim().split(/\s+/).length <= 4;
            const matched = (shortRequest && clarity < 0.55) || sufficiency < 0.4;
            return {
                matched,
                reason: `clarity=${clarity.toFixed(2)} sufficiency=${sufficiency.toFixed(2)} short=${shortRequest}`,
                confidence: clamp01(1 - Math.min(clarity, sufficiency)),
            };
        },
    ),
    builtin(
        "evidence_before_claim",
        "Evidence before claim",
        70,
        { preferActions: ["retrieve_evidence", "verify"], maxActionsPerTurn: 3 },
        ["do not assert external facts without evidence", "mark inference as inference"],
        (context) => {
            const matched = context.scenario.active.some((kind) => ["research", "investigation", "engineering"].includes(kind));
            return { matched, reason: `scenario=${context.scenario.active.join(",")}`, confidence: matched ? 0.7 : 0.2 };
        },
    ),
    builtin(
        "approval_before_destructive",
        "Approval before destructive operation",
        100,
        { requireApproval: true, maxActionsPerTurn: 3, hardGuardrail: true },
        ["destructive operations require explicit approval", "refuse unapproved destructive operations"],
        (context) => ({
            matched: context.risk === "destructive" || context.scenario.active.includes("engineering"),
            reason: context.risk === "destructive" ? "destructive risk" : "engineering scenario baseline",
            confidence: context.risk === "destructive" ? 0.95 : 0.5,
        }),
    ),
    builtin(
        "affect_then_converge",
        "Affect then converge",
        80,
        { preferActions: ["acknowledge", "clarify", "converge"], maxActionsPerTurn: 2 },
        ["acknowledge affect before giving steps", "do not diagnose"],
        (context) => {
            const emotion = context.user.state.emotionalIntensity;
            const urgency = context.user.state.urgency;
            const affectText = /\b(overwhelmed|anxious|panic|scared|afraid|stressed|sad|angry|frustrated|lonely|grief)\w*\b/i.test(context.text);
            return {
                matched: affectText || emotion > 0.55 || urgency > 0.65,
                reason: `emotion=${emotion.toFixed(2)} urgency=${urgency.toFixed(2)} affectText=${affectText}`,
                confidence: clamp01(Math.max(emotion, urgency)),
            };
        },
    ),
    builtin(
        "rest_when_fatigued",
        "Rest when fatigued",
        90,
        { preferActions: ["rest", "defer"], maxActionsPerTurn: 1, hardGuardrail: true },
        ["suggest rest instead of pushing through low attention health"],
        (context) => ({
            matched: context.attention.rest || context.attention.utilization > 0.85,
            reason: `rest=${context.attention.rest} utilization=${context.attention.utilization.toFixed(2)}`,
            confidence: clamp01(context.attention.utilization),
        }),
    ),
    builtin(
        "no_diagnosis",
        "No diagnosis",
        100,
        { forbidOperations: ["medical.diagnose"], maxActionsPerTurn: 3, hardGuardrail: true },
        ["do not diagnose or claim a therapeutic relationship"],
        (context) => ({
            matched: context.user.state.emotionalIntensity > 0.3 || /\b(feel|anxious|depress|therapy|diagnos|overwhelmed|panic|grief)\w*\b/i.test(context.text),
            reason: "affect/health-adjacent language",
            confidence: 0.8,
        }),
    ),
];

export class BehaviorRegistry {
    private readonly rules: BehaviorRule[] = [];
    private tuningVersion = 0;
    private readonly tuningSnapshots: Array<{ version: number; priorities: Record<string, number>; }> = [];

    constructor(rules: readonly BehaviorRule[] = DefaultBehaviors) {
        for (const rule of rules) {
            this.register(rule);
        }
    }

    register(rule: BehaviorRule): this {
        if (this.rules.some((entry) => entry.behavior.id === rule.behavior.id)) {
            throw new Error(`duplicate behavior ${rule.behavior.id}`);
        }
        this.rules.push(rule);
        return this;
    }

    list(): Behavior[] {
        return this.rules.map((rule) => rule.behavior);
    }

    /**
     * Apply reviewed priority changes; hard guardrails are never lowered.
     */
    applyPriorities(changes: Readonly<Record<string, number>>): { version: number; applied: Array<{ id: string; from: number; to: number; }>; } {
        const priorities: Record<string, number> = {};
        for (const rule of this.rules) {
            priorities[rule.behavior.id] = rule.behavior.priority;
        }
        this.tuningSnapshots.push({ version: this.tuningVersion, priorities });
        const applied: Array<{ id: string; from: number; to: number; }> = [];
        for (let index = 0; index < this.rules.length; index += 1) {
            const rule = this.rules[index];
            const requested = changes[rule.behavior.id];
            if (requested === (void 0)) {
                continue;
            }
            const next = Math.max(0, Math.min(100, requested));
            if (rule.behavior.policy.hardGuardrail === true && next < rule.behavior.priority) {
                continue;
            }
            if (next === rule.behavior.priority) {
                continue;
            }
            applied.push({ id: rule.behavior.id, from: rule.behavior.priority, to: next });
            this.rules[index] = { ...rule, behavior: { ...rule.behavior, priority: next, version: rule.behavior.version + 1 } };
        }
        if (applied.length > 0) {
            this.tuningVersion += 1;
        }
        return { version: this.tuningVersion, applied };
    }

    /**
     * Roll back to the snapshot before `version`; returns false if unknown.
     */
    rollbackPriorities(version: number): boolean {
        const snapshot = [...this.tuningSnapshots].reverse().find((entry) => entry.version === version - 1);
        if (snapshot === (void 0)) {
            return false;
        }
        for (let index = 0; index < this.rules.length; index += 1) {
            const rule = this.rules[index];
            const priority = snapshot.priorities[rule.behavior.id];
            if (priority === (void 0) || priority === rule.behavior.priority) {
                continue;
            }
            this.rules[index] = { ...rule, behavior: { ...rule.behavior, priority, version: rule.behavior.version + 1 } };
        }
        this.tuningVersion += 1;
        return true;
    }

    tuning(): number {
        return this.tuningVersion;
    }

    select(context: BehaviorContext): BehaviorPlan {
        const activations: BehaviorActivation[] = [];
        const guardrails = new Set<string>();
        let maxActionsPerTurn = 3;
        const contenders: Array<{ activation: BehaviorActivation; rule: BehaviorRule; }> = [];
        for (const rule of this.rules) {
            const result = rule.match(context);
            if (!result.matched) {
                continue;
            }
            const activation: BehaviorActivation = {
                behaviorId: rule.behavior.id,
                turnId: context.turnId,
                trigger: result.reason,
                confidence: result.confidence,
                priority: rule.behavior.priority,
            };
            activations.push(activation);
            for (const guardrail of rule.behavior.guardrails) {
                guardrails.add(guardrail);
            }
            if (rule.behavior.policy.maxActionsPerTurn !== (void 0)) {
                maxActionsPerTurn = Math.min(maxActionsPerTurn, rule.behavior.policy.maxActionsPerTurn);
            }
            if ((rule.behavior.policy.preferActions ?? []).length > 0) {
                contenders.push({ activation, rule });
            }
        }
        contenders.sort((left, right) => right.activation.priority - left.activation.priority || right.activation.confidence - left.activation.confidence);
        const winner = contenders[0];
        const preferredActions = winner === (void 0) ? [] : [...(winner.rule.behavior.policy.preferActions ?? [])];
        const conflicts: BehaviorConflict[] = [];
        if (winner !== (void 0)) {
            for (const loser of contenders.slice(1)) {
                const loserActions = loser.rule.behavior.policy.preferActions ?? [];
                if (JSON.stringify(loserActions) === JSON.stringify(preferredActions)) {
                    continue;
                }
                conflicts.push({
                    winner: winner.activation.behaviorId,
                    loser: loser.activation.behaviorId,
                    reason: `preferred actions ${preferredActions.join(",")} vs ${loserActions.join(",")}`,
                    winnerPriority: winner.activation.priority,
                    loserPriority: loser.activation.priority,
                });
            }
        }
        return {
            activations,
            guardrails: [...guardrails],
            maxActionsPerTurn: Math.max(1, maxActionsPerTurn),
            preferredActions,
            ...(winner === (void 0) ? {} : { winner: winner.activation.behaviorId }),
            conflicts,
        };
    }
}
