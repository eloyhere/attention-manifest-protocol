/**
 * Frame boundary: the only place a `Frame` may be constructed.
 *
 * The reference runtime builds frames from object literals, so a frame can
 * currently cite a target that does not exist, omit a reason, or carry an
 * unbounded exclusion list. This module turns those into rejections and returns
 * the part of the exclusion list that does not fit as `deferred`, so nothing is
 * silently dropped.
 *
 * The frame is not extended with new fields: `frame.schema.json` sets
 * `additionalProperties: false`, so aggregates belong to a later capacity layer,
 * not to this object.
 */
import type { Id, Ref, Timestamp } from "../types/common.ts";
import type { Frame, FrameBudget, FrameMode, Ignored, Impasse, Slot } from "../frame/frame.ts";

import { digestOf } from "../semantic/canonical.ts";
import { isId } from "./ids.ts";
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
     * Visible exclusions kept on the frame; the rest is returned as `deferred`. Defaults to 50.
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
const FrameModes: readonly FrameMode[] = ["explore", "exploit", "triage", "reflect", "rest"];
const SlotRoles: readonly Slot["role"][] = ["goal", "question", "evidence", "concept", "process", "tool", "memory", "self", "other", "threat", "artifact"];
const SlotStates: readonly Slot["state"][] = ["active", "released", "evicted", "done"];
const IgnoredReasons: readonly Ignored["reason"][] = ["low_voi", "out_of_scope", "untrusted", "budget", "blocked", "habituated", "deferred"];
const ImpasseStates: readonly Impasse["state"][] = ["TIE", "STUCK", "STALLED", "CONFLICT", "INFEASIBLE", "UNKNOWN", "UNVERIFIED", "DRIFT", "BUDGET"];
const Tiers: readonly NonNullable<Slot["tier"]>[] = ["T0", "T1", "T2", "T3", "T4"];

type ProblemChecker = (value: unknown, at: string, problems: string[]) => void;

type RefTableChecker = (value: unknown, refs: RefTable, at: string, problems: string[]) => void;

type FrameBoundaryBuilder = (draft: FrameDraft, refs: RefTable, options?: FrameBoundaryOptions) => FrameBoundaryResult;

const isRecord: (value: unknown) => value is Record<string, unknown> = (value: unknown): value is Record<string, unknown> =>
    typeof(value) === "object" && value !== null && !Array.isArray(value);

const checkBudget: ProblemChecker = (value: unknown, at: string, problems: string[]): void => {
    if (!isRecord(value)) {
        problems.push(`${at} must be an object`);
        return;
    }
    const budgetKeys: string[] = Object.keys(value);
    for (let keyIndex: number = 0; keyIndex < budgetKeys.length; keyIndex += 1) {
        const key: string = budgetKeys[keyIndex];
        const amount: unknown = value[key];
        if (!BudgetDimensions.includes(key)) {
            problems.push(`${at}.${key} is not a budget dimension`);
            continue;
        }
        if (typeof(amount) !== "number" || !Number.isFinite(amount) || amount < 0) {
            problems.push(`${at}.${key} must be a non-negative finite number`);
            continue;
        }
        if (key !== "money" && !Number.isInteger(amount)) {
            problems.push(`${at}.${key} must be an integer`);
        }
    }
};

const checkRef: RefTableChecker = (value: unknown, refs: RefTable, at: string, problems: string[]): void => {
    if (!isRecord(value)) {
        problems.push(`${at} must be a Ref object`);
        return;
    }
    if (typeof(value.kind) !== "string" || !isId(value.id)) {
        problems.push(`${at} must have a string kind and a valid id`);
        return;
    }
    if (!refs.has(value as unknown as Ref)) {
        const problem: string | undefined = refs.check(value as unknown as Ref);
        if (problem !== (void 0)) {
            problems.push(`${at} ${problem}`);
        }
    }
};

