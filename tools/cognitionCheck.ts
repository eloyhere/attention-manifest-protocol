#!/usr/bin/env node
/**
 * Cognitive state model — checks and a falsifiable demonstration.
 *
 * Two jobs, in this order:
 *
 * 1. **Contract checks.** The state estimators and the salience law must obey
 *    the monotonicity claims the proposal makes, on synthetic inputs where the
 *    right answer is known by construction.
 * 2. **A demonstration on a synthetic trace.** The same candidate pool is given
 *    to the current allocator (`attention.ts`) and to the cognitive allocator
 *    (`cognition.ts`), and the two are scored against hidden ground truth that
 *    neither allocator can see.
 *
 * The demonstration is deliberately small and deterministic. It is evidence
 * that the model is *computable and falsifiable*, not evidence that it improves
 * a real agent. The numbers below are properties of the simulation.
 */
import assert from "node:assert/strict";

import { selectFocus, type Candidate, type Selection } from "../src/attention/attention.ts";
import {
    CognitiveLaws,
    estimateCognitiveState,
    historyFactor,
    selectFromState,
    salienceFromState,
    type CandidateHistory,
    type CognitiveCandidate,
    type CognitiveIgnored,
    type CognitiveSelection,
    type CognitiveState,
} from "../src/attention/cognition.ts";
import type { Frame, FrameMode, Ignored, IgnoredReason, Slot } from "../src/frame/frame.ts";
import type { Receipt } from "../src/receipt/receipt.ts";
import type { Ref } from "../src/types/common.ts";

let Passed: number = 0;
let Failed: number = 0;

type TestCase = (name: string, fn: () => void) => void;

const test: TestCase = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        Failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

/**
 * Fixtures.
 */

const at: (cycle: number) => string = (cycle: number): string => new Date(Date.UTC(2026, 9, 24, 1, 0, cycle)).toISOString();

const ref: (kind: string, id: string) => Ref = (kind: string, id: string): Ref => ({ kind, id }) as Ref;

type SlotFactory = (target: Ref, role: Slot["role"], extras?: Partial<Slot>) => Slot;

const slot: SlotFactory = (target: Ref, role: Slot["role"], extras: Partial<Slot> = {}): Slot => ({
    target,
    role,
    salience: 0.5,
    cost: { tokens: 100 },
    why: "fixture",
    state: "active",
    ...extras,
});

type FrameFactory = (cycle: number, mode: FrameMode, slots: Slot[], ignored?: Frame["ignored"]) => Frame;

const frame: FrameFactory = (cycle: number, mode: FrameMode, slots: Slot[], ignored: Frame["ignored"] = []): Frame => {
    return {
        amp: "0.1",
        kind: "frame",
        id: `f.${cycle}`,
        agent: "a.sim",
        cycle,
        ts: at(cycle),
        digest: "sha256:fixture",
        mode,
        slots,
        ignored,
        budget: { allocated: { tokens: 2000 }, spent: { tokens: 0 } },
    };
};

type ReceiptFactory = (cycle: number, index: number, outcome: Receipt["outcome"]) => Receipt;

const receipt: ReceiptFactory = (cycle: number, index: number, outcome: Receipt["outcome"]): Receipt => {
    return {
        amp: "0.1",
        kind: "receipt",
        id: `rc.${cycle}.${index}`,
        op: "attend",
        target: ref("tool", `t.${cycle}.${index}`),
        at: at(cycle),
        usage: { tokens: 100 },
        outcome,
    };
};

const BaseState: CognitiveState = {
    load: 0.5,
    vigilance: 0.9,
    arousal: 0.2,
    mastery: 0.6,
    accountability: 0,
    cyclesSinceRest: 1,
    capacityEff: 4,
    pLapse: 0.1,
    dominantRole: "question",
    source: "default",
    samples: 0,
};

const BaseCandidate: CognitiveCandidate = {
    target: ref("unknown", "u.1"),
    role: "question",
    voi: 0.6,
    goalFit: 0.7,
    uncertainty: 0.5,
    novelty: 0.4,
    costTokens: 400,
    risk: 0.1,
    trustCap: 1,
    why: "fixture",
};

