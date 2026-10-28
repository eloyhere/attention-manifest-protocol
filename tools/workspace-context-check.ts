#!/usr/bin/env node
/**
 * End-to-end fixtures for project trees, manifest/code graphs, knowledge
 * retrieval and Frame-scoped detail access. No fixture code is executed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import { WorkspaceIndex } from "../src/context/workspace.ts";
import type { WorkspaceEntity, WorkspaceQueryResult, WorkspaceSnapshot } from "../src/context/workspace.ts";
import type { Context } from "../src/context/lifecycle.ts";
import type { Frame } from "../src/frame/frame.ts";
import { scanWorkspace } from "./support/workspaceScanner.ts";
import type { WorkspaceFile } from "./support/workspaceScanner.ts";

const Files: WorkspaceFile[] = [
    { path: "package.json", content: '{"name":"root","dependencies":{"app":"workspace:*","external":"^2"}}' },
    { path: "packages/app/package.json", content: '{"name":"app","dependencies":{"lib":"workspace:*"}}' },
    { path: "packages/lib/package.json", content: '{"name":"lib","dependencies":{"app":"workspace:*"}}' },
    { path: "tsconfig.json", content: '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["packages/lib/*"]}}}' },
    { path: "packages/lib/calc.ts", content: "export function computeValue(n: number): number { return n ? computeValue(n - 1) : 0; }" },
    {
        path: "packages/app/main.ts",
        content: 'import { computeValue as run } from "@lib/calc"; import "./cycle.ts"; export function main() { return run(2); }',
    },
    { path: "packages/app/cycle.ts", content: 'import "./main.ts"; import "./missing.ts"; // import "./fake.ts";\nexport const text = "import fake from x";' },
    { path: "docs/design.md", content: "# Compute policy\nUse the [calculator](../packages/lib/calc.ts).\n\n## Constraint\nKeep recursion bounded.\n" },
    { path: "private.md", content: "# Secret\nUNALLOCATED KNOWLEDGE DETAIL" },
];
const Store: MemoryContentStore = new MemoryContentStore();
const Snapshot: WorkspaceSnapshot = scanWorkspace(Files, Store);
const Index: WorkspaceIndex = new WorkspaceIndex(Snapshot, Store);
const find: (kind: WorkspaceEntity["kind"], label: string) => WorkspaceEntity = (kind: WorkspaceEntity["kind"], label: string): WorkspaceEntity => {
    const entity: WorkspaceEntity | undefined = Snapshot.entities.find((item: WorkspaceEntity): boolean => item.kind === kind && item.label === label);
    assert.ok(entity, `${kind} ${label} must exist`);
    return entity;
};
const makeFrame: (ids: string[]) => Frame = (ids: string[]): Frame => ({
    amp: "0.1",
    kind: "frame",
    id: "f.workspace",
    agent: "a.test",
    cycle: 1,
    ts: "2026-10-29T00:00:00Z",
    digest: "0".repeat(64),
    mode: "explore",
    slots: ids.map((id: string): Frame["slots"][number] => ({
        target: { kind: "other", id },
        role: "artifact",
        salience: 1,
        cost: {},
        why: "explicit workspace selection",
        state: "active",
    })),
    budget: { allocated: { tokens: 8000 }, spent: {} },
});

const summaryFixture: (count: number, shape: "deep" | "wide") => WorkspaceSnapshot = (count: number, shape: "deep" | "wide"): WorkspaceSnapshot => {
    const entities: WorkspaceEntity[] = [
        {
            id: "project",
            kind: "project",
            projectId: "project",
            label: "project",
            summary: "project",
            source: { uri: "package.json", revision: "1" },
        },
    ];
    for (let index: number = 0; index < count; index += 1) {
        entities.push({
            id: `n${index}`,
            kind: "knowledge",
            projectId: "project",
            parentId: index === 0 ? "project" : shape === "deep" ? `n${index - 1}` : "n0",
            label: `section ${index}`,
            summary: "exclusiveSummaryWord",
            source: { uri: "book.tex", revision: "1" },
            summaryProvenance: {
                method: "extractive-v1",
                sources: [{ uri: "book.tex", revision: "1" }],
                children: shape === "deep" && index + 1 < count ? [`n${index + 1}`] : [],
            },
        });
    }
    if (shape === "wide") {
        entities[1].summaryProvenance!.children = entities.slice(2).map((entity: WorkspaceEntity): string => entity.id);
    }
    return { version: 1, revision: "fixture", entities, relations: [], diagnostics: [] };
};

test("deep document summaries avoid recursion and propagate descendant invalidation", (): void => {
    const snapshot: WorkspaceSnapshot = summaryFixture(12000, "deep");
    const index: WorkspaceIndex = new WorkspaceIndex(snapshot, Store);
    assert.equal(index.summaryState("n0"), "fresh");
    assert.equal(index.summaryState("n11999"), "fresh");
    assert.equal(index.summaryState("n0", [{ uri: "book.tex", revision: "2" }]), "stale");
    assert.equal(index.summaryState("n0"), "fresh");
    snapshot.entities.at(-1)!.summaryProvenance!.sources[0].revision = "old";
    const stale: WorkspaceIndex = new WorkspaceIndex(snapshot, Store);
    assert.equal(stale.summaryState("n0"), "stale");
    assert.equal(stale.summaryState("n11999"), "stale");
    assert.equal(stale.query({ text: "exclusiveSummaryWord" }).candidates.length, 0);
});

test("wide summary dependencies handle missing provenance and conflicting source revisions", (): void => {
    const snapshot: WorkspaceSnapshot = summaryFixture(8000, "wide");
    const index: WorkspaceIndex = new WorkspaceIndex(snapshot, Store);
    assert.equal(index.summaryState("n0"), "fresh");
    assert.equal(
        index.summaryState("n0", [
            { uri: "book.tex", revision: "1" },
            { uri: "book.tex", revision: "2" },
        ]),
        "stale",
    );
    assert.equal(index.summaryState("n0", []), "stale");
    assert.equal(index.summaryState("unknown"), "untracked");
    delete snapshot.entities.at(-1)!.summaryProvenance;
    const untracked: WorkspaceIndex = new WorkspaceIndex(snapshot, Store);
    assert.equal(untracked.summaryState("n7999"), "untracked");
    assert.equal(untracked.summaryState("n0"), "stale");
    assert.equal(untracked.summaryState("n1"), "fresh");
    snapshot.entities.at(-1)!.source.revision = "2";
    const conflict: WorkspaceIndex = new WorkspaceIndex(snapshot, Store);
    assert.equal(conflict.summaryState("n1"), "stale");
});

test("project ownership, tree navigation and cyclic declared dependencies stay distinct", (): void => {
    assert.equal(Index.entity("file:packages/app/main.ts")?.projectId, "project:packages/app");
    assert.ok(Index.children("project:packages/app").some((entity: WorkspaceEntity): boolean => entity.id === "file:packages/app/main.ts"));
    assert.equal(Index.relations("project:packages/app", "outgoing", "project_depends_on")[0].to, "project:packages/lib");
    assert.equal(Index.relations("project:packages/lib", "outgoing", "project_depends_on")[0].to, "project:packages/app");
    assert.doesNotThrow((): void => {
        Index.project().view(20000);
    });
    assert.match(find("package", "external").summary, /declared \^2; installed version not inspected/);
});

test("compiler resolves aliased calls, tsconfig paths, recursion and import cycles", (): void => {
    const compute: WorkspaceEntity = find("symbol", "computeValue");
    const main: WorkspaceEntity = find("symbol", "main");
    assert.ok(Index.relations(main.id, "outgoing", "calls").some((edge): boolean => edge.to === compute.id));
    assert.ok(Index.relations(compute.id, "outgoing", "calls").some((edge): boolean => edge.to === compute.id));
    assert.equal(Index.relations("file:packages/app/main.ts", "outgoing", "imports")[0].to, "file:packages/lib/calc.ts");
    assert.ok(Index.relations("file:packages/app/cycle.ts", "outgoing", "imports").some((edge): boolean => edge.to === "file:packages/app/main.ts"));
    assert.ok(Snapshot.diagnostics.some((item): boolean => item.code === "unresolved_import" && item.message === "./missing.ts"));
    assert.ok(!Snapshot.relations.some((edge): boolean => /fake/.test(edge.to)));
});

test("knowledge chunks retain content hashes, line ranges and explicit code links", (): void => {
    const knowledge: WorkspaceEntity = find("knowledge", "Compute policy");
    assert.equal(knowledge.source.startLine, 1);
    assert.equal(knowledge.source.endLine, 3);
    assert.match(Store.get(knowledge.detailRef!)!, /calculator/);
    assert.equal(Index.relations(knowledge.id, "outgoing", "documents")[0].to, "file:packages/lib/calc.ts");
    assert.match(knowledge.source.revision, /^[a-f0-9]{64}$/);
});

test("UTF-8 BOM inputs parse like compiler files while stored file bodies retain original bytes", (): void => {
    const body: string = "\uFEFF#!/usr/bin/env node\nexport function run() { return 1; }\nrun();";
    const snapshot: WorkspaceSnapshot = scanWorkspace(
        [
            { path: "package.json", content: '\uFEFF{"name":"bom-project"}' },
            { path: "main.ts", content: body },
            { path: "guide.md", content: "\uFEFF# Guide\nText" },
        ],
        Store,
    );
    const index: WorkspaceIndex = new WorkspaceIndex(snapshot, Store);
    assert.equal(snapshot.diagnostics.length, 0);
    assert.equal(index.entity("project:.")!.label, "bom-project");
    assert.equal(Store.get(index.entity("file:main.ts")!.detailRef!), body);
    assert.equal(index.entity("knowledge:guide.md#L1")!.label, "Guide");
    assert.equal(index.relations("file:main.ts", "outgoing", "calls").length, 1);
});

test("lexical retrieval, directional navigation and project scope precede allocation", (): void => {
    const compute: WorkspaceEntity = find("symbol", "computeValue");
    const main: WorkspaceEntity = find("symbol", "main");
    const incoming: WorkspaceQueryResult = Index.query({ seedIds: [compute.id], relationKinds: ["calls"], direction: "incoming", maxDepth: 1 });
    assert.deepEqual(new Set(incoming.candidates.map((candidate): string => candidate.id)), new Set([compute.id, main.id]));
    const scoped: WorkspaceQueryResult = Index.query({
        seedIds: [compute.id],
        projectIds: ["project:packages/lib"],
        relationKinds: ["calls"],
        direction: "incoming",
    });
    assert.deepEqual(
        scoped.candidates.map((candidate): string => candidate.id),
        [compute.id],
    );
    assert.equal(Index.query({ seedIds: [compute.id], projectIds: [] }).candidates.length, 0);
    assert.deepEqual(
        Index.query({ text: "compute policy", maxDepth: 0 }).candidates.map((candidate): string => candidate.id),
        ["file:docs/design.md", "knowledge:docs/design.md#L1"],
    );
    assert.equal(Index.query({ text: "compute nonmatchingword" }).candidates.length, 0);
    assert.deepEqual(Index.query({ seedIds: ["unknown"] }).unknownIds, ["unknown"]);
    assert.equal(Index.query({ seedIds: [compute.id], relationKinds: ["calls"], limit: 1 }).truncated, true);
    assert.throws(() => Index.query({ maxDepth: -1 }), RangeError);
    assert.throws(() => Index.query({ limit: 0 }), RangeError);
});

test("full knowledge text is searchable while fenced headings and example links create no graph facts", (): void => {
    const snapshot: WorkspaceSnapshot = scanWorkspace(
        [
            {
                path: "guide.md",
                content: `# Guide\n${"padding ".repeat(50)}\nneedleBeyondSummary\n\n\x60\x60\x60md\n# Fake heading\n[example](missing.ts)\n\x60\x60\x60\n\x60[inline](also-missing.ts)\x60\n## Real section\nTail`,
            },
        ],
        Store,
    );
    const index: WorkspaceIndex = new WorkspaceIndex(snapshot, Store);
    assert.equal(snapshot.entities.filter((entity): boolean => entity.kind === "knowledge").length, 2);
    assert.equal(index.query({ text: "needleBeyondSummary", maxDepth: 0 }).candidates[0].id, "knowledge:guide.md#L1");
    assert.equal(snapshot.relations.length, 0);
    assert.equal(snapshot.diagnostics.length, 0);
});

test("compiler-only project edges, missing aliases and shadowed loaders preserve extraction meaning", (): void => {
    const snapshot: WorkspaceSnapshot = scanWorkspace(
        [
            { path: "package.json", content: '{"name":"root","dependencies":{"lib":"^1"}}' },
            { path: "lib/package.json", content: '{"name":"lib"}' },
            { path: "lib/value.ts", content: "export const value = 1;" },
            { path: "app/package.json", content: '{"name":"app"}' },
            { path: "app/main.ts", content: 'import { value } from "../lib/value.ts"; import "@lib/missing"; export const result = value;' },
            { path: "tsconfig.json", content: '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["lib/*"]}}}' },
            { path: "local.ts", content: 'function require(name: string) { return name; } require("./imaginary.ts");' },
        ],
        Store,
    );
    const index: WorkspaceIndex = new WorkspaceIndex(snapshot, Store);
    assert.ok(
        index.relations("project:app", "outgoing", "project_depends_on").some((edge): boolean => edge.to === "project:lib" && edge.method === "compiler"),
    );
    assert.equal(index.entity(index.relations("project:.", "outgoing", "project_depends_on")[0].to)!.kind, "package");
    assert.ok(snapshot.diagnostics.some((item): boolean => item.code === "unresolved_import" && item.message === "@lib/missing"));
    assert.ok(!snapshot.diagnostics.some((item): boolean => item.message === "./imaginary.ts"));
    assert.equal(index.relations("file:local.ts", "outgoing", "imports").length, 0);
    assert.equal(index.relations("file:local.ts", "outgoing", "calls").length, 1);
});

test("one Frame can combine all four layers and expose only allocated details", (): void => {
    const compute: WorkspaceEntity = find("symbol", "computeValue");
    const main: WorkspaceEntity = find("symbol", "main");
    const knowledge: WorkspaceEntity = find("knowledge", "Compute policy");
    const ids: string[] = [main.id, compute.id, knowledge.id];
    const frame: Frame = makeFrame(ids);
    const context: Context = Index.context(frame, 8000);
    assert.ok(context.view!.relations.some((edge): boolean => edge.kind === "calls"));
    assert.ok(context.view!.relations.some((edge): boolean => edge.kind === "project_depends_on"));
    assert.ok(context.view!.relations.some((edge): boolean => edge.kind === "documents"));
    assert.match(context.view!.text, /source=.*calc.ts/);
    assert.ok(context.view!.tokens <= 8000);
    assert.equal(context.expand(compute.id), Files.find((file): boolean => file.path === "packages/lib/calc.ts")!.content);
    assert.equal(context.expand("file:private.md"), (void 0));
    assert.equal(context.expand("knowledge:private.md#L1"), (void 0));
    assert.doesNotMatch(context.view!.text, /UNALLOCATED KNOWLEDGE/);
    const single: Context = Index.context(makeFrame([main.id]), 8000);
    assert.equal(single.expand(compute.id), (void 0));
    assert.ok(!single.view!.nodes.some((node): boolean => node.id === compute.id));
    assert.deepEqual(
        frame.slots.map((slot): string => slot.target.id),
        ids,
    );
    const tight: Context = Index.context(makeFrame([main.id]), 1);
    assert.equal(tight.expand(main.id), (void 0));
    assert.equal(tight.view!.nodes.length, 0);
});

test("snapshots and disposable projections cannot corrupt source facts or indexes", (): void => {
    const copied: WorkspaceSnapshot = Index.snapshot();
    copied.entities[0].source.uri = "tampered";
    copied.entities[0].summary = "tampered";
    copied.relations[0].to = "tampered";
    const entity: WorkspaceEntity = Index.entity(Snapshot.entities[0].id)!;
    entity.source.uri = "tampered again";
    const graph: ReturnType<WorkspaceIndex["project"]> = Index.project();
    graph.node(entity.id)!.summary = "tampered projection";
    assert.notEqual(Index.entity(entity.id)!.summary, "tampered projection");
    assert.notEqual(Index.entity(entity.id)!.source.uri, "tampered again");
    assert.deepEqual(new WorkspaceIndex(Index.snapshot(), Store).query({ text: "compute" }), Index.query({ text: "compute" }));
});

test("rebuilds invalidate changed facts and remove deleted entities without mutating old snapshots", (): void => {
    const changed: WorkspaceFile[] = Files.filter((file): boolean => file.path !== "private.md").map((file): WorkspaceFile =>
        file.path === "packages/lib/calc.ts" ? { ...file, content: "export const replacement = 1;" } : file,
    );
    const rebuilt: WorkspaceSnapshot = scanWorkspace(changed, Store);
    const current: WorkspaceIndex = new WorkspaceIndex(rebuilt, Store);
    assert.notEqual(current.revision, Index.revision);
    assert.equal(current.entity("file:private.md"), (void 0));
    assert.equal(current.query({ text: "computeValue", projectIds: ["project:packages/lib"], maxDepth: 0 }).candidates.length, 0);
    assert.notEqual(current.entity("file:packages/lib/calc.ts")!.source.revision, Index.entity("file:packages/lib/calc.ts")!.source.revision);
    assert.ok(Index.entity("file:private.md"));
    assert.equal(scanWorkspace([...Files].reverse(), Store).revision, Snapshot.revision);
});

test("malformed identities, hierarchy cycles, unknown edges and escaped paths are rejected", (): void => {
    const duplicate: WorkspaceSnapshot = Index.snapshot();
    duplicate.entities.push(duplicate.entities[0]);
    assert.throws(() => new WorkspaceIndex(duplicate, Store), /duplicate/);
    const cycle: WorkspaceSnapshot = Index.snapshot();
    const children: WorkspaceEntity[] = cycle.entities.filter((entity): boolean => entity.kind === "file" && entity.projectId === "project:.").slice(0, 2);
    children[0].parentId = children[1].id;
    children[1].parentId = children[0].id;
    assert.throws(() => new WorkspaceIndex(cycle, Store), /cycle/);
    const edge: WorkspaceSnapshot = Index.snapshot();
    edge.relations[0].to = "unknown";
    assert.throws(() => new WorkspaceIndex(edge, Store), /invalid workspace relation/);
    const missingSource: WorkspaceSnapshot = Index.snapshot();
    missingSource.entities[0].source.revision = "";
    assert.throws(() => new WorkspaceIndex(missingSource, Store), /source URI and revision/);
    assert.throws(() => scanWorkspace([{ path: "../outside.ts", content: "" }], Store), /invalid/);
    assert.throws(() => scanWorkspace([{ path: "C:\\outside.ts", content: "" }], Store), /invalid/);
    const invalid: WorkspaceSnapshot = scanWorkspace(
        [
            { path: "package.json", content: "{" },
            { path: "main.ts", content: "function (" },
        ],
        Store,
    );
    assert.ok(invalid.diagnostics.some((item): boolean => item.code === "invalid_manifest"));
    assert.ok(invalid.diagnostics.some((item): boolean => item.code === "syntax_error"));
    assert.doesNotThrow((): void => {
        new WorkspaceIndex(invalid, Store);
    });
});