const checkSlot: RefTableChecker = (value: unknown, refs: RefTable, at: string, problems: string[]): void => {
    if (!isRecord(value)) {
        problems.push(`${at} must be an object`);
        return;
    }
    checkRef(value.target, refs, `${at}.target`, problems);
    if (typeof(value.role) !== "string" || !SlotRoles.includes(value.role as Slot["role"])) {
        problems.push(`${at}.role is not a slot role`);
    }
    const salience: unknown = value.salience;
    if (typeof(salience) !== "number" || salience < 0 || salience > 1) {
        problems.push(`${at}.salience must be in [0,1]`);
    }
    if (typeof(value.why) !== "string" || value.why.trim().length === 0) {
        problems.push(`${at}.why is empty`);
    }
    checkBudget(value.cost, `${at}.cost`, problems);
    if (typeof(value.state) !== "string" || !SlotStates.includes(value.state as Slot["state"])) {
        problems.push(`${at}.state is not a slot state`);
    }
    if (value.tier !== (void 0) && (typeof(value.tier) !== "string" || !Tiers.includes(value.tier as NonNullable<Slot["tier"]>))) {
        problems.push(`${at}.tier is not a tier`);
    }
    const voi: unknown = value.voi;
    if (voi !== (void 0) && (typeof(voi) !== "number" || voi < 0 || voi > 1)) {
        problems.push(`${at}.voi must be in [0,1]`);
    }
    if (value.budget !== (void 0)) {
        checkBudget(value.budget, `${at}.budget`, problems);
    }
    const ttlTurns: unknown = value.ttl_turns;
    if (ttlTurns !== (void 0) && (typeof(ttlTurns) !== "number" || !Number.isInteger(ttlTurns) || ttlTurns < 0)) {
        problems.push(`${at}.ttl_turns must be a non-negative integer`);
    }
};

const checkIgnored: RefTableChecker = (value: unknown, refs: RefTable, at: string, problems: string[]): void => {
    if (!isRecord(value)) {
        problems.push(`${at} must be an object`);
        return;
    }
    checkRef(value.target, refs, `${at}.target`, problems);
    if (typeof(value.reason) !== "string" || !IgnoredReasons.includes(value.reason as Ignored["reason"])) {
        problems.push(`${at}.reason is not an ignored reason`);
    }
    if (typeof(value.revisit_if) !== "string" || value.revisit_if.trim().length === 0) {
        problems.push(`${at}.revisit_if is empty`);
    }
};

const checkImpasse: ProblemChecker = (value: unknown, at: string, problems: string[]): void => {
    if (!isRecord(value)) {
        problems.push(`${at} must be an object`);
        return;
    }
    if (typeof(value.state) !== "string" || !ImpasseStates.includes(value.state as Impasse["state"])) {
        problems.push(`${at}.state is not an impasse state`);
    }
    if (value.detail !== (void 0) && typeof(value.detail) !== "string") {
        problems.push(`${at}.detail must be a string`);
    }
};

/**
 * Validate a draft and return the only frame it permits.
 *
 * @throws BoundaryRejection `invalid_frame` with every problem found.
 */
