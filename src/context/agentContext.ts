/**
 * Agent context assembly: self -> role -> affect -> memory -> relationships ->
 * memberships -> background, under a token budget.
 *
 * This is not a memory dump. Every segment carries a ref and every omission is
 * recorded with a reason. Affect can bias retrieval but cannot change truth.
 */
import type { Budget, Ref } from "../types/common.ts";
import type { AffectState, AgentProfile, AgentReader, BackgroundProcess, Memory, Pid, RoleAssignment, SelfNarrative } from "../process/agent.ts";
import type { Membership, Relationship, SocialReader } from "../ipc/social.ts";

const DEFAULT_TOKENS = 2000;

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
}

export interface AgentContextOptions {
    now?: string;
    includeKinds?: AgentContextKind[];
}

export interface AgentContextAssembler {
    assemble(pid: Pid, budget: Budget, options?: AgentContextOptions): AgentContext;
}

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const refFor = (kind: AgentContextKind, id: string, label?: string): Ref => {
    const refKind = kind === "self" ? "self" : kind === "memory" ? "memory" : kind === "membership" ? "org" : kind === "relationship" ? "human" : "other";
    const ref: Ref = { kind: refKind, id };
    if (label !== undefined) ref.label = label;
    return ref;
};

const selfText = (profile: AgentProfile, narrative: SelfNarrative): string => {
    const values = profile.values.length > 0 ? profile.values.join(", ") : "none stated";
    const constraints = profile.constraints.length > 0 ? profile.constraints.join(", ") : "none stated";
    return [
        `I am ${profile.name}. Life chapter: ${profile.lifeChapter}.`,
        `Values: ${values}. Constraints: ${constraints}.`,
        `Current self-narrative (v${narrative.version}): ${narrative.narrative}`,
    ].join(" ");
};

const roleText = (assignment: RoleAssignment): string => {
    const obligations = assignment.role.obligations.map((obligation) => obligation.statement);
    return [
        `Active role: ${assignment.role.label} (salience ${assignment.salience.toFixed(2)}).`,
        obligations.length > 0 ? `Obligations: ${obligations.join("; ")}.` : "No explicit obligations.",
        assignment.role.audiences.length > 0 ? `Audiences: ${assignment.role.audiences.join(", ")}.` : "",
    ]
        .filter((part) => part.length > 0)
        .join(" ");
};

const affectText = (affect: AffectState): string => {
    return `Affect: valence ${affect.valence.toFixed(2)}, arousal ${affect.arousal.toFixed(2)}, stress ${affect.stress.toFixed(2)}, fatigue ${affect.fatigue.toFixed(2)}, mood ${affect.mood}.`;
};

const memoryText = (memory: Memory): string => {
    const content = memory.content.length > 400 ? `${memory.content.slice(0, 397)}...` : memory.content;
    return `[${memory.kind}] ${content}`;
};

const relationshipText = (relationship: Relationship, pid: Pid): string => {
    const other = relationship.fromPid === pid ? relationship.toPid : relationship.fromPid;
    const obligations = relationship.obligations.length > 0 ? ` Obligations: ${relationship.obligations.join("; ")}.` : "";
    return `${relationship.kind} with person ${other}: trust ${relationship.trust.toFixed(2)}, attachment ${relationship.attachment.toFixed(2)}.${obligations}`;
};

const membershipText = (membership: Membership): string => {
    const norms = membership.institution.norms.length > 0 ? ` Norms: ${membership.institution.norms.join("; ")}.` : "";
    return `Member of ${membership.institution.name} as ${membership.role} (${membership.status}).${norms}`;
};

const backgroundText = (process: BackgroundProcess): string => {
    return `${process.kind}: ${process.label} (intensity ${process.intensity.toFixed(2)}${process.trigger === undefined ? "" : `, trigger: ${process.trigger}`}).`;
};

const recencyScore = (at: string, now: number): number => {
    const then = Date.parse(at);
    if (Number.isNaN(then) || Number.isNaN(now)) return 0.5;
    const days = Math.max(0, (now - then) / 86_400_000);
    return 1 / (1 + days / 30);
};

