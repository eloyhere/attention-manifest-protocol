#!/usr/bin/env node
/**
 * Checkpoint and append-only log checks: chain integrity, reopen, tamper, seal/verify.
 */
import assert from "node:assert/strict";

import { digestOf } from "../src/semantic/canonical.ts";
import {
    CheckpointDomain,
    checkpointBody,
    checkpointDigest,
    sealCheckpoint,
    verifyCheckpoint,
    verifySnapshotAgainstCheckpoint,
} from "../src/ledger/checkpoint.ts";
import type { CheckpointVerdict, LedgerCheckpoint } from "../src/ledger/checkpoint.ts";
import type { ChainEntry, LedgerSnapshot } from "../src/ledger/persistence.ts";
import { verifySnapshot } from "../src/ledger/persistence.ts";
import type { KeyPair } from "../src/manifest/sign.ts";
import { generateSigningKey } from "../src/manifest/sign.ts";
import { AppendLog, AppendLogError, MemoryAppendSink } from "../src/storage/appendLog.ts";
import type { LogEntry } from "../src/storage/appendLog.ts";

const AGENT: string = "a.checkpoint";
const TENANT: string = "tenant.alpha";
const ISSUED: string = "2026-10-26T00:00:00Z";
const GENESIS: string = `sha256:${"0".repeat(64)}`;

type SeededLog = {
    sink: MemoryAppendSink;
    log: AppendLog;
};

type TestBody = () => Promise<void> | void;

type Mutator = (record: Record<string, unknown>) => void;

type MutateLine = (lines: readonly string[], index: number, mutate: Mutator) => string[];

