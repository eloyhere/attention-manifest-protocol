#!/usr/bin/env node
/**
 * Capability checks: ownership, attenuation, expiry, recursive revoke and
 * thread inheritance. These tests define what "isolated" means in a system
 * without an MMU: a subject sees its own resources and whatever it was granted,
 * and nothing else.
 */
import assert from "node:assert/strict";

import type { Action, Resource, Subject } from "../src/authz/authz.ts";
import { can, grant, listCapabilities, requirePermission, revoke } from "../src/authz/authz.ts";
import { AuthzError } from "../src/error/authzError.ts";
import { createProcess } from "../src/process/process.ts";
import { openStore } from "../src/database/store/database.ts";

const At: string = "2026-10-24T00:00:00.000Z";
const Later: string = "2026-10-24T01:00:00.000Z";
const TooLate: string = "2026-10-24T02:00:00.000Z";
const Earlier: string = "2026-10-23T00:00:00.000Z";

let passed: number = 0;
let failed: number = 0;

const test = (name: string, fn: () => void): void => {
    try {
        fn();
        passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

const rejects =
    (code: string) =>
    (error: unknown): boolean =>
        error instanceof AuthzError && error.code === code;

const setup = () => {
    const db = openStore(":memory:");
    const a = createProcess(db, { id: "a.authz.a", name: "Agent A" }, At);
    const b = createProcess(db, { id: "a.authz.b", name: "Agent B" }, At);
    const subjectA: Subject = { kind: "process", id: "a.authz.a", pid: a.pid };
    const subjectB: Subject = { kind: "process", id: "a.authz.b", pid: b.pid };
    const threadB: Subject = { kind: "thread", id: "t.b", pid: b.pid, tid: 1 };
    const resource: Resource = { kind: "object", id: "obj.1", ownerPid: a.pid };
    return { db, a, b, subjectA, subjectB, threadB, resource };
};

test("owner is allowed and a stranger is denied", () => {
    const { db, subjectA, subjectB, resource } = setup();
    assert.equal(can(db, subjectA, "read", resource, At), true);
    assert.equal(can(db, subjectA, "kill", resource, At), true);
    assert.equal(can(db, subjectB, "read", resource, At), false);
    assert.throws(() => requirePermission(db, subjectB, "read", resource, At), rejects("permission_denied"));
    db.close();
});

test("a read grant allows read but not write", () => {
    const { db, subjectA, subjectB, resource } = setup();
    grant(db, { grantor: subjectA, grantee: subjectB, resource, rights: ["read"] }, At);
    assert.equal(can(db, subjectB, "read", resource, At), true);
    assert.equal(can(db, subjectB, "write", resource, At), false);
    db.close();
});

test("rights cannot be amplified when re-granting", () => {
    const { db, subjectA, subjectB, threadB, resource } = setup();
    grant(db, { grantor: subjectA, grantee: subjectB, resource, rights: ["read", "grant"] }, At);
    const wrong: Action[] = ["write"];
    assert.throws(() => grant(db, { grantor: subjectB, grantee: threadB, resource, rights: wrong }, At), rejects("rights_amplification"));
    db.close();
});

test("expiry cannot outlive the grantor's capability", () => {
    const { db, subjectA, subjectB, threadB, resource } = setup();
    grant(db, { grantor: subjectA, grantee: subjectB, resource, rights: ["read", "grant"], expiresAt: Later }, At);
    assert.throws(
        () => grant(db, { grantor: subjectB, grantee: threadB, resource, rights: ["read"], expiresAt: TooLate }, At),
        rejects("expiry_amplification"),
    );
    const ok = grant(db, { grantor: subjectB, grantee: threadB, resource, rights: ["read"], expiresAt: Later }, At);
    assert.equal(ok.rights.includes("read"), true);
    db.close();
});

test("expired capabilities stop working", () => {
    const { db, subjectA, subjectB, resource } = setup();
    grant(db, { grantor: subjectA, grantee: subjectB, resource, rights: ["read"], expiresAt: Earlier }, At);
    assert.equal(can(db, subjectB, "read", resource, At), false);
    db.close();
});

test("revoke cascades to derived grants", () => {
    const { db, subjectA, subjectB, threadB, resource } = setup();
    const bCap = grant(db, { grantor: subjectA, grantee: subjectB, resource, rights: ["read", "grant"] }, At);
    grant(db, { grantor: subjectB, grantee: threadB, resource, rights: ["read"] }, At);
    assert.equal(can(db, threadB, "read", resource, At), true);
    const revoked = revoke(db, subjectA, bCap.hid, Later);
    assert.equal(revoked, 2);
    assert.equal(can(db, subjectB, "read", resource, Later), false);
    assert.equal(can(db, threadB, "read", resource, Later), false);
    db.close();
});

test("a thread inherits its process capabilities", () => {
    const { db, subjectA, subjectB, threadB, resource } = setup();
    grant(db, { grantor: subjectA, grantee: subjectB, resource, rights: ["read"] }, At);
    assert.equal(can(db, threadB, "read", resource, At), true);
    assert.equal(can(db, threadB, "write", resource, At), false);
    db.close();
});

test("host is the only superuser", () => {
    const { db, resource } = setup();
    const host: Subject = { kind: "host", id: "host" };
    assert.equal(can(db, host, "write", resource, At), true);
    assert.equal(can(db, host, "revoke", resource, At), true);
    db.close();
});

test("capabilities are listed and audited", () => {
    const { db, subjectA, subjectB, resource } = setup();
    grant(db, { grantor: subjectA, grantee: subjectB, resource, rights: ["read"] }, At);
    const list = listCapabilities(db, subjectB);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.resource.id, "obj.1");
    const events = db.prepare("SELECT COUNT(*) AS n FROM objects WHERE kind = 'event'").get() as { n: number };
    assert.equal(events.n >= 1, true);
    db.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
