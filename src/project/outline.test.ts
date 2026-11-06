import assert from "node:assert/strict";
import test from "node:test";
import { Optional, SynchronousOrderedSet } from "semantic-typescript";
import { ProjectOutline } from "./outline.ts";
import type { OutlineBatchInput, OutlineDependency, OutlineNodeInput } from "./outline.ts";
import { WorkspaceError } from "../workspace/types.ts";

const outline = (rootId = "repo") => new ProjectOutline({ tenantId: "tenant-a", rootId, projectVersion: 1 });
const node = (path: string, type: OutlineNodeInput["type"], patch: Partial<OutlineNodeInput> = {}): OutlineNodeInput => ({
    tenantId: "tenant-a", rootId: "repo", path, type, name: path.split("/").at(-1) ?? path,
    summary: `summary ${path}`, hash: `hash-${path}`, ...patch,
});
const seed = (tree = outline()) => {
    tree.upsertBatch({ tenantId: "tenant-a", rootId: "repo", expectedVersion: 1, upsert: [
        node(".", "directory", { name: "repo" }),
        node("src", "directory"),
        node("src/main.ts", "file", { sourceRef: "file:src/main.ts", sourceVersion: 1, summary: "entry point" }),
        node("src/core", "module", { summary: "core module" }),
        node("src/core/summary", "summary", { summary: "dependency injector" }),
        node("src/core/pointer", "pointer", { summary: "design note" }),
    ] });
    return tree;
};
const deps = (items: readonly (readonly [string, string])[]): OutlineDependency[] => items.map(([from, to]) => ({ tenantId: "tenant-a", rootId: "repo", from, to, kind: "depends_on", reason: `${from} depends on ${to}` }));

test("builds a scoped rooted tree and exposes Optional path and subtree queries", () => {
    const tree = seed();
    assert.equal(tree.version, 2);
    assert.ok(tree.find("src/main.ts") instanceof Optional);
    assert.equal(tree.find("missing").isEmpty(), true);
    assert.deepEqual(tree.subtree("src/core").map(value => value.path), ["src/core", "src/core/summary", "src/core/pointer"]);
    assert.deepEqual(tree.subtree("src/main.ts").map(value => value.path), ["src/main.ts"]);
    assert.equal(tree.list().length, 6);
    assert.equal(tree.subtree(".").length, 6);
    assert.ok(tree.list().every(value => value.tenantId === "tenant-a" && value.rootId === "repo"));
});

