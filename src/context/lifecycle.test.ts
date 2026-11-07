import assert from "node:assert/strict";
import test from "node:test";
import {
    ContextCache, advanceContextCheckpoint, advanceContextEntry, approveContextPrune, compactContext,
    planContextPrune, rejectContextPrune, verifyContextCompaction,
} from "./lifecycle.ts";
import type { ContextPruneCandidate } from "./lifecycle.ts";
import type { CompiledContext } from "./types.ts";

const scope = { tenantId: "t", principalId: "p", sessionId: "s", turnId: "u" } as const;

function context(tokens: number, bytes = tokens * 4): CompiledContext {
    return {
        version: "attention-context/1",
        compiledAt: "2026-01-01T00:00:00Z",
        scope,
        items: [],
        exclusions: [],
        budget: { tokens: 1000 },
        usage: { tokens, bytes, milliseconds: 0, calls: 0 },
        text: "",
        authorization: "not_granted",
    };
}

function candidate(id: string, overrides: Partial<ContextPruneCandidate> = {}): ContextPruneCandidate {
    return Object.freeze({
        id, tokens: 10, score: 1, createdAt: "2026-01-01T00:00:00Z",
        lastAccessAt: "2026-01-01T00:00:00Z", ...overrides,
    });
}

test("cache reports hits, misses and saved tokens", () => {
    const cache = new ContextCache({ maxEntries: 4, maxTokens: 1000, ttlMilliseconds: 60_000 });
    cache.put("a", context(30), "2026-01-01T00:00:00Z");
    assert.equal(cache.get("a", "2026-01-01T00:00:01Z").hit, true);
    assert.equal(cache.get("b", "2026-01-01T00:00:01Z").hit, false);
    const stats = cache.stats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.equal(stats.hitRate, 0.5);
    assert.equal(stats.savedTokens, 30);
    assert.equal(stats.utilisation, 0.03);
    assert.equal(Object.isFrozen(stats), true);
});

test("cache evicts the least recently used entry and reports it", () => {
    const cache = new ContextCache({ maxEntries: 2, maxTokens: 1000, ttlMilliseconds: 60_000 });
    cache.put("a", context(10), "2026-01-01T00:00:00Z");
    cache.put("b", context(10), "2026-01-01T00:00:01Z");
    cache.get("a", "2026-01-01T00:00:02Z");
    const evicted = cache.put("c", context(10), "2026-01-01T00:00:03Z");
    assert.deepEqual([...evicted], ["b"]);
    assert.equal(cache.stats().evictions, 1);
    assert.deepEqual(cache.entries().map(entry => entry.signature), ["a", "c"]);
});

test("cache respects the token ceiling and TTL expiry", () => {
    const cache = new ContextCache({ maxEntries: 10, maxTokens: 100, ttlMilliseconds: 60_000 });
    cache.put("a", context(60), "2026-01-01T00:00:00Z");
    cache.put("b", context(60), "2026-01-01T00:00:01Z");
    const stats = cache.stats();
    assert.equal(stats.tokens, 60);
    assert.equal(stats.entries, 1);
    assert.equal(cache.get("b", "2026-01-01T00:00:10Z").hit, true);

    const expiring = new ContextCache({ maxEntries: 4, maxTokens: 1000, ttlMilliseconds: 5_000 });
    expiring.put("c", context(10), "2026-01-01T00:00:00Z");
    assert.equal(expiring.get("c", "2026-01-01T00:00:10Z").hit, false);
    assert.equal(expiring.stats().expirations, 1);
});

test("cache invalidation is explicit and monotonic", () => {
    const cache = new ContextCache({ maxEntries: 4, maxTokens: 1000, ttlMilliseconds: 60_000 });
    cache.put("a", context(10), "2026-01-01T00:00:00Z");
    cache.put("b", context(10), "2026-01-01T00:00:00Z");
    assert.equal(cache.invalidate("a"), true);
    assert.equal(cache.invalidate("a"), false);
    assert.equal(cache.invalidateWhere(entry => entry.signature === "b"), 1);
    assert.equal(cache.stats().entries, 0);
    cache.put("c", context(10), "2026-01-01T00:00:00Z");
    cache.clear();
    assert.equal(cache.stats().entries, 0);
});

test("prune keeps protected and recent entries", () => {
    const plan = planContextPrune([
        candidate("active", { active: true }),
        candidate("pinned", { pinned: true }),
        candidate("recent", { lastAccessAt: "2026-02-01T00:00:00Z" }),
        candidate("old", { lastAccessAt: "2026-01-01T00:00:00Z" }),
    ], { keepRecent: 1, maxEntries: 3 }, { now: "2026-03-01T00:00:00Z" });
    assert.deepEqual([...plan.kept].sort(), ["active", "pinned", "recent"]);
    assert.deepEqual([...plan.pruned], ["old"]);
    assert.equal(plan.state, "draft");
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.decisions), true);
    assert.equal(Object.isFrozen(plan.pruned), true);
});

test("prune carries reasons and revisit conditions", () => {
    const plan = planContextPrune([
        candidate("superseded", { supersededBy: "new" }),
        candidate("expired", { expiresAt: "2026-01-01T00:00:00Z" }),
        candidate("cold"),
    ], { keepRecent: 0 }, { now: "2026-02-01T00:00:00Z" });
    const byId = new Map(plan.decisions.map(decision => [decision.id, decision]));
    assert.equal(byId.get("superseded")?.reason, "superseded");
    assert.equal(byId.get("expired")?.reason, "expired");
    assert.equal(byId.get("cold")?.reason, "cold");
    assert.equal(byId.get("expired")?.revisitAfter, "2026-01-01T00:00:00Z");
});

