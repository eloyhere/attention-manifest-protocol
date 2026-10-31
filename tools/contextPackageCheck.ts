#!/usr/bin/env node
/**
 * Context package boundary checks.
 *
 * The suite has three parts:
 *   1. `ContextPackage`/`ContextBuilder` behavior over a deterministic fake
 *      session: budgets, duplicates, ordering, relations, scope, determinism
 *      and a 1000+ node timing run;
 *   2. read-only compatibility with a real `FilesystemSession` bound to a
 *      temporary root, including error-code propagation;
 *   3. the audit of the existing context layer: `ContextAst.view` charging,
 *      `estimateTokens` roughness, `WorkspaceIndex.summaryState` caching and
 *      `ContextIndex` LRU statistics.
 *
 * Fixtures live under `os.tmpdir()` and are removed by the `after` hook. The
 * fake session implements exactly the builder's read-only interface, so the
 * test never relies on a hook-layer adapter.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { estimateTokens } from "../src/context/agentContext.ts";
import { ContextAst } from "../src/context/ast.ts";
import type { ContextAstView } from "../src/context/ast.ts";
import { ContextBuilder } from "../src/context/contextBuilder.ts";
import type { ContextBuilderSession } from "../src/context/contextBuilder.ts";
import { ContextIndex } from "../src/context/contextIndex.ts";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import { clampSummary, renderContextRelation, toContextRange } from "../src/context/contextPackage.ts";
import type { ContextItem, ContextOmission, ContextPackage, ContextRelation } from "../src/context/contextPackage.ts";
import { WorkspaceIndex } from "../src/context/workspace.ts";
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import type { DependencyQuery, ExportRequest, ImportRequest, OutlineRequest } from "../src/file/service.ts";
import { FilesystemService } from "../src/file/service.ts";
import type { FilesystemSession } from "../src/file/service.ts";
import type { DependencyEdge, DependencyMode, DependencyNode, DependencyReport, DirectoryNode, ExportReport, ExportSymbol, FileNode, ImportEdge, ImportKind, ImportReport, ReadPage, ReadRequest } from "../src/file/types.ts";
import type { OutlineNode, OutlineRange, OutlineResult } from "../src/outline/types.ts";
import { SessionRegistry } from "../src/session/registry.ts";
import type { SessionDescriptor } from "../src/session/types.ts";

/**
 * Temporary sandbox for the real-service test.
 */
const Sandbox: string = mkdtempSync(join(tmpdir(), "amp-context-package-"));

after((): void => {
    rmSync(Sandbox, { recursive: true, force: true });
});

/**
 * One import edge in a fake file.
 */
interface FakeImport {
    readonly to: string;
    readonly specifier: string;
    readonly kind: ImportKind;
    readonly line: number;
    readonly external?: boolean;
    readonly resolved?: boolean;
}

/**
 * One exported symbol in a fake file.
 */
interface FakeExport {
    readonly name: string;
    readonly kind: ExportSymbol["kind"];
    readonly line: number;
    readonly signature: string;
}

/**
 * One outline symbol in a fake file.
 */
interface FakeSymbol {
    readonly name: string;
    readonly line: number;
    readonly endLine: number;
    readonly kind?: OutlineNode["type"];
    readonly detail?: string;
    readonly children?: readonly FakeSymbol[];
}

/**
 * One fake file.
 */
interface FakeFile {
    readonly text: string;
    readonly description?: string;
    readonly summary?: string;
    readonly purpose?: string;
    readonly imports?: readonly FakeImport[];
    readonly exports?: readonly FakeExport[];
    readonly reexports?: readonly FakeImport[];
    readonly symbols?: readonly FakeSymbol[];
}

/**
 * One dependency graph fixture.
 */
interface FakeGraph {
    readonly nodes: readonly DependencyNode[];
    readonly edges: readonly DependencyEdge[];
    readonly roots: readonly string[];
    readonly order?: readonly string[];
    readonly cycles?: readonly (readonly string[])[];
    readonly truncated?: boolean;
}

/**
 * A fake-session error carrying a classified filesystem code.
 */
interface FakeError extends Error {
    readonly code: string;
}

/**
 * Mutable import-method view used by the retry test.
 */
interface ImportsOverride {
    imports: (request: ImportRequest) => ImportReport;
}

/**
 * Mutable export-method view used by the retry test.
 */
interface ExportsOverride {
    exports: (request: ExportRequest) => ExportReport;
}

/**
 * Optional anchor payloads, deleted to simulate a lean outline.
 */
interface LeanOutlineAnchor {
    file?: FileNode;
    directory?: DirectoryNode;
}

/**
 * Function shape of the directory-node projection.
 */
type DirectoryNodeFn = (path: string, children: readonly (FileNode | DirectoryNode)[]) => DirectoryNode;

/**
 * Function shape of the symbol-tree projection.
 */
type SymbolNodeFn = (filePath: string, symbol: FakeSymbol, depth: number, parentPath: string) => OutlineNode;

/**
 * Function shape of the file-outline projection.
 */
type FileOutlineFn = (path: string, file: FakeFile, maxNodes: number) => OutlineResult;

/**
 * Function shape of the directory-outline projection.
 */
type DirectoryOutlineFn = (files: Map<string, FakeFile>, dirs: readonly string[], path: string, maxNodes: number) => OutlineResult;

/**
 * Build one classified fake-session error.
 *
 * @param code - Filesystem error code.
 * @returns An error carrying the code.
 */
const fakeError: (code: string) => FakeError = (code: string): FakeError => {
    return Object.assign(new Error(code), { code });
};

/**
 * Deterministic fingerprint for a fake path.
 *
 * @param path - Root-relative path.
 * @returns A `sha256:` ref.
 */
const fingerprintOf: (path: string) => string = (path: string): string => {
    const hex: string = Buffer.from(path, "utf8").toString("hex");
    return `sha256:${hex.padEnd(64, "0").slice(0, 64)}`;
};

/**
 * Number of lines in a fake file.
 *
 * @param text - File text.
 * @returns At least 1.
 */
const lineCount: (text: string) => number = (text: string): number => Math.max(1, text.split("\n").length);

/**
 * Full-file outline range.
 *
 * @param text - File text.
 * @returns Range covering the whole file.
 */
const fullRange: (text: string) => OutlineRange = (text: string): OutlineRange => ({
    startByte: BigInt(0),
    endByte: BigInt(Buffer.byteLength(text)),
    startLine: BigInt(1),
    endLine: BigInt(lineCount(text)),
});

/**
 * File node metadata for a fake path.
 *
 * @param path - Root-relative path.
 * @param file - Fake file.
 * @returns A complete `FileNode`.
 */
const fileNodeOf: (path: string, file: FakeFile) => FileNode = (path: string, file: FakeFile): FileNode => {
    const name: string = path.slice(path.lastIndexOf("/") + 1);
    const dot: number = name.lastIndexOf(".");
    return {
        type: "File",
        path,
        name,
        extension: dot < 0 ? "" : name.slice(dot + 1),
        children: [],
        fingerprint: fingerprintOf(path),
        charset: "utf-8",
        lines: BigInt(lineCount(file.text)),
        bytes: BigInt(Buffer.byteLength(file.text)),
        create: "2026-10-30T00:00:00",
        modify: "2026-10-30T00:00:00",
        description: file.description ?? "",
        summary: file.summary ?? "",
        purpose: file.purpose ?? "",
    };
};

/**
 * Directory node metadata for a fake path.
 *
 * @param path - Root-relative directory path.
 * @param children - Direct child nodes.
 * @returns A complete `DirectoryNode`.
 */
const directoryNodeOf: DirectoryNodeFn = (path: string, children: readonly (FileNode | DirectoryNode)[]): DirectoryNode => {
    let lines: bigint = BigInt(0);
    let bytes: bigint = BigInt(0);
    children.forEach((child: FileNode | DirectoryNode): void => {
        lines += child.lines;
        bytes += child.bytes;
    });
    return {
        type: "Directory",
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        extension: "directory",
        children,
        fingerprint: fingerprintOf(path),
        charset: "none",
        lines,
        bytes,
        create: "2026-10-30T00:00:00",
        modify: "2026-10-30T00:00:00",
        description: "",
        summary: "",
        purpose: "",
    };
};

/**
 * Convert one fake symbol tree into outline nodes.
 *
 * @param filePath - File path used for the `#` suffix.
 * @param symbol - Fake symbol.
 * @param depth - 1-based outline depth.
 * @param parentPath - Dotted parent path.
 * @returns The anchored outline node.
 */
const symbolNodeOf: SymbolNodeFn = (filePath: string, symbol: FakeSymbol, depth: number, parentPath: string): OutlineNode => {
    const symbolPath: string = parentPath.length === 0 ? symbol.name : `${parentPath}.${symbol.name}`;
    const children: readonly FakeSymbol[] = symbol.children ?? [];
    return {
        isFile: false,
        isDirectory: false,
        path: `${filePath}#${symbolPath}`,
        type: symbol.kind ?? "function",
        range: {
            startByte: BigInt(0),
            endByte: BigInt(0),
            startLine: BigInt(symbol.line),
            endLine: BigInt(symbol.endLine),
        },
        label: symbol.name,
        depth,
        ...(symbol.detail === (void 0) ? {} : { detail: symbol.detail }),
        children: children.map((child: FakeSymbol): OutlineNode => symbolNodeOf(filePath, child, depth + 1, symbolPath)),
    };
};

