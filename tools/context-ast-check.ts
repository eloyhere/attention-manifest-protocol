#!/usr/bin/env node
/**
 * Context AST: tree + precedence, summary budget, detail expansion.
 */
import assert from "node:assert/strict";

import { ContextAst, MemoryDetailStore } from "../src/context/ast.ts";
import type { ContextAstNode, ContextAstView } from "../src/context/ast.ts";

type FlatContext = {
    text: string;
    tokens: number;
};

const Ast: ContextAst = new ContextAst();
const Details: MemoryDetailStore = new MemoryDetailStore();
Ast.add({
    id: "incident",
    kind: "goal",
    summary: "payment API p99 2.8s and 5xx 8%; diagnose before changing limits",
    order: 0,
    salience: 1,
});
const Layers: string[] = ["thread_pool", "connection_pool", "connect", "database", "queue", "application", "release"];
for (let layerIndex: number = 0; layerIndex < Layers.length; layerIndex += 1) {
    const layer: string = Layers[layerIndex];
    const layerId: string = `layer.${layer}`;
    Ast.add({
        id: layerId,
        parentId: "incident",
        kind: "frame",
        summary: `${layer} check: utilization, saturation, errors`,
        order: layerIndex + 1,
        salience: 0.9 - layerIndex * 0.05,
    });
    for (let probe: number = 0; probe < 20; probe += 1) {
        const id: string = `${layerId}.probe.${probe}`;
        const detail: string = `${layer} probe ${probe}: ${"raw metric and stack sample ".repeat(30)}`;
        const ref: string = Details.put(id, detail);
        Ast.add({
            id,
            parentId: layerId,
            kind: "observation",
            summary: `${layer} probe ${probe} summary: key saturation signal`,
            detailRef: ref,
            detailTokens: Math.ceil(detail.length / 4),
            order: layerIndex * 100 + probe + 10,
            salience: 0.5,
        });
    }
}
for (let index: number = 1; index < 20; index += 1) {
    Ast.link({ from: "layer.thread_pool.probe.0", to: "layer.thread_pool.probe.1", kind: "before" });
}
for (let index: number = 0; index < Layers.length - 1; index += 1) {
    Ast.link({ from: `layer.${Layers[index]}`, to: `layer.${Layers[index + 1]}`, kind: "before" });
}

const Order: ContextAstNode[] = Ast.order();
assert.equal(Order.length, 148);
assert.equal(Order[0].id, "incident");
assert.equal(Ast.children("layer.database").length, 20);
assert.equal(Ast.descendants("incident").length, 147);
assert.equal(
    Ast.ancestors("layer.database.probe.3")
        .map((node) => node.id)
        .join("/"),
    "incident/layer.database",
);

const View: ContextAstView = Ast.view(1200);
assert.ok(View.tokens <= 1200);
assert.ok(View.nodes.length < Order.length);
assert.ok(View.refs.length > 0);
assert.match(View.text, /layer\.database/);

const Flat: FlatContext = Ast.flat(Details);
assert.ok(Flat.tokens > View.tokens * 3, `flat=${Flat.tokens} view=${View.tokens}`);

const Detail: string | undefined = Ast.expand("layer.database.probe.3", Details);
assert.ok(Detail?.startsWith("database probe 3:"));
assert.equal(Ast.expand("incident", Details), undefined);

const Restored: ContextAst = ContextAst.restore(Ast.serialize());
assert.equal(Restored.order().length, Ast.order().length);
assert.equal(Restored.children("layer.queue").length, 20);

console.log(`nodes=${Order.length} viewTokens=${View.tokens} flatTokens=${Flat.tokens} refs=${View.refs.length}`);
console.log("\x1b[32m✓\x1b[0m AST keeps summaries under budget, expands details on demand, and preserves tree/precedence");
console.log("\n1 passed, 0 failed");