export const frameFrom: FrameBoundaryBuilder = (draft: FrameDraft, refs: RefTable, options: FrameBoundaryOptions = {}): FrameBoundaryResult => {
    const problems: string[] = [];

    if (!isId(draft.id)) {
        problems.push("id is not a valid AMP id");
    }
    if (!isId(draft.agent)) {
        problems.push("agent is not a valid AMP id");
    }
    if (!Number.isSafeInteger(draft.cycle) || draft.cycle < 0) {
        problems.push("cycle must be a non-negative integer");
    }
    if (!FrameModes.includes(draft.mode)) {
        problems.push("mode is not a frame mode");
    }

    const ts: Timestamp = draft.ts ?? (options.now ? options.now() : new Date().toISOString());
    if (typeof(ts) !== "string" || Number.isNaN(Date.parse(ts))) {
        problems.push("ts is not a date-time");
    }

    const requestedMaxSlots: number = options.maxSlots ?? SchemaMaxSlots;
    if (!Number.isInteger(requestedMaxSlots) || requestedMaxSlots < 0 || requestedMaxSlots > SchemaMaxSlots) {
        problems.push(`maxSlots must be an integer in [0,${SchemaMaxSlots}]`);
    }
    const maxSlots: number = Math.min(Math.max(0, requestedMaxSlots), SchemaMaxSlots);

    const requestedMaxIgnored: number = options.maxIgnored ?? DefaultMaxIgnored;
    if (!Number.isInteger(requestedMaxIgnored) || requestedMaxIgnored < 0) {
        problems.push("maxIgnored must be a non-negative integer");
    }
    const maxIgnored: number = Math.max(0, requestedMaxIgnored);

    if (!Array.isArray(draft.slots)) {
        problems.push("slots must be an array");
    } else {
        if (draft.slots.length > maxSlots) {
            problems.push(`slots has ${draft.slots.length} entries, max is ${maxSlots}`);
        }
        draft.slots.forEach((slot, index) => checkSlot(slot, refs, `slots[${index}]`, problems));
    }

    const declaredIgnored: unknown = draft.ignored;
    const ignored: Ignored[] = Array.isArray(declaredIgnored) ? declaredIgnored : [];
    if (declaredIgnored !== (void 0) && !Array.isArray(declaredIgnored)) {
        problems.push("ignored must be an array");
    }
    ignored.forEach((item, index) => checkIgnored(item, refs, `ignored[${index}]`, problems));

    const budgetValue: unknown = draft.budget;
    if (!isRecord(budgetValue)) {
        problems.push("budget must be an object");
    } else {
        const allocated: unknown = budgetValue.allocated;
        const spent: unknown = budgetValue.spent;
        checkBudget(allocated, "budget.allocated", problems);
        checkBudget(spent, "budget.spent", problems);
        if (isRecord(allocated) && isRecord(spent)) {
            if (Object.keys(allocated).length === 0) {
                problems.push("budget.allocated must set at least one dimension");
            }
            for (let dimensionIndex: number = 0; dimensionIndex < BudgetDimensions.length; dimensionIndex += 1) {
                const key: string = BudgetDimensions[dimensionIndex];
                const limit: unknown = allocated[key];
                const used: unknown = spent[key];
                if (typeof(limit) === "number" && typeof(used) === "number" && used > limit) {
                    problems.push(`budget.spent.${key} exceeds budget.allocated.${key}`);
                }
            }
        }
    }

    if (draft.parent !== (void 0)) {
        checkRef(draft.parent, refs, "parent", problems);
    }
    if (draft.goal !== (void 0)) {
        checkRef(draft.goal, refs, "goal", problems);
    }
    if (draft.open_questions !== (void 0)) {
        if (!Array.isArray(draft.open_questions)) {
            problems.push("open_questions must be an array");
        } else {
            draft.open_questions.forEach((ref, index) => checkRef(ref, refs, `open_questions[${index}]`, problems));
        }
    }
    if (draft.impasse !== (void 0)) {
        checkImpasse(draft.impasse, "impasse", problems);
    }
    if (draft.note !== (void 0) && typeof(draft.note) !== "string") {
        problems.push("note must be a string");
    }

    if (problems.length > 0) {
        throw new BoundaryRejection("invalid_frame", problems);
    }

    const visible: Ignored[] = ignored.slice(0, maxIgnored);
    const deferred: Ignored[] = ignored.slice(maxIgnored);
    const body: Omit<Frame, "digest"> = {
        amp: "0.1",
        kind: "frame",
        id: draft.id,
        agent: draft.agent,
        cycle: draft.cycle,
        ts,
        mode: draft.mode,
        slots: [...draft.slots],
        budget: { allocated: { ...draft.budget.allocated }, spent: { ...draft.budget.spent } },
    };
    if (draft.parent !== (void 0)) {
        body.parent = draft.parent;
    }
    if (draft.goal !== (void 0)) {
        body.goal = draft.goal;
    }
    if (visible.length > 0) {
        body.ignored = visible;
    }
    if (draft.open_questions !== (void 0)) {
        body.open_questions = [...draft.open_questions];
    }
    if (draft.impasse !== (void 0)) {
        body.impasse = draft.impasse;
    }
    if (draft.note !== (void 0)) {
        body.note = draft.note;
    }

    const frame: Frame = { ...body, digest: digestOf(body) };
    return { frame, deferred };
};
