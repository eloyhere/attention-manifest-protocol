import { SynchronousUnorderedMap, SynchronousUnorderedSet } from "semantic-typescript";
import { digestOf } from "../serialization/index.ts";
import type { CompiledContext } from "./types.ts";

/**
 * Context lifecycle: cache, prune and compact compiled context.
 *
 * The cache exists to raise reuse: a hit avoids recompiling and re-counting
 * tokens, and the statistics expose hit rate, utilisation and saved tokens so a
 * host can tune capacity instead of guessing. Pruning and compaction are the
 * eviction path: every drop carries a reason and a revisit condition, and a
 * compaction refuses to bury an entry that retained entries still cite.
 */

export type ContextEntryState = "candidate" | "cached" | "compressed" | "pruned" | "expired";

const ENTRY_TRANSITIONS: Record<ContextEntryState, readonly ContextEntryState[]> = {
    candidate: ["cached", "pruned", "expired"],
    cached: ["compressed", "pruned", "expired"],
    compressed: ["pruned", "expired"],
    pruned: [],
    expired: ["cached", "pruned"],
};

export const CONTEXT_ENTRY_TRANSITIONS: Readonly<Record<ContextEntryState, readonly ContextEntryState[]>> = Object.freeze(ENTRY_TRANSITIONS);

export function advanceContextEntry(state: ContextEntryState, next: ContextEntryState): ContextEntryState {
    if (!CONTEXT_ENTRY_TRANSITIONS[state].includes(next)) throw new TypeError(`invalid context entry transition: ${state} -> ${next}`);
    return next;
}

export interface ContextCachePolicy {
    readonly maxEntries: number;
    readonly maxTokens: number;
    readonly ttlMilliseconds: number;
}

export interface ContextCacheEntry {
    readonly signature: string;
    readonly context: CompiledContext;
    readonly tokens: number;
    readonly bytes: number;
    readonly createdAt: string;
    readonly lastAccessAt: string;
    readonly hits: number;
}

export type CacheLookup =
    | { readonly hit: true; readonly entry: ContextCacheEntry }
    | { readonly hit: false; readonly reason: "miss" | "expired" };

export interface ContextCacheStats {
    readonly entries: number;
    readonly tokens: number;
    readonly bytes: number;
    readonly hits: number;
    readonly misses: number;
    readonly evictions: number;
    readonly expirations: number;
    /** hits / (hits + misses); 0 when nothing was requested yet. */
    readonly hitRate: number;
    /** tokens / maxTokens, capped at 1. */
    readonly utilisation: number;
    /** Tokens served from cache instead of recomputation. */
    readonly savedTokens: number;
}

function requireSafeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
}

function usageTokens(context: CompiledContext): number {
    return Number(context.usage.tokens);
}

function usageBytes(context: CompiledContext): number {
    return Number(context.usage.bytes);
}

/**
 * LRU + TTL cache over compiled context. Eviction is by entries and by tokens,
 * oldest access first; a hit refreshes recency and records the tokens saved.
 */
export class ContextCache {
    private readonly policy: ContextCachePolicy;
    private readonly values = new SynchronousUnorderedMap<string, ContextCacheEntry>();
    private readonly recency: string[] = [];
    private hitsValue = 0;
    private missesValue = 0;
    private evictionsValue = 0;
    private expirationsValue = 0;
    private savedTokensValue = 0;

    constructor(policy: ContextCachePolicy) {
        requireSafeInteger(policy.maxEntries, "maxEntries");
        requireSafeInteger(policy.maxTokens, "maxTokens");
        requireSafeInteger(policy.ttlMilliseconds, "ttlMilliseconds");
        if (policy.maxEntries === 0 || policy.maxTokens === 0) throw new TypeError("cache needs a positive capacity");
        this.policy = Object.freeze({ ...policy });
    }

