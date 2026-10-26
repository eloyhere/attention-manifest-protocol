#!/usr/bin/env node
/**
 * AMP conformance suite — reference semantics for vectors V1–V15.
 *
 * This is NOT an implementation test. It encodes the protocol's rules as small
 * pure functions and checks the observable behaviour each vector demands, so a
 * host can be judged against the same table.
 *
 * Exit code 0 iff every vector passes.
 */

/**
 * A manifest-shaped value as seen by the drift classifier.
 */
type DriftInput = {
    id?: string;
    agent?: {
        id?: string;
    };
    digest?: string;
};

/**
 * A complete manifest used as a drift vector input.
 */
type Manifest = {
    amp: string;
    kind: string;
    id: string;
    agent: {
        id: string;
    };
    digest: string;
};

/**
 * One claim as seen by the reconciliation helper.
 */
type ClaimLike = {
    id: string;
    statement?: string;
    structured?: {
        subject?: string;
        relation?: string;
        value?: string;
    };
    status: string;
};

/**
 * Result of reconciling conflicting claims.
 */
type ReconcileResult = {
    conflicting: boolean;
    claims: ClaimLike[];
};

/**
 * Shape chosen for a tool result.
 */
type ShapeResult = {
    mode: string;
    truncated: boolean;
    omitted?: number;
};

/**
 * One catalog entry considered during retrieval.
 */
type CatalogEntry = {
    id: string;
    when: string;
};

/**
 * One scored retrieval candidate.
 */
type RankedEntry = {
    id: string;
    score: number;
};

/**
 * Retrieval outcome: matches, or an explicit abstention.
 */
type RetrieveResult = {
    results: RankedEntry[];
    abstained: boolean;
    reason?: string;
};

/**
 * Plan budget consulted by the monitor.
 */
type PlanInput = {
    budget?: {
        calls?: number;
    };
};

/**
 * Observable monitor signals for one step.
 */
type Observation = {
    abandoned?: boolean[];
    expectFailed?: boolean;
    callsUsed: number;
};

/**
 * Claim whose confidence is revised under pressure.
 */
type ConfidenceClaim = {
    id: string;
    confidence: number;
};

/**
 * Pressure and evidence signals for the revision check.
 */
type PressureOptions = {
    pressure?: boolean;
    newEvidence?: boolean;
};

/**
 * Outcome of a revision under pressure.
 */
type PressureResult = {
    confidence: number;
    integrity: string | null;
};

/**
 * One belief held by the model about a slot.
 */
type BeliefLike = {
    slot: string;
    order: number;
    proposition: string;
};

/**
 * Belief table consulted when resolving a slot.
 */
type BeliefModel = {
    beliefs: BeliefLike[];
};

/**
 * How a belief slot was resolved.
 */
type BeliefResolution = {
    error?: string;
    requiresRecord?: boolean;
    order?: number;
    proposition?: string;
};

/**
 * Trajectory state consulted before asking a question.
 */
type AskInput = {
    progress: number;
    kind: string;
};

/**
 * One scripted step, possibly with nested calls.
 */
type StepLike = {
    nested?: StepLike[];
};

/**
 * Result of running a script under a call budget.
 */
type RunScriptResult = {
    status: string;
    calls: number;
};

/**
 * Hypothesis shape inspected for a refutation condition.
 */
type Hypothesis = {
    statement?: string;
    refutes_if?: string;
};

/**
 * Source consulted when promoting evidence to T1.
 */
type EvidenceLike = {
    entails?: boolean;
};

/**
 * Request to promote a claim to a tier.
 */
type PromotionInput = {
    evidence?: EvidenceLike[];
    requested?: string;
};

/**
 * Tier decision.
 */
type TierResult = {
    tier: string;
    reason: string;
};

/**
 * Adjustment sets audited for collider adjustment.
 */
type CausalInput = {
    adjustment_set?: string[];
    colliders?: string[];
};

/**
 * Causal audit outcome.
 */
