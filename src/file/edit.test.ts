import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryFileStorage } from "./core.ts";
import { createOutlineProvider } from "./outline.ts";
import { Workspace } from "../workspace/core.ts";
import { WorkspaceError } from "../workspace/types.ts";
import type { WorkspaceMode } from "./types.ts";

function fixture(content: string, mode: WorkspaceMode = "writable", path = "notes.md") {
    const storage = new InMemoryFileStorage();
    storage.put({ tenantId: "t", rootId: "r", path }, content);
    const file = new Workspace({ tenantId: "t", rootId: "r", storage }).mount(path, {
        mode, owner: "agent", outline: createOutlineProvider(),
    });
    const read = (): string => file.read();
    return { storage, file, read };
}

function code(code: WorkspaceError["code"]) {
    return (error: unknown): boolean => error instanceof WorkspaceError && error.code === code;
}

test("whole-buffer write keeps the legacy signature and marks the buffer dirty", () => {
    const { file, read } = fixture("original\n");
    const snapshot = file.write("replaced\n");
    assert.equal(read(), "replaced\n");
    assert.equal(snapshot.dirty, true);
    assert.equal(snapshot.bufferVersion, 1);
});

test("line write replaces whole lines and preserves the trailing newline", () => {
    const { file, read } = fixture("one\ntwo\nthree\n");
    file.write("TWO", { mode: "line", start: 1, end: 2 });
    assert.equal(read(), "one\nTWO\nthree\n");
    file.write("TWO\nTHREE", { mode: "line", start: 1, end: 3 });
    assert.equal(read(), "one\nTWO\nTHREE\n");
    assert.throws(() => file.write("x", { mode: "line", start: 2, end: 1 }), code("invalid_range"));
    assert.throws(() => file.write("x", { mode: "line", start: 0, end: 99 }), code("invalid_range"));
});

test("legacy FileRange targets still route through the new line and byte paths", () => {
    const { file, read } = fixture("a\nb\nc\n");
    file.write("B", { kind: "line", start: 1, end: 2 });
    assert.equal(read(), "a\nB\nc\n");
    file.write("X", { byte: { start: 0, end: 1 } });
    assert.equal(read(), "X\nB\nc\n");
});

test("byte write uses UTF-8 offsets and rejects offsets inside a code point", () => {
    const { file, read } = fixture("a😀b\n");
    file.write("X", { mode: "byte", start: 1, end: 5 });
    assert.equal(read(), "aXb\n");
    const { file: emoji } = fixture("a😀b\n");
    assert.throws(() => emoji.write("Y", { mode: "byte", start: 2, end: 4 }), code("invalid_range"));
    assert.throws(() => emoji.write("Y", { mode: "byte", start: 0, end: 99 }), code("invalid_range"));
    const { file: chinese, read: readChinese } = fixture("中文\n");
    chinese.write("日", { mode: "byte", start: 0, end: 3 });
    assert.equal(readChinese(), "日文\n");
});

test("outline write replaces exactly the addressed node and requires a provider", () => {
    const source = "# Title\n\nintro\n\n## Section\n\nbody\n";
    const { file, read } = fixture(source);
    const entries = file.outline();
    assert.deepEqual(entries.map(entry => entry.name), ["Title", "Section"]);
    const section = entries.find(entry => entry.name === "Section")!;
    file.write("## Section\n\nreplaced\n", { mode: "outline", id: section.id });
    assert.equal(read(), "# Title\n\nintro\n\n## Section\n\nreplaced\n");
    assert.throws(() => file.write("x", { mode: "outline", id: "missing" }), code("not_found"));

    const storage = new InMemoryFileStorage();
    storage.put({ tenantId: "t", rootId: "r", path: "notes.md" }, source);
    const plain = new Workspace({ tenantId: "t", rootId: "r", storage }).mount("notes.md", { mode: "writable" });
    assert.throws(() => plain.write("x", { mode: "outline", id: "any" }), code("outline_unavailable"));
    assert.throws(() => plain.outline(), code("outline_unavailable"));
});

test("string replace is literal and requires an unambiguous target", () => {
    const { file, read } = fixture("const a = 1;\nconst b = 1;\n");
    assert.throws(() => file.replace({ mode: "string", text: "1" }, "2"), code("ambiguous_match"));
    file.replace({ mode: "string", text: "1", occurrence: 1 }, "2");
    assert.equal(read(), "const a = 2;\nconst b = 1;\n");
    file.replace({ mode: "string", text: "1", all: true }, "$&");
    assert.equal(read(), "const a = 2;\nconst b = $&;\n");
    assert.throws(() => file.replace({ mode: "string", text: "absent" }, "x"), code("no_match"));
    assert.throws(() => file.replace({ mode: "string", text: "" }, "x"), code("invalid_target"));
    assert.throws(() => file.replace({ mode: "string", text: "2", occurrence: 9 }, "x"), code("no_match"));
    assert.throws(() => file.replace({ mode: "string", text: "2", occurrence: 1, all: true }, "x"), code("invalid_target"));
});