test("prune protects the reference closure of retained entries", () => {
    const plan = planContextPrune([
        candidate("kept", { references: ["evidence"] }),
        candidate("evidence"),
    ], { keepRecent: 1 }, { now: "2026-02-01T00:00:00Z" });
    assert.equal(plan.pruned.includes("evidence"), false);
    assert.equal(plan.kept.includes("evidence"), true);
});

test("capacity pressure demotes the coldest unprotected entry", () => {
    const plan = planContextPrune([
        candidate("a", { lastAccessAt: "2026-01-01T00:00:00Z", tokens: 50 }),
        candidate("b", { lastAccessAt: "2026-02-01T00:00:00Z", tokens: 50 }),
        candidate("c", { lastAccessAt: "2026-03-01T00:00:00Z", tokens: 50, active: true }),
    ], { keepRecent: 3, maxTokens: 100 }, { now: "2026-04-01T00:00:00Z" });
    assert.equal(plan.kept.includes("a"), false);
    assert.equal(plan.kept.includes("b"), true);
    assert.equal(plan.kept.includes("c"), true);
    assert.equal(plan.decisions.find(decision => decision.id === "a")?.reason, "over_budget");
});

test("prune plan lifecycle is strict", () => {
    const plan = planContextPrune([candidate("a")], { keepRecent: 0 }, { now: "2026-01-01T00:00:00Z" });
    const approved = approveContextPrune(plan);
    assert.equal(approved.state, "approved");
    assert.equal(approved.version, 2);
    assert.throws(() => approveContextPrune(approved), TypeError);
    assert.equal(rejectContextPrune(approved).state, "rejected");
    const verified = Object.freeze({ ...plan, state: "verified" as const });
    assert.throws(() => approveContextPrune(verified), TypeError);
});

test("entry transitions reject impossible moves", () => {
    assert.equal(advanceContextEntry("candidate", "cached"), "cached");
    assert.equal(advanceContextEntry("cached", "compressed"), "compressed");
    assert.throws(() => advanceContextEntry("pruned", "cached"), TypeError);
    assert.throws(() => advanceContextEntry("candidate", "compressed"), TypeError);
});

test("compaction requires an applied plan and refuses hidden references", () => {
    const candidates = [candidate("a"), candidate("b", { references: ["a"] })];
    const plan = planContextPrune(candidates, { keepRecent: 0 }, { now: "2026-01-01T00:00:00Z" });
    assert.throws(() => compactContext(candidates, plan, { now: "2026-01-01T00:00:00Z", summary: "x" }), TypeError);

    const handMade = Object.freeze({
        id: "hand", version: 2, digest: "digest", state: "applied" as const,
        decisions: Object.freeze([]), kept: Object.freeze(["b"]), pruned: Object.freeze(["a"]),
        createdAt: "2026-01-01T00:00:00Z", reason: "external plan",
    });
    assert.throws(() => compactContext(candidates, handMade, { now: "2026-01-01T00:00:00Z", summary: "x" }), /cites pruned/);

    const unlinked = [candidate("a"), candidate("b")];
    const plan2 = planContextPrune(unlinked, { keepRecent: 0 }, { now: "2026-01-01T00:00:00Z" });
    const applied2 = Object.freeze({ ...approveContextPrune(plan2), state: "applied" as const });
    const result = compactContext(unlinked, applied2, { now: "2026-01-01T00:00:00Z", summary: "compacted" });
    assert.equal(result.checkpoint.through, 2);
    assert.equal(result.checkpoint.savedTokens, 20);
    assert.equal(result.retained.length, 0);
    assert.equal(verifyContextCompaction(unlinked, result.checkpoint), true);
    assert.equal(Object.isFrozen(result.checkpoint), true);
});

test("a tampered checkpoint fails verification", () => {
    const candidates = [candidate("a")];
    const plan = planContextPrune(candidates, { keepRecent: 0 }, { now: "2026-01-01T00:00:00Z" });
    const applied = Object.freeze({ ...approveContextPrune(plan), state: "applied" as const });
    const result = compactContext(candidates, applied, { now: "2026-01-01T00:00:00Z", summary: "s" });
    const tampered = Object.freeze({ ...result.checkpoint, savedTokens: 999 });
    assert.equal(verifyContextCompaction(candidates, tampered), false);
});

test("checkpoint lifecycle and empty ledgers behave", () => {
    const candidates = [candidate("a")];
    const plan = planContextPrune(candidates, { keepRecent: 0 }, { now: "2026-01-01T00:00:00Z" });
    const applied = Object.freeze({ ...approveContextPrune(plan), state: "applied" as const });
    const { checkpoint } = compactContext(candidates, applied, { now: "2026-01-01T00:00:00Z", summary: "s" });
    assert.equal(checkpoint.state, "committed");
    assert.equal(advanceContextCheckpoint(checkpoint, "verified").state, "verified");
    assert.throws(() => advanceContextCheckpoint(checkpoint, "created"), TypeError);

    const empty = planContextPrune([], { keepRecent: 0 }, { now: "2026-01-01T00:00:00Z" });
    assert.deepEqual(empty.decisions, []);
    assert.equal(empty.pruned.length, 0);
});

test("prune rejects duplicate ids and invalid policies", () => {
    assert.throws(() => planContextPrune([candidate("a"), candidate("a")], { keepRecent: 0 }), /duplicate/);
    assert.throws(() => planContextPrune([], { keepRecent: -1 }), TypeError);
    assert.throws(() => new ContextCache({ maxEntries: 0, maxTokens: 1, ttlMilliseconds: 1 }), TypeError);
});
