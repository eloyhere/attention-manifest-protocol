import { LayerOrder, clamp01 } from "./types.ts";
import type {
    DiagnosticFrame,
    DiagnosticLayer,
    DiagnosticSignal,
    DiagnosticStep,
    Hypothesis,
    HypothesisAssessment,
    IncidentInput,
    SignalPattern,
} from "./types.ts";
import { stepsFor } from "./checklist.ts";
import type { PlanTask } from "../goal/plan.ts";
import type { ActionPlan } from "../runtime/action.ts";

export const DefaultHypotheses: readonly Hypothesis[] = [
    {
        id: "thread_pool_exhaustion",
        cause: "worker threads are exhausted or blocked",
        layer: "thread_pool",
        supports: [
            { layer: "thread_pool", kind: "saturation", name: "thread.queue" },
            { layer: "thread_pool", kind: "utilization", name: "thread.active_max" },
            { layer: "thread_pool", kind: "errors", name: "thread.reject" },
        ],
        contradicts: [{ layer: "thread_pool", kind: "utilization", name: "thread.idle" }],
        discriminatingTest: "thread dump: are active threads blocked on a pool, a lock, or CPU?",
        baseConfidence: 0.25,
        rootWeight: 0,
    },
    {
        id: "connection_pool_exhaustion",
        cause: "connection pool is exhausted or leaking",
        layer: "connection_pool",
        supports: [
            { layer: "connection_pool", kind: "saturation", name: "pool.pending" },
            { layer: "connection_pool", kind: "utilization", name: "pool.active_max" },
            { layer: "connection_pool", kind: "latency", name: "pool.checkout_wait" },
        ],
        contradicts: [{ layer: "connection_pool", kind: "utilization", name: "pool.idle" }],
        discriminatingTest: "checkout wait vs active vs held-time: pool exhaustion, leak, or slow owner?",
        baseConfidence: 0.25,
        rootWeight: 0,
    },
    {
        id: "connect_latency",
        cause: "new connections are slow to establish",
        layer: "connect",
        supports: [
            { layer: "connect", kind: "latency", name: "connect.p99" },
            { layer: "connect", kind: "errors", name: "connect.error" },
            { layer: "connect", kind: "latency", name: "tls.handshake" },
        ],
        contradicts: [{ layer: "connect", kind: "latency", name: "connect.ok" }],
        discriminatingTest: "split connect into TCP RTT, TLS, auth, DNS; is pool wait high while active is low?",
        baseConfidence: 0.25,
        rootWeight: 0.1,
    },
    {
        id: "db_slow_query",
        cause: "database queries are slow",
        layer: "database",
        supports: [
            { layer: "database", kind: "latency", name: "db.query_p99" },
            { layer: "database", kind: "utilization", name: "db.cpu" },
            { layer: "database", kind: "saturation", name: "db.temp_spill" },
        ],
        contradicts: [{ layer: "database", kind: "latency", name: "db.query_ok" }],
        discriminatingTest: "EXPLAIN ANALYZE: seq scan, temp spill, bad row estimate, or missing index?",
        baseConfidence: 0.25,
        rootWeight: 0.15,
    },
    {
        id: "db_lock",
        cause: "database locks are blocking progress",
        layer: "database",
        supports: [
            { layer: "database", kind: "saturation", name: "db.lock_wait" },
            { layer: "database", kind: "saturation", name: "db.blocking_chain" },
        ],
        contradicts: [{ layer: "database", kind: "saturation", name: "db.no_lock_wait" }],
        discriminatingTest: "pg_locks + pg_blocking_pids: who blocks whom, and for how long?",
        baseConfidence: 0.25,
        rootWeight: 0.15,
    },
    {
        id: "queue_backlog",
        cause: "consumers cannot keep up with the queue",
        layer: "queue",
        supports: [
            { layer: "queue", kind: "saturation", name: "queue.lag" },
            { layer: "queue", kind: "latency", name: "queue.consume_rate" },
            { layer: "queue", kind: "errors", name: "queue.retry" },
        ],
        contradicts: [{ layer: "queue", kind: "saturation", name: "queue.drained" }],
        discriminatingTest: "lag with idle consumers (blocked) vs busy consumers (capacity)?",
        baseConfidence: 0.2,
        rootWeight: 0.1,
    },
    {
        id: "code_regression",
        cause: "application code or GC is the bottleneck",
        layer: "application",
        supports: [
            { layer: "application", kind: "utilization", name: "app.cpu" },
            { layer: "application", kind: "saturation", name: "app.gc_pause" },
            { layer: "release", kind: "errors", name: "release.only_new_version" },
        ],
        contradicts: [{ layer: "database", kind: "latency", name: "db.query_p99" }],
        discriminatingTest: "DB fast + app CPU/GC high + blocked stack in app code?",
        baseConfidence: 0.2,
        rootWeight: 0.1,
    },
];

const patternMatches = (pattern: SignalPattern, signal: DiagnosticSignal): boolean => {
    if (pattern.layer !== signal.layer) {
        return false;
    }
    if (pattern.kind !== (void 0) && pattern.kind !== signal.kind) {
        return false;
    }
    if (pattern.name !== (void 0) && signal.name !== pattern.name && !signal.name.startsWith(`${pattern.name}.`)) {
        return false;
    }
    return true;
};

