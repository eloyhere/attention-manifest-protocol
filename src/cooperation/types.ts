import type { Identifier, JsonValue } from "../shared.ts";
import type { PermissionScope } from "../profession/types.ts";
export type Clock = () => string;
export type DelegatedTaskState = "delegated" | "running" | "cancel_requested" | "cancelled" | "completed" | "failed" | "unknown_outcome";
export type DelegatedTask = { readonly taskId: Identifier; readonly parentTaskId?: Identifier; readonly cooperationId: Identifier; readonly delegatorAgentId: Identifier; readonly ownerAgentId: Identifier; readonly ownerEpoch: number; readonly fence: string; readonly effectiveScope: PermissionScope; readonly state: DelegatedTaskState; readonly createdAt: string; readonly updatedAt: string; readonly cancellationReason?: string };
export type DelegationRequest = { readonly taskId: Identifier; readonly parentTaskId?: Identifier; readonly cooperationId?: Identifier; readonly delegatorAgentId: Identifier; readonly ownerAgentId: Identifier; readonly parentScope: PermissionScope; readonly requestedScope: PermissionScope };
export type ProvenanceRecord = { readonly sourceId: Identifier; readonly sourceType: "agent" | "tool" | "user" | "external" | "derived"; readonly authorityScope?: readonly string[]; readonly chain: readonly Identifier[]; readonly taint: readonly string[] };
export type ResultSubmission = { readonly taskId: Identifier; readonly ownerAgentId: Identifier; readonly ownerEpoch: number; readonly fence: string; readonly outcome: "success" | "failure" | "unknown_outcome"; readonly value?: JsonValue; readonly provenance: readonly ProvenanceRecord[] };
export type ResultAcceptance = { readonly accepted: boolean; readonly reason: "accepted" | "unknown_task" | "not_owner" | "stale_epoch" | "stale_fence" | "cancelled" | "already_settled"; readonly task?: DelegatedTask };
export type MessageKind = "trustedInstruction" | "untrustedData";
/**
 * A message sent between cooperation participants. `cooperationId` is optional on
 * input for compatibility; the coordinator always stamps the owning cooperation.
 */
export type CooperationMessage = { readonly messageId: Identifier; readonly taskId: Identifier; readonly cooperationId?: Identifier; readonly senderAgentId: Identifier; readonly recipientAgentId: Identifier; readonly kind: MessageKind; readonly payload: JsonValue; readonly provenance: readonly ProvenanceRecord[]; readonly sentAt: string };

/** Five topologies from the collaboration model (declarative form). */
export type CooperationTopology = "star" | "mesh" | "pipeline" | "hierarchical" | "consensus";
export type IsolationMode = "isolated" | "shared_read" | "shared_write_with_lock";
export type CooperationStatus =
    | "proposed"
    | "negotiating"
    | "formed"
    | "active"
    | "paused"
    | "stalled"
    | "conflicted"
    | "renegotiating"
    | "converging"
    | "completed"
    | "partially_completed"
    | "failed"
    | "dissolved"
    | "aborted";
export type CooperationInitialStatus = "proposed" | "negotiating" | "formed" | "active";
export type CooperationCloseOutcome = "completed" | "partially_completed" | "failed" | "dissolved" | "aborted";
export type CooperationGoal = { readonly objective: string; readonly successCriteria: readonly string[] };
export type CooperationParticipant = { readonly agentId: Identifier; readonly trustLevel?: number };
export type CooperationRole = "coordinator" | "worker" | "peer" | "voter" | "stage" | "observer";
export type CooperationRoleAssignment = {
    readonly agentId: Identifier;
    readonly role: CooperationRole;
    readonly responsibilities: readonly string[];
    readonly stage?: number;
    readonly supervisorAgentId?: Identifier;
};

/** Dimension 1: how the shared goal is agreed and revised. */
export type GoalProtocol = { readonly alignment: "single" | "negotiated" | "voted"; readonly revisionPolicy: "locked" | "coordinator" | "consensus" };
/** Dimension 2: who does what. Every participant must be assigned exactly once. */
export type RoleProtocol = { readonly assignments: readonly CooperationRoleAssignment[]; readonly requireDistinctArbiter: boolean };
/** Dimension 3: message format, channel, timeouts, retries, ordering and idempotence. */
export type MessageProtocol = { readonly format: "json" | "text"; readonly channel: string; readonly timeoutMs: number; readonly retries: number; readonly ordering: "fifo" | "causal" | "unordered"; readonly idempotent: boolean };
/** Dimension 4: sequencing and parallelism. */
export type TimingProtocol = { readonly sequencing: "parallel" | "sequential" | "staged"; readonly deadline?: string; readonly maxParallelism?: number };
export type ConflictEscalation = "protocol" | "cooperation" | "level_up" | "human";
/** Dimension 5: who arbitrates and how conflicts escalate. */
export type ConflictProtocol = { readonly arbiterAgentId: Identifier; readonly escalation: readonly ConflictEscalation[]; readonly requireReason: boolean };
/** Dimension 6: isolation mode plus merge and lock policy. */
export type SharingProtocol = { readonly isolation: IsolationMode; readonly lockScope?: "file" | "region" | "workspace"; readonly mergeStrategy: "owner" | "coordinator" | "vote" | "none" };
/** Dimension 7: how partial results converge. */
export type ConvergenceProtocol = { readonly strategy: "merge" | "vote" | "consensus" | "owner_decision" | "quorum"; readonly quorum?: number; readonly partialCompletion: "report" | "fail" | "discard" };

