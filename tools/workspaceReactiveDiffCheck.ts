#!/usr/bin/env node
/**
 * Exercise the reactive and diff workspace tools.
 *
 * Four implemented tools share one fixture scanned through the real
 * `scanStructuredWorkspace` adapter: `package.json`, `c.ts`, `a.ts`, `d.ts` and
 * `src/util.ts`. The `a.ts -> c.ts` and `d.ts -> a.ts` imports make the
 * `exportation`/`importation` assertions meaningful, and the multi-byte
 * character in `util.ts` exercises byte-addressed splicing.
 *
 * One immutable snapshot serves every area; each test builds a fresh service
 * because writer calls, materialized Contexts and the reactive overlay/cache
 * are per-instance state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceServiceLimits, WorkspaceWriteRequest, WorkspaceWriter } from "../src/context/workspaceService.ts";
import type { Frame } from "../src/frame/frame.ts";
import { ToolIds } from "../src/naming/index.ts";
import type {
    WorkspaceDiffHunk,
    WorkspaceDiffNode,
    WorkspaceExportation,
    WorkspaceImportation,
    WorkspaceReactiveNode,
    WorkspaceResponse,
} from "../src/protocol/workspace.ts";
import { scanStructuredWorkspace } from "./support/documentScanner.ts";

interface ServiceOptions {
    writer?: WorkspaceWriter;
    limits?: Partial<WorkspaceServiceLimits>;
}

interface RecordedWriter {
    writer: WorkspaceWriter;
    requests: WorkspaceWriteRequest[];
}

/**
 * In-process shape of a reactive node. The proxy has no `content` member, which
 * is declared optional here only so the assertion can read it.
 */
interface ReactiveProxy {
    id: string;
    kind: string;
    label: string;
    summary: string;
    tags: string[];
    path: string;
    revision: string;
    childCount: number;
    children: ReactiveProxy[];
    content?: unknown;
}

interface ReactiveAnnotation {
    nodeId: string;
    property: string;
    value: string | string[];
    revision: string;
    cacheVersion: number;
    invalidated: string[];
}

/**
 * Bounded wire projection produced by `JSON.stringify` over the proxies.
 */
interface ReactiveWire {
    revision: string;
    cacheVersion: number;
    roots: WorkspaceReactiveNode[];
    nodes: number;
}

/**
 * Payload of the guarded `reactive_write` content path, which reuses `write`.
 */
interface WritePayload {
    nodeId: string;
    path: string;
    mode: "node" | "lines" | "bytes";
    dryRun: boolean;
    previousRevision: string;
    revision: string | null;
    bytes: number;
    lines: number;
    exportation: WorkspaceExportation;
    importation: WorkspaceImportation;
}

interface DiffWire {
    revision: string;
    roots: WorkspaceDiffNode[];
    files: number;
    nodes: number;
    truncated: boolean;
}

/**
 * Payload of `diff_write`: strategy, diff counts, hunk geometry and impacts.
 */
interface DiffWritePayload {
    nodeId: string;
    path: string;
    strategy: "whole" | "lines" | "bytes";
    dryRun: boolean;
    previousRevision: string;
    revision: string | null;
    bytes: number;
    lines: number;
    added: number;
    removed: number;
    unchanged: number;
    diffTruncated: boolean;
    hunks: WorkspaceDiffHunk[];
    remainingTokens: number;
    exportation: WorkspaceExportation;
    importation: WorkspaceImportation;
}

const ContentC: string = "export const xx = 1;\n";
const ContentA: string = 'import { xx } from "./c.ts";\nexport const xxx = xx;\n';
const ContentD: string = 'import { xxx } from "./a.ts";\nconsole.log(xxx);\n';
const ContentUtil: string = "export function helper(): number {\n    return 1; // caf\u00e9\n}\n";

const Store: MemoryContentStore = new MemoryContentStore();
const Snapshot: WorkspaceSnapshot = scanStructuredWorkspace(
    [
        { path: "package.json", content: '{"name":"fixture"}' },
        { path: "c.ts", content: ContentC },
        { path: "a.ts", content: ContentA },
        { path: "d.ts", content: ContentD },
        { path: "src/util.ts", content: ContentUtil },
    ],
    Store,
);
const Revision: string = Snapshot.revision;
const Target: string = "file:a.ts";
const UtilTarget: string = "file:src/util.ts";

/**
 * One fixture entity by id, so assertions take the revision the snapshot
 * recorded instead of a repeated literal hash.
 */
const entityOf: (id: string) => WorkspaceEntity = (id: string): WorkspaceEntity => {
    const found: WorkspaceEntity | undefined = Snapshot.entities.find((item: WorkspaceEntity): boolean => item.id === id);
    assert.ok(found, `entity ${id} must exist`);
    return found!;
};

const snapshotRevisionOf: (id: string) => string = (id: string): string => entityOf(id).source.revision;

/**
 * Symbol id by label; the id embeds a byte offset, so deriving it keeps the
 * fixture free to move the declaration.
 */
