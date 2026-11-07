import type { Identifier } from "../shared.ts";
import type { BehaviorCandidate, ProvenanceRecord, ValidationTrace } from "../behavior/types.ts";
import { SEDIMENT_GRANULARITIES } from "./types.ts";
import type {
    AcceptedBehaviorDraft,
    CapturedTrace,
    DenoiseResult,
    RemovedTrace,
    ShadowObservation,
} from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export type SedimentErrorCode =
    | "invalid_options"
    | "empty_traces"
    | "invalid_trace"
    | "duplicate_trace"
    | "unverified_trace"
    | "stage_out_of_order"
    | "stage_in_progress"
    | "capture_failed"
    | "denoise_failed"
    | "empty_denoised"
    | "invalid_denoise"
    | "abstraction_failed"
    | "invalid_abstractor_output"
    | "shadow_validation_failed"
    | "invalid_shadow_output"
    | "shadow_metrics_missing"
    | "proposal_failed"
    | "invalid_candidate"
    | "no_shadow_passes";

export class SedimentError extends Error {
    readonly code: SedimentErrorCode;

    constructor(code: SedimentErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SedimentError";
        this.code = code;
    }
}

const fail = (code: SedimentErrorCode, message: string): never => {
    throw new SedimentError(code, message);
};

export function readIdentifier(value: unknown, field: string, code: SedimentErrorCode): Identifier {
    if (typeof value !== "string" || value.trim().length === 0) return fail(code, `${field} must be a nonempty identifier`);
    return value;
}

function readOptionalIdentifier(value: unknown, field: string, code: SedimentErrorCode): Identifier | undefined {
    return value === undefined ? undefined : readIdentifier(value, field, code);
}

function readOptionalText(value: unknown, field: string, code: SedimentErrorCode): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) return fail(code, `${field} must be a nonempty string`);
    return value;
}

function readStringArray(value: unknown, field: string, code: SedimentErrorCode, minimum: number): readonly string[] {
    if (!Array.isArray(value)) return fail(code, `${field} must be an array`);
    if (value.length < minimum) return fail(code, `${field} must contain at least ${minimum} item(s)`);
    const seen = new Set<string>();
    const items: string[] = [];
    for (const item of value) {
        if (typeof item !== "string" || item.trim().length === 0) return fail(code, `${field} must contain nonempty strings`);
        if (seen.has(item)) return fail(code, `${field} contains a duplicate item: ${item}`);
        seen.add(item);
        items.push(item);
    }
    return Object.freeze(items);
}

function readIdentifierArray(value: unknown, field: string, code: SedimentErrorCode, minimum: number): readonly Identifier[] {
    if (!Array.isArray(value)) return fail(code, `${field} must be an array`);
    if (value.length < minimum) return fail(code, `${field} must contain at least ${minimum} item(s)`);
    const seen = new Set<Identifier>();
    const items: Identifier[] = [];
    for (const item of value) {
        const id = readIdentifier(item, `${field} item`, code);
        if (seen.has(id)) return fail(code, `${field} contains duplicate identifier: ${id}`);
        seen.add(id);
        items.push(id);
    }
    return Object.freeze(items);
}

function readUnit(value: unknown, field: string, code: SedimentErrorCode): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        return fail(code, `${field} must be a finite number between 0 and 1`);
    }
    return value;
}

function readProvenance(value: unknown, field: string, code: SedimentErrorCode): readonly ProvenanceRecord[] {
    if (!Array.isArray(value)) return fail(code, `${field} must be an array`);
    const records: ProvenanceRecord[] = [];
    for (const item of value) {
        if (!isRecord(item)) return fail(code, `${field} must contain provenance objects`);
        const sourceType = item.sourceType;
        if (sourceType !== "agent" && sourceType !== "tool" && sourceType !== "user" && sourceType !== "external" && sourceType !== "derived") {
            return fail(code, `${field} has an invalid sourceType`);
        }
        const taint = item.taint;
        if (!Array.isArray(taint) || taint.some(entry => typeof entry !== "string")) {
            return fail(code, `${field} taint must be an array of strings`);
        }
        const authorityScope = item.authorityScope === undefined
            ? undefined
            : readStringArray(item.authorityScope, `${field} authorityScope`, code, 1);
        records.push(Object.freeze({
            sourceId: readIdentifier(item.sourceId, `${field} sourceId`, code),
            sourceType,
            ...(authorityScope === undefined ? {} : { authorityScope }),
            chain: readIdentifierArray(item.chain, `${field} chain`, code, 1),
            taint: Object.freeze([...taint]),
        }));
    }
    return Object.freeze(records);
}

