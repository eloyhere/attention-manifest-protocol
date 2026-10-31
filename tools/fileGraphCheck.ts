#!/usr/bin/env node
/**
 * Filesystem graph checks.
 *
 * The suite covers lexical import/export extraction, relative and external
 * specifier resolution, strongly connected components, self-loops, topological
 * order with blocking cycles, bounded closures and the error taxonomy for
 * unreadable files. Fixtures live in one temporary directory and are removed
 * after the last test.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { buildDependencyReport, DependencyGraph, graphFromImports } from "../src/file/dependency.ts";
import { extractExports } from "../src/file/exportGraph.ts";
import type { ReexportEdge } from "../src/file/exportGraph.ts";
import { FilesystemError } from "../src/file/errors.ts";
import { extractImports, importedBy } from "../src/file/importGraph.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { DependencyEdge, DependencyNode, DependencyReport, ExportReport, ExportSymbol, FilesystemErrorCode, ImportEdge, ImportReport } from "../src/file/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

const RootPath: string = mkdtempSync(join(tmpdir(), "amp-file-graph-"));
const Root: SessionRoot = { id: "root", path: RootPath, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([Root]);

after((): void => {
    rmSync(RootPath, { recursive: true, force: true });
});

const write: (relative: string, content: string | Uint8Array) => void = (relative: string, content: string | Uint8Array): void => {
    const absolute: string = join(RootPath, ...relative.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
};

const expectCode: (action: () => void, code: FilesystemErrorCode) => void = (action: () => void, code: FilesystemErrorCode): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

const importEdge: (edges: readonly ImportEdge[], specifier: string) => ImportEdge = (edges: readonly ImportEdge[], specifier: string): ImportEdge => {
    const edge: ImportEdge | undefined = edges.find((candidate: ImportEdge): boolean => candidate.specifier === specifier);
    assert.ok(edge, `missing import edge ${specifier}`);
    return edge as ImportEdge;
};

const exportSymbol: (symbols: readonly ExportSymbol[], name: string) => ExportSymbol = (symbols: readonly ExportSymbol[], name: string): ExportSymbol => {
    const symbol: ExportSymbol | undefined = symbols.find((candidate: ExportSymbol): boolean => candidate.name === name);
    assert.ok(symbol, `missing export ${name}`);
    return symbol as ExportSymbol;
};

const reexportNamed: (edges: readonly ImportEdge[], name: string) => ReexportEdge = (edges: readonly ImportEdge[], name: string): ReexportEdge => {
    const edge: ReexportEdge | undefined = edges.find((candidate: ImportEdge): boolean => (candidate as ReexportEdge).name === name) as
        ReexportEdge | undefined;
    assert.ok(edge, `missing reexport ${name}`);
    return edge as ReexportEdge;
};

const node: (id: string) => DependencyNode = (id: string): DependencyNode => ({
    id,
    path: id,
    kind: "file",
    fingerprint: `sha256:${"0".repeat(64)}`,
});

type EdgeFactory = (from: string, to: string, kind?: DependencyEdge["kind"]) => DependencyEdge;

const edge: EdgeFactory = (from, to, kind = "import"): DependencyEdge => ({ from, to, kind });

test("import extraction recognises static, type, side-effect, export-from, dynamic and require edges", (): void => {
    write("src/b.ts", "export const b = 1;\n");
    write("src/types.ts", "export interface T { readonly value: number; }\n");
    write("src/side.ts", "export const side = 1;\n");
    write("src/c.ts", "export const c = 1;\n");
    write("src/d.tsx", "export const d = 1;\n");
    write("src/e/index.ts", "export const e = 1;\n");
    write("src/data.json", "{}\n");
    write(
        "src/imports.ts",
        [
            'import { b } from "./b";',
            'import type { T } from "./types";',
            'import "./side";',
            'export { c } from "./c";',
            'const d = import("./d");',
            'const e = require("./e");',
            'import data from "./data.json";',
            '// import fakeLine from "./fake-line";',
            '/* import fakeBlock from "./fake-block"; */',
            "const text = \"import fakeString from './fake-string'\";",
            'const template = `import fakeTemplate from "./fake-template"`;',
            "const nested = `value ${\"import fakeNested from './fake-nested'\"} end`;",
            'const pattern = /import fakeRegex from "\\.\\/fake-regex"/;',
            'const property = { import: "./not-an-import", require: "./not-a-require" };',
        ].join("\n"),
    );
    const report: ImportReport = extractImports(Sandbox, "src/imports.ts");
    assert.equal(report.path, "src/imports.ts");
    assert.match(report.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(report.imports.length, 7);
    assert.deepEqual(report.external, []);
    assert.deepEqual(report.unresolved, []);
    assert.deepEqual(report.importedBy, []);
    assert.equal(report.truncated, false);
    const b: ImportEdge = importEdge(report.imports, "./b");
    assert.equal(b.kind, "static");
    assert.equal(b.line, 1);
    assert.equal(b.resolved, true);
    assert.equal(b.external, false);
    assert.equal(b.to, "src/b.ts");
    const typeOnly: ImportEdge = importEdge(report.imports, "./types");
    assert.equal(typeOnly.kind, "type");
    assert.equal(typeOnly.line, 2);
    assert.equal(typeOnly.to, "src/types.ts");
    const side: ImportEdge = importEdge(report.imports, "./side");
    assert.equal(side.kind, "static");
    assert.equal(side.line, 3);
    const exported: ImportEdge = importEdge(report.imports, "./c");
    assert.equal(exported.kind, "export-from");
    assert.equal(exported.line, 4);
    assert.equal(exported.to, "src/c.ts");
    const dynamic: ImportEdge = importEdge(report.imports, "./d");
    assert.equal(dynamic.kind, "dynamic");
    assert.equal(dynamic.line, 5);
    assert.equal(dynamic.to, "src/d.tsx");
    const required: ImportEdge = importEdge(report.imports, "./e");
    assert.equal(required.kind, "require");
    assert.equal(required.line, 6);
    assert.equal(required.to, "src/e/index.ts");
    const json: ImportEdge = importEdge(report.imports, "./data.json");
    assert.equal(json.kind, "static");
    assert.equal(json.line, 7);
    assert.equal(json.to, "src/data.json");
    const fakeSpecifiers: string[] = [
        "./fake-line",
        "./fake-block",
        "./fake-string",
        "./fake-template",
        "./fake-nested",
        "./fake-regex",
        "./not-an-import",
        "./not-a-require",
    ];
    for (let index: number = 0; index < fakeSpecifiers.length; index += 1) {
        const specifier: string = fakeSpecifiers[index];
        assert.equal(
            report.imports.some((candidate: ImportEdge): boolean => candidate.specifier === specifier),
            false,
            `${specifier} must not be an import`,
        );
    }
    const reverse: ImportEdge[] = importedBy(Sandbox, "src/b.ts", ["src/missing.ts", "src/imports.ts"]);
    assert.equal(reverse.length, 1);
    assert.equal(reverse[0].from, "src/imports.ts");
    assert.equal(reverse[0].specifier, "./b");
});