const symbolOf: (label: string) => string = (label: string): string => {
    const found: WorkspaceEntity | undefined = Snapshot.entities.find(
        (item: WorkspaceEntity): boolean => item.kind === "symbol" && item.label === label,
    );
    assert.ok(found, `symbol ${label} must exist`);
    return found!.id;
};

const data: (response: WorkspaceResponse) => Record<string, unknown> = (response: WorkspaceResponse): Record<string, unknown> => {
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) {
        throw new Error("expected success");
    }
    return response.data;
};

const code: (response: WorkspaceResponse) => string = (response: WorkspaceResponse): string => {
    assert.equal(response.ok, false, JSON.stringify(response));
    if (!("error" in response)) {
        throw new Error("expected error");
    }
    return response.error.code;
};

const call: (host: WorkspaceAgentService, tool: string, args?: Record<string, unknown>) => WorkspaceResponse = (
    host: WorkspaceAgentService, tool: string, args: Record<string, unknown> = {},
): WorkspaceResponse => host.call(tool, { revision: Revision, ...args });

const frameOf: (id: string, nodeIds: readonly string[], tokens?: number) => Frame = (
    id: string, nodeIds: readonly string[], tokens: number = 4000,
): Frame => ({
    amp: "0.1",
    kind: "frame",
    id,
    agent: "a.test",
    cycle: 0,
    ts: "2026-10-29T00:00:00Z",
    digest: "0".repeat(64),
    mode: "explore",
    slots: nodeIds.map((nodeId: string): Frame["slots"][number] => ({
        target: { kind: "other", id: nodeId },
        role: "artifact",
        salience: 1,
        cost: {},
        why: "host selected this target",
        state: "active",
    })),
    budget: { allocated: { tokens }, spent: {} },
});

const serviceOf: (options?: ServiceOptions) => WorkspaceAgentService = (options: ServiceOptions = {}): WorkspaceAgentService =>
    new WorkspaceAgentService({
        agentId: "a.test",
        projectIds: ["project:."],
        snapshot: Snapshot,
        store: Store,
        ...(options.writer === (void 0) ? {} : { writer: options.writer }),
        ...(options.limits === (void 0) ? {} : { limits: options.limits }),
    });

/**
 * Register a Frame and materialize it, mirroring the host sequence a caller
 * needs before any guarded write.
 */
const materializedContext: (host: WorkspaceAgentService, nodeIds: readonly string[], frameId?: string) => string = (
    host: WorkspaceAgentService, nodeIds: readonly string[], frameId: string = "f.check",
): string => {
    host.registerFrame(frameOf(frameId, nodeIds), Revision);
    const view: Record<string, unknown> = data(call(host, ToolIds.workspaceMaterialize, { frameId, budgetTokens: 4000 }));
    nodeIds.forEach((nodeId: string): void => {
        assert.ok((view.readableIds as string[]).includes(nodeId), `readable ${nodeId}`);
    });
    return view.contextId as string;
};

const jsonOf: (value: unknown) => unknown = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const reactiveNodesOf: (nodes: readonly WorkspaceReactiveNode[]) => WorkspaceReactiveNode[] = (
    nodes: readonly WorkspaceReactiveNode[],
): WorkspaceReactiveNode[] => nodes.flatMap((node: WorkspaceReactiveNode): WorkspaceReactiveNode[] => [node, ...reactiveNodesOf(node.children)]);

const reactiveWireNodeOf: (wire: ReactiveWire, id: string) => WorkspaceReactiveNode | undefined = (
    wire: ReactiveWire, id: string,
): WorkspaceReactiveNode | undefined => reactiveNodesOf(wire.roots).find((node: WorkspaceReactiveNode): boolean => node.id === id);

const diffNodesOf: (nodes: readonly WorkspaceDiffNode[]) => WorkspaceDiffNode[] = (nodes: readonly WorkspaceDiffNode[]): WorkspaceDiffNode[] =>
    nodes.flatMap((node: WorkspaceDiffNode): WorkspaceDiffNode[] => [node, ...diffNodesOf(node.children)]);

const diffNodeOf: (wire: DiffWire, id: string) => WorkspaceDiffNode | undefined = (wire: DiffWire, id: string): WorkspaceDiffNode | undefined =>
    diffNodesOf(wire.roots).find((node: WorkspaceDiffNode): boolean => node.id === id);

const diffFilePathsOf: (wire: DiffWire) => string[] = (wire: DiffWire): string[] =>
    diffNodesOf(wire.roots)
        .filter((node: WorkspaceDiffNode): boolean => node.kind === "file")
        .map((node: WorkspaceDiffNode): string => node.path);

const linkPathsOf: (impact: unknown) => string[] = (impact: unknown): string[] =>
    ((impact as { files: Array<{ path: string; }>; }).files ?? []).map((item: { path: string; }): string => item.path);