function readTrace(value: unknown, index: number): CapturedTrace {
    if (!isRecord(value)) return fail("invalid_trace", `Trace at index ${index} must be an object`);
    const traceId = readIdentifier(value.traceId, `Trace at index ${index} traceId`, "invalid_trace");
    if (!(SEDIMENT_GRANULARITIES as readonly string[]).includes(value.granularity as string)) {
        return fail("invalid_trace", `Trace ${traceId} granularity must be one of ${SEDIMENT_GRANULARITIES.join(", ")}`);
    }
    if (typeof value.success !== "boolean") return fail("invalid_trace", `Trace ${traceId} success must be a boolean`);
    if (typeof value.verified !== "boolean") return fail("invalid_trace", `Trace ${traceId} verified must be a boolean`);
    if (!value.verified) return fail("unverified_trace", `Trace ${traceId} is not verified and cannot be sedimented`);
    const steps = readStringArray(value.steps, `Trace ${traceId} steps`, "invalid_trace", 1);
    const independenceKey = value.independenceKey === undefined
        ? traceId
        : readIdentifier(value.independenceKey, `Trace ${traceId} independenceKey`, "invalid_trace");
    const actionIds = value.actionIds === undefined
        ? undefined
        : readIdentifierArray(value.actionIds, `Trace ${traceId} actionIds`, "invalid_trace", 0);
    const evidenceIds = value.evidenceIds === undefined
        ? undefined
        : readIdentifierArray(value.evidenceIds, `Trace ${traceId} evidenceIds`, "invalid_trace", 0);
    const observedAt = readOptionalText(value.observedAt, `Trace ${traceId} observedAt`, "invalid_trace");
    const sessionId = readOptionalIdentifier(value.sessionId, `Trace ${traceId} sessionId`, "invalid_trace");
    const turnId = readOptionalIdentifier(value.turnId, `Trace ${traceId} turnId`, "invalid_trace");
    const taskId = readOptionalIdentifier(value.taskId, `Trace ${traceId} taskId`, "invalid_trace");
    const goalId = readOptionalIdentifier(value.goalId, `Trace ${traceId} goalId`, "invalid_trace");
    const planId = readOptionalIdentifier(value.planId, `Trace ${traceId} planId`, "invalid_trace");
    if (value.cost !== undefined && (typeof value.cost !== "number" || !Number.isFinite(value.cost) || value.cost < 0)) {
        return fail("invalid_trace", `Trace ${traceId} cost must be a finite nonnegative number`);
    }
    for (const field of ["shadowScore", "baselineScore"] as const) {
        if (value[field] !== undefined) readUnit(value[field], `Trace ${traceId} ${field}`, "invalid_trace");
    }
    return Object.freeze({
        traceId,
        granularity: value.granularity as CapturedTrace["granularity"],
        success: value.success,
        verified: true,
        steps,
        independenceKey,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(turnId === undefined ? {} : { turnId }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(goalId === undefined ? {} : { goalId }),
        ...(planId === undefined ? {} : { planId }),
        ...(actionIds === undefined ? {} : { actionIds }),
        ...(evidenceIds === undefined ? {} : { evidenceIds }),
        ...(observedAt === undefined ? {} : { observedAt }),
        ...(value.cost === undefined ? {} : { cost: value.cost as number }),
        ...(value.shadowScore === undefined ? {} : { shadowScore: value.shadowScore as number }),
        ...(value.baselineScore === undefined ? {} : { baselineScore: value.baselineScore as number }),
    });
}

/** Validates and freezes a batch of traces; duplicate ids are rejected. */
export function normalizeCapturedTraces(value: unknown): readonly CapturedTrace[] {
    if (!Array.isArray(value)) return fail("invalid_trace", "Sediment traces must be an array");
    const seen = new Set<Identifier>();
    const traces: CapturedTrace[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const trace = readTrace(value[index], index);
        if (seen.has(trace.traceId)) return fail("duplicate_trace", `Duplicate sediment trace: ${trace.traceId}`);
        seen.add(trace.traceId);
        traces.push(trace);
    }
    return Object.freeze(traces);
}

function readRemovedTrace(value: unknown, index: number): RemovedTrace {
    if (!isRecord(value)) return fail("invalid_denoise", `Removed trace at index ${index} must be an object`);
    const traceId = readIdentifier(value.traceId, `Removed trace at index ${index} traceId`, "invalid_denoise");
    if (value.reason !== "duplicate_independence" && value.reason !== "filtered") {
        return fail("invalid_denoise", `Removed trace ${traceId} has an invalid reason`);
    }
    return Object.freeze({ traceId, reason: value.reason as RemovedTrace["reason"] });
}

export function normalizeDenoiseOutput(value: unknown, input: readonly CapturedTrace[]): DenoiseResult {
    if (!isRecord(value)) return fail("invalid_denoise", "Denoise port must return an object");
    let traces: readonly CapturedTrace[];
    try {
        traces = normalizeCapturedTraces(value.traces);
    } catch (error) {
        if (error instanceof SedimentError) {
            throw new SedimentError("invalid_denoise", `Invalid denoise output: ${error.message}`, { cause: error });
        }
        throw error;
    }
    const inputById = new Map(input.map(trace => [trace.traceId, trace]));
    const outputIds = new Set<Identifier>();
    const independenceKeys = new Set<Identifier>();
    for (const trace of traces) {
        if (!inputById.has(trace.traceId)) return fail("invalid_denoise", `Denoise output invented trace: ${trace.traceId}`);
        if (outputIds.has(trace.traceId)) return fail("invalid_denoise", `Denoise output contains duplicate trace: ${trace.traceId}`);
        if (independenceKeys.has(trace.independenceKey)) {
            return fail("invalid_denoise", `Denoise output still contains duplicate independence key: ${trace.independenceKey}`);
        }
        outputIds.add(trace.traceId);
        independenceKeys.add(trace.independenceKey);
    }
    const provided = new Map<Identifier, RemovedTrace>();
    if (value.removed !== undefined) {
        if (!Array.isArray(value.removed)) return fail("invalid_denoise", "Denoise removed must be an array");
        for (let index = 0; index < value.removed.length; index += 1) {
            const removed = readRemovedTrace(value.removed[index], index);
            if (provided.has(removed.traceId)) return fail("invalid_denoise", `Duplicate removed trace: ${removed.traceId}`);
            if (!inputById.has(removed.traceId)) return fail("invalid_denoise", `Removed trace is not an input: ${removed.traceId}`);
            if (outputIds.has(removed.traceId)) return fail("invalid_denoise", `Trace is both kept and removed: ${removed.traceId}`);
            provided.set(removed.traceId, removed);
        }
    }
    const removed: RemovedTrace[] = [];
    for (const trace of input) {
        if (outputIds.has(trace.traceId)) continue;
        const supplied = provided.get(trace.traceId);
        if (supplied !== undefined) removed.push(supplied);
        else removed.push(Object.freeze({
            traceId: trace.traceId,
            reason: independenceKeys.has(trace.independenceKey) ? "duplicate_independence" as const : "filtered" as const,
        }));
    }
    removed.sort((left, right) => left.traceId < right.traceId ? -1 : left.traceId > right.traceId ? 1 : 0);
    const ordered = [...traces].sort((left, right) => left.traceId < right.traceId ? -1 : left.traceId > right.traceId ? 1 : 0);
    return Object.freeze({
        traces: Object.freeze(ordered),
        removed: Object.freeze(removed),
        inputCount: input.length,
        outputCount: traces.length,
    });
}

export function normalizeDraft(value: unknown, sourceTraceIds: readonly Identifier[]): AcceptedBehaviorDraft {
    if (!isRecord(value)) return fail("invalid_abstractor_output", "Abstractor must return a behavior draft object");
    const behaviorId = readIdentifier(value.behaviorId, "Draft behaviorId", "invalid_abstractor_output");
    const version = readIdentifier(value.version, "Draft version", "invalid_abstractor_output");
    const trigger = readIdentifier(value.trigger, "Draft trigger", "invalid_abstractor_output");
    const steps = readStringArray(value.steps, "Draft steps", "invalid_abstractor_output", 1);
    const successCriteria = readStringArray(value.successCriteria, "Draft successCriteria", "invalid_abstractor_output", 1);
    const applicableTaskTypes = value.applicableTaskTypes === undefined
        ? Object.freeze([] as string[])
        : readStringArray(value.applicableTaskTypes, "Draft applicableTaskTypes", "invalid_abstractor_output", 1);
    const dependsOnBehaviorIds = value.dependsOnBehaviorIds === undefined
        ? Object.freeze([] as Identifier[])
        : readIdentifierArray(value.dependsOnBehaviorIds, "Draft dependsOnBehaviorIds", "invalid_abstractor_output", 0);
    if (dependsOnBehaviorIds.includes(behaviorId)) return fail("invalid_abstractor_output", "Draft behavior cannot depend on itself");
    const availableTraceIds = new Set(sourceTraceIds);
    let draftSourceTraceIds: readonly Identifier[];
    if (value.sourceTraceIds === undefined) {
        draftSourceTraceIds = Object.freeze([...sourceTraceIds].sort());
    } else {
        draftSourceTraceIds = readIdentifierArray(value.sourceTraceIds, "Draft sourceTraceIds", "invalid_abstractor_output", 1);
        for (const traceId of draftSourceTraceIds) {
            if (!availableTraceIds.has(traceId)) {
                return fail("invalid_abstractor_output", `Draft source trace was not supplied to the abstractor: ${traceId}`);
            }
        }
    }
    const draft: AcceptedBehaviorDraft = Object.freeze({
        behaviorId,
        version,
        trigger,
        steps,
        successCriteria,
        applicableTaskTypes,
        dependsOnBehaviorIds,
        sourceTraceIds: draftSourceTraceIds,
    });
    return draft;
}

export function normalizeShadowRecords(value: unknown, sampleIds: ReadonlySet<Identifier>): readonly ShadowObservation[] {
    if (!Array.isArray(value)) return fail("invalid_shadow_output", "Shadow validator must return an array of records");
    const records: ShadowObservation[] = [];
    const shadowIds = new Set<Identifier>();
    const sampleSeen = new Set<Identifier>();
    for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (!isRecord(item)) return fail("invalid_shadow_output", `Shadow record at index ${index} must be an object`);
        const shadowId = readIdentifier(item.shadowId, `Shadow record at index ${index} shadowId`, "invalid_shadow_output");
        const sampleId = readIdentifier(item.sampleId, `Shadow record ${shadowId} sampleId`, "invalid_shadow_output");
        const independenceKey = readIdentifier(item.independenceKey, `Shadow record ${shadowId} independenceKey`, "invalid_shadow_output");
        const validator = readIdentifier(item.validator, `Shadow record ${shadowId} validator`, "invalid_shadow_output");
        const observedAt = readIdentifier(item.observedAt, `Shadow record ${shadowId} observedAt`, "invalid_shadow_output");
        if (typeof item.passed !== "boolean") return fail("invalid_shadow_output", `Shadow record ${shadowId} passed must be a boolean`);
        if (shadowIds.has(shadowId)) return fail("invalid_shadow_output", `Duplicate shadow record: ${shadowId}`);
        if (sampleSeen.has(sampleId)) return fail("invalid_shadow_output", `Duplicate shadow sample: ${sampleId}`);
        if (!sampleIds.has(sampleId)) return fail("invalid_shadow_output", `Shadow sample was not captured: ${sampleId}`);
        const provenance = item.provenance === undefined
            ? Object.freeze([] as ProvenanceRecord[])
            : readProvenance(item.provenance, `Shadow record ${shadowId} provenance`, "invalid_shadow_output");
        const notes = item.notes === undefined ? undefined : readOptionalText(item.notes, `Shadow record ${shadowId} notes`, "invalid_shadow_output");
        shadowIds.add(shadowId);
        sampleSeen.add(sampleId);
        records.push(Object.freeze({
            shadowId,
            sampleId,
            independenceKey,
            validator,
            candidateScore: readUnit(item.candidateScore, `Shadow record ${shadowId} candidateScore`, "invalid_shadow_output"),
            baselineScore: readUnit(item.baselineScore, `Shadow record ${shadowId} baselineScore`, "invalid_shadow_output"),
            passed: item.passed,
            observedAt,
            ...(notes === undefined ? {} : { notes }),
            provenance,
        }));
    }
    records.sort((left, right) => left.shadowId < right.shadowId ? -1 : left.shadowId > right.shadowId ? 1 : 0);
    return Object.freeze(records);
}

