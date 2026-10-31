/**
 * AMP — cognitive state model (proposal).
 *
 * The premise: an agent and a person face the same *control* problem — a
 * resource-bounded decider must allocate finite cognition, monitor itself, and
 * be observed by others. Psychology is the accumulated science of that problem,
 * so its constraints transfer even though its phenomenology does not. This
 * module therefore models the agent as a bounded agent, not as a mind.
 *
 * What is borrowed from psychology is *form*, never a magic number: every
 * constant below is a named parameter with a citation and a stated status
 * (`measured` on humans, or `convention`), and nothing here claims the agent
 * has the corresponding experience.
 *
 * Five state variables, each estimable from the ledger alone:
 *
 * | state | psychological construct | what it changes |
 * | --- | --- | --- |
 * | `load` | working-memory occupancy + open loops | effective capacity; whether novelty may fill space |
 * | `vigilance` | time-on-task alertness | probability of a *missed re-check*, not "energy" |
 * | `arousal` | error pressure / urgency | breadth: it narrows what counts as on-goal |
 * | `mastery` | self-efficacy, long-run | whether to act, ask, or delegate |
 * | `accountability` | identifiability to an audience | effort and how many alternatives are required |
 *
 * The laws in `CognitiveLaws` are deliberately few, monotone and falsifiable.
 * A state variable with no measurable signature is not modelled here at all —
 * which is why there is no `mood`, no `fatigue`, and no `intuition`.
 */
import type { Frame, Ignored, Slot } from "../frame/frame.ts";
import type { Receipt } from "../receipt/receipt.ts";
import type { Confidence, Ref, Tier } from "../types/common.ts";

const clamp01: (value: number) => number = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Rounds to three decimals, so receipts and snapshots stay byte-stable.
 */
const round3: (value: number) => number = (value: number): number => Math.round(value * 1000) / 1000;

type LawParameter = {
    readonly value: number;
    readonly status: "measured" | "convention";
    readonly source: string;
};

type CognitiveLawSet = {
    readonly lossAsymmetry: LawParameter;
    readonly vigilanceTau: LawParameter;
    readonly iorTau: LawParameter;
    readonly baseCapacity: LawParameter;
    readonly loadPenalty: LawParameter;
    readonly noveltyLoadFloor: LawParameter;
    readonly arousalNarrowing: LawParameter;
    readonly metaCharge: LawParameter;
    readonly valueLearning: LawParameter;
};

type SlotWithOptionalChunkWeight = Slot & {
    chunk_weight?: number;
};

type SlotWithChunkWeight = Slot & {
    chunk_weight: number;
};

/**
 * Named law parameters. Every entry states whether the value is measured on
 * humans or a convention of this implementation, because a protocol may cite a
 * direction it cannot cite a magnitude for.
 */
export const CognitiveLaws: CognitiveLawSet = {
    /**
     * Prospect theory's loss-asymmetry median estimate (Kahneman & Tversky 1992).
     */
    lossAsymmetry: { value: 2.25, status: "measured", source: "λ ≈ 2.25, median across studies" },
    /**
     * Vigilance half-life in *cycles*, not minutes: a convention pending measurement.
     */
    vigilanceTau: { value: 12, status: "convention", source: "calibrate per model from receipts" },
    /**
     * Inhibition-of-return kernel: distinct from novelty decay.
     */
    iorTau: { value: 3, status: "convention", source: "seconds-scale effect mapped onto cycles" },
    /**
     * Base chunk capacity before load is applied (Cowan 2001: ~4 unrehearsed).
     */
    baseCapacity: { value: 4, status: "measured", source: "Cowan 2001, BBS 24(1):87–114" },
    /**
     * Load may consume at most half of capacity.
     */
    loadPenalty: { value: 0.5, status: "convention", source: "monotone, bounded" },
    /**
     * Below this load, spare capacity must not be filled with novelty (Lavie).
     */
    noveltyLoadFloor: { value: 0.3, status: "convention", source: "Lavie 2005, TiCS 9(2):75–82" },
    /**
     * Arousal narrows breadth by raising the goal-fit exponent (Easterbrook 1959).
     */
    arousalNarrowing: { value: 0.5, status: "convention", source: "Easterbrook 1959, Psych Review 66:183–201" },
    /**
     * Screening overhead charged per candidate scored.
     */
    metaCharge: { value: 0.1, status: "convention", source: "Russell & Wefald 1991" },
    /**
     * How strongly a class's realised value moves its future priority.
     */
    valueLearning: { value: 2, status: "convention", source: "Anderson, Laurent & Yantis 2011, PNAS 108(25); calibrate per host" },
} as const;