type MonotonicityCheck = (candidate: CognitiveCandidate, state: CognitiveState) => boolean;

type SalienceProbe = (over?: Partial<CognitiveCandidate>, stateOver?: Partial<CognitiveState>) => number;

type CognitiveLaw = {
    value: number;
    status: "measured" | "convention";
    source: string;
};

const respectsAll: MonotonicityCheck = (candidate: CognitiveCandidate, state: CognitiveState): boolean => {
    const value: SalienceProbe = (over: Partial<CognitiveCandidate> = {}, stateOver: Partial<CognitiveState> = {}): number =>
        salienceFromState({ ...candidate, ...over }, { ...state, ...stateOver });
    const reference: number = value();
    return [
        value({ voi: 1 }) >= reference,
        value({ costTokens: 1900 }) <= reference,
        value({ risk: 1 }) <= reference,
        value({ trustCap: 0.2 }) <= reference,
        value({ history: { realized: 1 } }) >= reference,
        value({ history: { lastIgnoredAge: 0 } }) <= reference,
        value({ hardFloor: 1 }) >= reference,
        value({ switchCostTokens: 2000 }) <= reference,
        value({}, { arousal: 1 }) <= reference,
        value({}, { load: 0 }) <= reference,
    ].every((ok) => ok);
};

/**
 * Contract.
 */

test("state: rest resets vigilance and the lapse probability", () => {
    const frames: Frame[] = [frame(0, "triage", [slot(ref("unknown", "u.1"), "question")]), frame(1, "rest", []), frame(2, "triage", [])];
    const state: CognitiveState = estimateCognitiveState({ frames, receipts: [] });
    assert.equal(state.cyclesSinceRest, 1);
    assert.equal(state.source, "default");
    assert.ok(state.vigilance > 0.9, `vigilance should be near 1 right after rest, got ${state.vigilance}`);
});

test("state: vigilance decays with time on task", () => {
    const frames: Frame[] = Array.from({ length: 40 }, (unused, index) => frame(index, "exploit", []));
    const state: CognitiveState = estimateCognitiveState({ frames, receipts: [] });
    assert.equal(state.cyclesSinceRest, 40);
    assert.ok(state.vigilance < 0.1, `vigilance should be decayed at 40 cycles, got ${state.vigilance}`);
    assert.ok(state.pLapse > 0.9, `pLapse should be high at 40 cycles, got ${state.pLapse}`);
});

test("state: load rises with chunks occupied and shrinks effective capacity", () => {
    const light: Frame[] = [frame(0, "triage", [slot(ref("unknown", "u.1"), "question")])];
    const heavy: Frame[] = [
        frame(0, "triage", [
            slot(ref("unknown", "u.1"), "question"),
            slot(ref("unknown", "u.2"), "question"),
            slot(ref("unknown", "u.3"), "question"),
            slot(ref("unknown", "u.4"), "question"),
        ]),
    ];
    const lightState: CognitiveState = estimateCognitiveState({ frames: light, receipts: [] });
    const heavyState: CognitiveState = estimateCognitiveState({ frames: heavy, receipts: [] });
    assert.ok(heavyState.load > lightState.load, "more chunks must mean more load");
    assert.ok(heavyState.capacityEff <= lightState.capacityEff, "load must not increase capacity");
    assert.ok(heavyState.capacityEff >= 1, "capacity never falls below one chunk");
});

test("state: arousal tracks recent error pressure, mastery tracks the long run", () => {
    const receipts: Receipt[] = [receipt(0, 0, "failure"), receipt(0, 1, "failure"), receipt(0, 2, "success"), receipt(0, 3, "success")];
    const state: CognitiveState = estimateCognitiveState({ frames: [], receipts });
    assert.ok(state.arousal > 0.3 && state.arousal < 0.5, `expected mid arousal, got ${state.arousal}`);
    assert.equal(state.mastery, 0.5);
    assert.equal(state.source, "default");
    const many: Receipt[] = Array.from({ length: 30 }, (unused, index) => receipt(0, index, "success"));
    assert.equal(estimateCognitiveState({ frames: [], receipts: many }).source, "measured");
});

