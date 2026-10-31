#!/usr/bin/env node
/**
 * Round-trip checks for the workspace session and filesystem SQLite stores.
 *
 * Every test opens its own database (in memory, except the reopen test), applies
 * the full schema through `openStore`, exercises the repositories and adapters,
 * and closes the connection. Nothing is asserted against private SQL helpers:
 * the rows are checked where the repository contract exposes them, and canonical
 * JSON is checked once against the stored column.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { SqliteFilesystemStore } from "../src/database/adapter/filesystemStore.ts";
import { SqliteWorkspaceSessionContextStore, SqliteWorkspaceSessionStore } from "../src/database/adapter/workspaceSessionStore.ts";
import { FileAnnotationRepository } from "../src/database/repository/fileAnnotationRepository.ts";
import type { DependencyGraph } from "../src/database/repository/fileGraphRepository.ts";
import { FileGraphRepository } from "../src/database/repository/fileGraphRepository.ts";
import { FileNodeRepository } from "../src/database/repository/fileNodeRepository.ts";
import { FileOutlineRepository } from "../src/database/repository/fileOutlineRepository.ts";
import { FileWriteRepository } from "../src/database/repository/fileWriteRepository.ts";
import { WorkspaceSessionRepository } from "../src/database/repository/workspaceSessionRepository.ts";
import { closeStore, openStore, tableNames } from "../src/database/store/database.ts";
import type { FileNodeRow, FileWriteRow } from "../src/database/entity/fileTree.ts";
import type { DependencyEdge, DirectoryNode, ExportReport, FileNode, FilesystemStore, ImportEdge, ImportReport, TreeSnapshot, TreeNode, WriteJournalEntry } from "../src/file/types.ts";
import type { OutlineResult } from "../src/outline/types.ts";
import { canonical } from "../src/semantic/canonical.ts";
import type {
    SessionContextEntry,
    SessionContextStore,
    SessionDescriptor,
    SessionPermissions,
    SessionRoot,
    SessionStatus,
    SessionStore,
} from "../src/session/types.ts";

const At: string = "2026-10-30T00:00:00.000Z";
const Later: string = "2026-10-30T01:00:00.000Z";
const NodeCreate: string = "2026-10-01T09:00:00";
const NodeModify: string = "2026-10-02T10:30:00";

const Permissions: SessionPermissions = {
    read: true,
    write: true,
    create: true,
    remove: false,
    maxReadBytes: 4096,
    maxWriteBytes: 2048,
    maxTreeNodes: 100,
    maxContextEntries: 8,
    maxContextBytes: 8192,
};

/**
 * Raw session JSON columns read by the canonical-JSON assertion.
 */
interface StoredSessionJson {
    permissions_json: string;
    metadata_json: string;
}

/**
 * Raw context JSON column read by the canonical-JSON assertion.
 */
interface StoredContextJson {
    value_json: string;
}

/**
 * Options that vary one descriptor fixture.
 */
interface SessionOptions {
    readonly label?: string;
    readonly parentId?: string;
    readonly revision?: number;
    readonly status?: SessionStatus;
    readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Factory shape for one host root fixture.
 */
type RootFactory = (id: string, path: string, writable: boolean, exclude: readonly string[]) => SessionRoot;

/**
 * Build one host root fixture.
 */
const rootOf: RootFactory = (id: string, path: string, writable: boolean, exclude: readonly string[]): SessionRoot => ({
    id,
    path,
    writable,
    exclude,
});

/**
 * Factory shape for one session descriptor fixture.
 */
type SessionFactory = (id: string, agentId: string, roots: readonly SessionRoot[], options?: SessionOptions) => SessionDescriptor;

/**
 * Build one session descriptor fixture.
 */
const sessionOf: SessionFactory = (id: string, agentId: string, roots: readonly SessionRoot[], options: SessionOptions = {}): SessionDescriptor => ({
    id,
    agentId,
    label: options.label ?? `session ${id}`,
    status: options.status ?? "active",
    roots,
    permissions: Permissions,
    createdAt: At,
    expiresAt: "2026-10-31T00:00:00.000Z",
    idleExpiresAt: "2026-10-30T01:00:00.000Z",
    revision: options.revision ?? 1,
    ...(options.parentId === (void 0) ? {} : { parentId: options.parentId }),
    metadata: options.metadata ?? { purpose: "database check" },
});

/**
 * Run one test body against a fresh in-memory store and always close it.
 */
const withDatabase: (run: (db: DatabaseSync) => void) => void = (run: (db: DatabaseSync) => void): void => {
    const db: DatabaseSync = openStore(":memory:");
    try {
        run(db);
    } finally {
        closeStore(db);
    }
};

/**
 * Leaf name of one root-relative path.
 */
const nameOf: (path: string) => string = (path: string): string => {
    const slash: number = path.lastIndexOf("/");
    return path.slice(slash + 1);
};

/**
 * Extension of one leaf name, empty when there is none.
 */
const extensionOf: (path: string) => string = (path: string): string => {
    const name: string = nameOf(path);
    const dot: number = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot + 1);
};

/**
 * Factory shape for one file node fixture.
 */
type FileFactory = (path: string, fingerprint: string, lines: bigint, bytes: bigint) => FileNode;

/**
 * Build one file node fixture.
 */
const fileOf: FileFactory = (path: string, fingerprint: string, lines: bigint, bytes: bigint): FileNode => ({
    type: "File",
    path,
    name: nameOf(path),
    extension: extensionOf(path),
    children: [],
    fingerprint,
    charset: "utf-8",
    lines,
    bytes,
    create: NodeCreate,
    modify: NodeModify,
    description: `${path} description`,
    summary: `${path} summary`,
    purpose: `${path} purpose`,
});

/**
 * Factory shape for one directory node fixture.
 */
type DirectoryFactory = (path: string, children: readonly TreeNode[], lines: bigint, bytes: bigint, fingerprint: string) => DirectoryNode;

/**
 * Build one directory node fixture.
 */
const dirOf: DirectoryFactory = (path: string, children: readonly TreeNode[], lines: bigint, bytes: bigint, fingerprint: string): DirectoryNode => ({
    type: "Directory",
    path,
    name: path === "." ? "project" : nameOf(path),
    extension: "directory",
    children,
    fingerprint,
    charset: "none",
    lines,
    bytes,
    create: NodeCreate,
    modify: NodeModify,
    description: `${path} description`,
    summary: `${path} summary`,
    purpose: `${path} purpose`,
});

/**
 * Build the tree snapshot reused by the tree, adapter and persistence tests.
 */
const treeFixture: () => TreeSnapshot = (): TreeSnapshot => {
    const source: FileNode = fileOf("src/a.ts", "sha256:file-a", 12n, 345n);
    const readme: FileNode = fileOf("README.md", "sha256:readme", 3n, 40n);
    const directory: DirectoryNode = dirOf("src", [source], 12n, 345n, "sha256:dir-src");
    const root: DirectoryNode = dirOf(".", [directory, readme], 15n, 385n, "sha256:root");
    return {
        root,
        revision: "rev-1",
        stats: { files: 2n, directories: 2n, lines: 15n, bytes: 385n, truncated: false },
    };
};

