#!/usr/bin/env node
/**
 * Evidence-aware tool routing, not static checklist order.
 */
import assert from "node:assert/strict";

import { buildDiagnosisFrame, routeTool } from "../src/diagnosis/index.ts";
import type { DiagnosticSignal } from "../src/diagnosis/index.ts";

const signal = (layer: DiagnosticSignal["layer"], kind: DiagnosticSignal["kind"], name: string): DiagnosticSignal => ({ layer, kind, name, state: "critical" });

const payment = buildDiagnosisFrame({
    id: "payment",
    summary: "DB CPU 92%, lock wait, query p99 high, pool saturated",
    symptoms: ["db-cpu"],
    signals: [
        signal("connection_pool", "saturation", "pool.pending"),
        signal("database", "utilization", "db.cpu"),
        signal("database", "latency", "db.query_p99"),
        signal("database", "saturation", "db.lock_wait"),
    ],
});
const paymentRoute = routeTool(payment);
assert.equal(paymentRoute?.tool, "pg_stat_statements");
assert.equal(paymentRoute?.layer, "database");
assert.equal(paymentRoute?.readOnly, true);

const lockOnly = buildDiagnosisFrame({
    id: "lock",
    summary: "blocking chain only",
    symptoms: ["lock"],
    signals: [signal("database", "saturation", "db.blocking_chain")],
});
assert.equal(routeTool(lockOnly)?.tool, "pg_locks");

const queue = buildDiagnosisFrame({
    id: "queue",
    summary: "consumer lag rising",
    symptoms: ["lag"],
    signals: [signal("queue", "saturation", "queue.lag"), signal("queue", "latency", "queue.consume_rate")],
});
assert.equal(routeTool(queue)?.tool, "queue_lag");

const cold = buildDiagnosisFrame({ id: "cold", summary: "unknown incident", symptoms: [] });
assert.equal(routeTool(cold)?.tool, "thread_dump");
assert.equal(routeTool(cold)?.readOnly, true);

console.log(`payment=${paymentRoute?.tool} lock=${routeTool(lockOnly)?.tool} queue=${routeTool(queue)?.tool} cold=${routeTool(cold)?.tool}`);
console.log("\x1b[32m✓\x1b[0m tool routing follows the top hypothesis and falls back to a read-only first probe");
console.log("\n1 passed, 0 failed");
