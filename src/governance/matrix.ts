/**
 * The scenario x interaction-mode matrix (spec sections 9.1-9.8).
 *
 * This module is the single source of truth for the five canonical scenarios,
 * their default mode weights, and the four derived tables the rest of the
 * governance layer reads: evidence floor, ignored-item revisit cadence, budget
 * elasticity and escalation sensitivity. It also owns the perspective
 * activation table and the adapters to the legacy weighted scenario and
 * interaction modules, so no caller has to duplicate a table.
 */
import type { InteractionKind, InteractionMix } from "../interaction/interaction.ts";
import type { ScenarioKind, ScenarioMix } from "../scenario/scenario.ts";
import type { EvidenceFloor, Elasticity, GateStrictness, ModeId, ModeWeights, PerspectiveId, ScenarioId, Sensitivity, Tier } from "./types.ts";
import { FloorRank, FloorTier, GovernanceError, ModeIds, ScenarioIds, SensitivityRank } from "./types.ts";

/**
 * Default weights, copied exactly from spec section 9.1. Each row sums to 1.
 */
export const DefaultModeWeights: Record<ScenarioId, ModeWeights> = {
    chat: { affect: 0.5, think: 0.2, diverge: 0.2, converge: 0.1 },
    writing: { affect: 0.1, think: 0.2, diverge: 0.5, converge: 0.2 },
    office: { affect: 0.1, think: 0.3, diverge: 0.1, converge: 0.5 },
    research: { affect: 0.05, think: 0.4, diverge: 0.4, converge: 0.15 },
    engineering: { affect: 0.05, think: 0.35, diverge: 0.1, converge: 0.5 },
};

/**
 * Evidence floors per scenario and mode (spec section 9.4), translated from
 * the description's T1/T2/T3 wording into the governance F1/F2/F3 order.
 */
export const EvidenceFloorTable: Record<ScenarioId, Record<ModeId, EvidenceFloor>> = {
    chat: { affect: "F3", think: "F3", diverge: "F3", converge: "F3" },
    writing: { affect: "F3", think: "F2", diverge: "F3", converge: "F2" },
    office: { affect: "F2", think: "F2", diverge: "F2", converge: "F2" },
    research: { affect: "F2", think: "F1", diverge: "F2", converge: "F2" },
    engineering: { affect: "F2", think: "F1", diverge: "F2", converge: "F1" },
};

/**
 * Frame cadence for re-evaluating ignored items (spec section 9.5).
 */
export const RevisitIntervalTable: Record<ScenarioId, Record<ModeId, number>> = {
    chat: { affect: 10, think: 5, diverge: 8, converge: 10 },
    writing: { affect: 8, think: 5, diverge: 2, converge: 4 },
    office: { affect: 8, think: 4, diverge: 6, converge: 4 },
    research: { affect: 10, think: 3, diverge: 2, converge: 4 },
    engineering: { affect: 10, think: 3, diverge: 4, converge: 2 },
};

/**
 * Budget elasticity per scenario and mode (spec section 9.6).
 */
export const ElasticityTable: Record<ScenarioId, Record<ModeId, Elasticity>> = {
    chat: { affect: "low", think: "low", diverge: "medium", converge: "low" },
    writing: { affect: "low", think: "medium", diverge: "high", converge: "medium" },
    office: { affect: "low", think: "medium", diverge: "low", converge: "medium" },
    research: { affect: "low", think: "high", diverge: "high", converge: "medium" },
    engineering: { affect: "low", think: "high", diverge: "medium", converge: "high" },
};

/**
 * Escalation-trigger sensitivity (spec section 9.7).
 */
export const SensitivityTable: Record<ScenarioId, Record<ModeId, Sensitivity>> = {
    chat: { affect: "very-low", think: "low", diverge: "low", converge: "low" },
    writing: { affect: "low", think: "medium", diverge: "low", converge: "medium" },
    office: { affect: "low", think: "medium", diverge: "medium", converge: "medium" },
    research: { affect: "medium", think: "high", diverge: "medium", converge: "high" },
    engineering: { affect: "medium", think: "high", diverge: "medium", converge: "high" },
};