/**
 * Build the import report reused by the graph tests.
 */
const importReport: (path: string, fingerprint: string) => ImportReport = (path: string, fingerprint: string): ImportReport => ({
    path,
    fingerprint,
    imports: [
        { from: path, to: "src/b.ts", specifier: "./b", kind: "static", line: 1, resolved: true, external: false },
        { from: path, to: "react", specifier: "react", kind: "static", line: 2, resolved: false, external: true },
        { from: path, to: "@missing", specifier: "@missing", kind: "dynamic", line: 3, resolved: false, external: false },
    ],
    importedBy: [],
    external: ["react"],
    unresolved: ["@missing"],
    truncated: false,
});

/**
 * Build the export report reused by the graph tests.
 */
const exportReport: () => ExportReport = (): ExportReport => ({
    path: "src/a.ts",
    fingerprint: "sha256:file-a",
    exports: [
        { name: "alpha", kind: "function", line: 1, signature: "function alpha(): void" },
        { name: "beta", kind: "reexport", line: 2, signature: "", reexportFrom: "./b" },
    ],
    reexports: [{ from: "src/a.ts", to: "src/b.ts", specifier: "./b", kind: "export-from", line: 2, resolved: true, external: false }],
    truncated: false,
});

/**
 * Build the outline result reused by the outline tests.
 */
const outlineOf: () => OutlineResult = (): OutlineResult => ({
    path: "src/a.ts",
    fingerprint: "sha256:file-a",
    language: "typescript",
    strategy: "typescript",
    category: "code",
    target: "file",
    charset: "utf-8",
    nodes: [
        {
            isFile: false,
            isDirectory: false,
            path: "src/a.ts#alpha",
            type: "function",
            range: { startByte: 0n, endByte: 12n, startLine: 1n, endLine: 2n },
            label: "alpha",
            depth: 0,
            children: [
                {
                    isFile: false,
                    isDirectory: false,
                    path: "src/a.ts#alpha.inner",
                    type: "property",
                    range: { startByte: 10n, endByte: 12n, startLine: 2n, endLine: 2n },
                    label: "inner",
                    depth: 1,
                    children: [],
                },
            ],
        },
        {
            isFile: true,
            isDirectory: false,
            file: fileOf("src/a.ts", "sha256:file-a", 12n, 345n),
            path: "src/a.ts",
            type: "File",
            range: { startByte: 0n, endByte: 345n, startLine: 1n, endLine: 12n },
            label: "src/a.ts",
            depth: 0,
            children: [],
        },
    ],
    truncated: false,
});

test("openStore creates every workspace session and filesystem table", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const names: string[] = tableNames(db);
        const required: readonly string[] = [
            "workspace_sessions",
            "session_roots",
            "session_context",
            "file_nodes",
            "file_annotations",
            "file_writes",
            "file_outlines",
            "file_imports",
            "file_exports",
            "file_dependencies",
        ];
        for (let index: number = 0; index < required.length; index += 1) {
            assert.ok(names.includes(required[index]), `missing table ${required[index]}`);
        }
    });
});

test("session descriptor, roots and secret survive save, update and delete", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: WorkspaceSessionRepository = new WorkspaceSessionRepository(db);
        const roots: readonly SessionRoot[] = [
            rootOf("root.project", "C:/project/alpha", true, ["node_modules", ".git"]),
            rootOf("root.docs", "C:/project/docs", false, []),
        ];
        const descriptor: SessionDescriptor = sessionOf("s.alpha", "agent.coder", roots, {
            parentId: "s.parent",
            revision: 4,
            metadata: { purpose: "check", owner: "host" },
        });
        repository.save(descriptor, "sha256:token-a");
        assert.deepEqual(repository.load("s.alpha"), descriptor);
        assert.equal(repository.loadSecret("s.alpha"), "sha256:token-a");
        assert.deepEqual(repository.findRoots("s.alpha"), roots);
        assert.equal(repository.list("agent.coder").length, 1);
        assert.equal(repository.list("agent.other").length, 0);
        assert.equal(repository.list().length, 1);

        const stored: StoredSessionJson = db
            .prepare("SELECT permissions_json, metadata_json FROM workspace_sessions WHERE session_id = ?")
            .get("s.alpha") as unknown as StoredSessionJson;
        assert.equal(stored.permissions_json, canonical(Permissions));
        assert.equal(stored.metadata_json, canonical(descriptor.metadata));

        const updated: SessionDescriptor = {
            ...descriptor,
            label: "renamed",
            status: "suspended",
            revision: 5,
            roots: [roots[0]],
            metadata: { purpose: "updated" },
        };
        repository.save(updated, "sha256:token-b");
        assert.deepEqual(repository.load("s.alpha"), updated);
        assert.equal(repository.findRoots("s.alpha").length, 1);
        assert.equal(repository.loadSecret("s.alpha"), "sha256:token-b");

        assert.throws((): void => {
            repository.save({ ...descriptor, status: "bogus" as unknown as SessionStatus }, "sha256:bad");
        }, /invalid workspace session status/);

        assert.equal(repository.delete("s.alpha"), true);
        assert.equal(repository.load("s.alpha"), (void 0));
        assert.equal(repository.loadSecret("s.alpha"), (void 0));
        assert.equal(repository.findRoots("s.alpha").length, 0);
        assert.equal(repository.delete("s.alpha"), false);
    });
});

test("context entries round-trip, replace atomically and delete by key", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: WorkspaceSessionRepository = new WorkspaceSessionRepository(db);
        repository.save(sessionOf("s.ctx", "agent.ctx", [rootOf("root.ctx", "C:/ctx", true, [])]), "sha256:ctx");
        const first: SessionContextEntry = { namespace: "notes", key: "alpha", value: { z: 2, a: [true, null, "x"] }, bytes: 21, updatedAt: At };
        repository.putContext("s.ctx", first);
        assert.deepEqual(repository.loadContext("s.ctx"), [first]);
        const stored: StoredContextJson = db
            .prepare("SELECT value_json FROM session_context WHERE entry_id = ?")
            .get("s.ctx\u0000notes\u0000alpha") as unknown as StoredContextJson;
        assert.equal(stored.value_json, canonical(first.value));

        const second: SessionContextEntry = { namespace: "notes", key: "alpha", value: { a: 1 }, bytes: 8, updatedAt: Later };
        repository.putContext("s.ctx", second);
        assert.deepEqual(repository.loadContext("s.ctx"), [second]);
        assert.throws((): void => {
            repository.putContext("s.ctx", { ...second, bytes: -1 });
        }, RangeError);
        assert.throws((): void => {
            repository.putContext("s.ctx", { ...second, bytes: 1.5 });
        }, RangeError);
        assert.deepEqual(repository.loadContext("s.ctx"), [second]);

        const other: SessionContextEntry = { namespace: "beta", key: "zeta", value: "text", bytes: 6, updatedAt: At };
        repository.putContext("s.ctx", other);
        assert.equal(repository.loadContext("s.ctx").length, 2);
        assert.equal(repository.deleteContext("s.ctx", "notes", "alpha"), true);
        assert.equal(repository.deleteContext("s.ctx", "notes", "alpha"), false);
        assert.deepEqual(repository.loadContext("s.ctx"), [other]);

        const replacement: readonly SessionContextEntry[] = [
            { namespace: "alpha", key: "a", value: 1, bytes: 1, updatedAt: At },
            { namespace: "beta", key: "a", value: 2, bytes: 1, updatedAt: At },
        ];
        repository.replaceContext("s.ctx", replacement);
        assert.deepEqual(repository.loadContext("s.ctx"), replacement);
        repository.deleteContextSession("s.ctx");
        assert.deepEqual(repository.loadContext("s.ctx"), []);
        assert.equal(repository.loadContext("s.other").length, 0);
    });
});

