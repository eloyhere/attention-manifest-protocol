/**
 * Agent context assembly: self -> role -> affect -> memory -> relationships ->
 * memberships -> background, under a token budget.
 *
 * This is not a memory dump. Every segment carries a ref and every omission is
 * recorded with a reason. Affect can bias retrieval but cannot change truth.
 */
import type { Budget, Ref, RefKind } from "../types/common.ts";
import type { AffectState, AgentProfile, AgentReader, BackgroundProcess, Memory, MemoryKind, Pid, RoleAssignment, SelfNarrative } from "../process/agent.ts";
import type { Membership, Relationship, SocialReader } from "../ipc/social.ts";
import { contextBudgetTokens } from "../scenario/scenario.ts";
import type { ScenarioPlan } from "../scenario/scenario.ts";
import { combineContextWeights, combineMemoryWeights } from "../interaction/interaction.ts";
import type { InteractionPlan } from "../interaction/interaction.ts";

const DefaultTokens: number = 2000;

const Shares: Record<AgentContextKind, number> = {
    self: 0.25,
    role: 0.15,
    affect: 0.1,
    memory: 0.35,
    relationship: 0.1,
    membership: 0,
    background: 0.05,
};

export type AgentContextKind = "self" | "role" | "affect" | "memory" | "relationship" | "membership" | "background";

export interface AgentContextSegment {
    kind: AgentContextKind;
    ref?: Ref;
    text: string;
    tokens: number;
}

export interface ExcludedSegment {
    kind: AgentContextKind;
    ref?: Ref;
    reason: "budget" | "low-salience" | "role-mismatch" | "stale" | "privacy";
}

export interface AgentContext {
    profile: AgentProfile;
    narrative: SelfNarrative;
    activeRole?: RoleAssignment;
    affect?: AffectState;
    memories: Memory[];
    relationships: Relationship[];
    memberships: Membership[];
    background: BackgroundProcess[];
    segments: AgentContextSegment[];
    tokens: number;
    excluded: ExcludedSegment[];
    scenario?: ScenarioPlan;
    interaction?: InteractionPlan;
}

export interface AgentContextOptions {
    now?: string;
    includeKinds?: AgentContextKind[];
    /**
     * Weighted scenario mix controls token budget, shares and memory kinds.
     */
    scenario?: ScenarioPlan;
    /**
     * Interaction modes re-weight what matters inside the scenario budget.
     */
    interaction?: InteractionPlan;
}

export interface AgentContextAssembler {
    assemble(pid: Pid, budget: Budget, options?: AgentContextOptions): AgentContext;
}

/**
 * One counter shared by every segment of the same kind.
 */
type GroupUsage = {
    value: number;
};

/**
 * One scored memory waiting for budget admission.
 */
type RankedMemory = {
    memory: Memory;
    score: number;
};

export const estimateTokens: (text: string) => number = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const clamp01: (value: number) => number = (value: number): number => Math.max(0, Math.min(1, value));

const refFor: (kind: AgentContextKind, id: string, label?: string) => Ref = (kind: AgentContextKind, id: string, label?: string): Ref => {
    const refKind: RefKind =
        kind === "self" ? "self" : kind === "memory" ? "memory" : kind === "membership" ? "org" : kind === "relationship" ? "human" : "other";
    const ref: Ref = { kind: refKind, id };
    if (label !== (void 0)) {
        ref.label = label;
    }
    return ref;
};

const selfText: (profile: AgentProfile, narrative: SelfNarrative) => string = (profile: AgentProfile, narrative: SelfNarrative): string => {
    const values: string = profile.values.length > 0 ? profile.values.join(", ") : "none stated";
    const constraints: string = profile.constraints.length > 0 ? profile.constraints.join(", ") : "none stated";
    return [
        `I am ${profile.name}. Life chapter: ${profile.lifeChapter}.`,
        `Values: ${values}. Constraints: ${constraints}.`,
        `Current self-narrative (v${narrative.version}): ${narrative.narrative}`,
    ].join(" ");
};

const roleText: (assignment: RoleAssignment) => string = (assignment: RoleAssignment): string => {
    const obligations: string[] = assignment.role.obligations.map((obligation) => obligation.statement);
    return [
        `Active role: ${assignment.role.label} (salience ${assignment.salience.toFixed(2)}).`,
        obligations.length > 0 ? `Obligations: ${obligations.join("; ")}.` : "No explicit obligations.",
        assignment.role.audiences.length > 0 ? `Audiences: ${assignment.role.audiences.join(", ")}.` : "",
    ]
        .filter((part) => part.length > 0)
        .join(" ");
};