test("contract: ten monotonicity claims hold across a state grid", () => {
    const states: CognitiveState[] = [];
    const loads: number[] = [0, 0.25, 0.6, 1];
    const arousals: number[] = [0, 0.5, 1];
    const lapses: number[] = [0, 0.9];
    for (let i: number = 0; i < loads.length; i += 1) {
        const load: number = loads[i];
        for (let j: number = 0; j < arousals.length; j += 1) {
            const arousal: number = arousals[j];
            for (let k: number = 0; k < lapses.length; k += 1) {
                const pLapse: number = lapses[k];
                states.push({ ...BaseState, load, arousal, pLapse });
            }
        }
    }
    for (let i: number = 0; i < states.length; i += 1) {
        const state: CognitiveState = states[i];
        assert.ok(respectsAll(BaseCandidate, state), `contract violated at load=${state.load} arousal=${state.arousal}`);
    }
});

test("history: value learning and inhibition of return have opposite signs", () => {
    const neutral: number = historyFactor(undefined);
    assert.equal(neutral, 1);
    assert.ok(historyFactor({ realized: 1 }) > neutral, "a class that paid off must gain priority");
    assert.ok(historyFactor({ realized: 0 }) < neutral, "a class that never paid off must lose priority");
    assert.ok(historyFactor({ lastIgnoredAge: 0 }) < historyFactor({ lastIgnoredAge: 10 }), "inhibition must decay with age");
});

test("floors: an off-goal hazard is excluded without a floor and kept with one", () => {
    const hazard: CognitiveCandidate = { ...BaseCandidate, target: ref("threat", "x.1"), role: "threat", voi: 1, goalFit: 0.05, risk: 0.1 };
    const withoutFloor: CognitiveSelection = selectFromState([hazard], BaseState, { budgetTokens: 2000 });
    assert.equal(withoutFloor.slots.length, 0, "the multiplicative score is expected to drop an off-goal hazard");
    assert.equal(withoutFloor.ignored[0].reason, "low_voi");

    const withFloor: CognitiveSelection = selectFromState([{ ...hazard, hardFloor: 0.9 }], BaseState, { budgetTokens: 2000 });
    assert.equal(withFloor.slots.length, 1, "a floor must survive the multiplicative score");
    assert.ok(withFloor.slots[0].salience >= 0.9);
});

test("floors: a floor that cannot be placed is INFEASIBLE, never low_voi", () => {
    const hazard: CognitiveCandidate = { ...BaseCandidate, target: ref("threat", "x.1"), voi: 1, goalFit: 0.05, hardFloor: 0.9, chunkWeight: 3 };
    const selection: CognitiveSelection = selectFromState([hazard], BaseState, { budgetTokens: 2000, capacity: 2 });
    assert.equal(selection.impasse, "INFEASIBLE");
    assert.ok(selection.ignored.every((item) => item.reason !== "low_voi"));
});

test("capacity: overflow is attributable, and chunks are the unit", () => {
    const candidates: CognitiveCandidate[] = Array.from({ length: 6 }, (unused, index) => ({
        ...BaseCandidate,
        target: ref("unknown", `u.${index}`),
        chunkWeight: 2,
    }));
    const selection: CognitiveSelection = selectFromState(candidates, BaseState, { budgetTokens: 100000, capacity: 4 });
    assert.equal(selection.capacityUsed, 4);
    assert.equal(selection.slots.length, 2);
    assert.equal(selection.ignored.filter((item) => item.reason === "capacity").length, 4);
});

test("reasons: a recently excluded target is inhibited, not low-value", () => {
    const stale: CognitiveCandidate = { ...BaseCandidate, goalFit: 0.1, history: { lastIgnoredAge: 0 } };
    const selection: CognitiveSelection = selectFromState([stale], BaseState, { budgetTokens: 2000 });
    assert.equal(selection.slots.length, 0);
    assert.equal(selection.ignored[0].reason, "inhibited");
});