/**
 * Activation plan for one scenario (spec section 9.8).
 */
export interface ScenarioPerspectives {
    default: PerspectiveId[];
    onDemand: PerspectiveId[];
    dormant: PerspectiveId[];
    note?: string;
}

/**
 * Which perspectives a scenario activates by default.
 */
export const PerspectiveActivationTable: Record<ScenarioId, ScenarioPerspectives> = {
    chat: {
        default: ["customer-service"],
        onDemand: ["marketing"],
        dormant: ["strategy", "technology", "supervisory", "board"],
        note: "Market research is rare in chat and stays dormant most of the time.",
    },
    writing: {
        default: ["customer-service", "writing"],
        onDemand: ["marketing", "strategy"],
        dormant: ["technology", "supervisory"],
    },
    office: {
        default: ["customer-service", "operations"],
        onDemand: ["finance", "legal"],
        dormant: ["strategy", "technology", "marketing"],
    },
    research: {
        default: ["customer-service", "strategy", "marketing"],
        onDemand: ["technology", "supervisory"],
        dormant: ["operations"],
    },
    engineering: {
        default: ["customer-service", "technology", "operations"],
        onDemand: ["legal", "supervisory", "strategy"],
        dormant: ["marketing"],
        note: "Marketing is dormant but can be pulled in for user-facing impact review.",
    },
};

/**
 * How one mode bends a manifest (spec section 9.2).
 */
export interface ModeAdjustment {
    focusBias: "narrow" | "neutral" | "broad";
    focusDelta: number;
    revisitMultiplier: number;
    elasticityBias: -1 | 0 | 1;
    gateBias: -1 | 0 | 1;
    note: string;
}

export const ModeAdjustments: Record<ModeId, ModeAdjustment> = {
    affect: {
        focusBias: "narrow",
        focusDelta: 0,
        revisitMultiplier: 1,
        elasticityBias: 0,
        gateBias: -1,
        note: "Focus on emotional signals and relationship maintenance; loosen the gate, keep behaviour conservative.",
    },
    think: {
        focusBias: "neutral",
        focusDelta: 0,
        revisitMultiplier: 1,
        elasticityBias: 0,
        gateBias: 1,
        note: "Focus on the evidence chain and causal structure; raise the check frequency.",
    },
    diverge: {
        focusBias: "broad",
        focusDelta: 2,
        revisitMultiplier: 0.5,
        elasticityBias: 1,
        gateBias: 0,
        note: "Widen the focus set, revisit ignored items twice as often, allow more budget slack.",
    },
    converge: {
        focusBias: "narrow",
        focusDelta: -2,
        revisitMultiplier: 1.5,
        elasticityBias: -1,
        gateBias: 0,
        note: "Shrink the focus to the candidate set, tighten the budget, make escalation triggers more sensitive.",
    },
};

/**
 * The resolved matrix row for one task.
 */
export interface ScenarioModePlan {
    scenario: ScenarioId;
    modes: ModeWeights;
    dominant: ModeId;
    secondary: ModeId;
    active: ModeId[];
    evidenceFloor: EvidenceFloor;
    requiredTier: Tier;
    revisitEvery: number;
    elasticity: Elasticity;
    sensitivity: Sensitivity;
    gateStrictness: GateStrictness;
    focusLimit: number;
    rationale: string;
}

const ElasticityRank: Record<Elasticity, number> = { low: 0, medium: 1, high: 2 };

const GateStrictnessByScenario: Record<ScenarioId, GateStrictness> = {
    chat: "loose",
    writing: "medium",
    office: "medium",
    research: "medium-strict",
    engineering: "strict",
};

const ActiveThreshold: number = 0.15;

/**
 * Validate a scenario id at runtime; unknown values fail closed.
 */