type CausalResult = {
    ok: boolean;
    violations: string[];
};

/**
 * Hypothesis shape inspected for preregistration.
 */
type HypothesisLabelInput = {
    statement?: string;
    prereg?: {
        hash?: string;
    };
};

/**
 * P-value observation with the number of looks.
 */
type PValueInput = {
    p: number;
    looks: number;
    alpha?: number;
};

/**
 * Promotion decision for a p-value observation.
 */
type PValueResult = {
    tier: string;
    promoted: boolean;
    reason?: string;
};

/**
 * Whether an answer is known.
 */
type AnswerInput = {
    known: boolean;
};

/**
 * Answer or explicit abstention.
 */
type AnswerResult = {
    text?: string;
    abstain: boolean;
    reason?: string;
};

/**
 * Body of one conformance vector; the returned text is printed as detail.
 */
type CheckFn = () => string;

/**
 * Register and run one conformance vector.
 */
type Check = (id: string, title: string, fn: CheckFn) => void;

/**
 * Retrieval helper signature.
 */
type Retrieve = (query: string, catalog: CatalogEntry[], tau?: number) => RetrieveResult;

/**
 * Pressure-revision helper signature.
 */
type ReviseUnderPressure = (claim: ConfidenceClaim, options: PressureOptions) => PressureResult;

/**
 * Belief-resolution helper signature.
 */
type ResolveBelief = (model: BeliefModel, slotId: string) => BeliefResolution;

/**
 * Script-run helper signature.
 */
type RunScript = (steps: StepLike[], limit: number) => RunScriptResult;

/**
 * Causal-audit helper signature.
 */
type CausalCheck = (input: CausalInput) => CausalResult;

/**
 * Tier-promotion helper signature.
 */
type Promotion = (input: PromotionInput) => TierResult;

let Failures: number = 0;
let Passes: number = 0;

const check: Check = (id: string, title: string, fn: CheckFn): void => {
    try {
        const detail: string = fn();
        Passes++;
        console.log(`\x1b[32m✓\x1b[0m ${id}  ${title}${detail ? `\n      ${detail}` : ""}`);
    } catch (err) {
        Failures++;
        console.error(`\x1b[31m✗\x1b[0m ${id}  ${title}\n      ${err.message}`);
    }
};

const assert: (cond: boolean, msg: string) => void = (cond: boolean, msg: string): void => {
    if (!cond) {
        throw new Error(msg);
    }
};

/**
 * ------------------------------------------------------------------
 * Reference semantics
 * ------------------------------------------------------------------
 */

/**
 * V1: a manifest that changed bytes after approval is a security event.
 */
const classifyDrift: (prev: DriftInput, next: DriftInput) => string = (prev: DriftInput, next: DriftInput): string => {
    if (!prev || !next) {
        return "invalid";
    }
    if (prev.id !== next.id || prev.agent?.id !== next.agent?.id) {
        return "identity_mismatch";
    }
    return prev.digest === next.digest ? "clean" : "security_event";
};

/**
 * V2: conflicting claims are both retained and marked doubtful — never averaged away.
 */
const reconcile: (claims: ClaimLike[]) => ReconcileResult = (claims: ClaimLike[]): ReconcileResult => {
    const values: Set<string> = new Set(claims.map((c) => JSON.stringify(c.structured?.value ?? c.statement)));
    const conflicting: boolean = values.size > 1;
    return {
        conflicting,
        claims: claims.map((c) => ({ ...c, status: conflicting ? "doubted" : c.status })),
    };
};

/**
 * V3: over-budget results become handles. They are never silently truncated.
 */
const shape: (tokens: number, budgetTokens: number) => ShapeResult = (tokens: number, budgetTokens: number): ShapeResult => {
    if (tokens <= budgetTokens) {
        return { mode: "inline", truncated: false };
    }
    return { mode: "handle", truncated: false, omitted: tokens - budgetTokens };
};