test("parameters: every law constant declares its evidential status", () => {
    const laws: [string, CognitiveLaw][] = Object.entries(CognitiveLaws);
    for (let i: number = 0; i < laws.length; i += 1) {
        const name: string = laws[i][0];
        const law: CognitiveLaw = laws[i][1];
        assert.ok(law.status === "measured" || law.status === "convention", `${name} must declare a status`);
        assert.ok(law.source.length > 0, `${name} must cite a source`);
        assert.ok(Number.isFinite(law.value), `${name} must be finite`);
    }
});

/**
 * Demonstration.
 */

type Kind = "goal" | "distractor" | "stale" | "safety";

interface Spec {
    key: string;
    kind: Kind;
    cost: number;
    /**
     * Hidden ground truth: realised value if selected. Neither engine can see it.
     */
    truth: number;
}

type Profile = {
    voi: number;
    goalFit: number;
    novelty: number;
    uncertainty: number;
    risk: number;
    role: Slot["role"];
    floor: number;
};

const PROFILE: Record<Kind, Profile> = {
    goal: { voi: 0.8, goalFit: 0.9, novelty: 0.4, uncertainty: 0.5, risk: 0.05, role: "question", floor: 0 },
    distractor: { voi: 0.9, goalFit: 0.55, novelty: 0.9, uncertainty: 0.5, risk: 0.02, role: "memory", floor: 0 },
    stale: { voi: 0.55, goalFit: 0.6, novelty: 0.5, uncertainty: 0.4, risk: 0.02, role: "memory", floor: 0 },
    safety: { voi: 1, goalFit: 0.05, novelty: 0.7, uncertainty: 0.8, risk: 0.1, role: "threat", floor: 0.9 },
};

const CYCLES: number = 24;
const BUDGET: number = 2000;
const SafetyCycles: Set<number> = new Set([7, 18]);

/**
 * Project a proposed ignore reason onto the current schema. `frame.schema.json`
 * does not yet enumerate the new reasons, so the demo records its frames with
 * the closest existing value rather than widening a normative enum.
 */
const toFrameReason: (reason: string) => IgnoredReason = (reason: string): IgnoredReason => {
    if (reason === "capacity" || reason === "budget" || reason === "deferred") {
        return "budget";
    }
    if (reason === "inhibited" || reason === "habituated") {
        return "habituated";
    }
    return "low_voi";
};

type PoolFactory = (cycle: number, hazardValue?: number) => Spec[];

const poolFor: PoolFactory = (cycle: number, hazardValue: number = 1): Spec[] => {
    const pool: Spec[] = [];
    for (let index: number = 0; index < 4; index += 1) {
        pool.push({ key: `g.${cycle}.${index}`, kind: "goal", cost: 400, truth: 0.8 });
    }
    pool.push({ key: `d.${cycle}`, kind: "distractor", cost: 120, truth: 0 });
    pool.push({ key: "s.1", kind: "stale", cost: 150, truth: 0 });
    if (SafetyCycles.has(cycle)) {
        pool.push({ key: `x.${cycle}`, kind: "safety", cost: 300, truth: hazardValue });
    }
    return pool;
};

interface Tally {
    tokens: number;
    value: number;
    wasted: number;
    harm: number;
    repeats: number;
    /**
     * Per-kind selection counts, keyed by class rather than by target.
     */
    samples: Map<Kind, number>;
    reasons: Map<string, number>;
    valueOnSafety: number;
    valueOffSafety: number;
    safetyCycles: number;
    plainCycles: number;
}

const emptyTally: () => Tally = (): Tally => ({
    tokens: 0,
    value: 0,
    wasted: 0,
    harm: 0,
    repeats: 0,
    samples: new Map(),
    reasons: new Map(),
    valueOnSafety: 0,
    valueOffSafety: 0,
    safetyCycles: 0,
    plainCycles: 0,
});

type Accountant = (tally: Tally, spec: Spec, tokens: number, cycle: number) => void;

const account: Accountant = (tally: Tally, spec: Spec, tokens: number, cycle: number): void => {
    tally.tokens += tokens;
    tally.value += spec.truth;
    if (spec.truth === 0) {
        tally.wasted += tokens;
        const seen: number = tally.samples.get(spec.kind) ?? 0;
        if (seen > 0) {
            tally.repeats += 1;
        }
    }
    tally.samples.set(spec.kind, (tally.samples.get(spec.kind) ?? 0) + 1);
    if (SafetyCycles.has(cycle)) {
        tally.valueOnSafety += spec.truth;
    } else {
        tally.valueOffSafety += spec.truth;
    }
};

