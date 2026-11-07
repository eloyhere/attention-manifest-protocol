import assert from "node:assert/strict";
import test from "node:test";
import {
    advanceEvidence,
    advanceReceipt,
    EVIDENCE_TRANSITIONS,
    EvidenceLedger,
    receiptLifecycle,
} from "./provenance.ts";

test("provenance barrel exposes the receipt and evidence extensions", () => {
    assert.equal(typeof advanceEvidence, "function");
    assert.equal(typeof advanceReceipt, "function");
    assert.equal(typeof EvidenceLedger, "function");
    assert.equal(receiptLifecycle.issued.includes("signed"), true);
    assert.equal(receiptLifecycle.revoked.includes("purged"), true);
    assert.equal(EVIDENCE_TRANSITIONS.active.includes("corroborated"), true);
    assert.equal(EVIDENCE_TRANSITIONS.purged.length, 0);
    assert.equal(advanceReceipt("signed", "anchored"), "anchored");
    assert.equal(advanceEvidence("normalized", "validated"), "validated");
});
