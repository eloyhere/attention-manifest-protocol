import type { Identifier, JsonValue } from "../shared.ts";
import type { Feedback, FeedbackState, FeedbackTarget, FeedbackTargetKind } from "./types.ts";
import {
    FEEDBACK_POLARITIES,
    FEEDBACK_SOURCES,
    FEEDBACK_TARGET_KINDS,
    FeedbackError,
    assertFeedbackTransition,
} from "./types.ts";

/** Triaging can only apply, reject or defer a normalized item. */
export const TRIAGE_DECISIONS = ["apply", "reject", "defer"] as const;
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number];

export type FeedbackClock = () => string;

export interface CaptureFeedbackInput {
    readonly id: Identifier;
    readonly source: Feedback["source"];
    readonly polarity: Feedback["polarity"];
    readonly target: FeedbackTarget;
    readonly evidenceIds: readonly Identifier[];
    readonly receiptIds?: readonly Identifier[];
    readonly scoreDelta?: number;
    readonly reason: string;
    readonly payload?: JsonValue;
}

export interface FeedbackTransitionOptions {
    /** Version the caller read; every transition is a compare-and-swap. */
    readonly expectedVersion: number;
}

export interface NormalizeFeedbackInput extends FeedbackTransitionOptions {
    readonly scoreDelta?: number;
    readonly target?: FeedbackTarget;
}

export interface TriageFeedbackInput extends FeedbackTransitionOptions {
    readonly decision: TriageDecision;
    /** Required when `decision` is `reject`. */
    readonly reason?: string;
}

export interface VerifyFeedbackInput extends FeedbackTransitionOptions {
    /** A verification record owned by the verification domain. */
    readonly verificationId: Identifier;
}

/** The last triage decision; it is not part of the {@link Feedback} record. */
export interface FeedbackTriage {
    readonly decision: TriageDecision;
    readonly reason?: string;
    readonly triagedAt: string;
}

export interface FeedbackApplyResult {
    readonly applied: boolean;
    /** Target-domain version after the adapter applied the feedback. */
    readonly targetVersion: number;
}

/**
 * The only way a feedback item reaches another domain. The ledger never
 * imports or mutates attention/behavior/profession/capability/context state.
 */
export interface FeedbackTargetAdapter {
    readonly kind: FeedbackTargetKind;
    apply(feedback: Feedback): FeedbackApplyResult;
}

export type FeedbackAction = "normalize" | "triage" | "apply" | "verify" | "archive" | "reject" | "supersede";

/** Append-only audit record, one per successful transition (replays excluded). */
export interface FeedbackEvent {
    readonly sequence: number;
    readonly feedbackId: Identifier;
    readonly action: FeedbackAction;
    readonly from: FeedbackState;
    readonly to: FeedbackState;
    readonly fromVersion: number;
    readonly version: number;
    readonly at: string;
    readonly reason?: string;
}

type FeedbackPatch = Partial<Pick<Feedback, "scoreDelta" | "target" | "supersededBy">>;

interface LastTransition {
    readonly action: FeedbackAction;
    readonly expectedVersion: number;
    readonly fingerprint: string;
    readonly version: number;
}

const MAX_FEEDBACK_VERSION = Number.MAX_SAFE_INTEGER;