test("file tree replace, point lookup, children, count and delete are consistent", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: FileNodeRepository = new FileNodeRepository(db);
        repository.replaceTree("root.1", treeFixture(), At);
        assert.equal(repository.count("root.1"), 4);
        const rootRow: FileNodeRow | undefined = repository.findNode("root.1", ".");
        assert.ok(rootRow);
        assert.equal(rootRow.type, "Directory");
        assert.equal(rootRow.parent_path, null);
        assert.equal(rootRow.revision, "rev-1");
        assert.equal(rootRow.updated_at, At);

        const fileRow: FileNodeRow | undefined = repository.findNode("root.1", "src/a.ts");
        assert.ok(fileRow);
        assert.equal(fileRow.type, "File");
        assert.equal(fileRow.parent_path, "src");
        assert.equal(fileRow.lines, "12");
        assert.equal(fileRow.bytes, "345");
        assert.equal(fileRow.charset, "utf-8");
        assert.equal(fileRow.created_at, NodeCreate);
        assert.equal(fileRow.modified_at, NodeModify);

        const top: FileNodeRow[] = repository.children("root.1", ".");
        assert.equal(top.length, 2);
        assert.equal(top[0].path, "src");
        assert.equal(top[1].path, "README.md");
        assert.equal(repository.children("root.1", "src").length, 1);
        assert.equal(repository.children("root.1", "src")[0].path, "src/a.ts");
        assert.equal(repository.children("root.1", "missing").length, 0);
        assert.equal(repository.findNode("root.1", "missing.ts"), (void 0));
        assert.equal(repository.count("root.2"), 0);

        repository.replaceTree("root.2", treeFixture(), At);
        repository.deleteTree("root.1");
        assert.equal(repository.count("root.1"), 0);
        assert.equal(repository.count("root.2"), 4);

        const empty: TreeSnapshot = {
            root: dirOf(".", [], 0n, 0n, "sha256:empty"),
            revision: "rev-2",
            stats: { files: 0n, directories: 1n, lines: 0n, bytes: 0n, truncated: false },
        };
        repository.replaceTree("root.2", empty, Later);
        assert.equal(repository.count("root.2"), 1);
        assert.equal(repository.findNode("root.2", "src/a.ts"), (void 0));
    });
});

test("annotations upsert, load and delete by root and path", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: FileAnnotationRepository = new FileAnnotationRepository(db);
        assert.deepEqual(repository.load("root.1"), {});
        repository.upsert("root.1", "src/a.ts", { description: "human note" }, "host", At);
        assert.deepEqual(repository.load("root.1"), { "src/a.ts": { description: "human note" } });
        repository.upsert("root.1", "src/a.ts", { description: "agent note", summary: "sum", purpose: "purpose" }, "agent", Later);
        assert.deepEqual(repository.load("root.1")["src/a.ts"], { description: "agent note", summary: "sum", purpose: "purpose" });
        repository.upsert("root.1", "README.md", { summary: "readme" }, "host", At);
        assert.equal(Object.keys(repository.load("root.1")).length, 2);
        assert.equal(repository.delete("root.1", "src/a.ts"), true);
        assert.equal(repository.delete("root.1", "src/a.ts"), false);
        assert.deepEqual(repository.load("root.1"), { "README.md": { summary: "readme" } });
    });
});

test("write journal appends auto ids and lists newest first per session", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: FileWriteRepository = new FileWriteRepository(db);
        const first: WriteJournalEntry = {
            id: "w.1",
            sessionId: "s.1",
            rootId: "root.1",
            path: "a.ts",
            mode: "create",
            previousFingerprint: null,
            nextFingerprint: "sha256:one",
            bytes: 5n,
            at: At,
        };
        const second: WriteJournalEntry = {
            ...first,
            id: "w.2",
            mode: "overwrite",
            previousFingerprint: "sha256:one",
            nextFingerprint: "sha256:two",
            bytes: 7n,
            at: Later,
        };
        const third: WriteJournalEntry = { ...first, id: "w.3", sessionId: "s.2", rootId: "root.2", path: "b.ts", nextFingerprint: "sha256:three" };
        repository.append(first, "root.1");
        repository.append(second, "root.1");
        repository.append(third, "root.2");

        const rows: FileWriteRow[] = repository.list("s.1", 10);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].next_fingerprint, "sha256:two");
        assert.equal(rows[0].mode, "overwrite");
        assert.equal(rows[0].bytes, "7");
        assert.ok(rows[0].write_id > rows[1].write_id);
        assert.equal(rows[1].previous_fingerprint, null);
        assert.equal(rows[1].root_id, "root.1");
        assert.equal(repository.list("s.1", 1).length, 1);
        assert.equal(repository.list("s.2", 10).length, 1);
        assert.equal(repository.list("s.1", 0).length, 0);
        assert.equal(repository.list("s.3", 10).length, 0);
        assert.throws((): void => {
            repository.list("s.1", -1);
        }, RangeError);
        assert.throws((): void => {
            repository.append({ ...first, mode: "bogus" as unknown as WriteJournalEntry["mode"] }, "root.1");
        }, /invalid write mode/);
        assert.throws((): void => {
            repository.append({ ...first, bytes: -1n }, "root.1");
        }, RangeError);
        assert.equal(repository.list("s.1", 10).length, 2);
    });
});

test("outlines cache by fingerprint and never return a stale parse", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: FileOutlineRepository = new FileOutlineRepository(db);
        const outline: OutlineResult = outlineOf();
        repository.save("root.1", outline, At);
        assert.deepEqual(repository.load("root.1", "src/a.ts", "sha256:file-a"), outline);
        assert.equal(repository.load("root.1", "src/a.ts", "sha256:other"), (void 0));
        assert.equal(repository.load("root.2", "src/a.ts", "sha256:file-a"), (void 0));

        const updated: OutlineResult = {
            ...outline,
            language: "typescript",
            truncated: true,
            nodes: [
                {
                    isFile: false,
                    isDirectory: false,
                    path: "src/a.ts#next",
                    type: "class",
                    range: { startByte: 20n, endByte: 40n, startLine: 5n, endLine: 9n },
                    label: "next",
                    depth: 0,
                    children: [],
                },
            ],
        };
        repository.save("root.1", updated, Later);
        assert.deepEqual(repository.load("root.1", "src/a.ts", "sha256:file-a"), updated);
    });
});

