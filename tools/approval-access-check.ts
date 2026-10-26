#!/usr/bin/env node
/** Approval audit access control + field redaction. */
import assert from "node:assert/strict";

import { openStore } from "../src/database/store/database.ts";
import { RuntimeApprovalRepository } from "../src/database/repository/runtimeApprovalRepository.ts";
import { outboxEventSink } from "../src/database/adapter/runtimeSink.ts";
import { createProcess } from "../src/process/process.ts";
import { grant } from "../src/authz/authz.ts";
import type { Subject } from "../src/authz/authz.ts";
import { AuthzError } from "../src/error/authzError.ts";

const At = "2026-10-24T00:00:00.000Z";
const db = openStore(":memory:");
const owner = createProcess(db, { id: "a.approval.owner", name: "Owner" }, At);
const stranger = createProcess(db, { id: "a.approval.stranger", name: "Stranger" }, At);
const ownerSubject: Subject = { kind: "process", id: "a.approval.owner", pid: owner.pid };
const strangerSubject: Subject = { kind: "process", id: "a.approval.stranger", pid: stranger.pid };
const approvals = new RuntimeApprovalRepository(db);

outboxEventSink(
    db,
    {
        topic: "runtime.approval",
        payload: {
            pid: owner.pid,
            turnId: "rt.1",
            operationId: "op.1",
            tool: "deploy.rollback",
            risk: "destructive",
            decision: "token sk-abcdefghijklmnop123456",
            status: "denied",
        },
    },
    At,
);

const rows = approvals.list(owner.pid);
assert.equal(rows.length, 1);
assert.equal(rows[0].decision.includes("sk-abcdefghijklmnop123456"), false);
assert.equal(rows[0].decision.includes("[REDACTED]"), true);

assert.equal(approvals.listForSubject(ownerSubject, owner.pid, At).length, 1);
assert.throws(
    () => approvals.listForSubject(strangerSubject, owner.pid, At),
    (error: unknown) => error instanceof AuthzError && error.code === "permission_denied",
);

grant(
    db,
    {
        grantor: ownerSubject,
        grantee: strangerSubject,
        resource: { kind: "object", id: `approval:${owner.pid}`, ownerPid: owner.pid },
        rights: ["read"],
    },
    At,
);
assert.equal(approvals.listForSubject(strangerSubject, owner.pid, At).length, 1);
assert.equal(approvals.prune("2026-10-25T00:00:00.000Z"), 1);

db.close();
console.log("\x1b[32m✓\x1b[0m approval audit is authz-gated and redacted");
console.log("\n1 passed, 0 failed");