const label = (pattern: SignalPattern): string => [pattern.layer, pattern.kind, pattern.name].filter((part) => part !== (void 0)).join(".");

export const assessHypotheses = (frame: DiagnosticFrame): HypothesisAssessment[] => {
    return frame.hypotheses
        .map((hypothesis) => {
            const matched = hypothesis.supports.filter((pattern) => frame.incident.signals?.some((signal) => patternMatches(pattern, signal))).map(label);
            const contradicted = (hypothesis.contradicts ?? [])
                .filter((pattern) => frame.incident.signals?.some((signal) => patternMatches(pattern, signal)))
                .map(label);
            const missing = hypothesis.supports.filter((pattern) => !matched.includes(label(pattern))).map(label);
            const score = matched.length - contradicted.length * 2;
            return {
                hypothesis,
                score,
                confidence: clamp01(hypothesis.baseConfidence + matched.length * 0.12 + (hypothesis.rootWeight ?? 0) - contradicted.length * 0.2),
                matched,
                missing,
                contradicted,
            };
        })
        .sort((left, right) => right.confidence - left.confidence || right.score - left.score);
};

export const selectHypothesis = (frame: DiagnosticFrame): HypothesisAssessment | undefined => assessHypotheses(frame)[0];

export const buildDiagnosisFrame = (incident: IncidentInput): DiagnosticFrame => {
    const layers = incident.layers ?? LayerOrder;
    return {
        id: `diag.${incident.id}`,
        incident,
        layers: [...layers],
        hypotheses: DefaultHypotheses.map((hypothesis) => ({ ...hypothesis })),
        steps: stepsFor(layers),
        phase: (incident.signals?.length ?? 0) > 0 ? "observing" : "framing",
    };
};

/**
 * Add an observation without mutating the original frame.
 */
export const observe = (frame: DiagnosticFrame, signal: DiagnosticSignal): DiagnosticFrame => ({
    ...frame,
    incident: { ...frame.incident, signals: [...(frame.incident.signals ?? []), signal] },
    phase: frame.phase === "framing" ? "observing" : frame.phase,
});

export const nextStep = (frame: DiagnosticFrame): DiagnosticStep | undefined => frame.steps[0];

/**
 * Route to the step that best matches the current evidence. The static layer
 * order is only a fallback: a strong DB hypothesis must not be routed to
 * `thread_pool` just because it is first in the checklist.
 */
export const routeStep = (frame: DiagnosticFrame, minConfidence = 0.5): DiagnosticStep | undefined => {
    const top = selectHypothesis(frame);
    if (top !== (void 0) && top.confidence >= minConfidence) {
        const matched = frame.steps.find((step) => step.layer === top.hypothesis.layer);
        if (matched !== (void 0)) {
            return matched;
        }
    }
    return nextStep(frame);
};

export const validateDiagnosisFrame = (frame: DiagnosticFrame): string[] => {
    const problems: string[] = [];
    if (frame.layers.length === 0) {
        problems.push("diagnosis requires at least one layer");
    }
    if (frame.hypotheses.length === 0) {
        problems.push("diagnosis requires at least one hypothesis");
    }
    for (const hypothesis of frame.hypotheses) {
        if (hypothesis.discriminatingTest.trim().length === 0) {
            problems.push(`hypothesis ${hypothesis.id} lacks a discriminating test`);
        }
    }
    if (frame.steps.some((step) => step.readOnly !== true)) {
        problems.push("diagnostic steps must be read-only");
    }
    if (new Set(frame.steps.map((step) => step.id)).size !== frame.steps.length) {
        problems.push("duplicate diagnostic step ids");
    }
    return problems;
};

/**
 * Render the next diagnostic step as a bounded, read-only ActionPlan.
 */
export const toActionPlan = (frame: DiagnosticFrame): ActionPlan | undefined => {
    const step = routeStep(frame);
    if (step === (void 0)) {
        return undefined;
    }
    return {
        goal: `discriminate the incident cause at ${step.layer}`,
        intent: `diagnose:${step.layer}`,
        expectedEffect: `evidence for or against ${step.layer} hypotheses`,
        preconditions: ["diagnostic step is read-only", "no production mutation before discrimination"],
        successCriteria: step.successCriteria,
        risk: "read",
    };
};

/**
 * Render diagnostic steps as existing PlanTasks (all irreversibility 0).
 */
export const toPlanTasks = (frame: DiagnosticFrame): PlanTask[] =>
    frame.steps.map((step, index) => ({
        id: step.id,
        intent: step.intent,
        actor: "tool",
        pre: index === 0 ? [] : [frame.steps[index - 1].id],
        expect: { observation: step.probe, check: step.successCriteria.join("; ") },
        irreversibility: 0,
        status: "pending",
    }));

/**
 * Select the layer that best explains the current evidence, with an explicit reason.
 */
export const selectLayer = (frame: DiagnosticFrame): { layer: DiagnosticLayer | null; reason: string } => {
    const top = selectHypothesis(frame);
    if (top === (void 0)) {
        return { layer: null, reason: "no hypotheses" };
    }
    return { layer: top.hypothesis.layer, reason: `${top.hypothesis.id} confidence=${top.confidence.toFixed(2)} matched=${top.matched.join(",") || "none"}` };
};