const Key: KeyPair = await generateSigningKey("a.checkpoint#1");
const OtherKey: KeyPair = await generateSigningKey("a.checkpoint#2");

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: TestBody) => Promise<void> = async (name: string, fn: TestBody): Promise<void> => {
    try {
        await fn();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        Failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

const seededLog: (agent?: string) => Promise<SeededLog> = async (agent: string = AGENT): Promise<SeededLog> => {
    const sink: MemoryAppendSink = new MemoryAppendSink();
    const log: AppendLog = await AppendLog.open(sink, agent);
    await log.append("event", { id: "ev.1", at: ISSUED });
    await log.append("claim", { id: "c.1", statement: "p", tier: "T2" });
    await log.append("receipt", { id: "r.1", outcome: "ok" });
    return { sink, log };
};

const snapshotOf: (log: AppendLog, agent?: string) => LedgerSnapshot = (log: AppendLog, agent: string = AGENT): LedgerSnapshot => {
    const entries: ChainEntry[] = log.entries().map((entry) => ({
        seq: entry.seq,
        kind: entry.kind,
        payload: entry.payload,
        prev: entry.prev,
        hash: entry.hash,
    }));
    return {
        amp: "0.1",
        kind: "ledger-snapshot",
        agent,
        tip: log.tip,
        count: log.count,
        entries,
    };
};

const mutateLine: MutateLine = (lines: readonly string[], index: number, mutate: Mutator): string[] => {
    const copy: string[] = [...lines];
    const record: Record<string, unknown> = JSON.parse(copy[index]) as Record<string, unknown>;
    mutate(record);
    copy[index] = JSON.stringify(record);
    return copy;
};

const assertOpenRejects: (lines: readonly string[]) => Promise<AppendLogError> = async (lines: readonly string[]): Promise<AppendLogError> => {
    try {
        await AppendLog.open(new MemoryAppendSink(lines), AGENT);
    } catch (error) {
        if (!(error instanceof AppendLogError)) {
            throw new Error(`expected AppendLogError, received ${`${error}`}`);
        }
        assert.ok(error.reasons.length > 0, "expected at least one verification reason");
        return error;
    }
    throw new Error("expected AppendLog.open to reject");
};

class FlakySink extends MemoryAppendSink {
    failNext = false;

    append(line: string): void {
        if (this.failNext) {
            this.failNext = false;
            throw new Error("sink write failed");
        }
        super.append(line);
    }
}

/**
 * chain
 */

await test("append builds a chain that matches persistence hashing", async () => {
    const { log }: SeededLog = await seededLog();
    assert.equal(log.count, 3);
    assert.equal(log.verify().ok, true);

    const entries: readonly LogEntry[] = log.entries();
    assert.deepEqual(
        entries.map((entry) => entry.seq),
        [0, 1, 2],
    );
    assert.equal(entries[0].prev, GENESIS);
    assert.equal(entries[1].prev, entries[0].hash);
    assert.equal(entries[2].prev, entries[1].hash);
    for (let index: number = 0; index < entries.length; index += 1) {
        const entry: LogEntry = entries[index];
        assert.equal(entry.hash, digestOf({ seq: entry.seq, kind: entry.kind, payload: entry.payload, prev: entry.prev }));
    }
    assert.equal(log.tip, entries[2].hash);
});

await test("at metadata round-trips but stays outside the hash", async () => {
    const sink: MemoryAppendSink = new MemoryAppendSink();
    const log: AppendLog = await AppendLog.open(sink, AGENT);
    const entry: LogEntry = await log.append("event", { id: "ev.1" }, { at: ISSUED });
    assert.equal(entry.at, ISSUED);

    const reopened: AppendLog = await AppendLog.open(sink, AGENT);
    assert.equal(reopened.entries()[0].at, ISSUED);

    const lines: string[] = mutateLine(sink.readAll(), 0, (record) => {
        record.at = "1999-01-01T00:00:00Z";
    });
    const tampered: AppendLog = await AppendLog.open(new MemoryAppendSink(lines), AGENT);
    assert.equal(tampered.verify().ok, true);
});

await test("payloads are normalized to the JSON that is stored", async () => {
    const sink: MemoryAppendSink = new MemoryAppendSink();
    const log: AppendLog = await AppendLog.open(sink, AGENT);
    const entry: LogEntry = await log.append("event", { id: "ev.1", missing: undefined });
    assert.deepEqual(entry.payload, { id: "ev.1" });

    const reopened: AppendLog = await AppendLog.open(sink, AGENT);
    assert.equal(reopened.verify().ok, true);
    assert.equal(reopened.tip, entry.hash);
});

await test("reopening the same sink restores count and tip", async () => {
    const { sink, log }: SeededLog = await seededLog();
    const reopened: AppendLog = await AppendLog.open(sink, AGENT);
    assert.equal(reopened.count, log.count);
    assert.equal(reopened.tip, log.tip);
    assert.deepEqual(reopened.entries(), log.entries());
    assert.equal(reopened.verify().ok, true);
});

await test("appending after reopen continues the sequence", async () => {
    const { sink, log }: SeededLog = await seededLog();
    const reopened: AppendLog = await AppendLog.open(sink, AGENT);
    const next: LogEntry = await reopened.append("frame", { id: "f.1" });
    assert.equal(next.seq, 3);
    assert.equal(next.prev, log.tip);

    const again: AppendLog = await AppendLog.open(sink, AGENT);
    assert.equal(again.count, 4);
    assert.equal(again.tip, next.hash);
    assert.equal(again.verify().ok, true);
});

await test("concurrent appends are serialized", async () => {
    const sink: MemoryAppendSink = new MemoryAppendSink();
    const log: AppendLog = await AppendLog.open(sink, AGENT);
    const [first, second]: [LogEntry, LogEntry] = await Promise.all([log.append("event", { id: "ev.0" }), log.append("event", { id: "ev.1" })]);
    assert.deepEqual([first.seq, second.seq], [0, 1]);
    assert.equal(second.prev, first.hash);
    assert.equal(log.count, 2);
    assert.equal(log.verify().ok, true);
});

/**
 * tamper
 */

await test("a tampered payload fails open", async () => {
    const { sink }: SeededLog = await seededLog();
    const lines: string[] = mutateLine(sink.readAll(), 1, (record) => {
        record.payload = { id: "c.1", statement: "forged", tier: "T2" };
    });
    const error: AppendLogError = await assertOpenRejects(lines);
    assert.ok(error.reasons.some((reason) => reason.includes("hash")));
});

await test("a tampered hash fails open", async () => {
    const { sink }: SeededLog = await seededLog();
    const lines: string[] = mutateLine(sink.readAll(), 1, (record) => {
        record.hash = `sha256:${"f".repeat(64)}`;
    });
    const error: AppendLogError = await assertOpenRejects(lines);
    assert.ok(error.reasons.some((reason) => reason.includes("hash")));
});

await test("a tampered seq fails open", async () => {
    const { sink }: SeededLog = await seededLog();
    const lines: string[] = mutateLine(sink.readAll(), 1, (record) => {
        record.seq = 7;
    });
    const error: AppendLogError = await assertOpenRejects(lines);
    assert.ok(error.reasons.some((reason) => reason.includes("seq")));
});

await test("a tampered prev fails open", async () => {
    const { sink }: SeededLog = await seededLog();
    const lines: string[] = mutateLine(sink.readAll(), 1, (record) => {
        record.prev = GENESIS;
    });
    const error: AppendLogError = await assertOpenRejects(lines);
    assert.ok(error.reasons.some((reason) => reason.includes("prev")));
});

await test("reordered lines fail open", async () => {
    const { sink }: SeededLog = await seededLog();
    const lines: string[] = sink.readAll();
    const reordered: string[] = [lines[1], lines[0], lines[2]];
    const error: AppendLogError = await assertOpenRejects(reordered);
    assert.ok(error.reasons.some((reason) => reason.includes("seq") || reason.includes("prev")));
});

await test("dropping a middle line fails open", async () => {
    const { sink }: SeededLog = await seededLog();
    const truncated: string[] = sink.readAll().filter((line, index) => index !== 1);
    const error: AppendLogError = await assertOpenRejects(truncated);
    assert.ok(error.reasons.some((reason) => reason.includes("seq") || reason.includes("prev")));
});

await test("invalid JSON fails open", async () => {
    const { sink }: SeededLog = await seededLog();
    const lines: string[] = sink.readAll();
    lines[0] = "{not json";
    const error: AppendLogError = await assertOpenRejects(lines);
    assert.ok(error.reasons.some((reason) => reason.includes("JSON")));
});

await test("an empty line fails open", async () => {
    const { sink }: SeededLog = await seededLog();
    const lines: string[] = [...sink.readAll(), ""];
    const error: AppendLogError = await assertOpenRejects(lines);
    assert.ok(error.reasons.some((reason) => reason.includes("empty")));
});

await test("a line missing canonical fields fails open", async () => {
    const { sink }: SeededLog = await seededLog();
    const record: Record<string, unknown> = JSON.parse(sink.readAll()[0]) as Record<string, unknown>;
    record.kind = undefined;
    const lines: string[] = [JSON.stringify(record), ...sink.readAll().slice(1)];
    const error: AppendLogError = await assertOpenRejects(lines);
    assert.ok(error.reasons.some((reason) => reason.includes("kind")));
});

await test("verify fails closed after an in-memory mutation", async () => {
    const { log }: SeededLog = await seededLog();
    log.entries()[0].payload = { id: "ev.1", forged: true };
    const verdict: CheckpointVerdict = log.verify();
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((reason) => reason.includes("hash")));
});

/**
 * sink failures
 */

await test("a failed sink write leaves count and tip unchanged", async () => {
    const sink: FlakySink = new FlakySink();
    const log: AppendLog = await AppendLog.open(sink, AGENT);
    const first: LogEntry = await log.append("event", { id: "ev.0" });
    const beforeTip: string = log.tip;

    sink.failNext = true;
    await assert.rejects(() => log.append("event", { id: "ev.1" }), /sink write failed/);
    assert.equal(log.count, 1);
    assert.equal(log.tip, beforeTip);
    assert.equal(sink.readAll().length, 1);

    const retried: LogEntry = await log.append("event", { id: "ev.1" });
    assert.equal(retried.seq, 1);
    assert.equal(retried.prev, first.hash);
    assert.equal(log.count, 2);
    assert.equal(log.verify().ok, true);
});

/**
 * checkpoints
 */

await test("a sealed checkpoint verifies and binds the tip", async () => {
    const { log }: SeededLog = await seededLog();
    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });

    assert.equal(checkpoint.amp, "0.1");
    assert.equal(checkpoint.kind, "ledger-checkpoint");
    assert.equal(checkpoint.tenant, TENANT);
    assert.equal(checkpoint.agent, AGENT);
    assert.equal(checkpoint.seq, 0);
    assert.equal(checkpoint.count, log.count);
    assert.equal(checkpoint.tip, log.tip);
    assert.equal(checkpoint.issued, ISSUED);
    assert.equal(checkpoint.kid, Key.kid);
    assert.equal(checkpoint.prev, undefined);

    const verdict: CheckpointVerdict = await verifyCheckpoint(checkpoint, Key.publicKey);
    assert.equal(verdict.ok, true, verdict.reasons.join("; "));
});

