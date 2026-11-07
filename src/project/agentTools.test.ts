import assert from "node:assert/strict";
import test from "node:test";
import { AgentGateway } from "../agent/gateway.ts";
import { WorkspaceError } from "../workspace/types.ts";
import { createProjectToolHandlers, projectToolNames } from "./agentTools.ts";
import { Project } from "./core.ts";
import type { GatewayCallContext, GatewayCallRecord, GatewayHandler } from "../agent/gateway.ts";
import type { AgentBinding } from "../agent/surface.ts";
import type { ProjectEnvironment } from "./environment.ts";
import type { ProjectRule } from "./types.ts";

const scope = { tenantId: "tenant-a", rootId: "root-1" } as const;
const CONFIGURE = "attention_manifest_protocol_project.configure_environment";
const PUT_RULE = "attention_manifest_protocol_project.put_rule";
const DESCRIBE = "attention_manifest_protocol_project.describe_environment";

const BINDING: AgentBinding = Object.freeze({
    tenantId: "tenant-a",
    principalId: "principal-1",
    sessionId: "session-1",
    policyVersion: "policy-1",
    cancellationEpoch: 0,
});

const createProject = (): Project => new Project({ ...scope, kind: "go", clock: () => "2026-01-01T00:00:00.000Z" });

const code = (expected: WorkspaceError["code"]) => (error: unknown): boolean =>
    error instanceof WorkspaceError && error.code === expected;

const contextFor = (name: string): GatewayCallContext => Object.freeze({
    binding: BINDING,
    tool: Object.freeze({
        name,
        module: "project",
        verb: name.slice(name.indexOf(".") + 1),
        mutating: name !== DESCRIBE,
        authority: Object.freeze(["project:write"]),
        description: "test descriptor for a project tool",
    }),
});

const callTool = (handlers: Record<string, GatewayHandler>, name: string, parameters: Readonly<Record<string, unknown>> = {}): unknown => {
    const handler: GatewayHandler | undefined = handlers[name];
    if (handler === undefined) {
        throw new Error(`missing project tool handler: ${name}`);
    }
    return handler(parameters, contextFor(name));
};

test("the handler map covers exactly the declared project tools and stays synchronous", () => {
    assert.deepEqual([...projectToolNames], [CONFIGURE, PUT_RULE, DESCRIBE]);
    assert.equal(Object.isFrozen(projectToolNames), true);
    assert.equal(new Set(projectToolNames).size, projectToolNames.length);

    const handlers = createProjectToolHandlers(createProject());
    assert.equal(Object.isFrozen(handlers), true);
    assert.deepEqual(Object.keys(handlers).sort(), [...projectToolNames].sort());
    for (const name of projectToolNames) {
        assert.equal(typeof(handlers[name]), "function", name);
    }

    const configured: unknown = callTool(handlers, CONFIGURE, { variables: { CI: "true" } });
    const ruled: unknown = callTool(handlers, PUT_RULE, { id: "r1", text: "Keep modules small." });
    const brief: unknown = callTool(handlers, DESCRIBE);
    for (const result of [configured, ruled, brief]) {
        assert.equal(result instanceof Promise, false);
    }
    assert.equal(typeof(brief), "string");
});

test("configure_environment merges a valid patch and returns a frozen versioned snapshot", () => {
    const project = createProject();
    const handlers = createProjectToolHandlers(project);
    const result = callTool(handlers, CONFIGURE, {
        variables: { GO111MODULE: "on", GOPROXY: "" },
        paths: ["src", "test"],
        dependencies: [{ id: "go", scope: "build", version: ">=1.22" }],
    }) as { environment: ProjectEnvironment; version: number };

    assert.equal(result.version, 1);
    assert.equal(project.environmentVersion, 1);
    assert.equal(result.environment, project.environment);
    assert.deepEqual(result.environment.variables, { GO111MODULE: "on", GOPROXY: "" });
    assert.deepEqual(result.environment.paths, ["src", "test"]);
    assert.equal(result.environment.dependencies[0]?.id, "go");
    assert.equal(result.environment.dependencies[0]?.version, ">=1.22");

    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.environment), true);
    assert.equal(Object.isFrozen(result.environment.variables), true);
    assert.equal(Object.isFrozen(result.environment.paths), true);
    assert.equal(Object.isFrozen(result.environment.dependencies), true);
    assert.throws(() => { result.version = 9; }, TypeError);
    assert.throws(() => { (result.environment.variables as Record<string, string>).GO111MODULE = "off"; }, TypeError);
    assert.equal(result.version, 1);
    assert.equal(project.environment.variables.GO111MODULE, "on");
});