test("imports and exports replace by file while other files keep their cache", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: FileGraphRepository = new FileGraphRepository(db);
        const report: ImportReport = importReport("src/a.ts", "sha256:file-a");
        repository.replaceImports("root.1", report, At);
        const loaded: ImportReport | undefined = repository.loadImports("root.1", "src/a.ts", "sha256:file-a");
        assert.ok(loaded);
        assert.equal(loaded.path, "src/a.ts");
        assert.equal(loaded.fingerprint, "sha256:file-a");
        assert.deepEqual(loaded.imports, report.imports);
        assert.deepEqual(loaded.importedBy, []);
        assert.deepEqual(loaded.external, ["react"]);
        assert.deepEqual(loaded.unresolved, ["@missing"]);
        assert.equal(loaded.truncated, false);
        assert.equal(repository.loadImports("root.1", "src/a.ts", "sha256:stale"), (void 0));
        assert.equal(repository.loadImports("root.1", "src/missing.ts", "sha256:file-a"), (void 0));

        const other: ImportReport = importReport("src/b.ts", "sha256:file-b");
        repository.replaceImports("root.1", other, At);
        const updated: ImportReport = { ...report, fingerprint: "sha256:file-a2", imports: [report.imports[0]], external: [], unresolved: [] };
        repository.replaceImports("root.1", updated, Later);
        const reloaded: ImportReport | undefined = repository.loadImports("root.1", "src/a.ts", "sha256:file-a2");
        assert.ok(reloaded);
        assert.equal(reloaded.imports.length, 1);
        assert.equal(reloaded.imports[0].specifier, "./b");
        assert.equal(repository.loadImports("root.1", "src/a.ts", "sha256:file-a"), (void 0));
        assert.equal(repository.loadImports("root.1", "src/b.ts", "sha256:file-b")?.imports.length, 3);

        const exports: ExportReport = exportReport();
        repository.replaceExports("root.1", exports, At);
        const loadedExports: ExportReport | undefined = repository.loadExports("root.1", "src/a.ts", "sha256:file-a");
        assert.ok(loadedExports);
        assert.deepEqual(loadedExports.exports, exports.exports);
        assert.equal(loadedExports.reexports.length, 1);
        assert.equal(loadedExports.reexports[0].specifier, "./b");
        assert.equal(loadedExports.reexports[0].kind, "export-from");
        assert.equal(loadedExports.truncated, false);
        assert.equal(repository.loadExports("root.1", "src/a.ts", "sha256:stale"), (void 0));

        const withoutReexport: ExportReport = {
            ...exports,
            exports: [exports.exports[0]],
            reexports: [],
        };
        repository.replaceExports("root.1", withoutReexport, Later);
        assert.deepEqual(repository.loadExports("root.1", "src/a.ts", "sha256:file-a")?.exports, withoutReexport.exports);
        assert.deepEqual(repository.loadExports("root.1", "src/a.ts", "sha256:file-a")?.reexports, []);
    });
});

test("dependency edges round-trip and the revision lives in meta", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: FileGraphRepository = new FileGraphRepository(db);
        const graph: DependencyGraph = {
            nodes: [
                { id: "file:src/a.ts", path: "src/a.ts", kind: "file", fingerprint: "sha256:file-a" },
                { id: "file:src/b.ts", path: "src/b.ts", kind: "file", fingerprint: "sha256:file-b" },
                { id: "package:react", path: "react", kind: "package", fingerprint: "" },
                { id: "src/isolated.ts", path: "src/isolated.ts", kind: "file", fingerprint: "sha256:isolated" },
            ],
            edges: [
                { from: "file:src/a.ts", to: "file:src/b.ts", kind: "import", specifier: "./b", line: 1 },
                { from: "file:src/a.ts", to: "package:react", kind: "package", specifier: "react" },
                { from: "src/raw.ts", to: "external:react", kind: "package", specifier: "react" },
                { from: "directory:src", to: "file:src/a.ts", kind: "reference" },
            ],
        };
        repository.replaceDependencies("root.1", graph, At);
        const loaded: DependencyGraph | undefined = repository.loadDependencies("root.1");
        assert.ok(loaded);
        assert.equal(loaded.edges.length, 4);
        const internal: DependencyEdge | undefined = loaded.edges.find((edge): boolean => edge.to === "file:src/b.ts");
        const external: DependencyEdge | undefined = loaded.edges.find((edge): boolean => edge.to === "package:react");
        const raw: DependencyEdge | undefined = loaded.edges.find((edge): boolean => edge.from === "src/raw.ts");
        const directory: DependencyEdge | undefined = loaded.edges.find((edge): boolean => edge.from === "directory:src");
        assert.ok(internal);
        assert.ok(external);
        assert.ok(raw);
        assert.ok(directory);
        assert.equal(internal.from, "file:src/a.ts");
        assert.equal(internal.kind, "import");
        assert.equal(internal.specifier, "./b");
        assert.equal(internal.line, 1);
        assert.equal(external.kind, "package");
        assert.equal(external.specifier, "react");
        assert.equal(external.line, (void 0));
        assert.equal(raw.to, "external:react");
        assert.equal(raw.specifier, "react");
        assert.equal(directory.to, "file:src/a.ts");
        assert.equal(directory.kind, "reference");
        const nodeIds: string[] = loaded.nodes.map((node): string => node.id);
        assert.deepEqual(nodeIds, ["directory:src", "external:react", "file:src/a.ts", "file:src/b.ts", "package:react", "src/isolated.ts", "src/raw.ts"]);
        assert.equal(loaded.nodes[0].kind, "directory");
        assert.equal(loaded.nodes[0].path, "src");
        assert.equal(loaded.nodes[1].kind, "package");
        assert.equal(loaded.nodes[1].path, "react");
        assert.equal(loaded.nodes[4].kind, "package");
        assert.equal(loaded.nodes[4].path, "react");
        assert.equal(loaded.nodes[5].id, "src/isolated.ts");
        assert.equal(loaded.nodes[5].fingerprint, "sha256:isolated");
        assert.equal(loaded.nodes[6].kind, "file");
        assert.equal(loaded.nodes[6].path, "src/raw.ts");
        assert.equal(loaded.nodes[2].path, "src/a.ts");

        assert.equal(repository.loadRevision("root.1"), (void 0));
        repository.saveRevision("root.1", "dep-rev-1");
        assert.equal(repository.loadRevision("root.1"), "dep-rev-1");
        repository.saveRevision("root.1", "dep-rev-2");
        assert.equal(repository.loadRevision("root.1"), "dep-rev-2");
        assert.equal(repository.loadRevision("root.2"), (void 0));

        repository.replaceDependencies("root.1", { nodes: [], edges: [] }, Later);
        assert.equal(repository.loadDependencies("root.1"), (void 0));
        repository.replaceDependencies("root.1", { nodes: [{ id: "only.ts", path: "only.ts", kind: "file", fingerprint: "sha256:only" }], edges: [] }, Later);
        const onlyNode: DependencyGraph | undefined = repository.loadDependencies("root.1");
        assert.ok(onlyNode);
        assert.deepEqual(onlyNode.edges, []);
        assert.equal(onlyNode.nodes.length, 1);
        assert.equal(onlyNode.nodes[0].id, "only.ts");
        assert.equal(onlyNode.nodes[0].fingerprint, "sha256:only");
    });
});

