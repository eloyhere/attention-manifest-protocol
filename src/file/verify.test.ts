import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryFileStorage } from "./core.ts";
import { NodeFileStorage } from "./node.ts";
import { Workspace } from "../workspace/core.ts";
import { WorkspaceError } from "../workspace/types.ts";
import type { EditOp } from "./types.ts";

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