await test("sealCheckpoint signs an empty snapshot", async () => {
    const snapshot: LedgerSnapshot = {
        amp: "0.1",
        kind: "ledger-snapshot",
        agent: AGENT,
        tip: GENESIS,
        count: 0,
        entries: [],
    };
    const checkpoint: LedgerCheckpoint = await sealCheckpoint(snapshot, Key, { tenant: TENANT, issued: ISSUED });
    assert.equal(checkpoint.count, 0);
    assert.equal(checkpoint.tip, GENESIS);
    assert.equal(checkpoint.seq, 0);

    const verdict: CheckpointVerdict = await verifyCheckpoint(checkpoint, Key.publicKey);
    assert.equal(verdict.ok, true, verdict.reasons.join("; "));
});

await test("the signed body is canonical and the digest excludes sig", async () => {
    const { log }: SeededLog = await seededLog();
    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });
    const reordered: Omit<LedgerCheckpoint, "sig"> = {
        kid: checkpoint.kid,
        issued: checkpoint.issued,
        tip: checkpoint.tip,
        count: checkpoint.count,
        seq: checkpoint.seq,
        agent: checkpoint.agent,
        tenant: checkpoint.tenant,
        kind: checkpoint.kind,
        amp: checkpoint.amp,
    };

    assert.equal(checkpointBody(reordered), checkpointBody(checkpoint));
    assert.ok(checkpointBody(checkpoint).startsWith('{"agent"'));
    assert.ok(CheckpointDomain.startsWith("amp:ledger-checkpoint:"));
    assert.equal(checkpointDigest({ ...checkpoint, sig: "AAAA" }), checkpointDigest(checkpoint));
    assert.notEqual(checkpointDigest({ ...checkpoint, tenant: "tenant.beta" }), checkpointDigest(checkpoint));
});