test("two sessions keep context, roots and write journals isolated", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const sessions: WorkspaceSessionRepository = new WorkspaceSessionRepository(db);
        sessions.save(sessionOf("s.1", "agent.1", [rootOf("root.1", "C:/one", true, [])]), "sha256:1");
        sessions.save(sessionOf("s.2", "agent.2", [rootOf("root.2", "C:/two", true, [])]), "sha256:2");
        const first: SessionContextEntry = { namespace: "ns", key: "k", value: { owner: "s.1" }, bytes: 11, updatedAt: At };
        const second: SessionContextEntry = { namespace: "ns", key: "k", value: { owner: "s.2" }, bytes: 11, updatedAt: At };
        sessions.putContext("s.1", first);
        sessions.putContext("s.2", second);
        assert.deepEqual(sessions.loadContext("s.1"), [first]);
        assert.deepEqual(sessions.loadContext("s.2"), [second]);
        assert.equal(sessions.findRoots("s.1")[0].id, "root.1");
        assert.equal(sessions.findRoots("s.2")[0].id, "root.2");

        const writes: FileWriteRepository = new FileWriteRepository(db);
        const journal: WriteJournalEntry = {
            id: "w",
            sessionId: "s.1",
            rootId: "root.1",
            path: "only-one.ts",
            mode: "create",
            previousFingerprint: null,
            nextFingerprint: "sha256:only",
            bytes: 1n,
            at: At,
        };
        writes.append(journal, "root.1");
        writes.append({ ...journal, sessionId: "s.2", rootId: "root.2", path: "only-two.ts" }, "root.2");
        assert.equal(writes.list("s.1", 10).length, 1);
        assert.equal(writes.list("s.1", 10)[0].path, "only-one.ts");
        assert.equal(writes.list("s.2", 10)[0].path, "only-two.ts");

        assert.equal(sessions.delete("s.1"), true);
        assert.equal(sessions.load("s.1"), (void 0));
        assert.equal(sessions.loadContext("s.1").length, 0);
        assert.equal(sessions.load("s.2")?.agentId, "agent.2");
        assert.deepEqual(sessions.loadContext("s.2"), [second]);
    });
});

test("session and context adapters implement their ports over one database", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const store: SessionStore = new SqliteWorkspaceSessionStore(db);
        const contextStore: SessionContextStore = new SqliteWorkspaceSessionContextStore(db);
        const descriptor: SessionDescriptor = sessionOf("s.adapter", "agent.adapter", [rootOf("root.adapter", "C:/adapter", true, [])], {
            parentId: "s.parent",
            revision: 3,
            metadata: { mode: "adapter" },
        });
        store.save(descriptor, "sha256:adapter-secret");
        assert.deepEqual(store.load("s.adapter"), descriptor);
        assert.equal(store.loadSecret("s.adapter"), "sha256:adapter-secret");
        assert.equal(store.list("agent.adapter").length, 1);
        assert.equal(store.list().length, 1);

        const first: SessionContextEntry = { namespace: "ns", key: "a", value: { one: 1 }, bytes: 9, updatedAt: At };
        const second: SessionContextEntry = { namespace: "ns", key: "b", value: [1, 2, 3], bytes: 7, updatedAt: Later };
        contextStore.put("s.adapter", first);
        assert.deepEqual(contextStore.load("s.adapter"), [first]);
        contextStore.replace("s.adapter", [first, second]);
        assert.deepEqual(contextStore.load("s.adapter"), [first, second]);
        assert.equal(contextStore.delete("s.adapter", "ns", "a"), true);
        assert.deepEqual(contextStore.load("s.adapter"), [second]);
        contextStore.deleteSession("s.adapter");
        assert.deepEqual(contextStore.load("s.adapter"), []);
        assert.equal(store.delete("s.adapter"), true);
        assert.equal(store.load("s.adapter"), (void 0));
    });
});

test("filesystem adapter round-trips tree, annotations, journal, outline, graphs and revision", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const store: FilesystemStore = new SqliteFilesystemStore(db);
        assert.equal(store.loadTree("root.1"), (void 0));
        const snapshot: TreeSnapshot = treeFixture();
        store.saveTree("root.1", snapshot);
        assert.deepEqual(store.loadTree("root.1"), snapshot);
        const loaded: TreeSnapshot | undefined = store.loadTree("root.1");
        assert.ok(loaded);
        assert.equal(loaded.root.children[0].type, "Directory");
        assert.equal(loaded.root.lines, 15n);
        assert.equal(loaded.stats.files, 2n);
        assert.equal(loaded.stats.bytes, 385n);
        const truncatedTree: TreeSnapshot = { ...treeFixture(), stats: { ...treeFixture().stats, truncated: true } };
        store.saveTree("root.truncated", truncatedTree);
        assert.deepEqual(store.loadTree("root.truncated"), truncatedTree);

        store.saveAnnotation("root.1", "src/a.ts", { description: "adapter note" }, "host");
        assert.deepEqual(store.loadAnnotations("root.1"), { "src/a.ts": { description: "adapter note" } });

        const journal: WriteJournalEntry = {
            id: "1",
            sessionId: "s.1",
            rootId: "root.1",
            path: "src/a.ts",
            mode: "create",
            previousFingerprint: null,
            nextFingerprint: "sha256:file-a",
            bytes: 345n,
            at: At,
        };
        store.appendWrite(journal);
        assert.deepEqual(store.listWrites("s.1", 10), [journal]);
        assert.equal(store.listWrites("s.2", 10).length, 0);

        const outline: OutlineResult = outlineOf();
        store.saveOutline("root.1", outline);
        assert.deepEqual(store.loadOutline("root.1", "src/a.ts", "sha256:file-a"), outline);
        assert.equal(store.loadOutline("root.1", "src/a.ts", "sha256:stale"), (void 0));

        const report: ImportReport = { ...importReport("src/a.ts", "sha256:file-a"), truncated: true };
        store.saveImports("root.1", report);
        const imports: ImportReport | undefined = store.loadImports("root.1", "src/a.ts", "sha256:file-a");
        assert.ok(imports);
        assert.deepEqual(imports.imports, report.imports);
        assert.deepEqual(imports.external, ["react"]);
        assert.equal(imports.truncated, true);
        assert.equal(store.loadImports("root.1", "src/a.ts", "sha256:stale"), (void 0));

        const exported: ExportReport = { ...exportReport(), truncated: true };
        store.saveExports("root.1", exported);
        const loadedExports: ExportReport | undefined = store.loadExports("root.1", "src/a.ts", "sha256:file-a");
        assert.ok(loadedExports);
        assert.deepEqual(loadedExports.exports, exported.exports);
        assert.deepEqual(loadedExports.reexports, exported.reexports);
        assert.equal(loadedExports.truncated, true);
        assert.equal(store.loadExports("root.1", "src/a.ts", "sha256:stale"), (void 0));

        assert.equal(store.loadDependencyRevision("root.1"), (void 0));
        store.saveDependencyRevision("root.1", "dep-rev-1");
        assert.equal(store.loadDependencyRevision("root.1"), "dep-rev-1");
        store.saveDependencyRevision("root.1", "dep-rev-2");
        assert.equal(store.loadDependencyRevision("root.1"), "dep-rev-2");
        assert.equal(store.loadDependencyRevision("root.2"), (void 0));

        const empty: TreeSnapshot = {
            root: dirOf(".", [], 0n, 0n, "sha256:empty"),
            revision: "rev-3",
            stats: { files: 0n, directories: 1n, lines: 0n, bytes: 0n, truncated: false },
        };
        store.saveTree("root.1", empty);
        assert.deepEqual(store.loadTree("root.1"), empty);
    });
});