/**
 * Convert one fake file into an outline result.
 *
 * @param path - File path.
 * @param file - Fake file.
 * @param maxNodes - Node ceiling.
 * @returns A file-anchored outline.
 */
const fileOutlineOf: FileOutlineFn = (path: string, file: FakeFile, maxNodes: number): OutlineResult => {
    const node: FileNode = fileNodeOf(path, file);
    const symbols: readonly FakeSymbol[] = file.symbols ?? [];
    const children: OutlineNode[] = [];
    let count: number = 1;
    let truncated: boolean = false;
    for (let index: number = 0; index < symbols.length; index += 1) {
        if (count >= maxNodes) {
            truncated = true;
            break;
        }
        children.push(symbolNodeOf(path, symbols[index], 1, ""));
        count += 1;
    }
    return {
        path,
        fingerprint: node.fingerprint,
        language: "typescript",
        strategy: "typescript",
        category: "code",
        target: "file",
        charset: "utf-8",
        nodes: [
            {
                isFile: true,
                isDirectory: false,
                file: node,
                path,
                type: "File",
                range: fullRange(file.text),
                label: node.name,
                depth: 0,
                children,
            },
        ],
        truncated,
    };
};

/**
 * Convert fake files and directories into a directory outline.
 *
 * @param files - Fake files by path.
 * @param directories - Known directory paths.
 * @param path - Directory path to outline.
 * @param maxNodes - Node ceiling.
 * @returns A directory-anchored outline.
 */
const directoryOutlineOf: DirectoryOutlineFn = (files: Map<string, FakeFile>, dirs: readonly string[], path: string, maxNodes: number): OutlineResult => {
    const prefix: string = path.length === 0 ? "" : `${path}/`;
    const children: Array<FileNode | DirectoryNode> = [];
    files.forEach((file: FakeFile, filePath: string): void => {
        if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/")) {
            children.push(fileNodeOf(filePath, file));
        }
    });
    dirs.forEach((directory: string): void => {
        if (directory !== path && directory.startsWith(prefix) && !directory.slice(prefix.length).includes("/")) {
            children.push(directoryNodeOf(directory, []));
        }
    });
    children.sort((left: FileNode | DirectoryNode, right: FileNode | DirectoryNode): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const directory: DirectoryNode = directoryNodeOf(path, children);
    const anchors: OutlineNode[] = [];
    let truncated: boolean = false;
    for (let index: number = 0; index < children.length; index += 1) {
        if (anchors.length + 1 >= maxNodes) {
            truncated = true;
            break;
        }
        const child: FileNode | DirectoryNode = children[index];
        if (child.type === "File") {
            anchors.push({
                isFile: true,
                isDirectory: false,
                file: child,
                path: child.path,
                type: "File",
                range: { startByte: BigInt(0), endByte: child.bytes, startLine: BigInt(1), endLine: child.lines },
                label: child.name,
                depth: 1,
                children: [],
            });
        } else {
            anchors.push({
                isFile: false,
                isDirectory: true,
                directory: child,
                path: child.path,
                type: "Directory",
                range: { startByte: BigInt(0), endByte: child.bytes, startLine: BigInt(1), endLine: child.lines },
                label: child.name,
                depth: 1,
                children: [],
            });
        }
    }
    return {
        path,
        fingerprint: directory.fingerprint,
        language: "directory",
        strategy: "directory",
        category: "other",
        target: "directory",
        charset: "none",
        nodes: [
            {
                isFile: false,
                isDirectory: true,
                directory,
                path,
                type: "Directory",
                range: { startByte: BigInt(0), endByte: directory.bytes, startLine: BigInt(1), endLine: directory.lines },
                label: directory.name,
                depth: 0,
                children: anchors,
            },
        ],
        truncated,
    };
};

/**
 * Strip file/directory payloads from every outline anchor.
 *
 * @param result - Complete directory outline.
 * @returns A lean outline whose anchors carry only path/label/range.
 */
const stripOutlinePayloads: (result: OutlineResult) => OutlineResult = (result: OutlineResult): OutlineResult => {
    const strip: (node: OutlineNode) => OutlineNode = (node: OutlineNode): OutlineNode => {
        const copy: OutlineNode = { ...node, children: node.children.map(strip) };
        delete (copy as LeanOutlineAnchor).file;
        delete (copy as LeanOutlineAnchor).directory;
        return copy;
    };
    return { ...result, nodes: result.nodes.map(strip) };
};

/**
 * Build one import edge.
 *
 * @param from - Importing path.
 * @param specifier - Fake import specifier.
 * @returns A complete `ImportEdge`.
 */
const importEdgeOf: (from: string, specifier: FakeImport) => ImportEdge = (from: string, specifier: FakeImport): ImportEdge => {
    return {
        from,
        to: specifier.to,
        specifier: specifier.specifier,
        kind: specifier.kind,
        line: specifier.line,
        resolved: specifier.resolved !== false,
        external: specifier.external === true,
    };
};

/**
 * Build a session descriptor for a fake session.
 *
 * @param sessionId - Session id, also used as the descriptor id.
 * @param read - Read permission.
 * @returns A complete descriptor.
 */
const descriptorOf: (sessionId: string, read: boolean) => SessionDescriptor = (sessionId: string, read: boolean): SessionDescriptor => ({
    id: sessionId,
    agentId: "agent.context-test",
    label: "context test",
    status: "active",
    roots: [{ id: "root.context-test", path: "C:\\fake\\context-test", writable: false, exclude: [] }],
    permissions: {
        read,
        write: false,
        create: false,
        remove: false,
        maxReadBytes: 65_536,
        maxWriteBytes: 0,
        maxTreeNodes: 20_000,
        maxContextEntries: 100,
        maxContextBytes: 100_000,
    },
    createdAt: "2026-10-30T00:00:00.000Z",
    expiresAt: "2026-10-31T00:00:00.000Z",
    idleExpiresAt: "2026-10-31T00:00:00.000Z",
    revision: 0,
    metadata: {},
});

/**
 * Deterministic in-memory session that implements only the builder contract.
 */
class FakeSession implements ContextBuilderSession {
    readonly sessionId: string;
    readonly descriptor: SessionDescriptor;
    readonly files: Map<string, FakeFile>;
    readonly directories: readonly string[];
    readonly calls: string[] = [];
    graph: FakeGraph = { nodes: [], edges: [], roots: [] };
    revisionValue: string = "rev.1";
    /**
     * When true, directory outlines omit the `file`/`directory` payloads so the
     * lean-anchor fallback can be exercised.
     */
    leanAnchors: boolean = false;

    /**
     * @param sessionId - Session id.
     * @param files - Files by root-relative path.
     * @param directories - Directory paths; files imply their ancestors.
     * @param read - Read permission to expose on the descriptor.
     */
    constructor(sessionId: string, files: Map<string, FakeFile>, directories: readonly string[], read: boolean = true) {
        this.sessionId = sessionId;
        this.descriptor = descriptorOf(sessionId, read);
        this.files = files;
        this.directories = directories;
    }

    revision(): string {
        this.calls.push("revision");
        return this.revisionValue;
    }

    read(request: ReadRequest): ReadPage {
        this.calls.push("read");
        const file: FakeFile | undefined = this.files.get(request.path);
        if (file === (void 0)) {
            throw fakeError("not_found");
        }
        const lines: string[] = file.text.split(/\r?\n/u);
        const start: number = request.startLine ?? 1;
        const maxLines: number = request.maxLines ?? lines.length;
        const end: number = Math.min(lines.length, start - 1 + maxLines);
        const text: string = lines.slice(start - 1, end).join("\n");
        return {
            path: request.path,
            fingerprint: fingerprintOf(request.path),
            charset: "utf-8",
            offset: 0,
            startLine: start,
            endLine: Math.max(start, end),
            totalLines: BigInt(lines.length),
            bytesRead: Buffer.byteLength(text),
            totalBytes: BigInt(Buffer.byteLength(file.text)),
            text,
            nextStartLine: end < lines.length ? end + 1 : null,
            truncated: end < lines.length,
            binary: false,
        };
    }

    outline(request: OutlineRequest): OutlineResult {
        this.calls.push("outline");
        const maxNodes: number = request.maxNodes ?? 256;
        const file: FakeFile | undefined = this.files.get(request.path);
        if (file !== (void 0)) {
            return fileOutlineOf(request.path, file, maxNodes);
        }
        if (this.directories.includes(request.path)) {
            const result: OutlineResult = directoryOutlineOf(this.files, this.directories, request.path, maxNodes);
            return this.leanAnchors ? stripOutlinePayloads(result) : result;
        }
        throw fakeError("not_found");
    }

