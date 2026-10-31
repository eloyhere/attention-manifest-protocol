#!/usr/bin/env node
/**
 * Filesystem read/write checks: line paging, byte budgets, charset handling,
 * CAS, atomic replacement, dry-run, sandbox escapes and concurrent writers.
 *
 * Every case runs in a fresh temporary root, so a failure cannot leak a write
 * into the repository and a passing run proves the module works with the real
 * `node:fs` implementation rather than a mock.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { rawDigest } from "../src/fingerprint/raw.ts";
import { isFilesystemError } from "../src/file/errors.ts";
import { PathSandbox } from "../src/file/path.ts";
import { ReadCache, readPage, useByte as readUseByte, useLine as readUseLine } from "../src/file/read.ts";
import type { ByteUse, LineUse, ReadOptions } from "../src/file/read.ts";
import type { FilesystemErrorCode, ReadPage, RootedPath, TreeNode, WriteJournalEntry, WriteMode, WriteRequest, WriteResult } from "../src/file/types.ts";
import { WorkspaceTree } from "../src/file/tree.ts";
import { ensureDirectory, useByte as writeUseByte, useLine as writeUseLine, WriteLocks, writeFile } from "../src/file/write.ts";
import type { PatchJournalEntry, WritePatchResult } from "../src/file/write.ts";
import type { SessionRoot } from "../src/session/types.ts";

/**
 * One sandboxed temporary root. Tests never share a fixture.
 */
interface Fixture {
    readonly root: string;
    readonly sandbox: PathSandbox;
}

/**
 * Session id used by the write cases; the lock and journal include it.
 */
const Session: string = "session.readwrite";

/**
 * Create an isolated temporary root with a writable default root.
 */
const makeFixture: () => Fixture = (): Fixture => {
    const root: string = mkdtempSync(join(tmpdir(), "amp-file-rw-"));
    const descriptor: SessionRoot = { id: "root.test", path: root, writable: true, exclude: [] };
    return { root, sandbox: new PathSandbox([descriptor]) };
};

/**
 * Remove a fixture even when a case fails halfway through.
 */
const dropFixture: (fixture: Fixture) => void = (fixture: Fixture): void => {
    rmSync(fixture.root, { recursive: true, force: true });
};

/**
 * Assert that a synchronous action fails with one classified code.
 */
const expectSyncCode: (action: () => unknown, code: FilesystemErrorCode) => void = (action: () => unknown, code: FilesystemErrorCode): void => {
    assert.throws(action, (error: unknown): boolean => isFilesystemError(error) && error.code === code);
};

/**
 * Assert that an asynchronous action rejects with one classified code.
 */
const expectAsyncCode: (action: Promise<unknown>, code: FilesystemErrorCode) => Promise<void> = async (action: Promise<unknown>, code: FilesystemErrorCode): Promise<void> => {
    await assert.rejects(action, (error: unknown): boolean => isFilesystemError(error) && error.code === code);
};

/**
 * Five short ASCII lines with a trailing newline, so offsets are easy to state.
 */
const PageContent: string = "alpha\nbeta\ngamma\ndelta\nepsilon\n";

test("line paging reports 1-based ranges, offsets and totals", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "page.txt"), PageContent, "utf8");
        const first: ReadPage = readPage(fixture.sandbox, { path: "page.txt", maxLines: 2, includeLineNumbers: true });
        assert.equal(first.path, "page.txt");
        assert.equal(first.startLine, 1);
        assert.equal(first.endLine, 2);
        assert.equal(first.nextStartLine, 3);
        assert.equal(first.totalLines, 5n);
        assert.equal(first.totalBytes, BigInt(Buffer.byteLength(PageContent)));
        assert.equal(first.text, "1\talpha\n2\tbeta");
        assert.equal(first.bytesRead, Buffer.byteLength(first.text));
        assert.equal(first.offset, 0);
        assert.equal(first.truncated, true);
        assert.equal(first.charset, "utf-8");
        assert.equal(first.binary, false);
        const second: ReadPage = readPage(fixture.sandbox, { path: "page.txt", startLine: 3, maxLines: 2 });
        assert.equal(second.startLine, 3);
        assert.equal(second.endLine, 4);
        assert.equal(second.nextStartLine, 5);
        assert.equal(second.offset, 11);
        assert.equal(second.text, "gamma\ndelta");
        const last: ReadPage = readPage(fixture.sandbox, { path: "page.txt", startLine: 5, maxLines: 2 });
        assert.equal(last.endLine, 5);
        assert.equal(last.nextStartLine, null);
        assert.equal(last.truncated, false);
        const pastEof: ReadPage = readPage(fixture.sandbox, { path: "page.txt", startLine: 99 });
        assert.equal(pastEof.text, "");
        assert.equal(pastEof.endLine, 98);
        assert.equal(pastEof.nextStartLine, null);
        assert.equal(pastEof.bytesRead, 0);
        assert.equal(pastEof.totalLines, 5n);
        assert.equal(pastEof.truncated, false);
        const nextLine: ReadPage = readPage(fixture.sandbox, { path: "page.txt", startLine: 6 });
        assert.equal(nextLine.text, "");
        assert.equal(nextLine.endLine, 5);
        assert.equal(nextLine.nextStartLine, null);
    } finally {
        dropFixture(fixture);
    }
});

test("maxLines clamps to the hard page limit and startLine validates", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        const lines: string[] = [];
        for (let index: number = 1; index <= 2100; index += 1) {
            lines.push(`line-${index}`);
        }
        writeFileSync(join(fixture.root, "many.txt"), `${lines.join("\n")}\n`, "utf8");
        const clamped: ReadPage = readPage(fixture.sandbox, { path: "many.txt", maxLines: 100_000 });
        assert.equal(clamped.startLine, 1);
        assert.equal(clamped.endLine, 2000);
        assert.equal(clamped.nextStartLine, 2001);
        assert.equal(clamped.truncated, true);
        assert.equal(clamped.totalLines, 2100n);
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "many.txt", startLine: 0 }), "invalid_arguments");
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "many.txt", maxLines: 0 }), "invalid_arguments");
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "many.txt", maxBytes: -1 }), "invalid_arguments");
    } finally {
        dropFixture(fixture);
    }
});

test("the page byte budget keeps whole lines and flags a single oversized line", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "bytes.txt"), "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n", "utf8");
        const bounded: ReadPage = readPage(fixture.sandbox, { path: "bytes.txt", maxLines: 10, maxBytes: 25 });
        assert.equal(bounded.text, "aaaaaaaaaa\nbbbbbbbbbb");
        assert.equal(bounded.endLine, 2);
        assert.equal(bounded.nextStartLine, 3);
        assert.equal(bounded.bytesRead, 21);
        assert.equal(bounded.truncated, true);
        writeFileSync(join(fixture.root, "unicode.txt"), "中文中文\n日本語\n", "utf8");
        const unicode: ReadPage = readPage(fixture.sandbox, { path: "unicode.txt", maxBytes: 13 });
        assert.equal(unicode.text, "中文中文");
        assert.equal(unicode.bytesRead, 12);
        assert.equal(unicode.endLine, 1);
        assert.equal(unicode.nextStartLine, 2);
        writeFileSync(join(fixture.root, "long.txt"), `${"x".repeat(100)}\ny\n`, "utf8");
        const single: ReadPage = readPage(fixture.sandbox, { path: "long.txt", maxLines: 10, maxBytes: 10 });
        assert.equal(single.text, "x".repeat(100));
        assert.equal(single.endLine, 1);
        assert.equal(single.nextStartLine, 2);
        assert.equal(single.bytesRead, 100);
        assert.equal(single.truncated, true);
    } finally {
        dropFixture(fixture);
    }
});

test("charset sniffing reads BOM and UTF-16 files and refuses binary content", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        const utf8Bom: Buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo\nwörld\n", "utf8")]);
        writeFileSync(join(fixture.root, "bom.txt"), utf8Bom);
        const bomPage: ReadPage = readPage(fixture.sandbox, { path: "bom.txt" });
        assert.equal(bomPage.charset, "utf-8-bom");
        assert.equal(bomPage.text, "héllo\nwörld");
        assert.equal(bomPage.totalLines, 2n);
        assert.equal(bomPage.totalBytes, BigInt(utf8Bom.byteLength));
        const utf16: Buffer = Buffer.from("\uFEFFone\ntwo\n", "utf16le");
        writeFileSync(join(fixture.root, "utf16.txt"), utf16);
        const utf16Page: ReadPage = readPage(fixture.sandbox, { path: "utf16.txt" });
        assert.equal(utf16Page.charset, "utf-16le");
        assert.equal(utf16Page.text, "one\ntwo");
        assert.equal(utf16Page.totalLines, 2n);
        assert.equal(utf16Page.totalBytes, BigInt(utf16.byteLength));
        writeFileSync(join(fixture.root, "image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "image.bin" }), "binary_file");
        writeFileSync(join(fixture.root, "empty.txt"), "");
        const empty: ReadPage = readPage(fixture.sandbox, { path: "empty.txt" });
        assert.equal(empty.text, "");
        assert.equal(empty.totalLines, 0n);
        assert.equal(empty.nextStartLine, null);
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "missing.txt" }), "not_found");
        mkdirSync(join(fixture.root, "folder"));
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "folder" }), "not_file");
    } finally {
        dropFixture(fixture);
    }
});

