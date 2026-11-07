import type { Identifier } from "../shared.ts";
import type { Clock } from "../behavior/types.ts";
import { digestOf } from "./audit.ts";
import {
    defaultCapturePort,
    defaultDenoisePort,
    defaultProposerPort,
    defaultShadowValidator,
    proposalCandidateId,
} from "./defaults.ts";
import type {
    AbstractorPort,
    AbstractionResult,
    AcceptedBehaviorDraft,
    AuditSummaryValue,
    CapturePort,
    CaptureResult,
    CapturedTrace,
    DenoisePort,
    DenoiseResult,
    ProposalInput,
    ProposerPort,
    SedimentAuditEntry,
    SedimentAuditStage,
    SedimentAuditSummary,
    SedimentCandidate,
    SedimentPipelineOptions,
    SedimentRunResult,
    SedimentStage,
    SedimentTrace,
    ShadowObservation,
    ShadowValidationInput,
    ShadowValidationResult,
    ShadowValidatorPort,
} from "./types.ts";
import {
    normalizeCandidate,
    normalizeCapturedTraces,
    normalizeDenoiseOutput,
    normalizeDraft,
    normalizeShadowRecords,
    SedimentError,
} from "./validation.ts";
import type { SedimentErrorCode } from "./validation.ts";

const clone = <T>(value: T): T => structuredClone(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function asSedimentError(error: unknown, fallback: SedimentErrorCode, context: string): SedimentError {
    if (error instanceof SedimentError) return error;
    return new SedimentError(fallback, `${context}: ${messageOf(error)}`, { cause: error });
}

function freezeSummary(summary: SedimentAuditSummary): SedimentAuditSummary {
    const entries: Record<string, AuditSummaryValue> = {};
    for (const [key, value] of Object.entries(summary)) {
        entries[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
    }
    return Object.freeze(entries);
}

function sortedTraceIds(traces: readonly { readonly traceId: Identifier }[]): readonly Identifier[] {
    return Object.freeze(traces.map(trace => trace.traceId).sort());
}

function traceSummary(traces: readonly { readonly traceId: Identifier }[]): SedimentAuditSummary {
    return Object.freeze({ traceCount: traces.length, traceIds: sortedTraceIds(traces) });
}

function captureSummary(result: CaptureResult): SedimentAuditSummary {
    return Object.freeze({
        acceptedCount: result.acceptedCount,
        successCount: result.successCount,
        failureCount: result.failureCount,
        traceIds: sortedTraceIds(result.traces),
    });
}

function denoiseSummary(result: DenoiseResult): SedimentAuditSummary {
    return Object.freeze({
        inputCount: result.inputCount,
        outputCount: result.outputCount,
        removedCount: result.removed.length,
        traceIds: sortedTraceIds(result.traces),
        removedTraceIds: Object.freeze(result.removed.map(removed => removed.traceId).sort()),
    });
}

function draftSummary(draft: AcceptedBehaviorDraft): SedimentAuditSummary {
    return Object.freeze({
        behaviorId: draft.behaviorId,
        version: draft.version,
        stepCount: draft.steps.length,
        successCriteriaCount: draft.successCriteria.length,
        sourceTraceIds: Object.freeze([...draft.sourceTraceIds].sort()),
    });
}

function shadowSummary(result: ShadowValidationResult): SedimentAuditSummary {
    return Object.freeze({
        recordCount: result.records.length,
        passedCount: result.passedCount,
        failedCount: result.failedCount,
        independentSamples: result.independentSamples,
        shadowIds: Object.freeze(result.records.map(record => record.shadowId).sort()),
    });
}

function candidateSummary(candidate: SedimentCandidate): SedimentAuditSummary {
    return Object.freeze({
        candidateId: candidate.candidateId,
        behaviorId: candidate.behaviorId,
        version: candidate.version,
        state: candidate.state,
        traceCount: candidate.traces.length,
        independentSampleCount: candidate.independentSampleCount,
    });
}

/**
 * L8 sediment pipeline (refract §11.14): capture → denoise → abstract →
 * shadowValidate → propose. Each stage is atomic: a failing port leaves the
 * previous stage and every previous result untouched. The audit log records a
 * failed attempt as well, but never an output for it.
 *
 * A pipeline instance performs one sediment run; construct a new instance for
 * another run.
 */
export class SedimentPipeline {
    private readonly capturePort: CapturePort;
    private readonly denoisePort: DenoisePort;
    private readonly abstractor: AbstractorPort;
    private readonly shadowValidator: ShadowValidatorPort;
    private readonly proposer: ProposerPort;
    private readonly clock: Clock;
    private _stage: SedimentStage = "idle";
    private activeStage: SedimentAuditStage | undefined;
    private captured: readonly CapturedTrace[] = [];
    private denoised: DenoiseResult | undefined;
    private draft: AcceptedBehaviorDraft | undefined;
    private shadows: ShadowValidationResult | undefined;
    private proposed: SedimentCandidate | undefined;
    private readonly auditEntries: SedimentAuditEntry[] = [];
    private auditSequence = 0;

    constructor(options: SedimentPipelineOptions) {
        if (!isRecord(options)) throw new SedimentError("invalid_options", "Sediment pipeline options are required");
        if (!isRecord(options.abstractor) || typeof options.abstractor.abstract !== "function") {
            throw new SedimentError("invalid_options", "Sediment pipeline requires an abstractor port");
        }
        if (options.capture !== undefined && (!isRecord(options.capture) || typeof options.capture.capture !== "function")) {
            throw new SedimentError("invalid_options", "Capture port must expose capture()");
        }
        if (options.denoise !== undefined && (!isRecord(options.denoise) || typeof options.denoise.denoise !== "function")) {
            throw new SedimentError("invalid_options", "Denoise port must expose denoise()");
        }
        if (options.shadowValidator !== undefined && (!isRecord(options.shadowValidator) || typeof options.shadowValidator.validate !== "function")) {
            throw new SedimentError("invalid_options", "Shadow validator port must expose validate()");
        }
        if (options.proposer !== undefined && (!isRecord(options.proposer) || typeof options.proposer.propose !== "function")) {
            throw new SedimentError("invalid_options", "Proposer port must expose propose()");
        }
        if (options.clock !== undefined && typeof options.clock !== "function") {
            throw new SedimentError("invalid_options", "Clock must be a function");
        }
        this.capturePort = options.capture ?? defaultCapturePort;
        this.denoisePort = options.denoise ?? defaultDenoisePort;
        this.abstractor = options.abstractor;
        this.shadowValidator = options.shadowValidator ?? defaultShadowValidator;
        this.proposer = options.proposer ?? defaultProposerPort;
        this.clock = options.clock ?? (() => new Date().toISOString());
    }

    get stage(): SedimentStage {
        return this._stage;
    }

    /** Convenience for running all five stages in order. */
    async run(traces: readonly SedimentTrace[]): Promise<SedimentRunResult> {
        const capture = await this.capture(traces);
        const denoise = await this.denoise();
        const abstraction = await this.abstract();
        const shadow = await this.shadowValidate();
        const candidate = await this.propose();
        return Object.freeze({ capture, denoise, abstraction, shadow, candidate, audit: this.audit() });
    }

    async capture(traces: readonly SedimentTrace[]): Promise<CaptureResult> {
        this.requireStage("capture", "idle");
        this.activeStage = "capture";
        try {
            if (!Array.isArray(traces)) throw new SedimentError("invalid_trace", "Sediment traces must be an array");
            const input = clone(traces);
            const inputSummary = traceSummary(input);
            try {
                const raw = await this.capturePort.capture(input);
                const captured = normalizeCapturedTraces(raw);
                if (captured.length === 0) throw new SedimentError("empty_traces", "At least one verified sediment trace is required");
                const result: CaptureResult = Object.freeze({
                    traces: captured,
                    acceptedCount: captured.length,
                    successCount: captured.filter(trace => trace.success).length,
                    failureCount: captured.filter(trace => !trace.success).length,
                });
                this.captured = result.traces;
                this._stage = "captured";
                this.recordCompleted("capture", input, inputSummary, result, captureSummary(result));
                return clone(result);
            } catch (error) {
                this.recordFailed("capture", input, inputSummary, error);
                throw asSedimentError(error, "capture_failed", "Sediment capture failed");
            }
        } finally {
            this.activeStage = undefined;
        }
    }

    async denoise(): Promise<DenoiseResult> {
        this.requireStage("denoise", "captured");
        this.activeStage = "denoise";
        const input = this.captured;
        const inputSummary = traceSummary(input);
        try {
            try {
                const raw = await this.denoisePort.denoise(clone(input));
                const result = normalizeDenoiseOutput(raw, input);
                if (result.outputCount === 0) throw new SedimentError("empty_denoised", "Denoise removed every trace; nothing can be abstracted");
                this.denoised = result;
                this._stage = "denoised";
                this.recordCompleted("denoise", input, inputSummary, result, denoiseSummary(result));
                return clone(result);
            } catch (error) {
                this.recordFailed("denoise", input, inputSummary, error);
                throw asSedimentError(error, "denoise_failed", "Sediment denoise failed");
            }
        } finally {
            this.activeStage = undefined;
        }
    }

    async abstract(): Promise<AbstractionResult> {
        this.requireStage("abstract", "denoised");
        this.activeStage = "abstract";
        const denoised = this.denoised as DenoiseResult;
        const traces = denoised.traces;
        const inputSummary = traceSummary(traces);
        try {
            try {
                const raw = await this.abstractor.abstract({ traces: clone(traces), requestedAt: this.clock() });
                const draft = normalizeDraft(raw, traces.map(trace => trace.traceId));
                const result: AbstractionResult = Object.freeze({ draft, inputCount: traces.length });
                this.draft = draft;
                this._stage = "abstracted";
                this.recordCompleted("abstract", traces, inputSummary, result, draftSummary(draft));
                return clone(result);
            } catch (error) {
                this.recordFailed("abstract", traces, inputSummary, error);
                throw asSedimentError(error, "abstraction_failed", "Sediment abstraction failed");
            }
        } finally {
            this.activeStage = undefined;
        }
    }

    async shadowValidate(): Promise<ShadowValidationResult> {
        this.requireStage("shadowValidate", "abstracted");
        this.activeStage = "shadowValidate";
        const draft = this.draft as AcceptedBehaviorDraft;
        const traces = (this.denoised as DenoiseResult).traces;
        const inputSummary = Object.freeze({ behaviorId: draft.behaviorId, traceCount: traces.length });
        const input: ShadowValidationInput = {
            draft: clone(draft),
            traces: clone(traces),
            evaluatedAt: this.clock(),
        };
        try {
            try {
                const raw = await this.shadowValidator.validate(clone(input));
                const records = normalizeShadowRecords(raw, new Set(traces.map(trace => trace.traceId)));
                if (records.length === 0) throw new SedimentError("invalid_shadow_output", "Shadow validation must record at least one sample");
                const independentSamples = new Set(records.map(record => record.independenceKey)).size;
                const result: ShadowValidationResult = Object.freeze({
                    records,
                    passedCount: records.filter(record => record.passed).length,
                    failedCount: records.filter(record => !record.passed).length,
                    independentSamples,
                });
                this.shadows = result;
                this._stage = "shadow_validated";
                this.recordCompleted("shadowValidate", input, inputSummary, result, shadowSummary(result));
                return clone(result);
            } catch (error) {
                this.recordFailed("shadowValidate", input, inputSummary, error);
                throw asSedimentError(error, "shadow_validation_failed", "Sediment shadow validation failed");
            }
        } finally {
            this.activeStage = undefined;
        }
    }

    async propose(): Promise<SedimentCandidate> {
        this.requireStage("propose", "shadow_validated");
        this.activeStage = "propose";
        const draft = this.draft as AcceptedBehaviorDraft;
        const traces = (this.denoised as DenoiseResult).traces;
        const shadows = this.shadows as ShadowValidationResult;
        const inputSummary = Object.freeze({ behaviorId: draft.behaviorId, shadowCount: shadows.records.length });
        const proposalInput: ProposalInput = {
            draft: clone(draft),
            traces: clone(traces),
            shadowRecords: clone(shadows.records),
            candidateId: proposalCandidateId(draft, shadows.records),
            proposedAt: this.clock(),
        };
        try {
            try {
                const raw = await this.proposer.propose(clone(proposalInput));
                const passedSamples = new Set(shadows.records.filter(record => record.passed).map(record => record.sampleId));
                const candidate = normalizeCandidate(raw, draft, passedSamples);
                const enriched: SedimentCandidate = Object.freeze({
                    ...candidate,
                    draft,
                    shadowRecords: shadows.records,
                    sourceTraceIds: draft.sourceTraceIds,
                });
                this.proposed = enriched;
                this._stage = "proposed";
                this.recordCompleted("propose", proposalInput, inputSummary, enriched, candidateSummary(enriched));
                return clone(enriched);
            } catch (error) {
                this.recordFailed("propose", proposalInput, inputSummary, error);
                throw asSedimentError(error, "proposal_failed", "Sediment proposal failed");
            }
        } finally {
            this.activeStage = undefined;
        }
    }

    /** Immutable audit trail; failed attempts carry no output side. */
    audit(): readonly SedimentAuditEntry[] {
        return Object.freeze(this.auditEntries.map(entry => clone(entry)));
    }

    auditDigest(): string {
        return digestOf(this.auditEntries);
    }

    currentDraft(): AcceptedBehaviorDraft | undefined {
        return this.draft === undefined ? undefined : clone(this.draft);
    }

    shadowRecords(): readonly ShadowObservation[] {
        return this.shadows === undefined ? Object.freeze([]) : clone(this.shadows.records);
    }

    proposal(): SedimentCandidate | undefined {
        return this.proposed === undefined ? undefined : clone(this.proposed);
    }

    private requireStage(stage: SedimentAuditStage, expected: SedimentStage): void {
        if (this.activeStage !== undefined) {
            throw new SedimentError("stage_in_progress", `Cannot ${stage} while ${this.activeStage} is still running`);
        }
        if (this._stage !== expected) {
            throw new SedimentError("stage_out_of_order", `${stage} requires stage ${expected}; pipeline is ${this._stage}`);
        }
    }

    private recordCompleted(
        stage: SedimentAuditStage,
        input: unknown,
        inputSummary: SedimentAuditSummary,
        output: unknown,
        outputSummary: SedimentAuditSummary,
    ): void {
        this.auditSequence += 1;
        this.auditEntries.push(Object.freeze({
            sequence: this.auditSequence,
            stage,
            status: "completed" as const,
            at: this.clock(),
            input: Object.freeze({ digest: digestOf(input), summary: freezeSummary(inputSummary) }),
            output: Object.freeze({ digest: digestOf(output), summary: freezeSummary(outputSummary) }),
        }));
    }

    private recordFailed(stage: SedimentAuditStage, input: unknown, inputSummary: SedimentAuditSummary, error: unknown): void {
        this.auditSequence += 1;
        this.auditEntries.push(Object.freeze({
            sequence: this.auditSequence,
            stage,
            status: "failed" as const,
            at: this.clock(),
            input: Object.freeze({ digest: digestOf(input), summary: freezeSummary(inputSummary) }),
            error: messageOf(error),
        }));
    }
}
