#!/usr/bin/env node
/**
 * AgentContext/ContextWindow -> ContextAst projections.
 */
import assert from "node:assert/strict";

import { MemoryDetailStore } from "../src/context/ast.ts";
import { agentContextToAst, windowToAst } from "../src/context/projections.ts";
import type { AgentContext } from "../src/context/agentContext.ts";
import { ContextWindow } from "../src/window/window.ts";

const At = "2026-10-24T00:00:00.000Z";
const context: AgentContext = {
    profile: { pid: 1, name: "Incident Agent", lifeChapter: "on-call", values: ["evidence"], constraints: ["approval"], version: 1, updatedAt: At },
    narrative: { pid: 1, version: 2, identity: {}, narrative: "I diagnose before changing production.", at: At },
    memories: [
        {
            id: "m.1",
            pid: 1,
            kind: "episodic",
            content: "Previous rollback failed because the migration was not backward compatible.",
            salience: 0.9,
            at: At,
            refs: [],
            consolidated: true,
        },
        {
            id: "m.2",
            pid: 1,
            kind: "semantic",
            content: "Pool exhaustion is a symptom, not always the root cause.",
            salience: 0.7,
            at: At,
            refs: [],
            consolidated: true,
        },
    ],
    relationships: [],
    memberships: [],
    background: [],
    segments: [
        { kind: "self", text: "I am Incident Agent. Values: evidence.", tokens: 12 },
        { kind: "memory", text: "[episodic] Previous rollback failed...", tokens: 10 },
    ],
    tokens: 22,
    excluded: [],
};

const details = new MemoryDetailStore();
const projection = agentContextToAst(context, details);
const root = projection.ast.node("agent.context");
assert.ok(root);
assert.ok(projection.ast.node("agent.memory.m.1"));
assert.ok(projection.ast.expand("agent.memory.m.1", details)?.includes("migration"));
const agentView = projection.ast.view(400);
assert.ok(agentView.tokens <= 400);
assert.match(agentView.text, /Incident Agent|memory/);

const window = new ContextWindow({ capacityTokens: 500 });
window.fault("turn", "t.1", 40, { goal: "diagnose" });
window.fault("object", "obj.1", 30, { evidence: "db.lock_wait=critical" });
const windowAst = windowToAst(window);
assert.equal(windowAst.order().length, 3);
assert.ok(windowAst.node(`window.page.${window.entries()[0].id}`));
const windowView = windowAst.view(200);
assert.ok(windowView.tokens <= 200);
assert.match(windowView.text, /diagnose|db\.lock_wait/);

console.log(
    `agentNodes=${projection.ast.order().length} windowNodes=${windowAst.order().length} agentView=${agentView.tokens} windowView=${windowView.tokens}`,
);
console.log("\x1b[32m✓\x1b[0m AgentContext and ContextWindow project into the same AST summary/detail shape");
console.log("\n1 passed, 0 failed");