test("create, overwrite, upsert and append follow their mode contract", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        const created: WriteResult = await writeFile(fixture.sandbox, Session, { path: "notes.txt", content: "one", mode: "create" });
        assert.equal(created.created, true);
        assert.equal(created.dryRun, false);
        assert.equal(created.previousFingerprint, null);
        assert.equal(created.node.type, "File");
        assert.equal(created.node.path, "notes.txt");
        assert.equal(created.node.bytes, 3n);
        assert.equal(created.node.lines, 1n);
        assert.equal(created.node.fingerprint, rawDigest(Buffer.from("one")));
        assert.equal(created.bytesWritten, 3n);
        assert.equal(readFileSync(join(fixture.root, "notes.txt"), "utf8"), "one");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "notes.txt", content: "again", mode: "create" }), "already_exists");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "missing.txt", content: "x", mode: "overwrite" }), "not_found");
        const overwritten: WriteResult = await writeFile(fixture.sandbox, Session, { path: "notes.txt", content: "two\nlines", mode: "overwrite" });
        assert.equal(overwritten.created, false);
        assert.equal(overwritten.previousFingerprint, rawDigest(Buffer.from("one")));
        assert.equal(readFileSync(join(fixture.root, "notes.txt"), "utf8"), "two\nlines");
        const upsertNew: WriteResult = await writeFile(fixture.sandbox, Session, { path: "upsert.txt", content: "a", mode: "upsert" });
        assert.equal(upsertNew.created, true);
        const upsertExisting: WriteResult = await writeFile(fixture.sandbox, Session, { path: "upsert.txt", content: "b", mode: "upsert" });
        assert.equal(upsertExisting.created, false);
        assert.equal(readFileSync(join(fixture.root, "upsert.txt"), "utf8"), "b");
        const appendNew: WriteResult = await writeFile(fixture.sandbox, Session, { path: "append.txt", content: "x", mode: "append" });
        assert.equal(appendNew.created, true);
        const appendExisting: WriteResult = await writeFile(fixture.sandbox, Session, { path: "append.txt", content: "yz", mode: "append" });
        assert.equal(appendExisting.created, false);
        assert.equal(appendExisting.previousFingerprint, rawDigest(Buffer.from("x")));
        assert.equal(appendExisting.bytesWritten, 3n);
        assert.equal(appendExisting.node.bytes, 3n);
        assert.equal(readFileSync(join(fixture.root, "append.txt"), "utf8"), "xyz");
        mkdirSync(join(fixture.root, "folder"));
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "folder", content: "x", mode: "overwrite" }), "not_file");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: ".", content: "x" }), "not_file");
        await writeFile(fixture.sandbox, Session, { path: "wide.txt", content: "hi", encoding: "utf-16le" });
        const wide: Buffer = readFileSync(join(fixture.root, "wide.txt"));
        assert.equal(wide[0], 0xff);
        assert.equal(wide[1], 0xfe);
        assert.equal(readPage(fixture.sandbox, { path: "wide.txt" }).text, "hi");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "raw.bin", content: new Uint8Array([1, 2, 3]), encoding: "utf-16le" }), "invalid_arguments");
        assert.equal(existsSync(join(fixture.root, "raw.bin")), false);
    } finally {
        dropFixture(fixture);
    }
});

test("compare-and-swap accepts the current fingerprint and rejects a stale one", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "cas.txt"), "v1", "utf8");
        const first: ReadPage = readPage(fixture.sandbox, { path: "cas.txt" });
        const swapped: WriteResult = await writeFile(fixture.sandbox, Session, {
            path: "cas.txt",
            content: "v2",
            mode: "overwrite",
            expectFingerprint: first.fingerprint,
        });
        assert.equal(swapped.previousFingerprint, first.fingerprint);
        assert.equal(readFileSync(join(fixture.root, "cas.txt"), "utf8"), "v2");
        await expectAsyncCode(
            writeFile(fixture.sandbox, Session, { path: "cas.txt", content: "v3", mode: "overwrite", expectFingerprint: first.fingerprint }),
            "fingerprint_mismatch",
        );
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "cas.txt", content: "v3", expectFingerprint: null }), "fingerprint_mismatch");
        const created: WriteResult = await writeFile(fixture.sandbox, Session, {
            path: "cas-new.txt",
            content: "new",
            mode: "create",
            expectFingerprint: null,
        });
        assert.equal(created.created, true);
        assert.equal(readFileSync(join(fixture.root, "cas.txt"), "utf8"), "v2");
    } finally {
        dropFixture(fixture);
    }
});

test("dry-run validates without writing and reports projected metadata", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "dry.txt"), "original", "utf8");
        const journal: WriteJournalEntry[] = [];
        const preview: WriteResult = await writeFile(
            fixture.sandbox,
            Session,
            { path: "dry.txt", content: "preview content", mode: "overwrite", dryRun: true },
            { journal: (entry: WriteJournalEntry): void => { journal.push(entry); } },
        );
        assert.equal(preview.dryRun, true);
        assert.equal(preview.created, false);
        assert.equal(preview.previousFingerprint, rawDigest(Buffer.from("original")));
        assert.equal(preview.node.fingerprint, rawDigest(Buffer.from("preview content")));
        assert.equal(preview.node.bytes, BigInt(Buffer.byteLength("preview content")));
        assert.equal(preview.node.lines, 1n);
        assert.equal(preview.bytesWritten, BigInt(Buffer.byteLength("preview content")));
        assert.equal(readFileSync(join(fixture.root, "dry.txt"), "utf8"), "original");
        assert.deepEqual(journal, []);
        const fresh: WriteResult = await writeFile(fixture.sandbox, Session, { path: "dry-new.txt", content: "fresh\n", mode: "create", dryRun: true });
        assert.equal(fresh.created, true);
        assert.equal(fresh.previousFingerprint, null);
        assert.equal(fresh.node.path, "dry-new.txt");
        assert.equal(fresh.node.lines, 1n);
        assert.equal(fresh.node.bytes, 6n);
        assert.ok(fresh.node.description.length > 0);
        assert.equal(existsSync(join(fixture.root, "dry-new.txt")), false);
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "nope/file.txt", content: "x", mode: "create", dryRun: true }), "not_found");
        const deep: WriteResult = await writeFile(fixture.sandbox, Session, {
            path: "future/a.txt",
            content: "x",
            mode: "create",
            dryRun: true,
            createParents: true,
        });
        assert.equal(deep.created, true);
        assert.equal(existsSync(join(fixture.root, "future")), false);
    } finally {
        dropFixture(fixture);
    }
});

test("atomic writes leave a consistent fingerprint, parents and no temp files", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        const journal: WriteJournalEntry[] = [];
        const result: WriteResult = await writeFile(
            fixture.sandbox,
            Session,
            { path: "deep/nested/file.txt", content: "atomic\n", createParents: true },
            { journal: (entry: WriteJournalEntry): void => { journal.push(entry); }, timeZone: "utc" },
        );
        assert.equal(result.created, true);
        assert.equal(existsSync(join(fixture.root, "deep", "nested", "file.txt")), true);
        assert.equal(readFileSync(join(fixture.root, "deep", "nested", "file.txt"), "utf8"), "atomic\n");
        assert.equal(result.node.fingerprint, rawDigest(Buffer.from("atomic\n")));
        assert.equal(result.node.lines, 1n);
        assert.equal(result.node.bytes, 7n);
        const reread: ReadPage = readPage(fixture.sandbox, { path: "deep/nested/file.txt" });
        assert.equal(reread.fingerprint, result.node.fingerprint);
        assert.equal(reread.text, "atomic");
        const leftovers: string[] = readdirSync(join(fixture.root, "deep", "nested")).filter((name: string): boolean => name.startsWith(".amp-"));
        assert.deepEqual(leftovers, []);
        assert.equal(journal.length, 1);
        const entry: WriteJournalEntry = journal[0];
        assert.match(entry.id, /^w\.[0-9a-f]{16}$/u);
        assert.equal(entry.sessionId, Session);
        assert.equal(entry.rootId, "root.test");
        assert.equal(entry.path, "deep/nested/file.txt");
        assert.equal(entry.mode, "upsert");
        assert.equal(entry.previousFingerprint, null);
        assert.equal(entry.nextFingerprint, result.node.fingerprint);
        assert.equal(entry.bytes, 7n);
        assert.equal(new Date(entry.at).toISOString(), entry.at);
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "orphan/file.txt", content: "x", mode: "create" }), "not_found");
        writeFileSync(join(fixture.root, "blocker"), "x", "utf8");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "blocker/child.txt", content: "x", mode: "create" }), "not_directory");
    } finally {
        dropFixture(fixture);
    }
});

test("a workspace tree is refreshed after a successful write", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        const root: SessionRoot = { id: "root.test", path: fixture.root, writable: true, exclude: [] };
        const tree: WorkspaceTree = new WorkspaceTree(root);
        const before: string = tree.snapshot().revision;
        const result: WriteResult = await writeFile(fixture.sandbox, Session, { path: "tree.txt", content: "tree\n" }, { tree, timeZone: "utc" });
        assert.equal(result.revision, tree.revision());
        assert.notEqual(before, result.revision);
        const node: TreeNode | undefined = tree.node("tree.txt");
        assert.ok(node !== (void 0));
        assert.equal(node.type, "File");
        assert.equal(node.fingerprint, result.node.fingerprint);
    } finally {
        dropFixture(fixture);
    }
});