/**
 * Baseline: today's stateless allocator, with no history and no floors.
 */
const runBaseline: () => Tally = (): Tally => {
    const tally: Tally = emptyTally();
    for (let cycle: number = 0; cycle < CYCLES; cycle += 1) {
        const pool: Spec[] = poolFor(cycle);
        const candidates: Candidate[] = pool.map((spec) => {
            const profile: Profile = PROFILE[spec.kind];
            return {
                target: ref(spec.kind === "safety" ? "threat" : "unknown", spec.key),
                role: profile.role,
                voi: profile.voi,
                goalFit: profile.goalFit,
                uncertainty: profile.uncertainty,
                novelty: profile.novelty,
                costTokens: spec.cost,
                risk: profile.risk,
                trustCap: 1,
                why: spec.kind,
            };
        });
        const selection: Selection = selectFocus(candidates, { budgetTokens: BUDGET });
        const selectedKeys: Set<string> = new Set(selection.slots.map((item) => item.target.id));
        for (let i: number = 0; i < selection.slots.length; i += 1) {
            const item: Slot = selection.slots[i];
            const spec: Spec | undefined = pool.find((entry) => entry.key === item.target.id);
            assert.ok(spec !== (void 0));
            account(tally, spec, item.cost.tokens ?? 0, cycle);
        }
        for (let i: number = 0; i < selection.ignored.length; i += 1) {
            const item: Ignored = selection.ignored[i];
            tally.reasons.set(item.reason, (tally.reasons.get(item.reason) ?? 0) + 1);
        }
        for (let i: number = 0; i < pool.length; i += 1) {
            const spec: Spec = pool[i];
            if (spec.kind === "safety" && !selectedKeys.has(spec.key)) {
                tally.harm += 1;
            }
        }
        if (SafetyCycles.has(cycle)) {
            tally.safetyCycles += 1;
        } else {
            tally.plainCycles += 1;
        }
    }
    return tally;
};

type CognitiveRunOptions = {
    hazardValue?: number;
    capacity?: number;
};

type CognitiveRunner = (options?: CognitiveRunOptions) => Tally;

type Learned = {
    realized: number;
    lastSelectedAge: number;
    lastIgnoredAge: number;
};

/**
 * Cognitive: the same pool, plus state, history keyed by class, and floors.
 *
 * `capacity` is exposed because the two changes under test — closing the loop
 * and counting capacity in chunks — must be separable. Pinning capacity to the
 * baseline's seven isolates the state law; leaving it unset applies the chunk
 * rule as well.
 */
