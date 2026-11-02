#!/usr/bin/env node
/** Environment discovery through the builder and both agent surfaces. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HostCatalog, buildDiscoveryTree } from "../src/discover/index.ts";
import type { DiscoveryNode, DiscoveryQuery } from "../src/discover/index.ts";
import type { DiscoverySearch, DiscoverySearchResult } from "../src/discover/types.ts";
import { getDefaultEnvironments, loadDefaultEnvironments } from "../src/environment/index.ts";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceSnapshot } from "../src/context/workspace.ts";
import { GlobalAgentService } from "../src/global/service.ts";
import { SkillRegistry } from "../src/skill/index.ts";

const flatten = (node: DiscoveryNode): DiscoveryNode[] => [node, ...node.children.flatMap(flatten)];
const catalog = (): HostCatalog => {
    const host = new HostCatalog();
    host.addModule({ id: "runtime.powershell7", name: "Host PowerShell", description: "Host-confirmed runtime", category: "runtime", availability: "available", version: "7.6", platforms: ["windows"], skillIds: ["skill:pwsh"], toolIds: ["tool:run"], knowledgeIds: ["knowledge:pwsh"], protocolIds: ["protocol:exec"], relatedIds: ["language.python"] });
    loadDefaultEnvironments(host);
    host.addModule({ id: "private-runtime", name: "Private runtime", description: "PRIVATE ENVIRONMENT", category: "runtime", availability: "available", projectId: "private" });
    return host;
};
const build = (host: HostCatalog, query: DiscoveryQuery = {}) => buildDiscoveryTree({ revision: "env-r1", entities: [], projects: [], components: host.components(), query });

test("environment defaults require explicit loading and preserve host overrides", () => {
    const host = new HostCatalog();
    assert.equal(build(host, { scope: "host" }).summary.environments, 0);
    const defaults = getDefaultEnvironments();
    assert.ok(defaults.length > 20);
    assert.equal(loadDefaultEnvironments(host).length, defaults.length);
    const tree = build(host, { scope: "host", componentKind: "module", limit: 200 });
    assert.equal(tree.summary.environments, defaults.length);
    assert.equal(tree.summary.modules, 0);
    assert.ok(flatten(tree.tree).filter((node) => node.category !== undefined).every((node) => node.availability === "unknown"));
    assert.equal(loadDefaultEnvironments(host).length, 0);
});

test("environment filters, links, search and defensive projection", () => {
    const host = catalog();
    const tree = build(host, { scope: "host", category: "runtime", availability: "available", text: "skill:pwsh" });
    const nodes = flatten(tree.tree).filter((node) => node.category !== undefined);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].id, "runtime.powershell7");
    assert.deepEqual(nodes[0].toolIds, ["tool:run"]);
    assert.deepEqual(nodes[0].knowledgeIds, ["knowledge:pwsh"]);
    assert.deepEqual(nodes[0].protocolIds, ["protocol:exec"]);
    nodes[0].skillIds?.push("changed");
    assert.deepEqual(host.getComponent("runtime.powershell7")?.skillIds, ["skill:pwsh"]);
    assert.equal(tree.query.category, "runtime");
    assert.equal(tree.query.availability, "available");
    assert.equal(build(host, { category: "application", availability: "available" }).summary.nodes, 0);
});

test("environment filters exclude unrelated registries and obey scopes and budgets", () => {
    const host = catalog();
    const skills = new SkillRegistry();
    skills.register({ id: "s", name: "runtime", description: "skill", instructions: "PRIVATE INSTRUCTIONS" });
    const tree = buildDiscoveryTree({ revision: "r", entities: [], projects: [{id:"p",name:"runtime",description:"runtime",purpose:"runtime",summary:"runtime"}], components: host.components(), skills, query: { category: "runtime", limit: 1 } });
    assert.equal(tree.summary.nodes, 1);
    assert.equal(tree.summary.environments, 1);
    assert.equal(tree.summary.truncated, true);
    assert.equal(tree.summary.projects, 0);
    assert.equal(tree.summary.skills, 0);
    assert.equal(build(host, { scope: "projects", category: "runtime" }).summary.nodes, 0);
    assert.equal(build(host, { scope: "host", category: "runtime", extension: "ts" }).summary.nodes, 0);
    assert.throws(() => build(host, { category: "invalid" as never }), RangeError);
    assert.throws(() => build(host, { availability: "installed" as never }), RangeError);
});

const snapshot: WorkspaceSnapshot = { version: 1, revision: "env-r1", entities: [], relations: [], diagnostics: [] };
test("workspace and global agents route discover through async search", async () => {
    const host = catalog();
    const calls: Array<{ scope: { projectIds: readonly string[]; includeGlobal?: boolean }; queries: string | readonly string[]; }> = [];
    const search: DiscoverySearch = {
        async discover(scope, queries): Promise<DiscoverySearchResult> {
            calls.push({ scope, queries });
            const values = typeof queries === "string" ? [queries] : queries;
            return { trees: values.map((query) => ({
                query, tree: { id: "runtime.powershell7", kind: "module", label: "Host PowerShell", summary: "Host-confirmed runtime", matched: true, children: [] },
                total: 1, totalRelation: "eq", took: 1, timedOut: false, truncated: false,
            })) };
        },
    };
    const options = { agentId: "environment-agent", snapshot, store: new MemoryContentStore(), projectIds: [], host, search };
    const workspace = new WorkspaceAgentService(options);
    const global = new GlobalAgentService(options);
    for (const [service, tool] of [[workspace, "amp_tool_workspace_discover"], [global, "amp_tool_global_discover"]] as const) {
        const response = await service.callAsync(tool, { revision: snapshot.revision, queries: "powershell" });
        assert.equal(response.ok, true);
        if (!response.ok) { throw new Error("expected successful discovery"); }
        assert.equal((response.data.trees as unknown[]).length, 1);
        assert.deepEqual(calls.at(-1)?.scope, { projectIds: [], includeGlobal: true });
        assert.equal(service.call(tool, { revision: snapshot.revision, queries: "powershell" }).ok, false);
        const definition = service.tools().find((item) => item.name === tool);
        assert.ok(definition);
        assert.match(JSON.stringify(definition.inputSchema), /queries/);
        assert.doesNotMatch(JSON.stringify(definition.inputSchema), /category|availability|scope/);
    }
});
