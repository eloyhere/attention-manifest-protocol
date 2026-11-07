import type {
    Cooperation,
    CooperationBinding,
    CooperationBindingLevel,
    CooperationCloseOutcome,
    CooperationProtocol,
    CooperationRole,
    CooperationRoleAssignment,
    CooperationStatus,
    CooperationTopology,
    IsolationMode,
} from "./types.ts";

export const COOPERATION_TOPOLOGIES = ["star", "mesh", "pipeline", "hierarchical", "consensus"] as const;
export const ISOLATION_MODES = ["isolated", "shared_read", "shared_write_with_lock"] as const;
export const COOPERATION_ROLES = ["coordinator", "worker", "peer", "voter", "stage", "observer"] as const;
export const PROTOCOL_DIMENSIONS = ["goal", "roles", "messages", "timing", "conflicts", "sharing", "convergence"] as const;
export const COOPERATION_STATUSES = [
    "proposed",
    "negotiating",
    "formed",
    "active",
    "paused",
    "stalled",
    "conflicted",
    "renegotiating",
    "converging",
    "completed",
    "partially_completed",
    "failed",
    "dissolved",
    "aborted",
] as const;
export const COOPERATION_INITIAL_STATUSES = ["proposed", "negotiating", "formed", "active"] as const;
export const TERMINAL_COOPERATION_STATUSES = ["completed", "partially_completed", "failed", "dissolved", "aborted"] as const;
export const COOPERATION_BINDING_LEVELS = ["session", "mission", "goal", "plan", "task", "action"] as const;

export type CooperationTopologyDefinition = {
    readonly topology: CooperationTopology;
    readonly description: string;
    readonly minimumParticipants: number;
    readonly requiredRoles: readonly CooperationRole[];
    readonly allowedRoles: readonly CooperationRole[];
    readonly requiresOrderedStages: boolean;
};
export type TopologyKind = CooperationTopologyDefinition["topology"];
/** Declarative topology catalogue; validation is driven by this data, not by switches. */
export const cooperationTopologyDefinitions: Readonly<Record<CooperationTopology, CooperationTopologyDefinition>> = Object.freeze({
    star: { topology: "star", description: "One coordinator distributes work to workers", minimumParticipants: 2, requiredRoles: ["coordinator", "worker"], allowedRoles: ["coordinator", "worker", "observer"], requiresOrderedStages: false },
    mesh: { topology: "mesh", description: "Decentralised peers with no central coordinator", minimumParticipants: 2, requiredRoles: ["peer"], allowedRoles: ["peer", "observer"], requiresOrderedStages: false },
    pipeline: { topology: "pipeline", description: "Ordered stages; each stage hands results to the next", minimumParticipants: 2, requiredRoles: ["stage"], allowedRoles: ["stage", "observer"], requiresOrderedStages: true },
    hierarchical: { topology: "hierarchical", description: "Multi-level coordinators and workers", minimumParticipants: 2, requiredRoles: ["coordinator", "worker"], allowedRoles: ["coordinator", "worker", "observer"], requiresOrderedStages: false },
    consensus: { topology: "consensus", description: "Voters converge by vote or consensus", minimumParticipants: 2, requiredRoles: ["voter"], allowedRoles: ["voter", "observer"], requiresOrderedStages: false },
});
export const TERMINAL_CLOSE_OUTCOMES: readonly CooperationCloseOutcome[] = ["completed", "partially_completed", "failed", "dissolved", "aborted"];

const fail = (message: string): never => {
    throw new TypeError(message);
};
const requireText = (value: unknown, field: string): string => typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);
const requireArray = (value: unknown, field: string): readonly unknown[] => Array.isArray(value) ? value : fail(`${field} must be an array`);
const requireFinite = (value: unknown, field: string): number => typeof value === "number" && Number.isFinite(value) ? value : fail(`${field} must be a finite number`);
const requireInteger = (value: unknown, field: string, minimum = 0): number => Number.isSafeInteger(value) && (value as number) >= minimum ? value as number : fail(`${field} must be a safe integer >= ${minimum}`);
const includesString = (values: readonly string[], value: unknown): boolean => typeof value === "string" && values.includes(value);

/** True when a cooperation can no longer accept tasks, bindings or conflicts. */
export const isTerminalCooperationStatus = (status: CooperationStatus): boolean => (TERMINAL_COOPERATION_STATUSES as readonly string[]).includes(status);

/** The deepest of the six workflow levels present in a binding. */
export const cooperationBindingLevel = (binding: CooperationBinding): CooperationBindingLevel => {
    const candidates: readonly { readonly level: CooperationBindingLevel; readonly id: string | undefined }[] = [
        { level: "action", id: binding.actionId },
        { level: "task", id: binding.taskId },
        { level: "plan", id: binding.planId },
        { level: "goal", id: binding.goalId },
        { level: "mission", id: binding.missionId },
        { level: "session", id: binding.sessionId },
    ];
    return candidates.find(candidate => candidate.id !== undefined)?.level ?? "session";
};

