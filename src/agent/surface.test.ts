import assert from "node:assert/strict";
import test from "node:test";
import {
    DISCOVER_TOOL_NAME, SURFACE_MODULES, SURFACE_PREFIX, assertAgentAccessible, assertBinding, assertModelParameters,
    createAgentSurface, createDiscoverySurface, describeSurface, findModule, findTool, isHidden,
} from "./surface.ts";

const HIDDEN = ["workflow", "policy", "profession", "behaviour"];

test("the agent surface exposes named, unique, authority-bearing tools", () => {
    const surface = createAgentSurface();
    assert.equal(surface.prefix, SURFACE_PREFIX);
    assert.ok(surface.tools.length > 30);
    const names = new Set(surface.tools.map(tool => tool.name));
    assert.equal(names.size, surface.tools.length);
    for (const tool of surface.tools) {
        assert.match(tool.name, /^attention_manifest_protocol_[a-z0-9_]+\.[a-z0-9_]+$/);
        assert.ok(tool.description.length > 0, tool.name);
        assert.ok(tool.authority.length > 0, tool.name);
        assert.equal(Object.isFrozen(tool), true);
    }
    assert.equal(Object.isFrozen(surface.tools), true);
});

test("hidden modules never appear as tools", () => {
    const surface = createAgentSurface();
    for (const module of HIDDEN) {
        assert.equal(isHidden(module), true, module);
        assert.equal(surface.hidden.includes(module), true, module);
        assert.equal(surface.tools.some(tool => tool.module === module), false, module);
        const entry = findModule(module).get();
        assert.equal(entry.tier, "hidden");
        assert.equal(entry.exposed.length, 0);
    }
});

test("mutating verbs are marked and host-only verbs stay withheld", () => {
    const write = findTool(`${SURFACE_PREFIX}_workspace.write`).get();
    assert.equal(write.mutating, true);
    assert.deepEqual(write.authority, ["workspace:write"]);
    const read = findTool(`${SURFACE_PREFIX}_workspace.read`).get();
    assert.equal(read.mutating, false);

    const budget = findModule("budget").get();
    assert.deepEqual(budget.exposed.map(item => item.verb), ["remaining"]);
    assert.equal(budget.withheld.some(item => item.verb === "grant"), true);

    const goal = findModule("goal").get();
    assert.equal(goal.exposed.some(item => item.verb === "achieve"), false);
    assert.equal(goal.withheld.some(item => item.verb === "achieve"), true);
});

test("workspace.diff is an exposed read-only structured comparison", () => {
    const workspace = findModule("workspace").get();
    const entry = workspace.exposed.find(item => item.verb === "diff");
    assert.ok(entry, "workspace.diff must be exposed");
    assert.equal(entry.mutating, false);
    assert.deepEqual(entry.authority, ["workspace:read"]);
    assert.equal(entry.summary, "Compare the buffer with the committed base and return structured hunks.");

    const tool = findTool(`${SURFACE_PREFIX}_workspace.diff`).get();
    assert.equal(tool.mutating, false);
    assert.deepEqual(tool.authority, ["workspace:read"]);
    assert.equal(tool.description, entry.summary);

    const surface = createAgentSurface();
    assert.equal(surface.tools.filter(candidate => candidate.name === tool.name).length, 1);
    assert.equal(new Set(surface.tools.map(candidate => candidate.name)).size, surface.tools.length);
});

test("module access is asserted, not assumed", () => {
    assert.equal(assertAgentAccessible("workspace").module, "workspace");
    assert.throws(() => assertAgentAccessible("workflow"), /hidden, not agent accessible/);
    assert.throws(() => assertAgentAccessible("manifest"), /host, not agent accessible/);
    assert.throws(() => assertAgentAccessible("nope"), /unknown surface module/);
    assert.equal(isHidden("workspace"), false);
    assert.equal(isHidden("receipt"), false);
    assert.equal(findTool(`${SURFACE_PREFIX}_workspace.write`).isPresent(), true);
    assert.equal(findTool(`${SURFACE_PREFIX}_workflow.transition`).isEmpty(), true);
});

test("a restricted surface rejects hidden modules and filters tools", () => {
    const only = createAgentSurface({ only: ["workspace", "project"] });
    assert.deepEqual([...new Set(only.tools.map(tool => tool.module))].sort(), ["project", "workspace"]);
    assert.throws(() => createAgentSurface({ only: ["workspace", "workflow"] }), /hidden, not agent accessible/);
    assert.throws(() => createAgentSurface({ only: ["policy"] }), /hidden, not agent accessible/);
});

