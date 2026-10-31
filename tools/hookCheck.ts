#!/usr/bin/env node
/**
 * Hook layer checks: read/write/diff, parse helpers, observable state, audit
 * recording and the SQLite `hook_runs` round trip.
 *
 * The suite binds one real `FilesystemService` to one temporary root. Fixtures
 * are written once before the first session call, because the session runtime
 * caches its tree; later mutations go through `useWrite` so the tree and the
 * journal see them.
 *
 * The SQLite test creates the `hook_runs` table itself: the production DDL
 * lives in `schema.ts`, which this check must not modify. The DDL used here is
 * the same column list the repository writes.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import type { HookRunRow } from "../src/database/entity/hook.ts";
import { HookRepository, SqliteHookRecorder } from "../src/database/repository/hookRepository.ts";
import { closeStore, openStore } from "../src/database/store/database.ts";
import { FilesystemService } from "../src/file/service.ts";
import type { FilesystemSession } from "../src/file/service.ts";
import type { DependencyReport, ExportReport, ImportReport, ReadPage, ReadRequest, WriteRequest, WriteResult } from "../src/file/types.ts";
import type { OutlineResult } from "../src/outline/types.ts";
import { createHook, projectKindOf, useCode, useCodeParse, useDependency, useDependencyParse, useDiff, useExportation, useExportationParse, useImportation, useImportationParse, useOutline, useOutlineParse, useProject, useProjectParse, useRead, useWrite } from "../src/hook/index.ts";
import type { CodeModel, DependencyFacts, DiffLine, DiffResult, Hook, HookRecorder, HookRunEntry, HookState, ProjectModel } from "../src/hook/index.ts";
import type { SessionCredential, SessionDescriptor } from "../src/session/index.ts";
import { SessionRegistry } from "../src/session/registry.ts";

/**
 * Request shape used by the synthetic cache hook.
 */
interface CountRequest {
    readonly path: string;
    readonly maxLines?: number;
}

/**
 * Minimal shape of `SessionRegistry.open`, which is not exported as a type.
 */
interface OpenedSessionFixture {
    readonly descriptor: SessionDescriptor;
    readonly credential: SessionCredential;
}

/**
 * Fixture root removed by the `after` hook.
 */
const Sandbox: string = mkdtempSync(join(tmpdir(), "amp-hook-"));
const Workspace: string = join(Sandbox, "workspace");
mkdirSync(Workspace, { recursive: true });

/**
 * Write one fixture under the workspace, creating parent directories.
 *
 * @param relative - Root-relative path.
 * @param content - UTF-8 content.
 */
