/**
 * Frame boundary: the only place a `Frame` may be constructed.
 *
 * The reference runtime builds frames from object literals, so a frame can
 * currently cite a target that does not exist, omit a reason, or carry an
 * unbounded exclusion list. This module turns those into rejections and returns
 * the part of the exclusion list that does not fit as `deferred`, so nothing is
 * silently dropped.
 *
 * Construction is a rebuild, not a reference copy: every retained field is
 * checked against a whitelist and recreated, and then the frame (with
 * `deferred`) is recursively frozen. A caller that mutates its draft after
 * construction cannot change a frame that has already been digested.
 *
 * The frame is not extended with new fields: `frame.schema.json` sets
 * `additionalProperties: false`, so aggregates belong to a later capacity layer,
 * not to this object.
 */
import type { Budget, Id, Ref, RefKind, Timestamp } from "../types/common.ts";
import type { Frame, FrameBudget, FrameMode, Ignored, Impasse, Slot } from "../frame/frame.ts";

import { digestOf } from "../semantic/canonical.ts";
import { deepFreezeJson } from "../semantic/jsonValue.ts";
import { isDateTime } from "../semantic/time.ts";
import { isId } from "./ids.ts";
import { isRefKind } from "./kinds.ts";
import { BoundaryRejection } from "../error/boundaryRejection.ts";
import type { RefTable } from "./refTable.ts";

/**
 * Draft accepted by {@link frameFrom}; `digest` is computed here, never supplied.
 */
export interface FrameDraft {
    id: Id;
    agent: Id;
    cycle: number;
    ts?: Timestamp;
    parent?: Ref;
    mode: FrameMode;
    goal?: Ref;
    slots: Slot[];
    ignored?: Ignored[];
    budget: FrameBudget;
    open_questions?: Ref[];
    impasse?: Impasse;
    note?: string;
}

export interface FrameBoundaryOptions {
    /**
     * May lower the schema ceiling of 9, never raise it. Defaults to 9.
     */
    maxSlots?: number;
    /**
     * Visible exclusions kept on the frame; the rest is returned as `deferred`.
     * Defaults to 50 and may not be raised above it.
     */
    maxIgnored?: number;
    /**
     * Clock for `ts` when the draft omits it. Hosts should pass their ledger clock.
     */
    now?: () => Timestamp;
}

export interface FrameBoundaryResult {
    frame: Frame;
    /**
     * Exclusions beyond `maxIgnored`, in input order. Never silently dropped.
     */
    deferred: Ignored[];
}

const SchemaMaxSlots: number = 9;
const DefaultMaxIgnored: number = 50;

const BudgetDimensions: readonly string[] = ["tokens", "ms", "calls", "interrupts", "money"];
const FrameProperties: readonly string[] = [
    "id",
    "agent",
    "cycle",
    "ts",
    "parent",
    "mode",
    "goal",
    "slots",
    "ignored",
    "budget",
    "open_questions",
    "impasse",
    "note",
];
const SlotProperties: readonly string[] = ["target", "role", "tier", "salience", "voi", "cost", "budget", "why", "ttl_turns", "state"];
const IgnoredProperties: readonly string[] = ["target", "reason", "revisit_if"];
const RefProperties: readonly string[] = ["kind", "id", "label"];
const FrameBudgetProperties: readonly string[] = ["allocated", "spent"];
const ImpasseProperties: readonly string[] = ["state", "detail"];

const FrameModes: readonly FrameMode[] = ["explore", "exploit", "triage", "reflect", "rest"];
const SlotRoles: readonly Slot["role"][] = ["goal", "question", "evidence", "concept", "process", "tool", "memory", "self", "other", "threat", "artifact"];
const SlotStates: readonly Slot["state"][] = ["active", "released", "evicted", "done"];
const IgnoredReasons: readonly Ignored["reason"][] = ["low_voi", "out_of_scope", "untrusted", "budget", "blocked", "habituated", "deferred"];
const ImpasseStates: readonly Impasse["state"][] = ["TIE", "STUCK", "STALLED", "CONFLICT", "INFEASIBLE", "UNKNOWN", "UNVERIFIED", "DRIFT", "BUDGET"];
const Tiers: readonly NonNullable<Slot["tier"]>[] = ["T0", "T1", "T2", "T3", "T4"];

