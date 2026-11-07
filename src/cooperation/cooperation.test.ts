import assert from "node:assert/strict";
import test from "node:test";
import { CooperationCoordinator, PROTOCOL_DIMENSIONS, cooperationBindingLevel, validateCooperation } from "./index.ts";
import type { Cooperation, CooperationProtocol, CooperationRoleAssignment, CooperationSnapshot, CooperationTopology, CreateCooperationInput } from "./index.ts";
import type { PermissionScope } from "../profession/index.ts";

const clock = (): string => "2026-01-01T00:00:00.000Z";
const scope = (): PermissionScope => ({ capabilityIds: ["read", "write"], operations: ["inspect", "mutate"], resources: ["workspace"], allowWrite: true });

const assignments = (): readonly CooperationRoleAssignment[] => [
    { agentId: "a", role: "coordinator", responsibilities: ["coordinate"] },
    { agentId: "b", role: "worker", responsibilities: ["execute"] },
];
const protocol = (roles: readonly CooperationRoleAssignment[] = assignments(), overrides: Partial<CooperationProtocol> = {}): CooperationProtocol => ({
    goal: { alignment: "single", revisionPolicy: "coordinator" },
    roles: { assignments: roles, requireDistinctArbiter: true },
    messages: { format: "json", channel: "cooperation", timeoutMs: 1000, retries: 0, ordering: "fifo", idempotent: true },
    timing: { sequencing: "sequential", maxParallelism: 1 },
    conflicts: { arbiterAgentId: "a", escalation: ["protocol", "cooperation", "human"], requireReason: true },
    sharing: { isolation: "isolated", mergeStrategy: "owner" },
    convergence: { strategy: "owner_decision", partialCompletion: "report" },
    ...overrides,
});
const starInput = (overrides: Partial<CreateCooperationInput> = {}): CreateCooperationInput => ({
    id: "c1",
    name: "Star cooperation",
    goal: { objective: "ship the change", successCriteria: ["tests pass"] },
    participants: [{ agentId: "a" }, { agentId: "b" }],
    topology: "star",
    status: "active",
    protocol: protocol(),
    ...overrides,
});
const withoutDimension = (input: CreateCooperationInput, dimension: string): CreateCooperationInput => {
    const copy = { ...input.protocol } as unknown as Record<string, unknown>;
    delete copy[dimension];
    return { ...input, protocol: copy as unknown as CooperationProtocol };
};
const delegation = (overrides: Record<string, unknown> = {}) => ({ taskId: "t1", cooperationId: "c1", delegatorAgentId: "a", ownerAgentId: "b", parentScope: scope(), requestedScope: scope(), ...overrides });

test("delegated tasks and messages are owned by their cooperation", () => {
    const coordinator = new CooperationCoordinator(clock);
    const cooperation = coordinator.create(starInput());
    assert.equal(cooperation.version, 1);
    assert.equal(cooperation.status, "active");
    assert.equal(cooperation.isolation, "isolated");
    const task = coordinator.delegate(delegation());
    assert.equal(task.cooperationId, cooperation.id);
    assert.deepEqual(coordinator.getCooperation("c1")?.taskIds, ["t1"]);
    assert.equal(coordinator.getCooperation("c1")?.version, 2);
    const message = coordinator.storeMessage({ messageId: "m1", taskId: "t1", senderAgentId: "a", recipientAgentId: "b", kind: "trustedInstruction", payload: { step: 1 }, provenance: [], sentAt: clock() });
    assert.equal(message.cooperationId, "c1");
    assert.equal(coordinator.messagesFor("c1").length, 1);
    assert.deepEqual(coordinator.getCooperation("c1")?.messageIds, ["m1"]);
    assert.throws(() => coordinator.storeMessage({ messageId: "m2", taskId: "missing", senderAgentId: "a", recipientAgentId: "b", kind: "untrustedData", payload: null, provenance: [], sentAt: clock() }), /Unknown delegated task/);
    assert.throws(() => coordinator.delegate(delegation({ taskId: "t2", cooperationId: "missing" })), /Unknown cooperation/);
});