/**
 * V4: when nothing clears the threshold, abstain. Do not pick the least-bad tool.
 */
const retrieve: Retrieve = (query: string, catalog: CatalogEntry[], tau: number = 1): RetrieveResult => {
    const qs: Set<string> = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
    const ranked: RankedEntry[] = catalog
        .map((c) => {
            const ts: string[] = `${c.id} ${c.when}`.toLowerCase().split(/\s+/);
            return { id: c.id, score: ts.filter((t) => qs.has(t)).length };
        })
        .sort((a, b) => b.score - a.score);
    const best: RankedEntry | undefined = ranked[0];
    if (!best || best.score < tau) {
        return { results: [], abstained: true, reason: "no_match" };
    }
    return { results: ranked.filter((r) => r.score >= tau).slice(0, 3), abstained: false };
};

/**
 * V5: an observable abandon condition wins over every other monitor signal.
 */
const monitorPlan: (plan: PlanInput, obs: Observation) => string = (plan: PlanInput, obs: Observation): string => {
    if ((obs.abandoned ?? []).some(Boolean)) {
        return "abandon";
    }
    if (obs.expectFailed) {
        return "retry";
    }
    if (obs.callsUsed > (plan.budget?.calls ?? Infinity) * 1.2) {
        return "replan";
    }
    return "continue";
};

/**
 * V6: social pressure without new evidence cannot raise confidence.
 */
const reviseUnderPressure: ReviseUnderPressure = (claim: ConfidenceClaim, { pressure = false, newEvidence = false }: PressureOptions): PressureResult => {
    if (pressure && !newEvidence) {
        return { confidence: claim.confidence, integrity: "sycophancy_pressure" };
    }
    return { confidence: newEvidence ? Math.min(1, claim.confidence + 0.1) : claim.confidence, integrity: null };
};

/**
 * V7: beliefs above order 2 are resolved from records, never elicited from the model.
 */
const resolveBelief: ResolveBelief = (model: BeliefModel, slotId: string): BeliefResolution => {
    const b: BeliefLike | undefined = model.beliefs.find((x) => x.slot === slotId);
    if (!b) {
        return { error: "missing" };
    }
    if (b.order > 2) {
        return { requiresRecord: true, order: b.order };
    }
    return { proposition: b.proposition, order: b.order };
};

/**
 * V8: ask inside the window; after it, declare an assumption instead.
 */
const shouldAsk: (input: AskInput) => boolean = ({ progress, kind }: AskInput): boolean => {
    if (kind === "goal") {
        return progress < 0.1;
    }
    if (kind === "input") {
        return progress < 0.5;
    }
    return false;
};

/**
 * V9: nested calls count against the same budget as top-level calls.
 */
const countCalls: (steps: StepLike[]) => number = (steps: StepLike[]): number => {
    return steps.reduce((n, s) => n + 1 + countCalls(s.nested ?? []), 0);
};
const runScript: RunScript = (steps: StepLike[], limit: number): RunScriptResult => {
    const calls: number = countCalls(steps);
    return calls > limit ? { status: "budget_exceeded", calls } : { status: "ok", calls };
};

/**
 * V10: a hypothesis without a refutation condition is not admissible.
 */
const validHypothesis: (h: Hypothesis) => boolean = (h: Hypothesis): boolean => {
    return typeof(h.refutes_if) === "string" && h.refutes_if.trim().length > 0;
};

/**
 * V11: adjusting for a collider (or mediator) is a causal violation.
 */
const causalCheck: CausalCheck = ({ adjustment_set: adjustmentSet = [], colliders = [] }: CausalInput): CausalResult => {
    const bad: string[] = adjustmentSet.filter((a) => colliders.includes(a));
    return { ok: bad.length === 0, violations: bad };
};

/**
 * V12: a hypothesis registered after data access is exploratory, not confirmatory.
 */
const classifyHypothesis: (h: HypothesisLabelInput) => string = (h: HypothesisLabelInput): string => {
    return h.prereg ? "confirmatory" : "exploratory";
};

