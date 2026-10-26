#!/usr/bin/env node
/**
 * Sharing, IPC and window integration checks.
 *
 * These are the first tests where isolation is exercised through the public
 * surface: address-space membership, capability grants, a mailbox with a
 * capability and a capacity, and a context window that survives a step.
 */
import assert from "node:assert/strict";

import { Database } from "../src/database/service/database.ts";
import { attachObject, forkProcess, joinProcess, processObjects, readProcessObject } from "../src/process/process.ts";
import { Mailbox } from "../src/ipc/mailbox.ts";
import { MailboxError } from "../src/error/mailboxError.ts";
import { AuthzError } from "../src/error/authzError.ts";
import { KernelError } from "../src/error/kernelError.ts";
import { Kernel } from "../src/kernel/index.ts";
import type { Subject } from "../src/authz/authz.ts";

const At: string = "2026-10-24T00:00:00.000Z";

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

const denies =
    (code: string) =>
    (error: unknown): boolean =>
        (error instanceof AuthzError && error.code === code) ||
        (error instanceof MailboxError && error.code === code) ||
        (error instanceof KernelError && error.code === code);

test("address space is private until a capability maps an object", () => {
    const db = new Database(":memory:");
    const p1 = db.processService.create({ id: "a.addr.1", name: "Agent One" }, At);
    const p2 = db.processService.create({ id: "a.addr.2", name: "Agent Two" }, At);
    const object = db.objectService.put("claim", "cl.addr.1", { statement: "private" }, At);
    attachObject(db.db, p1.pid, object.seq, "own", "write", At);
    const subject1: Subject = { kind: "process", id: "a.addr.1", pid: p1.pid };
    const subject2: Subject = { kind: "process", id: "a.addr.2", pid: p2.pid };

    assert.equal(readProcessObject(db.db, p1.pid, object.seq, subject1, At).id, "cl.addr.1");
    assert.throws(() => readProcessObject(db.db, p2.pid, object.seq, subject2, At), denies("unknown_object"));

    const capability = db.handleService.grant(
        {
            grantor: subject1,
            grantee: subject2,
            resource: { kind: "object", id: `${object.seq}`, ownerPid: p1.pid },
            rights: ["read"],
        },
        At,
    );
    attachObject(db.db, p2.pid, object.seq, "mapped", "read", At);
    assert.equal(readProcessObject(db.db, p2.pid, object.seq, subject2, At).id, "cl.addr.1");
    db.handleService.revoke(subject1, capability.hid, At);
    assert.throws(() => readProcessObject(db.db, p2.pid, object.seq, subject2, At), denies("permission_denied"));
    db.close();
});

test("fork inherits a read-only view and join merges the child's own objects", () => {
    const db = new Database(":memory:");
    const parent = db.processService.create({ id: "a.fork.1", name: "Parent Agent" }, At);
    const base = db.objectService.put("claim", "cl.fork.base", { statement: "base" }, At);
    attachObject(db.db, parent.pid, base.seq, "own", "write", At);

    const child = forkProcess(db.db, parent.pid, { id: "a.fork.child", name: "Child Agent" }, At);
    assert.equal(child.parentPid, parent.pid);
    const subjectChild: Subject = { kind: "process", id: "a.fork.child", pid: child.pid };
    assert.equal(readProcessObject(db.db, child.pid, base.seq, subjectChild, At).role, "inherited");

    const own = db.objectService.put("claim", "cl.fork.child", { statement: "child work" }, At);
    attachObject(db.db, child.pid, own.seq, "own", "write", At, subjectChild);
    assert.equal(
        processObjects(db.db, parent.pid).some((row) => row.seq === own.seq),
        false,
    );

    const merged = joinProcess(db.db, child.pid, parent.pid, At);
    assert.equal(merged, 1);
    assert.equal(
        processObjects(db.db, parent.pid).some((row) => row.seq === own.seq),
        true,
    );
    db.close();
});

test("mailbox requires a send capability and enforces capacity", () => {
    const db = new Database(":memory:");
    const sender = db.processService.create({ id: "a.mail.1", name: "Sender Agent" }, At);
    const receiver = db.processService.create({ id: "a.mail.2", name: "Receiver Agent" }, At);
    const subjectSender: Subject = { kind: "process", id: "a.mail.1", pid: sender.pid };
    const subjectReceiver: Subject = { kind: "process", id: "a.mail.2", pid: receiver.pid };
    const mailbox = new Mailbox(db.db, db.messageService, { capacity: 1 });

    assert.throws(() => mailbox.send(subjectSender, { toPid: receiver.pid, kind: "event", body: { n: 1 } }, At), denies("permission_denied"));

    db.handleService.grant(
        {
            grantor: subjectReceiver,
            grantee: subjectSender,
            resource: { kind: "mailbox", id: `${receiver.pid}`, ownerPid: receiver.pid },
            rights: ["send"],
        },
        At,
    );

    const sent = mailbox.send(subjectSender, { toPid: receiver.pid, kind: "event", body: { n: 1 }, correlationId: "corr-1" }, At);
    assert.equal(db.messageService.pendingCount(receiver.pid), 1);
    assert.throws(() => mailbox.send(subjectSender, { toPid: receiver.pid, kind: "event", body: { n: 2 } }, At), denies("mailbox_full"));

    const delivery = mailbox.receive(subjectReceiver, At);
    assert.ok(delivery);
    assert.equal(db.objectService.get("receipt", delivery.receiptId)?.id, delivery.receiptId);
    assert.equal(mailbox.receive(subjectReceiver, At), (void 0));
    assert.equal(db.messageService.pendingCount(receiver.pid), 0);

    const replay = mailbox.send(subjectSender, { toPid: receiver.pid, kind: "event", body: { n: 1 }, correlationId: "corr-1" }, At);
    assert.equal(replay.id, sent.id);
    db.close();
});

test("the kernel restores a thread's window across steps", () => {
    const db = new Database(":memory:");
    const process = db.processService.create({ id: "a.win.1", name: "Window Agent" }, At);
    const thread = db.threadService.spawn(
        {
            pid: process.pid,
            goal: "g.win.1",
            statement: "keep a window across steps",
            success: [{ id: "c.win.1", statement: "window restored", check: "inspect" }],
        },
        At,
    );
    const kernel = new Kernel(db.db, { now: () => At, windowTokens: 100 });

    const first = kernel.step((context) => {
        context.window.fault("claim", "cl.win.1", 40);
        return { status: "yield" };
    });
    assert.ok(first);
    assert.equal(db.windowService.pages(thread.tid).length, 1);

    const second = kernel.step((context) => {
        assert.equal(context.window.has("claim", "cl.win.1"), true);
        assert.equal(context.window.usedTokens, 40);
        return { status: "done" };
    });
    assert.ok(second);
    assert.equal(second.status, "done");
    assert.equal(db.processService.byId(process.pid)?.state, "idle");
    kernel.close();
    db.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