type FrameBoundaryBuilder = (draft: FrameDraft, refs: RefTable, options?: FrameBoundaryOptions) => FrameBoundaryResult;

type BudgetReader = (value: unknown, at: string, problems: string[]) => Budget | undefined;

type RefReader = (value: unknown, refs: RefTable, at: string, problems: string[]) => Ref | undefined;

const isRecord: (value: unknown) => value is Record<string, unknown> = (value: unknown): value is Record<string, unknown> =>
    typeof(value) === "object" && value !== null && !Array.isArray(value);

/**
 * A host draft must be a plain object (or null-prototype). Class instances,
 * arrays and functions are not drafts, even though they can carry the fields.
 */
const isPlainRecord: (value: unknown) => value is Record<string, unknown> = (value: unknown): value is Record<string, unknown> => {
    if (!isRecord(value)) {
        return false;
    }
    const prototype: object | null = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
};

const isRefTable: (value: unknown) => value is RefTable = (value: unknown): value is RefTable =>
    typeof(value) === "object" && value !== null && typeof((value as { check?: unknown }).check) === "function";

const reportUnknownProperties: (value: Record<string, unknown>, allowed: readonly string[], at: string, problems: string[]) => void = (
    value: Record<string, unknown>,
    allowed: readonly string[],
    at: string,
    problems: string[],
): void => {
    const keys: string[] = Object.keys(value);
    for (let index: number = 0; index < keys.length; index += 1) {
        const key: string = keys[index];
        if (!allowed.includes(key)) {
            problems.push(at.length === 0 ? `unknown property "${key}"` : `${at}: unknown property "${key}"`);
        }
    }
};

/**
 * Validate a budget-like object and return a fresh copy that only holds the
 * five declared dimensions. `money` alone may be fractional.
 */
const readBudget: BudgetReader = (value: unknown, at: string, problems: string[]): Budget | undefined => {
    if (!isPlainRecord(value)) {
        problems.push(`${at} must be an object`);
        return (void 0);
    }
    const keys: string[] = Object.keys(value);
    const budget: Budget = {};
    let valid: boolean = true;
    for (let index: number = 0; index < keys.length; index += 1) {
        const key: string = keys[index];
        const amount: unknown = value[key];
        if (!BudgetDimensions.includes(key)) {
            problems.push(`${at}.${key} is not a budget dimension`);
            valid = false;
            continue;
        }
        if (typeof(amount) !== "number" || !Number.isFinite(amount) || amount < 0) {
            problems.push(`${at}.${key} must be a non-negative finite number`);
            valid = false;
            continue;
        }
        if (key !== "money" && !Number.isInteger(amount)) {
            problems.push(`${at}.${key} must be an integer`);
            valid = false;
            continue;
        }
        budget[key as keyof Budget] = amount;
    }
    return valid ? budget : (void 0);
};

/**
 * Validate a reference and return a fresh copy. Opaque kinds pass on shape
 * alone; every other kind must resolve in the supplied scope.
 */