    imports(request: ImportRequest): ImportReport {
        this.calls.push("imports");
        const file: FakeFile | undefined = this.files.get(request.path);
        if (file === (void 0)) {
            throw fakeError("not_found");
        }
        const outgoing: ImportEdge[] = (file.imports ?? []).map((specifier: FakeImport): ImportEdge => importEdgeOf(request.path, specifier));
        const incoming: ImportEdge[] = [];
        if (request.direction === "incoming" || request.direction === "both") {
            this.files.forEach((other: FakeFile, otherPath: string): void => {
                (other.imports ?? []).forEach((specifier: FakeImport): void => {
                    if (specifier.resolved === false || specifier.external === true || specifier.to !== request.path || otherPath === request.path) {
                        return;
                    }
                    incoming.push(importEdgeOf(otherPath, specifier));
                });
            });
        }
        const limit: number = Math.max(1, request.limit ?? 200);
        return {
            path: request.path,
            fingerprint: fingerprintOf(request.path),
            imports: outgoing,
            importedBy: incoming.slice(0, limit),
            external: outgoing.filter((edge: ImportEdge): boolean => edge.external).map((edge: ImportEdge): string => edge.specifier),
            unresolved: outgoing.filter((edge: ImportEdge): boolean => !edge.resolved && !edge.external).map((edge: ImportEdge): string => edge.specifier),
            truncated: false,
        };
    }

    exports(request: ExportRequest): ExportReport {
        this.calls.push("exports");
        const file: FakeFile | undefined = this.files.get(request.path);
        if (file === (void 0)) {
            throw fakeError("not_found");
        }
        return {
            path: request.path,
            fingerprint: fingerprintOf(request.path),
            exports: (file.exports ?? []).map((symbol: FakeExport): ExportSymbol => ({
                name: symbol.name,
                kind: symbol.kind,
                line: symbol.line,
                signature: symbol.signature,
            })),
            reexports: (file.reexports ?? []).map((specifier: FakeImport): ImportEdge => importEdgeOf(request.path, specifier)),
            truncated: false,
        };
    }

    dependency(request: DependencyQuery): DependencyReport {
        this.calls.push("dependency");
        return {
            revision: this.revisionValue,
            mode: request.mode as DependencyMode,
            roots: request.roots ?? this.graph.roots,
            nodes: this.graph.nodes,
            edges: this.graph.edges,
            order: this.graph.order ?? [],
            cycles: this.graph.cycles ?? [],
            unresolved: [],
            external: this.graph.nodes.filter((node: DependencyNode): boolean => node.kind === "package").map((node: DependencyNode): string => node.path),
            truncated: this.graph.truncated === true,
        };
    }
}

/**
 * Build a fake file map from path/content pairs.
 *
 * @param entries - Path and content pairs.
 * @returns A mutable file map.
 */
const filesOf: (entries: readonly (readonly [string, FakeFile])[]) => Map<string, FakeFile> = (
    entries: readonly (readonly [string, FakeFile])[],
): Map<string, FakeFile> => {
    const files: Map<string, FakeFile> = new Map<string, FakeFile>();
    entries.forEach((entry: readonly [string, FakeFile]): void => {
        files.set(entry[0], entry[1]);
    });
    return files;
};

/**
 * Small fixture used by most builder tests.
 *
 * @returns A fresh fake session.
 */
const sessionOf: () => FakeSession = (): FakeSession => {
    const files: Map<string, FakeFile> = filesOf([
        [
            "src/a.ts",
            {
                text: 'import { b } from "./b";\n\nexport const alpha = 1;\n\nexport const inner = 2;\n',
                summary: "entry module",
                imports: [{ to: "src/b.ts", specifier: "./b", kind: "static", line: 1 }],
                exports: [{ name: "alpha", kind: "const", line: 3, signature: "export const alpha = 1" }],
                symbols: [
                    { name: "alpha", line: 3, endLine: 3, detail: "const alpha" },
                    { name: "inner", line: 5, endLine: 5, children: [{ name: "leaf", line: 5, endLine: 5, kind: "method" }] },
                ],
            },
        ],
        [
            "src/b.ts",
            {
                text: 'import { c } from "./c";\n\nexport const beta = 2;\n',
                imports: [{ to: "src/c.ts", specifier: "./c", kind: "static", line: 1 }],
                symbols: [{ name: "beta", line: 3, endLine: 3 }],
            },
        ],
        ["src/c.ts", { text: "export const gamma = 3;\n" }],
        ["README.md", { text: "# Guide\n\nContext package guide.\n" }],
    ]);
    return new FakeSession("session.fake", files, ["src"]);
};

/**
 * Read the classified code off a thrown value.
 *
 * @param error - Thrown value.
 * @returns The `code` property, or `""`.
 */
const codeOf: (error: unknown) => string = (error: unknown): string => {
    if (typeof(error) === "object" && error !== null && "code" in error) {
        return `${error.code}`;
    }
    return "";
};

/**
 * Assert that an action throws the expected classified code.
 *
 * @param action - Action to run.
 * @param code - Expected code.
 */
const expectCode: (action: () => void, code: string) => void = (action: () => void, code: string): void => {
    try {
        action();
    } catch (error: unknown) {
        assert.equal(codeOf(error), code);
        return;
    }
    assert.fail(`expected throw with code ${code}`);
};

/**
 * Collect the ids of one package's items.
 *
 * @param pkg - Package to inspect.
 * @returns Item ids in prompt order.
 */
const itemIds: (pkg: ContextPackage) => string[] = (pkg: ContextPackage): string[] => pkg.items.map((item: ContextItem): string => item.id);

/**
 * Build with a very large budget and return the package.
 *
 * @param builder - Configured builder.
 * @returns All admitted items and relations.
 */
const fullPackage: (builder: ContextBuilder) => ContextPackage = (builder: ContextBuilder): ContextPackage => builder.build();

test("empty builder returns an empty, fully frozen package", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 100 });
    const pkg: ContextPackage = builder.build();
    assert.equal(pkg.sessionId, "session.fake");
    assert.equal(pkg.revision, "rev.1");
    assert.equal(pkg.budgetTokens, 100);
    assert.equal(pkg.usedTokens, 0);
    assert.deepEqual(pkg.items, []);
    assert.deepEqual(pkg.omitted, []);
    assert.deepEqual(pkg.relations, []);
    assert.equal(pkg.text, "");
    assert.equal(pkg.truncated, false);
    assert.ok(Object.isFrozen(pkg));
    assert.ok(Object.isFrozen(pkg.items));
});

test("budget 1 admits nothing and reports a budget omission", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 1 });
    builder.addNote("intent", "assemble a context package for the change request");
    const pkg: ContextPackage = builder.build();
    assert.deepEqual(pkg.items, []);
    assert.equal(pkg.usedTokens, 0);
    assert.equal(pkg.text, "");
    assert.equal(pkg.truncated, true);
    assert.deepEqual(
        pkg.omitted.map((omission: ContextOmission): string => `${omission.reason}:${omission.id}`),
        ["budget:note:intent"],
    );
});

test("an exact budget admits every scored item and charges the exact sum", (): void => {
    const session: FakeSession = sessionOf();
    const wide: ContextPackage = fullPackage(
        ((): ContextBuilder => {
            const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 100_000, includeRelations: false });
            builder.addFile("src/a.ts");
            builder.addNote("intent", "exact fit");
            return builder;
        })(),
    );
    assert.ok(wide.items.length >= 2);
    const exact: ContextBuilder = new ContextBuilder({ session, budgetTokens: wide.usedTokens, includeRelations: false });
    exact.addFile("src/a.ts");
    exact.addNote("intent", "exact fit");
    const pkg: ContextPackage = exact.build();
    assert.deepEqual(itemIds(pkg), itemIds(wide));
    assert.equal(pkg.usedTokens, wide.usedTokens);
    assert.equal(pkg.usedTokens, pkg.budgetTokens);
    assert.deepEqual(pkg.omitted, []);
    assert.equal(pkg.truncated, false);
});

test("one token below the exact budget drops the lowest-ranked item", (): void => {
    const session: FakeSession = sessionOf();
    const wideBuilder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 100_000, includeRelations: false });
    wideBuilder.addFile("src/a.ts");
    wideBuilder.addNote("intent", "one short");
    const wide: ContextPackage = wideBuilder.build();
    const budget: number = wide.usedTokens - 1;
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: budget, includeRelations: false });
    builder.addFile("src/a.ts");
    builder.addNote("intent", "one short");
    const pkg: ContextPackage = builder.build();
    const dropped: ContextOmission[] = pkg.omitted.filter((omission: ContextOmission): boolean => omission.reason === "budget");
    assert.equal(dropped.length, 1);
    const droppedItem: ContextItem | undefined = wide.items.find((item: ContextItem): boolean => item.id === dropped[0].id);
    assert.ok(droppedItem !== (void 0));
    assert.equal(pkg.items.length, wide.items.length - 1);
    assert.equal(pkg.usedTokens, wide.usedTokens - droppedItem.tokens);
    assert.ok(pkg.usedTokens <= budget);
    assert.equal(dropped[0].requiredIds, (void 0));
    assert.equal(pkg.truncated, true);
    assert.ok(pkg.text.length > 0);
    const relationCost: number = pkg.relations.reduce(
        (sum: number, relation: ContextRelation): number => sum + estimateTokens(renderContextRelation(relation)),
        0,
    );
    assert.equal(pkg.usedTokens, pkg.items.reduce((sum: number, item: ContextItem): number => sum + item.tokens, 0) + relationCost);
});

