import type { Identifier, JsonValue } from "../shared.ts";
import { safeStringify } from "../serialization/index.ts";
import { mergeIsolationChanges } from "./isolation.ts";
import type {
    ConflictEscalation,
    Cooperation,
    CooperationIsolationAdapter,
    CooperationRoleAssignment,
    CooperationTopology,
    DelegatedTask,
    IsolationChange,
    IsolationMergedContent,
    IsolationMergeConflict,
    IsolationMergeReceipt,
    IsolationMergeResult,
    IsolationSyntaxFinding,
} from "./types.ts";
import { validateCooperation } from "./validation.ts";

/**
 * Cooperation execution kernel for the five topology shapes (refract §10.6):
 *
 * - `star`: one coordinator serializes every task (single in-flight task).
 * - `mesh`: all peers start their tasks together (parallel).
 * - `pipeline`: tasks execute stage by stage; each stage sees prior results.
 * - `hierarchical`: top-level coordinator subtrees run in parallel, while each
 *   subtree remains serial under its own coordinator.
 * - `consensus`: every voter independently executes the task; the plurality of
 *   votes wins, and a tie or missing quorum is escalated to a human.
 *
 * All result contributions go through `isolation.merge` (``mergeIsolationChanges``
 * by default), never a partial write. The batch becomes one `merge_receipt` with
 * the merged changes and every detected conflict. Conflicts are escalated at
 * Level 4 (human) and never silently resolved by this kernel.
 */
export type TaskExecutionOutcome = "success" | "failure" | "unknown_outcome";

export interface TopologyExecutionAssignment {
    readonly cooperationId: Identifier;
    readonly topology: CooperationTopology;
    /** Agent that executes this task (task owner, voter, or stage owner). */
    readonly agentId: Identifier;
    /** Owner recorded on the delegated task. */
    readonly ownerAgentId: Identifier;
    readonly coordinatorAgentId?: Identifier;
    readonly supervisorAgentId?: Identifier;
    readonly stage?: number;
    readonly level?: number;
    /** Results already produced in this topology slice (pipeline/hierarchy). */
    readonly prior?: readonly TopologyTaskResult[];
}

export interface TopologyTaskResult {
    readonly taskId: Identifier;
    readonly agentId: Identifier;
    readonly outcome: TaskExecutionOutcome;
    readonly value?: JsonValue;
    readonly changes?: readonly IsolationChange[];
}

export type CooperationEscalationReason = "merge_conflict" | "consensus_tie" | "consensus_quorum_unmet";

/** Level 4 human escalation; Level 1-3 remain host/cooperation concerns. */
export interface CooperationEscalation {
    readonly escalationId: Identifier;
    readonly cooperationId: Identifier;
    readonly level: "human";
    readonly reason: CooperationEscalationReason;
    readonly taskIds: readonly Identifier[];
    readonly changeIds: readonly string[];
    readonly agents: readonly Identifier[];
    readonly detail: string;
    readonly escalationPath: readonly ConflictEscalation[];
}

/** Receipt-kind `merge_receipt` is the shared cooperation-domain receipt. */
export type MergeReceipt = IsolationMergeReceipt;

export interface TopologyExecutionResult {
    readonly cooperationId: Identifier;
    readonly topology: CooperationTopology;
    /** Results ordered exactly like the input tasks. */
    readonly executions: readonly TopologyTaskResult[];
    /** Atomic merge result; `merged` is empty whenever `conflicts` is nonempty. */
    readonly merge: IsolationMergeResult;
    readonly mergeReceipt: MergeReceipt;
    readonly escalations: readonly CooperationEscalation[];
    readonly status: "completed" | "partially_completed" | "failed";
    readonly startedAt: string;
    readonly completedAt: string;
}

