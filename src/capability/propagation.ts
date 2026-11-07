import type { Identifier } from "../shared.ts";
import { isSkillState } from "./lifecycle.ts";
import type { CapabilityLifecycleRecord, CapabilityReference, SkillState } from "./types.ts";

/** Default multiplier applied to a Skill's selection weight when cognition/behavior support weakens. */
export const DEFAULT_SKILL_WEIGHT_REDUCTION = 0.5;

/** Where a propagation impact originated. */
export type CapabilitySignalSource = {
    readonly kind: "tool" | "cognition" | "behavior";
    readonly id: Identifier;
    readonly version?: string;
    readonly state: string;
};

/**
 * One declarative Skill impact. The functions in this module are pure: they
 * compute what should happen but never mutate a registry or a Skill record.
 * The caller applies `cooling` / `failed` through
 * {@link CapabilityLifecycleRegistry.transition} and treats `weight_reduced` as
 * a selection-time multiplier.
 */
export type SkillPropagationImpact = {
    readonly skillId: Identifier;
    readonly version: string;
    readonly from: SkillState;
    readonly action: "cooling" | "failed" | "weight_reduced";
    /** Present for lifecycle actions, absent for weight-only adjustments. */
    readonly to?: SkillState;
    /** Present only for `weight_reduced`: multiply the Skill's selection weight by this factor. */
    readonly weightMultiplier?: number;
    readonly reason: string;
    readonly causedBy: CapabilitySignalSource;
};

export type ToolLifecycleSignal = {
    readonly id: Identifier;
    readonly version?: string;
    readonly state: "degraded" | "unavailable";
};

export type CognitionLifecycleSignal = {
    readonly id: Identifier;
    readonly version?: string;
    readonly state: "demoted";
};

export type BehaviorLifecycleSignal = {
    readonly id: Identifier;
    readonly version?: string;
    readonly state: "cooling";
};

export type CapabilityLifecycleSignal =
    | ({ readonly kind: "tool" } & ToolLifecycleSignal)
    | ({ readonly kind: "cognition" } & CognitionLifecycleSignal)
    | ({ readonly kind: "behavior" } & BehaviorLifecycleSignal);

/** The subset of a lifecycle record the propagation functions read. */
export type SkillPropagationTarget = Pick<
    CapabilityLifecycleRecord,
    "capabilityId" | "version" | "kind" | "state" | "references"
>;

const lifecycleActions: Readonly<Record<string, readonly SkillState[]>> = Object.freeze({
    cooling: Object.freeze(["ready", "active"] as SkillState[]),
    failed: Object.freeze(["binding", "ready", "cooling", "active"] as SkillState[]),
});

const weightedActions: readonly SkillState[] = Object.freeze(["binding", "ready", "cooling", "active"] as SkillState[]);

const matches = (reference: CapabilityReference, id: Identifier, version: string | undefined): boolean =>
    reference.id === id && (version === undefined || reference.version === undefined || reference.version === version);

const tag = (id: Identifier, version: string | undefined): string => version === undefined ? id : `${id}@${version}`;

const reasonOf = (signal: CapabilityLifecycleSignal): string => {
    switch (signal.kind) {
        case "tool": return `tool ${signal.state}: ${tag(signal.id, signal.version)}`;
        case "cognition": return `cognition demoted: ${tag(signal.id, signal.version)}`;
        case "behavior": return `behavior cooling: ${tag(signal.id, signal.version)}`;
    }
};

const sourceOf = (signal: CapabilityLifecycleSignal): CapabilitySignalSource => Object.freeze({
    kind: signal.kind,
    id: signal.id,
    state: signal.state,
    ...(signal.version === undefined ? {} : { version: signal.version }),
});

const skillState = (target: SkillPropagationTarget): SkillState | undefined => {
    if (target.kind !== "skill") return undefined;
    return isSkillState(target.state) ? target.state : undefined;
};