    put(signature: string, context: CompiledContext, now: string): readonly string[] {
        if (typeof signature !== "string" || signature.trim() === "") throw new TypeError("signature is required");
        const entry: ContextCacheEntry = Object.freeze({
            signature, context, tokens: usageTokens(context), bytes: usageBytes(context),
            createdAt: now, lastAccessAt: now, hits: 0,
        });
        if (this.values.containsKey(signature)) {
            this.values.put(signature, entry);
            this.touch(signature);
            return Object.freeze([]);
        }
        this.values.put(signature, entry);
        this.recency.push(signature);
        return this.evictOverflow(signature);
    }

    get(signature: string, now: string): CacheLookup {
        const value = this.values.get(signature);
        if (value.isEmpty()) {
            this.missesValue += 1;
            return Object.freeze({ hit: false, reason: "miss" });
        }
        const entry = value.get();
        if (this.expired(entry, now)) {
            this.values.remove(signature);
            this.touch(signature, true);
            this.missesValue += 1;
            this.expirationsValue += 1;
            return Object.freeze({ hit: false, reason: "expired" });
        }
        const refreshed: ContextCacheEntry = Object.freeze({ ...entry, lastAccessAt: now, hits: entry.hits + 1 });
        this.values.put(signature, refreshed);
        this.touch(signature);
        this.hitsValue += 1;
        this.savedTokensValue += refreshed.tokens;
        return Object.freeze({ hit: true, entry: refreshed });
    }

    invalidate(signature: string): boolean {
        if (!this.values.containsKey(signature)) return false;
        this.values.remove(signature);
        this.touch(signature, true);
        return true;
    }

    invalidateWhere(predicate: (entry: ContextCacheEntry) => boolean): number {
        let removed = 0;
        for (const entry of this.values.values()) {
            if (!predicate(entry)) continue;
            this.values.remove(entry.signature);
            this.touch(entry.signature, true);
            removed += 1;
        }
        return removed;
    }

    clear(): void {
        this.values.clear();
        this.recency.length = 0;
    }

    entries(): readonly ContextCacheEntry[] {
        const result: ContextCacheEntry[] = [];
        for (const signature of this.recency) {
            const value = this.values.get(signature);
            if (value.isPresent()) result.push(value.get());
        }
        return Object.freeze(result);
    }

    stats(): ContextCacheStats {
        let tokens = 0;
        let bytes = 0;
        for (const entry of this.values.values()) { tokens += entry.tokens; bytes += entry.bytes; }
        const requests = this.hitsValue + this.missesValue;
        return Object.freeze({
            entries: Number(this.values.size()),
            tokens, bytes,
            hits: this.hitsValue, misses: this.missesValue,
            evictions: this.evictionsValue, expirations: this.expirationsValue,
            hitRate: requests === 0 ? 0 : this.hitsValue / requests,
            utilisation: Math.min(1, tokens / this.policy.maxTokens),
            savedTokens: this.savedTokensValue,
        });
    }

    private expired(entry: ContextCacheEntry, now: string): boolean {
        return Date.parse(now) - Date.parse(entry.lastAccessAt) > this.policy.ttlMilliseconds;
    }

    private touch(signature: string, remove = false): void {
        const index = this.recency.indexOf(signature);
        if (index >= 0) this.recency.splice(index, 1);
        if (!remove) this.recency.push(signature);
    }

    private evictOverflow(keep: string): readonly string[] {
        const evicted: string[] = [];
        while (this.recency.length > this.policy.maxEntries || this.totalTokens() > this.policy.maxTokens) {
            const oldest = this.recency[0];
            if (oldest === undefined || oldest === keep) break;
            const value = this.values.get(oldest);
            this.values.remove(oldest);
            this.recency.shift();
            this.evictionsValue += 1;
            evicted.push(oldest);
            if (value.isEmpty()) continue;
        }
        return Object.freeze(evicted);
    }

    private totalTokens(): number {
        let sum = 0;
        for (const entry of this.values.values()) sum += entry.tokens;
        return sum;
    }
}

