import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileStorage, createNodeFileTreeHost } from "./node.ts";
import { NodeFileLock } from "./lock.ts";
import { decodeText, detectCharset, encodeText } from "./charset.ts";
import { WorkspaceError } from "../workspace/types.ts";
import type { FileRef } from "./types.ts";

function sandbox(t: { after: (fn: () => void) => void }, options: { maxFileBytes?: number } = {}) {
    const root = mkdtempSync(join(tmpdir(), "amp-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const storage = new NodeFileStorage({ root, fsync: false, ...options });
    const ref = (path: string): FileRef => ({ tenantId: "t", rootId: "r", path });
    return { root, storage, ref };
}

function code(expected: WorkspaceError["code"]) {
    return (error: unknown): boolean => error instanceof WorkspaceError && error.code === expected;
}

const utf16Crlf = (text: string): Uint8Array => encodeText(text, {
    encoding: "utf-16le", bom: true, eol: "\r\n", mixedEol: false, finalNewline: true, binary: false,
});

test("read normalizes line endings and commit restores encoding, BOM and EOL", (t) => {
    const { root, storage, ref } = sandbox(t);
    writeFileSync(join(root, "a.txt"), utf16Crlf("one\ntwo\n"));
    const stored = storage.read(ref("a.txt"));
    assert.ok(stored);
    assert.equal(stored.content, "one\ntwo\n");
    assert.equal(stored.charset?.encoding, "utf-16le");
    assert.equal(stored.charset?.eol, "\r\n");
    assert.equal(stored.charset?.bom, true);

    const lease = storage.acquireLease(ref("a.txt"), "agent");
    const committed = storage.compareAndSwap(ref("a.txt"), stored.hash, "one\nTWO\n", lease.fence);
    assert.equal(committed.content, "one\nTWO\n");
    const onDisk = readFileSync(join(root, "a.txt"));
    assert.deepEqual([...onDisk.subarray(0, 2)], [0xff, 0xfe]);
    const reread = detectCharset(onDisk);
    assert.equal(reread.encoding, "utf-16le");
    assert.equal(reread.eol, "\r\n");
    assert.equal(decodeText(onDisk, reread), "one\nTWO\n");
    assert.equal(readdirSync(root).some(name => name.endsWith(".tmp")), false);
});

test("compareAndSwap rejects a changed file and a stale fence", (t) => {
    const { root, storage, ref } = sandbox(t);
    writeFileSync(join(root, "a.txt"), "one\n", "utf8");
    const stored = storage.read(ref("a.txt"))!;
    const lease = storage.acquireLease(ref("a.txt"), "agent");
    writeFileSync(join(root, "a.txt"), "host changed\n", "utf8");
    assert.throws(() => storage.compareAndSwap(ref("a.txt"), stored.hash, "mine\n", lease.fence), code("version_conflict"));
    const fresh = storage.read(ref("a.txt"))!;
    assert.throws(() => storage.compareAndSwap(ref("a.txt"), fresh.hash, "mine\n", lease.fence + 1), code("fence_rejected"));
    storage.releaseLease(lease);
});

test("the lock serializes writers and a released lock can be re-acquired", (t) => {
    const { root, storage, ref } = sandbox(t);
    writeFileSync(join(root, "a.txt"), "a\n", "utf8");
    const first = storage.acquireLease(ref("a.txt"), "one");
    assert.throws(() => storage.acquireLease(ref("a.txt"), "two"), code("fence_rejected"));
    assert.equal(storage.inspectLock(ref("a.txt")).get().owner, "one");
    storage.releaseLease(first);
    const second = storage.acquireLease(ref("a.txt"), "two");
    assert.equal(second.fence, first.fence + 1);
    storage.releaseLease(second);
});

test("an expired lock is taken over and refresh keeps it live", (t) => {
    const { root } = sandbox(t);
    const target = join(root, "file.txt");
    writeFileSync(target, "x", "utf8");
    let now = 1_000_000;
    const lock = new NodeFileLock({ clock: () => now, defaultTtlMilliseconds: 1_000, fsync: false });
    const first = lock.acquire(target, "one");
    const refreshed = first.refresh(5_000);
    assert.notEqual(refreshed.expiresAt, first.record.expiresAt);
    assert.throws(() => lock.acquire(target, "two"), code("fence_rejected"));
    now += 6_000;
    const takeover = lock.acquire(target, "two");
    assert.equal(takeover.record.fence, first.record.fence + 1);
    assert.equal(lock.release(target, first.record.token), false);
    assert.equal(takeover.release(), true);
    assert.equal(lock.inspect(target).isEmpty(), true);
});

test("path traversal, absolute paths and symlink escapes are rejected", (t) => {
    const { root, storage } = sandbox(t);
    for (const path of ["../outside", "/etc/passwd", "a\\b", "a/../b", "C:/x", "", "./a"]) {
        assert.throws(() => storage.resolvePath(path), code("invalid_path"), path);
    }
    writeFileSync(join(root, "a.txt"), "x", "utf8");
    assert.equal(storage.resolvePath("a.txt"), join(storage.rootReal, "a.txt"));
    try {
        symlinkSync(join(root, "a.txt"), join(root, "link.txt"));
        assert.throws(() => storage.resolvePath("link.txt"), code("invalid_path"));
    } catch (error) {
        if (!(error instanceof WorkspaceError) && (error as NodeJS.ErrnoException).code !== "EPERM"
            && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    }
});

test("binary files, oversized files and mixed line endings are refused", (t) => {
    const { root, storage, ref } = sandbox(t, { maxFileBytes: 32 });
    writeFileSync(join(root, "image.bin"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    assert.throws(() => storage.read(ref("image.bin")), code("binary_file"));
    writeFileSync(join(root, "big.txt"), "x".repeat(64), "utf8");
    assert.throws(() => storage.read(ref("big.txt")), code("file_too_large"));
    writeFileSync(join(root, "mixed.txt"), "a\r\nb\n", "utf8");
    const mixed = storage.read(ref("mixed.txt"))!;
    assert.equal(mixed.charset?.mixedEol, true);
    const lease = storage.acquireLease(ref("mixed.txt"), "agent");
    assert.throws(() => storage.compareAndSwap(ref("mixed.txt"), mixed.hash, "a\nb\n", lease.fence), code("mixed_eol"));
    storage.releaseLease(lease);
});

test("the node tree host lists, reads and re-reads through the same adapter", (t) => {
    const { root, storage } = sandbox(t);
    writeFileSync(join(root, "a.md"), "# A\n", "utf8");
    writeFileSync(join(root, "b.md"), "# B\n", "utf8");
    const host = createNodeFileTreeHost(storage, { tenantId: "t", rootId: "r" });
    const children = host.listChildren({ tenantId: "t", rootId: "r", path: "" });
    assert.deepEqual(children.map(child => child.path), ["a.md", "b.md"]);
    assert.equal(children[0]?.kind, "file");
    const metadata = host.metadata("a.md").get();
    assert.equal(metadata.kind, "file");
    const read = host.readFile({ tenantId: "t", rootId: "r", path: "a.md" });
    assert.equal(read.content, "# A\n");
    assert.equal(read.hash, metadata.hash);
    assert.equal(host.metadata("missing.md").isEmpty(), true);
    assert.equal(host.authorize("read", { tenantId: "t", rootId: "r", path: "a.md" }), true);
});