/**
 * Computes the Skill impacts of one Tool / Cognition / Behavior signal
 * (refract §6.7).
 *
 * - `tool degraded` cools dependents that are `ready` or `active`;
 * - `tool unavailable` fails dependents in `binding` / `ready` / `cooling` / `active`;
 * - `cognition demoted` and `behavior cooling` reduce the weight of every
 *   non-terminal Skill that references them.
 *
 * A Skill is reported at most once per signal even when it references the
 * capability through several entries, and the output preserves the input
 * order of `skills`. No record is mutated.
 */
export function propagateSkillImpacts(
    signal: CapabilityLifecycleSignal,
    skills: readonly SkillPropagationTarget[],
): readonly SkillPropagationImpact[] {
    if (typeof signal !== "object" || signal === null) throw new TypeError("Capability lifecycle signal must be an object");
    if (typeof signal.id !== "string" || signal.id.trim().length === 0) throw new TypeError("Capability lifecycle signal id must be a nonempty string");
    if (signal.version !== undefined && (typeof signal.version !== "string" || signal.version.trim().length === 0)) throw new TypeError("Capability lifecycle signal version must be a nonempty string");
    const expectedStates: readonly string[] = signal.kind === "tool" ? ["degraded", "unavailable"] : signal.kind === "cognition" ? ["demoted"] : ["cooling"];
    if (!expectedStates.includes(signal.state)) throw new TypeError(`invalid ${signal.kind} propagation state: ${String(signal.state)}`);
    if (!Array.isArray(skills)) throw new TypeError("Skill propagation targets must be an array");
    const reason = reasonOf(signal);
    const causedBy = sourceOf(signal);
    const impacts: SkillPropagationImpact[] = [];
    const seen = new Set<string>();
    for (const skill of skills) {
        const state = skillState(skill);
        if (state === undefined) continue;
        const key = `${skill.capabilityId}@${skill.version}`;
        if (seen.has(key)) continue;
        const references: readonly CapabilityReference[] = signal.kind === "tool"
            ? (skill.references?.tools ?? [])
            : signal.kind === "cognition"
                ? (skill.references?.cognitions ?? [])
                : (skill.references?.behaviors ?? []);
        if (!references.some(reference => matches(reference, signal.id, signal.version))) continue;
        if (signal.kind === "tool") {
            const action = signal.state === "degraded" ? "cooling" : "failed";
            if (!(lifecycleActions[action] ?? []).includes(state)) continue;
            seen.add(key);
            impacts.push(Object.freeze({
                skillId: skill.capabilityId,
                version: skill.version,
                from: state,
                action,
                to: action,
                reason,
                causedBy,
            }));
        } else {
            if (!weightedActions.includes(state)) continue;
            seen.add(key);
            impacts.push(Object.freeze({
                skillId: skill.capabilityId,
                version: skill.version,
                from: state,
                action: "weight_reduced",
                weightMultiplier: DEFAULT_SKILL_WEIGHT_REDUCTION,
                reason,
                causedBy,
            }));
        }
    }
    return Object.freeze(impacts);
}

/** Convenience wrapper for a Tool lifecycle change (refract §6.7). */
export function propagateToolState(
    tool: ToolLifecycleSignal,
    skills: readonly SkillPropagationTarget[],
): readonly SkillPropagationImpact[] {
    return propagateSkillImpacts({ ...tool, kind: "tool" }, skills);
}

/** Convenience wrapper for a Cognition demotion (refract §6.6/§6.7). */
export function propagateCognitionDemotion(
    cognition: CognitionLifecycleSignal,
    skills: readonly SkillPropagationTarget[],
): readonly SkillPropagationImpact[] {
    return propagateSkillImpacts({ ...cognition, kind: "cognition" }, skills);
}

/** Convenience wrapper for Behavior cooling (refract §6.7/§7.4). */
export function propagateBehaviorCooling(
    behavior: BehaviorLifecycleSignal,
    skills: readonly SkillPropagationTarget[],
): readonly SkillPropagationImpact[] {
    return propagateSkillImpacts({ ...behavior, kind: "behavior" }, skills);
}
