#!/usr/bin/env node
/** Diagnostic frame: layer checklist, hypothesis discrimination, PlanTask bridge. */
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
import type { DiagnosticSignal } from "../src/diagnosis/index.ts";

const signal = (layer: DiagnosticSignal["layer"], kind: DiagnosticSignal["kind"], name: string): DiagnosticSignal => ({ layer, kind, name, state: "critical" });

const payment = buildDiagnosisFrame({
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

assert.deepEqual(validateDiagnosisFrame(payment), []);
const ranked = assessHypotheses(payment);
assert.equal(ranked[0].hypothesis.layer, "database");
assert.equal(selectLayer(payment).layer, "database");
assert.deepEqual(
    payment.steps.map((step) => step.layer),
    ["thread_pool", "connection_pool", "connect", "database", "queue", "application", "release"],
);
assert.equal(
    payment.steps.every((step) => step.readOnly),
    true,
);
const tasks = toPlanTasks(payment);
assert.equal(tasks.length, payment.steps.length);
assert.equal(
    tasks.every((task) => task.irreversibility === 0),
    true,
);
assert.equal(tasks[0].expect.observation.length > 0, true);
const action = toActionPlan(payment);
assert.ok(action);
assert.equal(action.risk, "read");
assert.equal(action.intent, "diagnose:database");

const context = toContextAst(payment, 800);
assert.ok(context.view.tokens <= 800);
assert.match(context.view.text, /database/);
assert.equal(context.top?.hypothesis.layer, "database");
const signalDetail = context.ast.expand("signal.database.db.lock_wait", context.details);
assert.ok(signalDetail?.includes("db.lock_wait"));

const added = observe(payment, signal("queue", "saturation", "queue.lag"));
assert.equal(payment.incident.signals?.length, 7);
assert.equal(added.incident.signals?.length, 8);

const connect = buildDiagnosisFrame({
    id: "connect",
    summary: "pool wait high but active low; TLS handshake slow",
    symptoms: ["connect-latency"],
    signals: [signal("connect", "latency", "connect.p99"), signal("connect", "latency", "tls.handshake")],
});
assert.equal(selectLayer(connect).layer, "connect");

const queue = buildDiagnosisFrame({
    id: "queue",
    summary: "lag rising, consumers idle",
    symptoms: ["queue-lag"],
    signals: [signal("queue", "saturation", "queue.lag"), signal("queue", "latency", "queue.consume_rate"), signal("application", "utilization", "app.cpu")],
});
assert.equal(selectLayer(queue).layer, "queue");

const code = buildDiagnosisFrame({
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
assert.equal(selectLayer(code).layer, "application");

console.log("\x1b[32m✓\x1b[0m diagnostic frame orders layers, discriminates DB/connect/queue/code causes, and emits read-only PlanTasks");
console.log("\n1 passed, 0 failed");