const affectText: (affect: AffectState) => string = (affect: AffectState): string => {
    return `Affect: valence ${affect.valence.toFixed(2)}, arousal ${affect.arousal.toFixed(2)}, stress ${affect.stress.toFixed(2)}, fatigue ${affect.fatigue.toFixed(2)}, mood ${affect.mood}.`;
};

const memoryText: (memory: Memory) => string = (memory: Memory): string => {
    const content: string = memory.content.length > 400 ? `${memory.content.slice(0, 397)}...` : memory.content;
    return `[${memory.kind}] ${content}`;
};

const relationshipText: (relationship: Relationship, pid: Pid) => string = (relationship: Relationship, pid: Pid): string => {
    const other: Pid = relationship.fromPid === pid ? relationship.toPid : relationship.fromPid;
    const obligations: string = relationship.obligations.length > 0 ? ` Obligations: ${relationship.obligations.join("; ")}.` : "";
    return `${relationship.kind} with person ${other}: trust ${relationship.trust.toFixed(2)}, attachment ${relationship.attachment.toFixed(2)}.${obligations}`;
};

const membershipText: (membership: Membership) => string = (membership: Membership): string => {
    const norms: string = membership.institution.norms.length > 0 ? ` Norms: ${membership.institution.norms.join("; ")}.` : "";
    return `Member of ${membership.institution.name} as ${membership.role} (${membership.status}).${norms}`;
};

const backgroundText: (process: BackgroundProcess) => string = (process: BackgroundProcess): string => {
    return `${process.kind}: ${process.label} (intensity ${process.intensity.toFixed(2)}${process.trigger === (void 0) ? "" : `, trigger: ${process.trigger}`}).`;
};

const recencyScore: (at: string, now: number) => number = (at: string, now: number): number => {
    const then: number = Date.parse(at);
    if (Number.isNaN(then) || Number.isNaN(now)) {
        return 0.5;
    }
    const days: number = Math.max(0, (now - then) / 86_400_000);
    return 1 / (1 + days / 30);
};

type MemoryScorer = (memory: Memory, activeRoleId: string | undefined, now: number, kindWeight?: number) => number;

const memoryScore: MemoryScorer = (memory: Memory, activeRoleId: string | undefined, now: number, kindWeight?: number): number => {
    const roleBoost: number = memory.roleId !== (void 0) && memory.roleId === activeRoleId ? 0.2 : 0;
    const base: number = clamp01(memory.salience * 0.7 + recencyScore(memory.at, now) * 0.3 + roleBoost);
    return kindWeight === (void 0) ? base : clamp01(base * (0.5 + kindWeight));
};

type SegmentAdder = (kind: AgentContextKind, ref: Ref | undefined, text: string, cap: number, groupUsed: GroupUsage) => boolean;

type ContextAssembler = (agent: AgentReader, social: SocialReader, pid: Pid, budget: Budget, options?: AgentContextOptions) => AgentContext;