/**
 * Host write port double. It records every request and answers with a revision
 * that changes per call, so a test can prove which revision reached the reply.
 */
const recordingWriter: () => RecordedWriter = (): RecordedWriter => {
    const requests: WorkspaceWriteRequest[] = [];
    return {
        requests,
        writer: {
            write: (request: WorkspaceWriteRequest): { ok: true; revision: string; bytes: number; } => {
                requests.push({ ...request });
                return { ok: true, revision: `rev.${requests.length}`, bytes: new TextEncoder().encode(request.content).length };
            },
        },
    };
};

test("reactive_read exposes lazy structural proxies without content", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const result: Record<string, unknown> = data(call(host, ToolIds.workspaceReactiveRead));
    assert.equal(result.revision, Revision);
    assert.equal(result.cacheVersion, 0);
    assert.equal(result.nodes, 1);
    const roots: ReactiveProxy[] = result.roots as unknown as ReactiveProxy[];
    assert.equal(roots.length, 1);
    const root: ReactiveProxy = roots[0];
    assert.equal(root.id, "project:.");
    assert.equal(root.kind, "project");
    assert.equal(root.label, "fixture");
    assert.equal(root.path, "package.json");
    assert.equal(root.summary, "fixture project at .");
    assert.deepEqual(root.tags, []);
    assert.equal(root.revision, snapshotRevisionOf("project:."));
    assert.equal(root.childCount, 5);
    assert.deepEqual(
        root.children.map((child: ReactiveProxy): string => child.id),
        ["directory:src", "file:a.ts", "file:c.ts", "file:d.ts", "file:package.json"],
    );
    assert.equal("content" in root, false);
    assert.equal(root.content, (void 0));
    const file: ReactiveProxy = root.children.find((child: ReactiveProxy): boolean => child.id === Target)!;
    assert.equal(file.kind, "file");
    assert.equal(file.childCount, 1);
    assert.equal(file.children.length, 1);
    assert.equal(file.children[0].kind, "symbol");
    assert.equal(file.children[0].label, "xxx");
    assert.equal(file.children[0].summary, "xxx = xx");
    assert.equal(file.children[0].path, "a.ts");
    assert.equal(file.children[0].revision, snapshotRevisionOf(Target));
    assert.deepEqual(file.children[0].children, []);
    assert.equal("content" in file.children[0], false);
    assert.doesNotMatch(JSON.stringify(result.roots), /"content"/);
});

test("reactive_read bounds the JSON projection and keeps real child counts", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const shallow: ReactiveWire = jsonOf(data(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 1 }))) as ReactiveWire;
    assert.equal(shallow.roots.length, 1);
    assert.equal(shallow.roots[0].childCount, 5);
    assert.equal(shallow.roots[0].children.length, 5);
    assert.equal(shallow.roots[0].truncated, (void 0));
    const directory: WorkspaceReactiveNode = shallow.roots[0].children[0];
    assert.equal(directory.id, "directory:src");
    assert.equal(directory.childCount, 1);
    assert.deepEqual(directory.children, []);
    assert.equal(directory.truncated, (void 0));
    const cut: ReactiveWire = jsonOf(data(call(host, ToolIds.workspaceReactiveRead, { limit: 2 }))) as ReactiveWire;
    const root: WorkspaceReactiveNode = cut.roots[0];
    assert.equal(root.childCount, 5);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].id, "directory:src");
    assert.equal(root.truncated, true);
    assert.equal(root.children[0].truncated, true);
    assert.equal(root.children[0].childCount, 1);
    assert.deepEqual(root.children[0].children, []);
    const full: ReactiveWire = jsonOf(data(call(host, ToolIds.workspaceReactiveRead))) as ReactiveWire;
    const symbol: WorkspaceReactiveNode | undefined = reactiveWireNodeOf(full, symbolOf("xxx"));
    assert.ok(symbol);
    assert.equal(symbol!.kind, "symbol");
    assert.equal(symbol!.childCount, 0);
    assert.equal(symbol!.startLine, 2);
    assert.equal(symbol!.endLine, 2);
    assert.deepEqual(symbol!.children, []);
});

test("reactive_read scopes to one nodeId and rejects unknown or non-project scope", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const scoped: Record<string, unknown> = data(call(host, ToolIds.workspaceReactiveRead, { nodeId: Target }));
    const roots: ReactiveProxy[] = scoped.roots as unknown as ReactiveProxy[];
    assert.equal(roots.length, 1);
    assert.equal(roots[0].id, Target);
    assert.equal(roots[0].kind, "file");
    assert.equal(roots[0].children.length, 1);
    assert.equal(roots[0].children[0].label, "xxx");
    const narrowed: ReactiveWire = jsonOf(data(call(host, ToolIds.workspaceReactiveRead, { projectId: "project:." }))) as ReactiveWire;
    assert.equal(narrowed.roots.length, 1);
    assert.equal(narrowed.roots[0].id, "project:.");
    assert.equal(code(call(host, ToolIds.workspaceReactiveRead, { nodeId: "file:missing.ts" })), "not_available");
    assert.equal(code(call(host, ToolIds.workspaceReactiveRead, { projectId: Target })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 13 })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceReactiveRead, { limit: 2001 })), "invalid_arguments");
});

