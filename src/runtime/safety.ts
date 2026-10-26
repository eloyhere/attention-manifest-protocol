/**
 * Safety gates for interaction output.
 *
 * These are conservative, pattern-based guards, not a classifier. They block
 * clear crisis/diagnosis/manipulation cases and leave the final judgment to a
 * human escalation path. They must not be treated as medical advice.
 */
import type { InteractionPlan } from "../interaction/interaction.ts";

export type SafetyAction = "allow" | "refuse" | "escalate";

export interface SafetyDecision {
    action: SafetyAction;
    reasons: string[];
}

const crisisPatterns = [
    /\b(suicide|suicidal|kill myself|end my life|self[- ]?harm|hurt myself|overdose)\b/i,
    /\b(immediate danger|emergency|someone is going to hurt me)\b/i,
];

const diagnosisPatterns = [/\byou (have|are diagnosed with|suffer from) (depression|anxiety disorder|bipolar|ptsd|adhd|autism)\b/i, /\byour diagnosis is\b/i];

const manipulationPatterns = [/\byou (only )?need me\b/i, /\bdon't (leave|trust anyone else)\b/i, /\bonly I (understand|can help) you\b/i];

export const checkSafety = (userText: string, interaction: InteractionPlan, answerText = ""): SafetyDecision => {
    const reasons: string[] = [];
    if (crisisPatterns.some((pattern) => pattern.test(userText))) {
        reasons.push("user text contains a crisis/self-harm signal");
        return { action: "escalate", reasons };
    }
    if (interaction.safety.noDiagnosis && diagnosisPatterns.some((pattern) => pattern.test(answerText))) {
        reasons.push("answer makes a diagnosis while the interaction forbids it");
        return { action: "refuse", reasons };
    }
    if (interaction.safety.noManipulation && manipulationPatterns.some((pattern) => pattern.test(answerText))) {
        reasons.push("answer uses dependency/manipulation language");
        return { action: "refuse", reasons };
    }
    return { action: "allow", reasons };
};

export const safetyFallback = (action: SafetyAction): string => {
    if (action === "escalate") {
        return "This sounds like an immediate safety concern. Please contact local emergency services or a crisis line now, and reach out to a trusted person who can stay with you. I can stay with you here, but I cannot replace emergency help.";
    }
    return "I cannot help with that framing. I can offer a safer, evidence-based alternative if you want to continue.";
};
