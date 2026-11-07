import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DISCOVERY_SOURCES, DISCOVERY_SOURCES, collectDiscoveryCandidates, discover, parseDiscoveryOptions } from "./discovery.ts";
import type { DiscoveryBranch, DiscoveryCandidate, DiscoveryLeaf, DiscoveryProvider } from "./discovery.ts";

const binding = { tenantId: "t", principalId: "p", sessionId: "s", policyVersion: "v1", cancellationEpoch: 0 } as const;
const scope = { tenantId: "t", principalId: "p", sessionId: "s" } as const;

function branch(node: DiscoveryBranch | DiscoveryLeaf): DiscoveryBranch {
    if (node.kind !== "source" && node.kind !== "group") { throw new TypeError(`expected a branch, received ${node.kind}`); }
    return node;
}

function candidate(id: string, overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
    return { id, source: "amp", kind: "tool", module: "workspace", name: id, summary: "Read a workspace file",
        target: { kind: "surface", name: id }, ...overrides };
}

test("discovery ranks matches into a query/source/group tree", () => {
    const result = discover([
        candidate("attention_manifest_protocol_workspace.read", { name: "workspace read", summary: "Read a text range" }),
        candidate("attention_manifest_protocol_workspace.write", { name: "workspace write", summary: "Write text" }),
        candidate("file-content", { source: "session_files", kind: "content", module: "src/a.ts",
            name: "src/a.ts:7", summary: "export function read() {}", searchText: "export function read() {}",
            scope, target: { kind: "content", path: "src/a.ts", startLine: "7" } }),
    ], { query: "read", limit: 4 });

    assert.equal(result.tree.kind, "query");
    assert.deepEqual([...result.sources], [...DEFAULT_DISCOVERY_SOURCES]);
    assert.ok(result.returned >= 2);
    const sourceNames = result.tree.children.map(branch => branch.name);
    assert.deepEqual([...sourceNames].sort(), ["amp", "session_files"]);
    const amp = result.tree.children.find(branch => branch.name === "amp")!;
    assert.equal(amp.kind, "source");
    assert.equal(amp.children[0].kind, "group");
    const file = result.tree.children.find(branch => branch.name === "session_files")!;
    const fileLeaf = branch(branch(file).children[0]).children[0] as { kind: string; target: Record<string, string> };
    assert.equal(fileLeaf.kind, "content");
    assert.equal(fileLeaf.target.startLine, "7");
    assert.equal(result.authorization, "not_granted");
});

test("name matches outrank tools that merely mention the word in a description", () => {
    const result = discover([
        candidate("workspace.read", { name: "workspace.read", summary: "Read a text range" }),
        candidate("other", { name: "other", summary: "Read a text range" }),
    ], { query: "read" });
    const leaves = branch(branch(result.tree.children[0]).children[0]).children as readonly { id: string; score: number }[];
    assert.equal(leaves[0].id, "workspace.read");
    assert.ok(leaves[0].score > leaves[1].score);
});

test("weights and host signals change the ranking and are explained", () => {
    const result = discover([
        candidate("lexical", { name: "read", summary: "read" }),
        candidate("semantic", { name: "unrelated", summary: "unrelated", signals: { semantic: 1 } }),
    ], { query: "read", weights: { lexical: 0.1, semantic: 0.9, signature: 0, context: 0 } });
    assert.equal(result.tree.children[0].name, "amp");
    const leaves = branch(branch(result.tree.children[0]).children[0]).children as readonly
        { id: string; score: number; scores: Record<string, number>; weights: Record<string, number> }[];
    assert.equal(leaves[0].id, "semantic");
    assert.equal(leaves[0].scores.semantic, 1);
    assert.equal(leaves[0].weights.semantic, 0.9);
    assert.ok(Math.abs(leaves[0].score - 0.9) < 1e-9);
});

test("a module is capped and unselected matches are reported as truncated", () => {
    const tools = Array.from({ length: 5 }, (_, index) => candidate(`workspace-${index}`, {
        name: `workspace tool ${index}`, summary: "workspace read write",
    }));
    const result = discover(tools, { query: "workspace", limit: 5, maxPerModule: 2 });
    assert.equal(result.returned, 2);
    assert.equal(result.matched, 5);
    assert.equal(result.truncated, true);
});

