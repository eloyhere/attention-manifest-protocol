import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryFileStorage } from "./core.ts";
import { defaultCharset } from "./charset.ts";
import { NodeFileStorage } from "./node.ts";
import { Workspace } from "../workspace/core.ts";
import { WorkspaceError } from "../workspace/types.ts";
import type { EditOp, FileOperationReceipt, FileStoragePort, OutlineProvider } from "./types.ts";

function memory(content: string) {
    const storage = new InMemoryFileStorage();
    storage.put({ tenantId: "t", rootId: "r", path: "notes.md" }, content);
    const workspace = new Workspace({ tenantId: "t", rootId: "r", storage });
    const file = workspace.mount("notes.md", { mode: "writable", owner: "agent" });
    return { storage, file };
}

function code(expected: WorkspaceError["code"]) {
    return (error: unknown): boolean => error instanceof WorkspaceError && error.code === expected;
}

test("readLines returns bounded text with the anchors an edit needs", () => {
    const { file } = memory("l0\nl1\nl2\nl3\nl4\n");
    const read = file.readLines(1, 2);
    assert.equal(read.text, "l1\nl2\n");
    assert.equal(read.startLine, 1);
    assert.equal(read.lineCount, 2);
    assert.equal(read.totalLines, 6);
    assert.equal(read.truncated, true);
    assert.equal(read.range.startLine, 1);
    assert.equal(read.range.endLine, 3);
    assert.equal(read.baseHash, file.snapshot().baseHash);
    assert.equal(read.bufferVersion, file.snapshot().bufferVersion);
    const tail = file.readLines(4, 10);
    assert.equal(tail.truncated, false);
    assert.equal(tail.lineCount, 2);
    assert.throws(() => file.readLines(-1), code("invalid_range"));
    assert.throws(() => file.readLines(0, 0), code("invalid_range"));
});

test("expectedBaseHash rejects an edit aimed at a different committed version", () => {
    const { file } = memory("alpha\n");
    const base = file.snapshot().baseHash;
    file.write("beta\n", undefined, { expectedBaseHash: base });
    file.flush();
    const committed = file.snapshot().baseHash;
    assert.notEqual(committed, base);
    assert.throws(() => file.write("gamma\n", undefined, { expectedBaseHash: base }), code("version_conflict"));
    file.write("gamma\n", undefined, { expectedBaseHash: committed });
    assert.equal(file.read(), "gamma\n");
});

test("apply resolves every edit before committing and bumps the buffer once", () => {
    const { file } = memory("alpha\nbeta\n");
    const failing: EditOp[] = [
        { kind: "replace", target: { mode: "string", text: "alpha" }, replacement: "ALPHA" },
        { kind: "replace", target: { mode: "string", text: "absent" }, replacement: "x" },
    ];
    assert.throws(() => file.apply(failing), code("no_match"));
    assert.equal(file.read(), "alpha\nbeta\n");
    assert.equal(file.snapshot().bufferVersion, 0);

    const version = file.snapshot().bufferVersion;
    const edits: EditOp[] = [
        { kind: "replace", target: { mode: "line", start: 0, end: 1 }, replacement: "ALPHA" },
        { kind: "replace", target: { mode: "string", text: "beta" }, replacement: "BETA" },
    ];
    const plan = file.planApply(edits);
    assert.equal(plan.mode, "apply");
    assert.equal(plan.matches.length, 2);
    assert.equal(plan.text, "ALPHA\nBETA\n");
    file.apply(edits);
    assert.equal(file.read(), "ALPHA\nBETA\n");
    assert.equal(file.snapshot().bufferVersion, version + 1);
    assert.throws(() => file.apply([]), code("invalid_target"));
});

test("diff reports the committed base against the buffer", () => {
    const { file } = memory("alpha\nbeta\n");
    assert.equal(file.diff(), "");
    file.write("alpha\nBETA\n");
    const diff = file.diff();
    assert.match(diff, /^--- a\/notes\.md/m);
    assert.match(diff, /^\+\+\+ b\/notes\.md$/m);
    assert.match(diff, /^@@ /m);
    assert.match(diff, /^-beta$/m);
    assert.match(diff, /^\+BETA$/m);
    assert.match(diff, /^ alpha$/m);
});

test("repeating a flush with the same idempotency key does not recommit", () => {
    const { storage, file } = memory("alpha\n");
    file.write("beta\n");
    file.flush({ idempotencyKey: "commit-1" });
    const committed = storage.read({ tenantId: "t", rootId: "r", path: "notes.md" })!;
    file.flush({ idempotencyKey: "commit-1" });
    const again = storage.read({ tenantId: "t", rootId: "r", path: "notes.md" })!;
    assert.equal(again.version, committed.version);
    assert.equal(again.content, "beta\n");
});

test("the real adapter keeps CRLF and encoding across a WorkspaceFile commit", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-verify-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "notes.md"), "one\r\ntwo\r\n", "utf8");
    const storage = new NodeFileStorage({ root, fsync: false });
    const workspace = new Workspace({ tenantId: "t", rootId: "r", storage });
    const file = workspace.mount("notes.md", { mode: "writable", owner: "agent" });
    assert.equal(file.snapshot().eol, "\r\n");
    assert.equal(file.read(), "one\ntwo\n");
    file.write("ONE", { mode: "line", start: 0, end: 1 });
    assert.equal(file.read(), "ONE\ntwo\n");
    file.flush();
    assert.equal(readFileSync(join(root, "notes.md"), "utf8"), "ONE\r\ntwo\r\n");
    assert.equal(file.readLines(0, 1).eol, "\r\n");
});