test("regex replace validates flags and expands groups", () => {
    const { file, read } = fixture("const a = 1;\nconst b = 2;\n");
    file.replace({ mode: "regex", pattern: "const (\\w+) = (\\d+);", all: true }, "let $1 = $2;");
    assert.equal(read(), "let a = 1;\nlet b = 2;\n");
    file.replace({ mode: "regex", pattern: "let (?<name>\\w+)", occurrence: 2 }, "var $<name>");
    assert.equal(read(), "let a = 1;\nvar b = 2;\n");
    assert.throws(() => file.replace({ mode: "regex", pattern: "x*" }, "y"), code("invalid_target"));
    assert.throws(() => file.replace({ mode: "regex", pattern: "(" }, "y"), code("invalid_target"));
    assert.throws(() => file.replace({ mode: "regex", pattern: "a", flags: "g" }, "y"), code("invalid_target"));
    const { file: missing } = fixture("const a = 1;\n");
    assert.throws(() => missing.replace({ mode: "regex", pattern: "absent" }, "y"), code("no_match"));
    const { file: sensitive } = fixture("A a\n");
    sensitive.replace({ mode: "regex", pattern: "A", flags: "i", occurrence: 1 }, "z");
    assert.equal(sensitive.read(), "z a\n");
    assert.throws(() => sensitive.replace({ mode: "regex", pattern: "z|a", flags: "i" }, "q"), code("ambiguous_match"));
});

test("replace supports line, byte and outline targets", () => {
    const { file, read } = fixture("one\ntwo\nthree\n");
    file.replace({ mode: "line", start: 0, end: 1 }, "ONE");
    assert.equal(read(), "ONE\ntwo\nthree\n");
    file.replace({ mode: "byte", start: 0, end: 3 }, "1");
    assert.equal(read(), "1\ntwo\nthree\n");

    const source = "# Title\n\nintro\n\n## Section\n\nbody\n";
    const { file: outlined, read: readOutlined } = fixture(source);
    const section = outlined.outline().find(entry => entry.name === "Section")!;
    outlined.replace({ mode: "outline", id: section.id }, "## Section\n\nrewritten\n");
    assert.equal(readOutlined(), "# Title\n\nintro\n\n## Section\n\nrewritten\n");
});

test("locate and preview resolve without mutating the buffer", () => {
    const { file, read } = fixture("alpha\nbeta\ngamma\n");
    const matches = file.locate({ mode: "string", text: "a", all: true });
    assert.ok(matches.length >= 3);
    assert.equal(matches[0]!.startLine, 0);
    assert.equal(matches[0]!.text, "a");
    const version = file.snapshot().bufferVersion;
    const plan = file.planReplace({ mode: "line", start: 0, end: 1 }, "ALPHA");
    assert.equal(plan.text, "ALPHA\nbeta\ngamma\n");
    assert.equal(file.snapshot().bufferVersion, version);
    assert.equal(read(), "alpha\nbeta\ngamma\n");
    const writePlan = file.planWrite("X", { mode: "byte", start: 0, end: 5 });
    assert.equal(writePlan.text, "X\nbeta\ngamma\n");
    assert.equal(writePlan.mode, "byte");
    assert.equal(file.snapshot().bufferVersion, version);
    assert.equal(file.planWrite("whole").mode, "file");
});

test("edits are rejected on read-only mounts and on stale bases", () => {
    const readOnly = fixture("alpha\n", "read-only").file;
    assert.throws(() => readOnly.write("beta\n"), code("read_only"));
    assert.throws(() => readOnly.replace({ mode: "string", text: "alpha" }, "beta"), code("read_only"));
    assert.equal(readOnly.locate({ mode: "string", text: "alpha" }).length, 1);

    const { storage, file } = fixture("alpha\n");
    storage.put({ tenantId: "t", rootId: "r", path: "notes.md" }, "host changed\n");
    assert.throws(() => file.write("beta\n"), code("stale"));
    assert.throws(() => file.replace({ mode: "line", start: 0, end: 1 }, "beta"), code("stale"));
});

test("expectedBufferVersion prevents applying an edit to a newer buffer", () => {
    const { file } = fixture("alpha\n");
    const version = file.snapshot().bufferVersion;
    file.write("beta\n", undefined, { expectedBufferVersion: version });
    assert.throws(() => file.write("gamma\n", undefined, { expectedBufferVersion: version }), code("buffer_conflict"));
    assert.throws(() => file.replace({ mode: "string", text: "beta" }, "delta", { expectedBufferVersion: version }), code("buffer_conflict"));
});

test("a flushed outline edit commits through the same CAS path", () => {
    const source = "# Title\n\nintro\n\n## Section\n\nbody\n";
    const { storage, file } = fixture(source);
    const section = file.outline().find(entry => entry.name === "Section")!;
    file.write("## Section\n\nnew body\n", { mode: "outline", id: section.id });
    assert.equal(file.dirty, true);
    file.flush();
    assert.equal(file.dirty, false);
    assert.equal(storage.read({ tenantId: "t", rootId: "r", path: "notes.md" })!.content, "# Title\n\nintro\n\n## Section\n\nnew body\n");
    assert.equal(file.outline().find(entry => entry.name === "Section")!.range.startLine, 4);
});
