import { ContextAst, MemoryDetailStore } from "../context/ast.ts";
import type { ContextAstNode } from "../context/ast.ts";
import type { DiagnosticFrame } from "./types.ts";
import { assessHypotheses, selectHypothesis } from "./frame.ts";

export interface DiagnosisContext {
    ast: ContextAst;
    details: MemoryDetailStore;
    view: ReturnType<ContextAst["view"]>;
    top?: ReturnType<typeof selectHypothesis>;
}

/**
 * Project a DiagnosticFrame into the context AST:
 * incident -> layer steps -> signals/hypotheses. Summaries stay in the view;
 * raw signal/probe payloads live behind local refs.
 */
export const toContextAst = (frame: DiagnosticFrame, budgetTokens = 1200): DiagnosisContext => {
    const ast = new ContextAst();
    const details = new MemoryDetailStore();
    let order = 0;
    ast.add({
        id: "diagnosis",
        kind: "goal",
        summary: `${frame.incident.summary} | phase=${frame.phase} | layers=${frame.layers.join(",")}`,
        order: order++,
        salience: 1,
    });
    for (const step of frame.steps) {
        const layerId = `step.${step.layer}`;
        ast.add({
            id: layerId,
            parentId: "diagnosis",
            kind: "frame",
            summary: `inspect ${step.layer}: ${step.probe}`,
            order: order++,
            salience: 0.8,
        });
        const signals = (frame.incident.signals ?? []).filter((signal) => signal.layer === step.layer);
        for (const signal of signals) {
            const id = `signal.${step.layer}.${signal.name}`;
            const raw = JSON.stringify(signal);
            const ref = details.put(id, raw);
            ast.add({
                id,
                parentId: layerId,
                kind: "observation",
                summary: `${signal.layer}/${signal.kind}/${signal.name}: ${signal.state}`,
                detailRef: ref,
                detailTokens: Math.ceil(raw.length / 4),
                order: order++,
                salience: signal.state === "critical" ? 0.95 : 0.6,
            });
        }
    }
    const ranked = assessHypotheses(frame);
    for (const assessment of ranked) {
        const id = `hyp.${assessment.hypothesis.id}`;
        const raw = JSON.stringify({
            cause: assessment.hypothesis.cause,
            matched: assessment.matched,
            missing: assessment.missing,
            contradicted: assessment.contradicted,
        });
        const ref = details.put(id, raw);
        ast.add({
            id,
            parentId: "diagnosis",
            kind: "hypothesis",
            summary: `${assessment.hypothesis.layer}: ${assessment.hypothesis.cause} (confidence=${assessment.confidence.toFixed(2)})`,
            detailRef: ref,
            detailTokens: Math.ceil(raw.length / 4),
            order: order++,
            salience: assessment.confidence,
        });
    }
    for (let index = 0; index < frame.steps.length - 1; index += 1) {
        ast.link({ from: `step.${frame.steps[index].layer}`, to: `step.${frame.steps[index + 1].layer}`, kind: "before" });
    }
    const firstStep = frame.steps[0];
    if (firstStep !== undefined) ast.link({ from: "diagnosis", to: `step.${firstStep.layer}`, kind: "before" });
    return { ast, details, view: ast.view(budgetTokens), top: selectHypothesis(frame) };
};

export const diagnosisNode = (id: string): ContextAstNode["kind"] =>
    id.startsWith("hyp.") ? "hypothesis" : id.startsWith("signal.") ? "observation" : "frame";