test("rejects bad tree topology, cross scope, noncanonical paths and traversal", () => {
    const tree = outline();
    const base: OutlineBatchInput = { tenantId: "tenant-a", rootId: "repo", expectedVersion: 1, upsert: [node(".", "directory")] };
    assert.throws(() => tree.upsertBatch({ ...base, upsert: [node(".", "directory"), node("x/y", "file")] }), /invalid parent/);
    assert.throws(() => tree.upsertBatch({ ...base, upsert: [node(".", "directory"), node("x", "file", { parentPath: "x" })] }), /parent/);
    assert.throws(() => tree.upsertBatch({ ...base, upsert: [node(".", "directory"), node("../outside", "file")] }), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_path");
    assert.throws(() => tree.upsertBatch({ ...base, upsert: [node(".", "directory"), node("a\\b", "file")] }), /relative POSIX/);
    assert.throws(() => tree.upsertBatch({ ...base, tenantId: "tenant-b" }), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_scope");
    assert.throws(() => tree.upsertBatch({ ...base, rootId: "other" }), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_scope");
    assert.equal(tree.version, 1);
    assert.equal(tree.list().length, 0);
});

test("rejects duplicate paths and commits batches atomically with expectedVersion", () => {
    const tree = outline();
    assert.throws(() => tree.upsertBatch({ tenantId: "tenant-a", rootId: "repo", expectedVersion: 1, upsert: [node(".", "directory"), node(".", "directory")] }), /duplicate upsert/);
    assert.equal(tree.version, 1);
    assert.throws(() => seed(tree).upsertBatch({ tenantId: "tenant-a", rootId: "repo", expectedVersion: 1, upsert: [node("new", "file")] }), (error: unknown) => error instanceof WorkspaceError && error.code === "version_conflict");
    assert.equal(tree.find("src/main.ts").isPresent(), true);
});

test("finds keyword candidates under a hard cap and marks discovery as non-authorizing", () => {
    const tree = seed();
    const results = tree.candidates("core", 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.node.path, "src/core");
    assert.equal(results[0]?.authorization, "not_granted");
    assert.equal(tree.candidates("not-present").length, 0);
    assert.equal(new SynchronousOrderedSet(results.map(result => result.node.path)).size(), 1n);
});

test("bounded relation traversal deduplicates cycles and stops at budgets", () => {
    const tree = seed();
    tree.addDependencies(deps([["src/main.ts", "src/core"], ["src/core", "src/core/summary"], ["src/core/summary", "src/main.ts"], ["src/main.ts", "src/core/summary"]]));
    const result = tree.related("src/main.ts", { maxDepth: 8, maxCandidates: 10, maxVisited: 10 });
    assert.deepEqual(result.candidates.map(candidate => candidate.node.path), ["src/core", "src/core/summary"]);
    assert.equal(new SynchronousOrderedSet(result.visited).size(), BigInt(result.visited.length));
    assert.equal(result.authorization, "not_granted");
    assert.equal(tree.related("src/main.ts", { maxDepth: 8, maxCandidates: 1, maxVisited: 10 }).stoppedBy, "candidates");
    assert.equal(tree.related("src/main.ts", { maxDepth: 8, maxCandidates: 10, maxVisited: 1 }).stoppedBy, "visited");
    assert.equal(tree.related("src/main.ts", { maxDepth: 0, maxCandidates: 10, maxVisited: 10 }).stoppedBy, "depth");
});

test("source and rule changes propagate stale before projections can be consumed", () => {
    const tree = seed();
    tree.putProjection({ tenantId: "tenant-a", rootId: "repo", id: "arch", sourcePaths: ["src/main.ts"], payload: { nodes: ["main"] } });
    assert.equal(tree.currentProjection("arch").isPresent(), true);
    tree.updateSource({ tenantId: "tenant-a", rootId: "repo", path: "src/main.ts", sourceRef: "file:src/main.ts", version: 2, hash: "newhash", summary: "changed source" });
    assert.equal(tree.find("src/main.ts").get().stale, true);
    assert.equal(tree.currentProjection("arch").isPresent(), false);
    assert.equal(tree.findProjection("arch").get().stale, true);
    assert.throws(() => tree.upsertBatch({ tenantId: "tenant-a", rootId: "repo", expectedVersion: 2, upsert: [node("new.ts", "file")] }), (error: unknown) => error instanceof WorkspaceError && error.code === "version_conflict");

    const ruled = outline();
    ruled.upsertBatch({ tenantId: "tenant-a", rootId: "repo", expectedVersion: 1, upsert: [node(".", "directory"), node("rule.txt", "file", { ruleIds: ["r1"] })] });
    ruled.updateRuleVersion("r1", 1);
    ruled.putProjection({ tenantId: "tenant-a", rootId: "repo", id: "rules", sourcePaths: ["rule.txt"], sourceRuleIds: ["r1"], payload: "based on r1" });
    ruled.updateRuleVersion("r1", 2);
    assert.equal(ruled.find("rule.txt").get().stale, true);
    assert.equal(ruled.currentProjection("rules").isPresent(), false);
    assert.equal(ruled.findProjection("rules").get().stale, true);
});

test("returns isolated snapshots from queries and mutation results", () => {
    const tree = seed();
    const result = tree.find("src/main.ts").get() as unknown as { summary: string; staleReasons: string[] };
    result.summary = "tampered";
    result.staleReasons.push("tampered");
    const listed = tree.list();
    (listed[0] as unknown as { name: string }).name = "tampered";
    assert.equal(tree.find("src/main.ts").get().summary, "entry point");
    assert.deepEqual(tree.find("src/main.ts").get().staleReasons, []);
    assert.equal(tree.list()[0]?.name, "repo");
});

test("rejects dependencies outside the scoped tree", () => {
    const tree = seed();
    assert.throws(() => tree.addDependencies([{ tenantId: "tenant-b", rootId: "repo", from: "src/main.ts", to: "src/core", kind: "uses", reason: "cross tenant" }]), /scope mismatch/);
    assert.throws(() => tree.addDependencies([{ tenantId: "tenant-a", rootId: "other", from: "src/main.ts", to: "src/core", kind: "uses", reason: "cross root" }]), /scope mismatch/);
});

test("lazy proxies expand direct children only, cache identity, and reject old versions", () => {
    const tree = seed();
    const root = tree.lazyTree().get();
    assert.equal(root.path, ".");
    const rootAgain = tree.lazyNode(".").get();
    assert.equal(rootAgain, root);
    const children = root.children;
    assert.ok(Object.isFrozen(children));
    assert.deepEqual(children.map(child => child.path), ["src"]);
    assert.equal(children[0], tree.lazyNode("src").get());
    const source = children[0]!;
    assert.deepEqual(source.children.map(child => child.path), ["src/main.ts", "src/core"]);
    const oldChild = source.children[1]!;
    assert.equal(Object.getOwnPropertyDescriptor(oldChild, "children")?.get instanceof Function, true);
    const json = JSON.stringify(root);
    assert.ok(json.includes("\"path\":\".\""));
    assert.equal(json.includes("children"), false);
    assert.equal(tree.lazyNode("missing").isEmpty(), true);
    assert.throws(() => tree.upsertBatch({ tenantId: "tenant-a", rootId: "repo", expectedVersion: tree.version, upsert: [node("src/new/deep.ts", "file")] }), /invalid parent/);
    assert.equal(tree.version, 2);
    tree.upsertBatch({ tenantId: "tenant-a", rootId: "repo", expectedVersion: tree.version, upsert: [node("src/new.ts", "file", { parentPath: "src" })] });
    assert.throws(() => oldChild.path, (error: unknown) => error instanceof WorkspaceError && error.code === "stale");
    assert.throws(() => source.children, (error: unknown) => error instanceof WorkspaceError && error.code === "stale");
    const freshRoot = tree.lazyTree().get();
    assert.notEqual(freshRoot, root);
    assert.equal(freshRoot.path, ".");
});

test("lazy proxy children and metadata do not escape tenant or root scope", () => {
    const tree = seed();
    const foreignRoot = outline("another-root");
    assert.equal(foreignRoot.lazyTree().isEmpty(), true);
    const root = tree.lazyTree().get();
    assert.equal(root.tenantId, "tenant-a");
    assert.equal(root.rootId, "repo");
    assert.throws(() => tree.lazyNode("../outside"), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_path");
    assert.throws(() => { (root as unknown as { name: string }).name = "tampered"; }, /read-only/);
    assert.equal(tree.lazyTree().get().name, "repo");
});
