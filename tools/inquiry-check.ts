#!/usr/bin/env node
/**
 * Inquiry profile checks: pre-registration, looks, tiers, replication.
 */
import assert from "node:assert/strict";

import { digestOf } from "../src/semantic/canonical.ts";
import { InquiryLog, preregHashOf, replicationCheck } from "../src/warrant/inquiry.ts";
import type { Experiment, ReplicationVerdict, RunContext } from "../src/warrant/inquiry.ts";
import type { Hypothesis } from "../src/types/index.ts";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => void = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

let Tick: number = 0;
const now: () => string = () => new Date(Date.parse("2026-10-24T04:00:00Z") + Tick++ * 1000).toISOString();

const hypothesis: (overrides?: Partial<Hypothesis>) => Hypothesis = (overrides: Partial<Hypothesis> = {}): Hypothesis => {
    const statement: string = "the deploy caused the error-rate spike";
    const metric: string = "5xx_rate";
    const stopping: string = "fixed_n_10m";
    return {
        amp: "0.1",
        kind: "hypothesis",
        id: "h.1",
        question: { kind: "unknown", id: "u.1" },
        statement,
        prediction: "rollback restores baseline",
        refutes_if: "error rate stays 3x above baseline",
        status: "testing",
        created: "2026-10-24T03:00:00Z",
        prereg: {
            hash: preregHashOf({ statement, metric, stopping, exclusions: [] }),
            registered_at: "2026-10-24T03:00:00Z",
            metric,
            stopping,
            exclusions: [],
            looks: 0,
        },
        ...overrides,
    };
};

test("registration requires a pre-registered hypothesis", () => {
    const log: InquiryLog = new InquiryLog({ now });
    assert.throws(() => log.register({ ...hypothesis(), prereg: undefined }), /pre-registered/);
});

test("a tampered hypothesis fails its hash check", () => {
    const log: InquiryLog = new InquiryLog({ now });
    const h: Hypothesis = hypothesis();
    h.statement = "the traffic spike caused the error rate";
    assert.throws(() => log.register(h), /hash does not match/);
});

test("looks are recorded and counted", () => {
    const log: InquiryLog = new InquiryLog({ now });
    const experiment: Experiment = log.register(hypothesis());
    log.observe(experiment.id, 0.061);
    log.observe(experiment.id, 0.052);
    assert.equal(log.experiment(experiment.id).looks.length, 2);
});

test("extra looks beyond a fixed-n design produce a warning", () => {
    const log: InquiryLog = new InquiryLog({ now });
    const experiment: Experiment = log.register(hypothesis());
    log.observe(experiment.id, 0.061);
    log.observe(experiment.id, 0.052);
    assert.ok(log.experiment(experiment.id).warnings.some((w) => w.includes("fixed-n")));
});

test("cannot conclude without a look", () => {
    const log: InquiryLog = new InquiryLog({ now });
    const experiment: Experiment = log.register(hypothesis());
    assert.throws(() => log.conclude(experiment.id, "supported"), /without a single look/);
});

test("completed experiment earns T3, registered-only stays T2", () => {
    const log: InquiryLog = new InquiryLog({ now });
    const experiment: Experiment = log.register(hypothesis());
    assert.equal(log.tierOf(experiment.id), "T2");
    log.observe(experiment.id, 0.061);
    log.conclude(experiment.id, "supported");
    assert.equal(log.tierOf(experiment.id), "T3");
});

test("replication requires a different run, seed and origin", () => {
    const original: RunContext = { runId: "run.1", seed: "s1", origin: "prod" };
    assert.equal(replicationCheck(original, { ...original }).ok, false);
    assert.equal(replicationCheck(original, { runId: "run.2", seed: "s1", origin: "prod" }).ok, false);
    assert.equal(replicationCheck(original, { runId: "run.2", seed: "s2", origin: "prod" }).ok, false);
    const ok: ReplicationVerdict = replicationCheck(original, { runId: "run.2", seed: "s2", origin: "staging" });
    assert.equal(ok.ok, true);
    assert.equal(ok.tier, "T4");
});

test("same environment is a warning, not a fatal failure", () => {
    const verdict: ReplicationVerdict = replicationCheck(
        { runId: "run.1", seed: "s1", origin: "prod", environment: "cn-east" },
        { runId: "run.2", seed: "s2", origin: "prod-2", environment: "cn-east" },
    );
    assert.equal(verdict.ok, true);
    assert.ok(verdict.reasons.some((r) => r.includes("environment")));
});

test("prereg hash is canonical and stable", () => {
    const a: string = preregHashOf({ statement: "s", metric: "m", stopping: "fixed_n", exclusions: ["x"] });
    const b: string = digestOf({ statement: "s", metric: "m", stopping: "fixed_n", exclusions: ["x"] });
    assert.equal(a, b);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
