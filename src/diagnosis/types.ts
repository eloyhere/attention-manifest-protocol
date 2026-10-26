/**
 * Diagnostic frame: a bounded, read-only investigation of a failing system.
 *
 * This is deliberately independent of the runtime. It can be rendered into a
 * Plan, an Action, or a prompt; it does not execute anything.
 */
export type DiagnosticLayer = "thread_pool" | "connection_pool" | "connect" | "database" | "queue" | "application" | "release";

export type SignalKind = "utilization" | "saturation" | "errors" | "latency";

export type ObservationState = "ok" | "warn" | "critical";

export interface DiagnosticSignal {
    layer: DiagnosticLayer;
    kind: SignalKind;
    name: string;
    state: ObservationState;
    value?: number;
    note?: string;
}

export interface SignalPattern {
    layer: DiagnosticLayer;
    kind?: SignalKind;
    name?: string;
}

export interface Hypothesis {
    id: string;
    cause: string;
    layer: DiagnosticLayer;
    supports: SignalPattern[];
    contradicts?: SignalPattern[];
    /** A check that separates this cause from its neighbors. */
    discriminatingTest: string;
    baseConfidence: number;
    /** Root-cause evidence weighs more than a downstream saturation symptom. */
    rootWeight?: number;
}

export interface HypothesisAssessment {
    hypothesis: Hypothesis;
    score: number;
    confidence: number;
    matched: string[];
    missing: string[];
    contradicted: string[];
}

export interface DiagnosticStep {
    id: string;
    layer: DiagnosticLayer;
    intent: string;
    probe: string;
    readOnly: true;
    successCriteria: string[];
    stopIf?: string;
}

export interface IncidentInput {
    id: string;
    summary: string;
    symptoms: string[];
    signals?: DiagnosticSignal[];
    recentChanges?: string[];
    constraints?: string[];
    /** Optional narrowing; defaults to all layers. */
    layers?: DiagnosticLayer[];
}

export interface DiagnosticFrame {
    id: string;
    incident: IncidentInput;
    layers: DiagnosticLayer[];
    hypotheses: Hypothesis[];
    steps: DiagnosticStep[];
    phase: "framing" | "observing" | "discriminating" | "deciding" | "verifying";
    selected?: string;
}

export const LAYER_ORDER: readonly DiagnosticLayer[] = ["thread_pool", "connection_pool", "connect", "database", "queue", "application", "release"];

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