test("reactive_write refreshes the annotation overlay and versions the cache", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    assert.equal(data(call(host, ToolIds.workspaceReactiveRead)).cacheVersion, 0);
    const label: ReactiveAnnotation = data(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "label", value: "Alpha" }),
    ) as unknown as ReactiveAnnotation;
    assert.equal(label.nodeId, Target);
    assert.equal(label.property, "label");
    assert.equal(label.value, "Alpha");
    assert.equal(label.revision, snapshotRevisionOf(Target));
    assert.equal(label.cacheVersion, 1);
    assert.deepEqual(label.invalidated, [Target, "project:."]);
    const summary: ReactiveAnnotation = data(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "summary", value: "annotated a" }),
    ) as unknown as ReactiveAnnotation;
    assert.equal(summary.property, "summary");
    assert.equal(summary.value, "annotated a");
    assert.equal(summary.cacheVersion, 2);
    assert.deepEqual(summary.invalidated, [Target, "project:."]);
    const tags: ReactiveAnnotation = data(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "tags", value: ["one", "two"] }),
    ) as unknown as ReactiveAnnotation;
    assert.equal(tags.property, "tags");
    assert.deepEqual(tags.value, ["one", "two"]);
    assert.equal(tags.cacheVersion, 3);
    assert.deepEqual(tags.invalidated, [Target, "project:."]);
    const tree: Record<string, unknown> = data(call(host, ToolIds.workspaceReactiveRead));
    assert.equal(tree.cacheVersion, 3);
    const roots: ReactiveProxy[] = tree.roots as unknown as ReactiveProxy[];
    const file: ReactiveProxy = roots[0].children.find((child: ReactiveProxy): boolean => child.id === Target)!;
    assert.equal(file.label, "Alpha");
    assert.equal(file.summary, "annotated a");
    assert.deepEqual(file.tags, ["one", "two"]);
    const wire: ReactiveWire = jsonOf(tree) as ReactiveWire;
    const node: WorkspaceReactiveNode = reactiveWireNodeOf(wire, Target)!;
    assert.equal(node.label, "Alpha");
    assert.equal(node.summary, "annotated a");
    assert.deepEqual(node.tags, ["one", "two"]);
    const other: WorkspaceReactiveNode = reactiveWireNodeOf(wire, "file:c.ts")!;
    assert.equal(other.label, "c.ts");
    assert.deepEqual(other.tags, []);
});

test("reactive_write rejects annotation values of the wrong shape", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    assert.equal(code(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "tags", value: "one" })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "summary", value: ["one"] })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "owner", value: "x" })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "tags", value: [1] })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceReactiveWrite, { nodeId: "file:missing.ts", property: "label", value: "x" })), "not_available");
    assert.equal(data(call(host, ToolIds.workspaceReactiveRead)).cacheVersion, 0);
});

test("reactive_write content is the guarded host write and a following read sees it", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target]);
    const before: Record<string, unknown> = data(call(host, ToolIds.workspaceRead, { contextId, nodeId: Target }));
    const previousRevision: string = (before.source as { revision: string; }).revision;
    assert.equal(previousRevision, snapshotRevisionOf(Target));
    const next: string = "export const xxx = 7;\n";
    const payload: WritePayload = data(
        call(host, ToolIds.workspaceReactiveWrite, {
            nodeId: Target,
            property: "content",
            value: next,
            contextId,
            expectRevision: previousRevision,
        }),
    ) as unknown as WritePayload;
    assert.equal(payload.nodeId, Target);
    assert.equal(payload.path, "a.ts");
    assert.equal(payload.mode, "node");
    assert.equal(payload.dryRun, false);
    assert.equal(payload.previousRevision, previousRevision);
    assert.equal(payload.revision, "rev.1");
    assert.equal(payload.bytes, new TextEncoder().encode(next).length);
    assert.equal(payload.lines, 1);
    assert.deepEqual(linkPathsOf(payload.importation), ["c.ts"]);
    assert.deepEqual(linkPathsOf(payload.exportation), ["d.ts"]);
    assert.equal(recorded.requests.length, 1);
    assert.equal(recorded.requests[0].agentId, "a.test");
    assert.equal(recorded.requests[0].uri, "a.ts");
    assert.equal(recorded.requests[0].content, next);
    assert.equal(recorded.requests[0].previousRevision, previousRevision);
    const after: Record<string, unknown> = data(call(host, ToolIds.workspaceRead, { contextId, nodeId: Target }));
    assert.equal(after.text, next);
    assert.equal((after.source as { revision: string; }).revision, "rev.1");
});