const validateGoalProtocol = (protocol: CooperationProtocol): void => {
    if (!["single", "negotiated", "voted"].includes(protocol.goal.alignment)) fail(`Invalid goal alignment: ${protocol.goal.alignment}`);
    if (!["locked", "coordinator", "consensus"].includes(protocol.goal.revisionPolicy)) fail(`Invalid goal revision policy: ${protocol.goal.revisionPolicy}`);
};
const validateRoleProtocol = (protocol: CooperationProtocol, agentIds: ReadonlySet<string>): void => {
    const assignments = requireArray(protocol.roles.assignments, "Cooperation role assignments") as readonly CooperationRoleAssignment[];
    if (assignments.length === 0) fail("Cooperation requires at least one role assignment");
    if (typeof protocol.roles.requireDistinctArbiter !== "boolean") fail("Cooperation roles.requireDistinctArbiter must be a boolean");
    const assigned = new Set<string>();
    for (const assignment of assignments) {
        const agentId = requireText(assignment.agentId, "Role assignment agentId");
        if (!agentIds.has(agentId)) fail(`Role assignment references unknown participant: ${agentId}`);
        if (assigned.has(agentId)) fail(`Participant has more than one role assignment: ${agentId}`);
        assigned.add(agentId);
        if (!includesString(COOPERATION_ROLES, assignment.role)) fail(`Invalid cooperation role: ${assignment.role}`);
        const responsibilities = requireArray(assignment.responsibilities, `Role responsibilities for ${agentId}`);
        if (responsibilities.length === 0) fail(`Role assignment for ${agentId} requires at least one responsibility`);
        for (const responsibility of responsibilities) requireText(responsibility, `Role responsibility for ${agentId}`);
        if (assignment.stage !== undefined) requireInteger(assignment.stage, `Role stage for ${agentId}`, 1);
        if (assignment.supervisorAgentId !== undefined) requireText(assignment.supervisorAgentId, `Role supervisor for ${agentId}`);
    }
    for (const agentId of agentIds) {
        if (!assigned.has(agentId)) fail(`Cooperation role assignment missing for participant: ${agentId}`);
    }
};
const validateMessageProtocol = (protocol: CooperationProtocol): void => {
    if (!["json", "text"].includes(protocol.messages.format)) fail(`Invalid message format: ${protocol.messages.format}`);
    requireText(protocol.messages.channel, "Message channel");
    requireFinite(protocol.messages.timeoutMs, "Message timeoutMs");
    if (protocol.messages.timeoutMs <= 0) fail("Message timeoutMs must be positive");
    requireInteger(protocol.messages.retries, "Message retries");
    if (!["fifo", "causal", "unordered"].includes(protocol.messages.ordering)) fail(`Invalid message ordering: ${protocol.messages.ordering}`);
    if (typeof protocol.messages.idempotent !== "boolean") fail("Message idempotent must be a boolean");
};
const validateTimingProtocol = (protocol: CooperationProtocol): void => {
    if (!["parallel", "sequential", "staged"].includes(protocol.timing.sequencing)) fail(`Invalid timing sequencing: ${protocol.timing.sequencing}`);
    if (protocol.timing.maxParallelism !== undefined && requireInteger(protocol.timing.maxParallelism, "Timing maxParallelism", 1) < 1) fail("Timing maxParallelism must be positive");
    if (protocol.timing.deadline !== undefined) requireText(protocol.timing.deadline, "Timing deadline");
};
const validateConflictProtocol = (protocol: CooperationProtocol, agentIds: ReadonlySet<string>): void => {
    const arbiterAgentId = requireText(protocol.conflicts.arbiterAgentId, "Conflict arbiterAgentId");
    if (!agentIds.has(arbiterAgentId)) fail(`Conflict arbiter must be a cooperation participant: ${arbiterAgentId}`);
    const escalation = requireArray(protocol.conflicts.escalation, "Conflict escalation");
    if (escalation.length === 0) fail("Conflict escalation requires at least one step");
    for (const step of escalation) {
        if (!["protocol", "cooperation", "level_up", "human"].includes(step as string)) fail(`Invalid conflict escalation step: ${step}`);
    }
    if (typeof protocol.conflicts.requireReason !== "boolean") fail("Conflict requireReason must be a boolean");
};
const validateSharingProtocol = (protocol: CooperationProtocol, isolation: IsolationMode): void => {
    if (!includesString(ISOLATION_MODES, protocol.sharing.isolation)) fail(`Invalid sharing isolation: ${protocol.sharing.isolation}`);
    if (protocol.sharing.isolation !== isolation) fail("Cooperation isolation must match protocol.sharing.isolation");
    if (protocol.sharing.isolation === "shared_write_with_lock" && protocol.sharing.lockScope === undefined) fail("shared_write_with_lock requires a lockScope");
    if (protocol.sharing.lockScope !== undefined && !["file", "region", "workspace"].includes(protocol.sharing.lockScope)) fail(`Invalid lock scope: ${protocol.sharing.lockScope}`);
    if (!["owner", "coordinator", "vote", "none"].includes(protocol.sharing.mergeStrategy)) fail(`Invalid merge strategy: ${protocol.sharing.mergeStrategy}`);
};
const validateConvergenceProtocol = (protocol: CooperationProtocol, participantCount: number): void => {
    if (!["merge", "vote", "consensus", "owner_decision", "quorum"].includes(protocol.convergence.strategy)) fail(`Invalid convergence strategy: ${protocol.convergence.strategy}`);
    if (!["report", "fail", "discard"].includes(protocol.convergence.partialCompletion)) fail(`Invalid partial completion policy: ${protocol.convergence.partialCompletion}`);
    if (protocol.convergence.quorum !== undefined) {
        requireInteger(protocol.convergence.quorum, "Convergence quorum", 1);
        if (protocol.convergence.quorum > participantCount) fail("Convergence quorum cannot exceed participant count");
    }
    if (protocol.convergence.strategy === "quorum" && protocol.convergence.quorum === undefined) fail("Convergence strategy quorum requires a quorum size");
};
const validateTopologyShape = (cooperation: Cooperation, agentIds: ReadonlySet<string>): void => {
    const definition = cooperationTopologyDefinitions[cooperation.topology];
    if (definition === undefined) fail(`Invalid cooperation topology: ${cooperation.topology}`);
    if (cooperation.participants.length < definition.minimumParticipants) fail(`Cooperation topology ${cooperation.topology} requires at least ${definition.minimumParticipants} participants`);
    const assignments = cooperation.protocol.roles.assignments;
    for (const role of definition.requiredRoles) {
        if (!assignments.some(assignment => assignment.role === role)) fail(`Cooperation topology ${cooperation.topology} requires role: ${role}`);
    }
    for (const assignment of assignments) {
        if (!definition.allowedRoles.includes(assignment.role)) fail(`Role ${assignment.role} is not allowed by topology ${cooperation.topology}`);
    }
    const roleCount = (role: CooperationRole): number => assignments.filter(assignment => assignment.role === role).length;
    if (cooperation.topology === "star" || cooperation.topology === "hierarchical") {
        if (roleCount("worker") < 1) fail(`Cooperation topology ${cooperation.topology} requires at least one worker`);
    }
    if (cooperation.topology === "star" && roleCount("coordinator") !== 1) fail("Cooperation topology star requires exactly one coordinator");
    if (cooperation.topology === "hierarchical") {
        const coordinators = assignments.filter(assignment => assignment.role === "coordinator");
        if (coordinators.filter(coordinator => coordinator.supervisorAgentId === undefined).length !== 1) fail("Cooperation topology hierarchical requires exactly one root coordinator");
        for (const coordinator of coordinators) {
            if (coordinator.supervisorAgentId === undefined) continue;
            const supervisor = assignments.find(assignment => assignment.agentId === coordinator.supervisorAgentId);
            if (supervisor?.role !== "coordinator") fail(`Hierarchical coordinator must report to another coordinator: ${coordinator.agentId}`);
        }
    }
    if (cooperation.topology === "mesh" && roleCount("peer") < 2) fail("Cooperation topology mesh requires at least two peers");
    if (cooperation.topology === "consensus" && roleCount("voter") < 2) fail("Cooperation topology consensus requires at least two voters");
    if (cooperation.topology === "hierarchical") {
        const byAgent = new Map(assignments.map(assignment => [assignment.agentId, assignment]));
        for (const assignment of assignments) {
            if (assignment.supervisorAgentId === undefined) continue;
            if (assignment.supervisorAgentId === assignment.agentId) fail(`Role assignment cannot supervise itself: ${assignment.agentId}`);
            if (!agentIds.has(assignment.supervisorAgentId)) fail(`Role supervisor references unknown participant: ${assignment.supervisorAgentId}`);
        }
        for (const start of assignments) {
            const visited = new Set<string>();
            let cursor: CooperationRoleAssignment | undefined = start;
            while (cursor !== undefined) {
                if (visited.has(cursor.agentId)) fail("Cooperation supervisor hierarchy must be acyclic");
                visited.add(cursor.agentId);
                cursor = cursor.supervisorAgentId === undefined ? undefined : byAgent.get(cursor.supervisorAgentId);
            }
        }
    }
    if (definition.requiresOrderedStages) {
        const staged = assignments.filter(assignment => assignment.role === "stage");
        if (staged.length < 2) fail("Cooperation topology pipeline requires at least two stages");
        const stageNumbers = staged.map(assignment => requireInteger(assignment.stage, `Pipeline stage for ${assignment.agentId}`, 1));
        if (new Set(stageNumbers).size !== stageNumbers.length) fail("Cooperation pipeline stages must be unique");
        const ordered = [...stageNumbers].sort((left, right) => left - right);
        if (ordered.some((value, index) => value !== index + 1)) fail("Cooperation pipeline stages must be contiguous starting at 1");
        if (cooperation.protocol.timing.sequencing !== "staged") fail("Pipeline cooperation requires staged sequencing");
    }
    if (cooperation.topology === "consensus") {
        const voters = roleCount("voter");
        const quorum = cooperation.protocol.convergence.quorum;
        if (quorum !== undefined && quorum > voters) fail("Consensus quorum cannot exceed voter count");
        if (cooperation.protocol.convergence.strategy === "quorum" && quorum === undefined) fail("Consensus cooperation with quorum strategy requires a quorum size");
    }
};

