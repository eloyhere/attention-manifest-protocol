/**
 * Responsibility and interaction assignment types.
 *
 * These mirror `docs/schemas/responsibility.schema.json` and
 * `docs/schemas/interaction.schema.json`. The runtime ledgers in
 * `assign.ts` and `binding.ts` own validation and lifecycle; this module
 * owns only the wire shapes.
 */
import type { Budget, Criterion, Digest, Id, Ref, Signature, Tier, Timestamp } from "../types/common.ts";
import type { InteractionKind } from "../interaction/interaction.ts";
import type { Performative } from "../protocol/protocol.ts";

export type { Performative };

export type AssignmentStatus = "proposed" | "accepted" | "declined" | "active" | "blocked" | "discharged" | "breached" | "revoked" | "expired";

export type AssignmentAcceptanceState = "pending" | "accepted" | "declined";

/**
 * One observable unit of responsibility. `conflicts_with` is a separation-of-
 * duties edge: the referenced duty may not be held by the same assignee while
 * the two windows overlap.
 */
export interface Duty {
    id: Id;
    statement: string;
    scope: string[];
    acceptance: Criterion[];
    evidence_required?: string[];
    conflicts_with?: Id[];
    delegable?: boolean;
}

/**
 * RACI vocabulary. `accountable` is a single id by construction; the ledger
 * additionally rejects two active assignments that claim the same duty.
 */
export interface Raci {
    accountable: Id;
    responsible: Id[];
    consulted?: Id[];
    informed?: Id[];
}

export interface AssignmentAcceptance {
    required: boolean;
    state: AssignmentAcceptanceState;
    by?: Id;
    at?: Timestamp;
    digest?: Digest;
    note?: string;
}

export interface AssignmentEvidence {
    required: string[];
    produced: Ref[];
}

export interface AssignmentWindow {
    from: Timestamp;
    to: Timestamp;
}

export interface ResponsibilityAssignment {
    amp: "0.1";
    kind: "responsibility-assignment";
    id: Id;
    version: number;
    parent?: Id;
    assigner: Id;
    assignee: Id;
    role?: string;
    duties: Duty[];
    raci?: Raci;
    authority: string[];
    budget: Budget;
    window: AssignmentWindow;
    acceptance?: AssignmentAcceptance;
    evidence?: AssignmentEvidence;
    out_of_scope?: string[];
    delegable: boolean;
    depth: number;
    status: AssignmentStatus;
    why: string;
    created: Timestamp;
    digest?: Digest;
    signatures?: Signature[];
}

export type BindingStatus = "proposed" | "active" | "suspended" | "closed" | "breached" | "revoked";

export type BindingDirection = "one-way" | "request-response" | "duplex" | "broadcast";

export type ProtocolRole = "initiator" | "responder" | "observer";

export type ChannelKind = "local" | "a2a" | "mcp" | "http" | "human";

export type EscalationWhen = "timeout" | "authority_exceeded" | "conflict" | "budget_exhausted" | "integrity_failure" | "manual";

export type BindingFallback = "queue" | "drop" | "escalate";

export interface ProtocolRoleBinding {
    party: Id;
    role: ProtocolRole;
}

export interface InteractionProtocol {
    id: string;
    version: string;
    roles: ProtocolRoleBinding[];
}

export interface InteractionChannel {
    kind: ChannelKind;
    endpoint?: string;
    auth?: "none" | "ed25519" | "oauth" | "mtls";
}

export interface InteractionCadence {
    max_turns: number;
    max_messages: number;
    response_within_ms: number;
    interval_ms?: number;
}

export interface InteractionExpectations {
    format?: string;
    language?: string;
    evidence_tier?: Tier;
}

export interface InteractionEscalation {
    when: EscalationWhen;
    to: Id;
    within_ms: number;
    fallback?: BindingFallback;
}

export interface InteractionHandoff {
    required_state: Ref[];
    acceptance: "ack" | "receipt";
}

export interface InteractionBinding {
    amp: "0.1";
    kind: "interaction-binding";
    id: Id;
    version: number;
    assignment?: Id;
    parties: Id[];
    purpose: Ref;
    channel: InteractionChannel;
    protocol: InteractionProtocol;
    mode_mix: Partial<Record<InteractionKind, number>>;
    direction: BindingDirection;
    cadence: InteractionCadence;
    expectations?: InteractionExpectations;
    escalation?: InteractionEscalation[];
    handoff?: InteractionHandoff;
    budget?: Budget;
    status: BindingStatus;
    why: string;
    created: Timestamp;
    digest?: Digest;
    signatures?: Signature[];
}

export type AssignmentEventType =
    | "assignment.proposed"
    | "assignment.accepted"
    | "assignment.declined"
    | "assignment.activated"
    | "assignment.blocked"
    | "assignment.resumed"
    | "assignment.discharged"
    | "assignment.breached"
    | "assignment.revoked"
    | "assignment.expired";

export interface AssignmentEvent {
    type: AssignmentEventType;
    assignment: Id;
    at: Timestamp;
    by: Id;
    reason?: string;
    digest?: Digest;
}

export type BindingEventType =
    | "binding.proposed"
    | "binding.acked"
    | "binding.activated"
    | "binding.suspended"
    | "binding.resumed"
    | "binding.message"
    | "binding.escalated"
    | "binding.handoff"
    | "binding.closed"
    | "binding.breached"
    | "binding.revoked";

export interface BindingEvent {
    type: BindingEventType;
    binding: Id;
    at: Timestamp;
    by: Id;
    reason?: string;
    digest?: Digest;
}

export interface BindingMessageRecord {
    binding: Id;
    sequence: number;
    from: Id;
    to: Id;
    performative: Performative;
    at: Timestamp;
}
