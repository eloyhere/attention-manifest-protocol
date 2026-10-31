#!/usr/bin/env node
/**
 * Emits a schema-valid ledger snapshot for docs/examples.
 */
import { exportLedger } from "../src/ledger/persistence.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { digestOf } from "../src/semantic/canonical.ts";
import type { Frame } from "../src/frame/frame.ts";
import type { Claim, UnknownItem } from "../src/warrant/epistemic.ts";

const ledger = new Ledger();
ledger.unknowns.push({
    amp: "0.1",
    kind: "unknown",
    id: "u.1",
    question: "错误率上升是发布引起还是流量引起？",
    importance: 0.9,
    blocking: true,
    since: "2026-10-24T01:00:01Z",
    status: "open",
} as UnknownItem);

const frameBase: Omit<Frame, "digest"> = {
    amp: "0.1",
    kind: "frame",
    id: "f.101",
    agent: "a.gamma",
    cycle: 1,
    ts: "2026-10-24T01:00:03Z",
    mode: "triage",
    slots: [
        {
            target: { kind: "unknown", id: "u.1" },
            role: "question",
            salience: 0.9,
            voi: 0.9,
            cost: { tokens: 200 },
            budget: { tokens: 200 },
            why: "blocking unknown",
            state: "active",
        },
    ],
    ignored: [],
    budget: { allocated: { tokens: 2000 }, spent: { tokens: 0, calls: 0, ms: 0 } },
} as unknown as Omit<Frame, "digest">;
ledger.frames.push({ ...frameBase, digest: digestOf(frameBase) } as Frame);

ledger.claims.push({
    amp: "0.1",
    kind: "claim",
    id: "cl.1",
    statement: "发布导致错误率上升",
    tier: "T2",
    status: "held",
    warrant: {
        evidence: [{ id: "ev.1", kind: "observation", trust: "self", independence: 0.9, entails: true, origin: "a", at: "2026-10-24T01:00:05Z" }],
        inference: "abduction",
        strength: 0.7,
    },
    provenance: { source: "a.gamma", kind: "inference", trust: "self", at: "2026-10-24T01:00:05Z" },
    created: "2026-10-24T01:00:06Z",
    confidence: 0.882,
} as unknown as Claim);

console.log(JSON.stringify(exportLedger(ledger, "a.gamma"), null, 2));