test("sandbox rejects escapes and symlinks, including on the write path", async (context: TestContext): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "inside.txt"), "inside", "utf8");
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "../outside.txt" }), "path_escape");
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "a/../../outside.txt" }), "path_escape");
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "/etc/passwd" }), "invalid_path");
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: `${fixture.root}\\inside.txt` }), "invalid_path");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "../escape.txt", content: "x", mode: "create" }), "path_escape");
        const outside: string = join(fixture.root, "..", `amp-outside-${process.pid}-${Date.now()}.txt`);
        writeFileSync(outside, "outside", "utf8");
        try {
            symlinkSync(outside, join(fixture.root, "link.txt"), "file");
        } catch (error: unknown) {
            rmSync(outside, { force: true });
            const code: string = typeof(error) === "object" && error !== null ? `${(error as { code?: unknown; }).code ?? ""}` : "";
            if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(code)) {
                context.skip("file symlinks are unavailable on this host");
                return;
            }
            throw error;
        }
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "link.txt" }), "symlink_denied");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "link.txt", content: "overwrite", mode: "overwrite" }), "symlink_denied");
        rmSync(outside, { force: true });
    } finally {
        dropFixture(fixture);
    }
});

test("concurrent writes to one path serialize and leave one complete payload", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "race.txt"), "seed", "utf8");
        const first: string = "A".repeat(40_000);
        const second: string = "B".repeat(50_000);
        const results: readonly WriteResult[] = await Promise.all([
            writeFile(fixture.sandbox, Session, { path: "race.txt", content: first, mode: "overwrite" }),
            writeFile(fixture.sandbox, Session, { path: "race.txt", content: second, mode: "overwrite" }),
        ]);
        const final: string = readFileSync(join(fixture.root, "race.txt"), "utf8");
        assert.ok(final === first || final === second);
        assert.equal(results.length, 2);
        assert.ok(results.every((result: WriteResult): boolean => result.bytesWritten === 40_000n || result.bytesWritten === 50_000n));
        const leftovers: string[] = readdirSync(fixture.root).filter((name: string): boolean => name.startsWith(".amp-"));
        assert.deepEqual(leftovers, []);
    } finally {
        dropFixture(fixture);
    }
});

test("WriteLocks serializes tasks for the same name", async (): Promise<void> => {
    const locks: WriteLocks = new WriteLocks();
    const order: number[] = [];
    const pause: () => Promise<void> = (): Promise<void> =>
        new Promise<void>((resolve): void => {
            setTimeout(resolve, 10);
        });
    await Promise.all([
        locks.run("same", async (): Promise<void> => {
            order.push(1);
            await pause();
            order.push(2);
        }),
        locks.run("same", (): void => {
            order.push(3);
        }),
    ]);
    assert.deepEqual(order, [1, 2, 3]);
});

test("the size ceiling bounds reads and both fresh and appended writes", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "large.txt"), "0123456789abcdefghij", "utf8");
        const readOptions: ReadOptions = { maxBytes: 10 };
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "large.txt" }, readOptions), "quota_exceeded");
        await expectAsyncCode(
            writeFile(fixture.sandbox, Session, { path: "too-big.txt", content: "0123456789", mode: "create" }, { maxBytes: 8 }),
            "quota_exceeded",
        );
        assert.equal(existsSync(join(fixture.root, "too-big.txt")), false);
        writeFileSync(join(fixture.root, "limit.txt"), "12345678", "utf8");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "limit.txt", content: "9", mode: "append" }, { maxBytes: 8 }), "quota_exceeded");
        assert.equal(readFileSync(join(fixture.root, "limit.txt"), "utf8"), "12345678");
    } finally {
        dropFixture(fixture);
    }
});

test("the page byte budget is inclusive and flags only a real single-line overflow", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "edge.txt"), "aaa\nbbb", "utf8");
        const under: ReadPage = readPage(fixture.sandbox, { path: "edge.txt", maxBytes: 6 });
        assert.equal(under.text, "aaa");
        assert.equal(under.endLine, 1);
        assert.equal(under.nextStartLine, 2);
        assert.equal(under.bytesRead, 3);
        assert.equal(under.truncated, true);
        const exact: ReadPage = readPage(fixture.sandbox, { path: "edge.txt", maxBytes: 7 });
        assert.equal(exact.text, "aaa\nbbb");
        assert.equal(exact.endLine, 2);
        assert.equal(exact.nextStartLine, null);
        assert.equal(exact.bytesRead, 7);
        assert.equal(exact.truncated, false);
        writeFileSync(join(fixture.root, "emoji.txt"), "😀", "utf8");
        const emojiExact: ReadPage = readPage(fixture.sandbox, { path: "emoji.txt", maxBytes: 4 });
        assert.equal(emojiExact.text, "😀");
        assert.equal(emojiExact.bytesRead, 4);
        assert.equal(emojiExact.nextStartLine, null);
        assert.equal(emojiExact.truncated, false);
        const emojiOver: ReadPage = readPage(fixture.sandbox, { path: "emoji.txt", maxBytes: 3 });
        assert.equal(emojiOver.text, "😀");
        assert.equal(emojiOver.bytesRead, 4);
        assert.equal(emojiOver.nextStartLine, null);
        assert.equal(emojiOver.truncated, true);
        writeFileSync(join(fixture.root, "numbered.txt"), "aa\nbb\n", "utf8");
        const numbered: ReadPage = readPage(fixture.sandbox, { path: "numbered.txt", maxBytes: 5, includeLineNumbers: true });
        assert.equal(numbered.text, "1\taa\n2\tbb");
        assert.equal(numbered.bytesRead, Buffer.byteLength(numbered.text));
        assert.ok(numbered.bytesRead > 5);
        assert.equal(numbered.nextStartLine, null);
    } finally {
        dropFixture(fixture);
    }
});

test("page ceilings clamp the line count and the UTF-8 byte budget", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        const wide: string = "x".repeat(200 * 1024);
        writeFileSync(join(fixture.root, "wide.txt"), `${wide}\n${wide}\n`, "utf8");
        const capped: ReadPage = readPage(fixture.sandbox, { path: "wide.txt", maxLines: 200, maxBytes: 10 * 1024 * 1024 });
        assert.equal(capped.endLine, 1);
        assert.equal(capped.bytesRead, 200 * 1024);
        assert.equal(capped.nextStartLine, 2);
        assert.equal(capped.truncated, true);
        const lines: string[] = [];
        for (let index: number = 1; index <= 300; index += 1) {
            lines.push(`line-${index}`);
        }
        writeFileSync(join(fixture.root, "default.txt"), `${lines.join("\n")}\n`, "utf8");
        const defaulted: ReadPage = readPage(fixture.sandbox, { path: "default.txt" });
        assert.equal(defaulted.endLine, 200);
        assert.equal(defaulted.nextStartLine, 201);
        assert.equal(defaulted.totalLines, 300n);
        assert.equal(defaulted.truncated, true);
    } finally {
        dropFixture(fixture);
    }
});

test("the default file ceiling accepts exactly 8 MiB and rejects one byte more", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "exactly.bin"), Buffer.alloc(8 * 1024 * 1024, 0x61));
        const page: ReadPage = readPage(fixture.sandbox, { path: "exactly.bin", maxLines: 1 });
        assert.equal(page.totalBytes, 8388608n);
        assert.equal(page.bytesRead, 8388608);
        assert.equal(page.endLine, 1);
        assert.equal(page.nextStartLine, null);
        assert.equal(page.truncated, true);
        writeFileSync(join(fixture.root, "over.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "over.bin" }), "quota_exceeded");
        writeFileSync(join(fixture.root, "ten.txt"), "0123456789", "utf8");
        const exactBytes: ReadOptions = { maxBytes: 10 };
        assert.equal(readPage(fixture.sandbox, { path: "ten.txt" }, exactBytes).totalBytes, 10n);
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "ten.txt" }, { maxBytes: 9 }), "quota_exceeded");
    } finally {
        dropFixture(fixture);
    }
});

test("newline-only and CRLF files keep line counts and prefixes", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "newline.txt"), "\n", "utf8");
        const newline: ReadPage = readPage(fixture.sandbox, { path: "newline.txt" });
        assert.equal(newline.totalLines, 1n);
        assert.equal(newline.text, "");
        assert.equal(newline.endLine, 1);
        assert.equal(newline.nextStartLine, null);
        const numbered: ReadPage = readPage(fixture.sandbox, { path: "newline.txt", includeLineNumbers: true });
        assert.equal(numbered.text, "1\t");
        assert.equal(numbered.bytesRead, 2);
        writeFileSync(join(fixture.root, "crlf.txt"), "a\r\nb\r\nc", "utf8");
        const first: ReadPage = readPage(fixture.sandbox, { path: "crlf.txt", maxLines: 1 });
        assert.equal(first.text, "a");
        assert.equal(first.nextStartLine, 2);
        const rest: ReadPage = readPage(fixture.sandbox, { path: "crlf.txt", startLine: 2, maxLines: 5 });
        assert.equal(rest.text, "b\r\nc");
        assert.equal(rest.totalLines, 3n);
        assert.equal(rest.nextStartLine, null);
    } finally {
        dropFixture(fixture);
    }
});