test("reactive_write content needs a readable materialized file and a host writer", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.content");
    assert.equal(code(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "content", value: "x" })), "not_available");
    const otherContext: string = materializedContext(host, ["file:c.ts"], "f.other");
    assert.equal(
        code(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "content", value: "x", contextId: otherContext })),
        "not_available",
    );
    const dry: WritePayload = data(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "content", value: "preview", contextId, dryRun: true }),
    ) as unknown as WritePayload;
    assert.equal(dry.dryRun, true);
    assert.equal(dry.revision, null);
    assert.equal(recorded.requests.length, 0);
    const symbolHost: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const symbolContext: string = materializedContext(symbolHost, [symbolOf("xxx")], "f.symbol");
    assert.equal(
        code(
            call(symbolHost, ToolIds.workspaceReactiveWrite, {
                nodeId: symbolOf("xxx"),
                property: "content",
                value: "x",
                contextId: symbolContext,
            }),
        ),
        "invalid_arguments",
    );
    const writerless: WorkspaceAgentService = serviceOf();
    const writerlessContext: string = materializedContext(writerless, [Target], "f.writerless");
    assert.equal(
        code(call(writerless, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "content", value: "x", contextId: writerlessContext })),
        "write_unavailable",
    );
    const preview: WritePayload = data(
        call(writerless, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "content", value: "x", contextId: writerlessContext, dryRun: true }),
    ) as unknown as WritePayload;
    assert.equal(preview.dryRun, true);
    assert.equal(preview.revision, null);
    assert.equal(recorded.requests.length, 0);
});

test("diff_read reports comparable file metrics and content revisions", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const wire: DiffWire = jsonOf(data(call(host, ToolIds.workspaceDiffRead))) as DiffWire;
    assert.equal(wire.revision, Revision);
    assert.equal(wire.files, 5);
    assert.equal(wire.nodes, 7);
    assert.equal(wire.truncated, false);
    assert.equal(wire.roots.length, 1);
    const project: WorkspaceDiffNode = wire.roots[0];
    assert.equal(project.id, "project:.");
    assert.equal(project.kind, "project");
    assert.equal(project.path, "package.json");
    assert.equal(project.revision, snapshotRevisionOf("project:."));
    assert.equal(project.bytes, null);
    assert.equal(project.lines, null);
    assert.equal(project.content, null);
    assert.equal(project.contentOmitted, false);
    assert.equal(project.childCount, 5);
    const directory: WorkspaceDiffNode = diffNodeOf(wire, "directory:src")!;
    assert.equal(directory.kind, "directory");
    assert.equal(directory.revision, Revision);
    assert.equal(directory.bytes, null);
    assert.equal(directory.lines, null);
    assert.equal(directory.childCount, 1);
    const file: WorkspaceDiffNode = diffNodeOf(wire, Target)!;
    assert.equal(file.kind, "file");
    assert.equal(file.label, "a.ts");
    assert.equal(file.path, "a.ts");
    assert.equal(file.revision, snapshotRevisionOf(Target));
    assert.equal(file.bytes, new TextEncoder().encode(ContentA).length);
    assert.equal(file.lines, 2);
    assert.equal(file.content, null);
    assert.equal(file.contentOmitted, false);
    assert.equal(file.childCount, 0);
    const util: WorkspaceDiffNode = diffNodeOf(wire, UtilTarget)!;
    assert.equal(util.bytes, 60);
    assert.equal(util.lines, 3);
    assert.equal(diffNodeOf(wire, "file:c.ts")!.lines, 1);
    assert.equal(diffNodeOf(wire, "file:package.json")!.bytes, 18);
});

test("diff_read filters files by extension and prefix and cuts the tree by limit", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const dotted: DiffWire = jsonOf(data(call(host, ToolIds.workspaceDiffRead, { extension: ".ts" }))) as DiffWire;
    assert.equal(dotted.files, 4);
    assert.equal(dotted.nodes, 6);
    assert.equal(dotted.roots[0].childCount, 4);
    assert.deepEqual(diffFilePathsOf(dotted), ["src/util.ts", "a.ts", "c.ts", "d.ts"]);
    const bare: DiffWire = jsonOf(data(call(host, ToolIds.workspaceDiffRead, { extension: "TS" }))) as DiffWire;
    assert.deepEqual(diffFilePathsOf(bare), ["src/util.ts", "a.ts", "c.ts", "d.ts"]);
    const manifestOnly: DiffWire = jsonOf(data(call(host, ToolIds.workspaceDiffRead, { extension: "json" }))) as DiffWire;
    assert.deepEqual(diffFilePathsOf(manifestOnly), ["package.json"]);
    assert.equal(diffNodeOf(manifestOnly, "directory:src")!.childCount, 0);
    const prefixed: DiffWire = jsonOf(data(call(host, ToolIds.workspaceDiffRead, { pathPrefix: "src/" }))) as DiffWire;
    assert.equal(prefixed.files, 1);
    assert.equal(prefixed.nodes, 3);
    assert.equal(prefixed.roots[0].childCount, 1);
    assert.deepEqual(diffFilePathsOf(prefixed), ["src/util.ts"]);
    const cut: DiffWire = jsonOf(data(call(host, ToolIds.workspaceDiffRead, { limit: 1 }))) as DiffWire;
    assert.equal(cut.nodes, 1);
    assert.equal(cut.files, 0);
    assert.equal(cut.truncated, true);
    assert.equal(cut.roots[0].childCount, 5);
    assert.deepEqual(cut.roots[0].children, []);
    assert.equal(diffNodeOf(cut, Target), (void 0));
});