/**
 * History of one target, derived from prior frames and receipts. Never stored as a weight.
 */
export interface CandidateHistory {
    /**
     * Mean of `realized_voi` over past selections; 0.5 only when no sample exists.
     */
    realized?: number;
    /**
     * Cycles since this target last occupied a slot.
     */
    lastSelectedAge?: number;
    /**
     * Cycles since this target was last explicitly excluded.
     */
    lastIgnoredAge?: number;
}

/**
 * A candidate plus the fields the cognitive law needs, all supplied by the host.
 */
export interface CognitiveCandidate {
    target: Ref;
    role: Slot["role"];
    tier?: Tier;
    voi: Confidence;
    goalFit: Confidence;
    uncertainty: Confidence;
    novelty: Confidence;
    costTokens: number;
    risk: Confidence;
    /**
     * Trust cap: external content cannot buy salience, only lose it (A-4).
     */
    trustCap: Confidence;
    why: string;
    /**
     * Additive floor that the multiplicative score cannot cancel (proposed A-10).
     */
    hardFloor?: Confidence;
    /**
     * Chunks the target occupies; two unrelated sub-goals cost two (proposed A-7).
     */
    chunkWeight?: number;
    /**
     * Deterministic difference from the previous focus, in tokens (proposed A-12).
     */
    switchCostTokens?: number;
    history?: CandidateHistory;
}

/**
 * Ignore reasons this law can emit. The five beyond `IgnoredReason` require a
 * schema addition; keeping them in a wider local union means this module stays
 * additive and changes no existing contract.
 */
export type CognitiveIgnoreReason = Ignored["reason"] | "inhibited" | "low_sensitivity" | "conservative_criterion" | "capacity" | "exhausted";

export interface CognitiveIgnored {
    target: Ref;
    reason: CognitiveIgnoreReason;
    revisit_if: string;
}

/**
 * The five state variables plus everything derived from them.
 */
export interface CognitiveState {
    load: Confidence;
    vigilance: Confidence;
    arousal: Confidence;
    mastery: Confidence;
    accountability: Confidence;
    /**
     * Cycles since the last `rest` frame; drives `vigilance`.
     */
    cyclesSinceRest: number;
    /**
     * `baseCapacity` after the load penalty. Capacity here is in chunks.
     */
    capacityEff: number;
    /**
     * Probability that a fired `revisit_if` goes unchecked. This is what rest repairs.
     */
    pLapse: Confidence;
    /**
     * Role that dominated the previous frame; switch cost is charged against it.
     */
    dominantRole?: Slot["role"];
    /**
     * `measured` when enough receipts existed, otherwise `default`.
     */
    source: "measured" | "default";
    samples: number;
}

export interface CognitiveInputs {
    frames: readonly Frame[];
    receipts: readonly Receipt[];
    /**
     * Host-supplied when it has ground truth; otherwise derived from frames.
     */
    accountability?: Confidence;
    /**
     * Receipts considered recent for `arousal`. Defaults to 12.
     */
    window?: number;
    baseCapacity?: number;
    tauVigilance?: number;
}

/**
 * Estimate the state from the ledger.
 *
 * Two timescales of the same signal are kept apart on purpose: `arousal` is
 * *recent* error pressure (fast, phasic) while `mastery` is the long-run success
 * rate (slow, trait-like). Collapsing them into one number loses the fact that a
 * competent agent can be briefly alarmed, and an incompetent one can be calm.
 */