await test("signatures are domain-separated", async () => {
    const { log }: SeededLog = await seededLog();
    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });
    const signature: BufferSource = Buffer.from(checkpoint.sig, "base64url") as unknown as BufferSource;
    const encoder: TextEncoder = new TextEncoder();

    const valid: boolean = await crypto.subtle.verify(
        "Ed25519",
        Key.publicKey,
        signature,
        encoder.encode(`${CheckpointDomain}\n${checkpointBody(checkpoint)}`),
    );
    assert.equal(valid, true);

    const domainless: boolean = await crypto.subtle.verify("Ed25519", Key.publicKey, signature, encoder.encode(checkpointBody(checkpoint)));
    assert.equal(domainless, false);
});

await test("tenant, tip, count, seq, prev, and sig tampering fails", async () => {
    const { log }: SeededLog = await seededLog();
    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });
    const flipped: string = `${checkpoint.sig[0] === "A" ? "B" : "A"}${checkpoint.sig.slice(1)}`;
    const variants: Array<[string, LedgerCheckpoint]> = [
        ["tenant", { ...checkpoint, tenant: "tenant.evil" }],
        ["tip", { ...checkpoint, tip: `sha256:${"1".repeat(64)}` }],
        ["count", { ...checkpoint, count: checkpoint.count + 1 }],
        ["seq", { ...checkpoint, seq: checkpoint.seq + 1 }],
        ["prev", { ...checkpoint, prev: `sha256:${"2".repeat(64)}` }],
        ["sig", { ...checkpoint, sig: flipped }],
    ];

    for (let index: number = 0; index < variants.length; index += 1) {
        const [field, variant]: [string, LedgerCheckpoint] = variants[index];
        const verdict: CheckpointVerdict = await verifyCheckpoint(variant, Key.publicKey);
        assert.equal(verdict.ok, false, `tampered ${field} must not verify`);
        assert.ok(verdict.reasons.length > 0, `tampered ${field} needs a reason`);
    }
});

await test("empty tenant/agent and malformed tips are rejected", async () => {
    const { log }: SeededLog = await seededLog();
    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });

    const emptyTenant: CheckpointVerdict = await verifyCheckpoint({ ...checkpoint, tenant: "" }, Key.publicKey);
    assert.equal(emptyTenant.ok, false);
    assert.ok(emptyTenant.reasons.some((reason) => reason.includes("tenant")));

    const emptyAgent: CheckpointVerdict = await verifyCheckpoint({ ...checkpoint, agent: "" }, Key.publicKey);
    assert.equal(emptyAgent.ok, false);
    assert.ok(emptyAgent.reasons.some((reason) => reason.includes("agent")));

    const badTip: CheckpointVerdict = await verifyCheckpoint({ ...checkpoint, tip: "sha256:xyz" }, Key.publicKey);
    assert.equal(badTip.ok, false);
    assert.ok(badTip.reasons.some((reason) => reason.includes("tip")));
});