/** Host ports; execution itself is injected so the kernel performs no IO. */
export interface TopologyExecutionPorts {
    readonly execute: (task: DelegatedTask, assignment: TopologyExecutionAssignment) => TopologyTaskResult | Promise<TopologyTaskResult>;
    /** Lock + merge port; defaults to the in-memory `mergeIsolationChanges`. */
    readonly isolation?: Pick<CooperationIsolationAdapter, "merge">;
    /** Receives every Level 4 human escalation. */
    readonly escalate?: (escalation: CooperationEscalation) => void;
    readonly clock?: () => string;
    readonly receiptId?: (cooperationId: Identifier) => Identifier;
}

const OUTCOMES: readonly TaskExecutionOutcome[] = ["success", "failure", "unknown_outcome"];
const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must be a nonempty string`);
    return value;
};
const freezeChange = (change: IsolationChange): IsolationChange => Object.freeze({
    ...change,
    ...(change.region === undefined ? {} : { region: Object.freeze({ ...change.region }) }),
});
const freezeResult = (result: TopologyTaskResult): TopologyTaskResult => Object.freeze({
    taskId: result.taskId,
    agentId: result.agentId,
    outcome: result.outcome,
    ...(result.value === undefined ? {} : { value: result.value }),
    changes: Object.freeze((result.changes ?? []).map(freezeChange)),
});

const validateTask = (cooperation: Cooperation, task: DelegatedTask, seen: Set<string>): void => {
    if (task === null || typeof task !== "object") throw new TypeError("Cooperation task must be an object");
    text(task.taskId, "Cooperation task taskId");
    if (seen.has(task.taskId)) throw new TypeError(`Duplicate cooperation task: ${task.taskId}`);
    seen.add(task.taskId);
    if (task.cooperationId !== cooperation.id) throw new TypeError(`Task ${task.taskId} belongs to another cooperation`);
    if (!cooperation.participants.some(participant => participant.agentId === task.ownerAgentId)) {
        throw new TypeError(`Task ${task.taskId} owner is not a cooperation participant: ${task.ownerAgentId}`);
    }
};
const validateResult = (cooperation: Cooperation, task: DelegatedTask, agentId: string, raw: TopologyTaskResult): TopologyTaskResult => {
    if (raw === null || typeof raw !== "object") throw new TypeError(`Execution result for ${task.taskId} must be an object`);
    if (raw.taskId !== task.taskId) throw new TypeError(`Execution result taskId ${String(raw.taskId)} does not match ${task.taskId}`);
    if (raw.agentId !== agentId) throw new TypeError(`Execution result agentId ${String(raw.agentId)} does not match executor ${agentId}`);
    if (!OUTCOMES.includes(raw.outcome)) throw new TypeError(`Invalid execution outcome for ${task.taskId}: ${String(raw.outcome)}`);
    if (raw.changes !== undefined && !Array.isArray(raw.changes)) throw new TypeError(`Execution changes for ${task.taskId} must be an array`);
    const changes = raw.changes ?? [];
    for (const change of changes) {
        if (change === null || typeof change !== "object") throw new TypeError("Execution change must be an object");
        text(change.changeId, "Execution change changeId");
        text(change.agentId, "Execution change agentId");
        text(change.resourceId, "Execution change resourceId");
        if (change.agentId !== agentId) throw new TypeError(`Execution change ${change.changeId} is attributed to ${change.agentId}, not executor ${agentId}`);
        if (change.cooperationId !== cooperation.id) throw new TypeError(`Execution change ${change.changeId} belongs to another cooperation`);
    }
    return freezeResult({ taskId: task.taskId, agentId, outcome: raw.outcome, ...(raw.value === undefined ? {} : { value: raw.value }), changes });
};

/**
 * Executes one cooperation's task batch under its declared topology.
 * Deterministic for a fixed clock, task order and port: results are returned
 * in input order and escalation ids are sequential.
 */
export async function executeTopology(
    cooperation: Cooperation,
    tasks: readonly DelegatedTask[],
    ports: TopologyExecutionPorts,
): Promise<TopologyExecutionResult> {
    if (cooperation === null || typeof cooperation !== "object") throw new TypeError("Cooperation must be an object");
    if (ports === null || typeof ports !== "object" || typeof ports.execute !== "function") throw new TypeError("Topology execution requires an execute port");
    validateCooperation(cooperation);
    if (!Array.isArray(tasks)) throw new TypeError("Cooperation tasks must be an array");
    const seen = new Set<string>();
    for (const task of tasks) validateTask(cooperation, task, seen);

    const clock = ports.clock ?? (() => new Date().toISOString());
    const startedAt = clock();
    const isolation = ports.isolation ?? { merge: mergeIsolationChanges };
    if (typeof isolation.merge !== "function") throw new TypeError("Isolation port must expose merge");
    const assignments = cooperation.protocol.roles.assignments;
    const byAgent = new Map<string, CooperationRoleAssignment>(assignments.map(assignment => [assignment.agentId, assignment]));
    const collected = new Map<string, TopologyTaskResult>();
    const escalations: CooperationEscalation[] = [];

    const escalate = (
        reason: CooperationEscalationReason,
        taskIds: readonly Identifier[],
        changeIds: readonly string[],
        agents: readonly Identifier[],
        detail: string,
    ): CooperationEscalation => {
        const escalation: CooperationEscalation = Object.freeze({
            escalationId: `${cooperation.id}:escalation:${escalations.length + 1}`,
            cooperationId: cooperation.id,
            level: "human",
            reason,
            taskIds: Object.freeze([...taskIds]),
            changeIds: Object.freeze([...changeIds]),
            agents: Object.freeze([...new Set(agents)].sort()),
            detail,
            escalationPath: Object.freeze([...cooperation.protocol.conflicts.escalation]),
        });
        escalations.push(escalation);
        ports.escalate?.(escalation);
        return escalation;
    };
    const executeTask = async (task: DelegatedTask, assignment: TopologyExecutionAssignment): Promise<TopologyTaskResult> =>
        validateResult(cooperation, task, assignment.agentId, await ports.execute(task, assignment));

    switch (cooperation.topology) {
        case "star": {
            const coordinator = assignments.find(assignment => assignment.role === "coordinator");
            if (coordinator === undefined) throw new TypeError("star topology requires exactly one coordinator");
            for (const task of tasks) {
                const result = await executeTask(task, {
                    cooperationId: cooperation.id,
                    topology: cooperation.topology,
                    agentId: task.ownerAgentId,
                    ownerAgentId: task.ownerAgentId,
                    coordinatorAgentId: coordinator.agentId,
                });
                collected.set(task.taskId, result);
            }
            break;
        }
        case "mesh": {
            const results = await Promise.all(tasks.map(task => executeTask(task, {
                cooperationId: cooperation.id,
                topology: cooperation.topology,
                agentId: task.ownerAgentId,
                ownerAgentId: task.ownerAgentId,
            })));
            for (const result of results) collected.set(result.taskId, result);
            break;
        }
        case "pipeline": {
            const stages = new Map<string, number>();
            for (const assignment of assignments) {
                if (assignment.role === "stage" && assignment.stage !== undefined) stages.set(assignment.agentId, assignment.stage);
            }
            const groups = new Map<number, DelegatedTask[]>();
            for (const task of tasks) {
                const stage = stages.get(task.ownerAgentId);
                if (stage === undefined) throw new TypeError(`pipeline task ${task.taskId} is not owned by a staged participant`);
                const group = groups.get(stage);
                if (group === undefined) groups.set(stage, [task]);
                else group.push(task);
            }
            const prior: TopologyTaskResult[] = [];
            for (const stage of [...groups.keys()].sort((left, right) => left - right)) {
                const batch = groups.get(stage) as DelegatedTask[];
                const results = await Promise.all(batch.map(task => executeTask(task, {
                    cooperationId: cooperation.id,
                    topology: cooperation.topology,
                    agentId: task.ownerAgentId,
                    ownerAgentId: task.ownerAgentId,
                    stage,
                    prior: Object.freeze([...prior]),
                })));
                for (const result of results) {
                    collected.set(result.taskId, result);
                    prior.push(result);
                }
            }
            break;
        }
        case "hierarchical": {
            const root = assignments.find(assignment => assignment.role === "coordinator" && assignment.supervisorAgentId === undefined);
            if (root === undefined) throw new TypeError("hierarchical topology requires a root coordinator");
            const pathOf = (agentId: string): CooperationRoleAssignment[] => {
                const path: CooperationRoleAssignment[] = [];
                const visited = new Set<string>();
                let cursor = byAgent.get(agentId);
                while (cursor !== undefined) {
                    if (visited.has(cursor.agentId)) throw new TypeError("Cooperation supervisor hierarchy contains a cycle");
                    visited.add(cursor.agentId);
                    path.unshift(cursor);
                    cursor = cursor.supervisorAgentId === undefined ? undefined : byAgent.get(cursor.supervisorAgentId);
                }
                if (path[0]?.agentId !== root.agentId) throw new TypeError(`Task owner ${agentId} is outside the hierarchy rooted at ${root.agentId}`);
                return path;
            };
            const branches = new Map<string, { readonly task: DelegatedTask; readonly level: number; readonly supervisorAgentId?: string }[]>();
            for (const task of tasks) {
                const path = pathOf(task.ownerAgentId);
                const branch = path.length <= 1 ? root.agentId : (path[1] as CooperationRoleAssignment).agentId;
                const assignment = byAgent.get(task.ownerAgentId);
                const entry = { task, level: path.length - 1, ...(assignment?.supervisorAgentId === undefined ? {} : { supervisorAgentId: assignment.supervisorAgentId }) };
                const group = branches.get(branch);
                if (group === undefined) branches.set(branch, [entry]);
                else group.push(entry);
            }
            await Promise.all([...branches.entries()].map(async ([branch, entries]) => {
                const prior: TopologyTaskResult[] = [];
                for (const entry of entries) {
                    const result = await executeTask(entry.task, {
                        cooperationId: cooperation.id,
                        topology: cooperation.topology,
                        agentId: entry.task.ownerAgentId,
                        ownerAgentId: entry.task.ownerAgentId,
                        coordinatorAgentId: branch,
                        ...(entry.supervisorAgentId === undefined ? {} : { supervisorAgentId: entry.supervisorAgentId }),
                        level: entry.level,
                        prior: Object.freeze([...prior]),
                    });
                    collected.set(result.taskId, result);
                    prior.push(result);
                }
            }));
            break;
        }
        case "consensus": {
            const voters = assignments.filter(assignment => assignment.role === "voter");
            if (voters.length < 2) throw new TypeError("consensus topology requires at least two voters");
            const quorum = cooperation.protocol.convergence.quorum ?? Math.floor(voters.length / 2) + 1;
            for (const task of tasks) {
                const ballots = await Promise.all(voters.map(voter => executeTask(task, {
                    cooperationId: cooperation.id,
                    topology: cooperation.topology,
                    agentId: voter.agentId,
                    ownerAgentId: task.ownerAgentId,
                })));
                const tally = new Map<string, { readonly count: number; readonly first: TopologyTaskResult; readonly agents: string[] }>();
                for (const ballot of ballots) {
                    const vote = `${ballot.outcome}\u0000${ballot.value === undefined ? "" : safeStringify(ballot.value, { stableKeys: true })}`;
                    const group = tally.get(vote);
                    if (group === undefined) tally.set(vote, { count: 1, first: ballot, agents: [ballot.agentId] });
                    else {
                        group.agents.push(ballot.agentId);
                        tally.set(vote, { ...group, count: group.count + 1 });
                    }
                }
                const ranked = [...tally.values()].sort((left, right) => right.count - left.count || left.first.agentId.localeCompare(right.first.agentId));
                const top = ranked[0];
                if (top === undefined) throw new TypeError(`Consensus produced no ballot for ${task.taskId}`);
                const tied = ranked.filter(candidate => candidate.count === top.count).length > 1;
                if (top.count >= quorum && !tied) {
                    collected.set(task.taskId, freezeResult({
                        taskId: task.taskId,
                        agentId: "consensus",
                        outcome: top.first.outcome,
                        ...(top.first.value === undefined ? {} : { value: top.first.value }),
                        changes: top.first.changes ?? [],
                    }));
                    continue;
                }
                const reason: CooperationEscalationReason = tied ? "consensus_tie" : "consensus_quorum_unmet";
                const agents = ranked.filter(candidate => candidate.count === top.count).flatMap(candidate => candidate.agents);
                escalate(reason, [task.taskId], [], agents,
                    `${reason}: best consensus group has ${top.count}/${voters.length} votes, quorum ${quorum}`);
                collected.set(task.taskId, freezeResult({ taskId: task.taskId, agentId: "consensus", outcome: "unknown_outcome", changes: [] }));
            }
            break;
        }
    }

    const executions = Object.freeze(tasks
        .map(task => collected.get(task.taskId))
        .filter((result): result is TopologyTaskResult => result !== undefined));
    const contributions = executions
        .filter(execution => execution.outcome === "success")
        .flatMap(execution => execution.changes ?? []);
    const mergeResult: IsolationMergeResult = isolation.merge(contributions);
    if (mergeResult === null || typeof mergeResult !== "object" || !Array.isArray(mergeResult.merged) || !Array.isArray(mergeResult.conflicts)) {
        throw new TypeError("Isolation merge returned an invalid result");
    }
    if (mergeResult.conflicts.length > 0) {
        const changeIds = mergeResult.conflicts.flatMap(conflict => conflict.changeIds);
        const agents = mergeResult.conflicts.flatMap(conflict => conflict.agents);
        escalate("merge_conflict", executions.map(execution => execution.taskId), changeIds, agents,
            `isolation merge rejected ${contributions.length} change(s) with ${mergeResult.conflicts.length} conflict(s)`);
    }
    const completedAt = clock();
    const merged = Object.freeze(mergeResult.merged.map(freezeChange));
    const conflicts: readonly IsolationMergeConflict[] = Object.freeze(mergeResult.conflicts.map(conflict => Object.freeze({
        ...conflict,
        changeIds: Object.freeze([...conflict.changeIds]),
        agents: Object.freeze([...conflict.agents]),
    })));
    const contents: readonly IsolationMergedContent[] = Object.freeze((mergeResult.contents ?? []).map(content => Object.freeze({ ...content })));
    const syntax: readonly IsolationSyntaxFinding[] = Object.freeze((mergeResult.syntax ?? []).map(finding => Object.freeze({ ...finding })));
    const merge: IsolationMergeResult = Object.freeze({ merged, conflicts, contents, syntax });
    const mergeReceipt: MergeReceipt = Object.freeze({
        receiptId: ports.receiptId === undefined ? `merge_receipt:${cooperation.id}` : text(ports.receiptId(cooperation.id), "Merge receipt id"),
        kind: "merge_receipt",
        cooperationId: cooperation.id,
        mergedChangeIds: Object.freeze([...new Set(merged.map(change => change.changeId))]),
        conflictCount: conflicts.length,
        contents: Object.freeze(contents.map(content => Object.freeze({ resourceId: content.resourceId, hash: content.hash, bytes: content.bytes }))),
        syntaxChecked: syntax.length > 0,
        syntaxValid: syntax.every(finding => finding.valid),
        mergedAt: completedAt,
    });
    const allSuccess = executions.length > 0 && executions.every(execution => execution.outcome === "success");
    const noneSuccess = executions.length > 0 && executions.every(execution => execution.outcome === "failure");
    const status: TopologyExecutionResult["status"] = executions.length === 0
        ? "completed"
        : noneSuccess
            ? "failed"
            : allSuccess && conflicts.length === 0 && syntax.every(finding => finding.valid)
                ? "completed"
                : "partially_completed";
    return Object.freeze({
        cooperationId: cooperation.id,
        topology: cooperation.topology,
        executions,
        merge,
        mergeReceipt,
        escalations: Object.freeze(escalations),
        status,
        startedAt,
        completedAt,
    });
}
