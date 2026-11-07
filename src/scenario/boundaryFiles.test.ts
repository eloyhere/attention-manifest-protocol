/**
 * Boundary matrix for the file / workspace / edit layer.
 *
 * Every test is self-contained: temporary directories are created with `mkdtempSync` and
 * removed in `t.after`. No production source file is modified by this suite.
 *
 * Contract notes discovered while writing these tests are called out in comments. The four
 * source defects this suite originally isolated as `test.skip` cases are fixed in `src/file/**`
 * and now run as normal regression tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Workspace } from "../workspace/core.ts";
import { WorkspaceError } from "../workspace/types.ts";
import { InMemoryFileStorage } from "../file/core.ts";
import type { WorkspaceFile } from "../file/core.ts";
import { NodeFileStorage } from "../file/node.ts";
import type { CharsetInfo } from "../file/charset.ts";
import { defaultCharset, detectCharset, detectLineEnding, encodeText } from "../file/charset.ts";
import { byteToCharIndex, resolveRegions, selectRegions, unifiedDiff } from "../file/edit.ts";
import { DocumentError } from "../file/document/types.ts";
import type { FileRange, FileRef, FileStoragePort, ReplaceTarget, WorkspaceMode, WriteTarget } from "../file/types.ts";

const scope = { tenantId: "tenant-boundary", rootId: "root-boundary" } as const;
type Code = WorkspaceError["code"];
type Cleanup = { after: (fn: () => void) => void };

/** Workspace-relative paths that the shared `validatePath` grammar must reject. */
const INVALID_PATHS: readonly string[] = [
    "", ".", "..", "../escape", "/absolute", "C:/windows", "c:relative", "a\\b", "a//b", "a/./b",
    "a/../b", "a/", "./a", "a:b", "nul\0byte",
];

function code(expected: Code) {
    return (error: unknown): boolean => error instanceof WorkspaceError && error.code === expected;
}

function expectCode(action: () => unknown, expected: Code, message?: string): void {
    assert.throws(action, code(expected), message);
}

function tempRoot(t: Cleanup, prefix = "amp-boundary-"): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

interface MemoryFixture {
    readonly storage: InMemoryFileStorage;
    readonly workspace: Workspace;
    readonly file: WorkspaceFile;
}

/** In-memory workspace with one seeded file, mounted writable and already active. */
function memoryFixture(content: string, options: { readonly path?: string; readonly mode?: WorkspaceMode } = {}): MemoryFixture {
    const path = options.path ?? "notes.txt";
    const storage = new InMemoryFileStorage();
    storage.put({ ...scope, path }, content);
    const workspace = new Workspace({ ...scope, storage });
    return { storage, workspace, file: workspace.mount(path, { mode: options.mode ?? "writable", owner: "agent" }) };
}

interface NodeFixture {
    readonly root: string;
    readonly storage: NodeFileStorage;
    readonly workspace: Workspace;
    readonly absolute: (path: string) => string;
}

/** Real-filesystem workspace rooted in a fresh temp directory. */
function nodeFixture(
    t: Cleanup,
    files: Readonly<Record<string, string | Uint8Array>> = {},
    options: { readonly maxFileBytes?: number; readonly fsync?: boolean } = {},
): NodeFixture {
    const root = tempRoot(t);
    for (const [name, content] of Object.entries(files)) {
        const absolute = join(root, name);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content);
    }
    const storage = new NodeFileStorage({
        root,
        fsync: options.fsync ?? false,
        ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    });
    return { root, storage, workspace: new Workspace({ ...scope, storage }), absolute: name => join(root, name) };
}

function charset(encoding: CharsetInfo["encoding"], bom: boolean, eol: CharsetInfo["eol"]): CharsetInfo {
    return { ...defaultCharset, encoding, bom, eol };
}

function writeAndRead(content: string, replacement: string, target: FileRange | WriteTarget): string {
    const { file } = memoryFixture(content);
    file.write(replacement, target);
    return file.read();
}

function replaceAndRead(content: string, target: ReplaceTarget, replacement: string): string {
    const { file } = memoryFixture(content);
    file.replace(target, replacement);
    return file.read();
}

// ---------------------------------------------------------------------------
// 1. Path validation
// ---------------------------------------------------------------------------

test("boundary(paths): empty, dot, traversal, absolute, drive, backslash, duplicate and NUL paths are invalid_path", () => {
    const workspace = new Workspace({ ...scope, storage: new InMemoryFileStorage() });
    for (const path of INVALID_PATHS) {
        assert.throws(() => workspace.file(path), code("invalid_path"), `file(${JSON.stringify(path)})`);
        assert.throws(() => workspace.mount(path), code("invalid_path"), `mount(${JSON.stringify(path)})`);
    }
    for (const path of [undefined, null]) {
        assert.throws(() => workspace.file(path as unknown as string), code("invalid_path"), `file(${String(path)})`);
        assert.throws(() => workspace.mount(path as unknown as string), code("invalid_path"), `mount(${String(path)})`);
    }
    // A truthy non-string reaches `path.includes(...)` and fails as a TypeError, which the contract permits.
    for (const path of [42, true]) {
        assert.throws(() => workspace.file(path as unknown as string), TypeError, `file(${String(path)})`);
        assert.throws(() => workspace.mount(path as unknown as string), TypeError, `mount(${String(path)})`);
    }
});

test("boundary(paths): NodeFileStorage.resolvePath applies the same workspace-relative grammar", (t) => {
    const fixture = nodeFixture(t);
    for (const path of INVALID_PATHS) {
        assert.throws(() => fixture.storage.resolvePath(path), code("invalid_path"), `resolvePath(${JSON.stringify(path)})`);
    }
    assert.throws(() => fixture.storage.resolvePath(undefined as unknown as string), code("invalid_path"));

    mkdirSync(join(fixture.root, "nested"));
    assert.equal(fixture.storage.resolvePath("nested/file.txt").endsWith(join("nested", "file.txt")), true);
    expectCode(() => fixture.storage.resolvePath("absent/file.txt"), "not_found");
});

test("boundary(paths): nested, dotted and hidden names are valid workspace paths", (t) => {
    const fixture = nodeFixture(t, {
        "plain.txt": "plain\n",
        "dir/nested.txt": "nested\n",
        ".hidden": "hidden\n",
        "a..b": "dots\n",
    });
    assert.equal(fixture.workspace.mount("plain.txt").read(), "plain\n");
    assert.equal(fixture.workspace.mount("dir/nested.txt").read(), "nested\n");
    assert.equal(fixture.workspace.mount(".hidden").read(), "hidden\n");
    assert.equal(fixture.workspace.mount("a..b").read(), "dots\n");
});

test("boundary(paths): a 5000-character path passes validation and fails as a missing file", (t) => {
    const longPath = "a".repeat(5000);
    const memory = new Workspace({ ...scope, storage: new InMemoryFileStorage() });
    assert.equal(memory.file(longPath).path.length, 5000);
    expectCode(() => memory.mount(longPath), "not_found");

    const fixture = nodeFixture(t);
    assert.equal(fixture.workspace.file(longPath).path.length, 5000);
    expectCode(() => fixture.workspace.mount(longPath), "not_found");
});

test("boundary(paths): Workspace requires non-empty tenantId and rootId", () => {
    const storage = new InMemoryFileStorage();
    expectCode(() => new Workspace({ tenantId: "", rootId: "root", storage }), "invalid_scope");
    expectCode(() => new Workspace({ tenantId: "tenant", rootId: "", storage }), "invalid_scope");
});

// ---------------------------------------------------------------------------
// 2. Range boundaries
// ---------------------------------------------------------------------------

test("boundary(range): line writes cover zero length, exact bounds, whole file and end == lineCount", () => {
    const cases: ReadonlyArray<readonly [string, string, FileRange | WriteTarget, string]> = [
        ["a\nb\n", "X", { mode: "line", start: 0, end: 0 }, "Xa\nb\n"],
        ["a\nb\n", "X", { mode: "line", start: 2, end: 2 }, "a\nb\nX"],
        ["a\nb\n", "X", { mode: "line", start: 1, end: 2 }, "a\nX\n"],
        ["a\nb\n", "X", { mode: "line", start: 1, end: 3 }, "a\nX\n"],
        ["a\nb\n", "X", { mode: "line", start: 0, end: 3 }, "X\n"],
        ["", "X", { mode: "line", start: 0, end: 0 }, "X"],
        ["", "X", { mode: "line", start: 0, end: 1 }, "X"],
        ["a\nb\n", "X", { kind: "line", start: 1, end: 2 }, "a\nX\n"],
        ["a\nb\n", "X", { line: { start: 1, end: 2 } }, "a\nX\n"],
    ];
    for (const [content, replacement, target, expected] of cases) {
        assert.equal(writeAndRead(content, replacement, target), expected, JSON.stringify(target));
    }
    // `end` equal to lineCount addresses the empty line after the final newline.
    assert.equal(writeAndRead("a\nb\n", "X", { mode: "line", start: 3, end: 3 }), "a\nb\nX");

    const { file } = memoryFixture("a\nb\n");
    const snapshot = file.write("X", { mode: "line", start: 1, end: 2 });
    assert.equal(snapshot.bufferVersion, 1);
    assert.equal(snapshot.state, "dirty");
    assert.equal(snapshot.dirty, true);
    assert.equal(file.read(), "a\nX\n");
});