const memoryScore = (memory: Memory, activeRoleId: string | undefined, now: number): number => {
    const roleBoost = memory.roleId !== undefined && memory.roleId === activeRoleId ? 0.2 : 0;
    return clamp01(memory.salience * 0.7 + recencyScore(memory.at, now) * 0.3 + roleBoost);
};

export const assembleAgentContext = (agent: AgentReader, social: SocialReader, pid: Pid, budget: Budget, options: AgentContextOptions = {}): AgentContext => {
    const profile = agent.profile(pid);
    if (profile === undefined) throw new Error(`agent_not_found: pid ${pid}`);
    const narrative = agent.narrative(pid);
    if (narrative === undefined) throw new Error(`agent_not_found: narrative for pid ${pid}`);

    const now = options.now === undefined ? Date.now() : Date.parse(options.now);
    const total = Number.isSafeInteger(budget.tokens) && (budget.tokens ?? 0) > 0 ? (budget.tokens as number) : DEFAULT_TOKENS;
    const include = new Set<AgentContextKind>(options.includeKinds ?? ["self", "role", "affect", "memory", "relationship", "membership", "background"]);
    const activeRole = agent.activeRole(pid);
    const affect = agent.affect(pid);
    const memories = agent.memories(pid, { limit: 32 });
    const relationships = social
        .relationships(pid)
        .slice()
        .sort((left, right) => right.trust - left.trust);
    const memberships = social.memberships(pid);
    const background = agent.background(pid, "active");

    const segments: AgentContextSegment[] = [];
    const excluded: ExcludedSegment[] = [];
    let used = 0;

    const add = (kind: AgentContextKind, ref: Ref | undefined, text: string, cap: number, groupUsed: { value: number }): boolean => {
        const tokens = estimateTokens(text);
        if (used + tokens > total || groupUsed.value + tokens > cap) {
            const item: ExcludedSegment = { kind, reason: "budget" };
            if (ref !== undefined) item.ref = ref;
            excluded.push(item);
            return false;
        }
        const segment: AgentContextSegment = { kind, text, tokens };
        if (ref !== undefined) segment.ref = ref;
        segments.push(segment);
        used += tokens;
        groupUsed.value += tokens;
        return true;
    };

    if (include.has("self")) {
        const ref = refFor("self", `agent.${pid}`, profile.name);
        add("self", ref, selfText(profile, narrative), Math.floor(total * Shares.self), { value: 0 });
    }

    if (include.has("role") && activeRole !== undefined) {
        const ref = refFor("role", activeRole.role.id, activeRole.role.label);
        add("role", ref, roleText(activeRole), Math.floor(total * Shares.role), { value: 0 });
    }

    if (include.has("affect") && affect !== undefined) {
        const ref = refFor("affect", `affect.${pid}`, affect.mood);
        add("affect", ref, affectText(affect), Math.floor(total * Shares.affect), { value: 0 });
    }

    if (include.has("memory")) {
        const cap = Math.floor(total * Shares.memory);
        const group = { value: 0 };
        const ranked = memories
            .map((memory) => ({ memory, score: memoryScore(memory, activeRole?.role.id, now) }))
            .sort((left, right) => right.score - left.score);
        for (const entry of ranked) {
            const ref = refFor("memory", entry.memory.id);
            if (!add("memory", ref, memoryText(entry.memory), cap, group)) {
                excluded.push({ kind: "memory", ref, reason: "low-salience" });
            }
        }
    }

    if (include.has("relationship")) {
        const cap = Math.floor(total * Shares.relationship);
        const group = { value: 0 };
        for (const relationship of relationships) {
            const ref = refFor("relationship", relationship.id, relationship.kind);
            add("relationship", ref, relationshipText(relationship, pid), cap, group);
        }
    }

    if (include.has("membership")) {
        const group = { value: 0 };
        for (const membership of memberships) {
            const ref = refFor("membership", membership.institution.id, membership.institution.name);
            add("membership", ref, membershipText(membership), Math.max(1, Math.floor(total * 0.05)), group);
        }
    }

    if (include.has("background")) {
        const cap = Math.floor(total * Shares.background);
        const group = { value: 0 };
        for (const process of background) {
            const ref = refFor("background", process.id, process.kind);
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
    };
};
