import type { Identifier } from "../shared.ts";
import type { BehaviorCandidate, Clock, ProvenanceRecord } from "../behavior/types.ts";

/**
 * Sediment granularities from `refract.md` §11.14. A failed Plan/Task/Action is
 * still represented by the same granularity with `success: false`, so failure
 * repair patterns can be abstracted alongside successful patterns.
 */
export const SEDIMENT_GRANULARITIES = [
    "session",
    "turn",
    "intent",
    "mission",
    "plan",
    "task",
    "action",
    "cooperation",
] as const;

export type SedimentGranularity = (typeof SEDIMENT_GRANULARITIES)[number];

/**
 * One verified trajectory offered to the sediment pipeline. `verified` is the
 * gate: an unverified trace is rejected instead of being silently dropped.
 */
export interface SedimentTrace {
    readonly traceId: Identifier;
    readonly granularity: SedimentGranularity;
    readonly success: boolean;
    readonly verified: boolean;
    readonly steps: readonly string[];
    /** Defaults to `traceId` during capture. */
    readonly independenceKey?: Identifier;
    readonly sessionId?: Identifier;
    readonly turnId?: Identifier;
    readonly taskId?: Identifier;
    readonly goalId?: Identifier;
    readonly planId?: Identifier;
    readonly actionIds?: readonly Identifier[];
    readonly evidenceIds?: readonly Identifier[];
    readonly observedAt?: string;
    readonly cost?: number;
    /** Optional recorded shadow metrics. The default validator never invents them. */
    readonly shadowScore?: number;
    readonly baselineScore?: number;
}

export type CapturedTrace = Omit<SedimentTrace, "independenceKey"> & { readonly independenceKey: Identifier };

export interface CaptureResult {
    readonly traces: readonly CapturedTrace[];
    readonly acceptedCount: number;
    readonly successCount: number;
    readonly failureCount: number;
}

export type RemovedTraceReason = "duplicate_independence" | "filtered";

export interface RemovedTrace {
    readonly traceId: Identifier;
    readonly reason: RemovedTraceReason;
}

export interface DenoiseOutput {
    readonly traces: readonly CapturedTrace[];
    readonly removed?: readonly RemovedTrace[];
}

export interface DenoiseResult {
    readonly traces: readonly CapturedTrace[];
    readonly removed: readonly RemovedTrace[];
    readonly inputCount: number;
    readonly outputCount: number;
}

/** Formalized behavior draft produced by the injectable abstractor (§7.5). */
export interface BehaviorDraft {
    readonly behaviorId: Identifier;
    readonly version: string;
    /** Trigger / applicability summary (the Venn condition in plain text). */
    readonly trigger: string;
    readonly steps: readonly string[];
    readonly successCriteria: readonly string[];
    readonly applicableTaskTypes?: readonly string[];
    readonly dependsOnBehaviorIds?: readonly Identifier[];
    /** When omitted, every denoised trace is recorded as a source. */
    readonly sourceTraceIds?: readonly Identifier[];
}

export type AcceptedBehaviorDraft = Omit<BehaviorDraft, "applicableTaskTypes" | "dependsOnBehaviorIds" | "sourceTraceIds"> & {
    readonly applicableTaskTypes: readonly string[];
    readonly dependsOnBehaviorIds: readonly Identifier[];
    readonly sourceTraceIds: readonly Identifier[];
};

/** Recorded shadow observation. This is not a publication decision. */
export interface ShadowObservation {
    readonly shadowId: Identifier;
    readonly sampleId: Identifier;
    readonly independenceKey: Identifier;
    readonly validator: Identifier;
    readonly candidateScore: number;
    readonly baselineScore: number;
    readonly passed: boolean;
    readonly observedAt: string;
    readonly notes?: string;
    readonly provenance?: readonly ProvenanceRecord[];
}

export interface AbstractionResult {
    readonly draft: AcceptedBehaviorDraft;
    readonly inputCount: number;
}

export interface ShadowValidationResult {
    readonly records: readonly ShadowObservation[];
    readonly passedCount: number;
    readonly failedCount: number;
    readonly independentSamples: number;
}

/**
 * `BehaviorCandidate`-shaped proposal enriched with the draft and the complete
 * shadow record. The proposal is always in `candidate` state and is never
 * published by this pipeline.
 */
export type SedimentCandidate = BehaviorCandidate & {
    readonly draft: AcceptedBehaviorDraft;
    readonly shadowRecords: readonly ShadowObservation[];
    readonly sourceTraceIds: readonly Identifier[];
};

export type SedimentStage = "idle" | "captured" | "denoised" | "abstracted" | "shadow_validated" | "proposed";

export type SedimentAuditStage = "capture" | "denoise" | "abstract" | "shadowValidate" | "propose";

export type AuditScalar = string | number | boolean;

export type AuditSummaryValue = AuditScalar | readonly AuditScalar[];

export type SedimentAuditSummary = Readonly<Record<string, AuditSummaryValue>>;

export interface SedimentAuditSide {
    readonly digest: string;
    readonly summary: SedimentAuditSummary;
}

export interface SedimentAuditEntry {
    readonly sequence: number;
    readonly stage: SedimentAuditStage;
    readonly status: "completed" | "failed";
    readonly at: string;
    readonly input: SedimentAuditSide;
    readonly output?: SedimentAuditSide;
    readonly error?: string;
}

export interface CapturePort {
    capture(traces: readonly SedimentTrace[]): readonly SedimentTrace[] | Promise<readonly SedimentTrace[]>;
}

export interface DenoisePort {
    denoise(traces: readonly CapturedTrace[]): DenoiseOutput | Promise<DenoiseOutput>;
}

export interface AbstractionInput {
    readonly traces: readonly CapturedTrace[];
    readonly requestedAt: string;
}

export interface AbstractorPort {
    abstract(input: AbstractionInput): BehaviorDraft | Promise<BehaviorDraft>;
}

export interface ShadowValidationInput {
    readonly draft: AcceptedBehaviorDraft;
    readonly traces: readonly CapturedTrace[];
    readonly evaluatedAt: string;
}

export interface ShadowValidatorPort {
    validate(input: ShadowValidationInput): readonly ShadowObservation[] | Promise<readonly ShadowObservation[]>;
}

export interface ProposalInput {
    readonly draft: AcceptedBehaviorDraft;
    readonly traces: readonly CapturedTrace[];
    readonly shadowRecords: readonly ShadowObservation[];
    readonly candidateId: Identifier;
    readonly proposedAt: string;
}

export interface ProposerPort {
    propose(input: ProposalInput): BehaviorCandidate | Promise<BehaviorCandidate>;
}

export interface SedimentPipelineOptions {
    /** Required: abstraction is always delegated (for example to a model). */
    readonly abstractor: AbstractorPort;
    readonly capture?: CapturePort;
    readonly denoise?: DenoisePort;
    readonly shadowValidator?: ShadowValidatorPort;
    readonly proposer?: ProposerPort;
    readonly clock?: Clock;
}

export interface SedimentRunResult {
    readonly capture: CaptureResult;
    readonly denoise: DenoiseResult;
    readonly abstraction: AbstractionResult;
    readonly shadow: ShadowValidationResult;
    readonly candidate: SedimentCandidate;
    readonly audit: readonly SedimentAuditEntry[];
}
