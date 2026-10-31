#!/usr/bin/env node
/**
 * Opt-in microbenchmark: global ordering plus filtering versus indexed scope.
 * Timings are observations, never pass/fail thresholds or model-quality claims.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { ContextAst } from "../src/context/ast.ts";
import type { ContextAstNode } from "../src/context/ast.ts";

const medianMs: (run: () => ContextAstNode[]) => number = (run: () => ContextAstNode[]): number => {
    for (let warmup: number = 0; warmup < 8; warmup += 1) {
        run();
    }
    const samples: number[] = [];
    for (let sample: number = 0; sample < 9; sample += 1) {
        const start: number = performance.now();
        for (let repeat: number = 0; repeat < 10; repeat += 1) {
            run();
        }
        samples.push((performance.now() - start) / 10);
    }
    return samples.sort((left, right) => left - right)[4];
};

for (let sizeIndex: number = 0; sizeIndex < 3; sizeIndex += 1) {
    const size: number = [128, 2048, 16384][sizeIndex];
    const graph: ContextAst = new ContextAst()
        .add({ id: "root", kind: "goal", summary: "root", order: 0 })
        .add({ id: "branch", parentId: "root", kind: "frame", summary: "branch", order: 1 })
        .add({ id: "chosen", parentId: "branch", kind: "evidence", summary: "chosen", order: 2 });
    for (let index: number = 3; index < size; index += 1) {
        graph.add({ id: `other.${index}`, kind: "evidence", summary: "unrelated", order: index });
        if (index > 3) {
            graph.link({ from: `other.${index - 1}`, to: `other.${index}`, kind: "before" });
            graph.link({ from: `other.${index}`, to: `other.${index - 1}`, kind: "supports" });
        }
    }
    const scope: string[] = ["root", "branch", "chosen"];
    const eligible: Set<string> = new Set(scope);
    const globalThenFilter: () => ContextAstNode[] = (): ContextAstNode[] => graph.order().filter((node) => eligible.has(node.id));
    const scoped: () => ContextAstNode[] = (): ContextAstNode[] => graph.order(scope);
    assert.deepEqual(globalThenFilter(), scoped());
    assert.deepEqual(
        graph.view(200, ["chosen"]).nodes.map((node) => node.id),
        scope,
    );
    console.log(JSON.stringify({ nodes: size, scope: scope.length, globalThenFilterMs: medianMs(globalThenFilter), indexedScopeMs: medianMs(scoped) }));
}