test("relative and external specifiers resolve with fixed probing and explicit gaps", (): void => {
    write("src/a.ts", "export const a = 1;\n");
    write("src/dir/index.ts", "export const index = 1;\n");
    write(
        "src/resolve.ts",
        [
            'import a from "./a";',
            'import dir from "./dir";',
            'import missing from "./missing";',
            'import abs from "/abs/path";',
            'import escape from "../../outside";',
            'import fs from "node:fs";',
            'import scoped from "@scope/pkg";',
            'import sub from "pkg/sub";',
            'import again from "./a";',
            'import missingAgain from "./missing";',
            'import reactOne from "react";',
            'import reactTwo from "react";',
        ].join("\n"),
    );
    const report: ImportReport = extractImports(Sandbox, "src/resolve.ts");
    assert.equal(importEdge(report.imports, "./a").to, "src/a.ts");
    assert.equal(importEdge(report.imports, "./dir").to, "src/dir/index.ts");
    const missing: ImportEdge = importEdge(report.imports, "./missing");
    assert.equal(missing.resolved, false);
    assert.equal(missing.external, false);
    assert.equal(missing.to, "src/missing.ts");
    const absolute: ImportEdge = importEdge(report.imports, "/abs/path");
    assert.equal(absolute.resolved, false);
    assert.equal(absolute.external, false);
    assert.equal(absolute.to, "/abs/path");
    const escape: ImportEdge = importEdge(report.imports, "../../outside");
    assert.equal(escape.resolved, false);
    assert.equal(escape.external, false);
    assert.equal(escape.to, "../../outside");
    const nodeBuiltin: ImportEdge = importEdge(report.imports, "node:fs");
    assert.equal(nodeBuiltin.resolved, true);
    assert.equal(nodeBuiltin.external, true);
    assert.equal(nodeBuiltin.to, "node:fs");
    assert.equal(importEdge(report.imports, "@scope/pkg").external, true);
    assert.equal(importEdge(report.imports, "pkg/sub").external, true);
    assert.deepEqual(report.external, ["node:fs", "@scope/pkg", "pkg/sub", "react"]);
    assert.deepEqual(report.unresolved, ["./missing", "/abs/path", "../../outside"]);
    write("src/notes.md", 'import text from "./b";\n');
    const markdown: ImportReport = extractImports(Sandbox, "src/notes.md");
    assert.deepEqual(markdown.imports, []);
    assert.deepEqual(markdown.external, []);
    assert.deepEqual(markdown.unresolved, []);
    assert.match(markdown.fingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("export extraction recognises declarations, defaults, local clauses and re-exports", (): void => {
    write("src/star.ts", "export const star = 1;\n");
    write("src/ns.ts", "export const ns = 1;\n");
    write("src/dep.ts", "export const thing = 1;\n");
    write(
        "src/exports.ts",
        [
            "export function alpha(): number { return 1; }",
            "export class Beta {}",
            "export interface Shape { readonly area: number; }",
            "export type Alias = string;",
            "export enum Color { Red }",
            "export const value = 1;",
            "export let mutable = 2;",
            "export var legacy = 3;",
            "export namespace Space { export const inner = 1; }",
            "const local = 1;",
            "export { local, alpha as renamed };",
            "export default class DefaultClass {}",
            'export * from "./star";',
            'export * as ns from "./ns";',
            'export { thing } from "./dep";',
            'const fake = "export const ghost = 1";',
        ].join("\n"),
    );
    const report: ExportReport = extractExports(Sandbox, "src/exports.ts");
    assert.equal(report.path, "src/exports.ts");
    assert.match(report.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(report.truncated, false);
    assert.equal(report.exports.length, 13);
    assert.equal(exportSymbol(report.exports, "alpha").kind, "function");
    assert.equal(exportSymbol(report.exports, "alpha").line, 1);
    assert.equal(exportSymbol(report.exports, "Beta").kind, "class");
    assert.equal(exportSymbol(report.exports, "Shape").kind, "interface");
    assert.equal(exportSymbol(report.exports, "Alias").kind, "type");
    assert.equal(exportSymbol(report.exports, "Color").kind, "enum");
    assert.equal(exportSymbol(report.exports, "value").kind, "const");
    assert.equal(exportSymbol(report.exports, "mutable").kind, "let");
    assert.equal(exportSymbol(report.exports, "legacy").kind, "var");
    assert.equal(exportSymbol(report.exports, "Space").kind, "namespace");
    assert.equal(exportSymbol(report.exports, "local").kind, "const");
    assert.equal(exportSymbol(report.exports, "renamed").kind, "function");
    assert.match(exportSymbol(report.exports, "local").signature, /^export \{/);
    const defaultExport: ExportSymbol = exportSymbol(report.exports, "default");
    assert.equal(defaultExport.kind, "default");
    assert.equal(defaultExport.line, 12);
    const thing: ExportSymbol = exportSymbol(report.exports, "thing");
    assert.equal(thing.kind, "reexport");
    assert.equal(thing.reexportFrom, "./dep");
    assert.equal(
        report.exports.some((candidate: ExportSymbol): boolean => candidate.name === "ghost"),
        false,
    );
    assert.equal(report.reexports.length, 3);
    const star: ReexportEdge = reexportNamed(report.reexports, "*");
    assert.equal(star.kind, "export-from");
    assert.equal(star.specifier, "./star");
    assert.equal(star.to, "src/star.ts");
    assert.equal(star.resolved, true);
    const namespace: ReexportEdge = reexportNamed(report.reexports, "ns");
    assert.equal(namespace.specifier, "./ns");
    assert.equal(namespace.to, "src/ns.ts");
    const named: ReexportEdge = reexportNamed(report.reexports, "thing");
    assert.equal(named.specifier, "./dep");
    assert.equal(named.to, "src/dep.ts");
    write("src/style.css", "export const notJavaScript = 1;\n");
    const style: ExportReport = extractExports(Sandbox, "src/style.css");
    assert.deepEqual(style.exports, []);
    assert.deepEqual(style.reexports, []);
    assert.equal(style.truncated, false);
});

test("SCC, self-loop and topological algorithms report cycles instead of dropping edges", (): void => {
    const graph: DependencyGraph = new DependencyGraph();
    const ids: string[] = ["a", "b", "c", "d", "e", "f"];
    for (let index: number = 0; index < ids.length; index += 1) {
        graph.addNode(node(ids[index]));
    }
    graph.addEdge(edge("e", "a"));
    graph.addEdge(edge("a", "b"));
    graph.addEdge(edge("b", "c"));
    graph.addEdge(edge("c", "a"));
    graph.addEdge(edge("d", "d"));
    assert.deepEqual(graph.scc(), [["a", "b", "c"], ["d"], ["e"], ["f"]]);
    assert.deepEqual(graph.cycles(), [["a", "b", "c"], ["d"]]);
    const result: ReturnType<DependencyGraph["topological"]> = graph.topological();
    assert.deepEqual(result.order, ["e", "f"]);
    assert.deepEqual(result.cycles, [["a", "b", "c"], ["d"]]);
    const acyclic: DependencyGraph = new DependencyGraph();
    acyclic.addNode(node("a"));
    acyclic.addNode(node("b"));
    acyclic.addNode(node("c"));
    acyclic.addNode(node("d"));
    acyclic.addEdge(edge("a", "b"));
    acyclic.addEdge(edge("a", "c"));
    acyclic.addEdge(edge("b", "d"));
    acyclic.addEdge(edge("c", "d"));
    assert.deepEqual(acyclic.topological(), { order: ["a", "b", "c", "d"], cycles: [] });
    assert.deepEqual(acyclic.cycles(), []);
    acyclic.addEdge(edge("a", "missing"));
    const withDangling: ReturnType<DependencyGraph["topological"]> = acyclic.topological();
    assert.deepEqual(withDangling.order, ["a", "b", "c", "d"]);
    assert.deepEqual(withDangling.cycles, []);
});

test("closure is bounded, bidirectional and stable", (): void => {
    const graph: DependencyGraph = new DependencyGraph();
    const ids: string[] = ["a", "b", "c", "d", "e"];
    for (let index: number = 0; index < ids.length; index += 1) {
        graph.addNode(node(ids[index]));
    }
    graph.addEdge(edge("a", "b"));
    graph.addEdge(edge("a", "c"));
    graph.addEdge(edge("b", "d"));
    graph.addEdge(edge("c", "d"));
    graph.addEdge(edge("d", "e"));
    const first: ReturnType<DependencyGraph["closure"]> = graph.closure(["a"], "dependencies", 1, 500);
    assert.deepEqual(first.nodes, ["a", "b", "c"]);
    assert.deepEqual(first.edges, [edge("a", "b"), edge("a", "c")]);
    assert.equal(first.truncated, false);
    const second: ReturnType<DependencyGraph["closure"]> = graph.closure(["a"], "dependencies", 2, 500);
    assert.deepEqual(second.nodes, ["a", "b", "c", "d"]);
    assert.deepEqual(second.edges, [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")]);
    const reverseOne: ReturnType<DependencyGraph["closure"]> = graph.closure(["e"], "dependents", 1, 500);
    assert.deepEqual(reverseOne.nodes, ["e", "d"]);
    assert.deepEqual(reverseOne.edges, [edge("d", "e")]);
    const reverseTwo: ReturnType<DependencyGraph["closure"]> = graph.closure(["e"], "dependents", 2, 500);
    assert.deepEqual(reverseTwo.nodes, ["e", "d", "b", "c"]);
    assert.deepEqual(reverseTwo.edges, [edge("d", "e"), edge("b", "d"), edge("c", "d")]);
    const limited: ReturnType<DependencyGraph["closure"]> = graph.closure(["a"], "dependencies", 10, 2);
    assert.deepEqual(limited.nodes, ["a", "b"]);
    assert.equal(limited.truncated, true);
    assert.deepEqual(graph.closure(["unknown"], "dependencies", 3, 500).nodes, []);
    assert.deepEqual(graph.closure(["d"], "dependencies", 0, 500).nodes, ["d"]);
});

test("buildDependencyReport scopes cycles/topological modes and fills every field", (): void => {
    const graph: DependencyGraph = new DependencyGraph();
    const ids: string[] = ["a", "b", "c", "z"];
    for (let index: number = 0; index < ids.length; index += 1) {
        graph.addNode(node(ids[index]));
    }
    graph.addEdge(edge("a", "b"));
    graph.addEdge(edge("b", "a"));
    graph.addEdge(edge("c", "c"));
    graph.addEdge(edge("z", "a"));
    const cycleReport: DependencyReport = buildDependencyReport(graph, "rev-1", { mode: "cycles", roots: ["a"] });
    assert.deepEqual(cycleReport.roots, ["a"]);
    assert.deepEqual(
        cycleReport.nodes.map((entry: DependencyNode): string => entry.id),
        ["a", "b"],
    );
    assert.deepEqual(cycleReport.cycles, [["a", "b"]]);
    assert.deepEqual(cycleReport.order, []);
    assert.deepEqual(cycleReport.unresolved, []);
    assert.deepEqual(cycleReport.external, []);
    assert.equal(cycleReport.revision, "rev-1");
    assert.equal(cycleReport.mode, "cycles");
    assert.equal(cycleReport.truncated, false);
    const allCycles: DependencyReport = buildDependencyReport(graph, "rev-1", { mode: "cycles" });
    assert.deepEqual(
        allCycles.nodes.map((entry: DependencyNode): string => entry.id),
        ["a", "b", "c", "z"],
    );
    assert.deepEqual(allCycles.cycles, [["a", "b"], ["c"]]);
    const unknownRoot: DependencyReport = buildDependencyReport(graph, "rev-1", { mode: "cycles", roots: ["missing"] });
    assert.deepEqual(unknownRoot.roots, []);
    assert.deepEqual(unknownRoot.nodes, []);
    assert.deepEqual(unknownRoot.cycles, []);
    const rootedTopological: DependencyReport = buildDependencyReport(graph, "rev-1", { mode: "topological", roots: ["z"] });
    assert.deepEqual(rootedTopological.order, ["z"]);
    assert.deepEqual(rootedTopological.cycles, [["a", "b"]]);
    const closureReport: DependencyReport = buildDependencyReport(graph, "rev-1", { mode: "closure", roots: ["a"], depth: 1 });
    assert.deepEqual(
        closureReport.nodes.map((entry: DependencyNode): string => entry.id),
        ["a", "b"],
    );
    assert.deepEqual(closureReport.order, []);
    assert.deepEqual(closureReport.cycles, []);
    const truncatedReport: DependencyReport = buildDependencyReport(graph, "rev-1", {
        mode: "dependencies",
        roots: ["z"],
        depth: 3,
        limit: 2,
    });
    assert.equal(truncatedReport.truncated, true);
    assert.deepEqual(
        truncatedReport.nodes.map((entry: DependencyNode): string => entry.id),
        ["z", "a"],
    );
});

test("graphFromImports and dependency reports keep external packages separate", (): void => {
    const reports: ImportReport[] = [
        {
            path: "src/a.ts",
            fingerprint: `sha256:${"a".repeat(64)}`,
            imports: [
                { from: "src/a.ts", to: "src/b.ts", specifier: "./b", kind: "static", line: 1, resolved: true, external: false },
                { from: "src/a.ts", to: "react", specifier: "react", kind: "static", line: 2, resolved: true, external: true },
                { from: "src/a.ts", to: "src/missing.ts", specifier: "./missing", kind: "static", line: 3, resolved: false, external: false },
                { from: "src/a.ts", to: "src/b.ts", specifier: "./b", kind: "export-from", line: 4, resolved: true, external: false },
            ],
            importedBy: [],
            external: ["react"],
            unresolved: ["./missing"],
            truncated: false,
        },
        {
            path: "src/b.ts",
            fingerprint: `sha256:${"b".repeat(64)}`,
            imports: [],
            importedBy: [],
            external: [],
            unresolved: [],
            truncated: false,
        },
    ];
    const graph: DependencyGraph = graphFromImports("rev-2", reports, true);
    assert.deepEqual(
        graph.nodes().map((entry: DependencyNode): string => entry.id),
        ["src/a.ts", "src/b.ts", "external:react"],
    );
    assert.equal(graph.node("external:react")?.kind, "package");
    assert.equal(graph.node("external:react")?.path, "react");
    assert.deepEqual(graph.edges(), [
        { from: "src/a.ts", to: "src/b.ts", kind: "import", specifier: "./b", line: 1 },
        { from: "src/a.ts", to: "external:react", kind: "import", specifier: "react", line: 2 },
        { from: "src/a.ts", to: "src/b.ts", kind: "export", specifier: "./b", line: 4 },
    ]);
    const withoutExternal: DependencyGraph = graphFromImports("rev-2", reports, false);
    assert.deepEqual(
        withoutExternal.nodes().map((entry: DependencyNode): string => entry.id),
        ["src/a.ts", "src/b.ts"],
    );
    const withExternal: DependencyReport = buildDependencyReport(graph, "rev-2", {
        mode: "closure",
        roots: ["src/a.ts"],
        includeExternal: true,
        depth: 1,
    });
    assert.deepEqual(
        withExternal.nodes.map((entry: DependencyNode): string => entry.id),
        ["src/a.ts", "src/b.ts", "external:react"],
    );
    assert.deepEqual(withExternal.external, ["react"]);
    const withoutExternalReport: DependencyReport = buildDependencyReport(graph, "rev-2", {
        mode: "closure",
        roots: ["src/a.ts"],
        depth: 1,
    });
    assert.deepEqual(
        withoutExternalReport.nodes.map((entry: DependencyNode): string => entry.id),
        ["src/a.ts", "src/b.ts"],
    );
    assert.deepEqual(withoutExternalReport.external, ["react"]);
    const topological: DependencyReport = buildDependencyReport(graph, "rev-2", { mode: "topological", includeExternal: true });
    assert.deepEqual(topological.order, ["src/a.ts", "external:react", "src/b.ts"]);
    assert.deepEqual(topological.cycles, []);
    const dependents: DependencyReport = buildDependencyReport(graph, "rev-2", {
        mode: "dependents",
        roots: ["src/b.ts"],
        depth: 1,
    });
    assert.deepEqual(
        dependents.nodes.map((entry: DependencyNode): string => entry.id),
        ["src/b.ts", "src/a.ts"],
    );
    assert.deepEqual(dependents.edges, [
        { from: "src/a.ts", to: "src/b.ts", kind: "import", specifier: "./b", line: 1 },
        { from: "src/a.ts", to: "src/b.ts", kind: "export", specifier: "./b", line: 4 },
    ]);
    const limited: DependencyReport = buildDependencyReport(graph, "rev-2", {
        mode: "dependencies",
        roots: ["src/a.ts"],
        includeExternal: true,
        limit: 1,
    });
    assert.equal(limited.truncated, true);
    assert.deepEqual(
        limited.nodes.map((entry: DependencyNode): string => entry.id),
        ["src/a.ts"],
    );
});

test("read errors are classified without leaking host paths", (): void => {
    write("src/binary.ts", Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]));
    write("src/large.ts", Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    write("src/self.ts", 'import self from "./self";\n');
    write("secret/hidden.ts", 'import x from "./x";\n');
    const excludedSandbox: PathSandbox = new PathSandbox([{ ...Root, exclude: ["secret"] }]);
    expectCode((): void => {
        extractImports(Sandbox, "../outside.ts");
    }, "path_escape");
    expectCode((): void => {
        extractImports(Sandbox, "/etc/passwd");
    }, "invalid_path");
    expectCode((): void => {
        extractImports(Sandbox, "src/nope.ts");
    }, "not_found");
    expectCode((): void => {
        extractImports(Sandbox, "src");
    }, "not_file");
    expectCode((): void => {
        extractImports(Sandbox, "src/binary.ts");
    }, "binary_file");
    expectCode((): void => {
        extractImports(Sandbox, "src/large.ts");
    }, "quota_exceeded");
    expectCode((): void => {
        extractExports(Sandbox, "src/binary.ts");
    }, "binary_file");
    expectCode((): void => {
        extractImports(excludedSandbox, "secret/hidden.ts");
    }, "excluded_path");
    expectCode((): void => {
        extractImports(Sandbox, "src/bad\u0000path.ts");
    }, "invalid_path");
    assert.deepEqual(importedBy(Sandbox, "../outside.ts", ["src/self.ts"]), []);
    const reverse: ImportEdge[] = importedBy(Sandbox, "src/self.ts", ["src/missing.ts", "src/binary.ts", "src/self.ts", "src/self.ts"]);
    assert.equal(reverse.length, 1);
    assert.equal(reverse[0].from, "src/self.ts");
    assert.equal(reverse[0].specifier, "./self");
});

test("tokenizer and encoding boundaries preserve line numbers and skip pseudo edges", (): void => {
    write("src/a.ts", "export const a = 1;\n");
    write("src/d.ts", "export const d = 1;\n");
    write("src/empty.ts", "");
    write("src/bom.ts", '\uFEFFimport x from "./a";\n');
    write("src/utf16.ts", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('import x from "./a";\n', "utf16le")]));
    write("src/latin1.ts", Buffer.concat([Buffer.from("// caf"), Buffer.from([0xe9]), Buffer.from('\nimport x from "./a";\n')]));
    write("src/crlf.ts", '// first\r\nimport x from "./a";\r\n');
    write(
        "src/nested-literals.ts",
        [
            "const first = 1;",
            "const nested = `outer ${ { nested: `inner ${\"import fake from './fake'\"}` } } tail`;",
            'const re = /[//]+import fake from "./fake"/g;',
            'const obj = { import: "./a", require: "./a" };',
            "const meta = import.meta.url;",
            'const resolved = require.resolve("./a");',
            'import x from "./a\\u002Ets";',
            'const inTemplate = `value ${import("./d")} tail`;',
        ].join("\n"),
    );
    const empty: ImportReport = extractImports(Sandbox, "src/empty.ts");
    assert.deepEqual(empty.imports, []);
    assert.match(empty.fingerprint, /^sha256:[0-9a-f]{64}$/);
    const bom: ImportReport = extractImports(Sandbox, "src/bom.ts");
    assert.equal(bom.imports.length, 1);
    assert.equal(bom.imports[0].line, 1);
    assert.equal(bom.imports[0].to, "src/a.ts");
    const utf16: ImportReport = extractImports(Sandbox, "src/utf16.ts");
    assert.equal(utf16.imports.length, 1);
    assert.equal(utf16.imports[0].line, 1);
    const latin1: ImportReport = extractImports(Sandbox, "src/latin1.ts");
    assert.equal(latin1.imports.length, 1);
    assert.equal(latin1.imports[0].line, 2);
    const crlf: ImportReport = extractImports(Sandbox, "src/crlf.ts");
    assert.equal(crlf.imports.length, 1);
    assert.equal(crlf.imports[0].line, 2);
    const nested: ImportReport = extractImports(Sandbox, "src/nested-literals.ts");
    assert.equal(nested.imports.length, 2);
    assert.equal(nested.imports[0].line, 7);
    assert.equal(nested.imports[0].specifier, "./a.ts");
    assert.equal(nested.imports[0].to, "src/a.ts");
    assert.equal(nested.imports[1].line, 8);
    assert.equal(nested.imports[1].kind, "dynamic");
    assert.equal(nested.imports[1].specifier, "./d");
    assert.equal(nested.imports[1].to, "src/d.ts");
    assert.deepEqual(nested.external, []);
    assert.deepEqual(nested.unresolved, []);
});

test("TSX text and attributes do not manufacture imports or exports", (): void => {
    write("src/a.ts", "export const a = 1;\n");
    write("src/d.ts", "export const d = 1;\n");
    write(
        "src/component.tsx",
        [
            'import real from "./a";',
            'const text = <div>import fake from "./fake"</div>;',
            "const attr = <div title=\"import fakeAttr from './fakeAttr'\">text</div>;",
            'const nested = <section><span>export const ghost = 1;</span>{import("./d")}</section>;',
            'const fragment = <>import fakeFragment from "./fragment"</>;',
            "const compare = 1 < 2;",
            "const identity = <T,>(value: T) => value;",
            "export const component = () => <div>export const ghostTwo = 1;</div>;",
            'const selfClosing = <Comp value={import("./d")} />;',
        ].join("\n"),
    );
    const imports: ImportReport = extractImports(Sandbox, "src/component.tsx");
    assert.equal(imports.imports.length, 3);
    assert.equal(imports.imports[0].specifier, "./a");
    assert.equal(imports.imports[0].line, 1);
    assert.equal(imports.imports[1].kind, "dynamic");
    assert.equal(imports.imports[1].specifier, "./d");
    assert.equal(imports.imports[1].line, 4);
    assert.equal(imports.imports[2].kind, "dynamic");
    assert.equal(imports.imports[2].line, 9);
    assert.deepEqual(imports.external, []);
    assert.deepEqual(imports.unresolved, []);
    const exports: ExportReport = extractExports(Sandbox, "src/component.tsx");
    assert.equal(exportSymbol(exports.exports, "component").kind, "const");
    assert.equal(exportSymbol(exports.exports, "component").line, 8);
    assert.equal(
        exports.exports.some((candidate: ExportSymbol): boolean => candidate.name === "ghost"),
        false,
    );
    assert.equal(
        exports.exports.some((candidate: ExportSymbol): boolean => candidate.name === "ghostTwo"),
        false,
    );
});

test("regex delimiters after expressions do not leak pseudo imports", (): void => {
    write("src/a.ts", "export const a = 1;\n");
    write(
        "src/regex-boundaries.ts",
        [
            "const afterParen = (1 + 2) / 3;",
            "const afterCall = fn(1) / 2;",
            "const afterBracket = [1, 2][0] / 2;",
            "const afterBrace = ({ value: 1 }).value / 2;",
            'if (true) /import fakeParen from "./fakeParen"/.test("x");',
            'if (true) { } /import fakeBlock from "./fakeBlock"/.test("x");',
            'const ratio = total / count; import later from "./a";',
            'const double = a / b / c; import afterDouble from "./a";',
            'const real = require("./a");',
        ].join("\n"),
    );
    const report: ImportReport = extractImports(Sandbox, "src/regex-boundaries.ts");
    assert.equal(report.imports.length, 3);
    assert.equal(report.imports[0].specifier, "./a");
    assert.equal(report.imports[0].line, 7);
    assert.equal(report.imports[1].specifier, "./a");
    assert.equal(report.imports[1].line, 8);
    assert.equal(report.imports[2].kind, "require");
    assert.equal(report.imports[2].line, 9);
    assert.equal(
        report.imports.some((edge: ImportEdge): boolean => edge.specifier.includes("fake")),
        false,
    );
});

test("size, export cap and signature thresholds sit on the documented boundary", (): void => {
    write("src/a.ts", "export const a = 1;\n");
    const sizeLimit: number = 4 * 1024 * 1024;
    const head: string = 'import a from "./a";\n';
    const exact: Buffer = Buffer.concat([Buffer.from(head), Buffer.alloc(sizeLimit - Buffer.byteLength(head), 0x2f)]);
    assert.equal(exact.length, sizeLimit);
    write("src/exact-limit.ts", exact);
    const exactReport: ImportReport = extractImports(Sandbox, "src/exact-limit.ts");
    assert.equal(exactReport.imports.length, 1);
    assert.equal(exactReport.imports[0].to, "src/a.ts");
    const many: string[] = [];
    for (let index: number = 0; index < 5000; index += 1) {
        many.push(`export const value${index} = ${index};`);
    }
    write("src/cap-exact.ts", many.join("\n"));
    const exactExports: ExportReport = extractExports(Sandbox, "src/cap-exact.ts");
    assert.equal(exactExports.exports.length, 5000);
    assert.equal(exactExports.truncated, false);
    write("src/cap-over.ts", [...many, "export const overflow = 1;"].join("\n"));
    const overExports: ExportReport = extractExports(Sandbox, "src/cap-over.ts");
    assert.equal(overExports.exports.length, 5000);
    assert.equal(overExports.truncated, true);
    const stars: string[] = [];
    for (let index: number = 0; index < 5001; index += 1) {
        stars.push('export * from "./a";');
    }
    write("src/cap-reexports.ts", stars.join("\n"));
    const starReport: ExportReport = extractExports(Sandbox, "src/cap-reexports.ts");
    assert.equal(starReport.reexports.length, 5000);
    assert.equal(starReport.truncated, true);
    write("src/signature.ts", `export function longName(): number { return 1; } // ${"x".repeat(300)}\n`);
    const signature: ExportSymbol = exportSymbol(extractExports(Sandbox, "src/signature.ts").exports, "longName");
    assert.equal(signature.signature.length, 200);
    assert.equal(signature.signature.startsWith("export function longName"), true);
});

test("specifier boundaries keep empty, dot, escape and missing inputs unresolved", (): void => {
    write("src/a.ts", "export const a = 1;\n");
    write("src/a.json", "{}\n");
    write("src/prefer.ts", "export const prefer = 1;\n");
    write("src/prefer/index.ts", "export const index = 1;\n");
    write(
        "src/specifier-boundaries.ts",
        [
            'import exact from "./a.ts";',
            'import prefer from "./prefer";',
            'import json from "./a.json";',
            'import missing from "./missing.js";',
            'import node from "node:fs";',
            'import empty from "";',
            'import blanks from "   ";',
            'import dot from ".";',
            'import escape from "../outside";',
        ].join("\n"),
    );
    const report: ImportReport = extractImports(Sandbox, "src/specifier-boundaries.ts");
    assert.equal(importEdge(report.imports, "./a.ts").to, "src/a.ts");
    assert.equal(importEdge(report.imports, "./prefer").to, "src/prefer.ts");
    assert.equal(importEdge(report.imports, "./a.json").to, "src/a.json");
    const missing: ImportEdge = importEdge(report.imports, "./missing.js");
    assert.equal(missing.resolved, false);
    assert.equal(missing.external, false);
    assert.equal(missing.to, "src/missing.js");
    const empty: ImportEdge = importEdge(report.imports, "");
    assert.equal(empty.resolved, false);
    assert.equal(empty.external, false);
    assert.equal(empty.to, "");
    const blanks: ImportEdge = importEdge(report.imports, "   ");
    assert.equal(blanks.resolved, false);
    assert.equal(blanks.external, false);
    assert.equal(blanks.to, "");
    const dot: ImportEdge = importEdge(report.imports, ".");
    assert.equal(dot.resolved, false);
    assert.equal(dot.external, false);
    assert.equal(dot.to, "src/index.ts");
    const escape: ImportEdge = importEdge(report.imports, "../outside");
    assert.equal(escape.resolved, false);
    assert.equal(escape.external, false);
    assert.deepEqual(report.external, ["node:fs"]);
    assert.deepEqual(report.unresolved, ["./missing.js", "", "   ", ".", "../outside"]);
});

test("destructuring exports contribute binding names without property keys or defaults", (): void => {
    write("src/a.ts", "export const a = 1;\n");
    write(
        "src/destructure.ts",
        [
            "const source = { x: 1, y: 2, nested: { deep: 3 } };",
            'const computedKeyName = "x";',
            "export const { x, y: renamed, nested: { deep }, ...rest } = source;",
            "export let [first, , third = 3, ...tail] = [1, 2, 3];",
            'export var { key = "value" } = {};',
            "export const { [computedKeyName]: computed } = source;",
            "export const { withObject = { inner: 1 } } = source;",
            "export const multiOne = 1, multiTwo = 2;",
            "export let { m: multiThree } = source, multiFour = 4;",
            'export const genericValue = identity<string, number>("x");',
            "export const comparisonValue = 1 < 2, comparisonOther = 3;",
            'export const genericMap = make<Map<string, number>>("x"), genericTail = 4;',
            'export { type Local } from "./a";',
            'export type * from "./a";',
        ].join("\n"),
    );
    const report: ExportReport = extractExports(Sandbox, "src/destructure.ts");
    assert.equal(exportSymbol(report.exports, "x").kind, "const");
    assert.equal(exportSymbol(report.exports, "renamed").kind, "const");
    assert.equal(exportSymbol(report.exports, "deep").kind, "const");
    assert.equal(exportSymbol(report.exports, "rest").kind, "const");
    assert.equal(exportSymbol(report.exports, "first").kind, "let");
    assert.equal(exportSymbol(report.exports, "third").kind, "let");
    assert.equal(exportSymbol(report.exports, "tail").kind, "let");
    assert.equal(exportSymbol(report.exports, "key").kind, "var");
    assert.equal(exportSymbol(report.exports, "computed").kind, "const");
    assert.equal(exportSymbol(report.exports, "withObject").kind, "const");
    assert.equal(exportSymbol(report.exports, "multiOne").kind, "const");
    assert.equal(exportSymbol(report.exports, "multiTwo").kind, "const");
    assert.equal(exportSymbol(report.exports, "multiThree").kind, "let");
    assert.equal(exportSymbol(report.exports, "multiFour").kind, "let");
    assert.equal(exportSymbol(report.exports, "genericValue").kind, "const");
    assert.equal(exportSymbol(report.exports, "comparisonValue").kind, "const");
    assert.equal(exportSymbol(report.exports, "comparisonOther").kind, "const");
    assert.equal(exportSymbol(report.exports, "genericMap").kind, "const");
    assert.equal(exportSymbol(report.exports, "genericTail").kind, "const");
    assert.equal(exportSymbol(report.exports, "Local").kind, "reexport");
    assert.equal(report.exports.length, 20);
    const absentNames: string[] = ["y", "nested", "value", "source", "computedKeyName", "inner", "m", "string", "number", "Map", "identity", "make"];
    for (let index: number = 0; index < absentNames.length; index += 1) {
        const absent: string = absentNames[index];
        assert.equal(
            report.exports.some((candidate: ExportSymbol): boolean => candidate.name === absent),
            false,
            `${absent} must not be exported`,
        );
    }
    assert.equal(reexportNamed(report.reexports, "Local").specifier, "./a");
    assert.equal(reexportNamed(report.reexports, "*").specifier, "./a");
});

test("graph thresholds handle empty, self-loop, reverse insertion and deep chains", (): void => {
    const empty: DependencyGraph = new DependencyGraph();
    assert.deepEqual(empty.scc(), []);
    assert.deepEqual(empty.cycles(), []);
    assert.deepEqual(empty.topological(), { order: [], cycles: [] });
    assert.deepEqual(empty.closure(["a"], "dependencies", 3, 500), { nodes: [], edges: [], truncated: false });
    const single: DependencyGraph = new DependencyGraph();
    single.addNode(node("a"));
    assert.deepEqual(single.scc(), [["a"]]);
    assert.deepEqual(single.cycles(), []);
    assert.deepEqual(single.topological(), { order: ["a"], cycles: [] });
    const selfLoop: DependencyGraph = new DependencyGraph();
    selfLoop.addNode(node("a"));
    selfLoop.addEdge(edge("a", "a"));
    assert.deepEqual(selfLoop.scc(), [["a"]]);
    assert.deepEqual(selfLoop.cycles(), [["a"]]);
    assert.deepEqual(selfLoop.topological(), { order: [], cycles: [["a"]] });
    const reverse: DependencyGraph = new DependencyGraph();
    const reverseIds: string[] = ["c", "b", "a"];
    for (let index: number = 0; index < reverseIds.length; index += 1) {
        reverse.addNode(node(reverseIds[index]));
    }
    reverse.addEdge(edge("a", "b"));
    reverse.addEdge(edge("b", "c"));
    assert.deepEqual(reverse.scc(), [["a"], ["b"], ["c"]]);
    assert.deepEqual(reverse.topological().order, ["a", "b", "c"]);
    const duplicate: DependencyGraph = new DependencyGraph();
    duplicate.addNode(node("a"));
    duplicate.addNode(node("b"));
    duplicate.addEdge(edge("a", "b"));
    duplicate.addEdge(edge("a", "b"));
    assert.deepEqual(duplicate.topological(), { order: ["a", "b"], cycles: [] });
    assert.equal(duplicate.closure(["a"], "dependencies", 1, 10).edges.length, 2);
    const deep: DependencyGraph = new DependencyGraph();
    for (let index: number = 0; index < 3000; index += 1) {
        deep.addNode(node(`n${index}`));
    }
    for (let index: number = 0; index + 1 < 3000; index += 1) {
        deep.addEdge(edge(`n${index}`, `n${index + 1}`));
    }
    assert.equal(deep.scc().length, 3000);
    assert.equal(deep.topological().order.length, 3000);
    const bounded: ReturnType<DependencyGraph["closure"]> = deep.closure(["n0"], "dependencies", 10_000, 2000);
    assert.equal(bounded.nodes.length, 2000);
    assert.equal(bounded.truncated, true);
    const zero: ReturnType<DependencyGraph["closure"]> = deep.closure(["n0"], "dependencies", 3, 0);
    assert.deepEqual(zero.nodes, []);
    assert.equal(zero.truncated, true);
    const nan: ReturnType<DependencyGraph["closure"]> = deep.closure(["n0"], "dependencies", Number.NaN, Number.NaN);
    assert.equal(nan.nodes.length, 3000);
    assert.equal(nan.truncated, false);
    const zeroReport: DependencyReport = buildDependencyReport(deep, "rev", { mode: "cycles", limit: 0 });
    assert.equal(zeroReport.nodes.length, 1);
    assert.equal(zeroReport.truncated, true);
    const depthReport: DependencyReport = buildDependencyReport(deep, "rev", { mode: "dependencies", roots: ["n0"], depth: -1 });
    assert.deepEqual(
        depthReport.nodes.map((entry: DependencyNode): string => entry.id),
        ["n0"],
    );
});

test("graph report clamps closure depth and limit prompts to their valid range", (): void => {
    const graph: DependencyGraph = new DependencyGraph();
    const graphIds: string[] = ["a", "b", "c"];
    for (let index: number = 0; index < graphIds.length; index += 1) {
        graph.addNode(node(graphIds[index]));
    }
    graph.addEdge(edge("a", "b"));
    graph.addEdge(edge("b", "c"));
    const deep: DependencyReport = buildDependencyReport(graph, "rev", { mode: "closure", roots: ["a"], depth: 99 });
    assert.deepEqual(
        deep.nodes.map((entry: DependencyNode): string => entry.id),
        ["a", "b", "c"],
    );
    const shallow: DependencyReport = buildDependencyReport(graph, "rev", { mode: "closure", roots: ["a"], depth: -1 });
    assert.deepEqual(
        shallow.nodes.map((entry: DependencyNode): string => entry.id),
        ["a"],
    );
    const zero: DependencyReport = buildDependencyReport(graph, "rev", { mode: "dependencies", roots: ["a"], limit: 0 });
    assert.deepEqual(
        zero.nodes.map((entry: DependencyNode): string => entry.id),
        ["a"],
    );
    assert.equal(zero.truncated, true);
    const nan: DependencyReport = buildDependencyReport(graph, "rev", { mode: "dependencies", roots: ["a"], depth: Number.NaN, limit: Number.NaN });
    assert.deepEqual(
        nan.nodes.map((entry: DependencyNode): string => entry.id),
        ["a", "b", "c"],
    );
});
