import assert from "node:assert/strict";
import test from "node:test";
import {
    createConversationDiscoveryProvider, createHostModuleDiscoveryProvider, createNetworkDiscoveryProvider,
    createSessionFileDiscoveryProvider, createSessionOutlineDiscoveryProvider,
} from "./discoveryProviders.ts";

const binding = { tenantId: "t", principalId: "p", sessionId: "s", policyVersion: "v1", cancellationEpoch: 0 } as const;
const scope = { tenantId: "t", principalId: "p", sessionId: "s" } as const;

test("host modules expose the module and each declared tool", async () => {
    const provider = createHostModuleDiscoveryProvider(async () => [{
        id: "build", name: "Build", summary: "Build and test", keywords: ["compile"],
        tools: [{ id: "run", name: "build.run", summary: "Run a build", keywords: ["compile"] }],
    }]);
    const candidates = await provider.search("build", binding);
    assert.deepEqual(candidates.map(item => item.kind), ["module", "tool"]);
    assert.deepEqual(candidates.map(item => item.target), [
        { kind: "host_module", moduleId: "build" },
        { kind: "host_tool", moduleId: "build", toolId: "run" },
    ]);
    assert.equal(candidates[1].keywords?.includes("compile"), true);
});

test("session files produce path candidates and bounded line candidates", async () => {
    const long = "x".repeat(5000);
    const provider = createSessionFileDiscoveryProvider(() => [
        { scope, id: "a", path: "src/a.ts", version: "v1", content: "first\r\nsecond line\r\n" },
        { scope, id: "b", path: "src/b.bin", version: "v1" },
        { scope: { ...scope, sessionId: "other" }, id: "c", path: "secret.ts", version: "v1", content: "hidden" },
        { scope, id: "d", path: "big.txt", version: "v1", content: long },
    ]);
    const candidates = await provider.search("", binding);
    const paths = candidates.filter(item => item.kind === "file").map(item => item.module);
    assert.deepEqual(paths, ["src/a.ts", "src/b.bin", "big.txt"]);
    const lines = candidates.filter(item => item.kind === "content");
    assert.deepEqual(lines.filter(item => item.module === "src/a.ts").map(item => item.target.startLine), ["1", "2"]);
    const big = lines.find(item => item.module === "big.txt")!;
    assert.equal(big.summary.length, 320);
    assert.equal(big.searchText?.length, 4096);
    assert.equal(new Set(candidates.map(item => item.id)).size, candidates.length);
});

test("session outlines carry parent and line anchors", async () => {
    const provider = createSessionOutlineDiscoveryProvider(async () => [{
        scope, id: "o", path: "src/a.ts", version: "v2",
        nodes: [
            { id: "n1", name: "add", summary: "Add numbers", startLine: 3, endLine: 8 },
            { id: "n2", name: "child", summary: "", parentId: "n1", startLine: 5, endLine: 5 },
        ],
    }]);
    const candidates = await provider.search("add", binding);
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates[0].target, { kind: "outline", outlineId: "o", nodeId: "n1", path: "src/a.ts", version: "v2",
        startLine: "3", endLine: "8" });
    assert.equal(candidates[1].target.parentId, "n1");
    assert.equal(candidates[1].summary, "child");
});

test("conversation messages are scoped and clipped", async () => {
    const provider = createConversationDiscoveryProvider(() => [
        { scope, id: "m1", turnId: "t1", role: "user", content: `read ${"y".repeat(5000)}` },
        { scope: { ...scope, principalId: "other" }, id: "m2", turnId: "t1", role: "user", content: "read secret" },
    ]);
    const candidates = await provider.search("read", binding);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, "message");
    assert.equal(candidates[0].summary.length, 320);
    assert.equal(candidates[0].searchText?.length, 4096);
    assert.deepEqual(candidates[0].target, { kind: "message", messageId: "m1", turnId: "t1", role: "user" });
});

test("network results validate and deduplicate HTTP(S) URLs", async () => {
    const queries: string[] = [];
    const provider = createNetworkDiscoveryProvider(query => {
        queries.push(query);
        return [
            { url: "https://example.com/a", title: "A", snippet: "first" },
            { url: "https://example.com/a", title: "A duplicate", snippet: "second" },
            { url: "http://example.org/b", title: "", snippet: "B" },
        ];
    });
    const candidates = await provider.search("read", binding);
    assert.deepEqual(queries, ["read"]);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].module, "example.com");
    assert.equal(candidates[0].summary, "first");
    assert.equal(candidates[1].module, "example.org");
});

test("network rejects non-HTTP results instead of returning them as navigation", async () => {
    const provider = createNetworkDiscoveryProvider(() => [{ url: "javascript:alert(1)", title: "bad", snippet: "" }]);
    await assert.rejects(async () => { await provider.search("read", binding); }, /HTTP\(S\)/);
});