test("file-backed store keeps sessions and trees across close and reopen", (): void => {
    const directory: string = mkdtempSync(join(tmpdir(), "amp-workspace-db-"));
    const path: string = join(directory, "store.sqlite");
    try {
        const first: DatabaseSync = openStore(path);
        try {
            const sessions: SqliteWorkspaceSessionStore = new SqliteWorkspaceSessionStore(first);
            sessions.save(sessionOf("s.persist", "agent.persist", [rootOf("root.persist", "C:/persist", true, [])]), "sha256:persist");
            new SqliteFilesystemStore(first).saveTree("root.persist", treeFixture());
        } finally {
            closeStore(first);
        }
        const second: DatabaseSync = openStore(path);
        try {
            const sessions: SqliteWorkspaceSessionStore = new SqliteWorkspaceSessionStore(second);
            const descriptor: SessionDescriptor | undefined = sessions.load("s.persist");
            assert.ok(descriptor);
            assert.equal(descriptor.agentId, "agent.persist");
            assert.equal(sessions.loadSecret("s.persist"), "sha256:persist");
            const filesystem: SqliteFilesystemStore = new SqliteFilesystemStore(second);
            assert.equal(filesystem.loadTree("root.persist")?.stats.files, 2n);
            assert.equal(filesystem.loadTree("root.persist")?.revision, "rev-1");
        } finally {
            closeStore(second);
        }
    } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
});

test("failed session, root and context writes roll back to the previous state", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: WorkspaceSessionRepository = new WorkspaceSessionRepository(db);
        const firstRoot: SessionRoot = rootOf("root.tx", "C:/tx", true, []);
        const secondRoot: SessionRoot = rootOf("root.tx2", "C:/tx2", false, []);
        const original: SessionDescriptor = sessionOf("s.tx", "agent.tx", [firstRoot, secondRoot], {
            label: "original",
            revision: 2,
            metadata: { note: "before" },
        });
        repository.save(original, "sha256:before");
        const duplicateRootId: SessionDescriptor = {
            ...original,
            label: "invalid",
            revision: 99,
            roots: [firstRoot, rootOf("root.tx", "C:/tx3", true, [])],
        };
        assert.throws((): void => {
            repository.save(duplicateRootId, "sha256:after");
        }, /UNIQUE constraint failed|PRIMARY KEY/);
        assert.deepEqual(repository.load("s.tx"), original);
        assert.equal(repository.loadSecret("s.tx"), "sha256:before");
        assert.equal(repository.findRoots("s.tx").length, 2);

        const foreign: SessionDescriptor = sessionOf("s.tx.other", "agent.other", [rootOf("root.tx", "C:/elsewhere", true, [])]);
        assert.throws((): void => {
            repository.save(foreign, "sha256:other");
        }, /UNIQUE constraint failed|PRIMARY KEY/);
        assert.equal(repository.load("s.tx.other"), (void 0));
        assert.deepEqual(repository.findRoots("s.tx"), [firstRoot, secondRoot]);

        const noRoots: SessionDescriptor = sessionOf("s.empty", "agent.empty", [], { metadata: {} });
        repository.save(noRoots, "sha256:empty");
        assert.deepEqual(repository.load("s.empty"), noRoots);
        assert.equal(repository.findRoots("s.empty").length, 0);

        const kept: SessionContextEntry = { namespace: "ns", key: "k", value: { ok: true }, bytes: 11, updatedAt: At };
        repository.putContext("s.tx", kept);
        const bad: SessionContextEntry = { namespace: "ns", key: "bad", value: 1n as unknown as SessionContextEntry["value"], bytes: 1, updatedAt: At };
        assert.throws((): void => {
            repository.replaceContext("s.tx", [bad]);
        }, TypeError);
        assert.deepEqual(repository.loadContext("s.tx"), [kept]);
        const nulNamespace: SessionContextEntry = { namespace: "a\u0000b", key: "c", value: 1, bytes: 1, updatedAt: At };
        assert.throws((): void => {
            repository.putContext("s.tx", nulNamespace);
        }, /U\+0000/);
        assert.deepEqual(repository.loadContext("s.tx"), [kept]);
        repository.replaceContext("s.tx", []);
        assert.deepEqual(repository.loadContext("s.tx"), []);
    });
});

test("counters beyond Number.MAX_SAFE_INTEGER survive TEXT columns exactly", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const hugeLines: bigint = 9007199254740993n;
        const hugeBytes: bigint = 9223372036854775807n;
        const hugeFile: FileNode = fileOf("huge.ts", "sha256:huge", hugeLines, hugeBytes);
        const snapshot: TreeSnapshot = {
            root: dirOf(".", [hugeFile], hugeLines, hugeBytes, "sha256:huge-root"),
            revision: "rev-huge",
            stats: { files: 1n, directories: 1n, lines: hugeLines, bytes: hugeBytes, truncated: false },
        };
        const nodes: FileNodeRepository = new FileNodeRepository(db);
        nodes.replaceTree("root.huge", snapshot, At);
        const row: FileNodeRow | undefined = nodes.findNode("root.huge", "huge.ts");
        assert.ok(row);
        assert.equal(row.lines, "9007199254740993");
        assert.equal(row.bytes, "9223372036854775807");
        const filesystem: FilesystemStore = new SqliteFilesystemStore(db);
        assert.deepEqual(filesystem.loadTree("root.huge"), snapshot);

        const outline: OutlineResult = {
            path: "huge.ts",
            fingerprint: "sha256:huge",
            language: "typescript",
            strategy: "typescript",
            category: "code",
            target: "file",
            charset: "utf-8",
            nodes: [
                {
                    isFile: false,
                    isDirectory: false,
                    path: "huge.ts#big",
                    type: "function",
                    range: { startByte: 9223372036854775808n, endByte: 18446744073709551616n, startLine: hugeLines, endLine: hugeLines + 2n },
                    label: "big",
                    depth: 0,
                    children: [],
                },
            ],
            truncated: false,
        };
        const outlines: FileOutlineRepository = new FileOutlineRepository(db);
        outlines.save("root.huge", outline, At);
        assert.deepEqual(outlines.load("root.huge", "huge.ts", "sha256:huge"), outline);

        const journal: WriteJournalEntry = {
            id: "w.huge",
            sessionId: "s.huge",
            rootId: "root.huge",
            path: "huge.ts",
            mode: "create",
            previousFingerprint: null,
            nextFingerprint: "sha256:huge",
            bytes: 18446744073709551616n,
            at: At,
        };
        filesystem.appendWrite(journal);
        assert.equal(filesystem.listWrites("s.huge", 1)[0].bytes, 18446744073709551616n);
    });
});