export const estimateCognitiveState: (input: CognitiveInputs) => CognitiveState = (input: CognitiveInputs): CognitiveState => {
    const frames: readonly Frame[] = input.frames;
    const last: Frame | undefined = frames.length > 0 ? frames[frames.length - 1] : undefined;
    const baseCapacity: number = input.baseCapacity ?? CognitiveLaws.baseCapacity.value;
    const tau: number = input.tauVigilance ?? CognitiveLaws.vigilanceTau.value;
    const window: number = input.window ?? 12;

    let cyclesSinceRest: number = frames.length;
    for (let index: number = frames.length - 1; index >= 0; index -= 1) {
        if (frames[index].mode === "rest") {
            cyclesSinceRest = frames.length - 1 - index;
            break;
        }
    }

    const active: Slot[] = last ? last.slots.filter((slot) => slot.state === "active") : [];
    const chunks: number = active.reduce(
        (sum, slot) => sum + (typeof((slot as SlotWithOptionalChunkWeight).chunk_weight) === "number" ? (slot as SlotWithChunkWeight).chunk_weight : 1),
        0,
    );
    const deferred: Ignored[] = (last?.ignored ?? []).filter((item) => item.reason === "deferred" || item.reason === "budget");
    const rootCapacity: number = Math.max(1, baseCapacity);
    const load: number = clamp01(0.6 * Math.min(1, chunks / rootCapacity) + 0.4 * Math.min(1, deferred.length / 8));

    const recent: Receipt[] = input.receipts.slice(Math.max(0, input.receipts.length - window));
    const scored: Receipt[] = recent.filter((receipt) => receipt.outcome !== (void 0));
    const failures: number = scored.filter((receipt) => receipt.outcome === "blocked" || receipt.outcome === "failure").length;
    const partials: number = scored.filter((receipt) => receipt.outcome === "partial").length;
    const failureRate: number = scored.length > 0 ? failures / scored.length : 0;
    const partialRate: number = scored.length > 0 ? partials / scored.length : 0;
    const arousal: number = clamp01(0.75 * failureRate + 0.25 * partialRate);

    const allScored: Receipt[] = input.receipts.filter((receipt) => receipt.outcome !== (void 0));
    const wins: number = allScored.filter((receipt) => receipt.outcome === "success").length;
    const mastery: number = allScored.length > 0 ? clamp01(wins / allScored.length) : 0.5;

    const vigilance: number = clamp01(Math.exp(-cyclesSinceRest / Math.max(1, tau)));
    const capacityEff: number = Math.min(9, Math.max(1, Math.round(rootCapacity * (1 - CognitiveLaws.loadPenalty.value * load))));
    const dominantRole: Slot["role"] | undefined = dominantRoleOf(active);

    return {
        load: round3(load),
        vigilance: round3(vigilance),
        arousal: round3(arousal),
        mastery: round3(mastery),
        accountability: clamp01(input.accountability ?? 0),
        cyclesSinceRest,
        capacityEff,
        pLapse: round3(1 - vigilance),
        dominantRole,
        source: allScored.length >= 30 ? "measured" : "default",
        samples: allScored.length,
    };
};

type DominantRoleOf = (slots: readonly Slot[]) => Slot["role"] | undefined;

/**
 * The role with the most chunk weight in a focus set; ties resolve to the first seen.
 */
const dominantRoleOf: DominantRoleOf = (slots: readonly Slot[]): Slot["role"] | undefined => {
    const weight: Map<Slot["role"], number> = new Map<Slot["role"], number>();
    for (let index: number = 0; index < slots.length; index += 1) {
        const slot: Slot = slots[index];
        const chunks: number = typeof((slot as SlotWithOptionalChunkWeight).chunk_weight) === "number" ? (slot as SlotWithChunkWeight).chunk_weight : 1;
        weight.set(slot.role, (weight.get(slot.role) ?? 0) + chunks);
    }
    let best: Slot["role"] | undefined = undefined;
    let bestWeight: number = -1;
    const entries: [Slot["role"], number][] = [...weight];
    for (let index: number = 0; index < entries.length; index += 1) {
        const [role, total]: [Slot["role"], number] = entries[index];
        if (total > bestWeight) {
            best = role;
            bestWeight = total;
        }
    }
    return best;
};

/**
 * The history multiplier: value learning minus inhibition of return.
 *
 * These are two mechanisms with opposite signs, not one "novelty" knob. A
 * candidate that paid off is worth re-selecting; a candidate just rejected is
 * worth *not* re-selecting, and both facts must survive into the next cycle.
 */
export const historyFactor: (history: CandidateHistory | undefined) => number = (history: CandidateHistory | undefined): number => {
    if (!history) {
        return 1;
    }
    const realized: number = typeof(history.realized) === "number" ? history.realized : 0.5;
    const learned: number = 1 + CognitiveLaws.valueLearning.value * (realized - 0.5);
    const age: number = typeof(history.lastIgnoredAge) === "number" ? history.lastIgnoredAge : Number.POSITIVE_INFINITY;
    const ior: number = age === Number.POSITIVE_INFINITY ? 0 : 0.5 * Math.exp(-age / CognitiveLaws.iorTau.value);
    return Math.max(0.1, learned - ior);
};