test("configure_environment rejects a stale expectedVersion without touching the environment", () => {
    const project = createProject();
    const handlers = createProjectToolHandlers(project);
    callTool(handlers, CONFIGURE, { variables: { A: "1" }, expectedVersion: 0 });

    assert.throws(() => callTool(handlers, CONFIGURE, { variables: { A: "2" }, expectedVersion: 0 }), code("version_conflict"));
    assert.equal(project.environmentVersion, 1);
    assert.deepEqual(project.environment.variables, { A: "1" });
});

test("configure_environment defaults a missing expectedVersion to the current revision", () => {
    const project = createProject();
    const handlers = createProjectToolHandlers(project);
    const first = callTool(handlers, CONFIGURE, { variables: { A: "1" } }) as { version: number };
    assert.equal(first.version, 1);
    const second = callTool(handlers, CONFIGURE, { variables: { A: "2" } }) as { version: number };
    assert.equal(second.version, 2);

    assert.throws(
        () => callTool(handlers, CONFIGURE, { variables: { A: "3" }, expectedVersion: 1 }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "version_conflict" && /version 2, expected 1/.test(error.message),
    );
    assert.equal(project.environmentVersion, 2);
    assert.deepEqual(project.environment.variables, { A: "2" });
});

test("configure_environment forwards invalid patches as invalid_project and keeps the previous environment", () => {
    const project = createProject();
    const handlers = createProjectToolHandlers(project);
    assert.throws(() => callTool(handlers, CONFIGURE, { variables: { "bad-name": "x" } }), code("invalid_project"));
    assert.throws(() => callTool(handlers, CONFIGURE, { paths: ["../escape"] }), code("invalid_project"));
    assert.throws(() => callTool(handlers, CONFIGURE, { dependencies: [{ id: "go", scope: "nope" }] }), code("invalid_project"));
    assert.throws(() => callTool(handlers, CONFIGURE, { variables: null }), code("invalid_project"));
    assert.equal(project.environmentVersion, 0);
    assert.deepEqual(project.environment.variables, {});
    assert.deepEqual(project.environment.paths, []);
    assert.deepEqual(project.environment.dependencies, []);
});

test("put_rule creates a rule in project scope and returns a frozen copy", () => {
    const project = createProject();
    const handlers = createProjectToolHandlers(project);
    const rule = callTool(handlers, PUT_RULE, { id: "r1", text: "Prefer small modules." }) as ProjectRule;

    assert.equal(rule.id, "r1");
    assert.equal(rule.tenantId, scope.tenantId);
    assert.equal(rule.rootId, scope.rootId);
    assert.equal(rule.text, "Prefer small modules.");
    assert.equal(rule.version, 1);
    assert.match(rule.hash, /^[0-9a-f]{64}$/);
    assert.equal(rule.updatedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(Object.isFrozen(rule), true);
    assert.deepEqual(project.getRule("r1"), rule);
    assert.throws(() => { (rule as { text: string }).text = "changed"; }, TypeError);
    assert.equal(project.getRule("r1")?.text, "Prefer small modules.");
});

test("put_rule updates an existing rule only under the current expectedVersion", () => {
    const project = createProject();
    const handlers = createProjectToolHandlers(project);
    const created = callTool(handlers, PUT_RULE, { id: "r1", text: "first" }) as ProjectRule;
    const updated = callTool(handlers, PUT_RULE, { id: "r1", text: "second", expectedVersion: 1 }) as ProjectRule;

    assert.equal(updated.version, 2);
    assert.notEqual(updated.hash, created.hash);
    assert.equal(project.getRule("r1")?.version, 2);
    assert.equal(project.getRule("r1")?.text, "second");

    assert.throws(() => callTool(handlers, PUT_RULE, { id: "r1", text: "third", expectedVersion: 1 }), code("version_conflict"));
    assert.throws(() => callTool(handlers, PUT_RULE, { id: "r1", text: "third" }), code("version_conflict"));
    assert.throws(() => callTool(handlers, PUT_RULE, { id: "new", text: "new rule", expectedVersion: 1 }), code("version_conflict"));
    assert.equal(project.getRule("r1")?.version, 2);
    assert.equal(project.getRule("new"), undefined);
});

test("describe_environment returns the project brief and changes nothing", () => {
    const project = createProject();
    project.configureEnvironment({ variables: { TEXINPUTS: "" }, paths: ["figures"] });
    const before: number = project.environmentVersion;
    const handlers = createProjectToolHandlers(project);
    const brief = callTool(handlers, DESCRIBE) as string;

    assert.equal(typeof(brief), "string");
    assert.equal(brief, project.describeEnvironment());
    assert.match(brief, /^# Project environment/m);
    assert.match(brief, /^kind: go$/m);
    assert.match(brief, /^version: 1$/m);
    assert.match(brief, /- TEXINPUTS = \(unset\)/);
    assert.match(brief, /- figures/);
    assert.equal(project.environmentVersion, before);
    assert.equal(project.listRules().length, 0);
});

test("unknown parameters and malformed CAS values are rejected with TypeError", () => {
    const project = createProject();
    const handlers = createProjectToolHandlers(project);
    assert.throws(() => callTool(handlers, CONFIGURE, { envVariables: { A: "1" } }), TypeError);
    assert.throws(() => callTool(handlers, PUT_RULE, { id: "r1", text: "t", scope: "other" }), TypeError);
    assert.throws(() => callTool(handlers, DESCRIBE, { id: "r1" }), TypeError);
    assert.throws(() => callTool(handlers, CONFIGURE, { variables: { A: "1" }, expectedVersion: "1" }), TypeError);
    assert.throws(() => callTool(handlers, CONFIGURE, { variables: { A: "1" }, expectedVersion: 1.5 }), TypeError);
    assert.throws(() => callTool(handlers, CONFIGURE, { variables: { A: "1" }, expectedVersion: -1 }), TypeError);
    assert.throws(() => callTool(handlers, PUT_RULE, { id: 7, text: "t" }), TypeError);
    assert.throws(() => callTool(handlers, PUT_RULE, { id: "r1", text: 7 }), TypeError);
    assert.throws(() => callTool(handlers, CONFIGURE, null as never), TypeError);
    assert.throws(() => callTool(handlers, CONFIGURE, [] as never), TypeError);
    assert.equal(project.environmentVersion, 0);
    assert.equal(project.listRules().length, 0);
});

test("the gateway dispatches project writes through this handler map", () => {
    const project = createProject();
    const calls: GatewayCallRecord[] = [];
    const gateway = new AgentGateway({
        handlers: createProjectToolHandlers(project),
        authorize: authority => authority.includes("project:write"),
        onCall: record => { calls.push(record); },
    });

    const configured = gateway.call(CONFIGURE, { variables: { CI: "true" }, expectedVersion: 0 }, { binding: BINDING, idempotencyKey: "op-config" });
    assert.equal((configured as { version: number }).version, 1);
    const ruled = gateway.call(PUT_RULE, { id: "r1", text: "Keep modules small." }, { binding: BINDING, idempotencyKey: "op-rule" });
    assert.equal((ruled as ProjectRule).version, 1);

    assert.deepEqual(calls.map(record => record.tool), [CONFIGURE, PUT_RULE]);
    assert.deepEqual(calls.map(record => record.mutating), [true, true]);
    assert.deepEqual(calls.map(record => record.idempotencyKey), ["op-config", "op-rule"]);
    assert.equal(calls.every(record => record.ok), true);
    assert.equal(project.environment.variables.CI, "true");
    assert.equal(project.getRule("r1")?.text, "Keep modules small.");
});
