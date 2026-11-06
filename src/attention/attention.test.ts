import assert from "node:assert/strict";
import test from "node:test";
import { SynchronousOrderedMap, SynchronousOrderedSet } from "semantic-typescript";
import { AttentionError, associate, blur, compileContext, createAttention, focus, mount, persist, unmount, update, verify } from "../attention.ts";
import type { AssociationOptions, AttentionObject, AttentionScope } from "../attention.ts";
import { compileContext as compileContextFromContext } from "../context/index.ts";
import type { CompiledContext } from "../context/index.ts";

const now = "2026-11-06T12:00:00Z";
const expiry = "2026-11-07T12:00:00Z";
const scope: AttentionScope = { tenantId: "tenant", principalId: "principal", sessionId: "session", turnId: "turn", workspaceId: "workspace" };
const operation = (object: AttentionObject) => ({ expectedVersion: object.version, now, reason: "test selection" });
const make = (id = "a", ownScope = scope): AttentionObject => createAttention({
    id, summary: `Summary ${id}`, pointer: { kind: "file", id, version: "v1" },
    scope: ownScope, budget: { tokens: 10000, bytes: 10000 }, expiresAt: expiry, reason: "current task",
}, now);
const association = (objects: AttentionObject[], links: AssociationOptions["links"], patch: Partial<AssociationOptions> = {}): AssociationOptions => ({
    now, scope, objects, links, maxDepth: 4, maxCandidates: 10, maxVisited: 20, budget: { calls: 20 }, ...patch,
});
const compile = (objects: AttentionObject[], patch: Partial<Parameters<typeof compileContext>[1]> = {}) => compileContext(objects, {
    now, scope, budget: { tokens: 10000, bytes: 10000 }, currentVersion: () => "v1", ...patch,
});

test("context domain owns compiler while attention entry remains compatible", () => {
    assert.equal(compileContextFromContext, compileContext);
    const output: CompiledContext = compileContextFromContext([], {
        now, scope, budget: { bytes: 1000 }, currentVersion: () => undefined,
    });
    assert.equal(output.version, "attention-context/1");
    assert.equal(output.text, "");
});

test("eight operations keep intensity, residency, retention and assessment distinct", () => {
    const initial = make();
    const focused = focus(initial, operation(initial));
    assert.equal(initial.version, 1);
    assert.equal(initial.intensity, 0.5);
    assert.equal(focused.version, 2);
    assert.ok(focused.intensity > initial.intensity);
    assert.equal(focused.mounted, false);
    const mounted = mount(focused, operation(focused));
    const blurred = blur(mounted, operation(mounted));
    assert.equal(blurred.mounted, true);
    assert.equal(blurred.summary, initial.summary);
    const retained = persist(blurred, { across: "turns", reason: "follow-up", expiresAt: expiry, budget: { tokens: 5000 } }, operation(blurred));
    const assessed = verify(retained, { verifier: { kind: "ranking", id: "verifier", version: "1" }, sourceVersion: "v1", posterior: 0.8, evidence: [], recommendation: "retain" }, operation(retained));
    assert.equal(assessed.assessment?.businessVerified, false);
    assert.equal(assessed.assessment?.objectVersion, assessed.version);
    const refreshed = update(assessed, { summary: "Refreshed", scores: { relevance: 1 }, pointer: { kind: "file", id: "a", version: "v2" } }, operation(assessed));
    assert.equal(refreshed.assessment, undefined);
    assert.equal(refreshed.pointer.version, "v2");
    const removed = unmount(refreshed, operation(refreshed));
    assert.equal(removed.mounted, false);
    assert.equal(removed.summary, "Refreshed");
    assert.equal(removed.retention?.across, "turns");
});

test("operations reject CAS conflicts, expired data and invalid retention", () => {
    const object = make();
    assert.throws(() => focus(object, { ...operation(object), expectedVersion: 0 }), (error: unknown) => error instanceof AttentionError && error.code === "version_conflict");
    assert.throws(() => mount(object, { ...operation(object), now: expiry }), /expired/);
    assert.throws(() => persist(object, { across: "turns", reason: "retain", expiresAt: expiry, budget: {} }, operation(object)), /explicit budget/);
    assert.throws(() => persist(object, { across: "turns", reason: "retain", expiresAt: "2027-01-01T00:00:00Z", budget: { tokens: 1 } }, operation(object)), /outlive/);
    assert.throws(() => createAttention({ id: "bad", summary: "bad", pointer: object.pointer, scope, budget: { tokens: -1 }, expiresAt: expiry, reason: "test" }, now), /nonnegative/);
    const stale = update(object, { stale: true }, operation(object));
    assert.throws(() => mount(stale, operation(stale)), /stale/);
    assert.equal(update(stale, { stale: false, summary: "Reloaded" }, operation(stale)).stale, false);
});