export const requireScenario: (value: string) => ScenarioId = (value: string): ScenarioId => {
    if (!ScenarioIds.includes(value as ScenarioId)) {
        throw new GovernanceError("invalid-scenario", `${value} is not a canonical scenario`);
    }
    return value as ScenarioId;
};

/**
 * Normalize a partial weight vector onto the mode simplex.
 *
 * Negative, non-finite and all-zero vectors are rejected: a manifest without a
 * mode is not a valid manifest.
 */
export const normalizeModeWeights: (input: Partial<ModeWeights>) => ModeWeights = (input: Partial<ModeWeights>): ModeWeights => {
    const result: ModeWeights = { affect: 0, think: 0, diverge: 0, converge: 0 };
    let total: number = 0;
    for (let index: number = 0; index < ModeIds.length; index += 1) {
        const mode: ModeId = ModeIds[index];
        const raw: number = input[mode] ?? 0;
        if (!Number.isFinite(raw) || raw < 0) {
            throw new GovernanceError("invalid-mode-weights", `${mode} must be a finite non-negative number`);
        }
        result[mode] = raw;
        total += raw;
    }
    if (total <= 0) {
        throw new GovernanceError("invalid-mode-weights", "at least one mode weight must be positive");
    }
    for (let index: number = 0; index < ModeIds.length; index += 1) {
        const mode: ModeId = ModeIds[index];
        result[mode] = result[mode] / total;
    }
    return result;
};

/**
 * Modes sorted by weight, descending; ties keep the canonical order.
 */
export const rankModes: (weights: ModeWeights) => ModeId[] = (weights: ModeWeights): ModeId[] => {
    const ranked: ModeId[] = [...ModeIds];
    ranked.sort((left: ModeId, right: ModeId) => weights[right] - weights[left] || ModeIds.indexOf(left) - ModeIds.indexOf(right));
    return ranked;
};

export const dominantMode: (weights: ModeWeights) => ModeId = (weights: ModeWeights): ModeId => rankModes(weights)[0];

/**
 * Modes receiving at least 15% of attention. One mode always qualifies
 * because the vector sums to 1.
 */
export const activeModes: (weights: ModeWeights, threshold?: number) => ModeId[] = (weights: ModeWeights, threshold: number = ActiveThreshold): ModeId[] => {
    const active: ModeId[] = ModeIds.filter((mode: ModeId) => weights[mode] >= threshold);
    return active.length === 0 ? [dominantMode(weights)] : active;
};

/**
 * Strictest floor across the active modes: a mixed task inherits the hardest
 * evidence demand, never the easiest.
 */
export const evidenceFloorFor: (scenario: ScenarioId, weights: ModeWeights) => EvidenceFloor = (scenario: ScenarioId, weights: ModeWeights): EvidenceFloor => {
    const modes: ModeId[] = activeModes(weights);
    let strictest: EvidenceFloor = "F3";
    for (let index: number = 0; index < modes.length; index += 1) {
        const floor: EvidenceFloor = EvidenceFloorTable[scenario][modes[index]];
        if (FloorRank[floor] < FloorRank[strictest]) {
            strictest = floor;
        }
    }
    return strictest;
};

/**
 * Revisit cadence for ignored items: the most frequent cadence among active
 * modes, so a divergence-heavy mix does not let ignored items go stale.
 */
export const revisitIntervalFor: (scenario: ScenarioId, weights: ModeWeights) => number = (scenario: ScenarioId, weights: ModeWeights): number => {
    const modes: ModeId[] = activeModes(weights);
    let interval: number = Number.POSITIVE_INFINITY;
    for (let index: number = 0; index < modes.length; index += 1) {
        interval = Math.min(interval, RevisitIntervalTable[scenario][modes[index]]);
    }
    return Math.max(2, Number.isFinite(interval) ? interval : 10);
};

/**
 * Budget elasticity: the most restrictive active mode wins, unless a mode
 * explicitly raises it and no other mode forbids it. Safety-first by design.
 */