const fail = (message: string): never => {
    throw new FeedbackError("invalid_feedback", message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const requireText = (value: unknown, field: string): string =>
    typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);

const safeInteger = (value: unknown, field: string, minimum = 0): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
        ? value
        : fail(`${field} must be a safe integer >= ${minimum}`);

const normalizeScoreDelta = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1
        ? value
        : fail("scoreDelta must be a finite number in [-1, 1]");

function normalizeTarget(value: unknown): FeedbackTarget {
    if (!isRecord(value)) return fail("feedback target must be an object");
    if (!(FEEDBACK_TARGET_KINDS as readonly string[]).includes(value.kind as string)) {
        return fail(`invalid feedback target kind: ${String(value.kind)}`);
    }
    const id = requireText(value.id, "feedback target id");
    const version = value.version === undefined ? undefined : safeInteger(value.version, "feedback target version");
    return Object.freeze({
        kind: value.kind as FeedbackTargetKind,
        id,
        ...(version === undefined ? {} : { version }),
    });
}

function normalizeIds(value: unknown, field: string, required: boolean): readonly Identifier[] | undefined {
    if (value === undefined) {
        if (required) return fail(`${field} requires at least one identifier`);
        return undefined;
    }
    if (!Array.isArray(value) || (required && value.length === 0)) {
        return fail(`${field} must be an array with at least one identifier`);
    }
    const seen = new Set<string>();
    const ids: Identifier[] = [];
    for (const item of value) {
        const id = requireText(item, `${field} item`);
        if (seen.has(id)) return fail(`${field} contains duplicate identifier: ${id}`);
        seen.add(id);
        ids.push(id);
    }
    return Object.freeze(ids);
}

function normalizeDecision(value: unknown): TriageDecision {
    return (TRIAGE_DECISIONS as readonly string[]).includes(value as string)
        ? value as TriageDecision
        : fail(`invalid triage decision: ${String(value)}`);
}

function fingerprintOf(...parts: readonly string[]): string {
    return parts.map(part => `${part.length}:${part}`).join("|");
}

function targetFingerprint(target: FeedbackTarget | undefined): string {
    return target === undefined ? "none" : JSON.stringify([target.kind, target.id, target.version ?? null]);
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

function snapshot<T>(value: T): T {
    return deepFreeze(structuredClone(value));
}

function adapterKindOf(adapter: unknown): FeedbackTargetKind {
    if (!isRecord(adapter) || typeof adapter.apply !== "function") {
        return fail("feedback target adapter must expose kind and apply");
    }
    if (!(FEEDBACK_TARGET_KINDS as readonly string[]).includes(adapter.kind as string)) {
        return fail(`invalid feedback target adapter kind: ${String(adapter.kind)}`);
    }
    return adapter.kind as FeedbackTargetKind;
}

/**
 * Versioned feedback ledger. It owns the feedback state machine, evidence
 * requirements and compare-and-swap versions. Applying to another domain is
 * exclusively delegated to a {@link FeedbackTargetAdapter}; a failed adapter
 * leaves the record untouched (atomic).
 */
export class FeedbackLedger {
    private readonly records = new Map<Identifier, Feedback>();
    private readonly triages = new Map<Identifier, FeedbackTriage>();
    private readonly lastTransitions = new Map<Identifier, LastTransition>();
    private readonly eventLog: FeedbackEvent[] = [];
    private readonly clock: FeedbackClock;
    private sequence = 0;

    constructor(clock: FeedbackClock = () => new Date().toISOString()) {
        if (typeof clock !== "function") fail("feedback clock must be a function");
        this.clock = clock;
    }

    /**
     * Captures a new feedback item. A reason and at least one evidence id are
     * mandatory (negative corrections can never be evidence-free), and ids are
     * unique across the ledger.
     */
    capture(input: CaptureFeedbackInput): Feedback {
        if (!isRecord(input)) return fail("feedback capture input must be an object");
        const id = requireText(input.id, "feedback id");
        if (this.records.has(id)) throw new FeedbackError("invalid_feedback", `duplicate feedback: ${id}`);
        const source = this.sourceOf(input.source);
        const polarity = this.polarityOf(input.polarity);
        const target = normalizeTarget(input.target);
        const evidenceIds = normalizeIds(input.evidenceIds, "feedback evidenceIds", true) as readonly Identifier[];
        if (polarity === "negative" && evidenceIds.length === 0) {
            return fail("negative feedback requires at least one evidence id");
        }
        const receiptIds = normalizeIds(input.receiptIds, "feedback receiptIds", false);
        const scoreDelta = input.scoreDelta === undefined ? undefined : normalizeScoreDelta(input.scoreDelta);
        const reason = requireText(input.reason, "feedback reason");
        const at = this.now();
        const record: Feedback = {
            id,
            source,
            polarity,
            target,
            evidenceIds,
            ...(receiptIds === undefined ? {} : { receiptIds }),
            ...(scoreDelta === undefined ? {} : { scoreDelta }),
            reason,
            ...(input.payload === undefined ? {} : { payload: input.payload }),
            createdAt: at,
            updatedAt: at,
            version: 1,
            state: "captured",
        };
        this.records.set(id, snapshot(record));
        return this.get(id) as Feedback;
    }

    get(id: Identifier): Feedback | undefined {
        const stored = this.records.get(id);
        return stored === undefined ? undefined : snapshot(stored);
    }

    list(): readonly Feedback[] {
        return Object.freeze([...this.records.values()].map(snapshot));
    }

    getTriage(id: Identifier): FeedbackTriage | undefined {
        const triage = this.triages.get(id);
        return triage === undefined ? undefined : snapshot(triage);
    }

    /** Transition audit in commit order; idempotent replays add no event. */
    auditEvents(feedbackId?: Identifier): readonly FeedbackEvent[] {
        return Object.freeze(
            this.eventLog
                .filter(event => feedbackId === undefined || event.feedbackId === feedbackId)
                .map(snapshot),
        );
    }

    /** captured -> normalized; `scoreDelta` is bounded to [-1, 1]. */
    normalize(id: Identifier, input: NormalizeFeedbackInput): Feedback {
        if (!isRecord(input)) return fail("normalize input must be an object");
        const scoreDelta = input.scoreDelta === undefined ? undefined : normalizeScoreDelta(input.scoreDelta);
        const target = input.target === undefined ? undefined : normalizeTarget(input.target);
        const fingerprint = fingerprintOf(
            "normalize",
            scoreDelta === undefined ? "none" : String(scoreDelta),
            targetFingerprint(target),
        );
        const begin = this.begin(id, "normalize", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertFeedbackTransition(begin.current.state, "normalized");
        return this.commit(id, "normalize", input.expectedVersion, fingerprint, begin.current, "normalized", {
            ...(scoreDelta === undefined ? {} : { scoreDelta }),
            ...(target === undefined ? {} : { target }),
        });
    }

    /**
     * normalized -> triaged. The decision is recorded separately from the
     * public record; `apply` requires the `apply` decision. Rejecting requires
     * a reason.
     */
    triage(id: Identifier, input: TriageFeedbackInput): Feedback {
        if (!isRecord(input)) return fail("triage input must be an object");
        const decision = normalizeDecision(input.decision);
        const reason = input.reason === undefined ? undefined : requireText(input.reason, "triage reason");
        if (decision === "reject" && reason === undefined) return fail("triage reject requires a reason");
        const fingerprint = fingerprintOf("triage", decision, reason ?? "none");
        const begin = this.begin(id, "triage", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertFeedbackTransition(begin.current.state, "triaged");
        const triaged = this.commit(id, "triage", input.expectedVersion, fingerprint, begin.current, "triaged", {}, reason);
        this.triages.set(id, snapshot({
            decision,
            ...(reason === undefined ? {} : { reason }),
            triagedAt: triaged.updatedAt,
        }));
        return triaged;
    }

    /**
     * triaged -> applied. The adapter is called exactly once per successful
     * transition; its result is validated before the ledger commits. Adapter
     * throws, `applied: false` or an invalid version leave the record in
     * `triaged` so the caller can retry with the same expected version.
     */
    apply(id: Identifier, adapter: FeedbackTargetAdapter, input: FeedbackTransitionOptions): Feedback {
        if (!isRecord(input)) return fail("apply input must be an object");
        const adapterKind = adapterKindOf(adapter);
        const fingerprint = fingerprintOf("apply", adapterKind);
        const begin = this.begin(id, "apply", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        if (begin.current.target.kind !== adapterKind) {
            throw new FeedbackError("invalid_feedback", `adapter ${adapterKind} cannot apply ${begin.current.target.kind} feedback`);
        }
        assertFeedbackTransition(begin.current.state, "applied");
        const triage = this.triages.get(id);
        if (triage === undefined || triage.decision !== "apply") {
            throw new FeedbackError("invalid_transition", `feedback ${id} requires an apply triage decision before apply`);
        }
        const candidate = snapshot(begin.current);
        const result: unknown = adapter.apply(candidate);
        if (!isRecord(result) || typeof result.applied !== "boolean") {
            return fail("feedback adapter must return { applied: boolean, targetVersion: number }");
        }
        if (!result.applied) {
            throw new FeedbackError("adapter_failed", `adapter ${adapterKind} did not apply feedback ${id}`);
        }
        const targetVersion = safeInteger(result.targetVersion, "feedback adapter targetVersion");
        const target: FeedbackTarget = Object.freeze({ ...begin.current.target, version: targetVersion });
        return this.commit(id, "apply", input.expectedVersion, fingerprint, begin.current, "applied", { target });
    }

    /** applied -> verified; a verification record id is mandatory. */
    verify(id: Identifier, input: VerifyFeedbackInput): Feedback {
        if (!isRecord(input)) return fail("verify input must be an object");
        const verificationId = requireText(input.verificationId, "verificationId");
        const fingerprint = fingerprintOf("verify", verificationId);
        const begin = this.begin(id, "verify", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertFeedbackTransition(begin.current.state, "verified");
        return this.commit(id, "verify", input.expectedVersion, fingerprint, begin.current, "verified", {});
    }

    /** verified -> archived. */
    archive(id: Identifier, input: FeedbackTransitionOptions): Feedback {
        if (!isRecord(input)) return fail("archive input must be an object");
        const fingerprint = fingerprintOf("archive");
        const begin = this.begin(id, "archive", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertFeedbackTransition(begin.current.state, "archived");
        return this.commit(id, "archive", input.expectedVersion, fingerprint, begin.current, "archived", {});
    }

    /** captured|normalized|triaged -> rejected; the reason is audited. */
    reject(id: Identifier, reason: string, input: FeedbackTransitionOptions): Feedback {
        if (!isRecord(input)) return fail("reject input must be an object");
        const rejectionReason = requireText(reason, "rejection reason");
        const fingerprint = fingerprintOf("reject", rejectionReason);
        const begin = this.begin(id, "reject", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertFeedbackTransition(begin.current.state, "rejected");
        return this.commit(id, "reject", input.expectedVersion, fingerprint, begin.current, "rejected", {}, rejectionReason);
    }

    /** Non-terminal states -> superseded by an existing feedback item. */
    supersede(id: Identifier, byId: Identifier, input: FeedbackTransitionOptions): Feedback {
        if (!isRecord(input)) return fail("supersede input must be an object");
        const successorId = requireText(byId, "superseding feedback id");
        if (successorId === id) return fail("feedback cannot supersede itself");
        if (!this.records.has(successorId)) return fail(`unknown superseding feedback: ${successorId}`);
        const fingerprint = fingerprintOf("supersede", successorId);
        const begin = this.begin(id, "supersede", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertFeedbackTransition(begin.current.state, "superseded");
        return this.commit(id, "supersede", input.expectedVersion, fingerprint, begin.current, "superseded", {
            supersededBy: successorId,
        });
    }

    private sourceOf(value: unknown): Feedback["source"] {
        return (FEEDBACK_SOURCES as readonly string[]).includes(value as string)
            ? value as Feedback["source"]
            : fail(`invalid feedback source: ${String(value)}`);
    }

    private polarityOf(value: unknown): Feedback["polarity"] {
        return (FEEDBACK_POLARITIES as readonly string[]).includes(value as string)
            ? value as Feedback["polarity"]
            : fail(`invalid feedback polarity: ${String(value)}`);
    }

    private now(): string {
        const value = this.clock();
        return typeof value === "string" && Number.isFinite(Date.parse(value))
            ? value
            : fail("feedback clock must return an ISO-compatible timestamp");
    }

    /**
     * Common CAS/idempotency gate. A repeated action with the same
     * `expectedVersion`, input fingerprint and resulting version returns the
     * existing record without re-running side effects (adapter included).
     */
    private begin(
        id: Identifier,
        action: FeedbackAction,
        expectedVersion: number,
        fingerprint: string,
    ): { readonly current: Feedback; readonly replay?: Feedback } {
        const current = this.records.get(id);
        if (current === undefined) return fail(`unknown feedback: ${id}`);
        const expected = safeInteger(expectedVersion, `feedback ${id} expectedVersion`, 1);
        const previous = this.lastTransitions.get(id);
        if (previous !== undefined
            && previous.version === current.version
            && previous.action === action
            && previous.expectedVersion === expected
            && previous.fingerprint === fingerprint) {
            return { current, replay: snapshot(current) };
        }
        if (current.version !== expected) {
            throw new FeedbackError("version_conflict", `feedback ${id} expected version ${expected}, current ${current.version}`);
        }
        return { current };
    }

    private commit(
        id: Identifier,
        action: FeedbackAction,
        expectedVersion: number,
        fingerprint: string,
        current: Feedback,
        nextState: FeedbackState,
        patch: FeedbackPatch,
        reason?: string,
    ): Feedback {
        if (current.version >= MAX_FEEDBACK_VERSION) return fail("feedback version exhausted");
        const at = this.now();
        const next: Feedback = snapshot({
            ...current,
            ...patch,
            state: nextState,
            version: current.version + 1,
            updatedAt: at,
            ...(nextState === "applied" ? { appliedAt: at } : {}),
            ...(nextState === "verified" ? { verifiedAt: at } : {}),
        });
        this.records.set(id, next);
        this.lastTransitions.set(id, Object.freeze({ action, expectedVersion, fingerprint, version: next.version }));
        this.sequence += 1;
        this.eventLog.push(Object.freeze({
            sequence: this.sequence,
            feedbackId: id,
            action,
            from: current.state,
            to: nextState,
            fromVersion: current.version,
            version: next.version,
            at,
            ...(reason === undefined ? {} : { reason }),
        }));
        return snapshot(next);
    }
}
