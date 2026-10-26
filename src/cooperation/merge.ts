import type { Id, Tier } from "../types/common.ts";

export interface MergeClaim {
    id: Id;
    /**
     * What the claim is about, e.g. `deploy.cause`. Conflicts are detected per subject.
     */
    subject: string;
    value: string;
    tier: Tier;
    agent: Id;
    /**
     * Distinct provenance roots behind this claim (not URLs).
     */
    origins: string[];
    /**
     * Can the receiving agent re-run the observation itself? Only then does tier survive transfer.
     */
    replayable: boolean;
}

export interface MergedClaim {
    subject: string;
    value: string;
    tier: Tier;
    supporters: Id[];
    origins: string[];
    status: "held" | "contested" | "single_agent";
}

export interface MergeResult {
    merged: MergedClaim[];
    conflicts: string[];
    warnings: string[];
}

export interface Adjudication {
    decision: "accept" | "escalate";
    value?: string;
    reason: string;
}

/**
 * A contested claim paired with the authority score of its supporters.
 */
type ScoredClaim = {
    claim: MergedClaim;
    score: number;
};

/**
 * Adjudicates contested claims by evidence tier, then by authority.
 */
type Adjudicator = (contested: MergedClaim[], authority: Record<Id, number>) => Adjudication;

/**
 * Conflicts are resolved by evidence tier first, then by authority — never by
 * majority. If no side dominates, escalate to a named authority.
 */
export const adjudicate: Adjudicator = (contested: MergedClaim[], authority: Record<Id, number>): Adjudication => {
    if (contested.length <= 1) {
        return { decision: "accept", value: contested[0]?.value, reason: "single value" };
    }

    const scored: ScoredClaim[] = contested
        .map((claim) => ({
            claim,
            score: Math.max(0, ...claim.supporters.map((agent) => authority[agent] ?? 0)),
        }))
        .sort((a, b) => ORDER.indexOf(b.claim.tier) - ORDER.indexOf(a.claim.tier) || b.score - a.score);

    const [first, second]: ScoredClaim[] = scored;
    if (ORDER.indexOf(first.claim.tier) > ORDER.indexOf(second.claim.tier)) {
        return { decision: "accept", value: first.claim.value, reason: "higher evidence tier" };
    }
    if (first.score > second.score) {
        return { decision: "accept", value: first.claim.value, reason: "higher authority" };
    }
    return { decision: "escalate", reason: "no side dominates; escalate to a named authority" };
};

const ORDER: Tier[] = ["T0", "T1", "T2", "T3", "T4"];

const degrade: (tier: Tier) => Tier = (tier: Tier): Tier => {
    const index: number = ORDER.indexOf(tier);
    return ORDER[Math.max(0, index - 1)];
};

/**
 * A claim does not keep its tier when it changes hands.
 * Unless the receiver can replay the observation, testimony is one level weaker.
 */
export const transferTier: (claim: MergeClaim, receiver: Id) => Tier = (claim: MergeClaim, receiver: Id): Tier => {
    if (claim.agent === receiver) {
        return claim.tier;
    }
    return claim.replayable ? claim.tier : degrade(claim.tier);
};

const capByIndependence: (agents: Id[], origins: string[]) => Tier = (agents: Id[], origins: string[]): Tier => {
    const distinctAgents: number = new Set(agents).size;
    const distinctOrigins: number = new Set(origins).size;
    if (distinctAgents >= 2 && distinctOrigins >= 2) {
        return "T4";
    }
    if (distinctAgents >= 2) {
        return "T3";
    }
    return "T2";
};

/**
 * Options controlling the merge.
 */
type MergeOptions = {
    forAgent: Id;
};

/**
 * Merge signature.
 */
type Merger = (claims: MergeClaim[], options: MergeOptions) => MergeResult;

/**
 * Merge contracts from several agents.
 *
 * Conflict is never averaged: two agents disagreeing yields `contested`,
 * both values retained, and a conflict entry. Consensus is not correctness.
 */
export const mergeResults: Merger = (claims: MergeClaim[], options: MergeOptions): MergeResult => {
    const warnings: string[] = [];
    const bySubject: Map<string, MergeClaim[]> = new Map<string, MergeClaim[]>();

    for (let index: number = 0; index < claims.length; index += 1) {
        const claim: MergeClaim = claims[index];
        const transferred: Tier = transferTier(claim, options.forAgent);
        if (transferred !== claim.tier) {
            warnings.push(`${claim.id}: tier degraded ${claim.tier} → ${transferred} on transfer`);
        }
        const normalised: MergeClaim = { ...claim, tier: transferred };
        const list: MergeClaim[] = bySubject.get(claim.subject) ?? [];
        list.push(normalised);
        bySubject.set(claim.subject, list);
    }

    const merged: MergedClaim[] = [];
    const conflicts: string[] = [];

    const groups: [string, MergeClaim[]][] = [...bySubject];
    for (let groupIndex: number = 0; groupIndex < groups.length; groupIndex += 1) {
        const subject: string = groups[groupIndex][0];
        const group: MergeClaim[] = groups[groupIndex][1];
        const values: string[] = [...new Set(group.map((claim) => claim.value))];
        const agents: Id[] = [...new Set(group.map((claim) => claim.agent))];
        const origins: string[] = [...new Set(group.flatMap((claim) => claim.origins))];

        if (values.length > 1) {
            conflicts.push(subject);
            for (let valueIndex: number = 0; valueIndex < values.length; valueIndex += 1) {
                const value: string = values[valueIndex];
                const supporters: Id[] = group.filter((claim) => claim.value === value).map((claim) => claim.agent);
                const supportingOrigins: string[] = [...new Set(group.filter((claim) => claim.value === value).flatMap((claim) => claim.origins))];
                merged.push({
                    subject,
                    value,
                    tier: capByIndependence(supporters, supportingOrigins),
                    supporters: [...new Set(supporters)],
                    origins: supportingOrigins,
                    status: "contested",
                });
            }
            continue;
        }

        const highest: Tier = group.map((claim) => claim.tier).sort((a, b) => ORDER.indexOf(b) - ORDER.indexOf(a))[0];
        const cap: Tier = capByIndependence(agents, origins);
        const tier: Tier = ORDER.indexOf(highest) <= ORDER.indexOf(cap) ? highest : cap;

        merged.push({
            subject,
            value: values[0],
            tier,
            supporters: agents,
            origins,
            status: agents.length === 1 ? "single_agent" : "held",
        });
    }

    return { merged, conflicts, warnings };
};