/**
 * Validates a Cooperation value, rejecting illegal topologies, missing roles,
 * missing protocol dimensions, missing convergence and unsupported isolation.
 * Throws `TypeError` with a field-specific message and never mutates the input.
 */
export const validateCooperation = (cooperation: Cooperation): void => {
    if (cooperation === null || typeof cooperation !== "object") fail("Cooperation must be an object");
    requireText(cooperation.id, "Cooperation id");
    requireText(cooperation.name, "Cooperation name");
    if (!includesString(COOPERATION_STATUSES, cooperation.status)) fail(`Invalid cooperation status: ${cooperation.status}`);
    if (!includesString(COOPERATION_TOPOLOGIES, cooperation.topology)) fail(`Invalid cooperation topology: ${cooperation.topology}`);
    if (!includesString(ISOLATION_MODES, cooperation.isolation)) fail(`Invalid isolation mode: ${cooperation.isolation}`);
    if (!Number.isSafeInteger(cooperation.version) || cooperation.version < 1) fail("Cooperation version must be a positive integer");
    if (!Array.isArray(cooperation.taskIds) || !Array.isArray(cooperation.messageIds)) fail("Cooperation taskIds and messageIds must be arrays");
    for (const taskId of cooperation.taskIds) requireText(taskId, "Cooperation taskId");
    for (const messageId of cooperation.messageIds) requireText(messageId, "Cooperation messageId");
    if (new Set(cooperation.taskIds).size !== cooperation.taskIds.length) fail("Cooperation taskIds must be unique");
    if (new Set(cooperation.messageIds).size !== cooperation.messageIds.length) fail("Cooperation messageIds must be unique");

    requireText(cooperation.goal?.objective, "Cooperation goal objective");
    const criteria = requireArray(cooperation.goal?.successCriteria, "Cooperation goal successCriteria");
    if (criteria.length === 0) fail("Cooperation goal requires at least one success criterion");
    for (const criterion of criteria) requireText(criterion, "Cooperation success criterion");

    const participants = requireArray(cooperation.participants, "Cooperation participants");
    if (participants.length === 0) fail("Cooperation requires at least one participant");
    const agentIds = new Set<string>();
    for (const participant of participants) {
        const agentId = requireText((participant as { agentId?: unknown }).agentId, "Participant agentId");
        if (agentIds.has(agentId)) fail(`Duplicate cooperation participant: ${agentId}`);
        agentIds.add(agentId);
        const trustLevel = (participant as { trustLevel?: unknown }).trustLevel;
        if (trustLevel !== undefined) {
            requireFinite(trustLevel, `Participant trustLevel for ${agentId}`);
            if ((trustLevel as number) < 0 || (trustLevel as number) > 1) fail(`Participant trustLevel must be between 0 and 1: ${agentId}`);
        }
    }

    const protocol = cooperation.protocol;
    if (protocol === null || typeof protocol !== "object") fail("Cooperation requires a seven-dimension protocol");
    for (const dimension of PROTOCOL_DIMENSIONS) {
        const value = (protocol as unknown as Record<string, unknown>)[dimension];
        if (value === null || value === undefined || typeof value !== "object") fail(`Cooperation protocol is missing dimension: ${dimension}`);
    }
    validateGoalProtocol(protocol);
    validateRoleProtocol(protocol, agentIds);
    validateMessageProtocol(protocol);
    validateTimingProtocol(protocol);
    validateConflictProtocol(protocol, agentIds);
    validateSharingProtocol(protocol, cooperation.isolation);
    validateConvergenceProtocol(protocol, participants.length);
    validateTopologyShape(cooperation, agentIds);
};