await test("a different key cannot verify the checkpoint", async () => {
    const { log }: SeededLog = await seededLog();
    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });
    const verdict: CheckpointVerdict = await verifyCheckpoint(checkpoint, OtherKey.publicKey);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((reason) => reason.includes("signature")));
});

await test("checkpoint chaining commits seq and the previous body digest", async () => {
    const { log }: SeededLog = await seededLog();
    const first: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });
    await log.append("event", { id: "ev.2" });
    const second: LedgerCheckpoint = await log.seal(Key, {
        tenant: TENANT,
        issued: "2026-10-26T00:00:01Z",
        previous: first,
    });

    assert.equal(second.seq, first.seq + 1);
    assert.equal(second.prev, checkpointDigest(first));

    const linked: CheckpointVerdict = await verifyCheckpoint(second, Key.publicKey, first);
    assert.equal(linked.ok, true, linked.reasons.join("; "));

    const standalone: CheckpointVerdict = await verifyCheckpoint(second, Key.publicKey);
    assert.equal(standalone.ok, true, standalone.reasons.join("; "));
});

await test("a broken prev/seq link is rejected", async () => {
    const { log }: SeededLog = await seededLog();
    const first: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });
    await log.append("event", { id: "ev.2" });
    const second: LedgerCheckpoint = await log.seal(Key, {
        tenant: TENANT,
        issued: "2026-10-26T00:00:01Z",
        previous: first,
    });

    const missingPrev: CheckpointVerdict = await verifyCheckpoint({ ...second, prev: undefined }, Key.publicKey, first);
    assert.equal(missingPrev.ok, false);
    assert.ok(missingPrev.reasons.some((reason) => reason.includes("missing prev")));

    const wrongPrev: CheckpointVerdict = await verifyCheckpoint({ ...second, prev: `sha256:${"3".repeat(64)}` }, Key.publicKey, first);
    assert.equal(wrongPrev.ok, false);
    assert.ok(wrongPrev.reasons.some((reason) => reason.includes("prev does not match")));

    const wrongSeq: CheckpointVerdict = await verifyCheckpoint({ ...second, seq: 7 }, Key.publicKey, first);
    assert.equal(wrongSeq.ok, false);
    assert.ok(wrongSeq.reasons.some((reason) => reason.includes("does not continue")));

    const backwards: CheckpointVerdict = await verifyCheckpoint(first, Key.publicKey, second);
    assert.equal(backwards.ok, false);
    assert.ok(backwards.reasons.some((reason) => reason.includes("does not continue")));
});

/**
 * snapshot agreement
 */

await test("a matching snapshot verifies against the checkpoint", async () => {
    const { log }: SeededLog = await seededLog();
    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });
    const snapshot: LedgerSnapshot = snapshotOf(log);

    assert.equal(verifySnapshot(snapshot).ok, true);
    const verdict: CheckpointVerdict = await verifySnapshotAgainstCheckpoint(snapshot, checkpoint);
    assert.equal(verdict.ok, true, verdict.reasons.join("; "));
});

await test("snapshot agent/count/tip and entry tampering fails", async () => {
    const { log }: SeededLog = await seededLog();
    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });
    const snapshot: LedgerSnapshot = snapshotOf(log);

    const agentVerdict: CheckpointVerdict = await verifySnapshotAgainstCheckpoint({ ...snapshot, agent: "a.other" }, checkpoint);
    assert.equal(agentVerdict.ok, false);
    assert.ok(agentVerdict.reasons.some((reason) => reason.includes("agent")));

    const countVerdict: CheckpointVerdict = await verifySnapshotAgainstCheckpoint({ ...snapshot, count: snapshot.count - 1 }, checkpoint);
    assert.equal(countVerdict.ok, false);
    assert.ok(countVerdict.reasons.some((reason) => reason.includes("count")));

    const tipVerdict: CheckpointVerdict = await verifySnapshotAgainstCheckpoint({ ...snapshot, tip: `sha256:${"4".repeat(64)}` }, checkpoint);
    assert.equal(tipVerdict.ok, false);
    assert.ok(tipVerdict.reasons.some((reason) => reason.includes("tip")));

    const broken: LedgerSnapshot = snapshotOf(log);
    broken.entries[1].payload = {
        ...(broken.entries[1].payload as Record<string, unknown>),
        statement: "forged",
    };
    const entryVerdict: CheckpointVerdict = await verifySnapshotAgainstCheckpoint(broken, checkpoint);
    assert.equal(entryVerdict.ok, false);
    assert.ok(entryVerdict.reasons.some((reason) => reason.includes("hash")));
});