test("boundary(range): line writes reject reversed, negative, fractional, infinite and beyond-lineCount bounds", () => {
    const { file } = memoryFixture("a\nb\n");
    const invalid: ReadonlyArray<readonly [number, number]> = [
        [2, 1], [-1, 0], [0, -1], [0, 4], [4, 4], [0.5, 1], [Number.NaN, 1], [0, Number.POSITIVE_INFINITY],
    ];
    for (const [start, end] of invalid) {
        expectCode(() => file.write("X", { mode: "line", start, end }), "invalid_range", `line ${start}..${end}`);
    }
    assert.equal(file.read(), "a\nb\n");
    assert.equal(file.snapshot().bufferVersion, 0);
});

test("boundary(range): byte writes use UTF-8 offsets and allow zero-length inserts", () => {
    const emoji = "a😀b\n";
    const emojiLimit = Buffer.byteLength(emoji, "utf8");
    const cases: ReadonlyArray<readonly [string, string, FileRange | WriteTarget, string]> = [
        ["a\nb\n", "X", { mode: "byte", start: 0, end: 0 }, "Xa\nb\n"],
        ["a\nb\n", "X", { mode: "byte", start: 4, end: 4 }, "a\nb\nX"],
        ["a\nb\n", "X", { mode: "byte", start: 2, end: 3 }, "a\nX\n"],
        ["a\nb\n", "X", { byte: { start: 0, end: 1 } }, "X\nb\n"],
        ["a\nb\n", "X", { kind: "byte", start: 0, end: 1 }, "X\nb\n"],
        [emoji, "X", { mode: "byte", start: 1, end: 5 }, "aXb\n"],
        [emoji, "X", { mode: "byte", start: emojiLimit, end: emojiLimit }, `${emoji}X`],
        ["中文\n", "日", { mode: "byte", start: 0, end: 3 }, "日文\n"],
    ];
    for (const [content, replacement, target, expected] of cases) {
        assert.equal(writeAndRead(content, replacement, target), expected, JSON.stringify(target));
    }
});

test("boundary(range): byte writes reject code-point splits, reversed and out-of-buffer bounds", () => {
    const { file } = memoryFixture("a😀b\n");
    const invalid: ReadonlyArray<readonly [number, number]> = [
        [2, 4], [3, 5], [0, 8], [-1, 1], [2, 1], [0.5, 1], [Number.NaN, 1], [0, Number.POSITIVE_INFINITY],
    ];
    for (const [start, end] of invalid) {
        expectCode(() => file.write("X", { mode: "byte", start, end }), "invalid_range", `byte ${start}..${end}`);
    }
    const chinese = memoryFixture("中文\n").file;
    for (const [start, end] of [[1, 3], [3, 5]] as const) {
        expectCode(() => chinese.write("X", { mode: "byte", start, end }), "invalid_range", `chinese ${start}..${end}`);
    }
    assert.equal(file.read(), "a😀b\n");
    assert.equal(chinese.read(), "中文\n");
});

test("boundary(range): a BOM prefix is not addressable through byte offsets", (t) => {
    const fixture = nodeFixture(t, { "bom.txt": Uint8Array.from([0xef, 0xbb, 0xbf, 0xc3, 0xa9, 0x0a]) });
    const file = fixture.workspace.mount("bom.txt", { mode: "writable", owner: "agent" });
    const snapshot = file.snapshot();
    assert.equal(snapshot.size, 6, "size includes the three BOM bytes");
    assert.equal(snapshot.bom, true);
    assert.equal(snapshot.encoding, "utf-8");
    assert.equal(file.read(), "é\n", "the BOM is stripped from the buffer");

    assert.equal(file.read({ kind: "byte", start: 0, end: 2 }), "é");
    assert.equal(file.read({ kind: "byte", start: 2, end: 3 }), "\n");
    expectCode(() => file.read({ kind: "byte", start: 0, end: 1 }), "invalid_range");

    file.write("E", { kind: "byte", start: 0, end: 2 });
    assert.equal(file.read(), "E\n");
    file.flush();
    assert.deepEqual([...readFileSync(fixture.absolute("bom.txt"))], [0xef, 0xbb, 0xbf, 0x45, 0x0a]);
});

test("boundary(range): CRLF files are addressed through the normalized LF buffer", (t) => {
    const fixture = nodeFixture(t, { "crlf.txt": "a\r\nb\r\n" });
    const file = fixture.workspace.mount("crlf.txt", { mode: "writable", owner: "agent" });
    const snapshot = file.snapshot();
    assert.equal(snapshot.size, 6);
    assert.equal(snapshot.eol, "\r\n");
    assert.equal(snapshot.encoding, "utf-8");
    assert.equal(file.read(), "a\nb\n");
    assert.deepEqual([...file.readBytes()], [0x61, 0x0a, 0x62, 0x0a], "text mounts expose normalized UTF-8");
    assert.equal(file.read({ kind: "byte", start: 0, end: 2 }), "a\n");
    assert.equal(file.read({ kind: "line", start: 1, end: 2 }), "b");

    file.write("X", { kind: "byte", start: 2, end: 4 });
    assert.equal(file.read(), "a\nX\n");
    file.flush();
    assert.equal(readFileSync(fixture.absolute("crlf.txt"), "utf8"), "a\r\nX\r\n");
});

test("boundary(range): legacy FileRange reads honor zero length, end == lineCount and byte limits", () => {
    const { file } = memoryFixture("one\ntwo\nthree\n");
    assert.equal(file.read({ kind: "line", start: 0, end: 0 }), "");
    assert.equal(file.read({ kind: "line", start: 0, end: 3 }), "one\ntwo\nthree");
    assert.equal(file.read({ kind: "line", start: 3, end: 4 }), "");
    assert.equal(file.read({ kind: "line", start: 4, end: 4 }), "");
    assert.equal(file.read({ line: { start: 0, end: 2 } }), "one\ntwo");
    assert.equal(file.read({ line: { start: 1, end: 3 } }), "two\nthree");
    assert.equal(file.read({ kind: "byte", start: 0, end: 0 }), "");
    assert.equal(file.read({ kind: "byte", start: 0, end: 14 }), "one\ntwo\nthree\n");
    assert.equal(file.read({ kind: "byte", start: 14, end: 14 }), "");
    assert.equal(file.read({ byte: { start: 0, end: 4 } }), "one\n");
    for (const range of [{ kind: "line", start: 5, end: 5 }, { kind: "line", start: 0, end: 5 }, { kind: "line", start: 2, end: 1 },
        { kind: "byte", start: 15, end: 15 }, { kind: "byte", start: 5, end: 4 }] as const) {
        expectCode(() => file.read(range), "invalid_range", JSON.stringify(range));
    }
    // `read` accepts the legacy `FileRange` union only; a new-style target object is a runtime TypeError.
    assert.throws(() => file.read({} as never), TypeError);
    assert.throws(() => file.read({ kind: "line" } as never), code("invalid_range"));
});

test("boundary(range): readLines handles startLine == lineCount, past EOF and invalid counts", () => {
    const { file } = memoryFixture("one\ntwo\nthree\n");
    const first = file.readLines(0, 2);
    assert.deepEqual({ text: first.text, lineCount: first.lineCount, totalLines: first.totalLines, truncated: first.truncated, startLine: first.startLine, eol: first.eol },
        { text: "one\ntwo\n", lineCount: 2, totalLines: 4, truncated: true, startLine: 0, eol: "\n" });
    const second = file.readLines(2, 2);
    assert.equal(second.text, "three\n");
    assert.equal(second.truncated, false);
    assert.equal(second.lineCount, 2);
    const trailing = file.readLines(3, 1);
    assert.equal(trailing.text, "");
    assert.equal(trailing.lineCount, 1, "the empty line after the final newline counts as a line");
    assert.equal(trailing.totalLines, 4);
    assert.equal(file.readLines(4, 1).lineCount, 0);
    assert.equal(file.readLines(99, 1).lineCount, 0);
    expectCode(() => file.readLines(0, 0), "invalid_range");
    expectCode(() => file.readLines(-1, 1), "invalid_range");
    expectCode(() => file.readLines(1.5, 1), "invalid_range");
    expectCode(() => file.readLines(0, -1), "invalid_range");
});

test("boundary(range): dry-run plans resolve targets without mutating the buffer", () => {
    const { file } = memoryFixture("one\ntwo\nthree\n");
    const written = file.planWrite("X", { mode: "line", start: 0, end: 1 });
    assert.equal(written.mode, "line");
    assert.equal(written.text, "X\ntwo\nthree\n");
    const whole = file.planWrite("whole");
    assert.equal(whole.mode, "file");
    assert.equal(whole.text, "whole");
    const replaced = file.planReplace({ mode: "regex", pattern: "one" }, "1");
    assert.equal(replaced.mode, "regex");
    assert.equal(replaced.text, "1\ntwo\nthree\n");
    const applied = file.planApply([{ kind: "replace", target: { mode: "string", text: "two" }, replacement: "2" }]);
    assert.equal(applied.mode, "apply");
    assert.equal(applied.text, "one\n2\nthree\n");
    assert.equal(file.read(), "one\ntwo\nthree\n");
    assert.equal(file.snapshot().bufferVersion, 0);
    assert.equal(file.snapshot().dirty, false);
});

// ---------------------------------------------------------------------------
// 3. Encoding and line endings
// ---------------------------------------------------------------------------