test("project views and outline are withheld from the model", () => {
    const project = findModule("project").get();
    assert.equal(project.tier, "agent", "the tier set must stay unchanged");
    assert.deepEqual(project.exposed.map(item => item.verb),
        ["rules", "metadata", "environment", "describe_environment", "configure_environment", "put_rule"]);

    for (const verbName of ["views", "outline"]) {
        assert.equal(project.exposed.some(item => item.verb === verbName), false, verbName);
        assert.equal(findTool(`${SURFACE_PREFIX}_project.${verbName}`).isEmpty(), true, verbName);
        const entry = project.withheld.find(item => item.verb === verbName);
        assert.ok(entry, `${verbName} must be withheld`);
        assert.match(entry.reason, /§13\.5/, verbName);
        assert.match(entry.reason, /视图渲染与脑图结构不进模型上下文/, verbName);
    }
    assert.equal(findTool(`${SURFACE_PREFIX}_project.rules`).isPresent(), true);
    assert.equal(findTool(`${SURFACE_PREFIX}_project.metadata`).isPresent(), true);
    assert.equal(findTool(`${SURFACE_PREFIX}_project.environment`).isPresent(), true);
    assert.equal(findTool(`${SURFACE_PREFIX}_project.describe_environment`).isPresent(), true);
});

test("project configuration verbs are exposed as mutating, authority-bound tools", () => {
    const project = findModule("project").get();
    const expected = [
        ["configure_environment", "Apply a project environment patch (variables, paths, dependencies) with CAS."],
        ["put_rule", "Create or update a project rule with an expected version."],
    ] as const;
    for (const [name, summary] of expected) {
        const entry = project.exposed.find(item => item.verb === name);
        assert.ok(entry, `${name} must be exposed`);
        assert.equal(entry.mutating, true, name);
        assert.deepEqual(entry.authority, ["project:write"], name);
        assert.equal(entry.summary, summary, name);
        assert.equal(project.withheld.some(item => item.verb === name), false, name);

        const tool = findTool(`${SURFACE_PREFIX}_project.${name}`).get();
        assert.equal(tool.mutating, true, name);
        assert.deepEqual(tool.authority, ["project:write"], name);
        assert.equal(tool.description, summary, name);
    }
    for (const verbName of ["putRule", "configureEnvironment"]) {
        assert.equal(project.withheld.some(item => item.verb === verbName), false, verbName);
    }
    const names = createAgentSurface().tools.map(candidate => candidate.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.filter(name => name === `${SURFACE_PREFIX}_project.configure_environment`).length, 1);
    assert.equal(names.filter(name => name === `${SURFACE_PREFIX}_project.put_rule`).length, 1);
});

test("bindings must be complete and model parameters cannot smuggle context", () => {
    assert.doesNotThrow(() => assertBinding({ tenantId: "t", principalId: "p", sessionId: "s", policyVersion: "v1", cancellationEpoch: 0 }));
    assert.throws(() => assertBinding({ tenantId: "", principalId: "p", sessionId: "s", policyVersion: "v1", cancellationEpoch: 0 }), /tenantId/);
    assert.throws(() => assertBinding({ tenantId: "t", principalId: "p", sessionId: "s", policyVersion: "v1", cancellationEpoch: -1 }), /cancellationEpoch/);

    assert.doesNotThrow(() => assertModelParameters({ path: "src/a.ts", start: 1 }));
    for (const key of ["tenantId", "principalId", "sessionId", "policyVersion", "cancellationEpoch", "owner", "fence"]) {
        assert.throws(() => assertModelParameters({ [key]: "x" }), /bound by the host/, key);
    }
    assert.throws(() => assertModelParameters({ nested: { tenantId: "t" } }), /bound by the host/);
});

test("discover is a bootstrap tool outside the domain surface", () => {
    assert.equal(DISCOVER_TOOL_NAME, `${SURFACE_PREFIX}_discover`);
    assert.equal(findTool(DISCOVER_TOOL_NAME).isPresent(), true);
    assert.equal(findTool(DISCOVER_TOOL_NAME).get().mutating, false);
    assert.deepEqual(findTool(DISCOVER_TOOL_NAME).get().authority, ["execution:find"]);
    assert.equal(findTool(`${SURFACE_PREFIX}_workspace.write`).get().keywords?.includes("edit"), true);
    assert.equal(findTool(`${SURFACE_PREFIX}_execution.run`).get().keywords?.includes("执行"), true);
    assert.equal(createAgentSurface().tools.some(tool => tool.name === DISCOVER_TOOL_NAME), false);
    const bootstrap = createDiscoverySurface();
    assert.deepEqual(bootstrap.tools.map(tool => tool.name), [DISCOVER_TOOL_NAME]);
    assert.deepEqual([...bootstrap.modules], []);
    assert.match(describeSurface(bootstrap), /attention_manifest_protocol_discover/);
});

test("every agent module is declared with a summary and the surface renders", () => {
    for (const entry of SURFACE_MODULES) {
        assert.ok(entry.summary.length > 0, entry.module);
    }
    const text = describeSurface();
    assert.match(text, /^# Agent surface/m);
    assert.match(text, /attention_manifest_protocol_workspace\.write/);
    assert.match(text, /## Withheld from the model/);
    assert.match(text, /- workflow \(hidden\)/);
    assert.match(text, /- manifest \(host\)/);
});
