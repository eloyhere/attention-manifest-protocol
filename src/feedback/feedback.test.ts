import assert from "node:assert/strict";
import test from "node:test";
import { FeedbackError, FeedbackLedger, assertFeedbackTransition } from "./index.ts";
import type {
    CaptureFeedbackInput,
    Feedback,
    FeedbackApplyResult,
    FeedbackErrorCode,
    FeedbackState,
    FeedbackTargetAdapter,
    FeedbackTargetKind,
    TriageDecision,
} from "./index.ts";

const at = "2026-11-07T00:00:00Z";

const newLedger = (): FeedbackLedger => new FeedbackLedger(() => at);

const baseInput = (id = "feedback:1"): CaptureFeedbackInput => ({
    id,
    source: "verification_result",
    polarity: "positive",
    target: { kind: "attention", id: "attention:1", version: 3 },
    evidenceIds: ["evidence:1"],
    reason: "verification passed",
});

const capture = (ledger: FeedbackLedger, id = "feedback:1", patch: Partial<CaptureFeedbackInput> = {}): Feedback =>
    ledger.capture({ ...baseInput(id), ...patch });

const normalizeFeedback = (ledger: FeedbackLedger, feedback: Feedback, scoreDelta?: number): Feedback =>
    ledger.normalize(feedback.id, {
        expectedVersion: feedback.version,
        ...(scoreDelta === undefined ? {} : { scoreDelta }),
    });

const triageFeedback = (ledger: FeedbackLedger, feedback: Feedback, decision: TriageDecision = "apply", reason?: string): Feedback =>
    ledger.triage(feedback.id, {
        expectedVersion: feedback.version,
        decision,
        ...(reason === undefined ? {} : { reason }),
    });

const readyForApply = (ledger: FeedbackLedger, decision: TriageDecision = "apply", reason?: string): Feedback =>
    triageFeedback(ledger, normalizeFeedback(ledger, capture(ledger)), decision, reason);

const applyFeedback = (ledger: FeedbackLedger, feedback: Feedback, adapter: FeedbackTargetAdapter): Feedback =>
    ledger.apply(feedback.id, adapter, { expectedVersion: feedback.version });

const verifyFeedback = (ledger: FeedbackLedger, feedback: Feedback, verificationId = "verification:1"): Feedback =>
    ledger.verify(feedback.id, { expectedVersion: feedback.version, verificationId });

const archiveFeedback = (ledger: FeedbackLedger, feedback: Feedback): Feedback =>
    ledger.archive(feedback.id, { expectedVersion: feedback.version });

const rejectFeedback = (ledger: FeedbackLedger, feedback: Feedback, reason = "not applicable"): Feedback =>
    ledger.reject(feedback.id, reason, { expectedVersion: feedback.version });

const errorCode = (code: FeedbackErrorCode): ((error: unknown) => boolean) =>
    (error: unknown): boolean => error instanceof FeedbackError && error.code === code;

interface Recorder {
    readonly adapter: FeedbackTargetAdapter;
    readonly calls: Feedback[];
}

const recordingAdapter = (kind: FeedbackTargetKind = "attention", targetVersion = 4): Recorder => {
    const calls: Feedback[] = [];
    return {
        calls,
        adapter: {
            kind,
            apply: (feedback: Feedback): FeedbackApplyResult => {
                calls.push(feedback);
                return { applied: true, targetVersion };
            },
        },
    };
};

test("capture starts in captured and validates reason, evidence, target and duplicate ids", () => {
    const ledger = newLedger();
    const feedback = capture(ledger);
    assert.equal(feedback.state, "captured");
    assert.equal(feedback.version, 1);
    assert.equal(feedback.createdAt, at);
    assert.equal(feedback.updatedAt, at);
    assert.deepEqual(feedback.target, { kind: "attention", id: "attention:1", version: 3 });
    assert.deepEqual([...feedback.evidenceIds], ["evidence:1"]);
    assert.ok(Object.isFrozen(feedback));
    assert.equal(ledger.get(feedback.id)?.id, feedback.id);

    assert.throws(() => capture(ledger, "feedback:1"), errorCode("invalid_feedback"));
    assert.throws(() => capture(ledger, "feedback:2", { reason: "   " }), errorCode("invalid_feedback"));
    assert.throws(() => capture(ledger, "feedback:3", { evidenceIds: [] }), errorCode("invalid_feedback"));
    assert.throws(
        () => capture(ledger, "feedback:4", { polarity: "negative", evidenceIds: [] }),
        errorCode("invalid_feedback"),
    );
    assert.throws(() => capture(ledger, "feedback:5", { evidenceIds: ["evidence:1", "evidence:1"] }), errorCode("invalid_feedback"));
    assert.throws(() => capture(ledger, "feedback:6", { scoreDelta: 1.5 }), errorCode("invalid_feedback"));
    assert.throws(
        () => capture(ledger, "feedback:7", { target: { kind: "unknown" as FeedbackTargetKind, id: "x" } }),
        errorCode("invalid_feedback"),
    );
    assert.equal(ledger.list().length, 1);
});

