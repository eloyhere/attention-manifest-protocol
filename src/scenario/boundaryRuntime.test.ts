import assert from "node:assert/strict";
import test from "node:test";
import { BudgetError, BudgetLedger } from "../budget/ledger.ts";
import type { BudgetErrorCode } from "../budget/ledger.ts";
import { DefaultPolicyEnforcementPoint, PolicyDeniedError } from "../policy/pep.ts";
import type { AuthorizationRequest, ChildCall, Manifest, PolicyDecision, ToolDefinition } from "../tool/types.ts";
import { CapabilityRegistry } from "../capability/registry.ts";
import type { CapabilityDefinition, CapabilityDependency } from "../capability/types.ts";
import { ManifestStore } from "../manifest/store.ts";
import type { ManifestKey } from "../manifest/store.ts";
import { WorkflowStore } from "../workflow/store.ts";
import { WorkflowError } from "../workflow/types.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { SessionService } from "../session/service.ts";
import { TurnService } from "../turn/service.ts";
import { IntentService } from "../intent/service.ts";
import { MissionService } from "../mission/service.ts";
import { GoalService } from "../goal/service.ts";
import { PlanService } from "../plan/service.ts";
import { TaskService } from "../task/service.ts";
import { createInvocation, createObservation, createReceiptCore, verifyReceiptIntegrity } from "../receipt/core.ts";
import type { ReceiptCore } from "../receipt/types.ts";
import { verifyBusinessSemantics } from "../verification/core.ts";
import { EvidenceLedger } from "../evidence/ledger.ts";
import type { AddEvidenceInput } from "../evidence/types.ts";
import { createAttention, focus, mount, persist, update, verify as verifyAttention } from "../attention/operations.ts";
import { AttentionError } from "../attention/validation.ts";
import type { AttentionObject, AttentionOperationOptions, AttentionScope, AttentionVerificationInput, CreateAttentionInput } from "../attention/types.ts";
import { compileContext } from "../context/compiler.ts";
import type { CompileContextOptions } from "../context/types.ts";
import { Executor, ExecutorError, childOperationKey } from "../execution/executor.ts";
import type { ExecutorOptions } from "../execution/executor.ts";
import type { ExecutionContext, JsonValue } from "../shared.ts";

const now = "2026-11-06T12:00:00Z";
const expiry = "2026-11-07T12:00:00Z";

const budgetCode = (code: BudgetErrorCode) => (error: unknown): boolean => error instanceof BudgetError && error.code === code;
const workflowCode = (code: WorkflowError["code"]) => (error: unknown): boolean => error instanceof WorkflowError && error.code === code;
const attentionCode = (code: AttentionError["code"]) => (error: unknown): boolean => error instanceof AttentionError && error.code === code;

const executionContext = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
    tenantId: "tenant",
    principalId: "principal",
    agentId: "agent",
    sessionId: "session",
    operationId: "operation",
    attemptId: "attempt",
    executionId: "execution",
    policyVersion: "policy-1",
    cancellationEpoch: 0,
    ...overrides,
});

// ---------------------------------------------------------------------------
// Budget ledger
// ---------------------------------------------------------------------------