test("boundary(charset): UTF-8 BOM with CRLF survives a line edit", (t) => {
    const fixture = nodeFixture(t, { "bom.txt": Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a\r\nb\r\n")]) });
    const file = fixture.workspace.mount("bom.txt", { mode: "writable", owner: "agent" });
    const snapshot = file.snapshot();
    assert.equal(snapshot.encoding, "utf-8");
    assert.equal(snapshot.bom, true);
    assert.equal(snapshot.eol, "\r\n");
    assert.equal(snapshot.size, 9);
    assert.equal(file.read(), "a\nb\n");
    assert.equal(file.readLines(0, 1).eol, "\r\n");

    file.write("A", { mode: "line", start: 0, end: 1 });
    assert.equal(file.read(), "A\nb\n");
    file.flush();
    const onDisk = readFileSync(fixture.absolute("bom.txt"));
    assert.deepEqual([...onDisk], [0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a, 0x62, 0x0d, 0x0a]);
    const reread = detectCharset(onDisk);
    assert.equal(reread.encoding, "utf-8");
    assert.equal(reread.bom, true);
    assert.equal(reread.eol, "\r\n");
});

test("boundary(charset): UTF-16LE BOM with CRLF survives a line edit", (t) => {
    const source = encodeText("a\nb\n", charset("utf-16le", true, "\r\n"));
    assert.deepEqual([...source], [0xff, 0xfe, 0x61, 0x00, 0x0d, 0x00, 0x0a, 0x00, 0x62, 0x00, 0x0d, 0x00, 0x0a, 0x00]);
    const fixture = nodeFixture(t, { "le.txt": source });
    const file = fixture.workspace.mount("le.txt", { mode: "writable", owner: "agent" });
    const snapshot = file.snapshot();
    assert.equal(snapshot.encoding, "utf-16le");
    assert.equal(snapshot.bom, true);
    assert.equal(snapshot.eol, "\r\n");
    assert.equal(snapshot.size, 14);
    assert.equal(file.read(), "a\nb\n");
    assert.equal(file.readLines(1, 1).text, "b\n");
    assert.deepEqual([...file.readBytes()], [...new TextEncoder().encode("a\nb\n")], "readBytes on a text mount is normalized UTF-8");

    file.write("A", { mode: "line", start: 0, end: 1 });
    file.flush();
    assert.deepEqual([...readFileSync(fixture.absolute("le.txt"))],
        [0xff, 0xfe, 0x41, 0x00, 0x0d, 0x00, 0x0a, 0x00, 0x62, 0x00, 0x0d, 0x00, 0x0a, 0x00]);
});

test("boundary(charset): UTF-16BE BOM with CRLF survives a line edit", (t) => {
    const source = encodeText("a\nb\n", charset("utf-16be", true, "\r\n"));
    assert.deepEqual([...source], [0xfe, 0xff, 0x00, 0x61, 0x00, 0x0d, 0x00, 0x0a, 0x00, 0x62, 0x00, 0x0d, 0x00, 0x0a]);
    const fixture = nodeFixture(t, { "be.txt": source });
    const file = fixture.workspace.mount("be.txt", { mode: "writable", owner: "agent" });
    const snapshot = file.snapshot();
    assert.equal(snapshot.encoding, "utf-16be");
    assert.equal(snapshot.bom, true);
    assert.equal(snapshot.eol, "\r\n");
    assert.equal(snapshot.size, 14);
    assert.equal(file.read(), "a\nb\n");

    file.write("A", { mode: "line", start: 0, end: 1 });
    file.flush();
    assert.deepEqual([...readFileSync(fixture.absolute("be.txt"))],
        [0xfe, 0xff, 0x00, 0x41, 0x00, 0x0d, 0x00, 0x0a, 0x00, 0x62, 0x00, 0x0d, 0x00, 0x0a]);
});

test("boundary(charset): LF text without a trailing newline keeps LF on commit", (t) => {
    const fixture = nodeFixture(t, { "lf.txt": "a\nb" });
    const file = fixture.workspace.mount("lf.txt", { mode: "writable", owner: "agent" });
    const snapshot = file.snapshot();
    assert.equal(snapshot.encoding, "utf-8");
    assert.equal(snapshot.bom, false);
    assert.equal(snapshot.eol, "\n");
    assert.equal(snapshot.size, 3);
    assert.equal(file.read(), "a\nb");

    file.write("a\nB");
    file.flush();
    assert.equal(readFileSync(fixture.absolute("lf.txt"), "utf8"), "a\nB");
    assert.equal(detectCharset(readFileSync(fixture.absolute("lf.txt"))).finalNewline, false);
});

test("boundary(charset): mixed line endings mount readably but refuse to commit", (t) => {
    const fixture = nodeFixture(t, { "mixed.txt": "a\r\nb\nc" });
    const file = fixture.workspace.mount("mixed.txt", { mode: "writable", owner: "agent" });
    assert.equal(file.snapshot().eol, "\r\n");
    assert.equal(file.snapshot().size, 6);
    assert.equal(file.read(), "a\nb\nc");
    assert.equal(fixture.storage.read({ ...scope, path: "mixed.txt" })?.charset?.mixedEol, true);

    file.write("X", { mode: "line", start: 0, end: 1 });
    expectCode(() => file.flush(), "mixed_eol");
    assert.equal(readFileSync(fixture.absolute("mixed.txt"), "utf8"), "a\r\nb\nc", "a refused commit must not touch disk");
    assert.equal(file.dirty, true);
});

test("boundary(charset): an isolated CR reads as LF but cannot be committed", (t) => {
    const fixture = nodeFixture(t, { "cr.txt": "a\rb" });
    const file = fixture.workspace.mount("cr.txt", { mode: "writable", owner: "agent" });
    const snapshot = file.snapshot();
    assert.equal(snapshot.size, 3);
    assert.equal(snapshot.eol, "\r\n", "LineEnding has no bare-CR variant; CR-only text is reported as CRLF");
    assert.equal(file.read(), "a\nb");
    assert.equal(fixture.storage.read({ ...scope, path: "cr.txt" })?.charset?.mixedEol, true);

    file.write("a\nb\n");
    expectCode(() => file.flush(), "mixed_eol");
    assert.equal(readFileSync(fixture.absolute("cr.txt"), "utf8"), "a\rb");
});

test("boundary(charset): the empty file reports default charset facts and stays editable", (t) => {
    const fixture = nodeFixture(t, { "empty.txt": "" });
    const file = fixture.workspace.mount("empty.txt", { mode: "writable", owner: "agent" });
    const snapshot = file.snapshot();
    assert.equal(snapshot.encoding, "utf-8");
    assert.equal(snapshot.bom, false);
    assert.equal(snapshot.eol, "\n");
    assert.equal(snapshot.size, 0);
    assert.equal(snapshot.binary, false);
    assert.equal(file.read(), "");
    const lines = file.readLines(0, 1);
    assert.equal(lines.text, "");
    assert.equal(lines.totalLines, 1);
    assert.equal(lines.lineCount, 1);

    file.write("x");
    file.flush();
    assert.equal(readFileSync(fixture.absolute("empty.txt"), "utf8"), "x");
    assert.equal(file.snapshot().size, 1);
});

test("boundary(charset): a BOM-only file is empty UTF-8 text that keeps its BOM", (t) => {
    const fixture = nodeFixture(t, { "bom.txt": Uint8Array.from([0xef, 0xbb, 0xbf]) });
    const file = fixture.workspace.mount("bom.txt", { mode: "writable", owner: "agent" });
    const snapshot = file.snapshot();
    assert.equal(snapshot.encoding, "utf-8");
    assert.equal(snapshot.bom, true);
    assert.equal(snapshot.size, 3);
    assert.equal(snapshot.binary, false);
    assert.equal(file.read(), "");

    const noop = file.write("");
    assert.equal(noop.state, "active");
    assert.equal(noop.dirty, false);
    assert.equal(noop.bufferVersion, 0);

    file.write("xy");
    file.flush();
    assert.deepEqual([...readFileSync(fixture.absolute("bom.txt"))], [0xef, 0xbb, 0xbf, 0x78, 0x79]);
    assert.equal(file.snapshot().size, 5);
});

test("boundary(charset): detectCharset and detectLineEnding classify BOMs, guesses and mixed endings", () => {
    const detect = (values: readonly number[]): CharsetInfo => detectCharset(Uint8Array.from(values));
    assert.deepEqual({ ...detect([]) }, { ...defaultCharset });
    assert.deepEqual({ encoding: detect([0xef, 0xbb, 0xbf, 0x61]).encoding, bom: detect([0xef, 0xbb, 0xbf, 0x61]).bom },
        { encoding: "utf-8", bom: true });
    assert.deepEqual({ encoding: detect([0xff, 0xfe, 0x61, 0x00]).encoding, bom: detect([0xff, 0xfe, 0x61, 0x00]).bom },
        { encoding: "utf-16le", bom: true });
    assert.deepEqual({ encoding: detect([0xfe, 0xff, 0x00, 0x61]).encoding, bom: detect([0xfe, 0xff, 0x00, 0x61]).bom },
        { encoding: "utf-16be", bom: true });
    assert.equal(detect([0x61, 0x00, 0x0a, 0x00]).encoding, "utf-16le", "BOM-less UTF-16LE is guessed from NUL patterns");
    assert.equal(detect([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00]).binary, true, "UTF-32LE is binary");
    assert.equal(detect([0x61, 0x00, 0x62]).binary, true, "an embedded NUL is binary");

    assert.deepEqual(detectLineEnding("a\nb"), { eol: "\n", mixed: false, finalNewline: false });
    assert.deepEqual(detectLineEnding("a\r\nb\r\n"), { eol: "\r\n", mixed: false, finalNewline: true });
    assert.deepEqual(detectLineEnding("a\r\nb\nc"), { eol: "\r\n", mixed: true, finalNewline: false });
    assert.deepEqual(detectLineEnding("a\nb\r\nc\n"), { eol: "\n", mixed: true, finalNewline: true });
    assert.equal(detectLineEnding("a\rb").mixed, true);
});

test("boundary(charset): newline-free text should default to LF and not gain CRLF on commit", (t) => {
    const fixture = nodeFixture(t, { "plain.txt": "abc", "bom.txt": Uint8Array.from([0xef, 0xbb, 0xbf]) });
    const plain = fixture.workspace.mount("plain.txt", { mode: "writable", owner: "agent" });
    assert.equal(plain.snapshot().eol, "\n");
    plain.write("abc\ndef");
    plain.flush();
    assert.equal(readFileSync(fixture.absolute("plain.txt"), "utf8"), "abc\ndef");
    const bom = fixture.workspace.mount("bom.txt", { mode: "writable", owner: "agent" });
    assert.equal(bom.snapshot().eol, "\n");
});

// ---------------------------------------------------------------------------
// 4. replace boundaries
// ---------------------------------------------------------------------------

test("boundary(replace): literal string targets are exact and never expand $ sequences", () => {
    assert.equal(replaceAndRead("const total = 1;\n", { mode: "string", text: "1" }, "$&"), "const total = $&;\n");
    assert.equal(replaceAndRead("a $& b\n", { mode: "string", text: "$&" }, "X"), "a X b\n");
    assert.equal(replaceAndRead("x-abc-y", { mode: "string", text: "abc" }, "[$1][$<name>][$$]"), "x-[$1][$<name>][$$]-y");
});

test("boundary(replace): string targets require uniqueness or an explicit occurrence/all", () => {
    expectCode(() => replaceAndRead("a a a\n", { mode: "string", text: "a" }, "X"), "ambiguous_match");
    expectCode(() => replaceAndRead("a a a\n", { mode: "string", text: "missing" }, "X"), "no_match");
    assert.equal(replaceAndRead("a a a\n", { mode: "string", text: "a", occurrence: 1 }, "X"), "X a a\n");
    assert.equal(replaceAndRead("a a a\n", { mode: "string", text: "a", occurrence: 2 }, "X"), "a X a\n");
    assert.equal(replaceAndRead("a a a\n", { mode: "string", text: "a", all: true }, "X"), "X X X\n");
    expectCode(() => replaceAndRead("a a a\n", { mode: "string", text: "a", occurrence: 4 }, "X"), "no_match");

    const { file } = memoryFixture("a a a\n");
    expectCode(() => file.replace({ mode: "string", text: "a" }, "X"), "ambiguous_match");
    assert.equal(file.read(), "a a a\n");
    assert.equal(file.snapshot().bufferVersion, 0);
});

test("boundary(replace): empty targets, empty buffers and invalid occurrence values are rejected", () => {
    expectCode(() => replaceAndRead("abc", { mode: "string", text: "" }, "X"), "invalid_target");
    expectCode(() => replaceAndRead("abc", { mode: "regex", pattern: "" }, "X"), "invalid_target");
    expectCode(() => replaceAndRead("", { mode: "string", text: "a" }, "X"), "no_match");
    expectCode(() => replaceAndRead("", { mode: "regex", pattern: "a" }, "X"), "no_match");
    expectCode(() => replaceAndRead("abc", { mode: "string", text: "a", occurrence: 0 }, "X"), "invalid_target");
    expectCode(() => replaceAndRead("abc", { mode: "string", text: "a", occurrence: -1 }, "X"), "invalid_target");
    expectCode(() => replaceAndRead("abc", { mode: "string", text: "a", occurrence: 1.5 }, "X"), "invalid_target");
    expectCode(() => replaceAndRead("abc", { mode: "string", text: 5 as unknown as string }, "X"), "invalid_target");
    expectCode(() => replaceAndRead("abc", { mode: "string", text: "a", occurrence: 1, all: true }, "X"), "invalid_target");
    expectCode(() => replaceAndRead("abc", { mode: "string", text: "a", occurrence: 2 }, "X"), "no_match");
});

test("boundary(replace): regex rejects g/y flags and honours i, m, s, u and v", () => {
    for (const flags of ["g", "y", "gy", "yg", "G", "i g"]) {
        expectCode(() => replaceAndRead("abc", { mode: "regex", pattern: "a", flags }, "X"), "invalid_target", `flags ${flags}`);
    }
    for (const flag of ["u", "v"]) {
        assert.equal(memoryFixture("a\n").file.locate({ mode: "regex", pattern: "a", flags: flag }).length, 1);
    }
    assert.equal(memoryFixture("A a\n").file.locate({ mode: "regex", pattern: "a", flags: "i" }).length, 2);
    assert.equal(memoryFixture("A\na\n").file.locate({ mode: "regex", pattern: "^a", flags: "m" }).length, 1);
    assert.equal(memoryFixture("A\na\n").file.locate({ mode: "regex", pattern: "^a" }).length, 0, "locate returns [] instead of throwing no_match");
    assert.equal(memoryFixture("A\na\n").file.locate({ mode: "regex", pattern: "A.a", flags: "s" }).length, 1);
    assert.equal(memoryFixture("A\na\n").file.locate({ mode: "regex", pattern: "A.a" }).length, 0);
    expectCode(() => replaceAndRead("abc", { mode: "regex", pattern: "[", flags: "u" }, "X"), "invalid_target");
});

test("boundary(replace): regex expansions cover $&, $1, $<name>, $$, $` and $'", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
        ["[$&]", "x-[abc]-y"],
        ["[$`]", "x-[x-]-y"],
        ["[$']", "x-[-y]-y"],
        ["[$$]", "x-[$]-y"],
    ];
    for (const [replacement, expected] of cases) {
        assert.equal(replaceAndRead("x-abc-y", { mode: "regex", pattern: "abc" }, replacement), expected, replacement);
    }
    assert.equal(replaceAndRead("x-abc-y", { mode: "regex", pattern: "(abc)" }, "[$1][$2]"), "x-[abc][]-y");
    assert.equal(replaceAndRead("x-abc-y", { mode: "regex", pattern: "(?<word>abc)" }, "[$<word>][$<missing>]"), "x-[abc][]-y");
    assert.equal(replaceAndRead("x-abc-y", { mode: "regex", pattern: "abc" }, "[$0][$99]"), "x-[abc][]-y");
});

