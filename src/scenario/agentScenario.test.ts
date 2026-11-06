import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../workspace/core.ts";
import { WorkspaceError } from "../workspace/types.ts";
import { NodeFileStorage } from "../file/node.ts";
import { createOutlineProvider } from "../file/outline.ts";
import { DocumentError } from "../file/document/types.ts";
import { createZip } from "../file/document/testZip.ts";
import { parseDocx } from "../file/document/docx.ts";
import { readArchiveListing } from "../file/document/archive.ts";
import { createProjectFromKind, applyProjectKind } from "../project/kinds/bridge.ts";
import { definition as goKind } from "../project/kinds/go.ts";
import { AgentGateway, GatewayError } from "../agent/gateway.ts";
import { SURFACE_PREFIX } from "../agent/surface.ts";
import type { GatewayCallRecord } from "../agent/gateway.ts";

const scope = { tenantId: "tenant-a", rootId: "root-1" } as const;

const INDEX_SOURCE = `export function greet(name: string): string {
    return \`hello \${name}\`;
}

export function add(a: number, b: number): number {
    return a - b;
}
`;

const LEGACY_SOURCE = "export const legacy = true;\r\nexport const mode = \"compat\";\r\n";

const DOCX = createZip({
    "word/document.xml": `<w:document xmlns:w="w"><w:body>`
        + `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Release notes</w:t></w:r></w:p>`
        + `<w:p><w:r><w:t>Fixed the addition bug.</w:t></w:r></w:p></w:body></w:document>`,
});

function errorCode(code: WorkspaceError["code"]) {
    return (error: unknown): boolean => error instanceof WorkspaceError && error.code === code;
}

function documentCode(code: DocumentError["code"]) {
    return (error: unknown): boolean => error instanceof DocumentError && error.code === code;
}

function gatewayCode(code: GatewayError["code"]) {
    return (error: unknown): boolean => error instanceof GatewayError && error.code === code;
}

test("scenario: an agent fixes a bug through outline lookup, string replace and an idempotent flush", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-fix-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "index.ts"), INDEX_SOURCE);
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }), outline: createOutlineProvider() });
    const file = workspace.mount("index.ts", { mode: "writable", owner: "agent" });

    const symbols = file.outline().map(entry => entry.name);
    assert.deepEqual(symbols, ["greet", "add"]);

    const located = file.locate({ mode: "string", text: "return a - b;" });
    assert.equal(located.length, 1);
    const preview = file.planReplace({ mode: "string", text: "return a - b;" }, "return a + b;");
    assert.equal(preview.changed, true);
    assert.equal(preview.mode, "string");
    file.replace({ mode: "string", text: "return a - b;" }, "return a + b;");
    assert.match(file.diff(), /-    return a - b;/);

    const first = file.flush({ idempotencyKey: "fix-add-1" });
    assert.equal(first.dirty, false);
    assert.equal(first.version >= 0, true);
    assert.equal(readFileSync(join(root, "index.ts"), "utf8").includes("return a + b;"), true);

    const replay = file.flush({ idempotencyKey: "fix-add-1" });
    assert.equal(replay.version, first.version, "replaying the same idempotency key must not commit again");
});

test("scenario: a reused idempotency key never publishes a second, different edit", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-idem-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "index.ts"), INDEX_SOURCE);
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }) });
    const file = workspace.mount("index.ts", { mode: "writable", owner: "agent" });
    file.replace({ mode: "string", text: "return a - b;" }, "return a + b;");
    file.flush({ idempotencyKey: "op-1" });
    const committed = readFileSync(join(root, "index.ts"), "utf8");

    file.replace({ mode: "string", text: "return a + b;" }, "return b + a;");
    file.flush({ idempotencyKey: "op-1" });
    assert.equal(readFileSync(join(root, "index.ts"), "utf8"), committed, "a stale key must not publish a new payload");

    file.flush({ idempotencyKey: "op-2" });
    assert.equal(readFileSync(join(root, "index.ts"), "utf8").includes("return b + a;"), true);
});

test("scenario: an external change is detected as stale before the agent can overwrite it", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-stale-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "index.ts"), INDEX_SOURCE);
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }) });
    const file = workspace.mount("index.ts", { mode: "writable", owner: "agent" });
    file.replace({ mode: "string", text: "return a - b;" }, "return a + b;");
    writeFileSync(join(root, "index.ts"), INDEX_SOURCE.replace("greet", "hello"));
    assert.throws(() => file.flush(), errorCode("stale"));
    assert.equal(readFileSync(join(root, "index.ts"), "utf8").includes("hello"), true);

    file.reload({ discardDirty: true });
    assert.match(file.read(), /export function hello/);
    assert.equal(file.snapshot().dirty, false);
});