test("legacy delegation without a cooperation id creates an implicit cooperation instead of an orphan task", () => {
    const coordinator = new CooperationCoordinator(clock);
    const task = coordinator.delegate({ taskId: "legacy", delegatorAgentId: "parent", ownerAgentId: "child", parentScope: scope(), requestedScope: scope() });
    const implicit = coordinator.getCooperation(task.cooperationId);
    assert.ok(implicit);
    assert.equal(implicit.topology, "star");
    assert.deepEqual(implicit.taskIds, ["legacy"]);
    assert.equal(coordinator.listCooperations().length, 1);
});

test("illegal topology is rejected", () => {
    const coordinator = new CooperationCoordinator(clock);
    assert.throws(() => coordinator.create(starInput({ topology: "market" as CooperationTopology })), /Invalid cooperation topology: market/);
    const valid = coordinator.getCooperation(coordinator.create(starInput()).id) as Cooperation;
    const broken = structuredClone(valid) as unknown as { topology: string };
    broken.topology = "blackboard";
    assert.throws(() => validateCooperation(broken as unknown as Cooperation), /Invalid cooperation topology: blackboard/);
});

test("missing or invalid role assignments are rejected", () => {
    const coordinator = new CooperationCoordinator(clock);
    assert.throws(() => coordinator.create(starInput({ protocol: protocol([{ agentId: "a", role: "coordinator", responsibilities: ["lead"] }]) })), /role assignment missing for participant: b/);
    assert.throws(() => coordinator.create(starInput({ protocol: protocol([{ agentId: "a", role: "worker", responsibilities: ["work"] }, { agentId: "b", role: "worker", responsibilities: ["work"] }]) })), /requires role: coordinator/);
    assert.throws(() => coordinator.create(starInput({ participants: [{ agentId: "a" }, { agentId: "b" }, { agentId: "c" }], protocol: protocol([{ agentId: "a", role: "coordinator", responsibilities: ["lead"] }, { agentId: "b", role: "worker", responsibilities: ["work"] }, { agentId: "c", role: "peer", responsibilities: ["peer"] }]) })), /not allowed by topology star/);
});

test("each of the seven protocol dimensions is required", () => {
    const coordinator = new CooperationCoordinator(clock);
    const valid = coordinator.getCooperation(coordinator.create(starInput()).id) as Cooperation;
    for (const dimension of PROTOCOL_DIMENSIONS) {
        const broken = structuredClone(valid) as unknown as { protocol: Record<string, unknown> };
        delete broken.protocol[dimension];
        assert.throws(() => validateCooperation(broken as unknown as Cooperation), new RegExp(`missing dimension: ${dimension}`), `dimension ${dimension} must be required`);
    }
    assert.throws(() => coordinator.create(withoutDimension(starInput({ id: "c-missing" }), "convergence")), /missing dimension: convergence/);
});

test("pipeline topology validates ordered stages", () => {
    const coordinator = new CooperationCoordinator(clock);
    const pipeline = (stages: readonly number[]): CreateCooperationInput => starInput({
        id: `pipeline-${stages.join("-")}`,
        topology: "pipeline",
        participants: stages.map((_, index) => ({ agentId: index === 0 ? "a" : "b" })),
        protocol: protocol(stages.map((stage, index) => ({ agentId: index === 0 ? "a" : "b", role: "stage", responsibilities: ["process"], stage })), { timing: { sequencing: "staged" } }),
    });
    assert.equal(coordinator.create(pipeline([1, 2])).topology, "pipeline");
    assert.throws(() => coordinator.create(pipeline([1, 1])), /stages must be unique/);
    assert.throws(() => coordinator.create(pipeline([1, 3])), /contiguous starting at 1/);
});

