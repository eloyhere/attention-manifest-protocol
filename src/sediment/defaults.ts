import type { BehaviorCandidate, ProvenanceRecord, ValidationTrace } from "../behavior/types.ts";
import { digestOf } from "./audit.ts";
import type {
    AcceptedBehaviorDraft,
    CapturePort,
    CapturedTrace,
    DenoisePort,
    DenoiseResult,
    ProposerPort,
    ShadowObservation,
    ShadowValidationInput,
    ShadowValidatorPort,
} from "./types.ts";
import { SedimentError } from "./validation.ts";

const freeze = <T>(value: T): T => Object.freeze(value);

/** Capture is already validated by the pipeline; the default port is identity. */
export const defaultCapturePort: CapturePort = Object.freeze({
    capture: (traces: Parameters<CapturePort["capture"]>[0]) => traces,
});

function compareObservedDescending(left: CapturedTrace, right: CapturedTrace): number {
    const leftObserved = left.observedAt ?? "";
    const rightObserved = right.observedAt ?? "";
    if (leftObserved !== rightObserved) return leftObserved < rightObserved ? 1 : -1;
    return left.traceId < right.traceId ? -1 : left.traceId > right.traceId ? 1 : 0;
}

function compareIds(left: { readonly traceId: string }, right: { readonly traceId: string }): number {
    return left.traceId < right.traceId ? -1 : left.traceId > right.traceId ? 1 : 0;
}

/** Default denoise: keep the most recent trace per independence key. */
export function denoiseByIndependence(traces: readonly CapturedTrace[]): DenoiseResult {
    const winners = new Map<string, CapturedTrace>();
    for (const trace of [...traces].sort(compareObservedDescending)) {
        if (!winners.has(trace.independenceKey)) winners.set(trace.independenceKey, trace);
    }
    const kept = [...winners.values()].sort(compareIds);
    const keptIds = new Set(kept.map(trace => trace.traceId));
    const removed = traces
        .filter(trace => !keptIds.has(trace.traceId))
        .map(trace => freeze({
            traceId: trace.traceId,
            reason: "duplicate_independence" as const,
        }))
        .sort(compareIds);
    return freeze({
        traces: freeze([...kept]),
        removed: freeze(removed),
        inputCount: traces.length,
        outputCount: kept.length,
    });
}

export const defaultDenoisePort: DenoisePort = Object.freeze({
    denoise: (traces: Parameters<DenoisePort["denoise"]>[0]) => denoiseByIndependence(traces),
});

function provenanceFor(trace: CapturedTrace): readonly ProvenanceRecord[] {
    return freeze((trace.evidenceIds ?? []).map(evidenceId => freeze({
        sourceId: evidenceId,
        sourceType: "derived" as const,
        chain: freeze([trace.traceId, evidenceId]),
        taint: freeze([] as string[]),
    })));
}

/**
 * Default shadow validator. It only records metrics that are already present on
 * the captured traces; when they are absent it fails instead of inventing a
 * shadow result. Nothing is published.
 */
export function validateShadowMetrics(input: ShadowValidationInput): readonly ShadowObservation[] {
    const records: ShadowObservation[] = [];
    for (const trace of input.traces) {
        if (trace.shadowScore === undefined || trace.baselineScore === undefined) {
            throw new SedimentError(
                "shadow_metrics_missing",
                `Trace ${trace.traceId} has no recorded shadowScore/baselineScore; supply a shadow validator`,
            );
        }
        records.push(freeze({
            shadowId: `shadow:${trace.traceId}`,
            sampleId: trace.traceId,
            independenceKey: trace.independenceKey,
            validator: "sediment.shadow-metrics",
            candidateScore: trace.shadowScore,
            baselineScore: trace.baselineScore,
            passed: trace.shadowScore > trace.baselineScore,
            observedAt: trace.observedAt ?? input.evaluatedAt,
            notes: "Derived from recorded shadow metrics; shadow only, not published.",
            provenance: provenanceFor(trace),
        }));
    }
    return freeze(records.sort((left, right) => left.shadowId < right.shadowId ? -1 : left.shadowId > right.shadowId ? 1 : 0));
}

export const defaultShadowValidator: ShadowValidatorPort = Object.freeze({
    validate: (input: ShadowValidationInput) => validateShadowMetrics(input),
});

/** Deterministic candidate id for the same draft and shadow record set. */
export function proposalCandidateId(draft: AcceptedBehaviorDraft, shadows: readonly ShadowObservation[]): string {
    const shadowIds = shadows.map(shadow => shadow.shadowId).sort();
    const suffix = digestOf({ behaviorId: draft.behaviorId, version: draft.version, shadowIds }).slice("sha256:".length, "sha256:".length + 16);
    return `sediment-candidate:${suffix}`;
}

/** Builds a candidate-shaped, unpublished proposal from passed shadow records. */
export function proposeBehaviorCandidate(input: Parameters<ProposerPort["propose"]>[0]): BehaviorCandidate {
    const passed = input.shadowRecords.filter(record => record.passed);
    if (passed.length === 0) throw new SedimentError("no_shadow_passes", "Shadow validation produced no passing samples; no candidate is proposed");
    const traces: ValidationTrace[] = passed.map(record => freeze({
        traceId: `validation:${record.shadowId}`,
        behaviorId: input.draft.behaviorId,
        sampleId: record.sampleId,
        independenceKey: record.independenceKey,
        validated: true as const,
        candidateScore: record.candidateScore,
        baselineScore: record.baselineScore,
        validator: record.validator,
        observedAt: record.observedAt,
        provenance: record.provenance ?? freeze([] as ProvenanceRecord[]),
    }));
    const independentSampleCount = new Set(traces.map(trace => trace.independenceKey)).size;
    return freeze({
        candidateId: input.candidateId,
        behaviorId: input.draft.behaviorId,
        version: input.draft.version,
        state: "candidate" as const,
        traces: freeze(traces),
        independentSampleCount,
        dependsOnBehaviorIds: input.draft.dependsOnBehaviorIds,
        createdAt: input.proposedAt,
    });
}

export const defaultProposerPort: ProposerPort = Object.freeze({
    propose: (input: Parameters<ProposerPort["propose"]>[0]) => proposeBehaviorCandidate(input),
});