test("scenario: a second writer is fenced out while the first holds the lease", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-fence-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "index.ts"), INDEX_SOURCE);
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }) });
    workspace.mount("index.ts", { mode: "writable", owner: "agent" });
    assert.throws(() => workspace.mount("index.ts", { mode: "writable", owner: "other" }), errorCode("fence_rejected"));
});

test("scenario: BOM and CRLF survive a line replacement", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-eol-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(LEGACY_SOURCE)]);
    writeFileSync(join(root, "legacy.ts"), bytes);
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }) });
    const file = workspace.mount("legacy.ts", { mode: "writable", owner: "agent" });
    assert.equal(file.snapshot().bom, true);
    assert.equal(file.snapshot().eol, "\r\n");
    assert.match(file.readLines(0, 1).text, /legacy/);

    file.write("export const legacy = false;", { mode: "line", start: 0, end: 1 });
    file.flush();
    const written = readFileSync(join(root, "legacy.ts"));
    assert.deepEqual([...written.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(written.toString("utf8").includes("legacy = false;\r\n"), true);
});

test("scenario: byte targets reject a range that splits an emoji", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-emoji-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = `const x = "😀";\n`;
    writeFileSync(join(root, "emoji.ts"), source);
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }) });
    const file = workspace.mount("emoji.ts", { mode: "writable", owner: "agent" });
    const start = Buffer.byteLength(`const x = "`, "utf8");
    assert.throws(() => file.write("!", { mode: "byte", start: start + 1, end: start + 3 }), errorCode("invalid_range"));
    file.write("!", { mode: "byte", start, end: start + 4 });
    file.flush();
    assert.equal(readFileSync(join(root, "emoji.ts"), "utf8"), `const x = "!";\n`);
});

test("scenario: a binary document is mounted as bytes and outline-only text APIs are refused", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-docx-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "notes.docx"), DOCX);
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }) });
    const file = workspace.mount("notes.docx", { mode: "writable", owner: "agent" });
    assert.equal(file.snapshot().binary, true);
    const outline = file.documentOutline();
    assert.equal(outline.language, "word");
    assert.equal(outline.entries[0]?.name, "Release notes");
    assert.throws(() => file.read(), errorCode("invalid_target"));
    assert.throws(() => file.write("x"), errorCode("invalid_target"));

    const before = file.readBytes();
    file.writeBytes(before);
    file.flush();
    assert.deepEqual([...readFileSync(join(root, "notes.docx"))], [...before]);
});

test("scenario: corrupted and unsupported documents fail with precise errors", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-bad-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "broken.docx"), DOCX.subarray(0, 60));
    writeFileSync(join(root, "archive.7z"), Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]));
    writeFileSync(join(root, "old.doc"), Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
    writeFileSync(join(root, "doc.pub"), new Uint8Array(64));
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }) });
    const broken = workspace.mount("broken.docx");
    assert.throws(() => broken.documentOutline(), documentCode("invalid_zip"));
    const sevenZip = workspace.mount("archive.7z");
    assert.throws(() => sevenZip.documentOutline(), documentCode("unsupported_format"));
    const word = workspace.mount("old.doc");
    assert.throws(() => word.documentOutline(), documentCode("invalid_document"));
    const publisher = workspace.mount("doc.pub");
    assert.throws(() => publisher.documentOutline(), documentCode("unsupported_format"));
});

test("scenario: archive listing is bounded and drive-by traversal never reaches storage", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-arch-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const archive = createZip({ "src/index.ts": INDEX_SOURCE, "docs/notes.md": "# Notes\n", "assets/logo.bin": "x" });
    writeFileSync(join(root, "bundle.zip"), archive);
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }) });
    const file = workspace.mount("bundle.zip");
    const outline = file.documentOutline();
    assert.equal(outline.language, "compress");
    assert.equal(outline.entries.length, 3);
    assert.deepEqual(outline.entries.map(entry => entry.name).sort(), ["assets/logo.bin", "docs/notes.md", "src/index.ts"]);
    const listing = readArchiveListing(archive, { maxEntriesInOutline: 2 });
    assert.equal(listing.entries.length, 2);
    assert.equal(listing.truncated, true);
    assert.throws(() => workspace.mount("../escape.txt"), errorCode("invalid_path"));
});

test("scenario: a storage size ceiling rejects an oversized file before it is read", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-size-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "big.txt"), "x".repeat(2048));
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false, maxFileBytes: 256 }) });
    assert.throws(() => workspace.mount("big.txt"), errorCode("file_too_large"));
});