test("boundary(replace): all:true expands every non-overlapping match", () => {
    const { file } = memoryFixture("a1 a2\n");
    const located = file.locate({ mode: "regex", pattern: "a(\\d)", all: true });
    assert.equal(located.length, 2);
    assert.equal(located[0]?.text, "a1");
    assert.equal(located[0]?.startLine, 0);
    file.replace({ mode: "regex", pattern: "a(\\d)", all: true }, "[$1]");
    assert.equal(file.read(), "[1] [2]\n");
});

test("boundary(replace): empty patterns and zero-width matches are invalid_target", () => {
    for (const pattern of ["", "^", "$", "a*", "(?=a)"]) {
        expectCode(() => replaceAndRead("abc", { mode: "regex", pattern }, "X"), "invalid_target", pattern);
    }
    const { file } = memoryFixture("abc");
    expectCode(() => file.replace({ mode: "regex", pattern: "^" }, "X"), "invalid_target");
    assert.equal(file.read(), "abc");
    assert.equal(file.snapshot().bufferVersion, 0);
});

test("boundary(replace): overlapping regex matches are resolved left-to-right without overlap", () => {
    const { file } = memoryFixture("aaaa");
    assert.equal(file.locate({ mode: "regex", pattern: "aa", all: true }).length, 2);
    file.replace({ mode: "regex", pattern: "aa", all: true }, "-");
    assert.equal(file.read(), "--");
});

test("boundary(replace): string matching is case-sensitive while the i flag is not", () => {
    assert.equal(memoryFixture("abc ABC\n").file.locate({ mode: "string", text: "ABC" }).length, 1);
    assert.equal(memoryFixture("abc ABC\n").file.locate({ mode: "string", text: "Abc" }).length, 0);
    assert.equal(memoryFixture("A a\n").file.locate({ mode: "regex", pattern: "a" }).length, 1);
    assert.equal(memoryFixture("A a\n").file.locate({ mode: "regex", pattern: "a", flags: "i" }).length, 2);
    expectCode(() => memoryFixture("A a\n").file.replace({ mode: "regex", pattern: "a", flags: "i" }, "X"), "ambiguous_match");
    assert.equal(replaceAndRead("A a\n", { mode: "regex", pattern: "a", flags: "i", all: true }, "X"), "X X\n");
});

test("boundary(replace): the 5000-match cap holds and a 100k replacement commits", () => {
    const { file } = memoryFixture("a".repeat(5000));
    file.replace({ mode: "string", text: "a", all: true }, "b");
    assert.equal(file.read(), "b".repeat(5000));
    expectCode(() => memoryFixture("a".repeat(5001)).file.replace({ mode: "string", text: "a", all: true }, "b"), "invalid_target");

    const huge = "Z".repeat(100_000);
    const { storage, file: second } = memoryFixture("x-abc-y");
    second.replace({ mode: "string", text: "abc" }, huge);
    assert.equal(second.read().length, 100_004);
    assert.equal(second.read().startsWith("x-Z"), true);
    second.flush();
    assert.equal(storage.read({ ...scope, path: "notes.txt" })?.content, `x-${huge}-y`);
});