/**
 * V13: T1 needs a source that ENTAILS the claim, not one that merely mentions it.
 */
const promoteToT1: Promotion = ({ evidence = [], requested = "T1" }: PromotionInput): TierResult => {
    const entailing: number = evidence.filter((e) => e.entails).length;
    if (requested === "T1" && entailing === 0) {
        return { tier: "T0", reason: "source_does_not_entail" };
    }
    return { tier: requested, reason: "ok" };
};

/**
 * V14: p = 0.049 after 12 logged looks does not promote to T2.
 */
const promoteFromP: (input: PValueInput) => PValueResult = ({ p, looks, alpha = 0.05 }: PValueInput): PValueResult => {
    if (p <= alpha && looks > 1) {
        return { tier: "T1", promoted: false, reason: "multiple_looks" };
    }
    return { tier: p <= alpha ? "T2" : "T1", promoted: p <= alpha };
};

/**
 * V15: without a source, abstain. Never invent the answer.
 */
const answer: (input: AnswerInput) => AnswerResult = ({ known }: AnswerInput): AnswerResult => {
    return known ? { text: "answered", abstain: false } : { abstain: true, reason: "unknown" };
};

/**
 * ------------------------------------------------------------------
 * Vectors
 * ------------------------------------------------------------------
 */

const ManifestOne: Manifest = {
    amp: "0.1",
    kind: "manifest",
    id: "m.1",
    agent: { id: "a.gamma" },
    digest: `sha256:${"a".repeat(64)}`,
};
const ManifestTwo: Manifest = { ...ManifestOne, digest: `sha256:${"b".repeat(64)}` };

check("V1", "批准后掉包 → fail closed", () => {
    const result: string = classifyDrift(ManifestOne, ManifestTwo);
    assert(result === "security_event", `expected security_event, got ${result}`);
    assert(classifyDrift(ManifestOne, ManifestOne) === "clean", "identical manifest must be clean");
    return "digest drift raises a security event";
});

check("V2", "矛盾来源 → 两条都保留且标为 doubted", () => {
    const claims: ClaimLike[] = [
        { id: "c1", structured: { subject: "e.deploy", relation: "causes", value: "error_rate" }, status: "held" },
        { id: "c2", structured: { subject: "e.deploy", relation: "causes", value: "nothing" }, status: "held" },
    ];
    const out: ReconcileResult = reconcile(claims);
    assert(out.conflicting === true, "conflict not detected");
    assert(out.claims.length === 2, "claims were dropped");
    assert(
        out.claims.every((c) => c.status === "doubted"),
        "conflict must doubt both sides",
    );
    return "both retained, neither silently wins";
});

check("V3", "超预算结果 → 转句柄，不截断", () => {
    const out: ShapeResult = shape(5000, 1200);
    assert(out.mode === "handle", `expected handle, got ${out.mode}`);
    assert(out.truncated === false, "silent truncation is forbidden");
    assert(out.omitted === 3800, "omitted amount must be reported");
    return "handle with an explicit omitted count";
});

check("V4", "无关查询 → abstain，不硬选", () => {
    const catalog: CatalogEntry[] = [
        { id: "mail.send", when: "send an email message" },
        { id: "invoice.create", when: "create an invoice" },
    ];
    const out: RetrieveResult = retrieve("compare deploy window error rate", catalog);
    assert(out.abstained === true, "should have abstained");
    assert(out.results.length === 0, "must not return a least-bad candidate");
    return "empty result is a legal answer";
});

check("V5", "abandon_if 成立 → 立即放弃", () => {
    const plan: PlanInput = { budget: { calls: 8 } };
    const out: string = monitorPlan(plan, { abandoned: [false, true], expectFailed: true, callsUsed: 2 });
    assert(out === "abandon", `expected abandon, got ${out}`);
    return "abandonment outranks retry";
});