function readValidationTrace(value: unknown, draft: AcceptedBehaviorDraft, shadowSampleIds: ReadonlySet<Identifier>): ValidationTrace {
    if (!isRecord(value)) return fail("invalid_candidate", "Candidate trace must be an object");
    const traceId = readIdentifier(value.traceId, "Candidate trace traceId", "invalid_candidate");
    const behaviorId = readIdentifier(value.behaviorId, `Candidate trace ${traceId} behaviorId`, "invalid_candidate");
    if (behaviorId !== draft.behaviorId) return fail("invalid_candidate", `Candidate trace ${traceId} belongs to a different behavior`);
    const sampleId = readIdentifier(value.sampleId, `Candidate trace ${traceId} sampleId`, "invalid_candidate");
    if (!shadowSampleIds.has(sampleId)) return fail("invalid_candidate", `Candidate trace ${traceId} does not match a shadow sample`);
    if (value.validated !== true) return fail("invalid_candidate", `Candidate trace ${traceId} is not validated`);
    const provenance = value.provenance === undefined
        ? Object.freeze([] as ProvenanceRecord[])
        : readProvenance(value.provenance, `Candidate trace ${traceId} provenance`, "invalid_candidate");
    return Object.freeze({
        traceId,
        behaviorId,
        sampleId,
        independenceKey: readIdentifier(value.independenceKey, `Candidate trace ${traceId} independenceKey`, "invalid_candidate"),
        validated: true,
        candidateScore: readUnit(value.candidateScore, `Candidate trace ${traceId} candidateScore`, "invalid_candidate"),
        baselineScore: readUnit(value.baselineScore, `Candidate trace ${traceId} baselineScore`, "invalid_candidate"),
        validator: readIdentifier(value.validator, `Candidate trace ${traceId} validator`, "invalid_candidate"),
        observedAt: readIdentifier(value.observedAt, `Candidate trace ${traceId} observedAt`, "invalid_candidate"),
        provenance,
    });
}