test("diff_read gates included content on the materialized Context and read ceiling", (): void => {
    const plain: WorkspaceAgentService = serviceOf();
    assert.equal(code(call(plain, ToolIds.workspaceDiffRead, { includeContent: true })), "not_available");
    const host: WorkspaceAgentService = serviceOf();
    const contextId: string = materializedContext(host, [Target], "f.content");
    const wire: DiffWire = jsonOf(data(call(host, ToolIds.workspaceDiffRead, { includeContent: true, contextId }))) as DiffWire;
    const readable: WorkspaceDiffNode = diffNodeOf(wire, Target)!;
    assert.equal(readable.content, ContentA);
    assert.equal(readable.contentOmitted, false);
    const unreachable: WorkspaceDiffNode = diffNodeOf(wire, "file:c.ts")!;
    assert.equal(unreachable.content, null);
    assert.equal(unreachable.contentOmitted, true);
    const project: WorkspaceDiffNode = wire.roots[0];
    assert.equal(project.content, null);
    assert.equal(project.contentOmitted, false);
    const boundedHost: WorkspaceAgentService = serviceOf({ limits: { maxReadChars: 8 } });
    const boundedContext: string = materializedContext(boundedHost, [Target], "f.bounded");
    const bounded: DiffWire = jsonOf(data(call(boundedHost, ToolIds.workspaceDiffRead, { includeContent: true, contextId: boundedContext }))) as DiffWire;
    const clipped: WorkspaceDiffNode = diffNodeOf(bounded, Target)!;
    assert.equal(clipped.content, ContentA.slice(0, 8));
    assert.equal((clipped.content as string).length, 8);
    assert.equal(clipped.bytes, new TextEncoder().encode(ContentA).length);
});

test("diff_write replaces the whole file and reports the diff and impacts", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.whole");
    const next: string = 'import { xx } from "./c.ts";\nexport const xxx = 2;\n';
    const payload: DiffWritePayload = data(
        call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: next }),
    ) as unknown as DiffWritePayload;
    assert.equal(payload.nodeId, Target);
    assert.equal(payload.path, "a.ts");
    assert.equal(payload.strategy, "whole");
    assert.equal(payload.dryRun, false);
    assert.equal(payload.previousRevision, snapshotRevisionOf(Target));
    assert.equal(payload.revision, "rev.1");
    assert.equal(payload.bytes, new TextEncoder().encode(next).length);
    assert.equal(payload.lines, 2);
    assert.equal(payload.added, 1);
    assert.equal(payload.removed, 1);
    assert.equal(payload.unchanged, 1);
    assert.equal(payload.diffTruncated, false);
    assert.equal(payload.hunks.length, 1);
    assert.deepEqual(payload.hunks[0], { beforeStart: 1, beforeLines: 2, afterStart: 1, afterLines: 2 });
    assert.equal(typeof(payload.remainingTokens), "number");
    assert.deepEqual(linkPathsOf(payload.importation), ["c.ts"]);
    assert.deepEqual(linkPathsOf(payload.exportation), ["d.ts"]);
    assert.equal(recorded.requests.length, 1);
    assert.equal(recorded.requests[0].uri, "a.ts");
    assert.equal(recorded.requests[0].content, next);
    assert.equal(recorded.requests[0].previousRevision, snapshotRevisionOf(Target));
    const reread: Record<string, unknown> = data(call(host, ToolIds.workspaceRead, { contextId, nodeId: Target }));
    assert.equal(reread.text, next);
    assert.equal((reread.source as { revision: string; }).revision, "rev.1");
});

test("diff_write applies line splices bottom-up", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.lines");
    const changes: Array<{ startLine: number; endLine: number; content: string; }> = [
        { startLine: 1, endLine: 1, content: 'import { xx } from "./c.ts"; // keep' },
        { startLine: 2, endLine: 2, content: "export const xxx = 42;" },
    ];
    const expected: string = 'import { xx } from "./c.ts"; // keep\nexport const xxx = 42;\n';
    const payload: DiffWritePayload = data(
        call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, changes, contextLines: 0 }),
    ) as unknown as DiffWritePayload;
    assert.equal(payload.strategy, "lines");
    assert.equal(payload.revision, "rev.1");
    assert.equal(payload.previousRevision, snapshotRevisionOf(Target));
    assert.equal(payload.bytes, new TextEncoder().encode(expected).length);
    assert.equal(payload.lines, 2);
    assert.equal(payload.added, 2);
    assert.equal(payload.removed, 2);
    assert.equal(payload.unchanged, 0);
    assert.equal(payload.hunks.length, 1);
    assert.deepEqual(payload.hunks[0], { beforeStart: 1, beforeLines: 2, afterStart: 1, afterLines: 2 });
    assert.equal(recorded.requests.length, 1);
    assert.equal(recorded.requests[0].content, expected);
    const reread: Record<string, unknown> = data(call(host, ToolIds.workspaceRead, { contextId, nodeId: Target }));
    assert.equal(reread.text, expected);
});