check("V6", "施压无新证据 → 置信度不变，记完整性事件", () => {
    const claim: ConfidenceClaim = { id: "cl.91", confidence: 0.72 };
    const out: PressureResult = reviseUnderPressure(claim, { pressure: true, newEvidence: false });
    assert(out.confidence === 0.72, "confidence moved under pressure");
    assert(out.integrity === "sycophancy_pressure", "integrity event not recorded");
    return "pressure logged, number unchanged";
});

check("V7", "三阶信念 → 由记录解析，不向模型诱导", () => {
    const model: BeliefModel = {
        beliefs: [
            { slot: "b1", order: 1, proposition: "P" },
            { slot: "b3", order: 3, proposition: "Q" },
        ],
    };
    const deep: BeliefResolution = resolveBelief(model, "b3");
    assert(deep.requiresRecord === true, "order-3 belief must be resolved from records");
    assert(resolveBelief(model, "b1").proposition === "P", "order-1 belief should resolve directly");
    return "depth > 2 requires an explicit record";
});

check("V8", "轨迹 80% 处才发现目标不清 → 不提问", () => {
    assert(shouldAsk({ progress: 0.8, kind: "goal" }) === false, "asked too late");
    assert(shouldAsk({ progress: 0.05, kind: "goal" }) === true, "should ask early for goals");
    assert(shouldAsk({ progress: 0.45, kind: "input" }) === true, "input window should still be open");
    return "ask early for goals, mid for input, never late";
});

check("V9", "嵌套 100 次调用 → 统一计数并拒绝", () => {
    const script: StepLike[] = [{ nested: Array.from({ length: 99 }, () => ({ nested: [] })) }];
    const out: RunScriptResult = runScript(script, 50);
    assert(out.calls === 100, `expected 100 counted calls, got ${out.calls}`);
    assert(out.status === "budget_exceeded", "nested calls bypassed the budget");
    return "one counter, including nested calls";
});

check("V10", "假设缺 refutes_if → 拒绝入库", () => {
    assert(validHypothesis({ statement: "x" }) === false, "accepted a hypothesis without refutes_if");
    assert(validHypothesis({ refutes_if: "error rate stays high" }) === true, "rejected a valid hypothesis");
    return "no refutation condition, no hypothesis";
});

check("V11", "调整对撞因子 → 因果违规", () => {
    const out: CausalResult = causalCheck({ adjustment_set: ["service", "load"], colliders: ["load"] });
    assert(out.ok === false, "collider adjustment was accepted");
    assert(out.violations.includes("load"), "violation not reported");
    return "adjustment set audited against the DAG";
});

check("V12", "事后假设 → exploratory，不作确证", () => {
    assert(classifyHypothesis({ statement: "x" }) === "exploratory", "post-hoc hypothesis treated as confirmatory");
    assert(classifyHypothesis({ prereg: { hash: `sha256:${"a".repeat(64)}` } }) === "confirmatory", "preregistered hypothesis misclassified");
    return "preregistration decides the label";
});

check("V13", "来源不蕴含结论 → 不得升 T1", () => {
    const out: TierResult = promoteToT1({ evidence: [{ entails: false }], requested: "T1" });
    assert(out.tier === "T0", `expected T0, got ${out.tier}`);
    return "mention is not entailment";
});

check("V14", "12 次偷看后 p=0.049 → 不升 T2", () => {
    const out: PValueResult = promoteFromP({ p: 0.049, looks: 12 });
    assert(out.promoted === false, "multiple looks were ignored");
    assert(out.tier === "T1", `expected T1, got ${out.tier}`);
    return "looks are part of the claim";
});

check("V15", "无法回答 → 弃权并声明未知", () => {
    const out: AnswerResult = answer({ known: false });
    assert(out.abstain === true, "answered an unanswerable question");
    return "abstention is a first-class outcome";
});

/**
 * ------------------------------------------------------------------
 */

console.log(`\n${Passes} passed, ${Failures} failed`);
if (Failures > 0) {
    process.exitCode = 1;
}
