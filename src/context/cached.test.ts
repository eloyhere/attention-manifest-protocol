import assert from "node:assert/strict";
import test from "node:test";
import type { AttentionObject, AttentionScope } from "../attention/types.ts";
import { cachedContextSignature, compileContextCached, signature } from "./cached.ts";
import { ContextCache } from "./lifecycle.ts";
import type { CompileContextOptions } from "./types.ts";

const now = "2026-11-06T12:00:00Z";
const scope: AttentionScope = { tenantId: "tenant", principalId: "principal", sessionId: "session", turnId: "turn" };

const object = (overrides: Partial<AttentionObject> = {}): AttentionObject => {
    const id = overrides.id ?? "a";
    return {
        id,
        version: 1,
        summary: "summary",
        pointer: { kind: "file", id, version: "v1" },
        sources: [],
        references: { evidence: [], receipts: [], capabilities: [], behaviors: [] },
        scope: { ...scope },
        scores: { relevance: 1, urgency: 1, confidence: 1, importance: 1 },
        intensity: 1,
        mounted: true,
        budget: { tokens: 100000 },
        expiresAt: "2027-01-01T00:00:00Z",
        stale: false,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        lastReason: "reason",
        ...overrides,
    };
};

const options = (overrides: Partial<CompileContextOptions> = {}): CompileContextOptions => ({
    now,
    scope: { ...scope },
    budget: { tokens: 100000 },
    currentVersion: () => "v1",
    ...overrides,
});

const cache = (ttlMilliseconds = 60_000): ContextCache =>
    new ContextCache({ maxEntries: 8, maxTokens: 1_000_000, ttlMilliseconds });

test("compileContextCached reports a miss then a hit and records saved tokens", () => {
    const store = cache();
    const objects = [object()];
    const first = compileContextCached(store, objects, options(), now);
    assert.equal(first.hit, false);
    assert.equal(first.context.items.length, 1);
    assert.ok(first.context.usage.tokens > 0);

    const second = compileContextCached(store, objects, options(), now);
    assert.equal(second.hit, true);
    assert.equal(second.context, first.context);
    assert.deepEqual(second.context, first.context);

    const stats = store.stats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.equal(stats.savedTokens, first.context.usage.tokens);
});

test("signature covers scope, budget, now and each object's version tuple", () => {
    const base = cachedContextSignature([object()], options());
    assert.equal(base, cachedContextSignature([object()], options()));
    assert.equal(
        signature(scope, { tokens: 100000 }, now, [{ id: "a", version: 1, sourceVersion: "v1", mounted: true, stale: false }]),
        base,
    );
    // Delimiter-like values remain unambiguous because the tuple is JSON encoded.
    assert.notEqual(
        cachedContextSignature([object({ id: "a@1", pointer: { kind: "file", id: "a@1", version: "v1@true@false" } })], options()),
        cachedContextSignature([object({ id: "a", version: 1, pointer: { kind: "file", id: "a", version: "v1" }, mounted: true, stale: false })], options()),
    );

    assert.notEqual(base, cachedContextSignature([object({ version: 2 })], options()));
    assert.notEqual(base, cachedContextSignature([object({ pointer: { kind: "file", id: "a", version: "v2" } })], options()));
    assert.notEqual(base, cachedContextSignature([object({ mounted: false })], options()));
    assert.notEqual(base, cachedContextSignature([object({ stale: true })], options()));
    assert.notEqual(base, cachedContextSignature([object()], options({ budget: { tokens: 99999 } })));
    assert.notEqual(base, cachedContextSignature([object()], options({ scope: { ...scope, turnId: "other" } })));
    assert.notEqual(base, cachedContextSignature([object()], options({ now: "2026-11-06T12:00:01Z" })));
});

test("an object version change misses the cache", () => {
    const store = cache();
    const first = compileContextCached(store, [object()], options(), now);
    assert.equal(first.hit, false);

    const versioned = compileContextCached(store, [object({ version: 2 })], options(), now);
    assert.equal(versioned.hit, false);
    assert.equal(versioned.context.items[0]?.version, 2);
    assert.equal(store.stats().entries, 2);
});

test("a source-version change misses even when the object version is unchanged", () => {
    const store = cache();
    const first = compileContextCached(store, [object()], options(), now);
    assert.equal(first.hit, false);

    const sourceChanged = compileContextCached(
        store,
        [object({ pointer: { kind: "file", id: "a", version: "v2" } })],
        options({ currentVersion: () => "v2" }),
        now,
    );
    assert.equal(sourceChanged.hit, false);
    assert.equal(sourceChanged.context.items[0]?.sourceVersion, "v2");
});

test("a budget change misses the cache", () => {
    const store = cache();
    const first = compileContextCached(store, [object()], options(), now);
    assert.equal(first.hit, false);

    const cheaper = compileContextCached(store, [object()], options({ budget: { tokens: 50000, bytes: 50000 } }), now);
    assert.equal(cheaper.hit, false);
    assert.deepEqual(cheaper.context.budget, { tokens: 50000, bytes: 50000 });
});

test("TTL expiry turns a would-be hit into a miss and refreshes the entry", () => {
    const store = cache(1000);
    const first = compileContextCached(store, [object()], options(), now);
    assert.equal(first.hit, false);

    const expired = compileContextCached(store, [object()], options(), "2026-11-06T12:00:02Z");
    assert.equal(expired.hit, false);
    assert.equal(store.stats().expirations, 1);

    const immediate = compileContextCached(store, [object()], options(), "2026-11-06T12:00:02Z");
    assert.equal(immediate.hit, true);
});

test("compiled contexts are deeply frozen on both miss and hit", () => {
    const store = cache();
    const first = compileContextCached(store, [object()], options(), now);
    const context = first.context;
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.items), true);
    assert.equal(Object.isFrozen(context.items[0]), true);
    assert.equal(Object.isFrozen(context.items[0]?.usage), true);
    assert.equal(Object.isFrozen(context.exclusions), true);
    assert.equal(Object.isFrozen(context.budget), true);
    assert.equal(Object.isFrozen(context.scope), true);
    assert.equal(Object.isFrozen(context.usage), true);
    assert.throws(() => { (context as unknown as { text: string }).text = "tampered"; }, TypeError);
    assert.throws(() => { (context.items[0] as unknown as { summary: string }).summary = "tampered"; }, TypeError);

    const hit = compileContextCached(store, [object()], options(), now);
    assert.equal(hit.hit, true);
    assert.equal(Object.isFrozen(hit.context), true);
    assert.throws(() => { (hit.context as unknown as { text: string }).text = "tampered"; }, TypeError);
});