test("deep and wide trees fit the recursion and ordering bounds", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const segments: string[] = [];
        for (let index: number = 0; index < 64; index += 1) {
            segments.push(`d${index}`);
        }
        const leafPath: string = `${segments.join("/")}/leaf.ts`;
        let node: TreeNode = fileOf(leafPath, "sha256:deep-leaf", 1n, 1n);
        for (let index: number = segments.length - 1; index >= 0; index -= 1) {
            const parentPath: string = segments.slice(0, index + 1).join("/");
            node = dirOf(parentPath, [node], 1n, 1n, `sha256:${parentPath}`);
        }
        const wide: number = 200;
        const children: TreeNode[] = [node];
        for (let index: number = 0; index < wide; index += 1) {
            children.push(fileOf(`f${1000 + index}.ts`, `sha256:wide-${index}`, 1n, 1n));
        }
        const lines: bigint = BigInt(wide + 1);
        const snapshot: TreeSnapshot = {
            root: dirOf(".", children, lines, lines, "sha256:deep-root"),
            revision: "rev-deep",
            stats: { files: BigInt(wide + 1), directories: BigInt(segments.length + 1), lines, bytes: lines, truncated: false },
        };
        const repository: FileNodeRepository = new FileNodeRepository(db);
        repository.replaceTree("root.deep", snapshot, At);
        assert.equal(repository.count("root.deep"), wide + 1 + segments.length + 1);
        const leaf: FileNodeRow | undefined = repository.findNode("root.deep", leafPath);
        assert.ok(leaf);
        assert.equal(leaf.lines, "1");
        assert.equal(repository.children("root.deep", ".").length, wide + 1);
        assert.equal(repository.children("root.deep", ".")[0].path, "d0");

        const store: FilesystemStore = new SqliteFilesystemStore(db);
        const loaded: TreeSnapshot | undefined = store.loadTree("root.deep");
        assert.ok(loaded);
        assert.deepEqual(loaded, snapshot);
        let cursor: DirectoryNode = loaded.root;
        for (let index: number = 0; index < segments.length; index += 1) {
            const next: TreeNode = cursor.children[0];
            assert.equal(next.type, "Directory");
            cursor = next as DirectoryNode;
        }
        assert.equal(cursor.children[0].path, leafPath);
    });
});

test("duplicate node paths abort the tree replace without losing the old rows", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: FileNodeRepository = new FileNodeRepository(db);
        repository.replaceTree("root.1", treeFixture(), At);
        const duplicate: TreeSnapshot = {
            root: dirOf(".", [fileOf("dup.ts", "sha256:one", 1n, 1n), fileOf("dup.ts", "sha256:two", 1n, 1n)], 2n, 2n, "sha256:dup"),
            revision: "rev-dup",
            stats: { files: 2n, directories: 1n, lines: 2n, bytes: 2n, truncated: false },
        };
        assert.throws((): void => {
            repository.replaceTree("root.1", duplicate, Later);
        }, /UNIQUE constraint failed|PRIMARY KEY/);
        assert.equal(repository.count("root.1"), 4);
        assert.equal(repository.findNode("root.1", "src/a.ts")?.fingerprint, "sha256:file-a");
        assert.equal(repository.findNode("root.1", "dup.ts"), (void 0));
    });
});

test("quoted, unicode and SQL-looking values round-trip without changing the schema", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: WorkspaceSessionRepository = new WorkspaceSessionRepository(db);
        const descriptor: SessionDescriptor = sessionOf(
            "s.quote",
            "agent.quote",
            [rootOf("root.quote", 'C:/项目/"quoted"', true, ["node_modules", "目录/子"])],
            {
                label: "label 'quoted' 会话 🚀",
                revision: 7,
                metadata: { quote: "it's", newline: "a\nb" },
            },
        );
        repository.save(descriptor, "sha256:'quote'");
        assert.deepEqual(repository.load("s.quote"), descriptor);

        const context: SessionContextEntry = {
            namespace: "ns'\"\n",
            key: "k; DROP TABLE session_context; --",
            value: { text: "'; DROP TABLE session_context; --" },
            bytes: 0,
            updatedAt: At,
        };
        repository.putContext("s.quote", context);
        assert.deepEqual(repository.loadContext("s.quote"), [context]);
        assert.equal(repository.deleteContext("s.quote", context.namespace, context.key), true);

        const path: string = "src/o'brien; DROP TABLE file_nodes; --.ts";
        const nodes: FileNodeRepository = new FileNodeRepository(db);
        nodes.replaceTree(
            "root.quote",
            {
                root: dirOf(".", [fileOf(path, "sha256:quote", 0n, 0n)], 0n, 0n, "sha256:quote-root"),
                revision: "rev-quote",
                stats: { files: 1n, directories: 1n, lines: 0n, bytes: 0n, truncated: false },
            },
            At,
        );
        const row: FileNodeRow | undefined = nodes.findNode("root.quote", path);
        assert.ok(row);
        assert.equal(row.fingerprint, "sha256:quote");
        const annotations: FileAnnotationRepository = new FileAnnotationRepository(db);
        annotations.upsert("root.quote", path, { description: "'; DELETE FROM file_annotations; --" }, "host", At);
        assert.equal(annotations.load("root.quote")[path].description, "'; DELETE FROM file_annotations; --");
        const names: string[] = tableNames(db);
        assert.ok(names.includes("file_nodes"));
        assert.ok(names.includes("file_annotations"));
        assert.ok(names.includes("session_context"));
    });
});

