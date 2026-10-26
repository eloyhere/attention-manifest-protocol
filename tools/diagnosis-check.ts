#!/usr/bin/env node
/**
 * Diagnostic frame: layer checklist, hypothesis discrimination, PlanTask bridge.
 */
import assert from "node:assert/strict";

import {
    assessHypotheses,
    buildDiagnosisFrame,
    observe,
    selectLayer,
    toActionPlan,
    toContextAst,
    toPlanTasks,
    validateDiagnosisFrame,
} from "../src/diagnosis/index.ts";
import type { DiagnosisContext, DiagnosticFrame, DiagnosticSignal, HypothesisAssessment } from "../src/diagnosis/index.ts";
import type { PlanTask } from "../src/goal/plan.ts";
import type { ActionPlan } from "../src/runtime/action.ts";

type Layer = DiagnosticSignal["layer"];

type Kind = DiagnosticSignal["kind"];

type SignalFactory = (layer: Layer, kind: Kind, name: string) => DiagnosticSignal;

const signal: SignalFactory = (layer: Layer, kind: Kind, name: string): DiagnosticSignal => ({ layer, kind, name, state: "critical" });

const Payment: DiagnosticFrame = buildDiagnosisFrame({
    id: "payment-api",
    summary: "p99 2.8s, 5xx 8%, pool saturated, DB CPU 92%",
    symptoms: ["latency", "errors", "pool-saturation", "db-cpu"],
    signals: [
        signal("thread_pool", "utilization", "thread.active_max"),
        signal("connection_pool", "utilization", "pool.active_max"),
        signal("connection_pool", "saturation", "pool.pending"),
        signal("connection_pool", "latency", "pool.checkout_wait"),
        signal("database", "utilization", "db.cpu"),
        signal("database", "latency", "db.query_p99"),
        signal("database", "saturation", "db.lock_wait"),
    ],
});

assert.deepEqual(validateDiagnosisFrame(Payment), []);
const Ranked: HypothesisAssessment[] = assessHypotheses(Payment);
assert.equal(Ranked[0].hypothesis.layer, "database");
assert.equal(selectLayer(Payment).layer, "database");
assert.deepEqual(
    Payment.steps.map((step) => step.layer),
    ["thread_pool", "connection_pool", "connect", "database", "queue", "application", "release"],
);
assert.equal(
    Payment.steps.every((step) => step.readOnly),
    true,
);
const Tasks: PlanTask[] = toPlanTasks(Payment);
assert.equal(Tasks.length, Payment.steps.length);
assert.equal(
    Tasks.every((task) => task.irreversibility === 0),
    true,
);
assert.equal(Tasks[0].expect.observation.length > 0, true);
const Action: ActionPlan | undefined = toActionPlan(Payment);
assert.ok(Action);
assert.equal(Action.risk, "read");
assert.equal(Action.intent, "diagnose:database");

const Context: DiagnosisContext = toContextAst(Payment, 800);
assert.ok(Context.view.tokens <= 800);
assert.match(Context.view.text, /database/);
assert.equal(Context.top?.hypothesis.layer, "database");
const SignalDetail: string | undefined = Context.ast.expand("signal.database.db.lock_wait", Context.details);
assert.ok(SignalDetail?.includes("db.lock_wait"));

const Added: DiagnosticFrame = observe(Payment, signal("queue", "saturation", "queue.lag"));
assert.equal(Payment.incident.signals?.length, 7);
assert.equal(Added.incident.signals?.length, 8);

const Connect: DiagnosticFrame = buildDiagnosisFrame({
    id: "connect",
    summary: "pool wait high but active low; TLS handshake slow",
    symptoms: ["connect-latency"],
    signals: [signal("connect", "latency", "connect.p99"), signal("connect", "latency", "tls.handshake")],
});
assert.equal(selectLayer(Connect).layer, "connect");

const Queue: DiagnosticFrame = buildDiagnosisFrame({
    id: "queue",
    summary: "lag rising, consumers idle",
    symptoms: ["queue-lag"],
    signals: [signal("queue", "saturation", "queue.lag"), signal("queue", "latency", "queue.consume_rate"), signal("application", "utilization", "app.cpu")],
});
assert.equal(selectLayer(Queue).layer, "queue");

const Code: DiagnosticFrame = buildDiagnosisFrame({
    id: "code",
    summary: "DB queries fast, CPU/GC high only on new version",
    symptoms: ["cpu"],
    signals: [
        signal("database", "latency", "db.query_ok"),
        signal("application", "utilization", "app.cpu"),
        signal("application", "saturation", "app.gc_pause"),
        signal("release", "errors", "release.only_new_version"),
    ],
});
assert.equal(selectLayer(Code).layer, "application");

console.log("\x1b[32m✓\x1b[0m diagnostic frame orders layers, discriminates DB/connect/queue/code causes, and emits read-only PlanTasks");
console.log("\n1 passed, 0 failed");