export function normalizeCandidate(
    value: unknown,
    draft: AcceptedBehaviorDraft,
    shadowSampleIds: ReadonlySet<Identifier>,
): BehaviorCandidate {
    if (!isRecord(value)) return fail("invalid_candidate", "Proposer must return a behavior candidate object");
    const candidateId = readIdentifier(value.candidateId, "Candidate candidateId", "invalid_candidate");
    const behaviorId = readIdentifier(value.behaviorId, `Candidate ${candidateId} behaviorId`, "invalid_candidate");
    const version = readIdentifier(value.version, `Candidate ${candidateId} version`, "invalid_candidate");
    if (behaviorId !== draft.behaviorId) return fail("invalid_candidate", "Candidate behaviorId does not match the draft");
    if (version !== draft.version) return fail("invalid_candidate", "Candidate version does not match the draft");
    if (value.state !== "candidate") return fail("invalid_candidate", "Proposal must stay in candidate state; publishing is not allowed here");
    if (value.publishedAt !== undefined) return fail("invalid_candidate", "Proposal must not carry a publishedAt timestamp");
    const createdAt = readIdentifier(value.createdAt, `Candidate ${candidateId} createdAt`, "invalid_candidate");
    if (!Array.isArray(value.traces) || value.traces.length === 0) {
        return fail("invalid_candidate", "Candidate traces must be a nonempty array");
    }
    const traceIds = new Set<Identifier>();
    const traces: ValidationTrace[] = [];
    const independenceKeys = new Set<Identifier>();
    for (let index = 0; index < value.traces.length; index += 1) {
        const trace = readValidationTrace(value.traces[index], draft, shadowSampleIds);
        if (traceIds.has(trace.traceId)) return fail("invalid_candidate", `Candidate contains duplicate trace: ${trace.traceId}`);
        traceIds.add(trace.traceId);
        independenceKeys.add(trace.independenceKey);
        traces.push(trace);
    }
    const independentSampleCount = value.independentSampleCount;
    if (typeof independentSampleCount !== "number" || !Number.isSafeInteger(independentSampleCount) || independentSampleCount < 1) {
        return fail("invalid_candidate", "Candidate independentSampleCount must be a positive safe integer");
    }
    if (independentSampleCount !== independenceKeys.size) {
        return fail("invalid_candidate", "Candidate independentSampleCount does not match its independent traces");
    }
    const dependsOnBehaviorIds = readIdentifierArray(value.dependsOnBehaviorIds ?? [], "Candidate dependsOnBehaviorIds", "invalid_candidate", 0);
    if (dependsOnBehaviorIds.includes(behaviorId)) return fail("invalid_candidate", "Candidate behavior cannot depend on itself");
    return Object.freeze({
        candidateId,
        behaviorId,
        version,
        state: "candidate" as const,
        traces: Object.freeze(traces),
        independentSampleCount,
        dependsOnBehaviorIds,
        createdAt,
        ...(value.evaluationId === undefined
            ? {}
            : { evaluationId: readIdentifier(value.evaluationId, `Candidate ${candidateId} evaluationId`, "invalid_candidate") }),
    });
}