export type ContextPruneReason = "superseded" | "expired" | "cold" | "over_budget" | "low_score" | "out_of_window";

export interface ContextPruneCandidate {
    readonly id: string;
    readonly tokens: number;
    readonly score: number;
    readonly createdAt: string;
    readonly lastAccessAt: string;
    readonly active?: boolean;
    readonly pinned?: boolean;
    readonly expiresAt?: string;
    readonly supersededBy?: string;
    readonly references?: readonly string[];
}

export interface ContextPrunePolicy {
    readonly keepRecent: number;
    readonly maxTokens?: number;
    readonly maxEntries?: number;
    readonly minScore?: number;
}

export interface ContextPruneDecision {
    readonly id: string;
    readonly action: "keep" | "prune";
    readonly reason?: ContextPruneReason;
    readonly rule: string;
    readonly revisitAfter?: string;
}

export type ContextPruneState = "draft" | "approved" | "applied" | "verified" | "rejected";

export interface ContextPrunePlan {
    readonly id: string;
    readonly version: number;
    readonly digest: string;
    readonly state: ContextPruneState;
    readonly decisions: readonly ContextPruneDecision[];
    readonly kept: readonly string[];
    readonly pruned: readonly string[];
    readonly createdAt: string;
    readonly reason: string;
}

const PRUNE_TRANSITIONS: Record<ContextPruneState, readonly ContextPruneState[]> = {
    draft: ["approved", "rejected"],
    approved: ["applied", "rejected"],
    applied: ["verified", "rejected"],
    verified: [],
    rejected: [],
};

export const CONTEXT_PRUNE_TRANSITIONS: Readonly<Record<ContextPruneState, readonly ContextPruneState[]>> = Object.freeze(PRUNE_TRANSITIONS);

function planState(plan: ContextPrunePlan, next: ContextPruneState): ContextPrunePlan {
    if (!CONTEXT_PRUNE_TRANSITIONS[plan.state].includes(next)) throw new TypeError(`invalid prune transition: ${plan.state} -> ${next}`);
    return Object.freeze({ ...plan, state: next, version: plan.version + 1 });
}

export function approveContextPrune(plan: ContextPrunePlan): ContextPrunePlan {
    return planState(plan, "approved");
}

export function rejectContextPrune(plan: ContextPrunePlan): ContextPrunePlan {
    return planState(plan, "rejected");
}

/**
 * Decides keep/prune for every candidate. Active, pinned and their referenced
 * entries are protected; recent entries are preferred but may be demoted under
 * capacity pressure. Every pruned entry carries a reason and rule.
 */