test("budget: rejects negative, NaN, infinite and unsafe amounts and unconfigured keys", () => {
    const ledger = new BudgetLedger();
    assert.throws(() => ledger.configure("tenant", { tokens: -1 }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.configure("tenant", { tokens: Number.NaN }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.configure("tenant", { tokens: Number.POSITIVE_INFINITY }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.configure("tenant", { milliseconds: Number.NEGATIVE_INFINITY }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.configure("tenant", { tokens: Number.MAX_SAFE_INTEGER + 1 }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.configure("tenant", { tokens: Number.MAX_SAFE_INTEGER + 0.5 }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.configure("tenant", { tokens: 1.5 }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.configure("tenant", { tokens: 1, invented: 1 } as never), budgetCode("invalid_amount"));
    assert.throws(() => ledger.reserve("r0", "missing", { tokens: 1 }), budgetCode("budget_not_configured"));
    ledger.configure("tenant", { tokens: 10 });
    assert.throws(() => ledger.reserve("r0", "tenant", { tokens: Number.NaN }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.reserve("r0", "tenant", { tokens: -1 }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.reserve("r0", "tenant", { tokens: Number.MAX_SAFE_INTEGER + 1 }), budgetCode("invalid_amount"));
    assert.deepEqual(ledger.snapshot("tenant").reserved, { tokens: 0, milliseconds: 0, calls: 0, bytes: 0 });
});

test("budget: exact exhaustion, over-reservation and reconfiguration boundaries", () => {
    const ledger = new BudgetLedger();
    ledger.configure("tenant", { tokens: 10, calls: 1 });
    const reservation = ledger.reserve("r1", "tenant", { tokens: 10, calls: 1 });
    assert.equal(reservation.state, "reserved");
    assert.deepEqual(ledger.snapshot("tenant").reserved, { tokens: 10, milliseconds: 0, calls: 1, bytes: 0 });
    assert.throws(() => ledger.reserve("r2", "tenant", { tokens: 1 }), budgetCode("limit_exceeded"));
    assert.throws(() => ledger.reserve("r3", "tenant", { calls: 1 }), budgetCode("limit_exceeded"));
    const settled = ledger.settle("r1", { tokens: 10, calls: 1 });
    assert.equal(settled.state, "settled");
    assert.deepEqual(ledger.snapshot("tenant").settled, { tokens: 10, milliseconds: 0, calls: 1, bytes: 0 });
    assert.deepEqual(ledger.snapshot("tenant").reserved, { tokens: 0, milliseconds: 0, calls: 0, bytes: 0 });
    assert.throws(() => ledger.reserve("r4", "tenant", { tokens: 1 }), budgetCode("limit_exceeded"));
    assert.throws(() => ledger.configure("tenant", { tokens: 9 }), budgetCode("limit_exceeded"));
    ledger.configure("tenant", { tokens: 10 });
    assert.throws(() => ledger.configure("tenant", { tokens: Number.NaN }), budgetCode("invalid_amount"));

    const zero = new BudgetLedger();
    zero.configure("zero", { tokens: 0, calls: 0 });
    zero.reserve("z", "zero", {});
    assert.equal(zero.snapshot("zero").reserved.tokens, 0);
    assert.throws(() => zero.reserve("z2", "zero", { calls: 1 }), budgetCode("limit_exceeded"));
    zero.settle("z", {});
    assert.equal(zero.snapshot("zero").settled.tokens, 0);

    const safe = new BudgetLedger();
    safe.configure("safe", { tokens: Number.MAX_SAFE_INTEGER });
    safe.reserve("safe-r", "safe", { tokens: Number.MAX_SAFE_INTEGER });
    // The sum would exceed MAX_SAFE_INTEGER, but this is an overrun, not a malformed amount.
    assert.throws(() => safe.reserve("safe-r2", "safe", { tokens: 1 }), budgetCode("limit_exceeded"));
    assert.throws(() => safe.configure("safe", { tokens: Number.MAX_SAFE_INTEGER + 1 }), budgetCode("invalid_amount"));
});

test("budget: duplicate ids, settlement limits and release are explicit", () => {
    const ledger = new BudgetLedger();
    ledger.configure("tenant", { tokens: 10 });
    ledger.reserve("r1", "tenant", { tokens: 4 });
    assert.throws(() => ledger.reserve("r1", "tenant", { tokens: 1 }), budgetCode("reservation_not_open"));
    assert.throws(() => ledger.settle("r1", { tokens: Number.MAX_SAFE_INTEGER + 1 }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.settle("r1", { tokens: 1.5 }), budgetCode("invalid_amount"));
    assert.throws(() => ledger.settle("r1", { tokens: 5 }), budgetCode("settlement_exceeds_reservation"));
    assert.throws(() => ledger.settle("missing", {}), budgetCode("reservation_not_found"));
    const released = ledger.release("r1");
    assert.equal(released.state, "released");
    assert.deepEqual(ledger.snapshot("tenant").reserved, { tokens: 0, milliseconds: 0, calls: 0, bytes: 0 });
    assert.throws(() => ledger.settle("r1", { tokens: 0 }), budgetCode("reservation_not_open"));
    assert.throws(() => ledger.release("r1"), budgetCode("reservation_not_open"));
    assert.equal(ledger.getReservation("r1")?.state, "released");
    assert.equal(ledger.getReservation("missing"), undefined);
    assert.equal(ledger.findReservation("missing").isPresent(), false);
});

test("budget: returned reservations and snapshots are deeply frozen and detached", () => {
    const ledger = new BudgetLedger();
    ledger.configure("tenant", { tokens: 10 });
    const reservation = ledger.reserve("r1", "tenant", { tokens: 4 });
    assert.equal(Object.isFrozen(reservation), true);
    assert.equal(Object.isFrozen(reservation.amount), true);
    assert.throws(() => { (reservation.amount as unknown as { tokens: number }).tokens = 999; }, TypeError);
    assert.deepEqual(ledger.snapshot("tenant").reserved, { tokens: 4, milliseconds: 0, calls: 0, bytes: 0 });

    const snapshot = ledger.snapshot("tenant");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.limit), true);
    assert.equal(Object.isFrozen(snapshot.settled), true);
    assert.equal(Object.isFrozen(snapshot.reserved), true);
    assert.throws(() => { (snapshot.limit as unknown as { tokens: number }).tokens = 9999; }, TypeError);
    assert.throws(() => { (snapshot.settled as unknown as { tokens: number }).tokens = 9999; }, TypeError);
    assert.throws(() => { (snapshot.reserved as unknown as { tokens: number }).tokens = 9999; }, TypeError);

    // Failed mutations never alter live accounting facts.
    assert.throws(() => ledger.reserve("r2", "tenant", { tokens: 7 }), budgetCode("limit_exceeded"));
    assert.throws(() => ledger.settle("r1", { tokens: 5 }), budgetCode("settlement_exceeds_reservation"));
    assert.throws(() => ledger.configure("tenant", { tokens: 3 }), budgetCode("limit_exceeded"));
    const fresh = ledger.snapshot("tenant");
    assert.equal(fresh.limit.tokens, 10);
    assert.equal(fresh.settled.tokens, 0);
    assert.equal(fresh.reserved.tokens, 4);
    assert.equal(ledger.getReservation("r2"), undefined);
});

// ---------------------------------------------------------------------------
// Policy enforcement point
// ---------------------------------------------------------------------------

const authorizationRequest = (): AuthorizationRequest => ({
    action: "execute",
    context: executionContext(),
    object: { kind: "tool", id: "tool", tenantId: "tenant" },
});

test("policy: default deny, approval gate and policy-version gate", async () => {
    const request = authorizationRequest();
    const denied = new DefaultPolicyEnforcementPoint(() => ({ allowed: false, policyVersion: "policy-1", reason: "capability missing" }));
    await assert.rejects(denied.authorize(request), (error: unknown) => error instanceof PolicyDeniedError && error.decision.reason === "capability missing");
    await assert.rejects(denied.authorize(request), (error: unknown) => error instanceof Error && error.message === "capability missing");

    const approval = new DefaultPolicyEnforcementPoint(() => ({ allowed: true, approvalRequired: true, policyVersion: "policy-1", reason: "requires approval" }));
    await assert.rejects(approval.authorize(request), (error: unknown) => error instanceof PolicyDeniedError && error.decision.approvalRequired === true);

    const stalePolicy = new DefaultPolicyEnforcementPoint(() => ({ allowed: true, policyVersion: "policy-2", reason: "ok" }));
    await assert.rejects(stalePolicy.authorize(request), (error: unknown) => error instanceof PolicyDeniedError && error.decision.policyVersion === "policy-2");

    const noReason = new DefaultPolicyEnforcementPoint(() => ({ allowed: false, policyVersion: "policy-1", reason: "" }));
    await assert.rejects(noReason.authorize(request), (error: unknown) => error instanceof PolicyDeniedError && error.message === "Policy denied the operation.");
});

test("policy: allow path returns the structured decision and PDP failures propagate", async () => {
    const request = authorizationRequest();
    const decision: PolicyDecision = { allowed: true, policyVersion: "policy-1", reason: "host policy" };
    const seen: AuthorizationRequest[] = [];
    const pep = new DefaultPolicyEnforcementPoint(async (incoming) => {
        seen.push(incoming);
        return decision;
    });
    assert.equal(await pep.authorize(request), decision);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], request);
    const offline = new Error("policy store offline");
    const failing = new DefaultPolicyEnforcementPoint(() => { throw offline; });
    await assert.rejects(failing.authorize(request), (error: unknown) => error === offline);
});

// ---------------------------------------------------------------------------
// Capability registry
// ---------------------------------------------------------------------------

const capability = (id: string, version: string, dependencies: readonly CapabilityDependency[] = []): CapabilityDefinition => ({
    id,
    version,
    kind: "tool",
    digest: `${id}-${version}-digest`,
    contract: { id, version },
    dependencies,
    risk: "low",
    definedAt: now,
});

test("capability: definition validation, duplicates and frozen listing", () => {
    const registry = new CapabilityRegistry(() => now);
    assert.throws(() => registry.define({ ...capability("a", "1"), id: "" }), /requires id, version and digest/);
    assert.throws(() => registry.define({ ...capability("a", "1"), version: "" }), /requires id, version and digest/);
    assert.throws(() => registry.define({ ...capability("a", "1"), digest: "" }), /requires id, version and digest/);
    assert.equal(registry.get("missing", "1"), undefined);
    const defined = registry.define(capability("a", "1"));
    assert.equal(defined.id, "a");
    assert.throws(() => registry.define(capability("a", "1")), /already defined/);
    assert.deepEqual(registry.list().map(value => `${value.id}@${value.version}`), ["a@1"]);
    assert.equal(Object.isFrozen(registry.list()), true);
    assert.equal(registry.list({ kind: "skill" }).length, 0);
    assert.equal(registry.list({ id: "a", usableOnly: true }).length, 0);
    const listed = registry.list();
    (listed[0] as unknown as { digest: string }).digest = "tampered";
    (defined as unknown as { digest: string }).digest = "tampered";
    assert.equal(registry.get("a", "1")?.digest, "a-1-digest");
    registry.activate("a", "1");
    assert.equal(registry.list({ id: "a", usableOnly: true }).length, 1);
});

test("capability: dependency resolution, fallback and revocation cascade", () => {
    const registry = new CapabilityRegistry(() => now);
    registry.define(capability("dep", "1"));
    registry.define(capability("fallback", "1"));
    registry.define(capability("main", "1", [{ capabilityId: "dep", version: "1", required: true }]));
    registry.define(capability("broken", "1", [{ capabilityId: "absent", version: "1", required: true }]));
    registry.define(capability("degraded", "1", [{ capabilityId: "absent", version: "1", required: true, fallback: { capabilityId: "fallback", version: "1" } }]));

    const active = registry.activate("main", "1");
    assert.equal(active.status, "active");
    assert.equal(active.activatedAt, now);
    assert.deepEqual(active.dependencies.map(item => item.status), ["available"]);
    assert.equal(registry.activate("broken", "1").status, "failed");
    assert.equal(registry.activate("broken", "1").reason, "required dependency unavailable");
    const degraded = registry.activate("degraded", "1");
    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.dependencies[0]?.status, "fallback");
    assert.equal(degraded.dependencies[0]?.resolvedCapabilityId, "fallback");

    const depActivation = registry.activate("dep", "1");
    const first = registry.activate("main", "1");
    const second = registry.activate("main", "1");
    assert.notEqual(first.activationId, second.activationId);
    assert.equal(registry.latestUsable("main")?.activationId, second.activationId);
    const revoked = registry.invalidate(depActivation.activationId, "withdrawn");
    assert.equal(revoked.status, "revoked");
    assert.equal(registry.latestUsable("dep"), undefined);
    assert.equal(registry.latestUsable("main"), undefined);
    assert.equal(registry.activate("main", "1").status, "failed");
    assert.throws(() => registry.activate("unknown", "1"), /Unknown capability/);
    assert.throws(() => registry.invalidate("missing", "reason"), /Unknown activation/);
});

test("capability: activation snapshots cannot mutate the registry", () => {
    const registry = new CapabilityRegistry(() => now);
    registry.define(capability("a", "1"));
    const activation = registry.activate("a", "1");
    (activation as unknown as { status: string }).status = "revoked";
    assert.equal(registry.getActivation(activation.activationId)?.status, "active");
    assert.equal(registry.findActivation(activation.activationId).map(value => value.status).orElse("failed"), "active");
});

// ---------------------------------------------------------------------------
// Manifest store
// ---------------------------------------------------------------------------

const toolDefinition: ToolDefinition = {
    toolId: "tool",
    version: "1",
    digest: "tool-digest",
    summary: "summary",
    inputSchema: {},
    risk: "read",
    effect: "read_only",
    policyScope: "scope",
};

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
    manifestId: "manifest-1",
    tenantId: "tenant",
    endpointId: "endpoint",
    endpointIdentity: "host:test",
    serverVersion: "1",
    digest: "manifest-digest",
    policyScope: "scope",
    issuedAt: now,
    expiresAt: expiry,
    tools: [toolDefinition],
    ...overrides,
});

const manifestKey = (value: Manifest): ManifestKey => ({
    tenantId: value.tenantId,
    endpointId: value.endpointId,
    version: value.serverVersion,
    digest: value.digest,
    policyScope: value.policyScope,
});

test("manifest: required fields, timestamps, duplicate tools and immutable keys", () => {
    const store = new ManifestStore<JsonValue>(() => now);
    assert.throws(() => store.put(manifest({ manifestId: "" })), /manifestId is required/);
    assert.throws(() => store.put(manifest({ manifestId: "   " })), /manifestId is required/);
    assert.throws(() => store.put(manifest({ endpointId: "" })), /endpointId is required/);
    assert.throws(() => store.put(manifest({ serverVersion: "" })), /serverVersion is required/);
    assert.throws(() => store.put(manifest({ digest: "" })), /digest is required/);
    assert.throws(() => store.put(manifest({ issuedAt: "not-a-date" })), /Invalid manifest issuedAt/);
    assert.throws(() => store.put(manifest({ issuedAt: "" })), /Invalid manifest issuedAt/);
    assert.throws(() => store.put(manifest({ expiresAt: "not-a-date" })), /Invalid manifest expiresAt/);
    assert.throws(() => store.put(manifest({ expiresAt: "2026-01-01T00:00:00Z" })), /precedes issuedAt/);
    assert.throws(() => store.put(manifest({ tools: [toolDefinition, { ...toolDefinition, version: "2" }] })), /Duplicate tool id/);
    store.put(manifest());
    store.put(manifest());
    assert.throws(() => store.put(manifest({ endpointIdentity: "changed" })), /immutable/);
    assert.throws(() => store.put(manifest({ tools: [{ ...toolDefinition, summary: "changed" }] })), /immutable/);
});

test("manifest: expiry instant, revocation and version/digest binding", () => {
    const value = manifest();
    const key = manifestKey(value);
    const store = new ManifestStore<JsonValue>(() => now);
    store.put(value);
    const handle = store.createHandle(value, "tool");
    assert.ok(handle);
    assert.equal(store.resolveTool(handle)?.summary, "summary");
    assert.equal(store.createHandle(value, "missing"), undefined);
    assert.equal(store.resolveTool({ ...handle, tenantId: "other" }), undefined);
    assert.equal(store.resolveTool({ ...handle, digest: "wrong" }), undefined);
    assert.equal(store.resolveTool({ ...handle, policyScope: "other" }), undefined);
    assert.equal(store.resolveTool({ ...handle, toolVersion: "9" }), undefined);
    assert.equal(store.resolveTool({ ...handle, toolDigest: "wrong" }), undefined);
    assert.ok(store.get(key));

    const beforeExpiry = new ManifestStore<JsonValue>(() => "2026-11-07T11:59:59.999Z");
    beforeExpiry.put(value);
    assert.ok(beforeExpiry.get(key));
    assert.equal(beforeExpiry.resolveTool(handle)?.toolId, "tool");

    // Expiry is inclusive and shared by get() and resolveTool().
    const atExpiry = new ManifestStore<JsonValue>(() => expiry);
    atExpiry.put(value);
    assert.equal(atExpiry.get(key), undefined);
    assert.equal(atExpiry.findManifest(key).isPresent(), false);
    assert.equal(atExpiry.resolveTool(handle), undefined);

    store.revoke(key);
    assert.equal(store.isRevoked(key), true);
    assert.equal(store.get(key), undefined);
    assert.equal(store.resolveTool(handle), undefined);
    store.unrevoke(key);
    assert.equal(store.resolveTool(handle)?.toolId, "tool");
});

test("manifest: returned manifests are detached from stored facts", () => {
    const store = new ManifestStore<JsonValue>(() => now);
    const input = manifest();
    store.put(input);
    const handle = store.createHandle(input, "tool");
    assert.ok(handle);
    (input.tools[0] as unknown as { summary: string }).summary = "mutated input";
    assert.equal(store.resolveTool(handle)?.summary, "summary");
    const loaded = store.get(manifestKey(input));
    assert.ok(loaded);
    (loaded.tools[0] as unknown as { summary: string }).summary = "mutated output";
    assert.equal(store.resolveTool(handle)?.summary, "summary");
});

// ---------------------------------------------------------------------------
// Workflow store and domain services
// ---------------------------------------------------------------------------

const workflowOptions = (expectedVersion: number, patch: Partial<TransitionOptions> = {}): TransitionOptions => ({
    actor: "host",
    expectedVersion,
    ...patch,
});

const sessionFixture = () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    return { store, session };
};

test("workflow: duplicate creation, invalid transitions and version/CAS conflicts", () => {
    const { session } = sessionFixture();
    assert.throws(() => session.create({ id: "s", sessionId: "s", participants: [] }, "host"), workflowCode("duplicate"));
    assert.throws(() => session.create({ id: "", sessionId: "", participants: [] }, "host"), workflowCode("guard_rejected"));
    assert.throws(() => session.activate("s", workflowOptions(99)), workflowCode("version_conflict"));
    assert.throws(() => session.close("s", workflowOptions(0)), workflowCode("invalid_transition"));
    assert.equal(session.activate("s", workflowOptions(0)).version, 1);
    assert.throws(() => session.idle("s", workflowOptions(0)), workflowCode("version_conflict"));
    assert.throws(() => session.activate("s", workflowOptions(1)), workflowCode("invalid_transition"));
    assert.equal(session.find("missing").isEmpty(), true);
    assert.throws(() => session.get("missing"), workflowCode("not_found"));
});

test("workflow: terminal and expired states refuse further transitions", () => {
    const { session } = sessionFixture();
    session.activate("s", workflowOptions(0));
    session.beginClose("s", workflowOptions(1));
    session.close("s", workflowOptions(2));
    assert.throws(() => session.close("s", workflowOptions(3)), workflowCode("invalid_transition"));
    assert.equal(session.archive("s", workflowOptions(3)).state, "archived");
    assert.throws(() => session.idle("s", workflowOptions(4)), workflowCode("invalid_transition"));

    session.create({ id: "s2", sessionId: "s2", participants: [] }, "host");
    session.activate("s2", workflowOptions(0));
    assert.equal(session.transition("s2", "expired", workflowOptions(1)).state, "expired");
    assert.throws(() => session.activate("s2", workflowOptions(2)), workflowCode("invalid_transition"));
});

const workflowFixture = () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const turn = new TurnService(store);
    const intent = new IntentService(store);
    const mission = new MissionService(store);
    const goal = new GoalService(store);
    const plan = new PlanService(store);
    const task = new TaskService(store);

    session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    session.activate("s", workflowOptions(0));
    turn.create({ id: "t", sessionId: "s", classification: "new_intent" }, "host");
    turn.interpret("t", workflowOptions(0));
    intent.create({ id: "i", sessionId: "s", originTurnId: "t", text: "boundary" }, "host");
    intent.confirm("i", workflowOptions(0));
    intent.accept("i", workflowOptions(1));
    mission.create({ id: "m", sessionId: "s", intentId: "i" }, "host");
    mission.activate("m", workflowOptions(0));
    return { store, session, turn, intent, mission, goal, plan, task };
};

test("workflow: cancellation propagates, fences the epoch and blocks child creation", () => {
    const { store, mission, goal } = workflowFixture();
    const before = store.snapshot();
    assert.throws(() => mission.requestCancel("m", workflowOptions(1, { actor: "" })), workflowCode("guard_rejected"));
    assert.deepEqual(store.snapshot(), before);
    const cancelled = mission.requestCancel("m", workflowOptions(1, { reason: "user cancel" }));
    assert.equal(cancelled.state, "cancel_requested");
    assert.equal(cancelled.cancellationEpoch, 1);
    assert.throws(() => goal.create({ id: "g", sessionId: "s", missionId: "m", contractVersion: "v1", acceptanceCriteria: ["criterion"] }, "host"), workflowCode("guard_rejected"));
    assert.throws(() => mission.achieve("m", workflowOptions(2)), workflowCode("invalid_transition"));
    assert.throws(() => mission.requestCancel("m", workflowOptions(2)), workflowCode("guard_rejected"));
    assert.equal(mission.drain("m", workflowOptions(2)).state, "draining");
    assert.equal(mission.finishCancellation("m", workflowOptions(3)).state, "cancelled");
    assert.throws(() => mission.drain("m", workflowOptions(4)), workflowCode("invalid_transition"));
});

test("workflow: snapshots and restore reject corruption without mutating live facts", () => {
    const { store } = workflowFixture();
    const snapshot = store.snapshot();
    const pristine = structuredClone(snapshot);
    const detached = snapshot as unknown as { entities: { state: string }[]; events: { actor: string }[] };
    detached.entities[0]!.state = "archived";
    detached.events[0]!.actor = "tampered";
    assert.equal(store.get("session", "s").state, "active");
    assert.equal(store.history()[0]?.actor, "host");
    const restored = WorkflowStore.restore(pristine);
    assert.deepEqual(restored.snapshot(), pristine);

    const duplicate = structuredClone(pristine) as unknown as { entities: unknown[] };
    duplicate.entities.push(duplicate.entities[0]);
    assert.throws(() => WorkflowStore.restore(duplicate as unknown as typeof pristine), workflowCode("invalid_snapshot"));
    const badVersion = structuredClone(pristine) as unknown as { entities: { version: number }[] };
    badVersion.entities[0]!.version = -1;
    assert.throws(() => WorkflowStore.restore(badVersion as unknown as typeof pristine), workflowCode("invalid_snapshot"));
    const badSequence = structuredClone(pristine) as unknown as { sequence: number };
    badSequence.sequence += 1;
    assert.throws(() => WorkflowStore.restore(badSequence as unknown as typeof pristine), workflowCode("invalid_snapshot"));
});

test("workflow: goal acceptance, plan bounds and task dependency boundaries", () => {
    const { mission, goal, plan, task } = workflowFixture();
    const goalInput = { id: "g", sessionId: "s", missionId: "m", contractVersion: "v1", acceptanceCriteria: ["criterion"] };
    assert.throws(() => goal.create({ ...goalInput, acceptanceCriteria: [] }, "host"), workflowCode("guard_rejected"));
    goal.create(goalInput, "host");
    assert.throws(() => goal.activate("g", workflowOptions(1)), workflowCode("version_conflict"));
    goal.activate("g", workflowOptions(0));

    const bounds = { maxAttempts: 2, deadline: "2027-01-01T00:00:00Z", progressMetric: "metric", deadLetterOwner: "owner" };
    for (const invalid of [
        { ...bounds, maxAttempts: 0 },
        { ...bounds, maxAttempts: Number.NaN },
        { ...bounds, maxAttempts: Number.POSITIVE_INFINITY },
        { ...bounds, maxAttempts: Number.MAX_SAFE_INTEGER + 1 },
        { ...bounds, deadline: "not-a-date" },
    ]) {
        assert.throws(() => plan.create({ id: "p-invalid", sessionId: "s", goalId: "g", bounds: invalid }, "host"), workflowCode("guard_rejected"));
    }
    plan.create({ id: "p", sessionId: "s", goalId: "g", bounds }, "host");
    task.create({ id: "t1", sessionId: "s", planId: "p", dependsOn: [], required: true, contractVersion: "v1", requiredEffects: [] }, "host");
    task.create({ id: "t2", sessionId: "s", planId: "p", dependsOn: ["t1"], required: true, contractVersion: "v1", requiredEffects: [] }, "host");
    assert.throws(() => task.create({ id: "t3", sessionId: "s", planId: "p", dependsOn: ["missing"], required: true, contractVersion: "v1", requiredEffects: [] }, "host"), workflowCode("not_found"));
    assert.throws(() => task.ready("t2", workflowOptions(0)), workflowCode("guard_rejected"));
    plan.ready("p", workflowOptions(0));
    assert.throws(() => task.ready("t2", workflowOptions(0)), workflowCode("guard_rejected"));
    assert.throws(() => task.skip("t1", workflowOptions(0)), workflowCode("guard_rejected"));
    plan.start("p", workflowOptions(1));
    task.ready("t1", workflowOptions(0));
    task.start("t1", workflowOptions(1));
    const acceptance = { valid: true, contractVersion: "v1", verificationId: "verification", evidenceIds: ["evidence"] };
    assert.throws(() => task.succeed("t1", { ...acceptance, contractVersion: "v2" }, workflowOptions(2, { cancellationEpoch: 0 })), workflowCode("guard_rejected"));
    assert.throws(() => task.succeed("t1", { ...acceptance, evidenceIds: [] }, workflowOptions(2, { cancellationEpoch: 0 })), workflowCode("guard_rejected"));
    task.succeed("t1", acceptance, workflowOptions(2, { cancellationEpoch: 0 }));
    task.ready("t2", workflowOptions(0));
    task.start("t2", workflowOptions(1));
    task.succeed("t2", acceptance, workflowOptions(2, { cancellationEpoch: 0 }));
    assert.equal(plan.complete("p", workflowOptions(2, { cancellationEpoch: 0 })).state, "completed");
    assert.throws(() => plan.start("p", workflowOptions(3)), workflowCode("invalid_transition"));
    assert.throws(() => goal.achieve("g", { ...acceptance, valid: false }, workflowOptions(1, { cancellationEpoch: 0 })), workflowCode("guard_rejected"));
    assert.equal(goal.achieve("g", acceptance, workflowOptions(1, { cancellationEpoch: 0 })).state, "achieved");
    assert.equal(goal.get("g").validity, "valid");
    assert.equal(mission.achieve("m", workflowOptions(1, { cancellationEpoch: 0 })).state, "achieved");
});

// ---------------------------------------------------------------------------
// Receipt, verification and evidence integrity
// ---------------------------------------------------------------------------

type ReceiptPayload = Pick<ReceiptCore, "invocation" | "observation" | "issuedAt">;
const receiptDigest = (value: ReceiptPayload): string => JSON.stringify({
    invocation: value.invocation,
    observation: value.observation,
    issuedAt: value.issuedAt,
});

const receiptFixture = async (tenantId = "tenant") => {
    const invocation = createInvocation({
        id: "invocation",
        context: executionContext({ tenantId }),
        toolId: "tool",
        arguments: { query: "read" },
        createdAt: now,
    });
    const observation = createObservation({
        id: "observation",
        invocationId: invocation.id,
        status: "success",
        value: { result: "ok" },
        observedAt: now,
    });
    const receipt = createReceiptCore({
        id: "receipt",
        invocation,
        observation,
        issuedAt: now,
        payloadDigest: receiptDigest({ invocation, observation, issuedAt: now }),
        hashAlgorithm: "sha256",
    });
    const integrity = await verifyReceiptIntegrity(receipt, { digest: receiptDigest, verifier: "integrity-checker", verifiedAt: now });
    const verification = await verifyBusinessSemantics(
        receipt,
        integrity,
        { id: "verification", verifier: "business-checker", verifiedAt: now, criteriaVersion: "criteria-v1" },
        () => true,
        ["claim"],
    );
    return { invocation, observation, receipt, integrity, verification };
};

test("receipt: immutable facts and field-level tamper detection", async () => {
    const facts = await receiptFixture();
    assert.equal(Object.isFrozen(facts.receipt), true);
    assert.equal(Object.isFrozen(facts.receipt.invocation), true);
    assert.equal(Object.isFrozen(facts.receipt.invocation.context), true);
    assert.equal(Object.isFrozen(facts.receipt.observation), true);
    assert.throws(() => { (facts.receipt as unknown as { id: string }).id = "tampered"; }, TypeError);
    assert.throws(() => { (facts.receipt.invocation as unknown as { toolId: string }).toolId = "other"; }, TypeError);

    assert.equal(facts.integrity.status, "integrity_verified");
    const tampered = { ...facts.receipt, observation: { ...facts.receipt.observation, value: { result: "tampered" } } };
    const rejected = await verifyReceiptIntegrity(tampered, { digest: receiptDigest, verifier: "integrity-checker", verifiedAt: now });
    assert.equal(rejected.digestValid, false);
    assert.equal(rejected.status, "integrity_rejected");
    assert.ok(rejected.reasons.includes("payload_digest_mismatch"));
    const inconclusive = await verifyBusinessSemantics(
        tampered,
        rejected,
        { id: "verification-tampered", verifier: "business-checker", verifiedAt: now, criteriaVersion: "criteria-v1" },
        () => true,
        ["claim"],
    );
    assert.equal(inconclusive.status, "inconclusive");
    assert.equal(inconclusive.rationale, "receipt_integrity_not_verified");
});

test("receipt: signature, timestamp and identity boundaries", async () => {
    const facts = await receiptFixture();
    const signed = createReceiptCore({ ...facts.receipt, signature: "signature", signerKeyId: "key-1" });
    const unchecked = await verifyReceiptIntegrity(signed, { digest: receiptDigest, verifier: "integrity-checker", verifiedAt: now });
    assert.equal(unchecked.status, "integrity_rejected");
    assert.ok(unchecked.reasons.includes("signature_not_checked"));
    const invalid = await verifyReceiptIntegrity(signed, { digest: receiptDigest, verifySignature: () => false, verifier: "integrity-checker", verifiedAt: now });
    assert.equal(invalid.status, "integrity_rejected");
    assert.ok(invalid.reasons.includes("signature_invalid"));
    const validSignature = await verifyReceiptIntegrity(signed, { digest: receiptDigest, verifySignature: () => true, verifier: "integrity-checker", verifiedAt: now });
    assert.equal(validSignature.status, "integrity_verified");

    assert.throws(() => createInvocation({ ...facts.invocation, id: "" }), /identity/);
    assert.throws(() => createInvocation({ ...facts.invocation, createdAt: "not-a-date" }), /createdAt/);
    assert.throws(() => createObservation({ ...facts.observation, status: "success", error: "boom" }), /cannot contain an error/);
    assert.throws(() => createObservation({ ...facts.observation, status: "failure", error: undefined }), /must include an error/);
    assert.throws(() => createObservation({ ...facts.observation, observedAt: "not-a-date" }), /observedAt/);
    assert.throws(() => createReceiptCore({ ...facts.receipt, payloadDigest: "" }), /identity/);
    assert.throws(() => createReceiptCore({ ...facts.receipt, observation: { ...facts.observation, invocationId: "other" } }), /reference its invocation/);
});

const evidenceFixture = async (tenantId = "tenant") => {
    const facts = await receiptFixture(tenantId);
    const ledger = new EvidenceLedger();
    const add = (id: string, dependsOn?: readonly string[], patch: Partial<AddEvidenceInput> = {}) => ledger.add({
        id,
        tenantId,
        claim: "claim",
        polarity: "supports",
        receipt: facts.receipt,
        integrity: facts.integrity,
        verification: facts.verification,
        criteriaVersion: "criteria-v1",
        environmentVersion: "env-v1",
        createdAt: now,
        ...(dependsOn === undefined ? {} : { dependsOn }),
        ...patch,
    });
    return { facts, ledger, add };
};

test("evidence: duplicate, self, missing and cross-tenant dependencies are rejected", async () => {
    const { ledger, add } = await evidenceFixture();
    assert.deepEqual(new EvidenceLedger().auditEvents(), []);
    assert.equal(Object.isFrozen(new EvidenceLedger().auditEvents()), true);
    const root = add("root");
    assert.equal(root.status, "active");
    assert.equal(Object.isFrozen(root), true);
    assert.equal(Object.isFrozen(root.dependsOn), true);
    assert.throws(() => add("root"), /Duplicate evidence/);
    assert.throws(() => add("self", ["self"]), /cannot depend on itself/);
    assert.throws(() => add("missing", ["absent"]), /Unknown, invalid, or cross-tenant/);
    assert.throws(() => ledger.revoke("absent", "tenant", "withdrawn", now), /Unknown evidence/);
    assert.throws(() => add("bad-created", undefined, { createdAt: "not-a-date" }), /createdAt/);
    assert.throws(() => add("bad-expiry", undefined, { expiresAt: now }), /expiresAt/);
    assert.throws(() => add("bad-tenant", undefined, { tenantId: "other" }), /Receipt tenant/);
    assert.equal(ledger.get("root", "other"), undefined);
    assert.equal(ledger.find("root", "other").isPresent(), false);

    const other = await evidenceFixture("other");
    other.add("other-root");
    assert.throws(() => other.add("cross", ["root"]), /Unknown, invalid, or cross-tenant/);
});

test("evidence: transitive revocation, expiry and immutable audit records", async () => {
    const { ledger, add } = await evidenceFixture();
    add("root");
    add("child", ["root"]);
    add("grandchild", ["child"]);
    const changed = ledger.revoke("root", "tenant", "source withdrawn", now);
    assert.deepEqual([...changed].sort(), ["child", "grandchild", "root"]);
    assert.equal(Object.isFrozen(changed), true);
    assert.equal(ledger.get("root", "tenant")?.status, "revoked");
    assert.equal(ledger.get("child", "tenant")?.status, "pending_revalidation");
    assert.equal(ledger.get("grandchild", "tenant")?.status, "pending_revalidation");
    assert.equal(ledger.getConsumable("grandchild", "tenant", now), undefined);
    assert.ok(ledger.auditEvents().some(event => event.type === "evidence_revoked"));
    assert.throws(() => { (ledger.get("root", "tenant") as unknown as { status: string }).status = "active"; }, TypeError);
    assert.equal(ledger.getConsumable("root", "tenant", "not-a-date"), undefined);

    const fresh = await evidenceFixture();
    fresh.add("expiring", undefined, { expiresAt: "2026-11-06T13:00:00Z" });
    fresh.add("dependent", ["expiring"]);
    assert.equal(fresh.ledger.getConsumable("dependent", "tenant", "2026-11-06T14:00:00Z"), undefined);
    assert.equal(fresh.ledger.getConsumable("dependent", "tenant", now)?.id, "dependent");
    const stale = fresh.ledger.invalidateCause({ kind: "environment", id: "env-v1", tenantId: "tenant" }, "environment changed", now);
    assert.ok(stale.includes("expiring"));
    assert.equal(fresh.ledger.get("expiring", "tenant")?.status, "stale");
});

// ---------------------------------------------------------------------------
// Attention and context compiler
// ---------------------------------------------------------------------------

const attentionScope: AttentionScope = { tenantId: "tenant", principalId: "principal", sessionId: "session", turnId: "turn" };

const attentionObject = (patch: Partial<CreateAttentionInput> = {}): AttentionObject => {
    const id = patch.id ?? "a";
    return createAttention({
        id,
        summary: "summary",
        pointer: { kind: "file", id, version: "v1" },
        scope: attentionScope,
        budget: { tokens: 10000, bytes: 10000 },
        expiresAt: expiry,
        reason: "boundary",
        ...patch,
    }, now);
};

const attentionOperation = (object: AttentionObject, patch: Partial<AttentionOperationOptions> = {}): AttentionOperationOptions => ({
    expectedVersion: object.version,
    now,
    reason: "boundary operation",
    ...patch,
});

const mountedAttention = (id = "a", scope: AttentionScope = attentionScope): AttentionObject => {
    const object = attentionObject({ id, scope });
    return mount(object, attentionOperation(object));
};

test("attention: numeric, temporal and version boundaries are explicit", () => {
    assert.throws(() => attentionObject({ summary: "   " }), attentionCode("invalid"));
    assert.throws(() => attentionObject({ pointer: { kind: "file", id: "a", version: "" } }), attentionCode("invalid"));
    assert.throws(() => attentionObject({ budget: { tokens: -1 } }), attentionCode("invalid"));
    assert.throws(() => attentionObject({ budget: { tokens: Number.NaN } }), attentionCode("invalid"));
    assert.throws(() => attentionObject({ budget: { bytes: Number.POSITIVE_INFINITY } }), attentionCode("invalid"));
    assert.throws(() => attentionObject({ scores: { relevance: Number.NaN } }), attentionCode("invalid"));
    assert.throws(() => attentionObject({ scores: { urgency: 1.5 } }), attentionCode("invalid"));
    assert.throws(() => attentionObject({ expiresAt: now }), attentionCode("expired"));
    assert.throws(() => attentionObject({ expiresAt: "not-a-date" }), attentionCode("invalid"));

    const base = attentionObject();
    assert.throws(() => focus(base, attentionOperation(base), Number.NaN), attentionCode("invalid"));
    assert.throws(() => focus(base, attentionOperation(base), -0.1), attentionCode("invalid"));
    assert.throws(() => focus(base, attentionOperation(base), 1.1), attentionCode("invalid"));
    assert.throws(() => focus(base, { ...attentionOperation(base), expectedVersion: 0 }), attentionCode("version_conflict"));
    assert.throws(() => focus(base, { ...attentionOperation(base), now: "2026-11-05T00:00:00Z" }), /predates/);
    assert.throws(() => focus(base, { ...attentionOperation(base), reason: "" }), attentionCode("invalid"));
    const maxed = { ...base, version: Number.MAX_SAFE_INTEGER };
    assert.throws(() => focus(maxed, attentionOperation(maxed)), /exhausted/);
    assert.throws(() => update(base, { expiresAt: now }, attentionOperation(base)), attentionCode("expired"));
});

test("attention: retention and assessment boundaries stay separate from business verification", () => {
    const base = attentionObject();
    const retained = persist(base, { across: "turns", reason: "keep", expiresAt: expiry, budget: { tokens: 1 } }, attentionOperation(base));
    assert.equal(retained.retention?.across, "turns");
    assert.throws(() => persist(base, { across: "turns", reason: "keep", expiresAt: expiry, budget: {} }, attentionOperation(base)), /explicit budget/);
    assert.throws(() => persist(base, { across: "turns", reason: "keep", expiresAt: "2027-01-01T00:00:00Z", budget: { tokens: 1 } }, attentionOperation(base)), /outlive/);
    assert.throws(() => persist(base, { across: "turns", reason: "keep", expiresAt: now, budget: { tokens: 1 } }, attentionOperation(base)), attentionCode("expired"));

    const verification: AttentionVerificationInput = {
        verifier: { kind: "ranking", id: "verifier", version: "1" },
        sourceVersion: "v1",
        posterior: 0.5,
        evidence: [],
        recommendation: "retain",
    };
    assert.throws(() => verifyAttention(retained, { ...verification, sourceVersion: "v2" }, attentionOperation(retained)), attentionCode("version_conflict"));
    assert.throws(() => verifyAttention(retained, { ...verification, posterior: Number.NaN }, attentionOperation(retained)), /posterior/);
    assert.throws(() => verifyAttention(retained, { ...verification, posterior: 1.5 }, attentionOperation(retained)), /posterior/);
    assert.throws(() => verifyAttention(retained, { ...verification, recommendation: "drop" as unknown as AttentionVerificationInput["recommendation"] }, attentionOperation(retained)), /recommendation/);
    const assessed = verifyAttention(retained, verification, attentionOperation(retained));
    assert.equal(assessed.assessment?.businessVerified, false);
    assert.equal(assessed.assessment?.objectVersion, assessed.version);
    assert.equal(assessed.assessment?.assessedAt, now);
});

const compile = (objects: readonly AttentionObject[], patch: Partial<CompileContextOptions> = {}) => compileContext(objects, {
    now,
    scope: attentionScope,
    budget: { tokens: 10000 },
    currentVersion: () => "v1",
    ...patch,
});

test("context: duplicate ids, exclusion reasons and exact token budget", () => {
    const active = mountedAttention("active");
    const foreign = mountedAttention("foreign", { ...attentionScope, tenantId: "other" });
    const expired = { ...mountedAttention("expired"), expiresAt: now };
    const stale = { ...mountedAttention("stale"), stale: true };
    const unmounted = attentionObject({ id: "unmounted" });
    const changed = mountedAttention("changed");
    const result = compile([active, foreign, expired, stale, unmounted, changed], {
        currentVersion: pointer => pointer.id === "changed" ? "v2" : "v1",
    });
    assert.deepEqual(result.items.map(item => item.id), ["active"]);
    assert.deepEqual(result.exclusions.map(item => item.reason).sort(), ["expired", "scope", "stale", "unmounted", "version"]);
    assert.equal(result.authorization, "not_granted");
    assert.equal(result.usage.bytes, new TextEncoder().encode(result.text).byteLength);
    assert.ok(result.text.includes("summary"));
    assert.throws(() => compile([active, active]), /Duplicate attention IDs/);

    const empty = compile([], { budget: { tokens: 1 }, currentVersion: () => undefined });
    assert.equal(empty.items.length, 0);
    assert.equal(empty.text, "");
    assert.deepEqual(empty.usage, { tokens: 0, milliseconds: 0, calls: 0, bytes: 0 });

    const exact = compile([active], { budget: { tokens: 5 }, countTokens: () => 5 });
    assert.equal(exact.items.length, 1);
    assert.equal(exact.usage.tokens, 5);
    assert.equal(exact.items[0]?.usage.tokens, 5);
    const over = compile([active], { budget: { tokens: 4 }, countTokens: () => 5 });
    assert.equal(over.items.length, 0);
    assert.equal(over.exclusions[0]?.reason, "budget");
    assert.equal(over.exclusions[0]?.pointer?.id, "active");
});

test("context: invalid scope, budget and tokenizer boundaries are rejected", () => {
    const active = mountedAttention("active");
    assert.throws(() => compile([], { budget: {} }), /tokens or bytes/);
    assert.throws(() => compile([], { budget: { tokens: Number.NaN } }), /finite/);
    assert.throws(() => compile([], { budget: { tokens: -1 } }), /finite/);
    assert.throws(() => compile([], { budget: { tokens: Number.POSITIVE_INFINITY } }), /finite/);
    assert.throws(() => compile([], { scope: { ...attentionScope, tenantId: "" } }), /tenantId/);
    assert.throws(() => compile([], { now: "not-a-date" }), /Invalid timestamp/);
    assert.throws(() => compile([active], { countTokens: () => Number.NaN }), /Tokenizer/);
    assert.throws(() => compile([active], { countTokens: () => Number.POSITIVE_INFINITY }), /Tokenizer/);
    assert.throws(() => compile([active], { countTokens: () => -1 }), /Tokenizer/);
    assert.throws(() => compile([active], { countTokens: () => 1.5 }), /Tokenizer/);
    assert.throws(() => compile([active], { countTokens: () => Number.MAX_SAFE_INTEGER + 1 }), /Tokenizer/);
});

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type Binding = (input: JsonValue, definition: ToolDefinition, context: ExecutionContext) => Promise<JsonValue>;

const executorFixture = (options: {
    binding?: Binding;
    decision?: PolicyDecision;
    ledger?: BudgetLedger;
    executor?: Partial<ExecutorOptions>;
} = {}) => {
    const manifests = new ManifestStore<JsonValue>(() => now);
    const value = manifest();
    manifests.put(value);
    const tool = manifests.createHandle(value, "tool");
    if (!tool) throw new Error("Fixture manifest is missing its tool handle.");
    const ledger = options.ledger ?? new BudgetLedger();
    if (!options.ledger) ledger.configure("budget", { tokens: 100, bytes: 1000, calls: 10, milliseconds: 10000 });
    const decision = options.decision ?? { allowed: true, policyVersion: "policy-1", reason: "allowed" };
    const binding: Binding = options.binding ?? (async () => ({ ok: true }));
    let sequence = 0;
    let invoked = 0;
    const executor = new Executor<JsonValue, JsonValue>(
        manifests,
        { authorize: async () => structuredClone(decision) },
        ledger,
        async (input, definition, context) => {
            invoked += 1;
            return binding(input, definition, context);
        },
        { id: () => `id-${++sequence}`, now: () => now, measure: () => ({ tokens: 1, bytes: 1 }), ...options.executor },
    );
    const call = (id = "child-1"): ChildCall => ({
        id,
        tool,
        arguments: { value: 1 },
        budget: { calls: 1, tokens: 1, bytes: 1, milliseconds: 1000 },
    });
    return { executor, manifests, manifest: value, ledger, tool, call, invoked: () => invoked };
};

test("executor: unknown tools and duplicate child ids fail before effects", async () => {
    const state = executorFixture();
    const unknown = await state.executor.run([{ ...state.call(), tool: { ...state.tool, toolId: "missing" } }], executionContext(), "budget");
    assert.equal(unknown.completed, false);
    assert.equal(unknown.children[0]?.observation.status, "failure");
    assert.match(unknown.children[0]?.failure ?? "", /stale, revoked, expired or absent/);
    assert.equal(state.invoked(), 0);
    await assert.rejects(state.executor.run([state.call(), state.call()], executionContext(), "budget"), /Duplicate ChildCall id/);
    assert.equal(state.invoked(), 0);
    const empty = await state.executor.run([], executionContext(), "budget");
    assert.deepEqual(empty, { children: [], completed: false });
});

test("executor: policy, approval, abort, budget and exception boundaries", async () => {
    const denied = executorFixture({ decision: { allowed: false, policyVersion: "policy-1", reason: "capability missing" } });
    const deniedResult = await denied.executor.run([denied.call()], executionContext(), "budget");
    assert.equal(deniedResult.completed, false);
    assert.match(deniedResult.children[0]?.failure ?? "", /capability missing/);
    assert.equal(denied.invoked(), 0);
    assert.equal(denied.ledger.snapshot("budget").reserved.calls, 0);

    const approval = executorFixture({ decision: { allowed: true, approvalRequired: true, policyVersion: "policy-1", reason: "approval required" } });
    assert.equal((await approval.executor.run([approval.call()], executionContext(), "budget")).completed, false);
    assert.equal(approval.invoked(), 0);

    const stalePolicy = executorFixture({ decision: { allowed: true, policyVersion: "policy-2", reason: "ok" } });
    assert.equal((await stalePolicy.executor.run([stalePolicy.call()], executionContext(), "budget")).completed, false);
    assert.equal(stalePolicy.invoked(), 0);

    const aborted = executorFixture({ executor: { assertActive: () => { throw new Error("cancellation epoch changed"); } } });
    const abortedResult = await aborted.executor.run([aborted.call()], executionContext(), "budget");
    assert.equal(abortedResult.children[0]?.observation.status, "failure");
    assert.match(abortedResult.children[0]?.failure ?? "", /cancellation epoch changed/);
    assert.equal(aborted.invoked(), 0);

    const limit = new BudgetLedger();
    limit.configure("budget", { calls: 1 });
    const exhausted = executorFixture({ ledger: limit });
    assert.equal((await exhausted.executor.run([exhausted.call("a")], executionContext(), "budget")).completed, true);
    const over = await exhausted.executor.run([exhausted.call("b")], executionContext(), "budget");
    assert.equal(over.completed, false);
    assert.match(over.children[0]?.failure ?? "", /exceed/);
    assert.equal(exhausted.invoked(), 1);

    const crashing = executorFixture({ binding: async () => { throw new Error("boom"); } });
    const crashed = await crashing.executor.run([crashing.call()], executionContext(), "budget");
    assert.equal(crashed.children[0]?.observation.status, "unknown");
    assert.equal(crashed.children[0]?.observation.error, "boom");
    assert.equal((crashed.children[0]?.observation.error ?? "").includes(" at "), false);
    assert.equal((crashed.children[0]?.observation.error ?? "").includes(".ts"), false);
});

test("executor: concurrent idempotency and unknown-outcome fencing", async () => {
    let release!: (value: JsonValue) => void;
    const gate = new Promise<JsonValue>((resolve) => { release = resolve; });
    const state = executorFixture({ binding: () => gate });
    const first = state.executor.run([state.call()], executionContext(), "budget");
    const second = state.executor.run([state.call()], executionContext({ executionId: "other" }), "budget");
    release({ ok: true });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(state.invoked(), 1);
    assert.deepEqual(a.children[0]?.output, { ok: true });
    assert.deepEqual(b.children[0]?.output, { ok: true });
    assert.equal(a.children[0]?.invocation.id, b.children[0]?.invocation.id);
    const invocation = a.children[0]?.invocation;
    assert.ok(invocation);
    assert.equal(Object.isFrozen(invocation), true);
    assert.equal(Object.isFrozen(invocation.context), true);
    assert.equal(Object.isFrozen(invocation.arguments), true);
    assert.throws(() => { (invocation as unknown as { toolId: string }).toolId = "tampered"; }, TypeError);
    const replay = await state.executor.run([state.call()], executionContext(), "budget");
    assert.equal(replay.children[0]?.invocation.toolId, "tool");
    assert.equal(state.invoked(), 1);
    const collision = await state.executor.run([{ ...state.call(), arguments: { value: 2 } }], executionContext(), "budget");
    assert.equal(collision.children[0]?.observation.status, "failure");
    assert.match(collision.children[0]?.failure ?? "", /different arguments/);

    const unknownState = executorFixture({ binding: async () => { throw new Error("timeout"); } });
    const operationId = childOperationKey(executionContext(), unknownState.call().id);
    const unknown = await unknownState.executor.run([unknownState.call()], executionContext(), "budget");
    assert.equal(unknown.children[0]?.observation.status, "unknown");
    assert.equal(unknownState.ledger.snapshot("budget").reserved.calls, 1);
    assert.equal(unknownState.executor.canRetry(operationId), false);
    const repeat = await unknownState.executor.run([unknownState.call()], executionContext(), "budget");
    assert.equal(repeat.children[0]?.observation.status, "unknown");
    assert.equal(unknownState.invoked(), 1);
    unknownState.executor.markReconciled(operationId);
    assert.equal(unknownState.executor.canRetry(operationId), true);
    const retried = await unknownState.executor.run([unknownState.call()], executionContext(), "budget");
    assert.equal(retried.children[0]?.observation.status, "unknown");
    assert.equal(unknownState.invoked(), 2);
});

const executorCode = (code: ExecutorError["code"]) => (error: unknown): boolean =>
    error instanceof ExecutorError && error.code === code;

test("executor: child fan-out limit has a stable error code and no effects", async () => {
    const state = executorFixture();
    const calls = Array.from({ length: 3 }, (_, index) => state.call(`child-${index}`));
    await assert.rejects(
        state.executor.run(calls, executionContext(), "budget", { maxChildCalls: 2 }),
        executorCode("child_limit_exceeded"),
    );
    assert.equal(state.invoked(), 0);
    assert.equal(state.ledger.snapshot("budget").reserved.calls, 0);

    const defaultLimit = Array.from({ length: 33 }, (_, index) => state.call(`default-${index}`));
    await assert.rejects(state.executor.run(defaultLimit, executionContext(), "budget"), executorCode("child_limit_exceeded"));
    assert.equal(state.invoked(), 0);
});

test("executor: timeout and abort signal fail unknown with stable codes", async () => {
    const hung = executorFixture({ binding: () => new Promise<JsonValue>(() => {}), executor: { timeoutMilliseconds: 10 } });
    const timedOut = await hung.executor.run([hung.call()], executionContext(), "budget");
    assert.equal(timedOut.completed, false);
    assert.equal(timedOut.children[0]?.observation.status, "unknown");
    assert.equal(timedOut.children[0]?.failure, "timeout");
    assert.equal(timedOut.children[0]?.observation.error, "timeout");
    assert.equal((timedOut.children[0]?.observation.error ?? "").includes(" at "), false);
    assert.equal(hung.ledger.snapshot("budget").reserved.calls, 1);

    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const controller = new AbortController();
    const abortedState = executorFixture({
        binding: () => { started(); return new Promise<JsonValue>(() => {}); },
        executor: { signal: controller.signal },
    });
    const running = abortedState.executor.run([abortedState.call()], executionContext(), "budget");
    await startedPromise;
    controller.abort();
    const aborted = await running;
    assert.equal(aborted.children[0]?.observation.status, "unknown");
    assert.equal(aborted.children[0]?.failure, "aborted");

    const preAborted = new AbortController();
    preAborted.abort();
    const preState = executorFixture({ executor: { signal: preAborted.signal } });
    const beforeInvocation = await preState.executor.run([preState.call()], executionContext(), "budget");
    assert.equal(beforeInvocation.children[0]?.observation.status, "failure");
    assert.equal(beforeInvocation.children[0]?.failure, "aborted");
    assert.equal(preState.invoked(), 0);
});
