/**
 * Lightweight routing from text/user state to scenario and interaction mixes.
 *
 * This is a rule-based prior, not a classifier. It exists so the runtime has a
 * complete loop; later it should be replaced/calibrated by the Bayesian engine
 * and real receipts.
 */
import type { UserScore } from "../bayes/engine.ts";
import type { InteractionMix } from "../interaction/interaction.ts";
import type { ScenarioMix } from "../scenario/scenario.ts";

const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

export const inferScenarioMix = (text: string): ScenarioMix => {
    const engineering = count(text, /\b(code|bug|typescript|javascript|api|sql|deploy|test|build|refactor|stack|error)\b/gi);
    const research = count(text, /\b(paper|study|literature|hypothesis|evidence|theory|experiment|survey)\b/gi);
    const investigation = count(text, /\b(incident|root cause|audit|forensic|postmortem|timeline|outage)\b/gi);
    const office = count(text, /\b(email|schedule|meeting|document|calendar|report|deadline|stakeholder)\b/gi);
    const writing = count(text, /\b(write|draft|rewrite|edit|style|tone|copy|article)\b/gi);
    const collaboration = count(text, /\b(team|coordinate|handoff|review|pair|collaborate|sync|owner)\b/gi);
    const iteration = count(text, /\b(iterate|version|prototype|quick|try|loop|experiment)\b/gi);
    const chat = count(text, /\b(hi|hello|thanks|feel|feeling|tired|overwhelmed|anxious|happy|sad)\b/gi);

    const scores: Array<[string, number]> = [
        ["engineering", engineering],
        ["research", research],
        ["investigation", investigation],
        ["office", office],
        ["writing", writing],
        ["collaboration", collaboration],
        ["iteration", iteration],
        ["chat", chat],
    ];
    scores.sort((left, right) => right[1] - left[1]);
    if (scores[0][1] === 0) {
        return { office: 0.2, collaboration: 0.2, engineering: 0.2, chat: 0.2, writing: 0.2 };
    }
    const top = scores.filter(([, score]) => score > 0).slice(0, 3);
    const total = top.reduce((sum, [, score]) => sum + score, 0);
    const mix: ScenarioMix = {};
    for (const [kind, score] of top) {
        mix[kind as keyof ScenarioMix] = score / total;
    }
    return mix;
};

export const inferInteractionMix = (user: UserScore): InteractionMix => {
    if (user.state.emotionalIntensity > 0.6) {
        return { affect: 0.55, think: 0.2, converge: 0.2, inspire: 0.05 };
    }
    if (user.state.urgency > 0.6) {
        return { converge: 0.55, think: 0.25, affect: 0.2 };
    }
    if (user.dimensions.clarity.mean < 0.4) {
        return { inspire: 0.45, affect: 0.25, think: 0.3 };
    }
    return { think: 0.55, converge: 0.25, orchestrate: 0.2 };
};