const readRef: RefReader = (value: unknown, refs: RefTable, at: string, problems: string[]): Ref | undefined => {
    if (!isPlainRecord(value)) {
        problems.push(`${at} must be a Ref object`);
        return (void 0);
    }
    reportUnknownProperties(value, RefProperties, at, problems);
    const kind: unknown = value.kind;
    const id: unknown = value.id;
    const label: unknown = value.label;
    let shapeValid: boolean = true;
    if (!isRefKind(kind)) {
        problems.push(`${at}.kind is not a ref kind`);
        shapeValid = false;
    }
    if (!isId(id)) {
        problems.push(`${at}.id is not a valid AMP id`);
        shapeValid = false;
    }
    if (label !== (void 0) && typeof(label) !== "string") {
        problems.push(`${at}.label must be a string`);
        shapeValid = false;
    }
    if (!shapeValid) {
        return (void 0);
    }
    const ref: Ref = { kind: kind as RefKind, id: id as Id };
    if (label !== (void 0)) {
        ref.label = label as string;
    }
    const problem: string | undefined = refs.check(ref);
    if (problem !== (void 0)) {
        problems.push(`${at} ${problem}`);
    }
    return ref;
};

/**
 * Validate a slot and return a fresh copy with only the schema fields.
 */
const readSlot: (value: unknown, refs: RefTable, at: string, problems: string[]) => Slot | undefined = (
    value: unknown,
    refs: RefTable,
    at: string,
    problems: string[],
): Slot | undefined => {
    if (!isPlainRecord(value)) {
        problems.push(`${at} must be an object`);
        return (void 0);
    }
    const problemCount: number = problems.length;
    reportUnknownProperties(value, SlotProperties, at, problems);
    const target: Ref | undefined = readRef(value.target, refs, `${at}.target`, problems);
    const role: unknown = value.role;
    if (typeof(role) !== "string" || !(SlotRoles as readonly string[]).includes(role)) {
        problems.push(`${at}.role is not a slot role`);
    }
    const tier: unknown = value.tier;
    if (tier !== (void 0) && (typeof(tier) !== "string" || !(Tiers as readonly string[]).includes(tier))) {
        problems.push(`${at}.tier is not a tier`);
    }
    const salience: unknown = value.salience;
    if (typeof(salience) !== "number" || !Number.isFinite(salience) || salience < 0 || salience > 1) {
        problems.push(`${at}.salience must be in [0,1]`);
    }
    const voi: unknown = value.voi;
    if (voi !== (void 0) && (typeof(voi) !== "number" || !Number.isFinite(voi) || voi < 0 || voi > 1)) {
        problems.push(`${at}.voi must be in [0,1]`);
    }
    const cost: Budget | undefined = readBudget(value.cost, `${at}.cost`, problems);
    const budget: Budget | undefined = value.budget === (void 0) ? (void 0) : readBudget(value.budget, `${at}.budget`, problems);
    const why: unknown = value.why;
    if (typeof(why) !== "string" || why.trim().length === 0) {
        problems.push(`${at}.why is empty`);
    }
    const ttlTurns: unknown = value.ttl_turns;
    if (ttlTurns !== (void 0) && (typeof(ttlTurns) !== "number" || !Number.isSafeInteger(ttlTurns) || ttlTurns < 0)) {
        problems.push(`${at}.ttl_turns must be a non-negative integer`);
    }
    const state: unknown = value.state;
    if (typeof(state) !== "string" || !(SlotStates as readonly string[]).includes(state)) {
        problems.push(`${at}.state is not a slot state`);
    }
    if (problems.length !== problemCount || target === (void 0) || cost === (void 0)) {
        return (void 0);
    }
    const slot: Slot = {
        target,
        role: role as Slot["role"],
        salience: salience as number,
        cost,
        why: why as string,
        state: state as Slot["state"],
    };
    if (tier !== (void 0)) {
        slot.tier = tier as NonNullable<Slot["tier"]>;
    }
    if (voi !== (void 0)) {
        slot.voi = voi as number;
    }
    if (budget !== (void 0)) {
        slot.budget = budget;
    }
    if (ttlTurns !== (void 0)) {
        slot.ttl_turns = ttlTurns as number;
    }
    return slot;
};

/**
 * Validate a deliberate exclusion and return a fresh copy.
 */