export const elasticityFor: (scenario: ScenarioId, weights: ModeWeights) => Elasticity = (scenario: ScenarioId, weights: ModeWeights): Elasticity => {
    const modes: ModeId[] = activeModes(weights);
    let elasticity: Elasticity = "high";
    for (let index: number = 0; index < modes.length; index += 1) {
        const candidate: Elasticity = ElasticityTable[scenario][modes[index]];
        if (ElasticityRank[candidate] < ElasticityRank[elasticity]) {
            elasticity = candidate;
        }
    }
    return elasticity;
};

/**
 * Escalation sensitivity: the most sensitive active mode wins.
 */
export const sensitivityFor: (scenario: ScenarioId, weights: ModeWeights) => Sensitivity = (scenario: ScenarioId, weights: ModeWeights): Sensitivity => {
    const modes: ModeId[] = activeModes(weights);
    let sensitivity: Sensitivity = "very-low";
    for (let index: number = 0; index < modes.length; index += 1) {
        const candidate: Sensitivity = SensitivityTable[scenario][modes[index]];
        if (SensitivityRank[candidate] > SensitivityRank[sensitivity]) {
            sensitivity = candidate;
        }
    }
    return sensitivity;
};

/**
 * Focus-set size: divergence widens it, convergence shrinks it (spec 9.2).
 */
export const focusLimitFor: (weights: ModeWeights) => number = (weights: ModeWeights): number => {
    const raw: number = 3 + Math.round(4 * weights.diverge) - Math.round(2 * weights.converge);
    return Math.max(1, Math.min(9, raw));
};

export const gateStrictnessFor: (scenario: ScenarioId) => GateStrictness = (scenario: ScenarioId): GateStrictness => GateStrictnessByScenario[scenario];

/**
 * Resolve a scenario and optional mode override into the full matrix row.
 */
type ResolveScenarioModes = (scenario: ScenarioId, override?: Partial<ModeWeights>) => ScenarioModePlan;

export const resolveScenarioModes: ResolveScenarioModes = (scenario, override) => {
    const checked: ScenarioId = requireScenario(scenario);
    const modes: ModeWeights = override === (void 0) ? { ...DefaultModeWeights[checked] } : normalizeModeWeights(override);
    const ranked: ModeId[] = rankModes(modes);
    const floor: EvidenceFloor = evidenceFloorFor(checked, modes);
    const plan: ScenarioModePlan = {
        scenario: checked,
        modes,
        dominant: ranked[0],
        secondary: ranked[1],
        active: activeModes(modes),
        evidenceFloor: floor,
        requiredTier: FloorTier[floor],
        revisitEvery: revisitIntervalFor(checked, modes),
        elasticity: elasticityFor(checked, modes),
        sensitivity: sensitivityFor(checked, modes),
        gateStrictness: gateStrictnessFor(checked),
        focusLimit: focusLimitFor(modes),
        rationale: `${checked} -> ${ranked
            .slice(0, 2)
            .map((mode: ModeId) => `${mode} ${modes[mode].toFixed(2)}`)
            .join(
                " + ",
            )}; floor ${floor} (${FloorTier[floor]}), revisit every ${revisitIntervalFor(checked, modes)} frames, elasticity ${elasticityFor(checked, modes)}`,
    };
    return plan;
};

/**
 * Active-mode adjustments, used by the manifest deriver to explain itself.
 */
export const modeAdjustments: (weights: ModeWeights) => Array<{ mode: ModeId; weight: number; adjustment: ModeAdjustment; }> = (
    weights: ModeWeights,
): Array<{ mode: ModeId; weight: number; adjustment: ModeAdjustment; }> => {
    const active: ModeId[] = activeModes(weights);
    return active.map((mode: ModeId) => ({ mode, weight: weights[mode], adjustment: ModeAdjustments[mode] }));
};