test("boundary(replace): a failed match, range or guard leaves the buffer untouched", () => {
    const { file } = memoryFixture("alpha\n");
    expectCode(() => file.replace({ mode: "string", text: "alpha" }, "x", { expectedBaseHash: "deadbeef" }), "version_conflict");
    expectCode(() => file.replace({ mode: "string", text: "missing" }, "x"), "no_match");
    expectCode(() => file.replace({ mode: "regex", pattern: "[" }, "x"), "invalid_target");
    expectCode(() => file.replace({ mode: "byte", start: 7, end: 7 }, "x"), "invalid_range");
    assert.equal(file.read(), "alpha\n");
    assert.equal(file.snapshot().bufferVersion, 0);
    assert.equal(file.snapshot().dirty, false);
});

test("boundary(replace): a no-op replace should leave the buffer clean", () => {
    const { file } = memoryFixture("same\n");
    const before = file.snapshot();
    const snapshot = file.replace({ mode: "string", text: "same" }, "same");
    assert.equal(snapshot.dirty, false);
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.bufferVersion, before.bufferVersion);
    assert.equal(file.flush().state, "active");
    assert.equal(file.flush().version, before.version);
});

// ---------------------------------------------------------------------------
// 5. apply atomicity
// ---------------------------------------------------------------------------

test("boundary(apply): a failing step leaves text, bufferVersion and state untouched", () => {
    const { file } = memoryFixture("one\ntwo\nthree\n");
    expectCode(() => file.apply([
        { kind: "replace", target: { mode: "string", text: "one" }, replacement: "ONE" },
        { kind: "write", target: { mode: "line", start: 0, end: 99 }, content: "x" },
    ]), "invalid_range");
    expectCode(() => file.apply([
        { kind: "replace", target: { mode: "line", start: 0, end: 1 }, replacement: "ONE" },
        { kind: "replace", target: { mode: "string", text: "t" }, replacement: "T" },
    ]), "ambiguous_match");
    expectCode(() => file.apply([
        { kind: "write", content: "whole" },
        { kind: "replace", target: { mode: "string", text: "missing" }, replacement: "x" },
    ]), "no_match");
    expectCode(() => file.planApply([{ kind: "write", target: { mode: "byte", start: 0, end: 99 }, content: "x" }]), "invalid_range");

    assert.equal(file.read(), "one\ntwo\nthree\n");
    assert.equal(file.snapshot().bufferVersion, 0);
    assert.equal(file.snapshot().dirty, false);
    assert.equal(file.snapshot().state, "active");
});

test("boundary(apply): later steps resolve against the scratch text of earlier steps", () => {
    const edits = [
        { kind: "write", content: "A\nB\n" },
        { kind: "write", target: { mode: "line", start: 0, end: 1 }, content: "A2" },
        { kind: "replace", target: { mode: "string", text: "B" }, replacement: "B2" },
    ] as const;
    const plan = memoryFixture("base\n").file.planApply(edits);
    assert.equal(plan.mode, "apply");
    assert.equal(plan.text, "A2\nB2\n");
    assert.equal(plan.changed, true);

    const { file } = memoryFixture("base\n");
    const snapshot = file.apply(edits);
    assert.equal(file.read(), "A2\nB2\n");
    assert.equal(snapshot.bufferVersion, 1);
    assert.equal(snapshot.state, "dirty");
});

test("boundary(apply): an empty edit list or an unknown kind is invalid_target", () => {
    const { file } = memoryFixture("base\n");
    expectCode(() => file.apply([]), "invalid_target");
    expectCode(() => file.apply([{ kind: "nope" } as never]), "invalid_target");
    assert.equal(file.read(), "base\n");
    assert.equal(file.snapshot().bufferVersion, 0);
});

test("boundary(apply): a no-op apply leaves the buffer clean", () => {
    const { file } = memoryFixture("same\n");
    const plan = file.planApply([{ kind: "replace", target: { mode: "string", text: "same" }, replacement: "same" }]);
    assert.equal(plan.changed, false);
    const snapshot = file.apply([{ kind: "replace", target: { mode: "string", text: "same" }, replacement: "same" }]);
    assert.equal(snapshot.state, "active");
    assert.equal(snapshot.dirty, false);
    assert.equal(snapshot.bufferVersion, 0);
    assert.equal(file.read(), "same\n");
});

test("boundary(apply): expectedBaseHash and expectedBufferVersion guard the commit", () => {
    const { file } = memoryFixture("base\n");
    const initial = file.snapshot();
    const accepted = file.write("next\n", undefined, { expectedBaseHash: initial.baseHash, expectedBufferVersion: initial.bufferVersion });
    assert.equal(accepted.state, "dirty");
    assert.equal(file.read(), "next\n");

    expectCode(() => file.write("bad\n", undefined, { expectedBaseHash: "deadbeef" }), "version_conflict");
    expectCode(() => file.write("bad\n", undefined, { expectedBufferVersion: 99 }), "buffer_conflict");
    assert.equal(file.flush().dirty, false);

    expectCode(() => file.write("bad\n", undefined, { expectedBaseHash: initial.baseHash }), "version_conflict");
    expectCode(() => file.apply([{ kind: "write", content: "bad\n" }], { expectedBufferVersion: 0 }), "buffer_conflict");
    assert.equal(file.read(), "next\n");
    assert.equal(file.snapshot().bufferVersion, 1);
});

test("boundary(apply): bufferVersion advances once per committed edit and never on dry runs", () => {
    const { file } = memoryFixture("one\ntwo\n");
    assert.equal(file.planWrite("x").bufferVersion, 0);
    assert.equal(file.planReplace({ mode: "string", text: "two" }, "2").bufferVersion, 0);
    assert.equal(file.planApply([{ kind: "write", content: "x" }]).bufferVersion, 0);
    assert.equal(file.snapshot().bufferVersion, 0);

    assert.equal(file.write("ONE\ntwo\n").bufferVersion, 1);
    assert.equal(file.replace({ mode: "string", text: "two" }, "TWO").bufferVersion, 2);
    assert.equal(file.apply([{ kind: "replace", target: { mode: "string", text: "ONE" }, replacement: "one" }]).bufferVersion, 3);
    const flushed = file.flush();
    assert.equal(flushed.bufferVersion, 3);
    assert.equal(flushed.dirty, false);
    assert.equal(file.reload().bufferVersion, 4);
});

// ---------------------------------------------------------------------------
// 6. Lifecycle
// ---------------------------------------------------------------------------

test("boundary(lifecycle): a read-only mount refuses every mutating text API with read_only", () => {
    const { file } = memoryFixture("alpha\n", { mode: "read-only" });
    assert.equal(file.mode, "read-only");
    assert.equal(file.snapshot().mode, "read-only");
    assert.equal(file.snapshot().lease, undefined);
    assert.equal(file.read(), "alpha\n");

    expectCode(() => file.write("beta\n"), "read_only");
    expectCode(() => file.replace({ mode: "string", text: "alpha" }, "beta"), "read_only");
    expectCode(() => file.apply([{ kind: "write", content: "beta\n" }]), "read_only");
    expectCode(() => file.flush(), "read_only");
    expectCode(() => file.writeBytes(Uint8Array.from([1])), "invalid_target");
    assert.equal(file.read(), "alpha\n");
    file.unmount();
    assert.equal(file.state, "unmounted");
});

test("boundary(lifecycle): every operation after unmount fails with not_mounted", () => {
    const { file } = memoryFixture("alpha\n");
    file.unmount();
    const snapshot = file.snapshot();
    assert.equal(snapshot.state, "unmounted");
    assert.equal(snapshot.baseHash, "");
    assert.equal(snapshot.baseVersion, -1);
    assert.equal(snapshot.version, -1);
    assert.equal(snapshot.size, 0);
    assert.equal(snapshot.bufferVersion, 0);

    const actions: ReadonlyArray<readonly [string, () => unknown]> = [
        ["read", () => file.read()],
        ["write", () => file.write("x")],
        ["replace", () => file.replace({ mode: "string", text: "alpha" }, "x")],
        ["apply", () => file.apply([{ kind: "write", content: "x" }])],
        ["flush", () => file.flush()],
        ["reload", () => file.reload()],
        ["readLines", () => file.readLines(0)],
        ["locate", () => file.locate({ mode: "string", text: "alpha" })],
        ["outline", () => file.outline()],
        ["readBytes", () => file.readBytes()],
        ["writeBytes", () => file.writeBytes(Uint8Array.from([1]))],
        ["diff", () => file.diff()],
        ["documentOutline", () => file.documentOutline()],
        ["planWrite", () => file.planWrite("x")],
        ["planReplace", () => file.planReplace({ mode: "string", text: "alpha" }, "x")],
        ["planApply", () => file.planApply([{ kind: "write", content: "x" }])],
        ["activate", () => file.activate()],
        ["unmount", () => file.unmount()],
    ];
    for (const [name, action] of actions) expectCode(action, "not_mounted", name);
});