const readIgnored: (value: unknown, refs: RefTable, at: string, problems: string[]) => Ignored | undefined = (
    value: unknown,
    refs: RefTable,
    at: string,
    problems: string[],
): Ignored | undefined => {
    if (!isPlainRecord(value)) {
        problems.push(`${at} must be an object`);
        return (void 0);
    }
    const problemCount: number = problems.length;
    reportUnknownProperties(value, IgnoredProperties, at, problems);
    const target: Ref | undefined = readRef(value.target, refs, `${at}.target`, problems);
    const reason: unknown = value.reason;
    if (typeof(reason) !== "string" || !(IgnoredReasons as readonly string[]).includes(reason)) {
        problems.push(`${at}.reason is not an ignored reason`);
    }
    const revisitIf: unknown = value.revisit_if;
    if (typeof(revisitIf) !== "string" || revisitIf.trim().length === 0) {
        problems.push(`${at}.revisit_if is empty`);
    }
    if (problems.length !== problemCount || target === (void 0)) {
        return (void 0);
    }
    return { target, reason: reason as Ignored["reason"], revisit_if: revisitIf as string };
};

/**
 * Validate an impasse marker and return a fresh copy.
 */
const readImpasse: (value: unknown, at: string, problems: string[]) => Impasse | undefined = (
    value: unknown,
    at: string,
    problems: string[],
): Impasse | undefined => {
    if (!isPlainRecord(value)) {
        problems.push(`${at} must be an object`);
        return (void 0);
    }
    const problemCount: number = problems.length;
    reportUnknownProperties(value, ImpasseProperties, at, problems);
    const state: unknown = value.state;
    if (typeof(state) !== "string" || !(ImpasseStates as readonly string[]).includes(state)) {
        problems.push(`${at}.state is not an impasse state`);
    }
    const detail: unknown = value.detail;
    if (detail !== (void 0) && typeof(detail) !== "string") {
        problems.push(`${at}.detail must be a string`);
    }
    if (problems.length !== problemCount) {
        return (void 0);
    }
    const impasse: Impasse = { state: state as Impasse["state"] };
    if (detail !== (void 0)) {
        impasse.detail = detail as string;
    }
    return impasse;
};

/**
 * Validate a draft and return the only frame it permits.
 *
 * @throws BoundaryRejection `invalid_frame` with every problem found.
 */