test("a 1000-character note is clamped to 400 characters, never shortened later", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addNote("long", "word ".repeat(300));
    const pkg: ContextPackage = builder.build();
    assert.equal(pkg.items.length, 1);
    assert.equal(pkg.items[0].summary.length, 400);
    assert.ok(pkg.items[0].summary.endsWith("..."));
    assert.equal(clampSummary("   "), "");
});

test("duplicate ids are kept once and reported as duplicates", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addFile("src/a.ts");
    builder.addFile("src/a.ts");
    builder.addNote("intent", "same note");
    builder.addNote("intent", "same note");
    const pkg: ContextPackage = builder.build();
    assert.deepEqual(itemIds(pkg).sort(), ["file:src/a.ts", "note:intent"]);
    const duplicates: ContextOmission[] = pkg.omitted.filter((omission: ContextOmission): boolean => omission.reason === "duplicate");
    assert.deepEqual(duplicates.map((omission: ContextOmission): string => omission.id).sort(), ["file:src/a.ts", "note:intent"]);
    assert.deepEqual(duplicates.map((omission: ContextOmission): readonly string[] => omission.requiredIds ?? []).sort(), [["file:src/a.ts"], ["note:intent"]]);
    assert.equal(pkg.truncated, false);
});

test("equal scores sort by path and are independent of insertion order", (): void => {
    const first: FakeSession = sessionOf();
    const second: FakeSession = sessionOf();
    const forward: ContextBuilder = new ContextBuilder({ session: first, budgetTokens: 10_000, includeRelations: false });
    forward.addFile("src/a.ts");
    forward.addFile("src/b.ts");
    const reverse: ContextBuilder = new ContextBuilder({ session: second, budgetTokens: 10_000, includeRelations: false });
    reverse.addFile("src/b.ts");
    reverse.addFile("src/a.ts");
    const left: ContextPackage = forward.build();
    const right: ContextPackage = reverse.build();
    assert.deepEqual(itemIds(left), ["file:src/a.ts", "file:src/b.ts"]);
    assert.deepEqual(itemIds(right), ["file:src/a.ts", "file:src/b.ts"]);
    assert.equal(JSON.stringify(left), JSON.stringify(right));
});

test("file, outline and imports close their relations over selected items", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addFile("src/a.ts");
    builder.addOutline("src/a.ts");
    builder.addImports("src/a.ts", { direction: "outgoing", depth: 2 });
    const pkg: ContextPackage = builder.build();
    const ids: Set<string> = new Set<string>(itemIds(pkg));
    assert.ok(ids.has("file:src/a.ts"));
    assert.ok(ids.has("file:src/b.ts"));
    assert.ok(ids.has("file:src/c.ts"));
    assert.ok(ids.has("outline:src/a.ts#alpha@3"));
    assert.ok(ids.has("outline:src/a.ts#inner@5"));
    assert.ok(ids.has("outline:src/a.ts#inner.leaf@5"));
    const edges: string[] = pkg.relations.map((relation: ContextRelation): string => `${relation.kind}:${relation.from}->${relation.to}`);
    assert.ok(edges.includes("import:file:src/a.ts->file:src/b.ts"));
    assert.ok(edges.includes("import:file:src/b.ts->file:src/c.ts"));
    assert.ok(edges.includes("contains:file:src/a.ts->outline:src/a.ts#alpha@3"));
    assert.ok(edges.includes("contains:outline:src/a.ts#inner@5->outline:src/a.ts#inner.leaf@5"));
    pkg.relations.forEach((relation: ContextRelation): void => {
        assert.ok(ids.has(relation.from), `missing from endpoint ${relation.from}`);
        assert.ok(ids.has(relation.to), `missing to endpoint ${relation.to}`);
    });
    const reached: Set<string> = new Set<string>(["file:src/a.ts"]);
    let changed: boolean = true;
    while (changed) {
        changed = false;
        pkg.relations.forEach((relation: ContextRelation): void => {
            if (relation.kind === "import" && reached.has(relation.from) && !reached.has(relation.to)) {
                reached.add(relation.to);
                changed = true;
            }
        });
    }
    assert.ok(reached.has("file:src/c.ts"));
});

test("unresolved and external import endpoints become missing/outside_scope omissions", (): void => {
    const files: Map<string, FakeFile> = filesOf([
        [
            "src/a.ts",
            {
                text: 'import fs from "node:fs";\nimport { nope } from "./missing";\n',
                imports: [
                    { to: "node:fs", specifier: "node:fs", kind: "static", line: 1, external: true },
                    { to: "src/missing.ts", specifier: "./missing", kind: "static", line: 2, resolved: false },
                ],
            },
        ],
    ]);
    const session: FakeSession = new FakeSession("session.scope", files, ["src"]);
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addFile("src/a.ts");
    builder.addImports("src/a.ts", { direction: "outgoing", depth: 1 });
    const pkg: ContextPackage = builder.build();
    const missing: ContextOmission[] = pkg.omitted.filter((omission: ContextOmission): boolean => omission.reason === "missing");
    const outside: ContextOmission[] = pkg.omitted.filter((omission: ContextOmission): boolean => omission.reason === "outside_scope");
    assert.deepEqual(
        missing.map((omission: ContextOmission): string => omission.id),
        ["file:src/missing.ts"],
    );
    assert.deepEqual(
        outside.map((omission: ContextOmission): string => omission.id),
        ["external:node:fs"],
    );
    assert.deepEqual(missing[0].requiredIds, ["file:src/a.ts"]);
    assert.deepEqual(outside[0].requiredIds, ["file:src/a.ts"]);
    assert.equal(pkg.truncated, true);
    const relations: string[] = pkg.relations.map((relation: ContextRelation): string => `${relation.kind}:${relation.from}->${relation.to}`);
    assert.equal(
        relations.some((edge: string): boolean => edge.includes("external:") || edge.includes("missing")),
        false,
    );
});

test("endpoint omissions disappear when their requiring item is not selected", (): void => {
    const files: Map<string, FakeFile> = filesOf([
        ["src/a.ts", { text: 'import fs from "node:fs";\n', imports: [{ to: "node:fs", specifier: "node:fs", kind: "static", line: 1, external: true }] }],
    ]);
    const session: FakeSession = new FakeSession("session.scope", files, ["src"]);
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 1 });
    builder.addImports("src/a.ts", { direction: "outgoing", depth: 1 });
    const pkg: ContextPackage = builder.build();
    assert.equal(
        pkg.omitted.some((omission: ContextOmission): boolean => omission.reason === "outside_scope"),
        false,
    );
    assert.equal(
        pkg.omitted.some((omission: ContextOmission): boolean => omission.reason === "budget"),
        true,
    );
});

test("dependency edges close between selected module items and drop packages as outside scope", (): void => {
    const session: FakeSession = sessionOf();
    session.graph = {
        nodes: [
            { id: "src/a.ts", path: "src/a.ts", kind: "file", fingerprint: "" },
            { id: "src/b.ts", path: "src/b.ts", kind: "file", fingerprint: "" },
            { id: "external:left-pad", path: "left-pad", kind: "package", fingerprint: "" },
        ],
        edges: [
            { from: "src/a.ts", to: "src/b.ts", kind: "import" },
            { from: "src/a.ts", to: "external:left-pad", kind: "package", specifier: "left-pad" },
        ],
        roots: ["src/a.ts"],
        order: ["src/a.ts", "src/b.ts"],
        cycles: [["src/a.ts", "src/b.ts"]],
    };
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addFile("src/a.ts");
    builder.addFile("src/b.ts");
    builder.addDependency({ mode: "closure", roots: ["src/a.ts"], depth: 2 });
    const pkg: ContextPackage = builder.build();
    const ids: Set<string> = new Set<string>(itemIds(pkg));
    assert.ok(ids.has("file:src/a.ts"));
    assert.ok(ids.has("file:src/b.ts"));
    const edges: string[] = pkg.relations.map((relation: ContextRelation): string => `${relation.kind}:${relation.from}->${relation.to}`);
    assert.ok(edges.includes("dependency:file:src/a.ts->file:src/b.ts"));
    assert.equal(
        edges.some((edge: string): boolean => edge.includes("external:")),
        false,
    );
    const outside: ContextOmission[] = pkg.omitted.filter((omission: ContextOmission): boolean => omission.reason === "outside_scope");
    assert.deepEqual(
        outside.map((omission: ContextOmission): string => omission.id),
        ["external:left-pad"],
    );
    assert.deepEqual(outside[0].requiredIds, ["file:src/a.ts"]);
    const anchored: ContextItem | undefined = pkg.items.find((item: ContextItem): boolean => item.id === "file:src/a.ts");
    assert.ok(anchored !== (void 0));
    assert.match(anchored.why, /dependency: closure/);
    assert.match(anchored.why, /cycle 1/);
    assert.match(anchored.why, /order 1/);
});