test("hierarchical topology supports multi-layer coordinators with one root", () => {
    const coordinator = new CooperationCoordinator(clock);
    const hierarchical = (id: string, roles: readonly CooperationRoleAssignment[]): CreateCooperationInput => starInput({ id, topology: "hierarchical", participants: [{ agentId: "a" }, { agentId: "b" }, { agentId: "c" }], protocol: protocol(roles) });
    const valid = hierarchical("h1", [
        { agentId: "a", role: "coordinator", responsibilities: ["root"] },
        { agentId: "b", role: "coordinator", responsibilities: ["layer"], supervisorAgentId: "a" },
        { agentId: "c", role: "worker", responsibilities: ["work"], supervisorAgentId: "b" },
    ]);
    assert.equal(coordinator.create(valid).topology, "hierarchical");
    const twoRoots = hierarchical("h2", [
        { agentId: "a", role: "coordinator", responsibilities: ["root"] },
        { agentId: "b", role: "coordinator", responsibilities: ["root"] },
        { agentId: "c", role: "worker", responsibilities: ["work"] },
    ]);
    assert.throws(() => coordinator.create(twoRoots), /exactly one root coordinator/);
});

test("isolation modes are validated and shared write requires a lock scope", () => {
    const coordinator = new CooperationCoordinator(clock);
    const sharedWrite = starInput({ isolation: "shared_write_with_lock", protocol: protocol(assignments(), { sharing: { isolation: "shared_write_with_lock", mergeStrategy: "coordinator" } }) });
    assert.throws(() => coordinator.create(sharedWrite), /requires a lockScope/);
    assert.equal(coordinator.create({ ...sharedWrite, id: "locked", protocol: protocol(assignments(), { sharing: { isolation: "shared_write_with_lock", lockScope: "file", mergeStrategy: "coordinator" } }) }).isolation, "shared_write_with_lock");
    assert.throws(() => coordinator.create(starInput({ id: "mismatch", isolation: "shared_read" })), /must match protocol.sharing.isolation/);
});

test("six-level binding records the deepest level and rejects duplicates", () => {
    const coordinator = new CooperationCoordinator(clock);
    coordinator.create(starInput());
    const binding = coordinator.bindCooperation({ cooperationId: "c1", sessionId: "s1", missionId: "m1", goalId: "g1", planId: "p1", taskId: "t1", actionId: "a1" });
    assert.equal(cooperationBindingLevel(binding), "action");
    assert.deepEqual(coordinator.getBinding("c1"), binding);
    assert.throws(() => coordinator.bindCooperation({ cooperationId: "c1", sessionId: "s1" }), /already bound/);
    coordinator.create(starInput({ id: "c2", name: "Second" }));
    assert.throws(() => coordinator.bindCooperation({ cooperationId: "c2", sessionId: "s1", missionId: "m1" }), /already bound: mission:m1/);
    const removed = coordinator.unbind("c1");
    assert.deepEqual(removed, binding);
    assert.equal(coordinator.getBinding("c1"), undefined);
    const rebound = coordinator.bindCooperation({ cooperationId: "c1", sessionId: "s1" });
    assert.equal(cooperationBindingLevel(rebound), "session");
});

test("conflict arbitration requires a reason, records a frozen result and refuses a second decision", () => {
    const coordinator = new CooperationCoordinator(clock);
    coordinator.create(starInput());
    const conflict = coordinator.reportConflict({ conflictId: "x1", cooperationId: "c1", type: "resource", parties: ["b"], description: "workspace lock", reportedBy: "b" });
    assert.equal(conflict.status, "open");
    assert.throws(() => coordinator.arbitrate("x1", { arbiter: "a", outcome: "split", reason: "  " }), /nonempty string/);
    assert.throws(() => coordinator.arbitrate("x1", { arbiter: "b", outcome: "split", reason: "self" }), /must not be a conflict party/);
    assert.throws(() => coordinator.arbitrate("x1", { arbiter: "z", outcome: "split", reason: "unknown" }), /not a cooperation participant/);
    const arbitration = coordinator.arbitrate("x1", { arbiter: "a", outcome: "favor_reporter", reason: "audit log shows the lock" });
    assert.equal(arbitration.frozen, true);
    assert.equal(Object.isFrozen(arbitration), true);
    const frozen = coordinator.getConflict("x1");
    assert.equal(frozen?.status, "arbitrated");
    assert.equal(frozen?.arbitration?.arbitrationId, arbitration.arbitrationId);
    assert.equal(coordinator.listArbitrations("c1").length, 1);
    assert.throws(() => coordinator.arbitrate("x1", { arbiter: "a", outcome: "no_action", reason: "again" }), /frozen after arbitration/);
});

