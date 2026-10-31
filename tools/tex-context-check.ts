#!/usr/bin/env node
/**
 * Literal LaTeX project/structure checks; fixtures are never compiled.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import { readDocumentDetail } from "../src/context/document.ts";
import type { DocumentDetail } from "../src/context/document.ts";
import { WorkspaceIndex } from "../src/context/workspace.ts";
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import type { Frame } from "../src/frame/frame.ts";
import { scanStructuredWorkspace } from "./support/documentScanner.ts";
import type { StructuredWorkspaceFile } from "./support/documentScanner.ts";

const Files: StructuredWorkspaceFile[] = [
    {
        path: "paper/main.tex",
        content: String.raw`\documentclass{local}
\usepackage[option={a[b]}]{localstyle,amsmath}
\title{A paper}
\begin{document}
\section[Short {title}]{Intro {nested}}
\label{sec:intro}
\input{chapters/method}
\include{chapters/result}
\bibliography{refs}
\includegraphics[width=10cm]{figures/plot}
\end{document}`,
    },
    {
        path: "paper/chapters/method.tex",
        content: String.raw`% !TeX root = ../main.tex
\subsection{Method}
\begin{equation}
E = mc^2 \label{eq:energy}
\end{equation}
\begin{figure}
\caption{A figure}\label{fig:plot}
\end{figure}
\input shared
\input{loop}
`,
    },
    {
        path: "paper/chapters/result.tex",
        content: String.raw`\section*{Results}
See \eqref{eq:energy}, \cref{fig:plot,sec:intro}.
\citep[see][p.~2]{known}
\nocite{*}
`,
    },
    { path: "paper/shared.tex", content: String.raw`\subsubsection{Shared facts} NeedleBeyondSummary ${"padding ".repeat(50)} LAST_EXACT_FACT` },
    { path: "paper/chapters/shared.tex", content: String.raw`\section{Wrong relative fallback}` },
    { path: "paper/loop.tex", content: String.raw`\input{chapters/method}` },
    { path: "paper/local.cls", content: String.raw`\LoadClass{article}` },
    { path: "paper/localstyle.sty", content: String.raw`\RequirePackage{graphicx}` },
    { path: "paper/figures/plot.png", content: new Uint8Array([1, 2, 3]) },
    {
        path: "paper/refs.bib",
        content: String.raw`@string{journal = "Not an entry"}
@article{known, title={An {Exact} Title}, year=2026}
@book(other, title="A parenthesis ) in a quote", author={A. Author})
`,
    },
    {
        path: "other/main.tex",
        content: String.raw`\documentclass{article}
\begin{document}\section{Other}\label{eq:energy}\ref{sec:intro}\end{document}`,
    },
    { path: "readme.md", content: "# Project\nCompanion text" },
    { path: "main.ts", content: "export const answer = 42;" },
];
const Store: MemoryContentStore = new MemoryContentStore();
const Snapshot: WorkspaceSnapshot = scanStructuredWorkspace(Files, Store);
const Index: WorkspaceIndex = new WorkspaceIndex(Snapshot, Store);
const find: (path: string, label: string) => WorkspaceEntity = (path: string, label: string): WorkspaceEntity => {
    const entity: WorkspaceEntity | undefined = Snapshot.entities.find(
        (item: WorkspaceEntity): boolean => item.kind === "knowledge" && item.source.uri === path && item.label === label,
    );
    assert.ok(entity, `Missing ${path}: ${label}`);
    return entity;
};
const frame: (ids: string[]) => Frame = (ids: string[]): Frame => ({
    amp: "0.1",
    kind: "frame",
    id: "f.tex",
    agent: "a.test",
    cycle: 1,
    ts: "2026-10-29T00:00:00Z",
    digest: Snapshot.revision,
    mode: "explore",
    slots: ids.map((id: string): Frame["slots"][number] => ({
        target: { kind: "other", id },
        role: "artifact",
        salience: 1,
        cost: {},
        why: "Explicit TeX selection",
        state: "active",
    })),
    budget: { allocated: { tokens: 16000 }, spent: {} },
});

test("LaTeX build roots expose transitive supplied files, local class/style dependencies and cyclic includes", (): void => {
    const id: string = "knowledge:paper/main.tex#latex-project";
    const detail: DocumentDetail = readDocumentDetail(Index.context(frame([id]), 16000), id)!;
    assert.equal(detail.kind, "tex-project");
    if (detail.kind === "tex-project") {
        assert.equal(detail.root, "paper/main.tex");
        assert.ok(detail.files.includes("paper/chapters/method.tex"));
        assert.ok(detail.files.includes("paper/local.cls"));
        assert.ok(detail.files.includes("paper/localstyle.sty"));
        assert.ok(detail.files.includes("paper/refs.bib"));
        assert.ok(detail.files.includes("paper/figures/plot.png"));
        assert.ok(!detail.files.includes("paper/chapters/shared.tex"));
        assert.ok(!detail.files.includes("other/main.tex"));
        assert.ok(detail.dependencies.some((item): boolean => item.from === "paper/loop.tex" && item.to === "paper/chapters/method.tex"));
    }
    assert.ok(Snapshot.entities.some((item): boolean => item.kind === "package" && item.label === "amsmath"));
    assert.ok(Index.relations("file:paper/main.tex", "outgoing", "imports").some((item): boolean => item.to === "file:paper/local.cls"));
    assert.equal(Snapshot.entities.filter((item): boolean => item.tags?.includes("latex-project")).length, 2);
    assert.ok(!Snapshot.diagnostics.some((item): boolean => item.code === "unsupported_document" || item.code === "invalid_tex"));
});

test("sections, nested environments and raw source retain hierarchy, precise anchors and recall", (): void => {
    const method: WorkspaceEntity = find("paper/chapters/method.tex", "Method");
    const equation: WorkspaceEntity = find("paper/chapters/method.tex", "equation");
    assert.equal(equation.parentId, method.id);
    assert.equal(equation.structureKind, "environment");
    assert.equal(equation.source.startLine, 3);
    assert.equal(equation.source.endLine, 5);
    assert.equal(equation.source.locator!.part, "paper/chapters/method.tex");
    const context: ReturnType<WorkspaceIndex["context"]> = Index.context(frame([equation.id]), 16000);
    assert.deepEqual(readDocumentDetail(context, equation.id), { kind: "text", text: "\\begin{equation}\nE = mc^2 \\label{eq:energy}\n\\end{equation}" });
    assert.equal(readDocumentDetail(context, "file:paper/chapters/result.tex"), (void 0));
    assert.equal(readDocumentDetail(Index.context(frame([equation.id]), 1), equation.id), (void 0));
    const shared: WorkspaceEntity = find("paper/shared.tex", "Shared facts");
    assert.ok(!shared.summary.includes("LAST_EXACT_FACT"));
    assert.ok(Index.query({ text: "LAST_EXACT_FACT", maxDepth: 0 }).candidates.some((item): boolean => item.id === shared.id));
    assert.equal(find("paper/main.tex", "Intro {nested}").structureKind, "section");
    assert.ok(Snapshot.entities.some((item): boolean => item.kind === "symbol" && item.label === "answer"));
});

test("cross-file labels and BibTeX citations resolve within each build project", (): void => {
    const results: WorkspaceEntity = find("paper/chapters/result.tex", "Results");
    const targets: Set<string> = new Set(Index.relations(results.id, "outgoing", "references").map((item): string => item.to));
    assert.ok(targets.has(find("paper/chapters/method.tex", "equation").id));
    assert.ok(targets.has(find("paper/chapters/method.tex", "figure").id));
    assert.ok(targets.has(find("paper/main.tex", "Intro {nested}").id));
    assert.ok(targets.has(find("paper/refs.bib", "known").id));
    assert.ok(targets.has(find("paper/refs.bib", "other").id));
    assert.equal(Index.relations(find("other/main.tex", "Other").id, "outgoing", "references").length, 0);
    assert.ok(Snapshot.diagnostics.some((item): boolean => item.uri === "other/main.tex" && item.code === "tex_unresolved_reference"));
    assert.ok(!Snapshot.diagnostics.some((item): boolean => item.uri.startsWith("paper/") && item.code === "tex_ambiguous_reference"));
});

test("comments, verbatim, inline verb and macro definitions create no fake structural facts", (): void => {
    const text: string = String.raw`% \section{Comment fake}\input{never-comment}
\newcommand{\fake}[1]{\section{Macro fake}\input{never-macro}}
\def\other#1{\section{Def fake}\label{ghost}}
\newenvironment{demo}{\input{never-env}}{\section{Env fake}}
\verb|\section{Inline fake}\input{never-inline}|
\begin{verbatim}
% Literal percent \section{Verbatim fake}
\input{never-verbatim}
\end{verbatim}
\section% comment between command and argument
{Actual}
Escaped percent \% visible
\subsection[short {nested [bracket]}]{Child {title}}
\begin{proof}Proof\begin{itemize}\item Fact\end{itemize}\end{proof}
`;
    const snapshot: WorkspaceSnapshot = scanStructuredWorkspace([{ path: "literal.TeX", content: text }], new MemoryContentStore());
    assert.deepEqual(
        snapshot.entities.filter((item): boolean => item.structureKind === "section").map((item): string => item.label),
        ["Actual", "Child {title}"],
    );
    assert.ok(!snapshot.diagnostics.some((item): boolean => item.code === "tex_unresolved_dependency" || item.code === "invalid_tex"));
    const proof: WorkspaceEntity = snapshot.entities.find((item): boolean => item.label === "proof")!;
    const list: WorkspaceEntity = snapshot.entities.find((item): boolean => item.label === "itemize")!;
    assert.equal(list.parentId, proof.id);
});

test("project summary revisions track included files and rebuilds remove deleted sections", (): void => {
    const id: string = "knowledge:paper/main.tex#latex-project";
    assert.equal(Index.summaryState(id), "fresh");
    const sources: Map<string, string> = new Map(
        Snapshot.entities.filter((item): boolean => item.kind === "file").map((item): [string, string] => [item.source.uri, item.source.revision]),
    );
    sources.set("paper/chapters/method.tex", "changed");
    assert.equal(
        Index.summaryState(
            id,
            [...sources].map(([uri, revision]: [string, string]) => ({ uri, revision })),
        ),
        "stale",
    );
    assert.equal(Index.summaryState(id), "fresh");
    const copy: WorkspaceSnapshot = Index.snapshot();
    copy.entities.find((item): boolean => item.id === "file:paper/chapters/method.tex")!.source.revision = "changed";
    const stale: WorkspaceIndex = new WorkspaceIndex(copy, Store);
    assert.equal(stale.summaryState(id), "stale");
    assert.match(stale.project().node(id)!.summary, /summary stale/);
    const rebuilt: WorkspaceSnapshot = scanStructuredWorkspace(
        Files.map((input: StructuredWorkspaceFile): StructuredWorkspaceFile =>
            input.path === "paper/chapters/method.tex" ? { ...input, content: "\\section{Revised}" } : input,
        ),
        Store,
    );
    assert.ok(!rebuilt.entities.some((item): boolean => item.label === "Method"));
    assert.ok(Index.entity(find("paper/chapters/method.tex", "Method").id));
});

test("root hints, standalone fragments, dynamic paths and missing files remain explicit", (): void => {
    const snapshot: WorkspaceSnapshot = scanStructuredWorkspace(
        [
            {
                path: "work/root.ltx",
                content: String.raw`\section{Root}\input{child}\input{\jobname-extra}\input{../../outside}\input{https://example.org/x}\ref{missing}`,
            },
            { path: "work/child.tex", content: "% !TeX root = root.ltx\n\\section{Child}" },
            { path: "fragment.tex", content: "\\section{Fragment}\\input{absent}" },
            { path: "lost.tex", content: "% !TeX root = missing.tex\n\\section{Lost}" },
        ],
        new MemoryContentStore(),
    );
    const index: WorkspaceIndex = new WorkspaceIndex(snapshot, new MemoryContentStore());
    assert.ok(index.entity("knowledge:work/root.ltx#latex-project"));
    assert.ok(!index.entity("file:outside.tex"));
    assert.ok(snapshot.diagnostics.some((item): boolean => item.uri === "fragment.tex" && item.code === "tex_unresolved_dependency"));
    assert.ok(snapshot.diagnostics.some((item): boolean => item.code === "tex_unresolved_root"));
    assert.ok(snapshot.diagnostics.filter((item): boolean => item.code === "tex_unresolved_dependency").length >= 4);
});

test("duplicate labels/citations, malformed groups and invalid UTF-8 cannot publish invented facts", (): void => {
    const snapshot: WorkspaceSnapshot = scanStructuredWorkspace(
        [
            { path: "main.tex", content: String.raw`\begin{document}\section{A}\label{same}\label{same}\ref{same}\bibliography{refs}\cite{dup}\end{document}` },
            { path: "refs.bib", content: "@article{dup,title={First}}\n@book{dup,title={Second}}" },
            { path: "broken.tex", content: "\\section{Unclosed" },
            { path: "deep.tex", content: `\\section{${"{".repeat(130)}deep${"}".repeat(131)}` },
            { path: "broken.bib", content: "@book{unclosed,title={Missing}" },
            { path: "invalid.tex", content: new Uint8Array([0xff]) },
            { path: "mismatch.tex", content: String.raw`\begin{proof}Partial\end{table}` },
        ],
        new MemoryContentStore(),
    );
    assert.equal(snapshot.diagnostics.filter((item): boolean => item.code === "tex_ambiguous_reference").length, 2);
    assert.equal(snapshot.diagnostics.filter((item): boolean => item.code === "invalid_tex").length, 4);
    assert.ok(snapshot.diagnostics.some((item): boolean => item.code === "tex_environment_mismatch"));
    assert.ok(
        !snapshot.entities.some(
            (item): boolean => item.kind === "knowledge" && ["broken.tex", "deep.tex", "broken.bib", "invalid.tex"].includes(item.source.uri),
        ),
    );
    assert.doesNotThrow((): void => {
        new WorkspaceIndex(snapshot, Store);
    });
    assert.throws((): void => {
        scanStructuredWorkspace([{ path: "../outside.tex", content: "ignored" }], Store);
    });
});
