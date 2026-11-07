import type { Identifier } from "../shared.ts";
import type {
    LearnRecord,
    LearnSource,
    LearnState,
    LearnTargetKind,
} from "./types.ts";
import {
    LEARN_SOURCES,
    LEARN_TARGET_KINDS,
    LearnError,
    assertLearnTransition,
} from "./types.ts";

export type LearnClock = () => string;

/** Interval applied by `reinforce` when the caller does not supply a new review time. */
export const DEFAULT_REVISIT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ObserveLearnInput {
    readonly id: Identifier;
    readonly source: LearnSource;
    readonly targetKind: LearnTargetKind;
    readonly targetId?: Identifier;
    /** Verified trajectory ids; at least one is required. */
    readonly traces: readonly Identifier[];
    readonly evidenceIds?: readonly Identifier[];
    readonly feedbackIds?: readonly Identifier[];
    /** Initial confidence; defaults to 0 because no reflection has happened yet. */
    readonly confidence?: number;
    readonly reason: string;
}

export interface LearnTransitionOptions {
    /** Version the caller read; every transition is a compare-and-swap. */
    readonly expectedVersion: number;
}

export interface ReflectLearnInput extends LearnTransitionOptions {
    readonly summary: string;
    /** Confidence in [0, 1]. */
    readonly confidence: number;
}

export interface AbstractLearnInput extends LearnTransitionOptions {
    readonly abstraction: string;
    /** Additional independent evidence supporting the abstraction. */
    readonly evidenceIds?: readonly Identifier[];
}

export interface ValidateLearnInput extends LearnTransitionOptions {
    /** A validation record owned by the evaluation/verification domain. */
    readonly validationId: Identifier;
    /** A dependent validation can never be adopted. */
    readonly independent: boolean;
}

export interface AdoptLearnInput extends LearnTransitionOptions {
    /** Human or host approval identity. */
    readonly approvedBy: Identifier;
    readonly reason: string;
}

export interface RetainLearnInput extends LearnTransitionOptions {
    readonly revisitAfter: string;
}

export interface ReinforceLearnInput extends LearnTransitionOptions {
    /** Defaults to `now + DEFAULT_REVISIT_INTERVAL_MS`. */
    readonly revisitAfter?: string;
}

/** The reflection summary; it is not part of {@link LearnRecord}. */
export interface LearnReflection {
    readonly summary: string;
    readonly confidence: number;
    readonly reflectedAt: string;
}

/** The validation reference recorded by `validate`; adopt reads `independent`. */
export interface LearnValidation {
    readonly validationId: Identifier;
    readonly independent: boolean;
    readonly validatedAt: string;
}

/** The approval recorded by `adopt`; the record keeps only `adoptedAt`. */
export interface LearnApproval {
    readonly approvedBy: Identifier;
    readonly reason: string;
    readonly adoptedAt: string;
}

export type LearnAction =
    | "observe"
    | "reflect"
    | "abstract"
    | "validate"
    | "adopt"
    | "retain"
    | "reinforce"
    | "decay"
    | "reject"
    | "supersede";

/** Append-only audit record, one per successful transition (replays excluded). */
export interface LearnEvent {
    readonly sequence: number;
    readonly learnId: Identifier;
    readonly action: LearnAction;
    readonly from: LearnState;
    readonly to: LearnState;
    readonly fromVersion: number;
    readonly version: number;
    readonly at: string;
    readonly reason?: string;
}

type LearnPatch = Partial<
    Pick<LearnRecord, "abstraction" | "confidence" | "evidenceIds" | "revisitAfter" | "supersededBy">
>;

interface LastTransition {
    readonly action: LearnAction;
    readonly expectedVersion: number;
    readonly fingerprint: string;
    readonly version: number;
}

const MAX_LEARN_VERSION = Number.MAX_SAFE_INTEGER;
const EMPTY_IDS: readonly Identifier[] = Object.freeze([]);