test("closing a cooperation blocks new tasks, bindings and conflicts", () => {
    const coordinator = new CooperationCoordinator(clock);
    coordinator.create(starInput());
    const closed = coordinator.close("c1", "completed", "done");
    assert.equal(closed.status, "completed");
    assert.equal(closed.closeReason, "done");
    assert.equal(coordinator.close("c1").status, "completed");
    assert.throws(() => coordinator.delegate(delegation()), /Cooperation is closed/);
    assert.throws(() => coordinator.bindCooperation({ cooperationId: "c1", sessionId: "s1" }), /Cooperation is closed/);
    assert.throws(() => coordinator.reportConflict({ conflictId: "x2", cooperationId: "c1", type: "result", parties: ["b"], description: "contradiction", reportedBy: "b" }), /Cooperation is closed/);
    coordinator.create(starInput({ id: "c3", name: "Third" }));
    const reasonOnly = coordinator.close("c3", "no longer needed");
    assert.equal(reasonOnly.status, "dissolved");
    assert.equal(reasonOnly.closeReason, "no longer needed");
});

test("intent conflicts must be escalated to a human decision", () => {
    const coordinator = new CooperationCoordinator(clock);
    coordinator.create(starInput());
    coordinator.reportConflict({ conflictId: "intent-1", cooperationId: "c1", type: "intent", parties: ["b"], description: "goal divergence", reportedBy: "b" });
    assert.throws(() => coordinator.arbitrate("intent-1", { arbiter: "a", outcome: "favor_reporter", reason: "machine decision" }), /escalated to a human/);
    const escalated = coordinator.arbitrate("intent-1", { arbiter: "a", outcome: "escalate_to_human", reason: "asked the user" });
    assert.equal(escalated.outcome, "escalate_to_human");
    assert.equal(coordinator.getConflict("intent-1")?.status, "arbitrated");
});

test("snapshot and pure restore preserve cooperation, task, message, binding and arbitration facts", () => {
    const coordinator = new CooperationCoordinator(clock);
    coordinator.create(starInput());
    coordinator.delegate(delegation());
    coordinator.storeMessage({ messageId: "m1", taskId: "t1", senderAgentId: "a", recipientAgentId: "b", kind: "trustedInstruction", payload: "run", provenance: [], sentAt: clock() });
    coordinator.bindCooperation({ cooperationId: "c1", sessionId: "s1", missionId: "m1" });
    coordinator.reportConflict({ conflictId: "x1", cooperationId: "c1", type: "result", parties: ["b"], description: "contradiction", reportedBy: "b" });
    coordinator.arbitrate("x1", { arbiter: "a", outcome: "favor_respondent", reason: "evidence" });
    const snapshot = coordinator.snapshot();
    const restored = CooperationCoordinator.restore(structuredClone(snapshot), () => { throw new Error("restore must not read the clock"); });
    assert.deepEqual(restored.snapshot(), snapshot);
    const broken = structuredClone(snapshot) as unknown as { tasks: { cooperationId: string }[] };
    broken.tasks[0]!.cooperationId = "missing";
    assert.throws(() => CooperationCoordinator.restore(broken as unknown as CooperationSnapshot), /Invalid cooperation snapshot/);
    const missingArbitration = structuredClone(snapshot) as unknown as { arbitrations: unknown[] };
    missingArbitration.arbitrations = [];
    assert.throws(() => CooperationCoordinator.restore(missingArbitration as unknown as CooperationSnapshot), /Invalid cooperation snapshot/);
});