test("scenario: a Go project kind seeds a versioned environment and reports its gaps", (t) => {
    const project = createProjectFromKind(goKind, { ...scope, clock: () => "2026-01-01T00:00:00Z" });
    t.after(() => void project);
    assert.equal(project.kind, "go");
    project.putMetadata({ ...scope, path: "src", tags: ["source"], ruleIds: [] });
    const initial = project.environmentPlan();
    assert.equal(initial.ready, false);
    assert.equal(initial.gaps.some(gap => gap.kind === "path" && gap.id === "bin"), true);
    assert.equal(initial.gaps.some(gap => gap.kind === "dependency" && gap.id === "go@build"), true);

    for (const path of ["cmd", "internal", "pkg", "bin"]) project.putMetadata({ ...scope, path, tags: ["source"], ruleIds: [] });
    project.configureEnvironment({ dependencies: [{ id: "go", scope: "build", version: ">=1.22", manager: "go" }] }, { expectedVersion: 0 });
    const ready = project.environmentPlan();
    assert.equal(ready.ready, true);
    assert.match(project.describeEnvironment(), /^# Project environment/m);
    assert.match(project.describeEnvironment(), /ready: yes/);

    const applied = applyProjectKind(project, goKind, { expectedVersion: 1 });
    assert.equal(applied.dependencies[0]?.version, ">=1.22");
});

test("scenario: the agent gateway denies an intern write, masks hidden modules and journals every call", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-gw-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "index.ts"), INDEX_SOURCE);
    const workspace = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }) });
    const file = workspace.mount("index.ts", { mode: "writable", owner: "agent" });

    const calls: GatewayCallRecord[] = [];
    const gateway = new AgentGateway({
        handlers: {
            [`${SURFACE_PREFIX}_workspace.read`]: () => file.read(),
            [`${SURFACE_PREFIX}_workspace.write`]: (parameters) => {
                file.replace({ mode: "string", text: String(parameters.oldText) }, String(parameters.newText));
                return file.flush({ idempotencyKey: String(parameters.idempotencyKey) }).version;
            },
            [`${SURFACE_PREFIX}_project.describe_environment`]: () => "brief",
        },
        authorize: (authority, binding) => authority.includes("workspace:read") || binding.principalId === "lead",
        onCall: record => calls.push(record),
    });
    const intern = { ...scope, principalId: "intern", sessionId: "s-1", policyVersion: "p1", cancellationEpoch: 0 } as const;
    const lead = { ...intern, principalId: "lead" } as const;

    assert.match(String(gateway.call(`${SURFACE_PREFIX}_workspace.read`, { path: "index.ts" }, { binding: intern })), /export function add/);
    assert.throws(() => gateway.call(`${SURFACE_PREFIX}_workspace.write`, { oldText: "a - b", newText: "a + b" }, { binding: intern, idempotencyKey: "w-1" }), gatewayCode("unauthorized"));
    assert.throws(() => gateway.call(`${SURFACE_PREFIX}_workflow.transition`, {}, { binding: lead }), gatewayCode("unknown_tool"));
    assert.throws(() => gateway.call(`${SURFACE_PREFIX}_workspace.read`, { tenantId: "evil" }, { binding: lead }), gatewayCode("invalid_parameters"));
    assert.throws(() => gateway.call(`${SURFACE_PREFIX}_workspace.write`, { oldText: "a - b", newText: "a + b" }, { binding: lead }), gatewayCode("mutating_requires_idempotency_key"));
    const version = gateway.call(`${SURFACE_PREFIX}_workspace.write`, { oldText: "a - b", newText: "a + b", idempotencyKey: "w-2" }, { binding: lead, idempotencyKey: "w-2" });
    assert.equal(typeof version, "number");
    assert.equal(readFileSync(join(root, "index.ts"), "utf8").includes("return a + b;"), true);
    assert.equal(calls.length, 6);
    assert.equal(calls.filter(record => record.ok).length, 2);
    assert.equal(calls.every(record => typeof record.durationMs === "number"), true);
});

test("scenario: document budgets truncate instead of failing the request", () => {
    const many = createZip({
        "word/document.xml": `<w:document xmlns:w="w"><w:body>`
            + Array.from({ length: 5 }, (_, index) => `<w:p><w:r><w:t>P${index}</w:t></w:r></w:p>`).join("")
            + `</w:body></w:document>`,
    });
    const truncated = parseDocx(many, { maxEntriesInOutline: 2 });
    assert.equal(truncated.entries.length, 2);
    assert.equal(truncated.truncated, true);
    const full = parseDocx(many);
    assert.equal(full.entries.length, 5);
    assert.equal(full.truncated, false);
});

test("scenario: workspace writes stay readable through a fresh mount (durability)", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-dur-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "index.ts"), INDEX_SOURCE);
    const storage = new NodeFileStorage({ root, fsync: false });
    const first = new Workspace({ ...scope, storage }).mount("index.ts", { mode: "writable", owner: "agent" });
    first.replace({ mode: "string", text: "return a - b;" }, "return a + b;");
    first.flush();
    first.unmount();

    const second = new Workspace({ ...scope, storage: new NodeFileStorage({ root, fsync: false }) }).mount("index.ts");
    assert.match(second.read(), /return a \+ b;/);
    assert.equal(second.snapshot().dirty, false);
});