test("normalize accepts the scoreDelta boundaries and rejects out-of-range values", () => {
    for (const delta of [-1, -0.25, 0, 1]) {
        const ledger = newLedger();
        const captured = capture(ledger);
        const normalized = ledger.normalize(captured.id, { expectedVersion: captured.version, scoreDelta: delta });
        assert.equal(normalized.state, "normalized");
        assert.equal(normalized.scoreDelta, delta);
        assert.equal(ledger.get(captured.id)?.scoreDelta, delta);
    }
    for (const delta of [-1.0001, 1.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
        const ledger = newLedger();
        const captured = capture(ledger);
        assert.throws(
            () => ledger.normalize(captured.id, { expectedVersion: captured.version, scoreDelta: delta }),
            errorCode("invalid_feedback"),
        );
        assert.equal(ledger.get(captured.id)?.state, "captured");
    }
    const ledger = newLedger();
    const captured = capture(ledger);
    const target = { kind: "behavior" as const, id: "behavior:7", version: 2 };
    assert.deepEqual(ledger.normalize(captured.id, { expectedVersion: captured.version, target }).target, target);
});

test("triage records apply, reject and defer decisions and gates apply", () => {
    const ledger = newLedger();
    const deferred = triageFeedback(ledger, normalizeFeedback(ledger, capture(ledger)), "defer");
    assert.equal(deferred.state, "triaged");
    assert.equal(ledger.getTriage(deferred.id)?.decision, "defer");
    const recorder = recordingAdapter();
    assert.throws(() => applyFeedback(ledger, deferred, recorder.adapter), errorCode("invalid_transition"));
    assert.equal(recorder.calls.length, 0);
    assert.equal(ledger.get(deferred.id)?.state, "triaged");

    const rejecting = newLedger();
    const normalized = normalizeFeedback(rejecting, capture(rejecting));
    assert.throws(() => triageFeedback(rejecting, normalized, "reject"), errorCode("invalid_feedback"));
    const rejectedTriage = triageFeedback(rejecting, normalized, "reject", "wrong target");
    assert.equal(rejectedTriage.state, "triaged");
    assert.equal(rejecting.getTriage(rejectedTriage.id)?.decision, "reject");
    assert.equal(rejecting.getTriage(rejectedTriage.id)?.reason, "wrong target");
    assert.throws(() => applyFeedback(rejecting, rejectedTriage, recordingAdapter().adapter), errorCode("invalid_transition"));
});

test("apply calls the matching adapter once and records appliedAt and targetVersion", () => {
    const ledger = newLedger();
    const ready = readyForApply(ledger);
    const recorder = recordingAdapter("attention", 9);
    const applied = applyFeedback(ledger, ready, recorder.adapter);
    assert.equal(applied.state, "applied");
    assert.equal(applied.appliedAt, at);
    assert.equal(applied.target.version, 9);
    assert.equal(applied.version, ready.version + 1);
    assert.equal(recorder.calls.length, 1);
    assert.equal(recorder.calls[0]?.id, ready.id);
    assert.ok(Object.isFrozen(recorder.calls[0]));
    assert.equal(ledger.auditEvents(ready.id).at(-1)?.action, "apply");
    assert.equal(ledger.auditEvents(ready.id).at(-1)?.to, "applied");
});

test("apply failure is atomic: the record stays triaged and can be retried", () => {
    const ledger = newLedger();
    const ready = readyForApply(ledger);
    const refusing: FeedbackTargetAdapter = { kind: "attention", apply: () => ({ applied: false, targetVersion: 4 }) };
    assert.throws(() => applyFeedback(ledger, ready, refusing), errorCode("adapter_failed"));
    assert.equal(ledger.get(ready.id)?.state, "triaged");
    assert.equal(ledger.get(ready.id)?.version, ready.version);
    assert.equal(ledger.get(ready.id)?.appliedAt, undefined);

    const throwing: FeedbackTargetAdapter = { kind: "attention", apply: () => { throw new Error("target domain down"); } };
    assert.throws(() => applyFeedback(ledger, ready, throwing), /target domain down/);
    assert.equal(ledger.get(ready.id)?.state, "triaged");
    assert.equal(ledger.auditEvents(ready.id).some(event => event.action === "apply"), false);

    const invalidVersion = { kind: "attention", apply: () => ({ applied: true, targetVersion: -1 }) } as unknown as FeedbackTargetAdapter;
    assert.throws(() => applyFeedback(ledger, ready, invalidVersion), errorCode("invalid_feedback"));
    assert.equal(ledger.get(ready.id)?.state, "triaged");

    const recorder = recordingAdapter("attention", 5);
    const applied = applyFeedback(ledger, ready, recorder.adapter);
    assert.equal(applied.state, "applied");
    assert.equal(applied.target.version, 5);
    assert.equal(recorder.calls.length, 1);
});

test("verify requires a verification id and leaves the applied state untouched when missing", () => {
    const ledger = newLedger();
    const applied = applyFeedback(ledger, readyForApply(ledger), recordingAdapter().adapter);
    assert.throws(
        () => ledger.verify(applied.id, { expectedVersion: applied.version, verificationId: " " }),
        errorCode("invalid_feedback"),
    );
    assert.equal(ledger.get(applied.id)?.state, "applied");
    assert.equal(ledger.get(applied.id)?.verifiedAt, undefined);

    const verified = verifyFeedback(ledger, applied, "verification:42");
    assert.equal(verified.state, "verified");
    assert.equal(verified.verifiedAt, at);
    assert.equal(verified.version, applied.version + 1);
    assert.equal(ledger.auditEvents(verified.id).at(-1)?.action, "verify");
    assert.equal(verifyFeedback(ledger, applied, "verification:42").version, verified.version);
});

test("archive, reject and supersede follow the declared transition table", () => {
    const ledger = newLedger();
    const applied = applyFeedback(ledger, readyForApply(ledger), recordingAdapter().adapter);
    const verified = verifyFeedback(ledger, applied);
    const archived = archiveFeedback(ledger, verified);
    assert.equal(archived.state, "archived");
    assert.equal(archiveFeedback(ledger, verified).version, archived.version);
    assert.throws(() => archiveFeedback(ledger, archived), errorCode("invalid_transition"));

    const rejecting = newLedger();
    const triaged = readyForApply(rejecting);
    assert.throws(
        () => rejecting.reject(triaged.id, "   ", { expectedVersion: triaged.version }),
        errorCode("invalid_feedback"),
    );
    const rejected = rejectFeedback(rejecting, triaged, "does not match the task");
    assert.equal(rejected.state, "rejected");
    assert.equal(rejecting.auditEvents(rejected.id).at(-1)?.reason, "does not match the task");
    assert.equal(
        rejecting.reject(triaged.id, "does not match the task", { expectedVersion: triaged.version }).version,
        rejected.version,
    );
    assert.throws(() => archiveFeedback(rejecting, rejected), errorCode("invalid_transition"));

    const superseding = newLedger();
    const first = readyForApply(superseding);
    const second = capture(superseding, "feedback:2");
    assert.throws(
        () => superseding.supersede(first.id, first.id, { expectedVersion: first.version }),
        errorCode("invalid_feedback"),
    );
    assert.throws(
        () => superseding.supersede(first.id, "feedback:missing", { expectedVersion: first.version }),
        errorCode("invalid_feedback"),
    );
    const superseded = superseding.supersede(first.id, second.id, { expectedVersion: first.version });
    assert.equal(superseded.state, "superseded");
    assert.equal(superseded.supersededBy, "feedback:2");
    assert.equal(
        superseding.supersede(first.id, second.id, { expectedVersion: first.version }).version,
        superseded.version,
    );
    assert.throws(() => normalizeFeedback(superseding, superseded), errorCode("invalid_transition"));
});

test("every transition compares and swaps expectedVersion", () => {
    const ledger = newLedger();
    const captured = capture(ledger);
    assert.throws(
        () => ledger.normalize(captured.id, { expectedVersion: 2, scoreDelta: 0.1 }),
        errorCode("version_conflict"),
    );
    assert.equal(ledger.get(captured.id)?.state, "captured");

    const normalized = normalizeFeedback(ledger, captured, 0.1);
    assert.throws(
        () => ledger.normalize(captured.id, { expectedVersion: captured.version, scoreDelta: 0.2 }),
        errorCode("version_conflict"),
    );
    assert.throws(
        () => ledger.triage(captured.id, { expectedVersion: captured.version, decision: "apply" }),
        errorCode("version_conflict"),
    );
    assert.equal(ledger.get(captured.id)?.state, "normalized");

    const ready = triageFeedback(ledger, normalized);
    assert.throws(
        () => ledger.apply(ready.id, recordingAdapter().adapter, { expectedVersion: ready.version + 1 }),
        errorCode("version_conflict"),
    );
    assert.equal(ledger.get(ready.id)?.state, "triaged");
});

test("same-version same-action transitions are idempotent and add no audit event", () => {
    const ledger = newLedger();
    const captured = capture(ledger);
    const first = ledger.normalize(captured.id, { expectedVersion: captured.version, scoreDelta: 0.4 });
    const second = ledger.normalize(captured.id, { expectedVersion: captured.version, scoreDelta: 0.4 });
    assert.equal(second.version, first.version);
    assert.equal(second.updatedAt, first.updatedAt);
    assert.equal(ledger.auditEvents(captured.id).length, 1);

    const triaged = triageFeedback(ledger, first);
    const triagedAgain = ledger.triage(captured.id, { expectedVersion: first.version, decision: "apply" });
    assert.equal(triagedAgain.version, triaged.version);
    assert.equal(ledger.auditEvents(captured.id).length, 2);

    assert.throws(() => capture(ledger, captured.id), errorCode("invalid_feedback"));
});

test("idempotent apply never calls the adapter twice", () => {
    const ledger = newLedger();
    const ready = readyForApply(ledger);
    const recorder = recordingAdapter();
    const applied = applyFeedback(ledger, ready, recorder.adapter);
    const replayed = applyFeedback(ledger, ready, recorder.adapter);
    assert.equal(replayed.version, applied.version);
    assert.equal(replayed.updatedAt, applied.updatedAt);
    assert.equal(recorder.calls.length, 1);
    assert.equal(ledger.auditEvents(ready.id).filter(event => event.action === "apply").length, 1);
});

test("illegal transitions fail with the stable invalid_transition code", () => {
    const ledger = newLedger();
    const captured = capture(ledger);
    assert.throws(() => archiveFeedback(ledger, captured), errorCode("invalid_transition"));
    assert.throws(() => verifyFeedback(ledger, captured), errorCode("invalid_transition"));
    assert.throws(
        () => applyFeedback(ledger, captured, recordingAdapter().adapter),
        errorCode("invalid_transition"),
    );
    assert.throws(
        () => triageFeedback(ledger, captured),
        errorCode("invalid_transition"),
    );
    assert.throws(() => assertFeedbackTransition("applied", "captured"), errorCode("invalid_transition"));
    assert.throws(
        () => assertFeedbackTransition("unknown" as FeedbackState, "captured"),
        errorCode("invalid_transition"),
    );
    assert.equal(ledger.get(captured.id)?.state, "captured");
});

test("a mismatched adapter kind is rejected without calling the adapter", () => {
    const ledger = newLedger();
    const ready = readyForApply(ledger);
    const recorder = recordingAdapter("behavior", 2);
    assert.throws(() => applyFeedback(ledger, ready, recorder.adapter), errorCode("invalid_feedback"));
    assert.equal(recorder.calls.length, 0);
    assert.equal(ledger.get(ready.id)?.state, "triaged");
    assert.throws(
        () => ledger.apply(ready.id, {} as FeedbackTargetAdapter, { expectedVersion: ready.version }),
        errorCode("invalid_feedback"),
    );
    assert.equal(ledger.get(ready.id)?.state, "triaged");
});

test("the full lifecycle archives with one audit event per transition", () => {
    const ledger = newLedger();
    const captured = capture(ledger);
    const normalized = normalizeFeedback(ledger, captured, -0.2);
    const triaged = triageFeedback(ledger, normalized);
    const applied = applyFeedback(ledger, triaged, recordingAdapter("attention", 4).adapter);
    const verified = verifyFeedback(ledger, applied, "verification:42");
    const archived = archiveFeedback(ledger, verified);
    assert.deepEqual(
        [captured.state, normalized.state, triaged.state, applied.state, verified.state, archived.state],
        ["captured", "normalized", "triaged", "applied", "verified", "archived"],
    );
    const events = ledger.auditEvents(archived.id);
    assert.equal(events.length, 5);
    assert.deepEqual(
        events.map(event => event.action),
        ["normalize", "triage", "apply", "verify", "archive"],
    );
    assert.deepEqual(
        events.map(event => event.fromVersion),
        [1, 2, 3, 4, 5],
    );
    assert.deepEqual(events.map(event => event.version), [2, 3, 4, 5, 6]);
    assert.equal(events.at(-1)?.to, "archived");
    assert.deepEqual(ledger.get(archived.id), archived);
});

test("unknown feedback ids fail with invalid_feedback", () => {
    const ledger = newLedger();
    assert.equal(ledger.get("feedback:missing"), undefined);
    assert.equal(ledger.getTriage("feedback:missing"), undefined);
    assert.throws(() => ledger.normalize("feedback:missing", { expectedVersion: 1 }), errorCode("invalid_feedback"));
    assert.throws(() => archiveFeedback(ledger, { id: "feedback:missing", version: 1 } as Feedback), errorCode("invalid_feedback"));
});