test("charset boundaries: BOM-only, UTF-16BE, Latin-1 and malformed UTF-16", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "bom-only.txt"), Buffer.from([0xef, 0xbb, 0xbf]));
        const bomOnly: ReadPage = readPage(fixture.sandbox, { path: "bom-only.txt" });
        assert.equal(bomOnly.charset, "utf-8-bom");
        assert.equal(bomOnly.text, "");
        assert.equal(bomOnly.totalLines, 0n);
        assert.equal(bomOnly.totalBytes, 3n);
        assert.equal(bomOnly.nextStartLine, null);
        const bigEndian: Buffer = Buffer.from("hi\nyo\n", "utf16le");
        bigEndian.swap16();
        writeFileSync(join(fixture.root, "utf16be.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]));
        const be: ReadPage = readPage(fixture.sandbox, { path: "utf16be.txt" });
        assert.equal(be.charset, "utf-16be");
        assert.equal(be.text, "hi\nyo");
        assert.equal(be.totalLines, 2n);
        writeFileSync(join(fixture.root, "latin.txt"), Buffer.from([0xe9, 0x0a]));
        const latin: ReadPage = readPage(fixture.sandbox, { path: "latin.txt" });
        assert.equal(latin.charset, "latin1");
        assert.equal(latin.text, "é");
        assert.equal(latin.totalLines, 1n);
        writeFileSync(join(fixture.root, "bad-utf16.txt"), Buffer.from([0xff, 0xfe, 0x61]));
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "bad-utf16.txt" }), "charset_unsupported");
        writeFileSync(join(fixture.root, "nul.bin"), Buffer.from([0x00]));
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "nul.bin" }), "binary_file");
    } finally {
        dropFixture(fixture);
    }
});

test("empty payloads keep fingerprints and counts exact across modes", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        const emptyDigest: string = rawDigest(new Uint8Array());
        const created: WriteResult = await writeFile(fixture.sandbox, Session, { path: "zero.txt", content: "", mode: "create" });
        assert.equal(created.created, true);
        assert.equal(created.previousFingerprint, null);
        assert.equal(created.node.bytes, 0n);
        assert.equal(created.node.lines, 0n);
        assert.equal(created.node.fingerprint, emptyDigest);
        assert.equal(created.bytesWritten, 0n);
        const page: ReadPage = readPage(fixture.sandbox, { path: "zero.txt" });
        assert.equal(page.charset, "utf-8");
        assert.equal(page.totalLines, 0n);
        assert.equal(page.totalBytes, 0n);
        assert.equal(page.text, "");
        assert.equal(page.nextStartLine, null);
        const journal: WriteJournalEntry[] = [];
        const appended: WriteResult = await writeFile(
            fixture.sandbox,
            Session,
            { path: "zero.txt", content: "", mode: "append" },
            { journal: (entry: WriteJournalEntry): void => { journal.push(entry); } },
        );
        assert.equal(appended.created, false);
        assert.equal(appended.previousFingerprint, emptyDigest);
        assert.equal(appended.bytesWritten, 0n);
        assert.equal(readFileSync(join(fixture.root, "zero.txt")).byteLength, 0);
        assert.equal(journal.length, 1);
        assert.equal(journal[0].bytes, 0n);
        assert.equal(journal[0].previousFingerprint, emptyDigest);
        assert.equal(journal[0].nextFingerprint, emptyDigest);
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "zero.txt", content: "x", mode: "overwrite", expectFingerprint: null }), "fingerprint_mismatch");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "zero.txt", content: "x", mode: "create", dryRun: true }), "already_exists");
        const rawEmpty: WriteResult = await writeFile(fixture.sandbox, Session, { path: "raw-empty.bin", content: new Uint8Array(0) });
        assert.equal(rawEmpty.node.bytes, 0n);
        assert.equal(rawEmpty.node.lines, 0n);
    } finally {
        dropFixture(fixture);
    }
});

test("write ceilings include append totals and reject before creating parents", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        const eight: string = "12345678";
        const filled: WriteResult = await writeFile(fixture.sandbox, Session, { path: "eight.txt", content: eight, mode: "create" }, { maxBytes: 8 });
        assert.equal(filled.node.bytes, 8n);
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "eight.txt", content: `${eight}9`, mode: "overwrite" }, { maxBytes: 8 }), "quota_exceeded");
        const journal: WriteJournalEntry[] = [];
        const appended: WriteResult = await writeFile(
            fixture.sandbox,
            Session,
            { path: "eight.txt", content: "", mode: "append" },
            { maxBytes: 8, journal: (entry: WriteJournalEntry): void => { journal.push(entry); } },
        );
        assert.equal(appended.bytesWritten, 8n);
        assert.equal(appended.previousFingerprint, rawDigest(Buffer.from(eight)));
        assert.equal(journal.length, 1);
        assert.equal(journal[0].bytes, 8n);
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "eight.txt", content: "9", mode: "append" }, { maxBytes: 8 }), "quota_exceeded");
        await expectAsyncCode(
            writeFile(fixture.sandbox, Session, { path: "blocked/deep/file.txt", content: `${eight}9`, mode: "create", createParents: true }, { maxBytes: 8 }),
            "quota_exceeded",
        );
        assert.equal(existsSync(join(fixture.root, "blocked")), false);
        const four: string = "a".repeat(4 * 1024 * 1024);
        const full: WriteResult = await writeFile(fixture.sandbox, Session, { path: "four.txt", content: four, mode: "create" });
        assert.equal(full.node.bytes, 4194304n);
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "four.txt", content: `${four}b`, mode: "overwrite" }), "quota_exceeded");
    } finally {
        dropFixture(fixture);
    }
});

test("create, append and CAS races settle with one deterministic outcome", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        const createAttempts: PromiseSettledResult<WriteResult>[] = await Promise.allSettled([
            writeFile(fixture.sandbox, Session, { path: "race-create.txt", content: "one", mode: "create" }),
            writeFile(fixture.sandbox, Session, { path: "race-create.txt", content: "two", mode: "create" }),
        ]);
        let createdCount: number = 0;
        let createCode: string = "";
        for (let index: number = 0; index < createAttempts.length; index += 1) {
            const entry: PromiseSettledResult<WriteResult> = createAttempts[index];
            if (entry.status === "fulfilled") {
                createdCount += 1;
            } else {
                const reason: unknown = entry.reason;
                createCode = isFilesystemError(reason) ? `${reason.code}` : "unknown";
            }
        }
        assert.equal(createdCount, 1);
        assert.equal(createCode, "already_exists");
        const createBody: string = readFileSync(join(fixture.root, "race-create.txt"), "utf8");
        assert.ok(createBody === "one" || createBody === "two");
        writeFileSync(join(fixture.root, "race-append.txt"), "seed", "utf8");
        const suffixA: string = "A".repeat(30_000);
        const suffixB: string = "B".repeat(30_000);
        const appends: readonly WriteResult[] = await Promise.all([
            writeFile(fixture.sandbox, Session, { path: "race-append.txt", content: suffixA, mode: "append" }),
            writeFile(fixture.sandbox, Session, { path: "race-append.txt", content: suffixB, mode: "append" }),
        ]);
        const appendedBody: string = readFileSync(join(fixture.root, "race-append.txt"), "utf8");
        assert.equal(appendedBody.length, 60_004);
        assert.ok(appendedBody.startsWith("seed"));
        const tail: string = appendedBody.slice(4);
        assert.ok(tail === `${suffixA}${suffixB}` || tail === `${suffixB}${suffixA}`);
        const sizes: string[] = appends.map((result: WriteResult): string => `${result.bytesWritten}`).sort();
        assert.deepEqual(sizes, ["30004", "60004"]);
        writeFileSync(join(fixture.root, "race-cas.txt"), "v1", "utf8");
        const expected: string = rawDigest(Buffer.from("v1"));
        const casAttempts: PromiseSettledResult<WriteResult>[] = await Promise.allSettled([
            writeFile(fixture.sandbox, Session, { path: "race-cas.txt", content: "x", mode: "overwrite", expectFingerprint: expected }),
            writeFile(fixture.sandbox, Session, { path: "race-cas.txt", content: "y", mode: "overwrite", expectFingerprint: expected }),
        ]);
        let casCount: number = 0;
        let casCode: string = "";
        for (let index: number = 0; index < casAttempts.length; index += 1) {
            const entry: PromiseSettledResult<WriteResult> = casAttempts[index];
            if (entry.status === "fulfilled") {
                casCount += 1;
            } else {
                const reason: unknown = entry.reason;
                casCode = isFilesystemError(reason) ? `${reason.code}` : "unknown";
            }
        }
        assert.equal(casCount, 1);
        assert.equal(casCode, "fingerprint_mismatch");
        const casBody: string = readFileSync(join(fixture.root, "race-cas.txt"), "utf8");
        assert.ok(casBody === "x" || casBody === "y");
    } finally {
        dropFixture(fixture);
    }
});