const runCognitive: CognitiveRunner = (options: CognitiveRunOptions = {}): Tally => {
    const hazardValue: number = options.hazardValue ?? 1;
    const tally: Tally = emptyTally();
    const frames: Frame[] = [];
    const receipts: Receipt[] = [];

    const learned: Map<Kind, Learned> = new Map<Kind, Learned>();

    for (let cycle: number = 0; cycle < CYCLES; cycle += 1) {
        const learnedEntries: Learned[] = [...learned.values()];
        for (let i: number = 0; i < learnedEntries.length; i += 1) {
            const entry: Learned = learnedEntries[i];
            entry.lastSelectedAge += 1;
            entry.lastIgnoredAge += 1;
        }
        const pool: Spec[] = poolFor(cycle, hazardValue);
        const state: CognitiveState = estimateCognitiveState({ frames, receipts, baseCapacity: CognitiveLaws.baseCapacity.value });
        const candidates: CognitiveCandidate[] = pool.map((spec) => {
            const profile: Profile = PROFILE[spec.kind];
            const memory: Learned | undefined = learned.get(spec.kind);
            const history: CandidateHistory | undefined = memory
                ? { realized: memory.realized, lastSelectedAge: memory.lastSelectedAge, lastIgnoredAge: memory.lastIgnoredAge }
                : undefined;
            return {
                target: ref(spec.kind === "safety" ? "threat" : "unknown", spec.key),
                role: profile.role,
                voi: profile.voi,
                goalFit: profile.goalFit,
                uncertainty: profile.uncertainty,
                novelty: profile.novelty,
                costTokens: spec.cost,
                risk: profile.risk,
                trustCap: 1,
                why: spec.kind,
                hardFloor: profile.floor > 0 ? profile.floor : undefined,
                history,
            };
        });

        const selection: CognitiveSelection = selectFromState(candidates, state, { budgetTokens: BUDGET, switchCostTokens: 40, capacity: options.capacity });
        const selectedKeys: Set<string> = new Set(selection.slots.map((item) => item.target.id));
        const activeSlots: Slot[] = [];
        for (let i: number = 0; i < selection.slots.length; i += 1) {
            const item: Slot = selection.slots[i];
            const spec: Spec | undefined = pool.find((entry) => entry.key === item.target.id);
            assert.ok(spec !== (void 0));
            account(tally, spec, item.cost.tokens ?? 0, cycle);
            activeSlots.push(slot(item.target, item.role, { salience: item.salience, cost: item.cost }));
            const memory: Learned = learned.get(spec.kind) ?? { realized: 0, lastSelectedAge: 0, lastIgnoredAge: 99 };
            const count: number = (tally.samples.get(spec.kind) ?? 1) - 1;
            memory.realized = count <= 0 ? spec.truth : (memory.realized * count + spec.truth) / (count + 1);
            memory.lastSelectedAge = 0;
            learned.set(spec.kind, memory);
            receipts.push({
                ...receipt(cycle, activeSlots.length, spec.truth > 0 ? "success" : "failure"),
                predicted_voi: PROFILE[spec.kind].voi,
                realized_voi: spec.truth,
            });
        }
        for (let i: number = 0; i < selection.ignored.length; i += 1) {
            const item: CognitiveIgnored = selection.ignored[i];
            tally.reasons.set(item.reason, (tally.reasons.get(item.reason) ?? 0) + 1);
        }
        for (let i: number = 0; i < pool.length; i += 1) {
            const spec: Spec = pool[i];
            if (spec.kind === "safety" && !selectedKeys.has(spec.key)) {
                tally.harm += 1;
            }
        }
        frames.push(
            frame(
                cycle,
                SafetyCycles.has(cycle) ? "triage" : "exploit",
                activeSlots,
                selection.ignored.map((item) => ({ target: item.target, reason: toFrameReason(item.reason), revisit_if: item.revisit_if })),
            ),
        );
        if (SafetyCycles.has(cycle)) {
            tally.safetyCycles += 1;
        } else {
            tally.plainCycles += 1;
        }
    }
    return tally;
};

const Baseline: Tally = runBaseline();
/**
 * The state law alone: capacity pinned to the baseline's seven, so only the loop changes.
 */
const StateLaw: Tally = runCognitive({ capacity: 7 });
/**
 * The state law plus the chunk rule: capacity now falls with load.
 */
const ChunkLaw: Tally = runCognitive();

const per1k: (tally: Tally) => number = (tally: Tally): number => (tally.tokens === 0 ? 0 : Math.round((tally.value / tally.tokens) * 1000 * 100) / 100);