test("includeRelations=false omits edges but keeps endpoint omissions", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000, includeRelations: false });
    builder.addFile("src/a.ts");
    builder.addOutline("src/a.ts");
    builder.addImports("src/a.ts", { direction: "outgoing", depth: 1 });
    const pkg: ContextPackage = builder.build();
    assert.deepEqual(pkg.relations, []);
    assert.doesNotMatch(pkg.text, /\[relation:/);
    assert.equal(
        pkg.omitted.some((omission: ContextOmission): boolean => omission.reason === "outside_scope"),
        false,
    );
});

test("directory expansion emits tree items and contains edges", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addDirectory("src", 1);
    const pkg: ContextPackage = builder.build();
    const ids: string[] = itemIds(pkg);
    assert.ok(ids.includes("directory:src"));
    assert.ok(ids.includes("file:src/a.ts"));
    assert.ok(ids.includes("file:src/b.ts"));
    assert.ok(ids.includes("file:src/c.ts"));
    const edges: string[] = pkg.relations.map((relation: ContextRelation): string => `${relation.kind}:${relation.from}->${relation.to}`);
    assert.ok(edges.includes("contains:directory:src->file:src/a.ts"));
    const directory: ContextItem | undefined = pkg.items.find((item: ContextItem): boolean => item.id === "directory:src");
    assert.ok(directory !== (void 0));
    assert.match(directory.summary, /entries/);
});

test("a deep directory outline follows the requested depth ceiling", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000, maxDepth: 1 });
    builder.addDirectory("src", 5);
    const pkg: ContextPackage = builder.build();
    assert.ok(itemIds(pkg).includes("directory:src"));
    assert.ok(itemIds(pkg).includes("file:src/a.ts"));
});

test("outline filters use label prefix and line windows without turning misses into items", (): void => {
    const session: FakeSession = sessionOf();
    const byQuery: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    byQuery.addOutline("src/a.ts", { query: "inn" });
    const queryPackage: ContextPackage = byQuery.build();
    const queryIds: string[] = itemIds(queryPackage);
    assert.ok(queryIds.includes("outline:src/a.ts#inner@5"));
    assert.equal(queryIds.includes("outline:src/a.ts#inner.leaf@5"), false);
    assert.equal(queryIds.includes("outline:src/a.ts#alpha@3"), false);
    const byRange: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    byRange.addOutline("src/a.ts", { startLine: 3, endLine: 3 });
    const rangePackage: ContextPackage = byRange.build();
    assert.ok(itemIds(rangePackage).includes("outline:src/a.ts#alpha@3"));
    assert.equal(itemIds(rangePackage).includes("outline:src/a.ts#inner@5"), false);
    const empty: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    empty.addOutline("src/a.ts", { query: "zzz" });
    const emptyPackage: ContextPackage = empty.build();
    assert.deepEqual(itemIds(emptyPackage), ["file:src/a.ts"]);
    assert.deepEqual(emptyPackage.omitted, []);
    assert.equal(emptyPackage.truncated, false);
});

test("outline items carry a JSON-safe range and a bounded score", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addOutline("src/a.ts");
    const pkg: ContextPackage = builder.build();
    const symbol: ContextItem | undefined = pkg.items.find((item: ContextItem): boolean => item.id === "outline:src/a.ts#alpha@3");
    assert.ok(symbol !== (void 0));
    assert.deepEqual(symbol.range, { startLine: 3, endLine: 3 });
    assert.equal(typeof(symbol.score), "number");
    assert.ok(symbol.tokens >= 1);
    assert.ok(symbol.score > 0);
    assert.match(symbol.provenance, /outline/);
});

test("export items attach to their file and external re-exports are out of scope", (): void => {
    const files: Map<string, FakeFile> = filesOf([
        [
            "src/a.ts",
            {
                text: 'export { b } from "./b";\nexport * from "react";\nexport const alpha = 1;\n',
                exports: [{ name: "alpha", kind: "const", line: 3, signature: "export const alpha = 1" }],
                reexports: [
                    { to: "src/b.ts", specifier: "./b", kind: "export-from", line: 1 },
                    { to: "react", specifier: "react", kind: "export-from", line: 2, external: true },
                ],
            },
        ],
        ["src/b.ts", { text: "export const beta = 2;\n" }],
    ]);
    const session: FakeSession = new FakeSession("session.export", files, ["src"]);
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addFile("src/a.ts");
    builder.addExports("src/a.ts");
    const pkg: ContextPackage = builder.build();
    const exportIds: string[] = itemIds(pkg).filter((id: string): boolean => id.startsWith("export:"));
    assert.deepEqual(exportIds, ["export:src/a.ts#alpha@3", "export:src/a.ts#reexport@1", "export:src/a.ts#reexport@2"]);
    const edges: string[] = pkg.relations.map((relation: ContextRelation): string => `${relation.kind}:${relation.from}->${relation.to}`);
    assert.ok(edges.includes("contains:file:src/a.ts->export:src/a.ts#alpha@3"));
    const reexport: ContextItem | undefined = pkg.items.find((item: ContextItem): boolean => item.id === "export:src/a.ts#reexport@1");
    assert.ok(reexport !== (void 0));
    assert.deepEqual(reexport.range, { startLine: 1, endLine: 1 });
    const outside: ContextOmission[] = pkg.omitted.filter((omission: ContextOmission): boolean => omission.reason === "outside_scope");
    assert.deepEqual(
        outside.map((omission: ContextOmission): string => omission.id),
        ["external:react"],
    );
    assert.deepEqual(outside[0].requiredIds, ["export:src/a.ts#reexport@2"]);
});

test("addExports owns its re-export omission and can anchor the file on request", (): void => {
    const files: Map<string, FakeFile> = filesOf([
        [
            "src/a.ts",
            {
                text: 'export * from "react";\nexport const alpha = 1;\n',
                exports: [{ name: "alpha", kind: "const", line: 2, signature: "export const alpha = 1" }],
                reexports: [{ to: "react", specifier: "react", kind: "export-from", line: 1, external: true }],
            },
        ],
    ]);
    const session: FakeSession = new FakeSession("session.export-anchor", files, ["src"]);
    const plain: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    plain.addExports("src/a.ts");
    const plainPackage: ContextPackage = plain.build();
    assert.equal(itemIds(plainPackage).includes("file:src/a.ts"), false);
    assert.deepEqual(plainPackage.relations, []);
    const plainOutside: ContextOmission[] = plainPackage.omitted.filter((omission: ContextOmission): boolean => omission.reason === "outside_scope");
    assert.deepEqual(
        plainOutside.map((omission: ContextOmission): string => omission.id),
        ["external:react"],
    );
    assert.deepEqual(plainOutside[0].requiredIds, ["export:src/a.ts#reexport@1"]);
    const anchored: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    anchored.addExports("src/a.ts", { anchor: true });
    const anchoredPackage: ContextPackage = anchored.build();
    assert.ok(itemIds(anchoredPackage).includes("file:src/a.ts"));
    const contains: string[] = anchoredPackage.relations.map((relation: ContextRelation): string => `${relation.kind}:${relation.from}->${relation.to}`);
    assert.ok(contains.includes("contains:file:src/a.ts->export:src/a.ts#alpha@2"));
    const anchoredOutside: ContextOmission[] = anchoredPackage.omitted.filter((omission: ContextOmission): boolean => omission.reason === "outside_scope");
    assert.deepEqual(anchoredOutside[0].requiredIds, ["export:src/a.ts#reexport@1"]);
});

test("a failed expansion is not cached, so a retry re-runs the check", (): void => {
    const directorySession: FakeSession = sessionOf();
    const directoryBuilder: ContextBuilder = new ContextBuilder({ session: directorySession, budgetTokens: 1000 });
    expectCode((): void => {
        directoryBuilder.addDirectory("src/a.ts", 1);
    }, "not_directory");
    expectCode((): void => {
        directoryBuilder.addDirectory("src/a.ts", 1);
    }, "not_directory");
    const importsSession: FakeSession = sessionOf();
    const originalImports: (request: ImportRequest) => ImportReport = importsSession.imports.bind(importsSession);
    let failImport: boolean = true;
    const importsOverride: ImportsOverride = importsSession as unknown as ImportsOverride;
    importsOverride.imports = (request: ImportRequest): ImportReport => {
        if (failImport) {
            failImport = false;
            throw fakeError("store_failure");
        }
        return originalImports(request);
    };
    const importsBuilder: ContextBuilder = new ContextBuilder({ session: importsSession, budgetTokens: 10_000 });
    expectCode((): void => {
        importsBuilder.addImports("src/a.ts", { direction: "outgoing", depth: 1 });
    }, "store_failure");
    importsBuilder.addImports("src/a.ts", { direction: "outgoing", depth: 1 });
    assert.ok(itemIds(importsBuilder.build()).includes("file:src/b.ts"));
    const exportsSession: FakeSession = sessionOf();
    const originalExports: (request: ExportRequest) => ExportReport = exportsSession.exports.bind(exportsSession);
    let failExport: boolean = true;
    const exportsOverride: ExportsOverride = exportsSession as unknown as ExportsOverride;
    exportsOverride.exports = (request: ExportRequest): ExportReport => {
        if (failExport) {
            failExport = false;
            throw fakeError("store_failure");
        }
        return originalExports(request);
    };
    const exportsBuilder: ContextBuilder = new ContextBuilder({ session: exportsSession, budgetTokens: 10_000 });
    expectCode((): void => {
        exportsBuilder.addExports("src/a.ts");
    }, "store_failure");
    exportsBuilder.addExports("src/a.ts");
    assert.ok(itemIds(exportsBuilder.build()).some((id: string): boolean => id.startsWith("export:")));
});

