import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryFileStorage } from "./core.ts";
import { Workspace } from "../workspace/core.ts";
import { WorkspaceError } from "../workspace/types.ts";

const ref = { tenantId: "t", rootId: "r", path: "notes.md" } as const;

function fixture(content: string) {
    const storage = new InMemoryFileStorage();
    storage.put(ref, content);
    const file = new Workspace({ tenantId: "t", rootId: "r", storage }).mount("notes.md", { mode: "writable", owner: "agent" });
    return { storage, file };
}

function code(expected: WorkspaceError["code"]) {
    return (error: unknown): boolean => error instanceof WorkspaceError && error.code === expected;
}

test("a clean buffer yields an empty, frozen structured diff", () => {
    const { file } = fixture("alpha\nbeta\n");
    const diff = file.diffStructured();
    assert.equal(diff.base, "disk");
    assert.equal(diff.baseHash, file.snapshot().baseHash);
    assert.equal(diff.bufferVersion, file.snapshot().bufferVersion);
    assert.deepEqual(diff.hunks, []);
    assert.deepEqual(diff.summary, { added: 0, removed: 0, changed: 0 });
    assert.equal(diff.truncated, false);
    assert.equal(Object.isFrozen(diff), true);
    assert.equal(Object.isFrozen(diff.hunks), true);
    assert.equal(Object.isFrozen(diff.summary), true);
});

test("a single-line edit reports one hunk with its line counts", () => {
    const { file } = fixture("alpha\nbeta\ngamma\n");
    file.write("alpha\nBETA\ngamma\n");
    const diff = file.diffStructured();
    assert.equal(diff.base, "disk");
    assert.equal(diff.bufferVersion, 1);
    assert.deepEqual(diff.hunks, [{ startLine: 1, endLine: 2, removed: 1, added: 1 }]);
    assert.deepEqual(diff.summary, { added: 1, removed: 1, changed: 1 });
    assert.equal(diff.truncated, false);
});

test("additions and removals are counted across separate hunks", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `${index}`);
    const base = `${lines.join("\n")}\n`;
    const after = [...lines.slice(0, 1), ...lines.slice(2, 16), "new", ...lines.slice(16)];
    const { file } = fixture(base);
    file.write(`${after.join("\n")}\n`);
    const diff = file.diffStructured();
    assert.equal(diff.hunks.length, 2);
    assert.deepEqual(diff.hunks[0], { startLine: 1, endLine: 2, removed: 1, added: 0 });
    assert.deepEqual(diff.hunks[1], { startLine: 16, endLine: 16, removed: 0, added: 1 });
    assert.deepEqual(diff.summary, { added: 1, removed: 1, changed: 2 });
});

test("maxHunks truncates only the returned hunks while summary stays complete", () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line${index}`);
    const changed = lines.map((line, index) => [1, 10, 19].includes(index) ? `changed${index}` : line);
    const { file } = fixture(`${lines.join("\n")}\n`);
    file.write(`${changed.join("\n")}\n`);

    const full = file.diffStructured();
    assert.equal(full.hunks.length, 3);
    assert.deepEqual(full.summary, { added: 3, removed: 3, changed: 3 });
    assert.equal(full.truncated, false);

    const limited = file.diffStructured("disk", { maxHunks: 2 });
    assert.equal(limited.hunks.length, 2);
    assert.deepEqual(limited.hunks, full.hunks.slice(0, 2));
    assert.deepEqual(limited.summary, full.summary);
    assert.equal(limited.truncated, true);

    const empty = file.diffStructured("disk", { maxHunks: 0 });
    assert.deepEqual(empty.hunks, []);
    assert.equal(empty.truncated, true);
    assert.deepEqual(empty.summary, full.summary);
    assert.throws(() => file.diffStructured("disk", { maxHunks: -1 }), code("invalid_target"));
});

test("a hash-addressed base compares against the committed version only", () => {
    const { file } = fixture("alpha\nbeta\n");
    const baseHash = file.snapshot().baseHash;
    file.write("alpha\nBETA\n");
    const diff = file.diffStructured({ hash: baseHash });
    assert.deepEqual(diff.base, { hash: baseHash });
    assert.equal(diff.baseHash, baseHash);
    assert.deepEqual(diff.hunks, [{ startLine: 1, endLine: 2, removed: 1, added: 1 }]);
    assert.throws(() => file.diffStructured({ hash: "sha256:deadbeef" }), code("version_conflict"));
    file.flush();
    assert.throws(() => file.diffStructured({ hash: baseHash }), code("version_conflict"));
});

test("binary mounts reject structured diffs as invalid_target", () => {
    const storage = new InMemoryFileStorage();
    storage.putBytes(ref, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const file = new Workspace({ tenantId: "t", rootId: "r", storage }).mount("notes.md");
    assert.equal(file.snapshot().binary, true);
    assert.throws(() => file.diffStructured(), code("invalid_target"));
    assert.throws(() => file.diffHunks(), code("invalid_target"));
});

test("a stale base stays diffable for both committed and newer storage hashes", () => {
    const { storage, file } = fixture("alpha\nbeta\n");
    const baseHash = file.snapshot().baseHash;
    file.write("alpha\nBETA\n");
    storage.put(ref, "host changed\n");
    assert.throws(() => file.read(), code("stale"));
    assert.equal(file.stale, true);

    const committed = file.diffStructured();
    assert.equal(committed.baseHash, baseHash);
    assert.deepEqual(committed.hunks, [{ startLine: 1, endLine: 2, removed: 1, added: 1 }]);

    const hostHash = storage.read(ref)!.hash;
    const newer = file.diffStructured({ hash: hostHash });
    assert.deepEqual(newer.base, { hash: hostHash });
    assert.equal(newer.baseHash, hostHash);
    assert.deepEqual(newer.summary, { added: 2, removed: 1, changed: 1 });
});