test("boundary(lifecycle): mount() is two-phase while Workspace.mount() activates", () => {
    const storage = new InMemoryFileStorage();
    storage.put({ ...scope, path: "notes.txt" }, "base\n");
    const workspace = new Workspace({ ...scope, storage });
    const file = workspace.file("notes.txt", { mode: "writable", owner: "agent" });
    assert.equal(file.state, "unmounted");
    expectCode(() => file.read(), "not_mounted");

    const mounted = file.mount();
    assert.equal(mounted.state, "mounted");
    expectCode(() => file.read(), "not_mounted");
    const active = file.activate();
    assert.equal(active.state, "active");
    assert.equal(file.read(), "base\n");
    expectCode(() => file.activate(), "not_mounted");
    expectCode(() => file.mount(), "already_mounted");

    assert.equal(memoryFixture("auto\n").file.state, "active", "Workspace.mount already activates");
});

test("boundary(lifecycle): a dirty buffer blocks unmount and reload until discardDirty", () => {
    const { storage, file, workspace } = memoryFixture("base\n");
    file.write("dirty\n");
    expectCode(() => file.unmount(), "dirty");
    expectCode(() => file.reload(), "dirty");
    assert.equal(file.read(), "dirty\n");

    storage.put({ ...scope, path: "notes.txt" }, "theirs\n");
    const conflict = file.conflict();
    assert.equal(conflict?.base.content, "base\n");
    assert.equal(conflict?.ours, "dirty\n");
    assert.equal(conflict?.theirs.content, "theirs\n");
    expectCode(() => file.read(), "stale");
    assert.equal(file.read(undefined, { allowStale: true }), "dirty\n");
    expectCode(() => file.flush(), "stale");
    assert.equal(file.dirty, true);

    file.unmount({ discardDirty: true });
    assert.equal(file.state, "unmounted");
    const fresh = workspace.mount("notes.txt", { mode: "writable", owner: "agent" });
    assert.equal(fresh.read(), "theirs\n");
    fresh.write("discarded\n");
    const reloaded = fresh.reload({ discardDirty: true });
    assert.equal(reloaded.bufferVersion, 2);
    assert.equal(reloaded.dirty, false);
    assert.equal(fresh.read(), "theirs\n");
});

test("boundary(lifecycle): reload after a clean external change refreshes the committed base", () => {
    const { storage, file } = memoryFixture("base\n");
    assert.equal(file.snapshot().bufferVersion, 0);
    storage.put({ ...scope, path: "notes.txt" }, "external\n");
    const snapshot = file.reload();
    assert.equal(snapshot.bufferVersion, 1);
    assert.equal(snapshot.dirty, false);
    assert.equal(snapshot.baseVersion, storage.read({ ...scope, path: "notes.txt" })?.version);
    assert.equal(file.read(), "external\n");
});

test("boundary(lifecycle): a writable mount whose lease was released fails flush with fence_rejected", () => {
    const { storage, file } = memoryFixture("base\n");
    const lease = file.snapshot().lease;
    assert.ok(lease);
    storage.releaseLease(lease);
    file.write("x\n");
    expectCode(() => file.flush(), "fence_rejected");
    assert.equal(file.dirty, true);
    assert.equal(file.read(), "x\n");
});

test("boundary(lifecycle): idempotent flush replays are no-ops, a stale key is ignored and a new key commits", () => {
    const { storage, file } = memoryFixture("base\n");
    const stored = (): string | undefined => storage.read({ ...scope, path: "notes.txt" })?.content;
    file.write("one\n");
    const first = file.flush({ idempotencyKey: "k1" });
    assert.equal(first.version, 1);
    assert.equal(first.dirty, false);
    assert.equal(stored(), "one\n");

    const replay = file.flush({ idempotencyKey: "k1" });
    assert.equal(replay.version, 1, "replaying a successful key must not commit again");
    assert.equal(stored(), "one\n");

    file.write("two\n");
    const staleKey = file.flush({ idempotencyKey: "k1" });
    assert.equal(staleKey.version, 1, "a stale key must not publish a new payload");
    assert.equal(staleKey.dirty, true);
    assert.equal(file.read(), "two\n");
    assert.equal(stored(), "one\n");

    const freshKey = file.flush({ idempotencyKey: "k2" });
    assert.equal(freshKey.version, 2);
    assert.equal(freshKey.dirty, false);
    assert.equal(stored(), "two\n");
    assert.equal(file.flush().version, 2, "a clean flush without a key is a no-op");
});

test("boundary(lifecycle): unmount clears the mount state and the same object can mount again", () => {
    const { file } = memoryFixture("base\n");
    file.write("dirty\n");
    file.unmount({ discardDirty: true });
    assert.equal(file.state, "unmounted");

    const mounted = file.mount();
    assert.equal(mounted.state, "mounted");
    assert.equal(mounted.bufferVersion, 0);
    const active = file.activate();
    assert.equal(active.state, "active");
    assert.equal(active.dirty, false);
    assert.equal(file.read(), "base\n");
    assert.equal(file.snapshot().version >= 0, true);
});

// ---------------------------------------------------------------------------
// 7. Storage boundaries
// ---------------------------------------------------------------------------

test("boundary(storage): InMemoryFileStorage validates paths, byte arguments and leases", () => {
    const storage = new InMemoryFileStorage();
    const ref = (path: string): FileRef => ({ ...scope, path });
    for (const path of INVALID_PATHS) {
        assert.throws(() => storage.read(ref(path)), code("invalid_path"), `read(${JSON.stringify(path)})`);
        assert.throws(() => storage.readBytes(ref(path)), code("invalid_path"), `readBytes(${JSON.stringify(path)})`);
        assert.throws(() => storage.put(ref(path), "x"), code("invalid_path"), `put(${JSON.stringify(path)})`);
        assert.throws(() => storage.compareAndSwap(ref(path), "hash", "x", 1), code("invalid_path"), `compareAndSwap(${JSON.stringify(path)})`);
        assert.throws(() => storage.acquireLease(ref(path), "owner"), code("invalid_path"), `acquireLease(${JSON.stringify(path)})`);
    }
    assert.throws(() => storage.putBytes(ref("ok.txt"), "not-bytes" as unknown as Uint8Array), TypeError);
    assert.throws(() => storage.compareAndSwapBytes(ref("ok.txt"), "hash", "not-bytes" as unknown as Uint8Array, 1), TypeError);

    const seeded = new InMemoryFileStorage();
    seeded.put(ref("file.txt"), "x");
    expectCode(() => seeded.acquireLease(ref("file.txt"), ""), "invalid_scope");
    for (const ttl of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
        expectCode(() => seeded.acquireLease(ref("file.txt"), "agent", ttl), "invalid_scope");
    }
    assert.equal(seeded.read(ref("missing.txt")), undefined);
    assert.equal(seeded.readBytes(ref("missing.txt")), undefined);
});

test("boundary(storage): NodeFileStorage rejects invalid roots and maxFileBytes values", (t) => {
    const root = tempRoot(t);
    assert.throws(() => new NodeFileStorage({ root: "" }), TypeError);
    assert.throws(() => new NodeFileStorage({ root: "   " }), TypeError);
    assert.throws(() => new NodeFileStorage({ root, maxFileBytes: 0 }), TypeError);
    assert.throws(() => new NodeFileStorage({ root, maxFileBytes: -1 }), TypeError);
    assert.throws(() => new NodeFileStorage({ root, maxFileBytes: 1.5 }), TypeError);
    assert.throws(() => new NodeFileStorage({ root, maxFileBytes: Number.NaN }), TypeError);
});

test("boundary(storage): NodeFileStorage enforces maxFileBytes when reading, counting a BOM", (t) => {
    const fixture = nodeFixture(t, { "exact.txt": "12345678", "over.txt": "123456789" }, { maxFileBytes: 8 });
    assert.equal(fixture.storage.read({ ...scope, path: "exact.txt" })?.size, 8, "size == limit is allowed");
    expectCode(() => fixture.storage.read({ ...scope, path: "over.txt" }), "file_too_large");
    expectCode(() => fixture.storage.readBytes({ ...scope, path: "over.txt" }), "file_too_large");

    const tight = nodeFixture(t, { "bom.txt": Uint8Array.from([0xef, 0xbb, 0xbf]) }, { maxFileBytes: 2 });
    expectCode(() => tight.storage.read({ ...scope, path: "bom.txt" }), "file_too_large");
    expectCode(() => tight.storage.readBytes({ ...scope, path: "bom.txt" }), "file_too_large");
});

test("boundary(storage): NodeFileStorage enforces maxFileBytes when committing and preserves disk", (t) => {
    const fixture = nodeFixture(t, { "four.txt": "abcd" }, { maxFileBytes: 8 });
    const file = fixture.workspace.mount("four.txt", { mode: "writable", owner: "agent" });
    file.write("abcdefgh");
    const exact = file.flush();
    assert.equal(exact.size, 8);
    assert.equal(readFileSync(fixture.absolute("four.txt"), "utf8"), "abcdefgh");

    file.write("abcdefghi");
    expectCode(() => file.flush(), "file_too_large");
    assert.equal(readFileSync(fixture.absolute("four.txt"), "utf8"), "abcdefgh", "a refused commit must not replace the file");
    assert.equal(file.dirty, true);
    assert.equal(file.read(), "abcdefghi");

    const syncStore = new NodeFileStorage({ root: fixture.root });
    writeFileSync(fixture.absolute("sync.txt"), "a\n");
    const synced = new Workspace({ ...scope, storage: syncStore }).mount("sync.txt", { mode: "writable", owner: "agent" });
    synced.write("b\n");
    synced.flush();
    assert.equal(readFileSync(fixture.absolute("sync.txt"), "utf8"), "b\n", "fsync:true default commits");
});