const fail = (message: string): never => {
    throw new LearnError("invalid_learn", message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const requireText = (value: unknown, field: string): string =>
    typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);

const confidenceOf = (value: unknown, field: string): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
        ? value
        : fail(`${field} must be a finite number in [0, 1]`);

const safeInteger = (value: unknown, field: string, minimum = 0): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
        ? value
        : fail(`${field} must be a safe integer >= ${minimum}`);

const timestampOf = (value: unknown, field: string): string =>
    typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value))
        ? value
        : fail(`${field} must be an ISO-compatible timestamp`);

function normalizeIds(
    value: unknown,
    field: string,
    required: boolean,
    minimum = 0,
): readonly Identifier[] | undefined {
    if (value === undefined) {
        if (required) return fail(`${field} requires at least ${minimum} identifier(s)`);
        return undefined;
    }
    if (!Array.isArray(value) || value.length < minimum) {
        return fail(`${field} must be an array with at least ${minimum} identifier(s)`);
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

function mergeIds(existing: readonly Identifier[], added: readonly Identifier[]): readonly Identifier[] {
    const seen = new Set<string>();
    const merged: Identifier[] = [];
    for (const id of [...existing, ...added]) {
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
    }
    return Object.freeze(merged);
}

function sourceOf(value: unknown): LearnSource {
    return (LEARN_SOURCES as readonly string[]).includes(value as string)
        ? value as LearnSource
        : fail(`invalid learn source: ${String(value)}`);
}

function targetKindOf(value: unknown): LearnTargetKind {
    return (LEARN_TARGET_KINDS as readonly string[]).includes(value as string)
        ? value as LearnTargetKind
        : fail(`invalid learn target kind: ${String(value)}`);
}

function fingerprintOf(...parts: readonly string[]): string {
    return parts.map(part => `${part.length}:${part}`).join("|");
}

const idsFingerprint = (ids: readonly Identifier[] | undefined): string =>
    ids === undefined ? "none" : JSON.stringify(ids);

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

/**
 * Versioned learning ledger for `refract.md` §11.14 L8.
 *
 * The ledger owns the learning state machine, evidence gate, review schedule
 * and compare-and-swap versions. It never writes to another domain; adoption
 * only records that a human/host approved the candidate.
 */
export class LearnLedger {
    private readonly records = new Map<Identifier, LearnRecord>();
    private readonly reflections = new Map<Identifier, LearnReflection>();
    private readonly validations = new Map<Identifier, LearnValidation>();
    private readonly approvals = new Map<Identifier, LearnApproval>();
    private readonly lastTransitions = new Map<Identifier, LastTransition>();
    private readonly eventLog: LearnEvent[] = [];
    private readonly clock: LearnClock;
    private sequence = 0;

    constructor(clock: LearnClock = () => new Date().toISOString()) {
        if (typeof clock !== "function") fail("learn clock must be a function");
        this.clock = clock;
    }

    /**
     * Records a verified trajectory as an `observed` candidate. At least one
     * trace and a reason are mandatory, and ids are unique across the ledger.
     */
    observe(input: ObserveLearnInput): LearnRecord {
        if (!isRecord(input)) return fail("learn observe input must be an object");
        const id = requireText(input.id, "learn id");
        if (this.records.has(id)) throw new LearnError("invalid_learn", `duplicate learn record: ${id}`);
        const source = sourceOf(input.source);
        const targetKind = targetKindOf(input.targetKind);
        const targetId = input.targetId === undefined ? undefined : requireText(input.targetId, "learn targetId");
        const traces = normalizeIds(input.traces, "learn traces", true, 1) as readonly Identifier[];
        const evidenceIds = normalizeIds(input.evidenceIds, "learn evidenceIds", false) ?? EMPTY_IDS;
        const feedbackIds = normalizeIds(input.feedbackIds, "learn feedbackIds", false);
        const confidence = input.confidence === undefined ? 0 : confidenceOf(input.confidence, "learn confidence");
        const reason = requireText(input.reason, "learn observation reason");
        const at = this.now();
        const record: LearnRecord = snapshot({
            id,
            source,
            targetKind,
            ...(targetId === undefined ? {} : { targetId }),
            traces,
            confidence,
            evidenceIds,
            ...(feedbackIds === undefined ? {} : { feedbackIds }),
            createdAt: at,
            updatedAt: at,
            version: 1,
            state: "observed",
        });
        this.records.set(id, record);
        this.sequence += 1;
        this.eventLog.push(Object.freeze({
            sequence: this.sequence,
            learnId: id,
            action: "observe",
            // Creation is audited as a self-edge so every event keeps from/to.
            from: "observed",
            to: "observed",
            fromVersion: 0,
            version: 1,
            at,
            reason,
        }));
        return this.get(id) as LearnRecord;
    }

    get(id: Identifier): LearnRecord | undefined {
        const stored = this.records.get(id);
        return stored === undefined ? undefined : snapshot(stored);
    }

    list(): readonly LearnRecord[] {
        return Object.freeze([...this.records.values()].map(snapshot));
    }

    reflection(id: Identifier): LearnReflection | undefined {
        const reflection = this.reflections.get(id);
        return reflection === undefined ? undefined : snapshot(reflection);
    }

    validation(id: Identifier): LearnValidation | undefined {
        const validation = this.validations.get(id);
        return validation === undefined ? undefined : snapshot(validation);
    }

    approval(id: Identifier): LearnApproval | undefined {
        const approval = this.approvals.get(id);
        return approval === undefined ? undefined : snapshot(approval);
    }

    /** Transition audit in commit order; idempotent replays add no event. */
    auditEvents(learnId?: Identifier): readonly LearnEvent[] {
        return Object.freeze(
            this.eventLog
                .filter(event => learnId === undefined || event.learnId === learnId)
                .map(snapshot),
        );
    }

    /** observed -> reflected; the summary is audited and confidence is bounded. */
    reflect(id: Identifier, input: ReflectLearnInput): LearnRecord {
        if (!isRecord(input)) return fail("reflect input must be an object");
        const summary = requireText(input.summary, "reflection summary");
        const confidence = confidenceOf(input.confidence, "reflection confidence");
        const fingerprint = fingerprintOf("reflect", summary, String(confidence));
        const begin = this.begin(id, "reflect", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertLearnTransition(begin.current.state, "reflected");
        const reflected = this.commit(id, "reflect", input.expectedVersion, fingerprint, begin.current, "reflected", {
            confidence,
        }, summary);
        this.reflections.set(id, snapshot({
            summary,
            confidence,
            reflectedAt: reflected.updatedAt,
        }));
        return reflected;
    }

    /**
     * reflected -> abstracted. Requires at least two traces or at least one
     * independent evidence id; otherwise the evidence gate fails and the
     * record stays reflected.
     */
    abstract(id: Identifier, input: AbstractLearnInput): LearnRecord {
        if (!isRecord(input)) return fail("abstract input must be an object");
        const abstraction = requireText(input.abstraction, "learn abstraction");
        const addedEvidence = normalizeIds(input.evidenceIds, "abstract evidenceIds", false) ?? EMPTY_IDS;
        const fingerprint = fingerprintOf("abstract", abstraction, idsFingerprint(addedEvidence));
        const begin = this.begin(id, "abstract", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertLearnTransition(begin.current.state, "abstracted");
        const evidenceIds = mergeIds(begin.current.evidenceIds, addedEvidence);
        if (begin.current.traces.length < 2 && evidenceIds.length < 1) {
            throw new LearnError(
                "insufficient_evidence",
                `learn ${id} needs at least two traces or one independent evidence id`,
            );
        }
        return this.commit(id, "abstract", input.expectedVersion, fingerprint, begin.current, "abstracted", {
            abstraction,
            evidenceIds,
        }, abstraction);
    }

    /** abstracted -> validated; a validation record id is mandatory. */
    validate(id: Identifier, input: ValidateLearnInput): LearnRecord {
        if (!isRecord(input)) return fail("validate input must be an object");
        const validationId = requireText(input.validationId, "validationId");
        if (typeof input.independent !== "boolean") return fail("validation independent must be a boolean");
        const fingerprint = fingerprintOf("validate", validationId, String(input.independent));
        const begin = this.begin(id, "validate", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertLearnTransition(begin.current.state, "validated");
        const validated = this.commit(id, "validate", input.expectedVersion, fingerprint, begin.current, "validated", {}, `validation ${validationId}`);
        this.validations.set(id, snapshot({
            validationId,
            independent: input.independent,
            validatedAt: validated.updatedAt,
        }));
        return validated;
    }

    /**
     * validated -> adopted. Requires a human/host approval identity and an
     * independent validation; a dependent validation keeps the record in
     * `validated`.
     */
    adopt(id: Identifier, input: AdoptLearnInput): LearnRecord {
        if (!isRecord(input)) return fail("adopt input must be an object");
        const approvedBy = requireText(input.approvedBy, "approvedBy");
        const reason = requireText(input.reason, "adoption reason");
        const fingerprint = fingerprintOf("adopt", approvedBy, reason);
        const begin = this.begin(id, "adopt", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertLearnTransition(begin.current.state, "adopted");
        const validation = this.validations.get(id);
        if (validation === undefined) {
            throw new LearnError("invalid_learn", `learn ${id} has no validation record to adopt from`);
        }
        if (!validation.independent) {
            throw new LearnError(
                "insufficient_evidence",
                `learn ${id} cannot be adopted from a non-independent validation`,
            );
        }
        const adopted = this.commit(id, "adopt", input.expectedVersion, fingerprint, begin.current, "adopted", {}, reason);
        this.approvals.set(id, snapshot({
            approvedBy,
            reason,
            adoptedAt: adopted.updatedAt,
        }));
        return adopted;
    }

    /** adopted -> retained; schedules the next review. */
    retain(id: Identifier, input: RetainLearnInput): LearnRecord {
        if (!isRecord(input)) return fail("retain input must be an object");
        const revisitAfter = timestampOf(input.revisitAfter, "revisitAfter");
        const fingerprint = fingerprintOf("retain", revisitAfter);
        const begin = this.begin(id, "retain", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertLearnTransition(begin.current.state, "retained");
        return this.commit(id, "retain", input.expectedVersion, fingerprint, begin.current, "retained", {
            revisitAfter,
        }, `revisit after ${revisitAfter}`);
    }

    /**
     * retained|decayed -> retained. Resets the review time to the supplied
     * `revisitAfter`, or to `now + DEFAULT_REVISIT_INTERVAL_MS`.
     */
    reinforce(id: Identifier, input: ReinforceLearnInput): LearnRecord {
        if (!isRecord(input)) return fail("reinforce input must be an object");
        const suppliedRevisit = input.revisitAfter === undefined
            ? undefined
            : timestampOf(input.revisitAfter, "revisitAfter");
        const fingerprint = fingerprintOf("reinforce", suppliedRevisit ?? "default");
        const begin = this.begin(id, "reinforce", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertLearnTransition(begin.current.state, "retained");
        const at = this.now();
        const revisitAfter = suppliedRevisit
            ?? new Date(Date.parse(at) + DEFAULT_REVISIT_INTERVAL_MS).toISOString();
        return this.commit(id, "reinforce", input.expectedVersion, fingerprint, begin.current, "retained", {
            revisitAfter,
        }, `reinforced; revisit after ${revisitAfter}`, at);
    }

    /**
     * retained -> decayed once `now >= revisitAfter`. Before the review time
     * the transition is refused with `decay_due`.
     */
    decay(id: Identifier, now: string, input: LearnTransitionOptions): LearnRecord {
        if (!isRecord(input)) return fail("decay input must be an object");
        const at = timestampOf(now, "decay now");
        const fingerprint = fingerprintOf("decay", at);
        const begin = this.begin(id, "decay", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertLearnTransition(begin.current.state, "decayed");
        const revisitAfter = begin.current.revisitAfter;
        if (revisitAfter === undefined) {
            throw new LearnError("invalid_learn", `learn ${id} is retained without a revisit time`);
        }
        if (Date.parse(at) < Date.parse(revisitAfter)) {
            throw new LearnError("decay_due", `learn ${id} is not due for decay until ${revisitAfter}`);
        }
        return this.commit(id, "decay", input.expectedVersion, fingerprint, begin.current, "decayed", {}, `revisit ${revisitAfter} reached at ${at}`);
    }

    /** observed|reflected|abstracted|validated -> rejected; the reason is audited. */
    reject(id: Identifier, reason: string, input: LearnTransitionOptions): LearnRecord {
        if (!isRecord(input)) return fail("reject input must be an object");
        const rejectionReason = requireText(reason, "rejection reason");
        const fingerprint = fingerprintOf("reject", rejectionReason);
        const begin = this.begin(id, "reject", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertLearnTransition(begin.current.state, "rejected");
        return this.commit(id, "reject", input.expectedVersion, fingerprint, begin.current, "rejected", {}, rejectionReason);
    }

    /** Non-terminal -> superseded by an existing learn record. */
    supersede(id: Identifier, byId: Identifier, input: LearnTransitionOptions): LearnRecord {
        if (!isRecord(input)) return fail("supersede input must be an object");
        const successorId = requireText(byId, "superseding learn id");
        if (successorId === id) return fail("learn record cannot supersede itself");
        if (!this.records.has(successorId)) return fail(`unknown superseding learn record: ${successorId}`);
        const fingerprint = fingerprintOf("supersede", successorId);
        const begin = this.begin(id, "supersede", input.expectedVersion, fingerprint);
        if (begin.replay !== undefined) return begin.replay;
        assertLearnTransition(begin.current.state, "superseded");
        return this.commit(id, "supersede", input.expectedVersion, fingerprint, begin.current, "superseded", {
            supersededBy: successorId,
        }, `superseded by ${successorId}`);
    }

    private now(): string {
        return timestampOf(this.clock(), "learn clock");
    }

    /**
     * Common CAS/idempotency gate. A repeated action with the same
     * `expectedVersion`, input fingerprint and resulting version returns the
     * existing record without committing again.
     */
    private begin(
        id: Identifier,
        action: LearnAction,
        expectedVersion: number,
        fingerprint: string,
    ): { readonly current: LearnRecord; readonly replay?: LearnRecord } {
        const current = this.records.get(id);
        if (current === undefined) return fail(`unknown learn record: ${id}`);
        const expected = safeInteger(expectedVersion, `learn ${id} expectedVersion`, 1);
        const previous = this.lastTransitions.get(id);
        if (previous !== undefined
            && previous.version === current.version
            && previous.action === action
            && previous.expectedVersion === expected
            && previous.fingerprint === fingerprint) {
            return { current, replay: snapshot(current) };
        }
        if (current.version !== expected) {
            throw new LearnError("version_conflict", `learn ${id} expected version ${expected}, current ${current.version}`);
        }
        return { current };
    }

    private commit(
        id: Identifier,
        action: LearnAction,
        expectedVersion: number,
        fingerprint: string,
        current: LearnRecord,
        nextState: LearnState,
        patch: LearnPatch,
        reason?: string,
        atOverride?: string,
    ): LearnRecord {
        if (current.version >= MAX_LEARN_VERSION) return fail("learn version exhausted");
        const at = atOverride ?? this.now();
        const next: LearnRecord = snapshot({
            ...current,
            ...patch,
            state: nextState,
            version: current.version + 1,
            updatedAt: at,
            ...(nextState === "adopted" ? { adoptedAt: at } : {}),
        });
        this.records.set(id, next);
        this.lastTransitions.set(id, Object.freeze({ action, expectedVersion, fingerprint, version: next.version }));
        this.sequence += 1;
        this.eventLog.push(Object.freeze({
            sequence: this.sequence,
            learnId: id,
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
