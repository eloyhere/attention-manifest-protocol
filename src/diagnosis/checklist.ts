import type { DiagnosticLayer, DiagnosticStep, SignalKind } from "./types.ts";

export interface LayerCheck {
    layer: DiagnosticLayer;
    question: string;
    signals: SignalKind[];
    probe: string;
}

/**
 * USE-style checklist. Utilization, saturation and errors are asked per layer;
 * latency is decomposed because "slow" is not a layer.
 */
export const LAYER_CHECKS: Record<DiagnosticLayer, LayerCheck> = {
    thread_pool: {
        layer: "thread_pool",
        question: "Are worker threads exhausted, blocked, or idle?",
        signals: ["utilization", "saturation", "errors"],
        probe: "active/max threads, run queue, reject count; one thread dump with top blocking frames",
    },
    connection_pool: {
        layer: "connection_pool",
        question: "Is the pool exhausted, leaking, or waiting on slow work?",
        signals: ["utilization", "saturation", "latency"],
        probe: "active/idle/pending, checkout wait P99, timeout count, held-time distribution",
    },
    connect: {
        layer: "connect",
        question: "Is a new connection slow to establish?",
        signals: ["latency", "errors"],
        probe: "TCP RTT, TLS handshake, auth, DNS, connect P99, new-connection/churn rate",
    },
    database: {
        layer: "database",
        question: "Is the database slow, locked, or out of connections?",
        signals: ["utilization", "saturation", "latency", "errors"],
        probe: "pg_stat_statements top SQL, EXPLAIN ANALYZE, pg_locks blocking chain, wait events, sessions/max_connections",
    },
    queue: {
        layer: "queue",
        question: "Is work arriving faster than it is consumed?",
        signals: ["saturation", "latency", "errors"],
        probe: "consumer lag, consume rate, retry/DLQ, partition skew, active consumers",
    },
    application: {
        layer: "application",
        question: "Is application code or GC burning CPU / holding locks?",
        signals: ["utilization", "saturation", "errors"],
        probe: "CPU, GC pauses, thread dump, lock contention, dependency spans",
    },
    release: {
        layer: "release",
        question: "Is the failure correlated with a specific version?",
        signals: ["errors", "latency"],
        probe: "per-version error/latency split, diff, canary cohort, deploy timeline",
    },
};

export const stepFor = (layer: DiagnosticLayer): DiagnosticStep => {
    const check = LAYER_CHECKS[layer];
    return {
        id: `probe.${layer}`,
        layer,
        intent: `inspect ${layer}`,
        probe: check.probe,
        readOnly: true,
        successCriteria: [`${layer} utilization/saturation/error signals are known`, "the next hypothesis is discriminated or explicitly left open"],
        stopIf: "a higher layer fully explains the symptoms and the lower layer is healthy",
    };
};

export const stepsFor = (layers: readonly DiagnosticLayer[]): DiagnosticStep[] => layers.map((layer) => stepFor(layer));