test("read-only roots, excluded paths and directory targets stay closed", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    const readOnlyRoot: string = mkdtempSync(join(tmpdir(), "amp-rw-ro-"));
    const excludedRoot: string = mkdtempSync(join(tmpdir(), "amp-rw-ex-"));
    try {
        writeFileSync(join(readOnlyRoot, "ro.txt"), "ro", "utf8");
        const readOnly: PathSandbox = new PathSandbox([{ id: "root.ro", path: readOnlyRoot, writable: false, exclude: [] }]);
        assert.equal(readPage(readOnly, { path: "ro.txt" }).text, "ro");
        await expectAsyncCode(writeFile(readOnly, Session, { path: "new.txt", content: "x", mode: "create" }), "permission_denied");
        expectSyncCode((): RootedPath => ensureDirectory(readOnly, "blocked"), "permission_denied");
        mkdirSync(join(excludedRoot, "secret"));
        writeFileSync(join(excludedRoot, "secret", "x.txt"), "x", "utf8");
        const excluded: PathSandbox = new PathSandbox([{ id: "root.ex", path: excludedRoot, writable: true, exclude: ["secret"] }]);
        expectSyncCode((): ReadPage => readPage(excluded, { path: "secret/x.txt" }), "excluded_path");
        await expectAsyncCode(writeFile(excluded, Session, { path: "secret/x.txt", content: "y", mode: "overwrite" }), "excluded_path");
        mkdirSync(join(fixture.root, "folder"));
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "folder", content: "x", mode: "create" }), "not_file");
        writeFileSync(join(fixture.root, "plain.txt"), "x", "utf8");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "plain.txt/child.txt", content: "x", mode: "create" }), "not_directory");
    } finally {
        dropFixture(fixture);
        rmSync(readOnlyRoot, { recursive: true, force: true });
        rmSync(excludedRoot, { recursive: true, force: true });
    }
});

test("invalid numeric and enum arguments fail before touching the disk", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "x", startLine: Number.NaN }), "invalid_arguments");
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "x", startLine: Number.MAX_SAFE_INTEGER + 1 }), "invalid_arguments");
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "x", maxLines: Number.POSITIVE_INFINITY }), "invalid_arguments");
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "x", maxBytes: 1.5 }), "invalid_arguments");
        expectSyncCode((): ReadPage => readPage(fixture.sandbox, { path: "x" }, { maxBytes: 0 }), "invalid_arguments");
        const badMode: WriteMode = "rename" as unknown as WriteMode;
        const badEncoding: WriteRequest["encoding"] = "ascii" as unknown as WriteRequest["encoding"];
        const badContent: string = 42 as unknown as string;
        await expectAsyncCode(writeFile(fixture.sandbox, "", { path: "x", content: "x" }), "invalid_arguments");
        await expectAsyncCode(writeFile(fixture.sandbox, "bad\u0000id", { path: "x", content: "x" }), "invalid_arguments");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "x.txt", content: "x", mode: badMode }), "invalid_arguments");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "x.txt", content: "x", encoding: badEncoding }), "invalid_arguments");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "x.txt", content: badContent }), "invalid_arguments");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "x.txt", content: "x" }, { maxBytes: Number.NaN }), "invalid_arguments");
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "x.txt", content: "x" }, { maxBytes: 1.5 }), "invalid_arguments");
        assert.equal(existsSync(join(fixture.root, "x.txt")), false);
    } finally {
        dropFixture(fixture);
    }
});

test("rejected dry-runs leave content and journal untouched", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "dry-reject.txt"), "keep", "utf8");
        const stale: string = rawDigest(Buffer.from("keep"));
        await writeFile(fixture.sandbox, Session, { path: "dry-reject.txt", content: "real", mode: "overwrite" });
        const journal: WriteJournalEntry[] = [];
        await expectAsyncCode(
            writeFile(
                fixture.sandbox,
                Session,
                { path: "dry-reject.txt", content: "x", mode: "overwrite", expectFingerprint: stale, dryRun: true },
                { journal: (entry: WriteJournalEntry): void => { journal.push(entry); } },
            ),
            "fingerprint_mismatch",
        );
        assert.equal(readFileSync(join(fixture.root, "dry-reject.txt"), "utf8"), "real");
        assert.deepEqual(journal, []);
        await expectAsyncCode(writeFile(fixture.sandbox, Session, { path: "dry-reject.txt", content: "x", mode: "create", dryRun: true }), "already_exists");
        assert.equal(readFileSync(join(fixture.root, "dry-reject.txt"), "utf8"), "real");
        await expectAsyncCode(
            writeFile(fixture.sandbox, Session, { path: "dry-oversize.txt", content: "123456789", mode: "create", dryRun: true }, { maxBytes: 8 }),
            "quota_exceeded",
        );
        assert.equal(existsSync(join(fixture.root, "dry-oversize.txt")), false);
    } finally {
        dropFixture(fixture);
    }
});

test("read useLine and useByte share one byte span and range fingerprint", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "span.txt"), "a\nbb\nccc\n", "utf8");
        const line: LineUse = readUseLine(fixture.sandbox, { path: "span.txt", startLine: 2, endLine: 3 });
        assert.equal(line.startLine, 2);
        assert.equal(line.endLine, 3);
        assert.equal(line.startChar, 2);
        assert.equal(line.endChar, 9);
        assert.equal(line.startByte, 2);
        assert.equal(line.endByte, 9);
        assert.equal(line.text, "bb\nccc");
        assert.equal(line.totalLines, 3n);
        assert.equal(line.totalBytes, 9n);
        assert.equal(line.charset, "utf-8");
        assert.equal(line.bomLength, 0);
        assert.equal(line.lineEnding, "\n");
        assert.equal(line.finalNewline, true);
        assert.equal(line.fingerprint, rawDigest(Buffer.from("a\nbb\nccc\n")));
        const bytes: ByteUse = readUseByte(fixture.sandbox, { path: "span.txt", startByte: line.startByte, endByte: line.endByte });
        assert.equal(bytes.rangeFingerprint, line.rangeFingerprint);
        assert.equal(bytes.text, "bb\nccc\n");
        assert.equal(bytes.bytes.byteLength, 7);
        assert.equal(bytes.binary, false);
        const empty: LineUse = readUseLine(fixture.sandbox, { path: "span.txt", startLine: 1, endLine: 0 });
        assert.equal(empty.text, "");
        assert.equal(empty.startByte, 0);
        assert.equal(empty.endByte, 0);
        assert.equal(empty.rangeFingerprint, readUseByte(fixture.sandbox, { path: "span.txt", startByte: 0, endByte: 0 }).rangeFingerprint);
        const eof: LineUse = readUseLine(fixture.sandbox, { path: "span.txt", startLine: 4, endLine: 3 });
        assert.equal(eof.startByte, 9);
        assert.equal(eof.endByte, 9);
        assert.equal(eof.text, "");
        writeFileSync(join(fixture.root, "bom-span.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\ntwo\n", "utf8")]));
        const bomLine: LineUse = readUseLine(fixture.sandbox, { path: "bom-span.txt", startLine: 1, endLine: 1 });
        assert.equal(bomLine.bomLength, 3);
        assert.equal(bomLine.startByte, 3);
        assert.equal(bomLine.endByte, 7);
        assert.deepEqual(Array.from(readUseByte(fixture.sandbox, { path: "bom-span.txt", startByte: 0, endByte: 3 }).bytes), [0xef, 0xbb, 0xbf]);
        expectSyncCode((): ByteUse => readUseByte(fixture.sandbox, { path: "span.txt", startByte: 3, endByte: 2 }), "invalid_arguments");
        expectSyncCode((): ByteUse => readUseByte(fixture.sandbox, { path: "span.txt", startByte: 0, endByte: 99 }), "invalid_arguments");
        expectSyncCode((): LineUse => readUseLine(fixture.sandbox, { path: "span.txt", startLine: 0, endLine: 1 }), "invalid_arguments");
        expectSyncCode((): LineUse => readUseLine(fixture.sandbox, { path: "span.txt", startLine: 3, endLine: 1 }), "invalid_arguments");
        expectSyncCode((): LineUse => readUseLine(fixture.sandbox, { path: "span.txt", startLine: 5, endLine: 5 }), "invalid_arguments");
        expectSyncCode((): LineUse => readUseLine(fixture.sandbox, { path: "span.txt", startLine: 1, endLine: 9 }), "invalid_arguments");
    } finally {
        dropFixture(fixture);
    }
});