test("boundary(storage): empty, single-byte and 1 MiB files round-trip through both adapters", (t) => {
    const memory = new InMemoryFileStorage();
    const memoryRef = (path: string): FileRef => ({ ...scope, path });
    const memoryWorkspace = new Workspace({ ...scope, storage: memory });

    memory.put(memoryRef("empty.txt"), "");
    const empty = memoryWorkspace.mount("empty.txt", { mode: "writable", owner: "agent" });
    assert.equal(empty.snapshot().size, 0);
    assert.equal(empty.read(), "");
    assert.equal(empty.readLines(0, 1).totalLines, 1);
    empty.write("x");
    empty.flush();
    assert.equal(memory.read(memoryRef("empty.txt"))?.content, "x");

    memory.put(memoryRef("one.txt"), "y");
    const single = memoryWorkspace.mount("one.txt", { mode: "writable", owner: "agent" });
    assert.equal(single.snapshot().size, 1);
    assert.equal(single.read(), "y");
    single.replace({ mode: "string", text: "y" }, "Y");
    single.flush();
    assert.equal(memory.read(memoryRef("one.txt"))?.content, "Y");

    const megabyte = "x".repeat(1024 * 1024);
    memory.put(memoryRef("big.txt"), megabyte);
    const big = memoryWorkspace.mount("big.txt", { mode: "writable", owner: "agent" });
    assert.equal(big.snapshot().size, 1024 * 1024);
    assert.equal(big.read().length, 1024 * 1024);
    expectCode(() => big.replace({ mode: "string", text: "x", all: true }, "y"), "invalid_target");
    big.write("Y", { mode: "byte", start: 0, end: 1 });
    big.flush();
    const memoryBig = memory.read(memoryRef("big.txt"));
    assert.equal(memoryBig?.content.length, 1024 * 1024);
    assert.equal(memoryBig?.content.startsWith("Y"), true);

    const fixture = nodeFixture(t, { "empty.txt": "", "one.txt": "y", "big.txt": megabyte });
    const nodeEmpty = fixture.workspace.mount("empty.txt", { mode: "writable", owner: "agent" });
    assert.equal(nodeEmpty.snapshot().size, 0);
    assert.equal(nodeEmpty.read(), "");
    nodeEmpty.write("x");
    nodeEmpty.flush();
    assert.equal(readFileSync(fixture.absolute("empty.txt"), "utf8"), "x");

    const nodeSingle = fixture.workspace.mount("one.txt", { mode: "writable", owner: "agent" });
    assert.equal(nodeSingle.snapshot().size, 1);
    nodeSingle.replace({ mode: "string", text: "y" }, "Y");
    nodeSingle.flush();
    assert.equal(readFileSync(fixture.absolute("one.txt"), "utf8"), "Y");

    const nodeBig = fixture.workspace.mount("big.txt", { mode: "writable", owner: "agent" });
    assert.equal(nodeBig.snapshot().size, 1024 * 1024);
    nodeBig.write("Y", { mode: "byte", start: 0, end: 1 });
    nodeBig.flush();
    const onDisk = readFileSync(fixture.absolute("big.txt"));
    assert.equal(onDisk.length, 1024 * 1024);
    assert.equal(onDisk.toString("utf8").startsWith("Y"), true);
});

interface StorageHarness {
    readonly label: string;
    readonly storage: FileStoragePort;
    readonly ref: (path: string) => FileRef;
    readonly seed: (path: string, text: string) => void;
    readonly externalWrite: (path: string, text: string) => void;
}

function memoryHarness(): StorageHarness {
    const storage = new InMemoryFileStorage();
    return {
        label: "InMemoryFileStorage",
        storage,
        ref: path => ({ ...scope, path }),
        seed: (path, text) => { storage.put({ ...scope, path }, text); },
        externalWrite: (path, text) => { storage.put({ ...scope, path }, text); },
    };
}

function nodeHarness(t: Cleanup): StorageHarness {
    const root = tempRoot(t);
    const storage = new NodeFileStorage({ root, fsync: false });
    const write = (path: string, text: string): void => { writeFileSync(join(root, path), text, "utf8"); };
    return {
        label: "NodeFileStorage",
        storage,
        ref: path => ({ ...scope, path }),
        seed: write,
        externalWrite: write,
    };
}

/** One operation script so both adapters are exercised by exactly the same expectations. */
function exerciseStorage(harness: StorageHarness): void {
    const storage = harness.storage;
    const ref = harness.ref("data.txt");
    assert.equal(storage.read(ref), undefined, `${harness.label}: missing read`);
    assert.deepEqual([...(storage.readBytes?.(ref)?.bytes ?? [])], [], `${harness.label}: missing readBytes`);

    harness.seed("data.txt", "alpha\nbeta\n");
    const initial = storage.read(ref);
    assert.ok(initial, `${harness.label}: seeded read`);
    assert.equal(initial.content, "alpha\nbeta\n");
    assert.equal(initial.size, 11);
    assert.deepEqual([...(storage.readBytes?.(ref)?.bytes ?? [])], [...new TextEncoder().encode("alpha\nbeta\n")]);

    const lease = storage.acquireLease(ref, "writer");
    assert.equal(lease.owner, "writer");
    assert.equal(lease.fence > 0, true);
    expectCode(() => storage.acquireLease(ref, "intruder"), "fence_rejected");
    expectCode(() => storage.compareAndSwap(ref, "sha256:not-the-hash", "nope\n", lease.fence), "version_conflict");
    expectCode(() => storage.compareAndSwap(ref, initial.hash, "nope\n", lease.fence + 1), "fence_rejected");

    const committed = storage.compareAndSwap(ref, initial.hash, "alpha\nBETA\n", lease.fence);
    assert.equal(committed.content, "alpha\nBETA\n");
    assert.equal(storage.read(ref)?.content, "alpha\nBETA\n");
    assert.deepEqual([...(storage.readBytes?.(ref)?.bytes ?? [])], [...new TextEncoder().encode("alpha\nBETA\n")]);

    harness.externalWrite("data.txt", "external\n");
    expectCode(() => storage.compareAndSwap(ref, committed.hash, "nope\n", lease.fence), "version_conflict");
    storage.releaseLease(lease);

    const second = storage.acquireLease(ref, "second");
    assert.equal(second.fence, lease.fence + 1);
    const current = storage.readBytes?.(ref);
    assert.ok(current);
    const casBytes = storage.compareAndSwapBytes;
    assert.ok(casBytes);
    const bytesCommitted = casBytes.call(storage, ref, current.hash, Uint8Array.from([0x01, 0x02, 0x03]), second.fence);
    assert.equal(bytesCommitted.size, 3);
    assert.deepEqual([...(storage.readBytes?.(ref)?.bytes ?? [])], [0x01, 0x02, 0x03]);
    storage.releaseLease(second);
}

test("boundary(storage): both adapters behave identically for the same operation script", (t) => {
    exerciseStorage(memoryHarness());
    exerciseStorage(nodeHarness(t));
});

test("boundary(storage): NodeFileStorage returns undefined for missing files/directories and refuses text reads of bytes", (t) => {
    const fixture = nodeFixture(t, { "image.bin": Uint8Array.from([0x61, 0x00, 0x62]) });
    assert.equal(fixture.storage.read({ ...scope, path: "missing.txt" }), undefined);
    assert.equal(fixture.storage.readBytes({ ...scope, path: "missing.txt" }), undefined);
    mkdirSync(join(fixture.root, "dir"));
    assert.equal(fixture.storage.read({ ...scope, path: "dir" }), undefined);
    assert.equal(fixture.storage.readBytes({ ...scope, path: "dir" }), undefined);
    expectCode(() => fixture.workspace.mount("dir"), "not_found");

    expectCode(() => fixture.storage.read({ ...scope, path: "image.bin" }), "binary_file");
    assert.deepEqual([...(fixture.storage.readBytes({ ...scope, path: "image.bin" })?.bytes ?? [])], [0x61, 0x00, 0x62]);
    expectCode(() => fixture.storage.read({ ...scope, path: "absent/nested.txt" }), "not_found");
});

test("boundary(storage): acquiring a lease for a missing file should fail consistently", (t) => {
    const memory = new InMemoryFileStorage();
    expectCode(() => memory.acquireLease({ ...scope, path: "ghost.txt" }, "owner"), "not_found");
    const fixture = nodeFixture(t, {});
    expectCode(() => fixture.storage.acquireLease({ ...scope, path: "ghost.txt" }, "owner"), "not_found");
});

test("boundary(storage): a text commit clears the byte view of a previously byte-stored file", () => {
    const storage = new InMemoryFileStorage();
    const ref = { ...scope, path: "mixed.bin" };
    storage.putBytes(ref, Uint8Array.from([0x01, 0x02]));
    const lease = storage.acquireLease(ref, "agent");
    const bytes = storage.readBytes(ref);
    assert.ok(bytes);
    storage.compareAndSwap(ref, bytes.hash, "text\n", lease.fence);
    assert.equal(storage.read(ref)?.content, "text\n");
    assert.deepEqual([...(storage.readBytes(ref)?.bytes ?? [])], [...new TextEncoder().encode("text\n")]);
    storage.releaseLease(lease);

    const putRef = { ...scope, path: "put.bin" };
    storage.putBytes(putRef, Uint8Array.from([0x03]));
    storage.put(putRef, "put text\n");
    assert.equal(storage.read(putRef)?.content, "put text\n");
    assert.deepEqual([...(storage.readBytes(putRef)?.bytes ?? [])], [...new TextEncoder().encode("put text\n")]);
});