/**
 * Largest single-dimension drift between two weight vectors.
 */
export const modeDrift: (from: ModeWeights, to: ModeWeights) => number = (from: ModeWeights, to: ModeWeights): number => {
    let drift: number = 0;
    for (let index: number = 0; index < ModeIds.length; index += 1) {
        const mode: ModeId = ModeIds[index];
        drift = Math.max(drift, Math.abs(from[mode] - to[mode]));
    }
    return drift;
};

/**
 * Mode changes above 0.15 need the general manager's approval (spec 9.3).
 */
export const driftRequiresApproval: (from: ModeWeights, to: ModeWeights) => boolean = (from: ModeWeights, to: ModeWeights): boolean =>
    modeDrift(from, to) > 0.15 + 1e-9;

/**
 * A scenario change always re-derives the manifest; it is never a patch.
 */
export const scenarioChangeRequiresRederive: (from: ScenarioId, to: ScenarioId) => boolean = (from: ScenarioId, to: ScenarioId): boolean => from !== to;

/**
 * Bridge: the five canonical scenarios all exist as legacy scenario kinds.
 */
export const legacyScenarioMix: (scenario: ScenarioId) => ScenarioMix = (scenario: ScenarioId): ScenarioMix => {
    const mix: ScenarioMix = {};
    mix[scenario as ScenarioKind] = 1;
    return mix;
};

/**
 * Bridge: map a legacy eight-kind mix onto its dominant canonical scenario.
 */
export const canonicalScenarioOf: (mix: ScenarioMix) => ScenarioId = (mix: ScenarioMix): ScenarioId => {
    const legacy: Partial<Record<ScenarioKind, number>> = mix as Partial<Record<ScenarioKind, number>>;
    const order: readonly ScenarioKind[] = ["chat", "writing", "office", "collaboration", "investigation", "research", "engineering", "iteration"];
    let best: ScenarioKind = "chat";
    let bestWeight: number = 0;
    for (let index: number = 0; index < order.length; index += 1) {
        const kind: ScenarioKind = order[index];
        const weight: number = legacy[kind] ?? 0;
        if (weight > bestWeight) {
            best = kind;
            bestWeight = weight;
        }
    }
    if (bestWeight <= 0) {
        throw new GovernanceError("invalid-scenario", "a scenario mix must contain at least one positive weight");
    }
    return scenarioOfLegacy(best);
};

/**
 * Bridge: collapse the three scenario kinds that have no canonical peer.
 */
export const scenarioOfLegacy: (kind: ScenarioKind) => ScenarioId = (kind: ScenarioKind): ScenarioId => {
    switch (kind) {
        case "collaboration":
            return "office";
        case "investigation":
            return "research";
        case "iteration":
            return "engineering";
        default:
            return kind;
    }
};

/**
 * Bridge: the legacy interaction vocabulary uses `inspire` where governance
 * says `diverge`.
 */
export const legacyInteractionMix: (weights: ModeWeights) => InteractionMix = (weights: ModeWeights): InteractionMix => {
    const mapping: Record<ModeId, InteractionKind> = { affect: "affect", think: "think", diverge: "inspire", converge: "converge" };
    const mix: InteractionMix = {};
    for (let index: number = 0; index < ModeIds.length; index += 1) {
        const mode: ModeId = ModeIds[index];
        mix[mapping[mode]] = weights[mode];
    }
    return mix;
};

/**
 * Bridge: derive governance modes from a legacy interaction mix. Missing
 * `orchestrate` weight is folded into `converge`, the planning mode.
 */
export const modesFromLegacyInteraction: (mix: InteractionMix) => ModeWeights = (mix: InteractionMix): ModeWeights => {
    const orchestrate: number = mix.orchestrate ?? 0;
    return normalizeModeWeights({
        affect: mix.affect ?? 0,
        think: mix.think ?? 0,
        diverge: mix.inspire ?? 0,
        converge: (mix.converge ?? 0) + orchestrate,
    });
};