export const assembleAgentContext: ContextAssembler = (agent: AgentReader, social: SocialReader, pid: Pid, budget: Budget, options = {}): AgentContext => {
    const profile: AgentProfile | undefined = agent.profile(pid);
    if (profile === (void 0)) {
        throw new Error(`agent_not_found: pid ${pid}`);
    }
    const narrative: SelfNarrative | undefined = agent.narrative(pid);
    if (narrative === (void 0)) {
        throw new Error(`agent_not_found: narrative for pid ${pid}`);
    }

    const now: number = options.now === (void 0) ? Date.now() : Date.parse(options.now);
    const requested: number = Number.isSafeInteger(budget.tokens) && (budget.tokens ?? 0) > 0 ? (budget.tokens as number) : DefaultTokens;
    const scenario: ScenarioPlan | undefined = options.scenario;
    const interaction: InteractionPlan | undefined = options.interaction;
    const total: number = scenario === (void 0) ? requested : contextBudgetTokens(scenario, requested);
    const combinedShares: Record<AgentContextKind, number> =
        scenario === (void 0) && interaction === (void 0) ? Shares : combineContextWeights(scenario?.contextWeights, interaction?.contextWeights);
    const include: Set<AgentContextKind> = new Set<AgentContextKind>(
        options.includeKinds ??
            (scenario === (void 0) && interaction === (void 0)
                ? ["self", "role", "affect", "memory", "relationship", "membership", "background"]
                : (Object.keys(combinedShares) as AgentContextKind[]).filter((kind) => combinedShares[kind] > 0.01)),
    );
    const share: (kind: AgentContextKind) => number = (kind: AgentContextKind): number => combinedShares[kind];
    const memoryWeights: Record<MemoryKind, number> | undefined = combineMemoryWeights(scenario?.memoryKindWeights, interaction?.memoryKindWeights);
    const activeRole: RoleAssignment | undefined = agent.activeRole(pid);
    const affect: AffectState | undefined = agent.affect(pid);
    const memories: Memory[] = agent.memories(pid, { limit: 32 });
    const relationships: Relationship[] = social
        .relationships(pid)
        .slice()
        .sort((left, right) => right.trust - left.trust);
    const memberships: Membership[] = social.memberships(pid);
    const background: BackgroundProcess[] = agent.background(pid, "active");

    const segments: AgentContextSegment[] = [];
    const excluded: ExcludedSegment[] = [];
    let used: number = 0;

    const add: SegmentAdder = (kind: AgentContextKind, ref: Ref | undefined, text: string, cap: number, groupUsed: GroupUsage): boolean => {
        const tokens: number = estimateTokens(text);
        if (used + tokens > total || groupUsed.value + tokens > cap) {
            const item: ExcludedSegment = { kind, reason: "budget" };
            if (ref !== (void 0)) {
                item.ref = ref;
            }
            excluded.push(item);
            return false;
        }
        const segment: AgentContextSegment = { kind, text, tokens };
        if (ref !== (void 0)) {
            segment.ref = ref;
        }
        segments.push(segment);
        used += tokens;
        groupUsed.value += tokens;
        return true;
    };

    if (include.has("self")) {
        const ref: Ref = refFor("self", `agent.${pid}`, profile.name);
        add("self", ref, selfText(profile, narrative), Math.floor(total * share("self")), { value: 0 });
    }

    if (include.has("role") && activeRole !== (void 0)) {
        const ref: Ref = refFor("role", activeRole.role.id, activeRole.role.label);
        add("role", ref, roleText(activeRole), Math.floor(total * share("role")), { value: 0 });
    }

    if (include.has("affect") && affect !== (void 0)) {
        const ref: Ref = refFor("affect", `affect.${pid}`, affect.mood);
        add("affect", ref, affectText(affect), Math.floor(total * share("affect")), { value: 0 });
    }

    if (include.has("memory")) {
        const cap: number = Math.floor(total * share("memory"));
        const group: GroupUsage = { value: 0 };
        const ranked: RankedMemory[] = memories
            .filter((memory) => memoryWeights === (void 0) || (memoryWeights[memory.kind] ?? 0) > 0)
            .map((memory) => ({
                memory,
                score: memoryScore(memory, activeRole?.role.id, now, memoryWeights === (void 0) ? undefined : (memoryWeights[memory.kind] ?? 0)),
            }))
            .sort((left, right) => right.score - left.score);
        for (let index: number = 0; index < ranked.length; index += 1) {
            const entry: RankedMemory = ranked[index];
            const ref: Ref = refFor("memory", entry.memory.id);
            if (!add("memory", ref, memoryText(entry.memory), cap, group)) {
                excluded.push({ kind: "memory", ref, reason: "low-salience" });
            }
        }
    }

    if (include.has("relationship")) {
        const cap: number = Math.floor(total * share("relationship"));
        const group: GroupUsage = { value: 0 };
        for (let index: number = 0; index < relationships.length; index += 1) {
            const relationship: Relationship = relationships[index];
            const ref: Ref = refFor("relationship", relationship.id, relationship.kind);
            add("relationship", ref, relationshipText(relationship, pid), cap, group);
        }
    }

    if (include.has("membership")) {
        const group: GroupUsage = { value: 0 };
        for (let index: number = 0; index < memberships.length; index += 1) {
            const membership: Membership = memberships[index];
            const ref: Ref = refFor("membership", membership.institution.id, membership.institution.name);
            add("membership", ref, membershipText(membership), Math.max(1, Math.floor(total * share("membership"))), group);
        }
    }

    if (include.has("background")) {
        const cap: number = Math.floor(total * share("background"));
        const group: GroupUsage = { value: 0 };
        for (let index: number = 0; index < background.length; index += 1) {
            const process: BackgroundProcess = background[index];
            const ref: Ref = refFor("background", process.id, process.kind);
            add("background", ref, backgroundText(process), cap, group);
        }
    }

    return {
        profile,
        narrative,
        activeRole,
        affect,
        memories,
        relationships,
        memberships,
        background,
        segments,
        tokens: used,
        excluded,
        ...(scenario === (void 0) ? {} : { scenario }),
        ...(interaction === (void 0) ? {} : { interaction }),
    };
};