test("diff_write splices UTF-8 bytes and rejects a boundary inside a character", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [UtilTarget], "f.bytes");
    const at: number = ContentUtil.indexOf("\u00e9");
    assert.equal(at, 55);
    assert.equal(new TextEncoder().encode(ContentUtil.slice(0, at)).length, at);
    const expected: string = ContentUtil.replace("caf\u00e9", "cafe");
    const payload: DiffWritePayload = data(
        call(host, ToolIds.workspaceDiffWrite, {
            contextId,
            nodeId: UtilTarget,
            byteChanges: [{ offsetBytes: at, endBytes: at + 2, content: "e" }],
        }),
    ) as unknown as DiffWritePayload;
    assert.equal(payload.strategy, "bytes");
    assert.equal(payload.revision, "rev.1");
    assert.equal(payload.previousRevision, snapshotRevisionOf(UtilTarget));
    assert.equal(payload.bytes, new TextEncoder().encode(expected).length);
    assert.equal(payload.lines, 3);
    assert.equal(payload.added, 1);
    assert.equal(payload.removed, 1);
    assert.equal(recorded.requests.length, 1);
    assert.equal(recorded.requests[0].content, expected);
    const reread: Record<string, unknown> = data(call(host, ToolIds.workspaceRead, { contextId, nodeId: UtilTarget }));
    assert.equal(reread.text, expected);
    const rejecting: RecordedWriter = recordingWriter();
    const fresh: WorkspaceAgentService = serviceOf({ writer: rejecting.writer });
    const freshContext: string = materializedContext(fresh, [UtilTarget], "f.invalid");
    assert.equal(
        code(
            call(fresh, ToolIds.workspaceDiffWrite, {
                contextId: freshContext,
                nodeId: UtilTarget,
                byteChanges: [{ offsetBytes: at + 1, endBytes: at + 2, content: "e" }],
            }),
        ),
        "invalid_arguments",
    );
    assert.equal(
        code(
            call(fresh, ToolIds.workspaceDiffWrite, {
                contextId: freshContext,
                nodeId: UtilTarget,
                byteChanges: [{ offsetBytes: at, endBytes: at + 1, content: "e" }],
            }),
        ),
        "invalid_arguments",
    );
    assert.equal(rejecting.requests.length, 0);
});

test("diff_write reports one-line replacement and appended-line hunk counts", (): void => {
    const replacement: RecordedWriter = recordingWriter();
    const replacementHost: WorkspaceAgentService = serviceOf({ writer: replacement.writer });
    const replacementContext: string = materializedContext(replacementHost, [Target], "f.replace");
    const replaced: DiffWritePayload = data(
        call(replacementHost, ToolIds.workspaceDiffWrite, {
            contextId: replacementContext,
            nodeId: Target,
            changes: [{ startLine: 2, endLine: 2, content: "export const xxx = 2;" }],
            contextLines: 0,
        }),
    ) as unknown as DiffWritePayload;
    assert.equal(replaced.strategy, "lines");
    assert.equal(replaced.added, 1);
    assert.equal(replaced.removed, 1);
    assert.equal(replaced.unchanged, 1);
    assert.equal(replaced.hunks.length, 1);
    assert.deepEqual(replaced.hunks[0], { beforeStart: 2, beforeLines: 1, afterStart: 2, afterLines: 1 });
    const appended: RecordedWriter = recordingWriter();
    const appendHost: WorkspaceAgentService = serviceOf({ writer: appended.writer });
    const appendContext: string = materializedContext(appendHost, [Target], "f.append");
    const appendedLine: string = "console.log(xxx);";
    const appendPayload: DiffWritePayload = data(
        call(appendHost, ToolIds.workspaceDiffWrite, {
            contextId: appendContext,
            nodeId: Target,
            changes: [{ startLine: 2, endLine: 2, content: `export const xxx = xx;\n${appendedLine}` }],
        }),
    ) as unknown as DiffWritePayload;
    assert.equal(appendPayload.added, 1);
    assert.equal(appendPayload.removed, 0);
    assert.equal(appendPayload.unchanged, 2);
    assert.equal(appendPayload.hunks.length, 1);
    assert.deepEqual(appendPayload.hunks[0], { beforeStart: 1, beforeLines: 2, afterStart: 1, afterLines: 3 });
    assert.equal(appendPayload.lines, 3);
    assert.equal(appended.requests[0].content, `${ContentA}${appendedLine}\n`);
});