await test("a freshly recomputed chain does not verify against the old checkpoint", async () => {
    const { log }: SeededLog = await seededLog();
    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });

    const attacker: AppendLog = await AppendLog.open(new MemoryAppendSink(), AGENT);
    await attacker.append("event", { id: "ev.1", forged: true });
    await attacker.append("claim", { id: "c.1", statement: "rewritten", tier: "T2" });
    await attacker.append("receipt", { id: "r.1", outcome: "ok" });

    assert.equal(attacker.count, checkpoint.count);
    assert.equal(attacker.verify().ok, true);
    assert.notEqual(attacker.tip, checkpoint.tip);

    const attackerSnapshot: LedgerSnapshot = snapshotOf(attacker);
    assert.equal(verifySnapshot(attackerSnapshot).ok, true);
    const verdict: CheckpointVerdict = await verifySnapshotAgainstCheckpoint(attackerSnapshot, checkpoint);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((reason) => reason.includes("tip")));

    const forgedCheckpoint: LedgerCheckpoint = await attacker.seal(Key, { tenant: TENANT, issued: ISSUED });
    const linked: CheckpointVerdict = await verifyCheckpoint(forgedCheckpoint, Key.publicKey, checkpoint);
    assert.equal(linked.ok, false);
});

await test("tail truncation is only detectable against a checkpoint", async () => {
    const { sink, log }: SeededLog = await seededLog();
    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });

    const truncated: AppendLog = await AppendLog.open(new MemoryAppendSink(sink.readAll().slice(0, -1)), AGENT);
    assert.equal(truncated.count, checkpoint.count - 1);
    assert.equal(truncated.verify().ok, true);

    const verdict: CheckpointVerdict = await verifySnapshotAgainstCheckpoint(snapshotOf(truncated), checkpoint);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((reason) => reason.includes("count") || reason.includes("tip")));
});

/**
 * empty log
 */

await test("an empty log opens, verifies, and seals a genesis checkpoint", async () => {
    const sink: MemoryAppendSink = new MemoryAppendSink();
    const log: AppendLog = await AppendLog.open(sink, AGENT);
    assert.equal(log.count, 0);
    assert.equal(log.tip, GENESIS);
    assert.deepEqual(log.entries(), []);
    assert.equal(log.verify().ok, true);

    const checkpoint: LedgerCheckpoint = await log.seal(Key, { tenant: TENANT, issued: ISSUED });
    assert.equal(checkpoint.count, 0);
    assert.equal(checkpoint.tip, GENESIS);
    const verdict: CheckpointVerdict = await verifyCheckpoint(checkpoint, Key.publicKey);
    assert.equal(verdict.ok, true, verdict.reasons.join("; "));

    const emptySnapshot: LedgerSnapshot = {
        amp: "0.1",
        kind: "ledger-snapshot",
        agent: AGENT,
        tip: GENESIS,
        count: 0,
        entries: [],
    };
    const snapshotVerdict: CheckpointVerdict = await verifySnapshotAgainstCheckpoint(emptySnapshot, checkpoint);
    assert.equal(snapshotVerdict.ok, true, snapshotVerdict.reasons.join("; "));

    const first: LogEntry = await log.append("event", { id: "ev.first" });
    assert.equal(first.seq, 0);
    assert.equal(first.prev, GENESIS);
    assert.equal(log.verify().ok, true);
});

await test("sealing without an agent fails closed", async () => {
    const log: AppendLog = await AppendLog.open(new MemoryAppendSink());
    await assert.rejects(() => log.seal(Key, { tenant: TENANT }), /without an agent/);

    const explicit: LedgerCheckpoint = await log.seal(Key, {
        tenant: TENANT,
        agent: "a.explicit",
        issued: ISSUED,
    });
    assert.equal(explicit.agent, "a.explicit");
    assert.equal((await verifyCheckpoint(explicit, Key.publicKey)).ok, true);
});

await test("sealing refuses a log mutated after open", async () => {
    const { log }: SeededLog = await seededLog();
    log.entries()[0].payload = { id: "ev.1", forged: true };
    await assert.rejects(() => log.seal(Key, { tenant: TENANT }), /broken append log/);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
