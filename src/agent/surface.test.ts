import assert from "node:assert/strict";
import test from "node:test";
import {
    SURFACE_MODULES, SURFACE_PREFIX, assertAgentAccessible, assertBinding, assertModelParameters,
    createAgentSurface, describeSurface, findModule, findTool, isHidden,
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