test("empty and duplicate graph inputs are cached through report headers", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const repository: FileGraphRepository = new FileGraphRepository(db);
        const emptyImports: ImportReport = {
            path: "empty.ts",
            fingerprint: "sha256:empty",
            imports: [],
            importedBy: [],
            external: [],
            unresolved: [],
            truncated: true,
        };
        repository.replaceImports("root.1", emptyImports, At);
        const loadedEmptyImports: ImportReport | undefined = repository.loadImports("root.1", "empty.ts", "sha256:empty");
        assert.ok(loadedEmptyImports);
        assert.deepEqual(loadedEmptyImports.imports, []);
        assert.deepEqual(loadedEmptyImports.importedBy, []);
        assert.deepEqual(loadedEmptyImports.external, []);
        assert.deepEqual(loadedEmptyImports.unresolved, []);
        assert.equal(loadedEmptyImports.truncated, true);
        assert.equal(repository.loadImports("root.1", "empty.ts", "sha256:stale"), (void 0));

        const edge: ImportEdge = { from: "dup.ts", to: "b.ts", specifier: "./b", kind: "static", line: 1, resolved: true, external: false };
        const duplicateImports: ImportReport = { ...emptyImports, path: "dup.ts", fingerprint: "sha256:dup", imports: [edge, edge], truncated: false };
        repository.replaceImports("root.1", duplicateImports, At);
        assert.equal(repository.loadImports("root.1", "dup.ts", "sha256:dup")?.imports.length, 1);
        const inconsistent: ImportReport = { ...emptyImports, path: "scope.ts", fingerprint: "sha256:scope", imports: [edge] };
        assert.throws((): void => {
            repository.replaceImports("root.1", inconsistent, At);
        }, /does not belong to report/);
        assert.equal(repository.loadImports("root.1", "scope.ts", "sha256:scope"), (void 0));

        const emptyExports: ExportReport = { path: "empty.ts", fingerprint: "sha256:empty", exports: [], reexports: [], truncated: true };
        repository.replaceExports("root.1", emptyExports, At);
        const loadedEmptyExports: ExportReport | undefined = repository.loadExports("root.1", "empty.ts", "sha256:empty");
        assert.ok(loadedEmptyExports);
        assert.deepEqual(loadedEmptyExports.exports, []);
        assert.deepEqual(loadedEmptyExports.reexports, []);
        assert.equal(loadedEmptyExports.truncated, true);
        assert.equal(repository.loadExports("root.1", "empty.ts", "sha256:stale"), (void 0));

        const reexportEdge: ImportEdge = { from: "dup.ts", to: "x.ts", specifier: "./x", kind: "export-from", line: 5, resolved: true, external: false };
        const duplicateReexports: ExportReport = {
            path: "dup.ts",
            fingerprint: "sha256:dup",
            exports: [
                { name: "a", kind: "reexport", line: 5, signature: "", reexportFrom: "./x" },
                { name: "b", kind: "reexport", line: 5, signature: "", reexportFrom: "./x" },
            ],
            reexports: [reexportEdge],
            truncated: true,
        };
        repository.replaceExports("root.1", duplicateReexports, At);
        const loadedExports: ExportReport | undefined = repository.loadExports("root.1", "dup.ts", "sha256:dup");
        assert.ok(loadedExports);
        assert.equal(loadedExports.exports.length, 2);
        assert.deepEqual(loadedExports.reexports, [reexportEdge]);
        assert.equal(loadedExports.truncated, true);

        const selfEdge: DependencyEdge = { from: "file:a.ts", to: "file:a.ts", kind: "reference" };
        repository.replaceDependencies("root.1", { nodes: [], edges: [selfEdge, selfEdge] }, At);
        const loaded: DependencyGraph | undefined = repository.loadDependencies("root.1");
        assert.ok(loaded);
        assert.equal(loaded.edges.length, 1);
        assert.equal(loaded.edges[0].from, loaded.edges[0].to);
        assert.equal(loaded.nodes.length, 1);
        repository.replaceDependencies("root.1", { nodes: [], edges: [] }, At);
        assert.equal(repository.loadDependencies("root.1"), (void 0));
    });
});

test("empty annotation, empty outline and zero-byte journal entries round-trip", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const annotations: FileAnnotationRepository = new FileAnnotationRepository(db);
        annotations.upsert("root.1", "empty.md", {}, "host", At);
        assert.deepEqual(annotations.load("root.1"), { "empty.md": {} });
        const outlines: FileOutlineRepository = new FileOutlineRepository(db);
        const emptyOutline: OutlineResult = {
            path: "empty.md",
            fingerprint: "sha256:empty",
            language: "markdown",
            strategy: "plainText",
            category: "prose",
            target: "file",
            charset: "utf-8",
            nodes: [],
            truncated: false,
        };
        outlines.save("root.1", emptyOutline, At);
        assert.deepEqual(outlines.load("root.1", "empty.md", "sha256:empty"), emptyOutline);
        const store: FilesystemStore = new SqliteFilesystemStore(db);
        store.appendWrite({
            id: "1",
            sessionId: "s.zero",
            rootId: "root.1",
            path: "empty.md",
            mode: "create",
            previousFingerprint: null,
            nextFingerprint: "sha256:empty",
            bytes: 0n,
            at: At,
        });
        const entries: WriteJournalEntry[] = store.listWrites("s.zero", 10);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].bytes, 0n);
    });
});

test("tree truncation survives reload and malformed persisted rows fail closed", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const store: FilesystemStore = new SqliteFilesystemStore(db);
        const truncated: TreeSnapshot = { ...treeFixture(), stats: { ...treeFixture().stats, truncated: true } };
        store.saveTree("root.trunc", truncated);
        assert.deepEqual(store.loadTree("root.trunc"), truncated);
        assert.equal(store.loadTree("root.trunc")?.stats.truncated, true);

        const nodes: FileNodeRepository = new FileNodeRepository(db);
        assert.equal(nodes.loadTruncated("root.trunc"), true);
        nodes.deleteTree("root.trunc");
        assert.equal(nodes.loadTruncated("root.trunc"), false);
        assert.equal(store.loadTree("root.trunc"), (void 0));
        nodes.replaceTree("root.neg", treeFixture(), At);
        const negative: TreeSnapshot = {
            root: dirOf(".", [fileOf("neg.ts", "sha256:neg", -1n, -1n)], 0n, 0n, "sha256:neg"),
            revision: "rev-neg",
            stats: { files: 1n, directories: 1n, lines: 0n, bytes: 0n, truncated: false },
        };
        assert.throws((): void => {
            nodes.replaceTree("root.neg", negative, Later);
        }, RangeError);
        assert.equal(nodes.count("root.neg"), 4);
        assert.equal(nodes.findNode("root.neg", "src/a.ts")?.fingerprint, "sha256:file-a");

        nodes.replaceTree("root.multi", treeFixture(), At);
        const rootRow: FileNodeRow | undefined = nodes.findNode("root.multi", ".");
        assert.ok(rootRow);
        nodes.insert({ ...rootRow, node_id: "root.multi\u0000other", path: "other", name: "other", parent_path: null });
        assert.throws((): void => {
            store.loadTree("root.multi");
        }, /multiple root nodes/);

        nodes.replaceTree("root.ext", treeFixture(), At);
        const directoryRow: FileNodeRow | undefined = nodes.findNode("root.ext", "src");
        assert.ok(directoryRow);
        nodes.insert({ ...directoryRow, node_id: "root.ext\u0000bad", path: "bad", name: "bad", extension: "ts", parent_path: "." });
        assert.throws((): void => {
            store.loadTree("root.ext");
        }, /invalid directory extension/);
    });
});

test("NUL separators are rejected in tree, annotation and outline ids", (): void => {
    withDatabase((db: DatabaseSync): void => {
        const nodes: FileNodeRepository = new FileNodeRepository(db);
        const nulTree: TreeSnapshot = {
            root: dirOf(".", [fileOf("a\u0000b.ts", "sha256:nul", 0n, 0n)], 0n, 0n, "sha256:nul"),
            revision: "rev-nul",
            stats: { files: 1n, directories: 1n, lines: 0n, bytes: 0n, truncated: false },
        };
        assert.throws((): void => {
            nodes.replaceTree("root.nul", nulTree, At);
        }, /U\+0000/);
        assert.equal(nodes.count("root.nul"), 0);

        const annotations: FileAnnotationRepository = new FileAnnotationRepository(db);
        assert.throws((): void => {
            annotations.upsert("root.1", "a\u0000b.ts", {}, "host", At);
        }, /U\+0000/);
        assert.deepEqual(annotations.load("root.1"), {});

        const outlines: FileOutlineRepository = new FileOutlineRepository(db);
        assert.throws((): void => {
            outlines.save("root.1", { ...outlineOf(), path: "a\u0000b.ts" }, At);
        }, /U\+0000/);
        assert.equal(outlines.load("root.1", "a\u0000b.ts", "sha256:file-a"), (void 0));
    });
});