test("lean directory anchors fall back to path and label items", (): void => {
    const session: FakeSession = sessionOf();
    session.leanAnchors = true;
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addDirectory("src", 1);
    const pkg: ContextPackage = builder.build();
    const files: ContextItem[] = pkg.items.filter((item: ContextItem): boolean => item.kind === "file");
    assert.deepEqual(files.map((item: ContextItem): string => item.path).sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
    assert.ok(files.every((item: ContextItem): boolean => item.summary.length > 0));
});

test("two builders over two sessions never share state", (): void => {
    const firstFiles: Map<string, FakeFile> = filesOf([["src/a.ts", { text: "const first = 1;\n", summary: "first" }]]);
    const secondFiles: Map<string, FakeFile> = filesOf([["src/a.ts", { text: "const second = 2;\n", summary: "second" }]]);
    const firstSession: FakeSession = new FakeSession("session.one", firstFiles, ["src"]);
    const secondSession: FakeSession = new FakeSession("session.two", secondFiles, ["src"]);
    const first: ContextBuilder = new ContextBuilder({ session: firstSession, budgetTokens: 1000 });
    const second: ContextBuilder = new ContextBuilder({ session: secondSession, budgetTokens: 1000 });
    first.addFile("src/a.ts");
    second.addFile("src/a.ts");
    const firstPackage: ContextPackage = first.build();
    const secondPackage: ContextPackage = second.build();
    assert.equal(firstPackage.sessionId, "session.one");
    assert.equal(secondPackage.sessionId, "session.two");
    assert.notEqual(firstPackage.items[0].summary, secondPackage.items[0].summary);
});

test("the same builder and revision produce byte-identical packages", (): void => {
    const session: FakeSession = sessionOf();
    const build: () => ContextPackage = (): ContextPackage => {
        const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 4000 });
        builder.addFile("src/a.ts");
        builder.addOutline("src/a.ts", { query: "inn" });
        builder.addImports("src/a.ts", { direction: "outgoing", depth: 2 });
        builder.addNote("intent", "repeatable");
        return builder.build();
    };
    const first: ContextPackage = build();
    const second: ContextPackage = build();
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 4000 });
    builder.addFile("src/a.ts");
    const one: ContextPackage = builder.build();
    const two: ContextPackage = builder.build();
    assert.equal(JSON.stringify(one), JSON.stringify(two));
});

test("a revision change is visible without changing item content", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 4000 });
    builder.addFile("src/a.ts");
    const before: ContextPackage = builder.build();
    session.revisionValue = "rev.2";
    const after: ContextPackage = builder.build();
    assert.equal(before.revision, "rev.1");
    assert.equal(after.revision, "rev.2");
    assert.deepEqual(itemIds(after), itemIds(before));
    assert.equal(JSON.stringify(after) === JSON.stringify(before), false);
});

test("JSON round trip preserves every field and every nested object is frozen", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 4000 });
    builder.addFile("src/a.ts");
    builder.addOutline("src/a.ts");
    builder.addImports("src/a.ts", { direction: "both", depth: 1 });
    builder.addNote("intent", "json");
    const pkg: ContextPackage = builder.build();
    const parsed: ContextPackage = JSON.parse(JSON.stringify(pkg)) as ContextPackage;
    assert.deepEqual(parsed, pkg);
    assert.ok(Object.isFrozen(pkg.items[0]));
    assert.ok(Object.isFrozen(pkg.relations[0]));
    assert.ok(Object.isFrozen(pkg.omitted));
    assert.ok(pkg.items.every((item: ContextItem): boolean => Object.isFrozen(item)) || pkg.items.length === 0);
    assert.throws((): void => {
        (pkg.items as ContextItem[]).push(pkg.items[0]);
    }, TypeError);
    assert.throws((): void => {
        (pkg.items[0] as unknown as Record<"summary", string>).summary = "tampered";
    }, TypeError);
});

test("invalid construction and request arguments fail with invalid_arguments", (): void => {
    const session: FakeSession = sessionOf();
    expectCode((): void => {
        new ContextBuilder({ session, budgetTokens: 0 });
    }, "invalid_arguments");
    expectCode((): void => {
        new ContextBuilder({ session, budgetTokens: -1 });
    }, "invalid_arguments");
    expectCode((): void => {
        new ContextBuilder({ session, budgetTokens: 1.5 });
    }, "invalid_arguments");
    expectCode((): void => {
        new ContextBuilder({ session, budgetTokens: 100, maxItems: 0 });
    }, "invalid_arguments");
    expectCode((): void => {
        new ContextBuilder({ session, budgetTokens: 100, maxDepth: 9 });
    }, "invalid_arguments");
    expectCode((): void => {
        new ContextBuilder({ session, budgetTokens: 100, weights: { anchor: -1 } });
    }, "invalid_arguments");
    expectCode((): void => {
        new ContextBuilder({ session, budgetTokens: 100, weights: { bogus: 1 } as never });
    }, "invalid_arguments");
    const broken: Record<string, unknown> = {
        sessionId: session.sessionId,
        descriptor: session.descriptor,
        read: session.read.bind(session),
        outline: session.outline.bind(session),
        imports: session.imports.bind(session),
        exports: (void 0),
        dependency: session.dependency.bind(session),
        revision: session.revision.bind(session),
    };
    expectCode((): void => {
        new ContextBuilder({ session: broken as unknown as ContextBuilderSession, budgetTokens: 100 });
    }, "invalid_arguments");
    const readOnly: FakeSession = new FakeSession("session.readonly", new Map<string, FakeFile>(), [], false);
    expectCode((): void => {
        new ContextBuilder({ session: readOnly, budgetTokens: 100 });
    }, "invalid_arguments");
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 100 });
    expectCode((): void => {
        builder.addFile("");
    }, "invalid_arguments");
    expectCode((): void => {
        builder.addNote("", "text");
    }, "invalid_arguments");
    expectCode((): void => {
        builder.addNote("id", "   ");
    }, "invalid_arguments");
    expectCode((): void => {
        builder.addOutline("src/a.ts", { startLine: 0 });
    }, "invalid_arguments");
    expectCode((): void => {
        builder.addOutline("src/a.ts", { startLine: 5, endLine: 1 });
    }, "invalid_arguments");
    expectCode((): void => {
        builder.addOutline("src/a.ts", { maxNodes: 0 });
    }, "invalid_arguments");
    expectCode((): void => {
        builder.addImports("src/a.ts", { depth: 9 });
    }, "invalid_arguments");
    expectCode((): void => {
        builder.addDependency({ mode: "bogus" as never });
    }, "invalid_arguments");
    expectCode((): void => {
        builder.addDependency({ mode: "closure", roots: [""] });
    }, "invalid_arguments");
});

test("addDirectory rejects a file path with not_directory", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 1000 });
    expectCode((): void => {
        builder.addDirectory("src/a.ts", 1);
    }, "not_directory");
});

test("session path errors propagate unchanged", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 1000 });
    expectCode((): void => {
        builder.addFile("src/absent.ts");
    }, "not_found");
    expectCode((): void => {
        builder.addOutline("src/absent.ts");
    }, "not_found");
});