test("associate deduplicates cycles and never crosses scope or grants authority", () => {
    const a = make("a"), b = make("b"), c = make("c"), foreign = make("foreign", { ...scope, workspaceId: "other" });
    const links = new SynchronousOrderedMap([
        ["a", [{ id: "b", reason: "dependency" }, { id: "foreign", reason: "other scope" }]],
        ["b", [{ id: "a", reason: "cycle" }, { id: "c", reason: "next" }]],
        ["c", [{ id: "b", reason: "cycle" }]],
    ]);
    const result = associate(a, association([a, b, c, foreign], links));
    assert.deepEqual(result.candidates.map(candidate => candidate.object.id), ["b", "c"]);
    assert.equal(result.authorization, "not_granted");
    assert.ok(result.candidates.every(candidate => candidate.authorization === "not_granted"));
    assert.equal(new SynchronousOrderedSet(result.visited).size(), BigInt(result.visited.length));
    assert.equal(result.candidates[1]?.depth, 2);
    assert.equal(a.mounted, false);
    assert.equal(associate(a, association([a, b, c], links, { maxDepth: 1 })).candidates.length, 1);
    assert.equal(associate(a, association([a, b, c], links, { maxCandidates: 1 })).candidates.length, 1);
    assert.equal(associate(a, association([a, b, c], links, { maxVisited: 1 })).candidates.length, 0);
    const exhausted = associate(a, association([a, b, c], links, { budget: { calls: 1 } }));
    assert.equal(exhausted.stoppedBy, "budget");
    assert.equal(exhausted.usage.calls, 1);
});

test("compiler filters stale, expired, unmounted, foreign and changed-version objects", () => {
    const a = make("a");
    const active = mount(a, operation(a));
    const old = { ...mount(make("old"), operation(make("old"))), expiresAt: now };
    const stale = { ...mount(make("stale"), operation(make("stale"))), stale: true };
    const foreign = mount(make("foreign", { ...scope, tenantId: "other" }), operation(make("foreign")));
    const changed = mount(make("changed"), operation(make("changed")));
    const result = compile([active, make("unmounted"), old, stale, foreign, changed], {
        currentVersion: pointer => pointer.id === "changed" ? "v2" : "v1",
    });
    assert.deepEqual(result.items.map(item => item.id), ["a"]);
    assert.ok(new SynchronousOrderedSet(result.exclusions.map(item => item.reason)).equals(new SynchronousOrderedSet(["unmounted", "expired", "stale", "scope", "version"])));
    assert.ok(result.text.includes("Summary a"));
    assert.equal(result.items[0]?.version, active.version);
    assert.equal(result.items[0]?.sourceVersion, "v1");
    assert.equal(result.authorization, "not_granted");
    assert.equal(result.usage.bytes, new TextEncoder().encode(result.text).byteLength);
    assert.equal(result.usage.tokens, result.usage.bytes);
});

test("compiler retains pointers on budget rejection and records actual payload usage", () => {
    const a = make("a"), b = make("b");
    const first = mount(a, operation(a)), second = mount(b, operation(b));
    const empty = compile([first], { budget: { tokens: 0, bytes: 0 } });
    assert.equal(empty.items.length, 0);
    assert.equal(empty.text, "");
    assert.equal(empty.exclusions[0]?.reason, "budget");
    assert.equal(empty.exclusions[0]?.pointer?.id, "a");
    const one = compile([first]);
    const bounded = compile([first, second], { budget: { bytes: one.usage.bytes } });
    assert.equal(bounded.items.length, 1);
    assert.ok(bounded.usage.bytes <= one.usage.bytes);
    assert.equal(compile([first], { currentVersion: () => undefined }).items.length, 0);
    assert.throws(() => compile([first], { countTokens: () => -1 }), /Tokenizer/);
});

test("cross-turn retention respects expiry and source ownership", () => {
    const object = make();
    const active = mount(object, operation(object));
    assert.equal(compile([active], { scope: { ...scope, turnId: "next" } }).items.length, 0);
    const retained = persist(active, { across: "turns", reason: "next turn", expiresAt: "2026-11-06T13:00:00Z", budget: { tokens: 5000 } }, operation(active));
    assert.equal(compile([retained], { scope: { ...scope, turnId: "next" } }).items.length, 1);
    assert.equal(compile([retained], { now: "2026-11-06T14:00:00Z", scope: { ...scope, turnId: "next" } }).items.length, 0);
    assert.equal(compile([retained], { scope: { ...scope, turnId: "next", principalId: "other" } }).items.length, 0);
});