export function planContextPrune(candidates: readonly ContextPruneCandidate[], policy: ContextPrunePolicy, options: { readonly now: string; readonly reason?: string } = { now: "" }): ContextPrunePlan {
    requireSafeInteger(policy.keepRecent, "keepRecent");
    if (policy.maxTokens !== undefined) requireSafeInteger(policy.maxTokens, "maxTokens");
    if (policy.maxEntries !== undefined) requireSafeInteger(policy.maxEntries, "maxEntries");
    const ids = new SynchronousUnorderedSet<string>();
    for (const candidate of candidates) {
        if (ids.contains(candidate.id)) throw new TypeError(`duplicate context candidate: ${candidate.id}`);
        ids.add(candidate.id);
    }
    const ordered = [...candidates].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const byId = new SynchronousUnorderedMap<string, ContextPruneCandidate>();
    for (const candidate of ordered) byId.put(candidate.id, candidate);
    const closure = (seed: SynchronousUnorderedSet<string>): SynchronousUnorderedSet<string> => {
        let changed = true;
        while (changed) {
            changed = false;
            for (const id of seed.toArray()) {
                const candidate = byId.get(id);
                if (candidate.isEmpty()) continue;
                for (const reference of candidate.get().references ?? []) {
                    if (!seed.contains(reference)) { seed.add(reference); changed = true; }
                }
            }
        }
        return seed;
    };

    const protectedIds = new SynchronousUnorderedSet<string>();
    for (const candidate of ordered) if (candidate.active === true || candidate.pinned === true) protectedIds.add(candidate.id);
    closure(protectedIds);

    const recentIds = new SynchronousUnorderedSet<string>();
    for (const candidate of [...ordered]
        .sort((left, right) => right.lastAccessAt.localeCompare(left.lastAccessAt) || right.id.localeCompare(left.id))
        .slice(0, policy.keepRecent)) recentIds.add(candidate.id);
    closure(recentIds);

    const keep = new SynchronousUnorderedSet<string>([...protectedIds.toArray(), ...recentIds.toArray()]);
    let retained = Number(keep.size());
    let retainedTokens = 0;
    for (const id of keep.toArray()) retainedTokens += byId.get(id).map(candidate => candidate.tokens).get(0);

    // Capacity pressure demotes the coldest unprotected, non-recent entries first.
    const demotable = keep.toArray()
        .filter(id => !protectedIds.contains(id))
        .sort((left, right) => {
            const recentOrder = (recentIds.contains(left) ? 1 : 0) - (recentIds.contains(right) ? 1 : 0);
            if (recentOrder !== 0) return recentOrder;
            const a = byId.get(left).map(candidate => candidate.lastAccessAt).get("");
            const b = byId.get(right).map(candidate => candidate.lastAccessAt).get("");
            return a.localeCompare(b) || left.localeCompare(right);
        });
    const overBudget = new SynchronousUnorderedSet<string>();
    for (const id of demotable) {
        if ((policy.maxEntries === undefined || retained <= policy.maxEntries)
            && (policy.maxTokens === undefined || retainedTokens <= policy.maxTokens)) break;
        overBudget.add(id);
        retained -= 1;
        retainedTokens -= byId.get(id).map(candidate => candidate.tokens).get(0);
    }

    const decisions: ContextPruneDecision[] = [];
    for (const candidate of ordered) {
        if (keep.contains(candidate.id) && !overBudget.contains(candidate.id)) {
            decisions.push(Object.freeze({ id: candidate.id, action: "keep", rule: protectedIds.contains(candidate.id) ? "protected" : "recent" }));
            continue;
        }
        if (overBudget.contains(candidate.id)) {
            const rule = policy.maxEntries !== undefined && retained >= policy.maxEntries ? "maxEntries" : "maxTokens";
            decisions.push(Object.freeze({ id: candidate.id, action: "prune", reason: "over_budget", rule }));
            continue;
        }
        if (candidate.supersededBy !== undefined) {
            decisions.push(Object.freeze({ id: candidate.id, action: "prune", reason: "superseded", rule: "superseded" }));
            continue;
        }
        if (candidate.expiresAt !== undefined && Date.parse(options.now) >= Date.parse(candidate.expiresAt)) {
            decisions.push(Object.freeze({ id: candidate.id, action: "prune", reason: "expired", rule: "expired", revisitAfter: candidate.expiresAt }));
            continue;
        }
        if (policy.minScore !== undefined && candidate.score < policy.minScore) {
            decisions.push(Object.freeze({ id: candidate.id, action: "prune", reason: "low_score", rule: "minScore" }));
            continue;
        }
        decisions.push(Object.freeze({ id: candidate.id, action: "prune", reason: "cold", rule: "cold" }));
    }

    const kept = decisions.filter(decision => decision.action === "keep").map(decision => decision.id);
    const pruned = decisions.filter(decision => decision.action === "prune").map(decision => decision.id);
    const base = { decisions: Object.freeze(decisions), kept: Object.freeze(kept), pruned: Object.freeze(pruned), createdAt: options.now, reason: options.reason ?? "context budget maintenance" };
    return Object.freeze({ ...base, id: digestOf(base), version: 1, digest: digestOf(base), state: "draft" });
}