/** Read-only adapter returning deliberately inconsistent metadata for validate() tests. */
function readOnlyStorage(content: string, hash: string): FileStoragePort {
    return {
        read: ref => ({ ...ref, content, hash, version: 3, updatedAt: "2026-01-01T00:00:00.000Z", charset: defaultCharset,
            size: Buffer.byteLength(content, "utf8") }),
        compareAndSwap: () => { throw new Error("fixture storage cannot commit"); },
        acquireLease: () => { throw new Error("fixture storage cannot lease"); },
        releaseLease: () => { /* no leases */ },
    };
}

test("validate reports hash and range findings without changing state", () => {
    const { file } = memory("alpha\n");
    const clean = file.validate();
    assert.deepEqual(clean, { valid: true, reasons: [] });
    assert.equal(file.state, "active");

    file.write("beta\n");
    assert.deepEqual(file.validate(), { valid: true, reasons: [] });
    assert.equal(file.state, "dirty", "validate must not clear a dirty buffer");

    const corrupt = new Workspace({ tenantId: "t", rootId: "r", storage: readOnlyStorage("alpha\n", "not-the-hash") }).mount("bad.txt");
    const hashReport = corrupt.validate();
    assert.equal(hashReport.valid, false);
    assert.equal(hashReport.reasons.some(reason => reason.includes("hash")), true);

    const external = memory("alpha\n");
    external.storage.put({ tenantId: "t", rootId: "r", path: "notes.md" }, "external\n");
    const externalReport = external.file.validate();
    assert.equal(externalReport.valid, false);
    assert.equal(externalReport.reasons.some(reason => reason.includes("stored file hash")), true);
    assert.equal(external.file.state, "active", "validate must report a hash mismatch without marking the file stale");

    const outline: OutlineProvider = { entries: () => [{ id: "bad", name: "bad", kind: "symbol",
        range: { startLine: 0, endLine: 99, startByte: 0, endByte: 9999 } }] };
    const rangedStorage = new InMemoryFileStorage();
    rangedStorage.put({ tenantId: "t", rootId: "r", path: "notes.md" }, "alpha\n");
    const ranged = new Workspace({ tenantId: "t", rootId: "r", storage: rangedStorage }).mount("notes.md", { outline });
    const rangeReport = ranged.validate();
    assert.equal(rangeReport.valid, false);
    assert.equal(rangeReport.reasons.some(reason => reason.includes("range")), true);

    const unmounted = new Workspace({ tenantId: "t", rootId: "r", storage: new InMemoryFileStorage() }).file("ghost.txt");
    assert.throws(() => unmounted.validate(), code("not_mounted"));
});

test("validate reports a buffer that cannot round-trip its charset", () => {
    const { file } = memory("alpha\n");
    file.write("lone\uD800surrogate\n");
    const report = file.validate();
    assert.equal(report.valid, false);
    assert.equal(report.reasons.some(reason => reason.includes("round trip")), true);
    assert.equal(file.state, "dirty");
});

test("diffHunks mirrors diff() for disk and hash-addressed baselines", () => {
    const { file } = memory("alpha\nbeta\ngamma\n");
    assert.deepEqual(file.diffHunks(), []);
    file.write("alpha\nBETA\ngamma\n");
    const expected = [{ startLine: 1, endLine: 2, removed: 1, added: 1 }];
    assert.deepEqual(file.diffHunks(), expected);
    assert.deepEqual(file.diffHunks("disk"), expected);
    assert.deepEqual(file.diffHunks({ hash: file.snapshot().baseHash }), expected);
    assert.throws(() => file.diffHunks({ hash: "sha256:deadbeef" }), code("version_conflict"));
    file.flush();
    assert.deepEqual(file.diffHunks(), []);
});

test("a reverting replace becomes clean and flush returns to active without a commit", () => {
    const { storage, file } = memory("alpha\n");
    file.replace({ mode: "string", text: "alpha" }, "beta");
    assert.equal(file.state, "dirty");
    file.replace({ mode: "string", text: "beta" }, "alpha");
    assert.equal(file.dirty, false);
    const flushed = file.flush();
    assert.equal(flushed.state, "active");
    assert.equal(flushed.version, 0);
    assert.equal(storage.read({ tenantId: "t", rootId: "r", path: "notes.md" })?.content, "alpha\n");
});

test("optional receipts fire after mount, flush and unmount", () => {
    const receipts: FileOperationReceipt[] = [];
    const storage = new InMemoryFileStorage();
    storage.put({ tenantId: "t", rootId: "r", path: "notes.md" }, "alpha\n");
    const workspace = new Workspace({ tenantId: "t", rootId: "r", storage, onFileReceipt: receipt => { receipts.push(receipt); } });
    const file = workspace.mount("notes.md", { mode: "writable", owner: "agent" });
    const mounted = file.snapshot();
    assert.equal(receipts.length, 1);
    assert.deepEqual({ kind: receipts[0]!.kind, path: receipts[0]!.path, version: receipts[0]!.version, hash: receipts[0]!.hash },
        { kind: "mount", path: "notes.md", version: mounted.version, hash: mounted.baseHash });
    assert.deepEqual({ ...receipts[0]!.workspaceAnchor }, { tenantId: "t", rootId: "r" });
    assert.equal(Number.isFinite(Date.parse(receipts[0]!.at)), true);

    file.write("beta\n");
    const flushed = file.flush();
    assert.equal(receipts.length, 2);
    assert.equal(receipts[1]!.kind, "flush");
    assert.equal(receipts[1]!.version, flushed.version);
    assert.equal(receipts[1]!.hash, flushed.baseHash);

    file.unmount();
    assert.equal(receipts.length, 3);
    assert.equal(receipts[2]!.kind, "unmount");
    assert.equal(receipts[2]!.version, flushed.version);
    assert.equal(receipts[2]!.hash, flushed.baseHash);
});