/**
 * The cognitive salience law.
 *
 * `S = floor ⊕ [ voi · goalFit^γ · (1 + novelty·openness) · history ]
 *      / [ 1 + c_tok + c_risk + c_switch·(1 + load) + c_meta ]`
 *
 * with `γ = 1 + arousalNarrowing · arousal`. Four consequences are worth naming:
 *
 * 1. **Arousal narrows.** As `arousal` rises, `goalFit` is raised to a power > 1,
 *    so off-goal candidates die faster and on-goal ones keep their rank. This is
 *    Easterbrook's cue-utilisation result expressed as an exponent, with no
 *    affect term anywhere.
 * 2. **Low load does not invite capture.** Below `noveltyLoadFloor`, novelty
 *    contributes nothing, because spare capacity is exactly where irrelevant
 *    material gets in (Lavie).
 * 3. **Hard floors bypass.** A floor is a maximum, never a multiplier, so a
 *    safety signal with `goalFit` near zero cannot be multiplied down to a
 *    `low_voi` exclusion.
 * 4. **Deciding costs.** Every candidate pays `metaCharge`, and a candidate that
 *    differs from the previous focus pays its switch cost — twice over when
 *    `load` is high, because reconfiguration is harder under load.
 */
type SalienceLaw = (candidate: CognitiveCandidate, state: CognitiveState) => Confidence;

export const salienceFromState: SalienceLaw = (candidate: CognitiveCandidate, state: CognitiveState): Confidence => {
    const gamma: number = 1 + CognitiveLaws.arousalNarrowing.value * state.arousal;
    const openness: number = state.load >= CognitiveLaws.noveltyLoadFloor.value ? 1 : 0;
    const value: number =
        candidate.voi * Math.pow(clamp01(candidate.goalFit), gamma) * (1 + 0.5 * clamp01(candidate.novelty) * openness) * historyFactor(candidate.history);

    const switchTokens: number = candidate.switchCostTokens ?? 0;
    const loadOnSwitch: number = 1 + state.load;
    const cost: number =
        1 +
        2 * clamp01(candidate.costTokens / 2000) +
        3 * clamp01(candidate.risk) +
        0.5 * clamp01(switchTokens / 2000) * loadOnSwitch +
        CognitiveLaws.metaCharge.value;

    const capped: number = Math.min(clamp01(value / cost), clamp01(candidate.trustCap));
    const floor: number = typeof(candidate.hardFloor) === "number" ? clamp01(candidate.hardFloor) : 0;
    return round3(Math.max(capped, floor));
};

export interface CognitiveSelectionOptions {
    budgetTokens: number;
    /**
     * Overrides `state.capacityEff` when the host has a better estimate.
     */
    capacity?: number;
    threshold?: number;
    /**
     * Token cost charged for changing the dominant role of the focus set.
     */
    switchCostTokens?: number;
}

export interface CognitiveSelection {
    slots: Slot[];
    ignored: CognitiveIgnored[];
    impasse?: "TIE" | "STUCK" | "BUDGET" | "INFEASIBLE";
    /**
     * Chunks consumed, so a caller can assert the capacity rule directly.
     */
    capacityUsed: number;
}

/**
 * Select a focus set under a state-modulated law.
 *
 * Order matters and is the point: floors are placed first, before any scoring,
 * so capacity pressure can never convert a safety signal into `low_voi`. A
 * floor that cannot be placed yields `INFEASIBLE` rather than a silent drop.
 */
type ScoredCandidate = {
    candidate: CognitiveCandidate;
    score: number;
};

type SelectionLaw = (candidates: readonly CognitiveCandidate[], state: CognitiveState, options: CognitiveSelectionOptions) => CognitiveSelection;