export interface ContextCheckpoint {
    readonly id: string;
    readonly planId: string;
    readonly through: number;
    readonly entryIds: readonly string[];
    readonly digest: string;
    readonly savedTokens: number;
    readonly summary: string;
    readonly createdAt: string;
    readonly state: "created" | "committed" | "verified" | "superseded";
    readonly reason: string;
}

const CHECKPOINT_TRANSITIONS: Record<ContextCheckpoint["state"], readonly ContextCheckpoint["state"][]> = {
    created: ["committed", "superseded"],
    committed: ["verified", "superseded"],
    verified: ["superseded"],
    superseded: [],
};

export const CONTEXT_CHECKPOINT_TRANSITIONS: Readonly<Record<ContextCheckpoint["state"], readonly ContextCheckpoint["state"][]>> = Object.freeze(CHECKPOINT_TRANSITIONS);

export function advanceContextCheckpoint(checkpoint: ContextCheckpoint, next: ContextCheckpoint["state"]): ContextCheckpoint {
    if (!CONTEXT_CHECKPOINT_TRANSITIONS[checkpoint.state].includes(next)) throw new TypeError(`invalid checkpoint transition: ${checkpoint.state} -> ${next}`);
    return Object.freeze({ ...checkpoint, state: next });
}

export interface ContextCompaction {
    readonly planId: string;
    readonly checkpoint: ContextCheckpoint;
    readonly retained: readonly ContextPruneCandidate[];
    readonly pruned: readonly ContextPruneCandidate[];
}

/**
 * Applies an approved-and-applied prune plan as a checkpoint. Retained entries
 * that cite a pruned entry abort the compaction instead of hiding the fact.
 */
export function compactContext(candidates: readonly ContextPruneCandidate[], plan: ContextPrunePlan, options: { readonly now: string; readonly summary: string }): ContextCompaction {
    if (plan.state !== "applied") throw new TypeError(`compaction requires an applied plan, got ${plan.state}`);
    const byId = new SynchronousUnorderedMap<string, ContextPruneCandidate>();
    for (const candidate of candidates) byId.put(candidate.id, candidate);
    const prunedIds = new SynchronousUnorderedSet<string>(plan.pruned);
    for (const candidate of candidates) {
        if (prunedIds.contains(candidate.id)) continue;
        for (const reference of candidate.references ?? []) {
            if (prunedIds.contains(reference)) {
                throw new TypeError(`retained entry ${candidate.id} cites pruned entry ${reference}`);
            }
        }
    }
    const pruned: ContextPruneCandidate[] = [];
    for (const id of plan.pruned) {
        const value = byId.get(id);
        if (value.isPresent()) pruned.push(value.get());
    }
    const retained = candidates.filter(candidate => !prunedIds.contains(candidate.id));
    const base = {
        planId: plan.id,
        through: pruned.length,
        entryIds: Object.freeze(pruned.map(candidate => candidate.id)),
        savedTokens: pruned.reduce((sum, candidate) => sum + candidate.tokens, 0),
        summary: options.summary,
        createdAt: options.now,
        reason: plan.reason,
    };
    const checkpoint = Object.freeze({ id: digestOf(base), state: "committed", digest: digestOf(base), ...base });
    return Object.freeze({ planId: plan.id, checkpoint, retained: Object.freeze(retained), pruned: Object.freeze(pruned) });
}

export function verifyContextCompaction(candidates: readonly ContextPruneCandidate[], checkpoint: ContextCheckpoint): boolean {
    const computed = digestOf({
        planId: checkpoint.planId, through: checkpoint.through, entryIds: checkpoint.entryIds,
        savedTokens: checkpoint.savedTokens, summary: checkpoint.summary,
        createdAt: checkpoint.createdAt, reason: checkpoint.reason,
    });
    if (computed !== checkpoint.digest) return false;
    const pruned = new SynchronousUnorderedSet<string>(checkpoint.entryIds);
    return candidates.every(candidate => pruned.contains(candidate.id) || !(candidate.references ?? []).some(reference => pruned.contains(reference)));
}