// ---------------------------------------------------------------------------
// 8. Binary / text switching
// ---------------------------------------------------------------------------

test("boundary(binary): a NUL-containing file auto-mounts as bytes and rejects every text API", (t) => {
    const fixture = nodeFixture(t, { "image.bin": Uint8Array.from([0x61, 0x00, 0x62]) });
    const file = fixture.workspace.mount("image.bin", { mode: "writable", owner: "agent" });
    const snapshot = file.snapshot();
    assert.equal(snapshot.binary, true);
    assert.equal(snapshot.encoding, "utf-8", "binary mounts keep default charset facts");
    assert.equal(snapshot.bom, false);
    assert.equal(snapshot.eol, "\n");
    assert.equal(snapshot.size, 3);
    assert.equal(snapshot.baseHash.length > 0, true);
    assert.deepEqual([...file.readBytes()], [0x61, 0x00, 0x62]);

    const actions: ReadonlyArray<readonly [string, () => unknown]> = [
        ["read", () => file.read()],
        ["write", () => file.write("x")],
        ["replace", () => file.replace({ mode: "string", text: "a" }, "b")],
        ["apply", () => file.apply([{ kind: "write", content: "x" }])],
        ["planWrite", () => file.planWrite("x")],
        ["locate", () => file.locate({ mode: "string", text: "a" })],
        ["outline", () => file.outline()],
        ["readLines", () => file.readLines(0)],
        ["diff", () => file.diff()],
    ];
    for (const [name, action] of actions) expectCode(action, "invalid_target", name);

    expectCode(() => file.readBytes({ start: -1, end: 0 }), "invalid_range");
    expectCode(() => file.readBytes({ start: 0, end: 4 }), "invalid_range");
    assert.throws(() => file.documentOutline(), (error: unknown) => error instanceof DocumentError);
});

test("boundary(binary): writeBytes + flush round-trips opaque bytes and refreshes the base", (t) => {
    const fixture = nodeFixture(t, { "image.bin": Uint8Array.from([0x61, 0x00, 0x62]) });
    const file = fixture.workspace.mount("image.bin", { mode: "writable", owner: "agent" });
    const before = file.snapshot();
    const dirty = file.writeBytes(Uint8Array.from([0x78, 0x00, 0x79]));
    assert.equal(dirty.binary, true);
    assert.equal(dirty.bufferVersion, before.bufferVersion + 1);
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.state, "dirty");
    assert.deepEqual([...file.readBytes()], [0x78, 0x00, 0x79]);

    const flushed = file.flush();
    assert.equal(flushed.dirty, false);
    assert.equal(flushed.state, "active");
    assert.equal(flushed.baseVersion, flushed.version);
    assert.deepEqual([...readFileSync(fixture.absolute("image.bin"))], [0x78, 0x00, 0x79]);
    assert.deepEqual([...file.readBytes()], [0x78, 0x00, 0x79]);

    const remounted = fixture.workspace.mount("image.bin");
    assert.equal(remounted.snapshot().binary, true);
    assert.deepEqual([...remounted.readBytes()], [0x78, 0x00, 0x79]);

    file.writeBytes(Uint8Array.from([0x01, 0x02, 0x03]));
    writeFileSync(fixture.absolute("image.bin"), Uint8Array.from([0x09, 0x09]));
    expectCode(() => file.flush(), "stale");
    const conflict = file.conflict();
    assert.equal(conflict?.ours, "");
    assert.equal(conflict?.theirs.size, 2);
    const reloaded = file.reload({ discardDirty: true });
    assert.equal(reloaded.dirty, false);
    assert.deepEqual([...file.readBytes()], [0x09, 0x09]);
});

test("boundary(binary): binary:true mounts text as bytes, binary:false rejects a NUL file and missing files stay not_found", (t) => {
    const fixture = nodeFixture(t, { "text.txt": "hello\n", "image.bin": Uint8Array.from([0x61, 0x00, 0x62]) });
    const bytesView = fixture.workspace.mount("text.txt", { binary: true });
    assert.equal(bytesView.snapshot().binary, true);
    expectCode(() => bytesView.read(), "invalid_target");
    assert.deepEqual([...bytesView.readBytes()], [...new TextEncoder().encode("hello\n")]);

    expectCode(() => fixture.workspace.mount("image.bin", { binary: false }), "binary_file");
    expectCode(() => fixture.workspace.mount("missing.bin", { binary: true }), "not_found");

    const memory = new InMemoryFileStorage();
    const ref = { ...scope, path: "blob.bin" };
    memory.putBytes(ref, Uint8Array.from([0x01, 0x02]));
    expectCode(() => memory.read(ref), "binary_file");
    const auto = new Workspace({ ...scope, storage: memory }).mount("blob.bin");
    assert.equal(auto.snapshot().binary, true);
    assert.deepEqual([...auto.readBytes()], [0x01, 0x02]);
});

test("boundary(binary): a .docx extension with plain-text content is mounted as text", (t) => {
    const fixture = nodeFixture(t, { "plain.docx": "just text\n" });
    const file = fixture.workspace.mount("plain.docx");
    assert.equal(file.snapshot().binary, false, "detection is content-driven, not extension-driven");
    assert.equal(file.snapshot().encoding, "utf-8");
    assert.equal(file.snapshot().size, 10);
    assert.equal(file.read(), "just text\n");
    assert.throws(() => file.documentOutline(), (error: unknown) => error instanceof DocumentError && error.code === "invalid_zip");
});

// ---------------------------------------------------------------------------
// 9. Direct edit-module boundaries
// ---------------------------------------------------------------------------

test("boundary(edit): resolveRegions and byteToCharIndex enforce bounds and UTF-8 code point boundaries", () => {
    const resolve = (content: string, target: ReplaceTarget) => resolveRegions(content, target, undefined, "edit.txt");
    expectCode(() => resolve("a\nb", { mode: "line", start: 0, end: 9 }), "invalid_range");
    expectCode(() => resolve("a\nb", { mode: "line", start: 1, end: 0 }), "invalid_range");
    assert.deepEqual(resolve("a\nb", { mode: "line", start: 0, end: 0 }), [{ start: 0, end: 0, text: "" }]);
    expectCode(() => resolve("a😀b", { mode: "byte", start: 2, end: 4 }), "invalid_range");
    assert.deepEqual(resolve("a😀b", { mode: "byte", start: 1, end: 5 }), [{ start: 1, end: 3, text: "😀" }]);
    expectCode(() => resolve("abc", { mode: "nope" } as unknown as ReplaceTarget), "invalid_target");
    expectCode(() => resolve("abc", null as unknown as ReplaceTarget), "invalid_target");
    expectCode(() => resolve("abc", { kind: "line", start: 0, end: 1 } as unknown as ReplaceTarget), "invalid_target");

    assert.equal(byteToCharIndex("abc", 0), 0);
    assert.equal(byteToCharIndex("abc", 3), 3);
    assert.equal(byteToCharIndex("😀", 0), 0);
    assert.equal(byteToCharIndex("😀", 4), 2);
    assert.equal(byteToCharIndex("a😀b", 5), 3);
    for (const offset of [-1, 1.5, Number.NaN, 4]) expectCode(() => byteToCharIndex("abc", offset), "invalid_range");
    expectCode(() => byteToCharIndex("😀", 2), "invalid_range");
});

test("boundary(edit): selectRegions enforces uniqueness, occurrence and all", () => {
    const first = { start: 0, end: 1, text: "a" };
    const second = { start: 2, end: 3, text: "a" };
    assert.deepEqual(selectRegions("aba", [first], { mode: "string", text: "a" }), [first]);
    expectCode(() => selectRegions("aba", [], { mode: "string", text: "a" }), "no_match");
    expectCode(() => selectRegions("aba", [first, second], { mode: "string", text: "a" }), "ambiguous_match");
    assert.equal(selectRegions("aba", [first, second], { mode: "string", text: "a", all: true }).length, 2);
    assert.deepEqual(selectRegions("aba", [first, second], { mode: "string", text: "a", occurrence: 2 }), [second]);
    expectCode(() => selectRegions("aba", [first], { mode: "string", text: "a", occurrence: 0 }), "invalid_target");
    expectCode(() => selectRegions("aba", [first], { mode: "string", text: "a", occurrence: 2 }), "no_match");
    expectCode(() => selectRegions("aba", [first], { mode: "string", text: "a", all: true, occurrence: 1 }), "invalid_target");
});

test("boundary(edit): unifiedDiff returns empty for equal text and emits bounded context hunks", () => {
    assert.equal(unifiedDiff("a\n", "a\n"), "");
    assert.equal(unifiedDiff("a\nb\n", "a\nB\n"), "--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n ");
    assert.equal(unifiedDiff("a\n", "a\nb\n"), "--- a\n+++ b\n@@ -1,2 +1,3 @@\n a\n+b\n ");
    assert.equal(unifiedDiff("a\nb\n", "a\n"), "--- a\n+++ b\n@@ -1,3 +1,2 @@\n a\n-b\n ");
    assert.equal(unifiedDiff("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nd\nE\nf\ng\nh\n"),
        "--- a\n+++ b\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h");
    assert.equal(unifiedDiff("x", "y", "before.txt", "after.txt"),
        "--- before.txt\n+++ after.txt\n@@ -1,1 +1,1 @@\n-x\n+y");
});
