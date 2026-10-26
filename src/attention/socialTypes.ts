/**
 * AMP v0.1 — social objects (Profile `Social`): other-model | common-ground | attention-request.
 * Mirrors docs/schemas/social.schema.json.
 *
 * Everything about another mind is a hypothesis carrying confidence, not a fact (W-1, INV-11).
 */
import type { Confidence, Id, Ref, Timestamp } from "../types/common.ts";

export interface OtherSubject {
    kind: "human" | "agent";
    id: Id;
    label?: string;
}

export interface BeliefAscription {
    slot: Id;
    /**
     * 1 = "A believes P" · 2 = "A believes B believes P". Depth above 2 is computed from records, not elicited.
     */
    order: 1 | 2 | 3;
    proposition: string;
    confidence: Confidence;
    source: string;
    volatility: "low" | "medium" | "high";
    ttl: number;
}

export interface GoalAscription {
    goal: string;
    priority: number;
    confidence: Confidence;
}

export interface KnowledgeState {
    known?: Ref[];
    unknown?: Ref[];
    uncertain?: Ref[];
}

export interface Preference {
    key: string;
    value: string;
    confidence: Confidence;
    source?: string;
}

export interface AttentionState {
    state: "idle" | "busy" | "interruptible";
    load?: Confidence;
    last_interaction?: Timestamp;
}

export interface TrustAssessment {
    domain?: string;
    level: Confidence;
    basis?: string;
}

export interface Privacy {
    scope: "turn" | "session" | "task" | "persistent";
    retention_days?: number;
    redact?: string[];
}

export interface OtherModel {
    amp: "0.1";
    kind: "other-model";
    id: Id;
    subject: OtherSubject;
    beliefs: BeliefAscription[];
    goals?: GoalAscription[];
    knowledge?: KnowledgeState;
    preferences?: Preference[];
    attention?: AttentionState;
    trust?: TrustAssessment;
    common_ground?: Ref[];
    privacy: Privacy;
    confidence: Confidence;
    updated: Timestamp;
}

export interface CommonGround {
    amp: "0.1";
    kind: "common-ground";
    id: Id;
    proposition: string;
    /**
     * Only the first four actually establish common ground.
     */
    established_by: "assertion" | "confirmation" | "repair" | "shared_observation" | "assumption";
    participants: Ref[];
    confidence: Confidence;
    established_at: Timestamp;
}

export type InterruptClass = "safety" | "commitment" | "opportunity" | "curiosity";

export interface AttentionRequest {
    amp: "0.1";
    kind: "attention-request";
    id: Id;
    from: Ref;
    to: Ref;
    target: Ref;
    class: InterruptClass;
    urgency: 1 | 2 | 3 | 4 | 5;
    why_now: string;
    if_ignored: string;
    cost: import("../types/common.ts").Budget;
    expected_value?: Confidence;
    expires?: Timestamp;
    fallback: "queue" | "drop" | "escalate";
}

export type SocialObject = OtherModel | CommonGround | AttentionRequest;