test("line patches replace, insert and append through canonical spans", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "lines.txt"), "a\nbb\nccc\n", "utf8");
        const span: LineUse = readUseLine(fixture.sandbox, { path: "lines.txt", startLine: 2, endLine: 3 });
        const replaced: WritePatchResult = await writeUseLine(fixture.sandbox, Session, {
            path: "lines.txt",
            startLine: 2,
            endLine: 3,
            content: "B\nCC\n",
            expectFingerprint: span.fingerprint,
            expectRangeFingerprint: span.rangeFingerprint,
        });
        assert.equal(replaced.kind, "line");
        assert.equal(replaced.created, false);
        assert.equal(replaced.startByte, 2);
        assert.equal(replaced.endByte, 9);
        assert.equal(replaced.startLine, 2);
        assert.equal(replaced.endLine, 3);
        assert.equal(replaced.nextStartByte, 2);
        assert.equal(replaced.nextEndByte, 7);
        assert.equal(replaced.previousRangeFingerprint, span.rangeFingerprint);
        assert.equal(replaced.nextRangeFingerprint, readUseLine(fixture.sandbox, { path: "lines.txt", startLine: 2, endLine: 3 }).rangeFingerprint);
        assert.equal(replaced.bytesWritten, 7n);
        assert.equal(replaced.node.bytes, 7n);
        assert.equal(readFileSync(join(fixture.root, "lines.txt"), "utf8"), "a\nB\nCC\n");
        const point: LineUse = readUseLine(fixture.sandbox, { path: "lines.txt", startLine: 2, endLine: 1 });
        await writeUseLine(fixture.sandbox, Session, { path: "lines.txt", startLine: 2, endLine: 1, content: "x\n", expectFingerprint: point.fingerprint, expectRangeFingerprint: point.rangeFingerprint });
        assert.equal(readFileSync(join(fixture.root, "lines.txt"), "utf8"), "a\nx\nB\nCC\n");
        writeFileSync(join(fixture.root, "tail.txt"), "one\ntwo", "utf8");
        const last: LineUse = readUseLine(fixture.sandbox, { path: "tail.txt", startLine: 2, endLine: 2 });
        assert.equal(last.startByte, 4);
        assert.equal(last.endByte, 7);
        await writeUseLine(fixture.sandbox, Session, { path: "tail.txt", startLine: 2, endLine: 2, content: "TWO", expectFingerprint: last.fingerprint, expectRangeFingerprint: last.rangeFingerprint });
        assert.equal(readFileSync(join(fixture.root, "tail.txt"), "utf8"), "one\nTWO");
        const eof: LineUse = readUseLine(fixture.sandbox, { path: "tail.txt", startLine: 3, endLine: 2 });
        await writeUseLine(fixture.sandbox, Session, { path: "tail.txt", startLine: 3, endLine: 2, content: "\nthree", expectFingerprint: eof.fingerprint, expectRangeFingerprint: eof.rangeFingerprint });
        assert.equal(readFileSync(join(fixture.root, "tail.txt"), "utf8"), "one\nTWO\nthree");
        writeFileSync(join(fixture.root, "empty.txt"), "", "utf8");
        const emptyPoint: LineUse = readUseLine(fixture.sandbox, { path: "empty.txt", startLine: 1, endLine: 0 });
        await writeUseLine(fixture.sandbox, Session, { path: "empty.txt", startLine: 1, endLine: 0, content: "first\n", expectFingerprint: emptyPoint.fingerprint, expectRangeFingerprint: emptyPoint.rangeFingerprint });
        assert.equal(readFileSync(join(fixture.root, "empty.txt"), "utf8"), "first\n");
    } finally {
        dropFixture(fixture);
    }
});

test("byte patches insert, replace and keep binary content exact", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "bytes.txt"), "0123456789", "utf8");
        const middle: ByteUse = readUseByte(fixture.sandbox, { path: "bytes.txt", startByte: 2, endByte: 5 });
        assert.equal(Buffer.from(middle.bytes).toString("utf8"), "234");
        assert.equal(middle.text, "234");
        const replaced: WritePatchResult = await writeUseByte(fixture.sandbox, Session, {
            path: "bytes.txt",
            startByte: 2,
            endByte: 5,
            content: new Uint8Array([0x41, 0x42]),
            expectFingerprint: middle.fingerprint,
            expectRangeFingerprint: middle.rangeFingerprint,
        });
        assert.equal(replaced.kind, "byte");
        assert.equal(replaced.previousRangeFingerprint, middle.rangeFingerprint);
        assert.equal(replaced.nextStartByte, 2);
        assert.equal(replaced.nextEndByte, 4);
        assert.equal(replaced.nextRangeFingerprint, readUseByte(fixture.sandbox, { path: "bytes.txt", startByte: 2, endByte: 4 }).rangeFingerprint);
        assert.equal(readFileSync(join(fixture.root, "bytes.txt"), "utf8"), "01AB56789");
        const start: ByteUse = readUseByte(fixture.sandbox, { path: "bytes.txt", startByte: 0, endByte: 0 });
        await writeUseByte(fixture.sandbox, Session, { path: "bytes.txt", startByte: 0, endByte: 0, content: new TextEncoder().encode("pre"), expectFingerprint: start.fingerprint, expectRangeFingerprint: start.rangeFingerprint });
        assert.equal(readFileSync(join(fixture.root, "bytes.txt"), "utf8"), "pre01AB56789");
        const all: ByteUse = readUseByte(fixture.sandbox, { path: "bytes.txt", startByte: 0, endByte: Number(readUseByte(fixture.sandbox, { path: "bytes.txt", startByte: 0, endByte: 0 }).totalBytes) });
        await writeUseByte(fixture.sandbox, Session, { path: "bytes.txt", startByte: 0, endByte: all.bytes.byteLength, content: new Uint8Array([0x78]), expectFingerprint: all.fingerprint, expectRangeFingerprint: all.rangeFingerprint });
        assert.equal(readFileSync(join(fixture.root, "bytes.txt"), "utf8"), "x");
        writeFileSync(join(fixture.root, "binary.dat"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
        const binary: ByteUse = readUseByte(fixture.sandbox, { path: "binary.dat", startByte: 1, endByte: 3 });
        assert.equal(binary.binary, true);
        assert.equal(binary.text, "");
        assert.deepEqual(Array.from(binary.bytes), [0x01, 0x02]);
        const binaryResult: WritePatchResult = await writeUseByte(fixture.sandbox, Session, {
            path: "binary.dat",
            startByte: 1,
            endByte: 3,
            content: new Uint8Array([0x09, 0x09]),
            expectFingerprint: binary.fingerprint,
            expectRangeFingerprint: binary.rangeFingerprint,
        });
        assert.deepEqual(Array.from(readFileSync(join(fixture.root, "binary.dat"))), [0x00, 0x09, 0x09, 0x03, 0x04]);
        assert.equal(binaryResult.node.charset, "binary");
        assert.equal(binaryResult.node.lines, 0n);
    } finally {
        dropFixture(fixture);
    }
});

test("line patches preserve CRLF, BOM and UTF-16 around the span", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "crlf.txt"), "a\r\nb\r\nc\r\n", "utf8");
        const crlf: LineUse = readUseLine(fixture.sandbox, { path: "crlf.txt", startLine: 2, endLine: 2 });
        assert.equal(crlf.lineEnding, "\r\n");
        assert.equal(crlf.startByte, 3);
        assert.equal(crlf.endByte, 6);
        await writeUseLine(fixture.sandbox, Session, { path: "crlf.txt", startLine: 2, endLine: 2, content: "B\r\n", expectFingerprint: crlf.fingerprint, expectRangeFingerprint: crlf.rangeFingerprint });
        assert.equal(readFileSync(join(fixture.root, "crlf.txt"), "utf8"), "a\r\nB\r\nc\r\n");
        writeFileSync(join(fixture.root, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\ntwo\n", "utf8")]));
        const bom: LineUse = readUseLine(fixture.sandbox, { path: "bom.txt", startLine: 1, endLine: 1 });
        assert.equal(bom.charset, "utf-8-bom");
        await writeUseLine(fixture.sandbox, Session, { path: "bom.txt", startLine: 1, endLine: 1, content: "ONE\n", expectFingerprint: bom.fingerprint, expectRangeFingerprint: bom.rangeFingerprint });
        const bomBytes: Buffer = readFileSync(join(fixture.root, "bom.txt"));
        assert.deepEqual(Array.from(bomBytes.subarray(0, 3)), [0xef, 0xbb, 0xbf]);
        assert.equal(bomBytes.subarray(3).toString("utf8"), "ONE\ntwo\n");
        writeFileSync(join(fixture.root, "utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("one\ntwo\n", "utf16le")]));
        const utf16: LineUse = readUseLine(fixture.sandbox, { path: "utf16.txt", startLine: 2, endLine: 2 });
        assert.equal(utf16.charset, "utf-16le");
        assert.equal(utf16.startByte, 10);
        assert.equal(utf16.endByte, 18);
        await writeUseLine(fixture.sandbox, Session, { path: "utf16.txt", startLine: 2, endLine: 2, content: "TWO\n", expectFingerprint: utf16.fingerprint, expectRangeFingerprint: utf16.rangeFingerprint });
        const utf16Bytes: Buffer = readFileSync(join(fixture.root, "utf16.txt"));
        assert.deepEqual(Array.from(utf16Bytes.subarray(0, 2)), [0xff, 0xfe]);
        assert.equal(utf16Bytes.subarray(2).toString("utf16le"), "one\nTWO\n");
        const bigEndianBody: Buffer = Buffer.from("one\ntwo\n", "utf16le");
        bigEndianBody.swap16();
        writeFileSync(join(fixture.root, "utf16be.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndianBody]));
        const utf16be: LineUse = readUseLine(fixture.sandbox, { path: "utf16be.txt", startLine: 2, endLine: 2 });
        assert.equal(utf16be.charset, "utf-16be");
        await writeUseLine(fixture.sandbox, Session, { path: "utf16be.txt", startLine: 2, endLine: 2, content: "TWO\n", expectFingerprint: utf16be.fingerprint, expectRangeFingerprint: utf16be.rangeFingerprint });
        const utf16beBytes: Buffer = readFileSync(join(fixture.root, "utf16be.txt"));
        assert.deepEqual(Array.from(utf16beBytes.subarray(0, 2)), [0xfe, 0xff]);
        const bigEndianAfter: Buffer = Buffer.from(utf16beBytes.subarray(2));
        bigEndianAfter.swap16();
        assert.equal(bigEndianAfter.toString("utf16le"), "one\nTWO\n");
    } finally {
        dropFixture(fixture);
    }
});

test("range patches reject stale whole-file or range fingerprints", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "cas-range.txt"), "abcdef", "utf8");
        const read: ByteUse = readUseByte(fixture.sandbox, { path: "cas-range.txt", startByte: 1, endByte: 3 });
        const zero: string = `sha256:${"0".repeat(64)}`;
        await expectAsyncCode(
            writeUseByte(fixture.sandbox, Session, { path: "cas-range.txt", startByte: 1, endByte: 3, content: new Uint8Array([0x58]), expectFingerprint: zero, expectRangeFingerprint: read.rangeFingerprint }),
            "fingerprint_mismatch",
        );
        assert.equal(readFileSync(join(fixture.root, "cas-range.txt"), "utf8"), "abcdef");
        await expectAsyncCode(
            writeUseByte(fixture.sandbox, Session, { path: "cas-range.txt", startByte: 1, endByte: 3, content: new Uint8Array([0x58]), expectFingerprint: read.fingerprint, expectRangeFingerprint: zero }),
            "fingerprint_mismatch",
        );
        assert.equal(readFileSync(join(fixture.root, "cas-range.txt"), "utf8"), "abcdef");
        await expectAsyncCode(writeUseByte(fixture.sandbox, Session, { path: "cas-range.txt", startByte: 1, endByte: 2, content: new Uint8Array([0x58]), expectFingerprint: "" }), "invalid_arguments");
        await expectAsyncCode(writeUseLine(fixture.sandbox, Session, { path: "cas-range.txt", startLine: 1, endLine: 1, content: "x\n", expectFingerprint: "" }), "invalid_arguments");
        await writeUseByte(fixture.sandbox, Session, { path: "cas-range.txt", startByte: 1, endByte: 3, content: new Uint8Array([0x58, 0x59]), expectFingerprint: read.fingerprint, expectRangeFingerprint: read.rangeFingerprint });
        assert.equal(readFileSync(join(fixture.root, "cas-range.txt"), "utf8"), "aXYdef");
        await expectAsyncCode(
            writeUseByte(fixture.sandbox, Session, { path: "cas-range.txt", startByte: 1, endByte: 2, content: new Uint8Array([0x5a]), expectFingerprint: read.fingerprint }),
            "fingerprint_mismatch",
        );
    } finally {
        dropFixture(fixture);
    }
});

