/**
 * AMP v0.1 — protocol surfaces: message envelope (A-surface) and model verbs (M-surface).
 * Mirrors docs/schemas/message.schema.json and docs/schemas/verb.schema.json.
 */
import type { Budget, Id, Ref, Signature, Tier, Timestamp } from "../types/common.ts";
import type { InterruptClass } from "../attention/socialTypes.ts";

/* ------------------------------- A-surface ------------------------------- */

export type Performative = "inform" | "request" | "propose" | "commit" | "decline" | "cancel" | "release";

/**
 * Closed error enum. `retryable` is a property of the code, not of the message.
 */
export type ErrorCode = "denied" | "unavailable" | "invalid" | "expired" | "conflict" | "budget_exceeded" | "unsupported" | "internal";

export interface MessagePayload {
    claim?: Ref;
    warrant?: Ref;
    target?: Ref;
    class?: InterruptClass;
    why_now?: string;
    if_ignored?: string;
    cost?: Budget;
    proposal?: string;
    ref?: Ref;
    request?: Id;
    reason?: string;
    code?: ErrorCode;
    note?: string;
}

/**
 * One envelope, seven performatives. Every field is observable; nothing encodes sincerity.
 */
export interface Message {
    amp: "0.1";
    kind: "message";
    id: Id;
    type: Performative;
    from: Ref;
    to: Ref;
    thread: Id;
    reply_to?: Id;
    sent: Timestamp;
    ttl?: number;
    payload: MessagePayload;
    signature?: Signature;
}

/* ------------------------------- M-surface ------------------------------- */

export type VerbName = "attend" | "plan" | "act" | "ask" | "note" | "reflect" | "read";

export interface ExpectationCall {
    observation: string;
    check: string;
}

export interface AttendCall {
    amp: "0.1";
    kind: "call";
    verb: "attend";
    id?: Id;
    target: Ref;
    why: string;
    budget?: Budget;
}

export interface PlanCall {
    amp: "0.1";
    kind: "call";
    verb: "plan";
    id?: Id;
    goal: Ref;
    process?: Ref;
    mode?: "draft" | "commit";
}

export interface ActCall {
    amp: "0.1";
    kind: "call";
    verb: "act";
    id?: Id;
    action: string;
    ref?: Ref;
    args?: Record<string, unknown>;
    expect?: ExpectationCall;
    budget?: Budget;
}

export interface AskCall {
    amp: "0.1";
    kind: "call";
    verb: "ask";
    id?: Id;
    question: string;
    to?: Ref;
    class?: InterruptClass;
    urgency?: 1 | 2 | 3 | 4 | 5;
    expires?: Timestamp;
}

export interface NoteCall {
    amp: "0.1";
    kind: "call";
    verb: "note";
    id?: Id;
    assertion: string;
    as: "claim" | "hypothesis" | "unknown" | "concept";
    /**
     * May be proposed; the Warrant Engine may reject or lower it (W-5).
     */
    tier?: Tier;
    evidence?: Ref[];
    refutes_if?: string;
    label?: string;
}

export interface ReflectCall {
    amp: "0.1";
    kind: "call";
    verb: "reflect";
    id?: Id;
    scope?: "turn" | "task" | "session";
}

export interface ReadCall {
    amp: "0.1";
    kind: "call";
    verb: "read";
    id?: Id;
    handle: string;
    cursor: number;
    limit?: number;
}

export type VerbCall = AttendCall | PlanCall | ActCall | AskCall | NoteCall | ReflectCall | ReadCall;