test("1000+ nodes assemble well under two seconds", (): void => {
    const bigSymbols: FakeSymbol[] = [];
    for (let index: number = 0; index < 1200; index += 1) {
        const line: number = 2 + index * 3;
        bigSymbols.push({ name: `symbol_${index}`, line, endLine: line + 2, detail: `generated symbol ${index}` });
    }
    const files: Map<string, FakeFile> = new Map<string, FakeFile>();
    files.set("big.ts", { text: "const generated = true;\n", symbols: bigSymbols });
    const directories: string[] = ["mod", "pkg"];
    for (let index: number = 0; index < 400; index += 1) {
        files.set(`mod/m${index}.ts`, { text: `export const value${index} = ${index};\n` });
    }
    const nodes: DependencyNode[] = [];
    const edges: DependencyEdge[] = [];
    for (let index: number = 0; index < 600; index += 1) {
        nodes.push({ id: `pkg/f${index}.ts`, path: `pkg/f${index}.ts`, kind: "file", fingerprint: "" });
        files.set(`pkg/f${index}.ts`, { text: `export const dep${index} = ${index};\n` });
        if (index > 0) {
            edges.push({ from: `pkg/f${index - 1}.ts`, to: `pkg/f${index}.ts`, kind: "import" });
        }
    }
    const session: FakeSession = new FakeSession("session.perf", files, directories);
    session.graph = { nodes, edges, roots: ["pkg/f0.ts"], order: nodes.map((node: DependencyNode): string => node.id) };
    const started: number = Date.now();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 20_000, maxItems: 2000 });
    builder.addDirectory("mod", 1);
    builder.addOutline("big.ts", { startLine: 1, endLine: 3600, maxNodes: 1200 });
    builder.addDependency({ mode: "closure", roots: ["pkg/f0.ts"], depth: 8 });
    builder.addFile("big.ts");
    const pkg: ContextPackage = builder.build();
    const elapsed: number = Date.now() - started;
    assert.ok(pkg.items.length > 100, `items=${pkg.items.length}`);
    assert.ok(elapsed < 2000, `elapsed=${elapsed}ms`);
    assert.ok(pkg.usedTokens <= pkg.budgetTokens);
    const relationCost: number = pkg.relations.reduce(
        (sum: number, relation: ContextRelation): number => sum + estimateTokens(renderContextRelation(relation)),
        0,
    );
    assert.equal(pkg.usedTokens, pkg.items.reduce((sum: number, item: ContextItem): number => sum + item.tokens, 0) + relationCost);
});

test("every item line is charged exactly once and the text renders it", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 4000 });
    builder.addFile("src/a.ts");
    builder.addNote("intent", "render check");
    const pkg: ContextPackage = builder.build();
    pkg.items.forEach((item: ContextItem): void => {
        assert.ok(item.tokens >= 1);
        assert.ok(item.score >= 0);
    });
    const lines: string[] = pkg.text.split("\n");
    assert.equal(lines.length, pkg.items.length + pkg.relations.length);
    pkg.items.forEach((item: ContextItem, index: number): void => {
        assert.ok(lines[index].includes(item.summary));
        assert.ok(lines[index].includes(item.path.length === 0 ? item.id : item.path));
    });
});

/**
 * Build one real filesystem fixture under the sandbox.
 *
 * @param relative - Root-relative path.
 * @param content - UTF-8 content.
 * @returns The absolute path written.
 */
const writeFixture: (relative: string, content: string) => string = (relative: string, content: string): string => {
    const target: string = join(Sandbox, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return target;
};

test("a real FilesystemSession satisfies the read-only builder contract", (): void => {
    const aPath: string = writeFixture(
        "src/a.ts",
        'import { b } from "./b";\n\nexport interface Answer {\n    readonly value: number;\n}\n\nexport const a = 1;\n',
    );
    writeFixture("src/b.ts", "export const b = 2;\n");
    writeFixture("README.md", "# Fixture\n\nContext package fixture.\n");
    const before: string = readFileSync(aPath, "utf8");
    const registry: SessionRegistry = new SessionRegistry();
    const opened: ReturnType<SessionRegistry["open"]> = registry.open({
        agentId: "agent.context-test",
        label: "context package",
        roots: [{ id: "root.context-test", path: Sandbox, writable: false, exclude: [] }],
    });
    const service: FilesystemService = new FilesystemService({ registry, timeZone: "utc" });
    const session: FilesystemSession = service.bind(opened.descriptor.id, opened.credential.token);
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 6000 });
    builder.addFile("src/a.ts");
    builder.addOutline("src/a.ts");
    builder.addImports("src/a.ts", { direction: "both", depth: 1 });
    builder.addExports("src/a.ts");
    builder.addDirectory("src", 1);
    builder.addDependency({ mode: "dependencies", roots: ["src/a.ts"], depth: 2 });
    builder.addNote("intent", "read a and its neighbours");
    const pkg: ContextPackage = builder.build();
    assert.equal(pkg.sessionId, session.sessionId);
    assert.equal(pkg.revision, session.revision());
    assert.ok(pkg.items.length > 0);
    assert.ok(pkg.usedTokens <= pkg.budgetTokens);
    assert.ok(pkg.items.every((item: ContextItem): boolean => item.path.length === 0 || (!/^[A-Za-z]:/u.test(item.path) && !item.path.startsWith(Sandbox))));
    assert.ok(pkg.items.some((item: ContextItem): boolean => item.id === "file:src/a.ts"));
    assert.ok(pkg.items.some((item: ContextItem): boolean => item.id.startsWith("outline:src/a.ts#")));
    assert.ok(pkg.items.some((item: ContextItem): boolean => item.id === "file:src/b.ts"));
    const edges: string[] = pkg.relations.map((relation: ContextRelation): string => `${relation.kind}:${relation.from}->${relation.to}`);
    assert.ok(edges.includes("import:file:src/a.ts->file:src/b.ts"));
    assert.equal(JSON.parse(JSON.stringify(pkg)).sessionId, session.sessionId);
    assert.equal(readFileSync(aPath, "utf8"), before);
});

test("a real session surfaces classified path errors unchanged", (): void => {
    const registry: SessionRegistry = new SessionRegistry();
    const opened: ReturnType<SessionRegistry["open"]> = registry.open({
        agentId: "agent.context-test",
        roots: [{ id: "root.context-test", path: Sandbox, writable: false, exclude: [] }],
    });
    const service: FilesystemService = new FilesystemService({ registry, timeZone: "utc" });
    const session: FilesystemSession = service.bind(opened.descriptor.id, opened.credential.token);
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 1000 });
    expectCode((): void => {
        builder.addFile("src/does-not-exist.ts");
    }, "not_found");
    expectCode((): void => {
        builder.addFile("../outside.ts");
    }, "path_escape");
    expectCode((): void => {
        builder.addFile("C:\\Windows\\win.ini");
    }, "invalid_path");
});

test("provenance promotion makes call order irrelevant for one module", (): void => {
    const firstSession: FakeSession = sessionOf();
    const secondSession: FakeSession = sessionOf();
    const importsFirst: ContextBuilder = new ContextBuilder({ session: firstSession, budgetTokens: 10_000 });
    importsFirst.addImports("src/a.ts", { direction: "outgoing", depth: 1 });
    importsFirst.addFile("src/a.ts");
    const anchorFirst: ContextBuilder = new ContextBuilder({ session: secondSession, budgetTokens: 10_000 });
    anchorFirst.addFile("src/a.ts");
    anchorFirst.addImports("src/a.ts", { direction: "outgoing", depth: 1 });
    const left: ContextPackage = importsFirst.build();
    const right: ContextPackage = anchorFirst.build();
    const leftItem: ContextItem | undefined = left.items.find((item: ContextItem): boolean => item.id === "file:src/a.ts");
    const rightItem: ContextItem | undefined = right.items.find((item: ContextItem): boolean => item.id === "file:src/a.ts");
    assert.ok(leftItem !== (void 0));
    assert.ok(rightItem !== (void 0));
    assert.equal(leftItem.provenance, "anchor");
    assert.equal(rightItem.provenance, "anchor");
    assert.equal(leftItem.score, rightItem.score);
    assert.equal(leftItem.why, rightItem.why);
    assert.equal(JSON.stringify(left), JSON.stringify(right));
    assert.equal(left.omitted.filter((omission: ContextOmission): boolean => omission.reason === "duplicate").length, 0);
});

test("a session without a usable revision fails with session_unavailable", (): void => {
    const session: FakeSession = sessionOf();
    session.revisionValue = "";
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 100 });
    builder.addNote("intent", "no revision");
    expectCode((): void => {
        builder.build();
    }, "session_unavailable");
});

test("a descriptor id that disagrees with the session id is rejected", (): void => {
    const session: FakeSession = sessionOf();
    const mismatched: Record<string, unknown> = {
        sessionId: session.sessionId,
        descriptor: { ...session.descriptor, id: "session.other" },
        read: session.read.bind(session),
        outline: session.outline.bind(session),
        imports: session.imports.bind(session),
        exports: session.exports.bind(session),
        dependency: session.dependency.bind(session),
        revision: session.revision.bind(session),
    };
    expectCode((): void => {
        new ContextBuilder({ session: mismatched as unknown as ContextBuilderSession, budgetTokens: 100 });
    }, "invalid_arguments");
});

test("maxItems is an item ceiling that reports the remainder as budget omissions", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000, maxItems: 1, includeRelations: false });
    builder.addNote("a", "first note");
    builder.addNote("b", "second note");
    const pkg: ContextPackage = builder.build();
    assert.equal(pkg.items.length, 1);
    assert.equal(pkg.items[0].id, "note:a");
    const omitted: ContextOmission[] = pkg.omitted.filter((omission: ContextOmission): boolean => omission.reason === "budget");
    assert.deepEqual(
        omitted.map((omission: ContextOmission): string => omission.id),
        ["note:b"],
    );
});

