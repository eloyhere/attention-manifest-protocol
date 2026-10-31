import { ContextAst, MemoryDetailStore } from "../context/ast.ts";
import type { ContextAstNode } from "../context/ast.ts";
import type { DiagnosticFrame, DiagnosticSignal, DiagnosticStep, HypothesisAssessment } from "./types.ts";
import { assessHypotheses, selectHypothesis } from "./frame.ts";

export interface DiagnosisContext {
    ast: ContextAst;
    details: MemoryDetailStore;
    view: ReturnType<ContextAst["view"]>;
    top?: ReturnType<typeof selectHypothesis>;
}

type ContextProjector = (frame: DiagnosticFrame, budgetTokens?: number) => DiagnosisContext;

/**
 * Project a DiagnosticFrame into the context AST:
 * incident -> layer steps -> signals/hypotheses. Summaries stay in the view;
 * raw signal/probe payloads live behind local refs.
 */
export const toContextAst: ContextProjector = (frame: DiagnosticFrame, budgetTokens: number = 1200): DiagnosisContext => {
    const ast: ContextAst = new ContextAst();
    const details: MemoryDetailStore = new MemoryDetailStore();
    let order: number = 0;
    ast.add({
        id: "diagnosis",
        kind: "goal",
        summary: `${frame.incident.summary} | phase=${frame.phase} | layers=${frame.layers.join(",")}`,
        order: order++,
        salience: 1,
    });
    for (let stepIndex: number = 0; stepIndex < frame.steps.length; stepIndex += 1) {
        const step: DiagnosticStep = frame.steps[stepIndex];
        const layerId: string = `step.${step.layer}`;
        ast.add({
            id: layerId,
            parentId: "diagnosis",
            kind: "frame",
            summary: `inspect ${step.layer}: ${step.probe}`,
            order: order++,
            salience: 0.8,
        });
        const signals: DiagnosticSignal[] = (frame.incident.signals ?? []).filter((signal) => signal.layer === step.layer);
        for (let signalIndex: number = 0; signalIndex < signals.length; signalIndex += 1) {
            const signal: DiagnosticSignal = signals[signalIndex];
            const id: string = `signal.${step.layer}.${signal.name}`;
            const raw: string = JSON.stringify(signal);
            const ref: string = details.put(id, raw);
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
    const ranked: HypothesisAssessment[] = assessHypotheses(frame);
    for (let index: number = 0; index < ranked.length; index += 1) {
        const assessment: HypothesisAssessment = ranked[index];
        const id: string = `hyp.${assessment.hypothesis.id}`;
        const raw: string = JSON.stringify({
            cause: assessment.hypothesis.cause,
            matched: assessment.matched,
            missing: assessment.missing,
            contradicted: assessment.contradicted,
        });
        const ref: string = details.put(id, raw);
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
    for (let index: number = 0; index < frame.steps.length - 1; index += 1) {
        ast.link({ from: `step.${frame.steps[index].layer}`, to: `step.${frame.steps[index + 1].layer}`, kind: "before" });
    }
    const firstStep: DiagnosticStep = frame.steps[0];
    if (firstStep !== (void 0)) {
        ast.link({ from: "diagnosis", to: `step.${firstStep.layer}`, kind: "before" });
    }
    return { ast, details, view: ast.view(budgetTokens), top: selectHypothesis(frame) };
};

export const diagnosisNode: (id: string) => ContextAstNode["kind"] = (id: string): ContextAstNode["kind"] =>
    id.startsWith("hyp.") ? "hypothesis" : id.startsWith("signal.") ? "observation" : "frame";