test("range patches validate coordinates and targets", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "valid.txt"), "abc", "utf8");
        const good: ByteUse = readUseByte(fixture.sandbox, { path: "valid.txt", startByte: 0, endByte: 1 });
        await expectAsyncCode(writeUseByte(fixture.sandbox, Session, { path: "valid.txt", startByte: 2, endByte: 1, content: new Uint8Array([0x78]), expectFingerprint: good.fingerprint }), "invalid_arguments");
        await expectAsyncCode(writeUseByte(fixture.sandbox, Session, { path: "valid.txt", startByte: 0, endByte: 99, content: new Uint8Array([0x78]), expectFingerprint: good.fingerprint }), "invalid_arguments");
        await expectAsyncCode(writeUseByte(fixture.sandbox, Session, { path: "valid.txt", startByte: -1, endByte: 1, content: new Uint8Array([0x78]), expectFingerprint: good.fingerprint }), "invalid_arguments");
        await expectAsyncCode(writeUseByte(fixture.sandbox, Session, { path: "valid.txt", startByte: 0.5, endByte: 1, content: new Uint8Array([0x78]), expectFingerprint: good.fingerprint }), "invalid_arguments");
        await expectAsyncCode(writeUseLine(fixture.sandbox, Session, { path: "valid.txt", startLine: 0, endLine: 1, content: "x", expectFingerprint: good.fingerprint }), "invalid_arguments");
        await expectAsyncCode(writeUseLine(fixture.sandbox, Session, { path: "valid.txt", startLine: 2, endLine: 0, content: "x", expectFingerprint: good.fingerprint }), "invalid_arguments");
        await expectAsyncCode(writeUseLine(fixture.sandbox, Session, { path: "valid.txt", startLine: 1, endLine: 9, content: "x", expectFingerprint: good.fingerprint }), "invalid_arguments");
        await expectAsyncCode(writeUseLine(fixture.sandbox, Session, { path: "valid.txt", startLine: 9, endLine: 9, content: "x", expectFingerprint: good.fingerprint }), "invalid_arguments");
        await expectAsyncCode(writeUseByte(fixture.sandbox, Session, { path: "missing.txt", startByte: 0, endByte: 0, content: new Uint8Array([0x78]), expectFingerprint: good.fingerprint }), "not_found");
        mkdirSync(join(fixture.root, "folder"));
        await expectAsyncCode(writeUseByte(fixture.sandbox, Session, { path: "folder", startByte: 0, endByte: 0, content: new Uint8Array([0x78]), expectFingerprint: good.fingerprint }), "not_file");
        writeFileSync(join(fixture.root, "binary.dat"), Buffer.from([0x00, 0x01, 0x02]));
        const binary: ByteUse = readUseByte(fixture.sandbox, { path: "binary.dat", startByte: 0, endByte: 3 });
        await expectAsyncCode(writeUseLine(fixture.sandbox, Session, { path: "binary.dat", startLine: 1, endLine: 1, content: "x", expectFingerprint: binary.fingerprint }), "binary_file");
        assert.equal(readFileSync(join(fixture.root, "valid.txt"), "utf8"), "abc");
    } finally {
        dropFixture(fixture);
    }
});

test("range dry-runs, journals and tree refresh stay consistent", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "range.txt"), "abcdef", "utf8");
        const read: ByteUse = readUseByte(fixture.sandbox, { path: "range.txt", startByte: 1, endByte: 3 });
        const dryJournal: WriteJournalEntry[] = [];
        const dryPatches: PatchJournalEntry[] = [];
        const preview: WritePatchResult = await writeUseByte(
            fixture.sandbox,
            Session,
            { path: "range.txt", startByte: 1, endByte: 3, content: new Uint8Array([0x58]), expectFingerprint: read.fingerprint, expectRangeFingerprint: read.rangeFingerprint, dryRun: true },
            { journal: (entry: WriteJournalEntry): void => { dryJournal.push(entry); }, patchJournal: (entry: PatchJournalEntry): void => { dryPatches.push(entry); } },
        );
        assert.equal(preview.dryRun, true);
        assert.equal(preview.node.bytes, 5n);
        assert.equal(preview.previousRangeFingerprint, read.rangeFingerprint);
        assert.notEqual(preview.nextRangeFingerprint, preview.previousRangeFingerprint);
        assert.deepEqual(dryJournal, []);
        assert.deepEqual(dryPatches, []);
        assert.equal(readFileSync(join(fixture.root, "range.txt"), "utf8"), "abcdef");
        const tree: WorkspaceTree = new WorkspaceTree({ id: "root.test", path: fixture.root, writable: true, exclude: [] });
        const journal: WriteJournalEntry[] = [];
        const patches: PatchJournalEntry[] = [];
        const written: WritePatchResult = await writeUseByte(
            fixture.sandbox,
            Session,
            { path: "range.txt", startByte: 1, endByte: 3, content: new Uint8Array([0x58]), expectFingerprint: read.fingerprint, expectRangeFingerprint: read.rangeFingerprint },
            { journal: (entry: WriteJournalEntry): void => { journal.push(entry); }, patchJournal: (entry: PatchJournalEntry): void => { patches.push(entry); }, tree },
        );
        assert.equal(readFileSync(join(fixture.root, "range.txt"), "utf8"), "aXdef");
        assert.equal(journal.length, 1);
        assert.equal(patches.length, 1);
        assert.match(journal[0].id, /^w\.[0-9a-f]{16}$/u);
        assert.equal(journal[0].mode, "overwrite");
        assert.equal(journal[0].path, "range.txt");
        assert.equal(journal[0].previousFingerprint, read.fingerprint);
        assert.equal(journal[0].nextFingerprint, written.node.fingerprint);
        assert.equal(journal[0].bytes, 5n);
        assert.equal(new Date(journal[0].at).toISOString(), journal[0].at);
        assert.equal(patches[0].kind, "byte");
        assert.equal(patches[0].startByte, 1);
        assert.equal(patches[0].endByte, 3);
        assert.equal(patches[0].previousRangeFingerprint, read.rangeFingerprint);
        assert.equal(patches[0].nextStartByte, 1);
        assert.equal(patches[0].nextEndByte, 2);
        assert.equal(patches[0].previousTotalBytes, 6n);
        assert.equal(patches[0].nextTotalBytes, 5n);
        assert.equal(written.revision, tree.revision());
        const treeNode: TreeNode | undefined = tree.node("range.txt");
        assert.ok(treeNode !== (void 0));
        assert.equal(treeNode.fingerprint, written.node.fingerprint);
        const leftovers: string[] = readdirSync(fixture.root).filter((name: string): boolean => name.startsWith(".amp-"));
        assert.deepEqual(leftovers, []);
        const lineRead: LineUse = readUseLine(fixture.sandbox, { path: "range.txt", startLine: 1, endLine: 1 });
        const linePatches: PatchJournalEntry[] = [];
        await writeUseLine(
            fixture.sandbox,
            Session,
            { path: "range.txt", startLine: 1, endLine: 1, content: "Z\n", expectFingerprint: lineRead.fingerprint, expectRangeFingerprint: lineRead.rangeFingerprint },
            { patchJournal: (entry: PatchJournalEntry): void => { linePatches.push(entry); } },
        );
        assert.equal(linePatches.length, 1);
        assert.equal(linePatches[0].kind, "line");
        assert.equal(linePatches[0].startLine, 1);
        assert.equal(linePatches[0].endLine, 1);
        assert.equal(linePatches[0].startByte, 0);
        assert.equal(linePatches[0].endByte, 5);
        assert.equal(readFileSync(join(fixture.root, "range.txt"), "utf8"), "Z\n");
    } finally {
        dropFixture(fixture);
    }
});