console.log("\n\x1b[1mSynthetic trace — 24 cycles, 4 goals + 1 distractor + 1 stale source per cycle, hazards at 7 and 18\x1b[0m");
console.log("hidden truth is known only to the scorer; neither allocator sees it\n");
console.log(`${"metric".padEnd(26)}${"baseline".padStart(10)}${"state-law".padStart(11)}${"+chunks".padStart(10)}`);
console.log("------------------------------------------------------------------");
const Rows: Array<[string, string[]]> = [
    ["realised value", [Baseline.value.toFixed(2), StateLaw.value.toFixed(2), ChunkLaw.value.toFixed(2)]],
    ["tokens spent", [`${Baseline.tokens}`, `${StateLaw.tokens}`, `${ChunkLaw.tokens}`]],
    ["value per 1k tokens", [`${per1k(Baseline)}`, `${per1k(StateLaw)}`, `${per1k(ChunkLaw)}`]],
    ["wasted tokens", [`${Baseline.wasted}`, `${StateLaw.wasted}`, `${ChunkLaw.wasted}`]],
    ["repeated zero-value picks", [`${Baseline.repeats}`, `${StateLaw.repeats}`, `${ChunkLaw.repeats}`]],
    ["hazards missed", [`${Baseline.harm}`, `${StateLaw.harm}`, `${ChunkLaw.harm}`]],
];
for (let i: number = 0; i < Rows.length; i += 1) {
    const label: string = Rows[i][0];
    const cells: string[] = Rows[i][1];
    console.log(
        `${label.padEnd(26)}${cells
            .map((cell) => cell.padStart(10))
            .join(" ")
            .padStart(32)}`,
    );
}
console.log("------------------------------------------------------------------");
console.log("state-law: capacity pinned to 7, so only the closed loop differs.");
console.log("+chunks:   capacity also falls with load, so it does less work per cycle.");
console.log(`\nreasons, baseline:  ${[...Baseline.reasons].map(([reason, count]) => `${reason}×${count}`).join(", ")}`);
console.log(`reasons, state-law: ${[...StateLaw.reasons].map(([reason, count]) => `${reason}×${count}`).join(", ")}`);
console.log(
    `\ncaveat: the state law produces less absolute output at equal cycles (${StateLaw.value.toFixed(2)} vs ${Baseline.value.toFixed(2)}) ` +
        "because it refuses work it has learned is worthless. Efficiency and waste are the fair comparisons; " +
        "at the baseline's token spend the efficiency row implies it would produce more, which is an inference, not a run.",
);

/**
 * Outcome assertions.
 */

test("demo: the floor captures every hazard, the stateless allocator captures none", () => {
    assert.equal(Baseline.harm, 2);
    assert.equal(StateLaw.harm, 0);
    assert.equal(ChunkLaw.harm, 0);
});

test("demo: closing the loop, at equal capacity, removes almost all wasted attention", () => {
    assert.ok(StateLaw.wasted * 10 < Baseline.wasted, `expected >10x less waste, got ${StateLaw.wasted} vs ${Baseline.wasted}`);
});

test("demo: value per thousand tokens improves at equal capacity", () => {
    assert.ok(per1k(StateLaw) > per1k(Baseline), `expected higher efficiency, got ${per1k(StateLaw)} vs ${per1k(Baseline)}`);
});

test("demo: a class that never paid off is not picked again after being sampled", () => {
    assert.equal(StateLaw.repeats, 0, `expected no repeat zero-value picks, got ${StateLaw.repeats}`);
});

test("demo: the chunk rule binds, so it is a separate change and not a hidden confound", () => {
    assert.ok(ChunkLaw.tokens < StateLaw.tokens, `chunk capacity should reduce spend, got ${ChunkLaw.tokens} vs ${StateLaw.tokens}`);
    assert.ok(per1k(ChunkLaw) >= per1k(StateLaw), `doing less work should not lower efficiency, got ${per1k(ChunkLaw)} vs ${per1k(StateLaw)}`);
});

test("demo: the floor has a measurable price, and the model reports its sign", () => {
    const deltaFor: (hazardValue: number) => number = (hazardValue: number): number => {
        const tally: Tally = runCognitive({ hazardValue });
        return tally.valueOffSafety / Math.max(1, tally.plainCycles) - tally.valueOnSafety / Math.max(1, tally.safetyCycles);
    };
    const cheapHazard: number = deltaFor(0.2);
    const costlyHazard: number = deltaFor(1);
    assert.ok(cheapHazard > 0, `with a low-value hazard the floor must cost output, got ${cheapHazard}`);
    assert.ok(costlyHazard < 0, `with a high-value hazard the floor must repay its slot, got ${costlyHazard}`);
    console.log(`      hazard worth 0.2: floor costs ${cheapHazard.toFixed(2)}/cycle · hazard worth 1.0: floor repays ${(-costlyHazard).toFixed(2)}/cycle`);
});

console.log(`\n${Failed === 0 ? "\x1b[32m" : "\x1b[31m"}${Passed} passed, ${Failed} failed\x1b[0m`);
if (Failed > 0) {
    process.exitCode = 1;
}
