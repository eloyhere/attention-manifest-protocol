/**
 * Tool routing: AST/diagnosis candidates -> read-only probe.
 *
 * This is deliberately not an executor. It selects a tool and explains why; the
 * runtime still wraps it in an Action/Operation and approval policy.
 */
import { selectHypothesis } from "./frame.ts";
import type { DiagnosticFrame, DiagnosticLayer, HypothesisAssessment } from "./types.ts";

export type ToolIntent = "inspect" | "discriminate" | "confirm" | "refute";

export interface ToolBinding {
    layer: DiagnosticLayer;
    hypothesisId?: string;
    tool: string;
    intent: ToolIntent;
    readOnly: true;
    produces: "metric" | "trace" | "log" | "lock" | "profile";
}

export interface ToolRoute {
    tool: string;
    layer: DiagnosticLayer;
    hypothesisId?: string;
    intent: ToolIntent;
    readOnly: true;
    reason: string;
}

export const DefaultToolBindings: readonly ToolBinding[] = [
    { layer: "thread_pool", tool: "thread_dump", intent: "inspect", readOnly: true, produces: "profile" },
    { layer: "connection_pool", tool: "pool_stats", intent: "inspect", readOnly: true, produces: "metric" },
    { layer: "connect", tool: "connect_stats", intent: "inspect", readOnly: true, produces: "metric" },
    { layer: "database", hypothesisId: "db_lock", tool: "pg_locks", intent: "discriminate", readOnly: true, produces: "lock" },
    { layer: "database", hypothesisId: "db_slow_query", tool: "pg_stat_statements", intent: "discriminate", readOnly: true, produces: "trace" },
    { layer: "database", tool: "pg_stat_statements", intent: "inspect", readOnly: true, produces: "trace" },
    { layer: "queue", tool: "queue_lag", intent: "inspect", readOnly: true, produces: "metric" },
    { layer: "application", tool: "app_profile", intent: "inspect", readOnly: true, produces: "profile" },
    { layer: "release", tool: "version_diff", intent: "inspect", readOnly: true, produces: "log" },
];

type ToolRouter = (frame: DiagnosticFrame, bindings?: readonly ToolBinding[], minConfidence?: number) => ToolRoute | undefined;

export const routeTool: ToolRouter = (frame: DiagnosticFrame, bindings: readonly ToolBinding[] = DefaultToolBindings, minConfidence = 0.5) => {
    const top: HypothesisAssessment | undefined = selectHypothesis(frame);
    if (top !== (void 0) && top.confidence >= minConfidence) {
        const exact: ToolBinding[] = bindings.filter((binding) => binding.layer === top.hypothesis.layer && binding.hypothesisId === top.hypothesis.id);
        const layer: ToolBinding[] = bindings.filter((binding) => binding.layer === top.hypothesis.layer && binding.hypothesisId === (void 0));
        const selected: ToolBinding | undefined = exact[0] ?? layer[0];
        if (selected !== (void 0)) {
            return {
                tool: selected.tool,
                layer: selected.layer,
                hypothesisId: top.hypothesis.id,
                intent: selected.intent,
                readOnly: true,
                reason: `${top.hypothesis.id} confidence=${top.confidence.toFixed(2)}; matched=${top.matched.join(",") || "none"}`,
            };
        }
    }
    const fallback: ToolBinding | undefined = bindings.find((binding) => binding.layer === "thread_pool") ?? bindings[0];
    if (fallback === (void 0)) {
        return undefined;
    }
    return {
        tool: fallback.tool,
        layer: fallback.layer,
        intent: fallback.intent,
        readOnly: true,
        reason: top === (void 0) ? "no hypothesis; start with thread dump" : `weak hypothesis confidence=${top.confidence.toFixed(2)}; start with thread dump`,
    };
};