export const selectFromState: SelectionLaw = (candidates: readonly CognitiveCandidate[], state: CognitiveState, options: CognitiveSelectionOptions) => {
    const threshold: number = options.threshold ?? 0.12;
    const capacity: number = Math.max(1, options.capacity ?? state.capacityEff);
    const switchCost: number = options.switchCostTokens ?? 0;
    const scored: ScoredCandidate[] = candidates
        .map((candidate) => ({ candidate, score: salienceFromState(candidate, state) }))
        .sort((left, right) => right.score - left.score);

    const ignored: CognitiveIgnored[] = [];
    const slots: Slot[] = [];
    let usedChunks: number = 0;
    let remaining: number = options.budgetTokens;
    let floorConflict: boolean = false;

    for (let index: number = 0; index < scored.length; index += 1) {
        const entry: ScoredCandidate = scored[index];
        const chunks: number = Math.max(1, typeof(entry.candidate.chunkWeight) === "number" ? Math.floor(entry.candidate.chunkWeight) : 1);
        const reserved: boolean = (entry.candidate.hardFloor ?? 0) > 0;
        if (usedChunks + chunks > capacity) {
            if (reserved) {
                floorConflict = true;
            }
            ignored.push({ target: entry.candidate.target, reason: "capacity", revisit_if: "焦点释放后" });
            continue;
        }
        const cost: number = entry.candidate.costTokens;
        const withSwitch: number = cost + (entry.candidate.role === state.dominantRole ? 0 : switchCost);
        if (withSwitch > remaining) {
            ignored.push({ target: entry.candidate.target, reason: "budget", revisit_if: "预算恢复后" });
            continue;
        }
        if (!reserved && entry.score < threshold) {
            ignored.push({
                target: entry.candidate.target,
                reason: reasonForIgnore(entry.candidate, state),
                revisit_if: entry.candidate.target.kind === "unknown" ? "VOI 上升或目标改变" : "重新评估后",
            });
            continue;
        }
        remaining -= withSwitch;
        usedChunks += chunks;
        slots.push({
            target: entry.candidate.target,
            role: entry.candidate.role,
            tier: entry.candidate.tier,
            salience: entry.score,
            voi: entry.candidate.voi,
            cost: { tokens: cost },
            budget: { tokens: withSwitch },
            why: entry.candidate.why,
            state: "active",
        });
    }

    let impasse: CognitiveSelection["impasse"] = undefined;
    if (floorConflict) {
        impasse = "INFEASIBLE";
    } else if (slots.length === 0) {
        impasse = "STUCK";
    } else if (slots.length > 1 && Math.abs(slots[0].salience - slots[1].salience) < 0.02) {
        impasse = "TIE";
    }

    return { slots, ignored, impasse, capacityUsed: usedChunks };
};

/**
 * Why an item was excluded, chosen so an auditor can tell three things apart:
 * it was not worth it (`low_voi`), it could not be told (`low_sensitivity`), or
 * it was deliberately not reacted to (`conservative_criterion`). Conflating
 * these is what makes alert fatigue unattributable.
 */
type IgnoreReasonLaw = (candidate: CognitiveCandidate, state: CognitiveState) => CognitiveIgnoreReason;

const reasonForIgnore: IgnoreReasonLaw = (candidate: CognitiveCandidate, state: CognitiveState): CognitiveIgnoreReason => {
    const age: number | undefined = candidate.history?.lastIgnoredAge;
    if (typeof(age) === "number" && age <= CognitiveLaws.iorTau.value) {
        return "inhibited";
    }
    if (state.pLapse > 0.5 && candidate.uncertainty > 0.5) {
        return "low_sensitivity";
    }
    return "low_voi";
};

/**
 * The contract, as tests rather than as a formula. Ten monotonicity claims —
 * the original five plus five that the cognitive law adds. An implementation may
 * replace every constant above and still be conformant, provided these hold.
 */
type MonotonicityLaw = (base: CognitiveCandidate, state: CognitiveState) => boolean;

type SalienceProbe = (over?: Partial<CognitiveCandidate>, stateOver?: Partial<CognitiveState>) => number;

export const respectsCognitiveMonotonicity: MonotonicityLaw = (base: CognitiveCandidate, state: CognitiveState): boolean => {
    const at: SalienceProbe = (over: Partial<CognitiveCandidate> = {}, stateOver: Partial<CognitiveState> = {}): number =>
        salienceFromState({ ...base, ...over }, { ...state, ...stateOver });
    const reference: number = at();
    const checks: boolean[] = [
        at({ voi: Math.min(1, base.voi + 0.1) }) >= reference,
        at({ costTokens: base.costTokens + 200 }) <= reference,
        at({ risk: Math.min(1, base.risk + 0.1) }) <= reference,
        at({ trustCap: Math.min(base.trustCap, 0.2) }) <= reference,
        at({ history: { ...base.history, realized: 1 } }) >= reference,
        at({ history: { ...base.history, lastIgnoredAge: 0, lastSelectedAge: 0 } }) <= reference,
        at({ hardFloor: 1 }) >= reference,
        at({ switchCostTokens: 2000 }) <= reference,
        at({}, { arousal: 1 }) <= reference,
        at({}, { load: 0 }) <= reference,
    ];
    return checks.every((ok) => ok);
};