test("sources are selected explicitly and default to local sources only", () => {
    const remote = candidate("remote", { source: "network", kind: "web", module: "example.com",
        name: "example", summary: "read example", target: { kind: "web", url: "https://example.com" } });
    const local = discover([remote], { query: "read" });
    assert.equal(local.returned, 0);
    assert.deepEqual([...DEFAULT_DISCOVERY_SOURCES], ["host_modules", "amp", "session_files", "session_outlines", "conversation"]);
    const selected = discover([remote], { query: "read", sources: ["network"] });
    assert.equal(selected.returned, 1);
    assert.deepEqual([...selected.sources], ["network"]);
});

test("no matches yields an empty tree and never grants authorization", () => {
    const empty = discover([], { query: "read" });
    assert.deepEqual(empty.tree.children, []);
    assert.equal(empty.considered, 0);
    assert.equal(empty.matched, 0);
    assert.equal(empty.returned, 0);
    assert.equal(empty.truncated, false);
    assert.equal(empty.authorization, "not_granted");
    assert.deepEqual([...empty.sources], [...DEFAULT_DISCOVERY_SOURCES]);

    const unmatched = discover([candidate("workspace-write", { name: "write", summary: "write" })], { query: "read" });
    assert.equal(unmatched.considered, 1);
    assert.equal(unmatched.matched, 0);
    assert.equal(unmatched.returned, 0);
    assert.equal(unmatched.truncated, false);
    assert.equal(unmatched.authorization, "not_granted");
});

test("discovery rejects invalid model parameters", () => {
    const invalid: Readonly<Record<string, unknown>>[] = [
        {}, { query: "" }, { query: "x", sources: [] }, { query: "x", sources: ["amp", "amp"] },
        { query: "x", sources: ["nope"] }, { query: "x", limit: 51 }, { query: "x", maxPerModule: 1.5 },
        { query: "x", minimumScore: 2 }, { query: "x", weights: { lexical: -1 } },
        { query: "x", weights: { unknown: 1 } }, { query: "x", extra: true },
    ];
    for (const parameters of invalid) { assert.throws(() => parseDiscoveryOptions(parameters)); }
    assert.throws(() => discover([], { query: "…" }), /searchable words/);
    assert.throws(() => discover([candidate("a"), candidate("a")], { query: "read" }), /duplicate/);
    assert.throws(() => discover([candidate("bad-kind", { kind: "nope" as never })], { query: "read" }), /kind/);
    assert.throws(() => discover([candidate("bad-target", { target: { count: 1 } as never })], { query: "read" }), /target/);
});

test("providers are scoped to the current session and failures become unavailable sources", async () => {
    const providers: DiscoveryProvider[] = [
        { source: "session_files", search: () => [
            candidate("in-scope", { source: "session_files", kind: "file", scope, target: { path: "a.ts" } }),
            candidate("other-session", { source: "session_files", kind: "file", scope: { ...scope, sessionId: "other" }, target: { path: "b.ts" } }),
        ] },
        { source: "conversation", search: () => { throw new Error("index down"); } },
    ];
    const collection = await collectDiscoveryCandidates({ providers }, { query: "read", sources: ["session_files", "conversation", "network"] }, binding);
    assert.deepEqual(collection.candidates.map(item => item.id), ["in-scope"]);
    assert.deepEqual([...collection.unavailable].sort(), ["conversation", "network"]);
    const result = discover(collection.candidates, { query: "read" });
    assert.equal(result.returned, 1);
});

test("a provider cannot return records for another source", async () => {
    const collection = await collectDiscoveryCandidates({ providers: [{
        source: "session_outlines", search: () => [candidate("wrong", { source: "amp" })],
    }] }, { query: "read", sources: ["session_outlines"] }, binding);
    assert.equal(collection.candidates.length, 0);
    assert.deepEqual([...collection.unavailable], ["session_outlines"]);
});

test("Chinese text and content snippets are searchable without leaking the body", () => {
    const body = `读取文件内容 ${"中".repeat(400)}`;
    const result = discover([candidate("cn", { source: "conversation", kind: "message", module: "turn-1",
        name: "user:1", summary: body, searchText: body, scope, target: { kind: "message", messageId: "1" } })],
    { query: "读取文件", sources: ["conversation"] });
    assert.equal(result.returned, 1);
    const leaf = branch(branch(result.tree.children[0]).children[0]).children[0] as { summary: string; searchText?: string };
    assert.equal(leaf.searchText, undefined);
    assert.ok(leaf.summary.length <= 320);
    assert.ok(DISCOVERY_SOURCES.includes("conversation"));
});