test("patch journal callbacks run outside the write lock", { timeout: 5_000 }, async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "reentrant.txt"), "abc", "utf8");
        const read: ByteUse = readUseByte(fixture.sandbox, { path: "reentrant.txt", startByte: 0, endByte: 1 });
        let reentrant: Promise<WriteResult> | undefined = (void 0);
        await writeUseByte(
            fixture.sandbox,
            Session,
            { path: "reentrant.txt", startByte: 0, endByte: 1, content: new Uint8Array([0x58]), expectFingerprint: read.fingerprint, expectRangeFingerprint: read.rangeFingerprint },
            {
                patchJournal: (): void => {
                    reentrant = writeFile(fixture.sandbox, Session, { path: "reentrant.txt", content: "done", mode: "overwrite" });
                },
            },
        );
        assert.ok(reentrant !== (void 0));
        await reentrant;
        assert.equal(readFileSync(join(fixture.root, "reentrant.txt"), "utf8"), "done");
    } finally {
        dropFixture(fixture);
    }
});

test("writeFile journal callbacks run outside the write lock", { timeout: 5_000 }, async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "write-reentrant.txt"), "start", "utf8");
        let reentrant: Promise<WriteResult> | undefined = (void 0);
        const first: WriteResult = await writeFile(
            fixture.sandbox,
            Session,
            { path: "write-reentrant.txt", content: "first", mode: "overwrite" },
            {
                journal: (): void => {
                    reentrant = writeFile(fixture.sandbox, Session, { path: "write-reentrant.txt", content: "second", mode: "overwrite" });
                },
            },
        );
        assert.equal(first.node.fingerprint, rawDigest(Buffer.from("first")));
        assert.ok(reentrant !== (void 0));
        await reentrant;
        assert.equal(readFileSync(join(fixture.root, "write-reentrant.txt"), "utf8"), "second");
    } finally {
        dropFixture(fixture);
    }
});

test("range patches enforce the result size ceiling", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "limit-range.txt"), "12345678", "utf8");
        const end: ByteUse = readUseByte(fixture.sandbox, { path: "limit-range.txt", startByte: 8, endByte: 8 });
        await expectAsyncCode(
            writeUseByte(fixture.sandbox, Session, { path: "limit-range.txt", startByte: 8, endByte: 8, content: new Uint8Array([0x39]), expectFingerprint: end.fingerprint, expectRangeFingerprint: end.rangeFingerprint }, { maxBytes: 8 }),
            "quota_exceeded",
        );
        assert.equal(readFileSync(join(fixture.root, "limit-range.txt"), "utf8"), "12345678");
        const first: ByteUse = readUseByte(fixture.sandbox, { path: "limit-range.txt", startByte: 0, endByte: 1 });
        const shrunk: WritePatchResult = await writeUseByte(
            fixture.sandbox,
            Session,
            { path: "limit-range.txt", startByte: 0, endByte: 1, content: new Uint8Array(0), expectFingerprint: first.fingerprint, expectRangeFingerprint: first.rangeFingerprint },
            { maxBytes: 8 },
        );
        assert.equal(shrunk.bytesWritten, 7n);
        assert.equal(readFileSync(join(fixture.root, "limit-range.txt"), "utf8"), "2345678");
        writeFileSync(join(fixture.root, "big-line.txt"), "123456789", "utf8");
        const bigLine: LineUse = readUseLine(fixture.sandbox, { path: "big-line.txt", startLine: 1, endLine: 1 });
        const shrunkLine: WritePatchResult = await writeUseLine(
            fixture.sandbox,
            Session,
            { path: "big-line.txt", startLine: 1, endLine: 1, content: "x", expectFingerprint: bigLine.fingerprint, expectRangeFingerprint: bigLine.rangeFingerprint },
            { maxBytes: 8 },
        );
        assert.equal(shrunkLine.bytesWritten, 1n);
        assert.equal(readFileSync(join(fixture.root, "big-line.txt"), "utf8"), "x");
        writeFileSync(join(fixture.root, "grow-line.txt"), "a\nb\nc\nd\n", "utf8");
        const grow: LineUse = readUseLine(fixture.sandbox, { path: "grow-line.txt", startLine: 1, endLine: 1 });
        await expectAsyncCode(
            writeUseLine(fixture.sandbox, Session, { path: "grow-line.txt", startLine: 1, endLine: 1, content: "AAAA\n", expectFingerprint: grow.fingerprint, expectRangeFingerprint: grow.rangeFingerprint }, { maxBytes: 8 }),
            "quota_exceeded",
        );
        assert.equal(readFileSync(join(fixture.root, "grow-line.txt"), "utf8"), "a\nb\nc\nd\n");
    } finally {
        dropFixture(fixture);
    }
});

test("concurrent range patches use whole-file CAS", async (): Promise<void> => {
    const fixture: Fixture = makeFixture();
    try {
        writeFileSync(join(fixture.root, "race-range.txt"), "0123456789", "utf8");
        const read: ByteUse = readUseByte(fixture.sandbox, { path: "race-range.txt", startByte: 0, endByte: 10 });
        const attempts: PromiseSettledResult<WritePatchResult>[] = await Promise.allSettled([
            writeUseByte(fixture.sandbox, Session, { path: "race-range.txt", startByte: 0, endByte: 1, content: new Uint8Array([0x41]), expectFingerprint: read.fingerprint }),
            writeUseByte(fixture.sandbox, Session, { path: "race-range.txt", startByte: 9, endByte: 10, content: new Uint8Array([0x5a]), expectFingerprint: read.fingerprint }),
        ]);
        let fulfilled: number = 0;
        let conflict: string = "";
        for (let index: number = 0; index < attempts.length; index += 1) {
            const entry: PromiseSettledResult<WritePatchResult> = attempts[index];
            if (entry.status === "fulfilled") {
                fulfilled += 1;
            } else {
                const reason: unknown = entry.reason;
                conflict = isFilesystemError(reason) ? `${reason.code}` : "unknown";
            }
        }
        assert.equal(fulfilled, 1);
        assert.equal(conflict, "fingerprint_mismatch");
        const middle: string = readFileSync(join(fixture.root, "race-range.txt"), "utf8");
        assert.ok(middle === "A123456789" || middle === "012345678Z");
        const latest: ByteUse = readUseByte(fixture.sandbox, { path: "race-range.txt", startByte: 0, endByte: 10 });
        if (middle.startsWith("A")) {
            await writeUseByte(fixture.sandbox, Session, { path: "race-range.txt", startByte: 9, endByte: 10, content: new Uint8Array([0x5a]), expectFingerprint: latest.fingerprint });
        } else {
            await writeUseByte(fixture.sandbox, Session, { path: "race-range.txt", startByte: 0, endByte: 1, content: new Uint8Array([0x41]), expectFingerprint: latest.fingerprint });
        }
        assert.equal(readFileSync(join(fixture.root, "race-range.txt"), "utf8"), "A12345678Z");
    } finally {
        dropFixture(fixture);
    }
});

test("ensureDirectory creates chains and keeps the root boundary", (): void => {
    const fixture: Fixture = makeFixture();
    try {
        const created: RootedPath = ensureDirectory(fixture.sandbox, "one/two");
        assert.equal(created.relative, "one/two");
        assert.equal(existsSync(join(fixture.root, "one", "two")), true);
        assert.equal(ensureDirectory(fixture.sandbox, "one/two").relative, "one/two");
        expectSyncCode((): void => {
            ensureDirectory(fixture.sandbox, "one/two", "create");
        }, "already_exists");
        expectSyncCode((): void => {
            ensureDirectory(fixture.sandbox, "../escape");
        }, "path_escape");
        expectSyncCode((): void => {
            ensureDirectory(fixture.sandbox, "missing/child", "create");
        }, "not_found");
        writeFileSync(join(fixture.root, "blocker"), "x", "utf8");
        expectSyncCode((): void => {
            ensureDirectory(fixture.sandbox, "blocker/child");
        }, "not_directory");
        assert.equal(ensureDirectory(fixture.sandbox, ".", "ensure").relative, ".");
        assert.equal(ensureDirectory(fixture.sandbox, ".", "create").relative, ".");
        mkdirSync(join(fixture.root, "existing"));
        expectSyncCode((): void => {
            ensureDirectory(fixture.sandbox, "existing", "create");
        }, "already_exists");
        expectSyncCode((): void => {
            ensureDirectory(fixture.sandbox, "existing", "invalid" as unknown as "create" | "ensure");
        }, "invalid_arguments");
    } finally {
        dropFixture(fixture);
    }
});

test("ReadCache evicts the least recently used page", (): void => {
    assert.throws((): ReadCache => new ReadCache({ entries: 0 }), RangeError);
    const cache: ReadCache = new ReadCache({ entries: 2 });
    cache.set("a", "first");
    cache.set("b", "second");
    assert.equal(cache.get("a"), "first");
    cache.set("c", "third");
    assert.equal(cache.get("b"), (void 0));
    assert.equal(cache.get("a"), "first");
    assert.equal(cache.get("c"), "third");
    assert.equal(cache.size, 2);
    cache.set("a", "updated");
    assert.equal(cache.get("a"), "updated");
    const single: ReadCache = new ReadCache({ entries: 1 });
    single.set("x", "one");
    single.set("y", "two");
    assert.equal(single.get("x"), (void 0));
    assert.equal(single.get("y"), "two");
});