test("diff_write enforces allocation, file-only targets and compare-and-swap", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.cas");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: "file:c.ts", content: "x" })), "not_available");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId: "ctx.missing", nodeId: Target, content: "x" })), "not_available");
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: "x", expectRevision: "rev.stale" })),
        "fingerprint_mismatch",
    );
    const first: DiffWritePayload = data(
        call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: ContentC, expectRevision: snapshotRevisionOf(Target) }),
    ) as unknown as DiffWritePayload;
    assert.equal(first.previousRevision, snapshotRevisionOf(Target));
    assert.equal(first.revision, "rev.1");
    assert.equal(recorded.requests.length, 1);
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: "y", expectRevision: snapshotRevisionOf(Target) })),
        "fingerprint_mismatch",
    );
    const second: DiffWritePayload = data(
        call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: ContentD, expectRevision: "rev.1" }),
    ) as unknown as DiffWritePayload;
    assert.equal(second.previousRevision, "rev.1");
    assert.equal(second.revision, "rev.2");
    assert.equal(recorded.requests.length, 2);
    const symbolHost: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const symbolContext: string = materializedContext(symbolHost, [symbolOf("xxx")], "f.symbol");
    assert.equal(
        code(call(symbolHost, ToolIds.workspaceDiffWrite, { contextId: symbolContext, nodeId: symbolOf("xxx"), content: "x" })),
        "invalid_arguments",
    );
    assert.equal(recorded.requests.length, 2);
});

test("diff_write dryRun previews without a writer and never calls the host", (): void => {
    const writerless: WorkspaceAgentService = serviceOf();
    const writerlessContext: string = materializedContext(writerless, [Target], "f.dry");
    assert.equal(
        code(call(writerless, ToolIds.workspaceDiffWrite, { contextId: writerlessContext, nodeId: Target, content: "preview\n" })),
        "write_unavailable",
    );
    const preview: DiffWritePayload = data(
        call(writerless, ToolIds.workspaceDiffWrite, { contextId: writerlessContext, nodeId: Target, content: "preview\n", dryRun: true }),
    ) as unknown as DiffWritePayload;
    assert.equal(preview.dryRun, true);
    assert.equal(preview.revision, null);
    assert.equal(preview.strategy, "whole");
    assert.equal(preview.previousRevision, snapshotRevisionOf(Target));
    assert.equal(preview.bytes, 8);
    assert.equal(preview.lines, 1);
    assert.equal(preview.added, 1);
    assert.equal(preview.removed, 2);
    assert.equal(data(call(writerless, ToolIds.workspaceRead, { contextId: writerlessContext, nodeId: Target })).text, ContentA);
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.preview");
    const dry: DiffWritePayload = data(
        call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: ContentC, dryRun: true }),
    ) as unknown as DiffWritePayload;
    assert.equal(dry.dryRun, true);
    assert.equal(dry.revision, null);
    assert.equal(recorded.requests.length, 0);
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: ContentC, dryRun: true, expectRevision: "rev.stale" })),
        "fingerprint_mismatch",
    );
    assert.equal(recorded.requests.length, 0);
    const real: DiffWritePayload = data(
        call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: ContentC }),
    ) as unknown as DiffWritePayload;
    assert.equal(real.revision, "rev.1");
    assert.equal(recorded.requests.length, 1);
});

test("diff_write rejects two edit modes at once or none", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.mixed");
    const content: string = "x";
    const changes: Array<{ startLine: number; endLine: number; content: string; }> = [{ startLine: 1, endLine: 1, content: "y" }];
    const byteChanges: Array<{ offsetBytes: number; endBytes: number; content: string; }> = [{ offsetBytes: 0, endBytes: 1, content: "z" }];
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content, changes })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content, byteChanges })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, changes, byteChanges })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, changes: [] })), "invalid_arguments");
    assert.equal(recorded.requests.length, 0);
});

test("diff_write enforces the service write ceiling on the assembled result", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer, limits: { maxWriteChars: 16 } });
    const contextId: string = materializedContext(host, [Target], "f.capacity");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: "x".repeat(17) })), "capacity_exceeded");
    assert.equal(recorded.requests.length, 0);
    const exact: string = "0123456789abcdef";
    assert.equal(exact.length, 16);
    const preview: DiffWritePayload = data(
        call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: exact, dryRun: true }),
    ) as unknown as DiffWritePayload;
    assert.equal(preview.dryRun, true);
    assert.equal(preview.revision, null);
    const written: DiffWritePayload = data(
        call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: Target, content: exact }),
    ) as unknown as DiffWritePayload;
    assert.equal(written.revision, "rev.1");
    assert.equal(written.bytes, 16);
    assert.equal(written.lines, 1);
    assert.equal(recorded.requests.length, 1);
    assert.equal(recorded.requests[0].content.length, 16);
});