/** The seven-dimension collaboration protocol from refract §10.7. */
export type CooperationProtocol = {
    readonly goal: GoalProtocol;
    readonly roles: RoleProtocol;
    readonly messages: MessageProtocol;
    readonly timing: TimingProtocol;
    readonly conflicts: ConflictProtocol;
    readonly sharing: SharingProtocol;
    readonly convergence: ConvergenceProtocol;
};

/** First-class Cooperation object (refract §10.4). */
export type Cooperation = {
    readonly id: Identifier;
    readonly name: string;
    readonly summary?: string;
    readonly goal: CooperationGoal;
    readonly participants: readonly CooperationParticipant[];
    readonly isolation: IsolationMode;
    readonly topology: CooperationTopology;
    readonly protocol: CooperationProtocol;
    readonly status: CooperationStatus;
    readonly version: number;
    readonly taskIds: readonly Identifier[];
    readonly messageIds: readonly Identifier[];
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly closedAt?: string;
    readonly closeReason?: string;
};
export type CreateCooperationInput = {
    readonly id: Identifier;
    readonly name: string;
    readonly summary?: string;
    readonly goal: CooperationGoal;
    readonly participants: readonly CooperationParticipant[];
    /** Defaults to `protocol.sharing.isolation`. */
    readonly isolation?: IsolationMode;
    readonly topology: CooperationTopology;
    readonly protocol: CooperationProtocol;
    /** Defaults to `formed`; terminal states can only be reached through `close`. */
    readonly status?: CooperationInitialStatus;
};

/** Six binding levels from refract §10.10 plus the cooperation id itself. */
export type CooperationBindingLevel = "session" | "mission" | "goal" | "plan" | "task" | "action";
export type CooperationBindingInput = {
    readonly cooperationId: Identifier;
    readonly sessionId: Identifier;
    readonly missionId?: Identifier;
    readonly goalId?: Identifier;
    readonly planId?: Identifier;
    readonly taskId?: Identifier;
    readonly actionId?: Identifier;
};
export type CooperationBinding = CooperationBindingInput & { readonly boundAt: string };

export type CooperationConflictType = "resource" | "result" | "intent" | "protocol_violation" | "budget" | "topology";
export type ArbitrationOutcome = "favor_reporter" | "favor_respondent" | "split" | "no_action" | "escalate_to_human" | "reassign";
export type ConflictReportInput = {
    readonly conflictId: Identifier;
    readonly cooperationId: Identifier;
    readonly type: CooperationConflictType;
    readonly parties: readonly Identifier[];
    readonly description: string;
    readonly reportedBy: Identifier;
};
/** A decision always needs a reason; the coordinator rejects empty reasons. */
export type ArbitrationDecision = { readonly arbiter: Identifier; readonly outcome: ArbitrationOutcome; readonly reason: string };
/** Immutable arbitration record; a conflict can be arbitrated only once. */
export type ArbitrationRecord = {
    readonly arbitrationId: Identifier;
    readonly conflictId: Identifier;
    readonly cooperationId: Identifier;
    readonly arbiter: Identifier;
    readonly outcome: ArbitrationOutcome;
    readonly reason: string;
    readonly decidedAt: string;
    readonly frozen: true;
};
export type CooperationConflict = {
    readonly conflictId: Identifier;
    readonly cooperationId: Identifier;
    readonly type: CooperationConflictType;
    readonly parties: readonly Identifier[];
    readonly description: string;
    readonly reportedBy: Identifier;
    readonly reportedAt: string;
    readonly status: "open" | "arbitrated";
    readonly arbitration?: ArbitrationRecord;
};

/** Pure in-memory facts; restoring never reads the clock or starts work. */
export type CooperationSnapshot = {
    readonly schemaVersion: 1;
    readonly cooperations: readonly Cooperation[];
    readonly tasks: readonly DelegatedTask[];
    readonly messages: readonly CooperationMessage[];
    readonly bindings: readonly CooperationBinding[];
    readonly conflicts: readonly CooperationConflict[];
    readonly arbitrations: readonly ArbitrationRecord[];
};
