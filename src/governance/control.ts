/**
 * The Bayesian control layer (spec section 6).
 *
 * The posterior does not generate text. It routes attention: it changes mode
 * weights, shrinks or expands the focus set, assigns budget to the observation
 * with the highest information value, and decides when to stop or escalate.
 *
 * Posterior uncertainty raises divergence; confidence raises convergence;
 * evidence conflict raises thinking and may be forced by legal. Probabilities
 * are clamped to [0.001, 0.999] so no single observation can claim certainty.
 */
import type { BetaBelief } from "../bayes/engine.ts";
import { betaMean, betaVariance } from "../bayes/engine.ts";
import type { ModeId, ModeWeights, PerspectiveId, ScenarioId } from "./types.ts";
import { GovernanceError, ModeIds } from "./types.ts";
import { driftRequiresApproval, normalizeModeWeights } from "./matrix.ts";

export interface ControlObservation {
    scenario: ScenarioId;
    modes: ModeWeights;
    /**
     * The posterior over "this turn is adequate". Alpha/beta counts.
     */
    posterior: BetaBelief;
    /**
     * Set when two evidence items disagree materially.
     */
    conflict?: boolean;
    /**
     * Legal can force the thinking mode on regardless of the posterior.
     */
    legalOverride?: boolean;
    /**
     * Estimated value of the next observation, in [0, 1].
     */
    voi?: number;
    frame?: number;
    openQuestions?: number;
}

export interface ControlBudget {
    nextObservationShare: number;
    reason: string;
}

export interface ControlDecision {
    modes: ModeWeights;
    action: "expand" | "hold" | "shrink";
    stop: boolean;
    escalate: boolean;
    escalateTo?: PerspectiveId;
    budget: ControlBudget;
    approvalRequired: boolean;
    mean: number;
    uncertainty: number;
    rationale: string[];
}

export interface ProbabilityRange {
    min: number;
    max: number;
}

export const ProbabilityClamp: ProbabilityRange = { min: 0.001, max: 0.999 };

const clampProbability: (value: number) => number = (value: number): number =>
    Math.max(ProbabilityClamp.min, Math.min(ProbabilityClamp.max, Number.isFinite(value) ? value : ProbabilityClamp.min));

/**
 * One control step. Pure: the caller applies the weights through the manifest
 * update path, where approvals are enforced.
 */
export const decideControl: (observation: ControlObservation) => ControlDecision = (observation: ControlObservation): ControlDecision => {
    if (
        !Number.isFinite(observation.posterior.alpha) ||
        !Number.isFinite(observation.posterior.beta) ||
        observation.posterior.alpha <= 0 ||
        observation.posterior.beta <= 0
    ) {
        throw new GovernanceError("probability-invalid", "the posterior alpha and beta must be finite and positive");
    }
    const mean: number = clampProbability(betaMean(observation.posterior));
    const variance: number = betaVariance(observation.posterior);
    const uncertainty: number = Math.min(1, Math.max(0, Math.sqrt(Math.max(0, Number.isFinite(variance) ? variance : 0)) * 2));
    const next: ModeWeights = { ...observation.modes };
    const rationale: string[] = [`posterior mean ${mean.toFixed(2)}, uncertainty ${uncertainty.toFixed(2)}`];

    if (uncertainty > 0.2) {
        const delta: number = 0.1 * Math.min(1, uncertainty * 2.5);
        next.diverge += delta;
        rationale.push(`uncertainty ${uncertainty.toFixed(2)} raises divergence by ${delta.toFixed(2)}`);
    }
    if (mean > 0.8 && uncertainty < 0.2) {
        next.converge += 0.1;
        rationale.push(`confidence ${mean.toFixed(2)} raises convergence by 0.10`);
    }
    if (observation.conflict === true) {
        next.think += 0.15;
        rationale.push("evidence conflict raises thinking by 0.15; the posterior overrides the prior");
    }
    const forced: boolean = observation.legalOverride === true;
    if (forced) {
        next.think += 0.2;
        rationale.push("legal forced the thinking mode on");
    }
    const modes: ModeWeights = normalizeModeWeights(next);
    const approvalRequired: boolean = driftRequiresApproval(observation.modes, modes);
    if (approvalRequired) {
        rationale.push("the adjustment exceeds 0.15 and needs the general manager's approval");
    }

    const action: ControlDecision["action"] = uncertainty > 0.2 ? "expand" : mean > 0.8 && uncertainty < 0.2 ? "shrink" : "hold";
    const voi: number = Math.max(0, Math.min(1, observation.voi ?? 0));
    const share: number = action === "expand" ? Math.max(0.1, Math.min(0.5, 0.1 + voi * 0.4)) : 0.05;
    const stop: boolean = mean >= 0.9 && uncertainty < 0.1 && (observation.openQuestions ?? 0) === 0 && voi < 0.05;
    if (stop) {
        rationale.push("high confidence, no open question and low information value: stop");
    }
    const escalate: boolean = forced || uncertainty > 0.45 || (observation.conflict === true && mean < 0.6);
    let escalateTo: PerspectiveId | undefined;
    if (escalate) {
        escalateTo = forced ? "legal" : uncertainty > 0.45 ? "supervisory" : "general-manager";
        rationale.push(
            `escalate to ${escalateTo}: ${forced ? "legal override" : uncertainty > 0.45 ? "residual uncertainty" : "unresolved evidence conflict"}`,
        );
    }
    return {
        modes,
        action,
        stop,
        escalate,
        ...(escalateTo === (void 0) ? {} : { escalateTo }),
        budget: {
            nextObservationShare: share,
            reason: action === "expand" ? `information value ${voi.toFixed(2)} keeps an exploratory share` : "confidence allows a narrow share",
        },
        approvalRequired,
        mean,
        uncertainty,
        rationale,
    };
};

/**
 * The mode with the largest positive change, for receipts and audit lines.
 */
export const changedMode: (from: ModeWeights, to: ModeWeights) => ModeId = (from: ModeWeights, to: ModeWeights): ModeId => {
    let best: ModeId = ModeIds[0];
    let delta: number = -1;
    for (let index: number = 0; index < ModeIds.length; index += 1) {
        const mode: ModeId = ModeIds[index];
        const change: number = to[mode] - from[mode];
        if (change > delta) {
            best = mode;
            delta = change;
        }
    }
    return best;
};