const writeFixture: (relative: string, content: string) => void = (relative: string, content: string): void => {
    const target: string = join(Workspace, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
};

writeFixture(
    "sample.ts",
    `import { readFileSync } from "node:fs";

export interface Question {
    readonly text: string;
}

export const answer: number = 42;

export const load = (path: string): string => readFileSync(path, "utf8");
`,
);
writeFixture(
    "package.json",
    `${JSON.stringify({ name: "hook-fixture", version: "1.2.3", dependencies: { "left-pad": "^1.0.0" } }, null, 4)}\n`,
);
writeFixture("Cargo.toml", "[package]\nname = \"hook-crate\"\nversion = \"0.1.0\"\n");
writeFixture("pyproject.toml", "[project]\nname = \"hook-py\"\nversion = \"2.0.0\"\n");
/**
 * Build a fixture whose 2000th line is blank, so a page boundary lands on an
 * empty line and the diff reader has to preserve it.
 *
 * @returns 2005-line text with a trailing newline.
 */
const pagedFixture: () => string = (): string => {
    const lines: string[] = [];
    for (let index: number = 1; index <= 2005; index += 1) {
        lines.push(index === 2000 ? "" : `l${index}`);
    }
    return `${lines.join("\n")}\n`;
};

writeFixture("read.txt", "line one\nline two\nline three\nline four\nline five\n");
writeFixture("diff-current.txt", "alpha\nbeta\ngamma\n");
writeFixture("empty.txt", "");
writeFixture("paged.txt", pagedFixture());
writeFixture("cache-read.txt", "before\n");
writeFixture("longline.txt", "x".repeat(300 * 1024));
writeFixture("single/Cargo.toml", "[package]\nname = 'cargo-single'\nversion = '9.9.9'\n\n[dependencies]\nname = 'decoy'\nversion = '0.0.0'\n");
writeFixture("poetry/pyproject.toml", "[tool.poetry]\nname = 'poetry-single'\nversion = '3.3.3'\n\n[tool.poetry.dependencies]\nname = 'decoy2'\n");
writeFixture("readonly.txt", "immutable\n");
writeFixture("pom.xml", "<project><modelVersion>4.0.0</modelVersion></project>\n");
writeFixture("build.gradle", "plugins {\n    id 'java'\n}\n");
writeFixture("build.gradle.kts", "plugins {\n    java\n}\n");
writeFixture("CMakeLists.txt", "project(hook-demo)\n");
writeFixture("go.mod", "module hook.example/demo\n");
writeFixture("Makefile", "all:\n\techo hook\n");
writeFileSync(join(Workspace, "binary.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x01]));

const Registry: SessionRegistry = new SessionRegistry();
const Service: FilesystemService = new FilesystemService({ registry: Registry });
const Opened: OpenedSessionFixture = Registry.open({
    agentId: "agent.hook",
    label: "hook check",
    roots: [{ id: "root.hook", path: Workspace, writable: true, exclude: [] }],
    permissions: { read: true, write: true, create: true, remove: false },
});
const Session: FilesystemSession = Service.bind(Opened.credential.sessionId, Opened.credential.token);

/**
 * DDL used by the check. Mirrors the production `hook_runs` column list; the
 * `IF NOT EXISTS` clause makes the check tolerate the schema gaining the table
 * first.
 */
const HookRunsDdl: string = `
CREATE TABLE IF NOT EXISTS hook_runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    hook TEXT NOT NULL,
    path TEXT,
    status TEXT NOT NULL,
    error TEXT,
    revision TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    output_digest TEXT NOT NULL,
    started_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    meta_json TEXT
);
CREATE INDEX IF NOT EXISTS hook_runs_session ON hook_runs(session_id, started_at DESC);
`;

/**
 * Ensure the check-local table exists.
 *
 * @param db - Open store.
 */
const ensureHookTable: (db: DatabaseSync) => void = (db: DatabaseSync): void => {
    db.exec(HookRunsDdl);
};

/**
 * Build one audit entry for the repository round trip.
 *
 * @param sessionId - Session handle to store.
 * @param startedAt - ISO start time.
 * @returns A ready run entry.
 */
const entryOf: (sessionId: string, startedAt: string) => HookRunEntry = (sessionId: string, startedAt: string): HookRunEntry => ({
    hook: "read",
    sessionId,
    path: "read.txt",
    status: "ready",
    revision: "rev.1",
    startedAt,
    durationMs: 3,
    inputDigest: "sha256:input",
    outputDigest: "sha256:output",
});

after((): void => {
    Service.dispose(Session.sessionId);
    Registry.close(Session.sessionId);
    rmSync(Sandbox, { recursive: true, force: true });
});

test("useRead returns bounded pages and keeps bigint totals", async (): Promise<void> => {
    const hook: Hook<ReadRequest, ReadPage> = useRead(Session);
    const state: HookState<ReadPage> = await hook.run({ path: "read.txt", startLine: 2, maxLines: 2 });
    assert.equal(state.status, "ready");
    const page: ReadPage = state.value;
    assert.equal(page.path, "read.txt");
    assert.equal(page.startLine, 2);
    assert.equal(page.endLine, 3);
    assert.equal(page.text, "line two\nline three");
    assert.equal(page.nextStartLine, 4);
    assert.equal(typeof(page.totalLines), "bigint");
    assert.equal(page.totalLines, 5n);
    assert.equal(typeof(page.totalBytes), "bigint");
    assert.ok(page.fingerprint.startsWith("sha256:"));
    assert.equal(hook.state.status, "ready");
});

test("useWrite is the mutating hook and its failure leaves content intact", async (): Promise<void> => {
    const hook: Hook<WriteRequest, WriteResult> = useWrite(Session);
    const created: HookState<WriteResult> = await hook.run({ path: "generated/note.txt", content: "hello\nhook\n", mode: "create", createParents: true });
    assert.equal(created.status, "ready");
    const written: WriteResult = created.value;
    assert.equal(written.created, true);
    assert.equal(created.revision, written.revision);
    assert.equal(written.node.path, "generated/note.txt");

    const readBack: HookState<ReadPage> = await useRead(Session).run({ path: "generated/note.txt", maxLines: 10 });
    assert.equal(readBack.status, "ready");
    assert.equal(readBack.value.text, "hello\nhook");

    const conflict: HookState<WriteResult> = await hook.run({ path: "generated/note.txt", content: "replaced", mode: "create" });
    assert.equal(conflict.status, "error");
    assert.equal(conflict.error, "already_exists");

    const unchanged: HookState<ReadPage> = await useRead(Session).run({ path: "generated/note.txt", maxLines: 10 });
    assert.equal(unchanged.value.text, "hello\nhook");

    const cached: Hook<WriteRequest, WriteResult> = useWrite(Session, { cache: true });
    const firstWrite: HookState<WriteResult> = await cached.run({ path: "generated/cache.txt", content: "once", mode: "create" });
    assert.equal(firstWrite.status, "ready");
    const replay: HookState<WriteResult> = await cached.run({ path: "generated/cache.txt", content: "once", mode: "create" });
    assert.equal(replay.status, "error");
    assert.equal(replay.error, "already_exists");
});

test("useDiff reports add, remove, context and an unchanged file", async (): Promise<void> => {
    const added: HookState<DiffResult> = await useDiff(Session).run({ path: "virtual.txt", before: "", content: "one\ntwo\n" });
    assert.equal(added.status, "ready");
    assert.equal(added.value.added, 2);
    assert.equal(added.value.removed, 0);
    assert.equal(added.value.unchanged, 0);
    assert.equal(added.value.hunks.length, 1);
    assert.deepEqual(added.value.hunks[0].lines.map((line: DiffLine): string => line.type), ["add", "add"]);
    assert.equal(added.value.hunks[0].lines[0].afterLine, 1);
    assert.equal(added.value.hunks[0].lines[0].beforeLine, 1);
    assert.ok(added.value.beforeFingerprint.startsWith("sha256:"));
    assert.ok(added.value.afterFingerprint.startsWith("sha256:"));

    const removed: HookState<DiffResult> = await useDiff(Session).run({ path: "virtual.txt", before: "one\ntwo\nthree\n", content: "one\nthree\n" });
    assert.equal(removed.value.added, 0);
    assert.equal(removed.value.removed, 1);
    assert.equal(removed.value.unchanged, 2);
    const removalLines: readonly DiffLine[] = removed.value.hunks[0].lines;
    assert.deepEqual(removalLines.map((line: DiffLine): string => line.type), ["context", "remove", "context"]);
    assert.equal(removalLines[1].beforeLine, 2);

    const contextual: HookState<DiffResult> = await useDiff(Session).run({ path: "virtual.txt", before: "a\nb\nc\nd\ne\n", content: "a\nb\nX\nd\ne\n", context: 1 });
    assert.equal(contextual.value.hunks.length, 1);
    assert.deepEqual(contextual.value.hunks[0].lines.map((line: DiffLine): string => line.type), ["context", "remove", "add", "context"]);
    assert.equal(contextual.value.hunks[0].beforeLines, 3);
    assert.equal(contextual.value.hunks[0].afterLines, 3);

    const same: HookState<DiffResult> = await useDiff(Session).run({ path: "virtual.txt", before: "a\nb\n", content: "a\nb\n" });
    assert.equal(same.value.added, 0);
    assert.equal(same.value.removed, 0);
    assert.equal(same.value.unchanged, 2);
    assert.equal(same.value.hunks.length, 0);
    assert.equal(same.value.beforeFingerprint, same.value.afterFingerprint);

    const empty: HookState<DiffResult> = await useDiff(Session).run({ path: "empty.txt" });
    assert.equal(empty.status, "ready");
    assert.equal(empty.value.hunks.length, 0);
    assert.equal(empty.value.unchanged, 0);

    const unchangedFile: HookState<DiffResult> = await useDiff(Session).run({ path: "diff-current.txt" });
    assert.equal(unchangedFile.status, "ready");
    assert.equal(unchangedFile.value.unchanged, 3);
    assert.equal(unchangedFile.value.hunks.length, 0);
    assert.equal(unchangedFile.value.beforeFingerprint, unchangedFile.value.afterFingerprint);

    const missing: HookState<DiffResult> = await useDiff(Session).run({ path: "missing-diff.txt" });
    assert.equal(missing.status, "ready");
    assert.equal(missing.value.hunks.length, 0);
    assert.equal(missing.value.beforeFingerprint, missing.value.afterFingerprint);

    const paged: HookState<DiffResult> = await useDiff(Session).run({ path: "paged.txt" });
    assert.equal(paged.status, "ready");
    assert.equal(paged.value.unchanged, 2005);
    assert.equal(paged.value.hunks.length, 0);

    const longLine: HookState<DiffResult> = await useDiff(Session).run({ path: "longline.txt" });
    assert.equal(longLine.status, "ready");
    assert.equal(longLine.value.unchanged, 1);
    assert.equal(longLine.value.hunks.length, 0);
    assert.equal(longLine.value.truncated, false);

    const directory: HookState<DiffResult> = await useDiff(Session).run({ path: "." });
    assert.equal(directory.status, "error");
    assert.equal(directory.error, "not_file");

    const longParts: string[] = [];
    for (let index: number = 0; index < 6000; index += 1) {
        longParts.push(`line ${index}`);
    }
    const longBefore: string = longParts.join("\n");
    const long: HookState<DiffResult> = await useDiff(Session).run({ path: "virtual.txt", before: longBefore, content: "changed" });
    assert.equal(long.value.truncated, true);
    assert.equal(long.value.removed, 5000);

    const binary: HookState<DiffResult> = await useDiff(Session).run({ path: "binary.bin" });
    assert.equal(binary.status, "error");
    assert.equal(binary.error, "binary_file");
});

test("hook state moves idle/loading/ready/error, notifies and resets", async (): Promise<void> => {
    const hook: Hook<ReadRequest, ReadPage> = useRead(Session);
    assert.equal(hook.state.status, "idle");
    assert.equal(Object.isFrozen(hook.state), true);
    const states: string[] = [];
    const unsubscribe: () => void = hook.subscribe((state: HookState<ReadPage>): void => {
        states.push(state.status);
    });
    const pending: Promise<HookState<ReadPage>> = hook.run({ path: "read.txt", maxLines: 2 });
    assert.equal(hook.state.status, "loading");
    const ready: HookState<ReadPage> = await pending;
    assert.equal(ready.status, "ready");
    assert.equal(hook.state.status, "ready");
    assert.deepEqual(states.slice(0, 2), ["loading", "ready"]);
    assert.equal(Object.isFrozen(hook.state), true);
    assert.equal(hook.state.revision, ready.revision);

    const errorState: HookState<ReadPage> = await hook.run({ path: "missing-read.txt" });
    assert.equal(errorState.status, "error");
    assert.equal(errorState.error, "not_found");
    assert.equal(hook.state.error, "not_found");

    unsubscribe();
    const beforeCount: number = states.length;
    await hook.run({ path: "read.txt", maxLines: 1 });
    assert.equal(states.length, beforeCount);

    const revisionBeforeReset: string = hook.state.revision;
    hook.reset();
    assert.equal(hook.state.status, "idle");
    assert.equal(Object.isFrozen(hook.state), true);
    assert.equal(hook.state.revision, revisionBeforeReset);

    const resubscribed: string[] = [];
    const stop: () => void = hook.subscribe((state: HookState<ReadPage>): void => {
        resubscribed.push(state.status);
    });
    await hook.run({ path: "read.txt", maxLines: 1 });
    assert.deepEqual(resubscribed, ["loading", "ready"]);
    stop();
});

test("createHook caches by canonical request and respects the LRU bound", async (): Promise<void> => {
    let calls: number = 0;
    const counted: Hook<CountRequest, string> = createHook<CountRequest, string>({
        name: "counted",
        session: Session,
        execute: (request: CountRequest): string => {
            calls += 1;
            return `${request.path}:${request.maxLines ?? 0}`;
        },
        pathOf: (request: CountRequest): string => request.path,
        options: { cache: true, maxCacheEntries: 1 },
    });
    const first: HookState<string> = await counted.run({ path: "alpha", maxLines: 1 });
    const second: HookState<string> = await counted.run({ maxLines: 1, path: "alpha" });
    assert.equal(first.value, second.value);
    assert.equal(calls, 1);
    await counted.run({ path: "beta" });
    await counted.run({ path: "alpha", maxLines: 1 });
    assert.equal(calls, 3);
});

test("cached reads invalidate when the workspace revision changes", async (): Promise<void> => {
    const reader: Hook<ReadRequest, ReadPage> = useRead(Session, { cache: true, maxCacheEntries: 4 });
    const beforeState: HookState<ReadPage> = await reader.run({ path: "cache-read.txt", maxLines: 5 });
    assert.equal(beforeState.status, "ready");
    assert.equal(beforeState.value.text, "before");
    const writer: Hook<WriteRequest, WriteResult> = useWrite(Session);
    const writeState: HookState<WriteResult> = await writer.run({ path: "cache-read.txt", content: "after\n", mode: "overwrite" });
    assert.equal(writeState.status, "ready");
    const afterState: HookState<ReadPage> = await reader.run({ path: "cache-read.txt", maxLines: 5 });
    assert.equal(afterState.status, "ready");
    assert.equal(afterState.value.text, "after");
    assert.notEqual(afterState.revision, beforeState.revision);
});

test("a stale run cannot overwrite a newer observable state", async (): Promise<void> => {
    let releaseFirst: (() => void) | undefined;
    const hook: Hook<CountRequest, string> = createHook<CountRequest, string>({
        name: "ordered",
        session: Session,
        execute: (request: CountRequest): Promise<string> =>
            new Promise<string>((resolve: (value: string) => void): void => {
                if (request.path === "first") {
                    releaseFirst = (): void => {
                        resolve("first");
                    };
                    return;
                }
                resolve("second");
            }),
        pathOf: (request: CountRequest): string => request.path,
    });
    const firstRun: Promise<HookState<string>> = hook.run({ path: "first" });
    const secondRun: Promise<HookState<string>> = hook.run({ path: "second" });
    const secondState: HookState<string> = await secondRun;
    assert.equal(secondState.value, "second");
    assert.equal(hook.state.value, "second");
    if (releaseFirst !== (void 0)) {
        releaseFirst();
    }
    const firstState: HookState<string> = await firstRun;
    assert.equal(firstState.value, "first");
    assert.equal(hook.state.value, "second");
});

test("recorder failures never break a hook result", async (): Promise<void> => {
    const entries: HookRunEntry[] = [];
    const recorder: HookRecorder = {
        record: (entry: HookRunEntry): void => {
            entries.push(entry);
        },
    };
    const hook: Hook<ReadRequest, ReadPage> = useRead(Session, { recorder });
    const state: HookState<ReadPage> = await hook.run({ path: "read.txt", maxLines: 1 });
    assert.equal(state.status, "ready");
    assert.equal(entries.length, 1);
    const entry: HookRunEntry = entries[0];
    assert.equal(entry.hook, "read");
    assert.equal(entry.sessionId, Session.sessionId);
    assert.equal(entry.path, "read.txt");
    assert.equal(entry.status, "ready");
    assert.ok(entry.revision.length > 0);
    assert.ok(entry.inputDigest.startsWith("sha256:"));
    assert.ok(entry.outputDigest.startsWith("sha256:"));
    assert.ok(entry.durationMs >= 0);
    assert.ok(Number.isFinite(Date.parse(entry.startedAt)));

    const missingState: HookState<ReadPage> = await hook.run({ path: "missing-recorder.txt" });
    assert.equal(missingState.status, "error");
    assert.equal(missingState.error, "not_found");
    assert.equal(entries.length, 2);
    assert.equal(entries[1].status, "error");
    assert.equal(entries[1].error, "not_found");
    assert.equal(entries[1].outputDigest, "");

    const failing: HookRecorder = {
        record: (): void => {
            throw new Error("recorder down");
        },
    };
    const resilient: Hook<ReadRequest, ReadPage> = useRead(Session, { recorder: failing, cache: true });
    const result: HookState<ReadPage> = await resilient.run({ path: "read.txt", maxLines: 1 });
    assert.equal(result.status, "ready");
    assert.equal(result.value.text, "line one");
});

test("useProject recognizes every supported manifest kind", async (): Promise<void> => {
    const expected: ReadonlyArray<readonly [string, string]> = [
        ["package.json", "npm"],
        ["pom.xml", "maven"],
        ["build.gradle", "gradle"],
        ["build.gradle.kts", "gradle"],
        ["CMakeLists.txt", "cmake"],
        ["Cargo.toml", "cargo"],
        ["go.mod", "go"],
        ["pyproject.toml", "python"],
        ["Makefile", "make"],
        ["README.md", "unknown"],
    ];
    for (let index: number = 0; index < expected.length; index += 1) {
        const relative: string = expected[index][0];
        const kind: string = expected[index][1];
        assert.equal(projectKindOf(relative), kind);
        if (kind === "unknown") {
            continue;
        }
        const model: ProjectModel = useProjectParse(Session)(relative);
        assert.equal(model.kind, kind);
        assert.equal(model.manifestOutline.path, relative);
        assert.equal(model.dependencies.mode, "dependencies");
    }
});

test("useProject scopes TOML identity to package sections", async (): Promise<void> => {
    const cargo: ProjectModel = useProjectParse(Session)("single/Cargo.toml");
    assert.equal(cargo.kind, "cargo");
    assert.equal(cargo.name, "cargo-single");
    assert.equal(cargo.version, "9.9.9");
    const poetry: ProjectModel = useProjectParse(Session)("poetry/pyproject.toml");
    assert.equal(poetry.kind, "python");
    assert.equal(poetry.name, "poetry-single");
    assert.equal(poetry.version, "3.3.3");
});

test("read-only hooks leave mtime and content unchanged", async (): Promise<void> => {
    const samplePath: string = join(Workspace, "sample.ts");
    const manifestPath: string = join(Workspace, "package.json");
    const sampleStat: Stats = statSync(samplePath);
    const sampleBytes: Buffer = readFileSync(samplePath);
    const manifestStat: Stats = statSync(manifestPath);
    const manifestBytes: Buffer = readFileSync(manifestPath);

    const outline: HookState<OutlineResult> = await useOutline(Session).run({ path: "sample.ts" });
    assert.equal(outline.status, "ready");
    assert.equal(outline.value.language, "typescript");
    assert.equal(outline.value.target, "file");
    const parsedOutline: OutlineResult = useOutlineParse(Session)("sample.ts", { maxDepth: 4 });
    assert.equal(parsedOutline.path, "sample.ts");
    assert.equal(parsedOutline.strategy, "typescript");
    assert.ok(parsedOutline.nodes.length > 0);

    const importState: HookState<ImportReport> = await useImportation(Session).run({ path: "sample.ts", direction: "outgoing" });
    assert.equal(importState.status, "ready");
    assert.ok(importState.value.imports.some((edge): boolean => edge.specifier === "node:fs"));
    assert.equal(importState.value.external.includes("node:fs"), true);
    const imported: ImportReport = useImportationParse(Session)("sample.ts");
    assert.equal(imported.path, "sample.ts");

    const exportState: HookState<ExportReport> = await useExportation(Session).run({ path: "sample.ts", includeReexports: true });
    assert.equal(exportState.status, "ready");
    assert.equal(exportState.value.reexports.length, 0);
    const exported: ExportReport = useExportationParse(Session)("sample.ts");
    assert.ok(exported.exports.some((symbol): boolean => symbol.name === "answer"));
    assert.ok(exported.exports.some((symbol): boolean => symbol.name === "Question"));

    const facts: DependencyFacts = useDependencyParse(Session)("sample.ts");
    assert.equal(facts.path, "sample.ts");
    assert.equal(facts.imports.path, "sample.ts");
    assert.equal(facts.exports.path, "sample.ts");
    const dependencyState: HookState<DependencyReport> = await useDependency(Session).run({ mode: "cycles" });
    assert.equal(dependencyState.status, "ready");
    assert.equal(dependencyState.value.mode, "cycles");

    const codeState: HookState<CodeModel> = await useCode(Session).run({ path: "sample.ts", maxNodes: 50 });
    assert.equal(codeState.status, "ready");
    assert.equal(codeState.value.path, "sample.ts");
    assert.equal(codeState.value.language, "typescript");
    assert.equal(codeState.value.fingerprint, codeState.value.outline.fingerprint);
    assert.ok(codeState.value.imports.imports.length > 0);
    assert.ok(codeState.value.exports.exports.length > 0);
    const parsedCode: CodeModel = useCodeParse(Session)("sample.ts");
    assert.equal(parsedCode.fingerprint, codeState.value.fingerprint);

    const projectState: HookState<ProjectModel> = await useProject(Session).run({ path: "package.json" });
    assert.equal(projectState.status, "ready");
    assert.equal(projectState.value.kind, "npm");
    assert.equal(projectState.value.name, "hook-fixture");
    assert.equal(projectState.value.version, "1.2.3");
    assert.equal(projectState.value.manifestOutline.strategy, "npm");
    assert.equal(projectState.value.dependencies.mode, "dependencies");
    const cargo: ProjectModel = useProjectParse(Session)("Cargo.toml");
    assert.equal(cargo.kind, "cargo");
    assert.equal(cargo.name, "hook-crate");
    assert.equal(cargo.version, "0.1.0");
    const python: ProjectModel = useProjectParse(Session)("pyproject.toml");
    assert.equal(python.kind, "python");
    assert.equal(python.name, "hook-py");
    assert.equal(python.version, "2.0.0");
    assert.equal(projectKindOf("unknown/README.md"), "unknown");

    const afterSampleStat: Stats = statSync(samplePath);
    const afterManifestStat: Stats = statSync(manifestPath);
    assert.equal(afterSampleStat.mtimeMs, sampleStat.mtimeMs);
    assert.equal(afterSampleStat.size, sampleStat.size);
    assert.equal(afterManifestStat.mtimeMs, manifestStat.mtimeMs);
    assert.equal(afterManifestStat.size, manifestStat.size);
    assert.deepEqual(readFileSync(samplePath), sampleBytes);
    assert.deepEqual(readFileSync(manifestPath), manifestBytes);
});

test("HookRepository and SqliteHookRecorder round trip through SQLite", async (): Promise<void> => {
    const db: DatabaseSync = openStore(":memory:");
    try {
        ensureHookTable(db);
        const repository: HookRepository = new HookRepository(db);
        repository.append(entryOf("session.hook", "2026-10-30T00:00:01.000Z"));
        repository.append(entryOf("session.hook", "2026-10-30T00:00:02.000Z"));
        assert.equal(repository.count("session.hook"), 2);
        assert.equal(repository.count(), 2);
        assert.equal(repository.count("\"session_id\" = ?", "session.hook"), 2);
        const rows: HookRunRow[] = repository.list("session.hook", 10);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].started_at, "2026-10-30T00:00:02.000Z");
        assert.equal(rows[1].started_at, "2026-10-30T00:00:01.000Z");
        assert.equal(rows[0].session_id, "session.hook");
        assert.equal(rows[0].hook, "read");
        assert.ok(rows[0].run_id.startsWith("run."));
        assert.equal(/^run\.[0-9a-f]{16}$/.test(rows[0].run_id), true);
        assert.equal(rows[0].path, "read.txt");
        assert.equal(rows[0].error, null);
        assert.equal(rows[0].revision, "rev.1");
        assert.equal(rows[0].duration_ms, 3);
        assert.equal(rows[0].meta_json, "{}");

        const recorder: SqliteHookRecorder = new SqliteHookRecorder(db);
        const hook: Hook<ReadRequest, ReadPage> = useRead(Session, { recorder });
        const state: HookState<ReadPage> = await hook.run({ path: "read.txt", maxLines: 1 });
        assert.equal(state.status, "ready");
        assert.equal(repository.count(Session.sessionId), 1);
        const liveRows: HookRunRow[] = repository.list(Session.sessionId, 1);
        assert.equal(liveRows.length, 1);
        assert.equal(liveRows[0].hook, "read");
        assert.equal(liveRows[0].path, "read.txt");
        assert.equal(liveRows[0].status, "ready");
        assert.ok(liveRows[0].input_digest.startsWith("sha256:"));
        assert.ok(liveRows[0].output_digest.startsWith("sha256:"));

        db.exec("DROP TABLE hook_runs");
        recorder.record(entryOf("session.hook", "2026-10-30T00:00:04.000Z"));
    } finally {
        closeStore(db);
    }
});