const buildFrame: FrameBoundaryBuilder = (draft: FrameDraft, refs: RefTable, options: FrameBoundaryOptions = {}): FrameBoundaryResult => {
    if (!isPlainRecord(draft)) {
        throw new BoundaryRejection("invalid_frame", ["draft must be an object"]);
    }
    if (!isRefTable(refs)) {
        throw new BoundaryRejection("invalid_frame", ["refs must be a RefTable"]);
    }
    if (!isRecord(options)) {
        throw new BoundaryRejection("invalid_frame", ["options must be an object"]);
    }

    const problems: string[] = [];
    const source: Record<string, unknown> = draft as unknown as Record<string, unknown>;
    const optionRecord: Record<string, unknown> = options as unknown as Record<string, unknown>;

    reportUnknownProperties(source, FrameProperties, "", problems);

    const id: unknown = source.id;
    if (!isId(id)) {
        problems.push("id is not a valid AMP id");
    }
    const agent: unknown = source.agent;
    if (!isId(agent)) {
        problems.push("agent is not a valid AMP id");
    }
    const cycle: unknown = source.cycle;
    if (typeof(cycle) !== "number" || !Number.isSafeInteger(cycle) || cycle < 0) {
        problems.push("cycle must be a non-negative integer");
    }
    const mode: unknown = source.mode;
    if (typeof(mode) !== "string" || !(FrameModes as readonly string[]).includes(mode)) {
        problems.push("mode is not a frame mode");
    }

    const clock: unknown = optionRecord.now;
    let ts: unknown;
    if (Object.hasOwn(source, "ts")) {
        ts = source.ts;
        if (typeof(ts) !== "string" || !isDateTime(ts)) {
            problems.push("ts is not a date-time");
        }
    } else if (clock === (void 0)) {
        ts = new Date().toISOString();
        if (typeof(ts) !== "string" || !isDateTime(ts)) {
            problems.push("ts is not a date-time");
        }
    } else if (typeof(clock) !== "function") {
        ts = (void 0);
        problems.push("now must be a function");
    } else {
        try {
            ts = (clock as () => Timestamp)();
        } catch {
            ts = (void 0);
        }
        if (typeof(ts) !== "string" || !isDateTime(ts)) {
            problems.push("ts is not a date-time");
        }
    }

    const requestedMaxSlots: unknown = optionRecord.maxSlots === (void 0) ? SchemaMaxSlots : optionRecord.maxSlots;
    const maxSlotsValid: boolean =
        typeof(requestedMaxSlots) === "number" && Number.isInteger(requestedMaxSlots) && requestedMaxSlots >= 0 && requestedMaxSlots <= SchemaMaxSlots;
    if (!maxSlotsValid) {
        problems.push(`maxSlots must be an integer in [0,${SchemaMaxSlots}]`);
    }
    const maxSlots: number = maxSlotsValid ? (requestedMaxSlots as number) : SchemaMaxSlots;

    const requestedMaxIgnored: unknown = optionRecord.maxIgnored === (void 0) ? DefaultMaxIgnored : optionRecord.maxIgnored;
    const maxIgnoredValid: boolean =
        typeof(requestedMaxIgnored) === "number" &&
        Number.isInteger(requestedMaxIgnored) &&
        requestedMaxIgnored >= 0 &&
        requestedMaxIgnored <= DefaultMaxIgnored;
    if (!maxIgnoredValid) {
        problems.push(`maxIgnored must be an integer in [0,${DefaultMaxIgnored}]`);
    }
    const maxIgnored: number = maxIgnoredValid ? (requestedMaxIgnored as number) : DefaultMaxIgnored;

    const rebuiltSlots: Slot[] = [];
    const declaredSlots: unknown = source.slots;
    if (!Array.isArray(declaredSlots)) {
        problems.push("slots must be an array");
    } else {
        if (declaredSlots.length > maxSlots) {
            problems.push(`slots has ${declaredSlots.length} entries, max is ${maxSlots}`);
        }
        for (let index: number = 0; index < declaredSlots.length; index += 1) {
            const rebuilt: Slot | undefined = readSlot(declaredSlots[index], refs, `slots[${index}]`, problems);
            if (rebuilt !== (void 0)) {
                rebuiltSlots.push(rebuilt);
            }
        }
    }

    const rebuiltIgnored: Ignored[] = [];
    const declaredIgnored: unknown = source.ignored;
    if (declaredIgnored !== (void 0)) {
        if (!Array.isArray(declaredIgnored)) {
            problems.push("ignored must be an array");
        } else {
            for (let index: number = 0; index < declaredIgnored.length; index += 1) {
                const rebuilt: Ignored | undefined = readIgnored(declaredIgnored[index], refs, `ignored[${index}]`, problems);
                if (rebuilt !== (void 0)) {
                    rebuiltIgnored.push(rebuilt);
                }
            }
        }
    }

    let frameBudget: FrameBudget | undefined;
    const declaredBudget: unknown = source.budget;
    if (!isPlainRecord(declaredBudget)) {
        problems.push("budget must be an object");
    } else {
        reportUnknownProperties(declaredBudget, FrameBudgetProperties, "budget", problems);
        const allocated: Budget | undefined = readBudget(declaredBudget.allocated, "budget.allocated", problems);
        const spent: Budget | undefined = readBudget(declaredBudget.spent, "budget.spent", problems);
        if (allocated !== (void 0) && spent !== (void 0)) {
            if (Object.keys(allocated).length === 0) {
                problems.push("budget.allocated must set at least one dimension");
            }
            const spentKeys: string[] = Object.keys(spent);
            for (let index: number = 0; index < spentKeys.length; index += 1) {
                const key: string = spentKeys[index];
                if (!Object.hasOwn(allocated, key)) {
                    problems.push(`budget.spent.${key} is not declared in budget.allocated`);
                    continue;
                }
                const limit: unknown = allocated[key as keyof Budget];
                const used: unknown = spent[key as keyof Budget];
                if (typeof(limit) === "number" && typeof(used) === "number" && used > limit) {
                    problems.push(`budget.spent.${key} exceeds budget.allocated.${key}`);
                }
            }
            frameBudget = { allocated, spent };
        }
    }

    let parent: Ref | undefined;
    const declaredParent: unknown = source.parent;
    if (declaredParent !== (void 0)) {
        parent = readRef(declaredParent, refs, "parent", problems);
    }
    let goal: Ref | undefined;
    const declaredGoal: unknown = source.goal;
    if (declaredGoal !== (void 0)) {
        goal = readRef(declaredGoal, refs, "goal", problems);
    }

    const rebuiltQuestions: Ref[] = [];
    const declaredQuestions: unknown = source.open_questions;
    if (declaredQuestions !== (void 0)) {
        if (!Array.isArray(declaredQuestions)) {
            problems.push("open_questions must be an array");
        } else {
            for (let index: number = 0; index < declaredQuestions.length; index += 1) {
                const rebuilt: Ref | undefined = readRef(declaredQuestions[index], refs, `open_questions[${index}]`, problems);
                if (rebuilt !== (void 0)) {
                    rebuiltQuestions.push(rebuilt);
                }
            }
        }
    }

    let impasse: Impasse | undefined;
    const declaredImpasse: unknown = source.impasse;
    if (declaredImpasse !== (void 0)) {
        impasse = readImpasse(declaredImpasse, "impasse", problems);
    }

    const declaredNote: unknown = source.note;
    if (declaredNote !== (void 0) && typeof(declaredNote) !== "string") {
        problems.push("note must be a string");
    }

    if (problems.length > 0) {
        throw new BoundaryRejection("invalid_frame", problems);
    }

    const visible: Ignored[] = rebuiltIgnored.slice(0, maxIgnored);
    const deferred: Ignored[] = rebuiltIgnored.slice(maxIgnored);
    const body: Omit<Frame, "digest"> = {
        amp: "0.1",
        kind: "frame",
        id: id as Id,
        agent: agent as Id,
        cycle: cycle as number,
        ts: ts as Timestamp,
        mode: mode as FrameMode,
        slots: rebuiltSlots,
        budget: frameBudget as FrameBudget,
    };
    if (parent !== (void 0)) {
        body.parent = parent;
    }
    if (goal !== (void 0)) {
        body.goal = goal;
    }
    if (visible.length > 0) {
        body.ignored = visible;
    }
    if (declaredQuestions !== (void 0)) {
        body.open_questions = rebuiltQuestions;
    }
    if (impasse !== (void 0)) {
        body.impasse = impasse;
    }
    if (declaredNote !== (void 0)) {
        body.note = declaredNote as string;
    }

    const frame: Frame = { ...body, digest: digestOf(body) };
    deepFreezeJson(frame);
    deepFreezeJson(deferred);
    return { frame, deferred };
};

/**
 * Public entry point. A revoked `Proxy`, a throwing getter or an exotic
 * `refs` object can still throw while the draft is inspected; the boundary
 * contract is that callers only ever see `BoundaryRejection`.
 */
export const frameFrom: FrameBoundaryBuilder = (draft: FrameDraft, refs: RefTable, options: FrameBoundaryOptions = {}): FrameBoundaryResult => {
    try {
        return buildFrame(draft, refs, options);
    } catch (error: unknown) {
        if (error instanceof BoundaryRejection) {
            throw error;
        }
        const reason: string = error instanceof Error ? error.message : typeof(error);
        throw new BoundaryRejection("invalid_frame", [`draft could not be inspected: ${reason}`]);
    }
};