test("weights change ranking deterministically", (): void => {
    const session: FakeSession = sessionOf();
    const defaults: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000, includeRelations: false });
    defaults.addFile("src/a.ts");
    defaults.addNote("intent", "weighted");
    const defaultOrder: string[] = itemIds(defaults.build());
    assert.equal(defaultOrder[0], "file:src/a.ts");
    const noteFirst: ContextBuilder = new ContextBuilder({
        session,
        budgetTokens: 10_000,
        includeRelations: false,
        weights: { anchor: 0, note: 5 },
    });
    noteFirst.addFile("src/a.ts");
    noteFirst.addNote("intent", "weighted");
    const weightedOrder: string[] = itemIds(noteFirst.build());
    assert.equal(weightedOrder[0], "note:intent");
    assert.deepEqual(weightedOrder.slice().sort(), defaultOrder.slice().sort());
});

test("addFile honors a host summary and detail ref", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addFile("src/a.ts", { summary: "  host   summary  ", detailRef: "cas:1234", maxLines: 1 });
    const pkg: ContextPackage = builder.build();
    assert.equal(pkg.items.length, 1);
    assert.equal(pkg.items[0].summary, "host summary");
    assert.equal(pkg.items[0].detailRef, "cas:1234");
    assert.equal(pkg.items[0].range, (void 0));
    assert.equal(pkg.items[0].provenance, "anchor");
});

test("incoming imports build the reverse relation", (): void => {
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addFile("src/b.ts");
    builder.addImports("src/b.ts", { direction: "incoming", depth: 1 });
    const pkg: ContextPackage = builder.build();
    const edges: string[] = pkg.relations.map((relation: ContextRelation): string => `${relation.kind}:${relation.from}->${relation.to}`);
    assert.ok(edges.includes("import:file:src/a.ts->file:src/b.ts"));
    assert.ok(itemIds(pkg).includes("file:src/a.ts"));
});

test("a two-level directory expansion recurses and keeps contains edges", (): void => {
    const files: Map<string, FakeFile> = filesOf([
        ["src/top.ts", { text: "export const top = 1;\n" }],
        ["src/nested/deep.ts", { text: "export const deep = 1;\n" }],
    ]);
    const session: FakeSession = new FakeSession("session.directory", files, ["src", "src/nested"]);
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 10_000 });
    builder.addDirectory("src", 2);
    const pkg: ContextPackage = builder.build();
    const ids: string[] = itemIds(pkg);
    assert.ok(ids.includes("directory:src"));
    assert.ok(ids.includes("directory:src/nested"));
    assert.ok(ids.includes("file:src/nested/deep.ts"));
    const edges: string[] = pkg.relations.map((relation: ContextRelation): string => `${relation.kind}:${relation.from}->${relation.to}`);
    assert.ok(edges.includes("contains:directory:src->directory:src/nested"));
    assert.ok(edges.includes("contains:directory:src/nested->file:src/nested/deep.ts"));
});

test("a host token estimator replaces the default budget heuristic", (): void => {
    const session: FakeSession = sessionOf();
    const text: string = "上下文".repeat(40);
    const defaults: ContextBuilder = new ContextBuilder({ session, budgetTokens: 100, includeRelations: false });
    defaults.addNote("cjk", text);
    const defaultPackage: ContextPackage = defaults.build();
    assert.equal(defaultPackage.items.length, 1);
    const bytes: ContextBuilder = new ContextBuilder({
        session,
        budgetTokens: 100,
        includeRelations: false,
        tokenEstimator: (value: string): number => Buffer.byteLength(value, "utf8"),
    });
    bytes.addNote("cjk", text);
    const bytePackage: ContextPackage = bytes.build();
    assert.equal(bytePackage.items.length, 0);
    assert.deepEqual(
        bytePackage.omitted.map((omission: ContextOmission): string => omission.reason),
        ["budget"],
    );
});

test("an invalid token estimator is rejected", (): void => {
    const session: FakeSession = sessionOf();
    expectCode((): void => {
        new ContextBuilder({ session, budgetTokens: 100, tokenEstimator: 5 as never });
    }, "invalid_arguments");
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 100, tokenEstimator: (): number => Number.NaN });
    builder.addNote("intent", "nan estimator");
    expectCode((): void => {
        builder.build();
    }, "invalid_arguments");
});

test("summaries strip control characters and ranges clamp instead of collapsing", (): void => {
    assert.equal(clampSummary("a\u0000b\u0007c\nd"), "abc d");
    const huge: ReturnType<typeof toContextRange> = toContextRange(BigInt("100000000000000000000"), BigInt(5));
    assert.equal(huge.startLine, Number.MAX_SAFE_INTEGER);
    assert.equal(huge.endLine, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(toContextRange(-3, 2), { startLine: 1, endLine: 2 });
    assert.deepEqual(toContextRange(5, 1), { startLine: 5, endLine: 5 });
    assert.deepEqual(toContextRange(3, 9), { startLine: 3, endLine: 9 });
    const session: FakeSession = sessionOf();
    const builder: ContextBuilder = new ContextBuilder({ session, budgetTokens: 100 });
    expectCode((): void => {
        builder.addNote("control-only", "\u0000\u0007");
    }, "invalid_arguments");
});

test("audit: estimateTokens is character-based and charges nothing for empty text", (): void => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a"), 1);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    const ascii: string = "x".repeat(400);
    const cjk: string = `${"上下文".repeat(133)}上`;
    assert.equal(estimateTokens(ascii), 100);
    assert.equal(estimateTokens(cjk), 100);
    const asciiBytes: number = Buffer.byteLength(ascii, "utf8");
    const cjkBytes: number = Buffer.byteLength(cjk, "utf8");
    assert.equal(asciiBytes, 400);
    assert.equal(cjkBytes, 1200);
    const byteEstimate: number = Math.ceil(cjkBytes / 4);
    assert.ok(estimateTokens(cjk) < byteEstimate, `${estimateTokens(cjk)} < ${byteEstimate}`);
});

test("audit: ContextAst.view reports rendered-text tokens but admits conservatively", (): void => {
    const graph: ContextAst = new ContextAst();
    graph.add({ id: "a", kind: "goal", summary: "b", order: 0, salience: 1 });
    graph.add({ id: "b", kind: "goal", summary: "c", order: 1, salience: 1 });
    graph.add({ id: "c", kind: "goal", summary: "d", order: 2, salience: 1 });
    const view: ContextAstView = graph.view(100);
    assert.equal(view.nodes.length, 3);
    assert.equal(view.tokens, estimateTokens(view.text));
    const joined: number = estimateTokens(view.text);
    assert.ok(joined <= view.budgetTokens);
    assert.equal(view.tokens, joined);
    const empty: ContextAstView = graph.view(1);
    assert.equal(empty.text, "");
    assert.equal(empty.tokens, 0);
    const single: ContextAstView = new ContextAst().add({ id: "a", kind: "goal", summary: "b", order: 0 }).view(5);
    assert.equal(single.text, "- [goal] a: b");
    assert.equal(single.tokens, estimateTokens("- [goal] a: b"));
});

test("audit: WorkspaceIndex.summaryState caches per snapshot and never poisons later queries", (): void => {
    const entities: WorkspaceEntity[] = [
        {
            id: "project.p",
            kind: "project",
            projectId: "project.p",
            label: "P",
            summary: "project",
            source: { uri: "README.md", revision: "1" },
        },
        {
            id: "file.doc",
            kind: "file",
            projectId: "project.p",
            parentId: "project.p",
            label: "doc",
            summary: "a document",
            source: { uri: "doc.md", revision: "1" },
            summaryProvenance: { method: "extractive-v1", sources: [{ uri: "doc.md", revision: "1" }], children: [] },
        },
    ];
    const snapshot: WorkspaceSnapshot = { version: 1, revision: "workspace.1", entities, relations: [], diagnostics: [] };
    const index: WorkspaceIndex = new WorkspaceIndex(snapshot, new MemoryContentStore());
    assert.equal(index.summaryState("file.doc"), "fresh");
    assert.equal(index.summaryState("file.doc", [{ uri: "doc.md", revision: "2" }]), "stale");
    assert.equal(index.summaryState("file.doc"), "fresh");
    assert.equal(index.summaryState("project.p"), "untracked");
    assert.equal(index.summaryState("missing"), "untracked");
    assert.equal(index.summaryState("file.doc", [{ uri: "doc.md", revision: "1" }]), "fresh");
});

test("audit: ContextIndex LRU hits count cache reuse, misses cover cache and CAS reads", (): void => {
    const store: MemoryContentStore = new MemoryContentStore();
    const index: ContextIndex = new ContextIndex(undefined, { store, cacheEntries: 2 });
    index.add({ id: "one", kind: "observation", summary: "one", order: 0 }, "shared detail");
    index.add({ id: "two", kind: "observation", summary: "two", order: 1 }, "shared detail");
    index.add({ id: "three", kind: "observation", summary: "three", order: 2 }, "third detail");
    assert.equal(index.stats().hits, 0);
    assert.equal(index.getDetail("one"), "shared detail");
    assert.equal(index.stats().misses, 1);
    assert.equal(index.getDetail("two"), "shared detail");
    assert.equal(index.stats().hits, 1);
    assert.equal(index.getDetail("missing"), (void 0));
    assert.equal(index.stats().hits + index.stats().misses, 2);
    assert.equal(index.stats().cachedDetails, 1);
    index.getDetail("three");
    assert.equal(index.stats().misses, 2);
});
