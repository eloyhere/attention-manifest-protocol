#!/usr/bin/env node
/**
 * Boundary checks for `amp_tool_workspace_reactive_read` and
 * `amp_tool_workspace_reactive_write`.
 *
 * The fixture is one immutable snapshot scanned through the real
 * `scanStructuredWorkspace` adapter: two projects (`project:.` and
 * `project:nested`), one declared package, a directory that mixes a
 * subdirectory with a file, a code file with a symbol, a Markdown file with
 * knowledge sections and a thirty-directory chain used to prove the `maxDepth`
 * cut. Each test builds its own service because the reactive overlay, the child
 * cache and the accepted-write map are per-instance state.
 *
 * These checks deliberately target boundaries rather than the happy path that
 * `workspaceReactiveDiffCheck.ts` already covers: schema ceilings, revision
 * gating, the difference between the lazy in-process proxy and its bounded
 * `toJSON` projection, cache version arithmetic and every failure branch of the
 * guarded content write.
 *
 * A missing `revision` is a schema violation (`invalid_arguments`) because both
 * descriptors require it; a present but stale revision reaches the service gate
 * and is `revision_mismatch`. Both paths are pinned below.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { types } from "node:util";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceWriteOutcome, WorkspaceWriteRequest, WorkspaceWriter } from "../src/context/workspaceService.ts";
import type { Frame } from "../src/frame/frame.ts";
import { ToolIds } from "../src/naming/index.ts";
import type {
    WorkspaceExportation,
    WorkspaceImportation,
    WorkspaceReactiveNode,
    WorkspaceResponse,
} from "../src/protocol/workspace.ts";
import { scanStructuredWorkspace } from "./support/documentScanner.ts";
import type { StructuredWorkspaceFile } from "./support/documentScanner.ts";

interface ServiceOptions {
    projectIds?: readonly string[];
    writer?: WorkspaceWriter;
}

interface RecordedWriter {
    writer: WorkspaceWriter;
    requests: WorkspaceWriteRequest[];
}

/**
 * In-process shape of one reactive node. `content` is absent from the proxy's
 * documented key set; it is declared only so the test can prove the negative.
 */
interface ReactiveProxy {
    id: string;
    kind: string;
    label: string;
    summary: string;
    tags: string[];
    path: string;
    structureKind?: string;
    startLine?: number;
    endLine?: number;
    revision: string;
    childCount: number;
    children: ReactiveProxy[];
    content?: unknown;
    toJSON: () => WorkspaceReactiveNode;
}

/**
 * Wire projection produced by `JSON.stringify` over the proxies.
 */
interface ReactiveWire {
    revision: string;
    cacheVersion: number;
    roots: WorkspaceReactiveNode[];
    nodes: number;
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
 * Payload of a `reactive_write` content call, which reuses `write`'s summary.
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
    remainingTokens: number;
    exportation: WorkspaceExportation;
    importation: WorkspaceImportation;
}

const AgentId: string = "a.test";
const RootProject: string = "project:.";
const NestedProject: string = "project:nested";

const ContentA: string = 'import { helper } from "./src/util.ts";\nexport const alpha = helper;\n';
const ContentConsumer: string = 'import { alpha } from "./a.ts";\nexport const consumed = alpha;\n';
const ContentUtil: string = "export function helper(): number {\n    return 1;\n}\n";
const ContentNotes: string = "# Notes\n\nBody text\n\n## Detail\n\nMore detail\n";
const ContentLib: string = "export const index = 1;\n";
const ContentDive: string = "export const dive = 2;\n";
const ContentLeaf: string = "export const leaf = 1;\n";
const ContentBeta: string = "export const beta = 2;\n";
const NextContentA: string = 'import { helper } from "./src/util.ts";\nexport const alpha = 2;\n';

/**
 * Thirty nested directories; the deep chain is what `maxDepth` has to cut.
 */
const DeepDirectories: readonly string[] = Array.from(
    { length: 30 },
    (_unused: unknown, index: number): string => `d${index + 1}`,
);
const DeepPathAt: (depth: number) => string = (depth: number): string => DeepDirectories.slice(0, depth).join("/");
const DeepFilePath: string = `${DeepPathAt(30)}/leaf.ts`;

const Fixture: readonly StructuredWorkspaceFile[] = [
    { path: "package.json", content: '{"name":"alpha-fixture","dependencies":{"left-pad":"^1.0.0"}}' },
    { path: "a.ts", content: ContentA },
    { path: "src/util.ts", content: ContentUtil },
    { path: "consumer.ts", content: ContentConsumer },
    { path: "lib/index.ts", content: ContentLib },
    { path: "lib/deep/dive.ts", content: ContentDive },
    { path: "docs/notes.md", content: ContentNotes },
    { path: DeepFilePath, content: ContentLeaf },
    { path: "nested/package.json", content: '{"name":"beta-fixture"}' },
    { path: "nested/b.ts", content: ContentBeta },
];

const Store: MemoryContentStore = new MemoryContentStore();
const Snapshot: WorkspaceSnapshot = scanStructuredWorkspace(Fixture, Store);
const Revision: string = Snapshot.revision;

/**
 * Reactive keys the proxy advertises, in `ownKeys` order. `toJSON` is the
 * serialization hook and `truncated` exists only on the wire projection.
 */
const ReactiveKeySet: readonly string[] = [
    "id",
    "kind",
    "label",
    "summary",
    "tags",
    "path",
    "structureKind",
    "startLine",
    "endLine",
    "revision",
    "childCount",
    "children",
];

const entityOf: (kind: WorkspaceEntity["kind"], label: string) => WorkspaceEntity = (
    kind: WorkspaceEntity["kind"],
    label: string,
): WorkspaceEntity => {
    const found: WorkspaceEntity | undefined = Snapshot.entities.find(
        (item: WorkspaceEntity): boolean => item.kind === kind && item.label === label,
    );
    assert.ok(found, `${kind} ${label} must exist`);
    return found!;
};

const Target: string = "file:a.ts";
const ConsumerTarget: string = "file:consumer.ts";
const UtilTarget: string = "file:src/util.ts";
const NotesTarget: string = "file:docs/notes.md";
const LibDirectory: string = "directory:lib";
const LibDeepDirectory: string = "directory:lib/deep";
const PackageTarget: string = entityOf("package", "left-pad").id;
const SymbolTarget: string = entityOf("symbol", "alpha").id;

const frameOf: (id: string, nodeIds: readonly string[], tokens?: number) => Frame = (
    id: string,
    nodeIds: readonly string[],
    tokens: number = 4000,
): Frame => ({
    amp: "0.1",
    kind: "frame",
    id,
    agent: AgentId,
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
        agentId: AgentId,
        projectIds: options.projectIds ?? [RootProject],
        snapshot: Snapshot,
        store: Store,
        ...(options.writer === (void 0) ? {} : { writer: options.writer }),
    });

const call: (host: WorkspaceAgentService, tool: string, args?: Record<string, unknown>) => WorkspaceResponse = (
    host: WorkspaceAgentService,
    tool: string,
    args: Record<string, unknown> = {},
): WorkspaceResponse => host.call(tool, { revision: Revision, ...args });

const dataOf: (response: WorkspaceResponse) => Record<string, unknown> = (
    response: WorkspaceResponse,
): Record<string, unknown> => {
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) {
        throw new Error("expected success");
    }
    return response.data;
};

const codeOf: (response: WorkspaceResponse) => string = (response: WorkspaceResponse): string => {
    assert.equal(response.ok, false, JSON.stringify(response));
    if (!("error" in response)) {
        throw new Error("expected error");
    }
    return response.error.code;
};

const wireOf: (response: WorkspaceResponse) => ReactiveWire = (response: WorkspaceResponse): ReactiveWire =>
    JSON.parse(JSON.stringify(dataOf(response))) as ReactiveWire;

const wireDataOf: (data: Record<string, unknown>) => ReactiveWire = (data: Record<string, unknown>): ReactiveWire =>
    JSON.parse(JSON.stringify(data)) as ReactiveWire;

const annotationOf: (response: WorkspaceResponse) => ReactiveAnnotation = (
    response: WorkspaceResponse,
): ReactiveAnnotation => dataOf(response) as unknown as ReactiveAnnotation;

const writePayloadOf: (response: WorkspaceResponse) => WritePayload = (response: WorkspaceResponse): WritePayload =>
    dataOf(response) as unknown as WritePayload;

const flattenNodes: (nodes: readonly WorkspaceReactiveNode[]) => WorkspaceReactiveNode[] = (
    nodes: readonly WorkspaceReactiveNode[],
): WorkspaceReactiveNode[] =>
    nodes.flatMap((node: WorkspaceReactiveNode): WorkspaceReactiveNode[] => [node, ...flattenNodes(node.children)]);

const findNode: (wire: ReactiveWire, id: string) => WorkspaceReactiveNode | undefined = (
    wire: ReactiveWire,
    id: string,
): WorkspaceReactiveNode | undefined => flattenNodes(wire.roots).find((node: WorkspaceReactiveNode): boolean => node.id === id);

const flattenProxies: (nodes: readonly ReactiveProxy[]) => ReactiveProxy[] = (nodes: readonly ReactiveProxy[]): ReactiveProxy[] =>
    nodes.flatMap((node: ReactiveProxy): ReactiveProxy[] => [node, ...flattenProxies(node.children)]);

const findProxy: (root: ReactiveProxy, id: string) => ReactiveProxy | undefined = (
    root: ReactiveProxy,
    id: string,
): ReactiveProxy | undefined => flattenProxies([root]).find((node: ReactiveProxy): boolean => node.id === id);

/**
 * Register a Frame and materialize it exactly like `workspaceAgentCheck.ts`,
 * which is the host sequence every guarded write needs.
 */
const materializedContext: (host: WorkspaceAgentService, nodeIds: readonly string[], frameId: string) => string = (
    host: WorkspaceAgentService,
    nodeIds: readonly string[],
    frameId: string,
): string => {
    host.registerFrame(frameOf(frameId, nodeIds), Revision);
    const view: Record<string, unknown> = dataOf(call(host, ToolIds.workspaceMaterialize, { frameId, budgetTokens: 4000 }));
    const readable: string[] = view.readableIds as string[];
    nodeIds.forEach((nodeId: string): void => {
        assert.ok(readable.includes(nodeId), `readable ${nodeId}`);
    });
    return view.contextId as string;
};

const recordingWriter: () => RecordedWriter = (): RecordedWriter => {
    const requests: WorkspaceWriteRequest[] = [];
    const writer: WorkspaceWriter = {
        write: (request: WorkspaceWriteRequest): WorkspaceWriteOutcome => {
            requests.push({ ...request });
            return { ok: true, revision: `rev.${requests.length}`, bytes: new TextEncoder().encode(request.content).length };
        },
    };
    return { writer, requests };
};

/**
 * Writer double whose answer is supplied verbatim, so a malformed outcome can
 * be delivered without widening the port's type.
 */
const writerOutcome: (outcome: unknown) => WorkspaceWriter = (outcome: unknown): WorkspaceWriter => ({
    write: (): WorkspaceWriteOutcome => outcome as WorkspaceWriteOutcome,
});

const tagsOf: (count: number, prefix?: string) => string[] = (count: number, prefix: string = "tag"): string[] =>
    Array.from({ length: count }, (_unused: unknown, index: number): string => `${prefix}-${index}`);

test("reactive_read rejects combined scope and unknown or unauthorized targets", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    assert.equal(
        codeOf(call(host, ToolIds.workspaceReactiveRead, { projectId: RootProject, nodeId: Target })),
        "invalid_arguments",
    );
    assert.equal(codeOf(call(host, ToolIds.workspaceReactiveRead, { nodeId: "file:missing.ts" })), "not_available");
    assert.equal(codeOf(call(host, ToolIds.workspaceReactiveRead, { nodeId: "file:nested/b.ts" })), "not_available");
    assert.equal(codeOf(call(host, ToolIds.workspaceReactiveRead, { projectId: "project:missing" })), "not_available");
    assert.equal(codeOf(call(host, ToolIds.workspaceReactiveRead, { projectId: NestedProject })), "not_available");
});

test("reactive_read accepts maxDepth 0 and 12 and rejects other depths", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const zero: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 0 }));
    assert.equal(zero.roots.length, 1);
    assert.deepEqual(zero.roots[0].children, []);
    assert.equal(zero.roots[0].childCount, 7);
    const full: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 12 }));
    assert.ok(flattenNodes(full.roots).length > flattenNodes(zero.roots).length);
    assert.equal(codeOf(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 13 })), "invalid_arguments");
    assert.equal(codeOf(call(host, ToolIds.workspaceReactiveRead, { maxDepth: -1 })), "invalid_arguments");
    assert.equal(codeOf(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 1.5 })), "invalid_arguments");
});

test("reactive_read accepts limit 1 and 2000 and rejects other limits", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const one: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { limit: 1 }));
    assert.equal(one.nodes, 1);
    assert.equal(one.roots.length, 1);
    assert.deepEqual(one.roots[0].children, []);
    assert.equal(one.roots[0].childCount, 7);
    const large: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { limit: 2000 }));
    assert.equal(large.roots[0].children.length, 7);
    assert.equal(codeOf(call(host, ToolIds.workspaceReactiveRead, { limit: 0 })), "invalid_arguments");
    assert.equal(codeOf(call(host, ToolIds.workspaceReactiveRead, { limit: 2001 })), "invalid_arguments");
    assert.equal(codeOf(call(host, ToolIds.workspaceReactiveRead, { limit: 2.5 })), "invalid_arguments");
});

test("reactive_read rejects a stale revision", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    assert.equal(codeOf(host.call(ToolIds.workspaceReactiveRead, { revision: "rev.stale" })), "revision_mismatch");
});

/**
 * A missing revision is rejected by the schema before dispatch, so the tool
 * reports `invalid_arguments`; only a present-but-stale revision reaches the
 * service gate and yields `revision_mismatch`.
 */
test("reactive_read and reactive_write reject a missing revision at the schema boundary", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const observed: Record<string, string> = {
        read: codeOf(host.call(ToolIds.workspaceReactiveRead, {})),
        write: codeOf(host.call(ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "summary", value: "annotated" })),
    };
    assert.deepEqual(observed, { read: "invalid_arguments", write: "invalid_arguments" });
});

test("reactive_read proxies expose the documented keys and no content", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const roots: ReactiveProxy[] = dataOf(call(host, ToolIds.workspaceReactiveRead)).roots as unknown as ReactiveProxy[];
    const root: ReactiveProxy = roots[0];
    assert.deepEqual(Object.keys(root), [...ReactiveKeySet]);
    assert.equal(types.isProxy(root), true);
    assert.equal("content" in root, false);
    assert.equal(root.content, (void 0));
    assert.equal("toJSON" in root, false);
    assert.equal(typeof(root.toJSON), "function");
});

test("reactive_read serialization is deterministic and matches toJSON", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const payload: Record<string, unknown> = dataOf(call(host, ToolIds.workspaceReactiveRead));
    const first: string = JSON.stringify(payload);
    const second: string = JSON.stringify(payload);
    assert.equal(first, second);
    const root: ReactiveProxy = (payload.roots as unknown as ReactiveProxy[])[0];
    assert.deepEqual(JSON.parse(JSON.stringify(root)), root.toJSON());
});

test("reactive_read child proxies and spread keep scalar values", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const payload: Record<string, unknown> = dataOf(call(host, ToolIds.workspaceReactiveRead));
    const root: ReactiveProxy = (payload.roots as unknown as ReactiveProxy[])[0];
    const children: ReactiveProxy[] = root.children;
    assert.equal(Array.isArray(children), true);
    assert.equal(children[0].id, "directory:d1");
    assert.equal(types.isProxy(children[0]), true);
    assert.equal(children[0].kind, "directory");
    const spread: Record<string, unknown> = { ...root };
    assert.equal(spread.id, root.id);
    assert.equal(spread.kind, root.kind);
    assert.equal(spread.label, root.label);
    assert.equal(spread.summary, root.summary);
    assert.equal(spread.path, root.path);
    assert.equal(spread.revision, root.revision);
    assert.equal(spread.childCount, root.childCount);
    assert.deepEqual(spread.tags, root.tags);
    assert.equal(Array.isArray(spread.children), true);
    assert.equal((spread.children as ReactiveProxy[])[0].id, "directory:d1");
});

test("reactive_read limit 1 truncates the serialized root only", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const payload: Record<string, unknown> = dataOf(call(host, ToolIds.workspaceReactiveRead, { limit: 1 }));
    const liveRoot: ReactiveProxy = (payload.roots as unknown as ReactiveProxy[])[0];
    assert.equal(liveRoot.children.length, 7);
    const wire: ReactiveWire = wireDataOf(payload);
    assert.equal(wire.roots.length, 1);
    assert.equal(wire.roots[0].id, RootProject);
    assert.equal(wire.roots[0].childCount, 7);
    assert.equal(wire.roots[0].childCount > 0, true);
    assert.deepEqual(wire.roots[0].children, []);
    assert.equal(wire.roots[0].children.length, 0);
    assert.equal(wire.roots[0].truncated, true);
});

test("reactive_read maxDepth 0 keeps the real childCount without children", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const wire: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 0 }));
    assert.equal(wire.roots[0].childCount, 7);
    assert.ok(wire.roots[0].childCount > 0);
    assert.deepEqual(wire.roots[0].children, []);
    assert.equal(wire.roots[0].truncated, (void 0));
});

test("reactive_read maxDepth 12 stops a thirty-level chain", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const wire: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 12, limit: 2000 }));
    const nodes: WorkspaceReactiveNode[] = flattenNodes(wire.roots);
    const atTwelve: WorkspaceReactiveNode | undefined = nodes.find(
        (node: WorkspaceReactiveNode): boolean => node.path === DeepPathAt(12),
    );
    assert.ok(atTwelve, "depth 12 directory must be projected");
    assert.equal(atTwelve!.kind, "directory");
    assert.equal(atTwelve!.childCount, 1);
    assert.deepEqual(atTwelve!.children, []);
    assert.equal(
        nodes.some((node: WorkspaceReactiveNode): boolean => node.path === DeepPathAt(13)),
        false,
    );
});

test("reactive_read scopes directory, package, symbol and file children", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const directory: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { nodeId: LibDirectory }));
    assert.equal(directory.nodes, 1);
    assert.equal(directory.roots[0].kind, "directory");
    assert.equal(directory.roots[0].childCount, 2);
    assert.deepEqual(
        directory.roots[0].children.map((node: WorkspaceReactiveNode): string => node.id),
        [LibDeepDirectory, "file:lib/index.ts"],
    );
    assert.deepEqual(
        directory.roots[0].children.map((node: WorkspaceReactiveNode): string => node.kind),
        ["directory", "file"],
    );
    const packageNode: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { nodeId: PackageTarget }));
    assert.equal(packageNode.nodes, 1);
    assert.equal(packageNode.roots[0].kind, "package");
    assert.equal(packageNode.roots[0].childCount, 0);
    assert.deepEqual(packageNode.roots[0].children, []);
    const symbol: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { nodeId: SymbolTarget }));
    assert.equal(symbol.nodes, 1);
    assert.equal(symbol.roots[0].kind, "symbol");
    assert.equal(symbol.roots[0].childCount, 0);
    const file: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { nodeId: Target }));
    assert.equal(file.roots[0].kind, "file");
    assert.deepEqual(
        file.roots[0].children.map((node: WorkspaceReactiveNode): string => node.kind),
        ["symbol"],
    );
    assert.equal(file.roots[0].children[0].label, "alpha");
    const notes: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { nodeId: NotesTarget }));
    assert.deepEqual(
        notes.roots[0].children.map((node: WorkspaceReactiveNode): string => node.kind),
        ["knowledge"],
    );
    const project: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { projectId: RootProject }));
    const kinds: string[] = project.roots[0].children.map((node: WorkspaceReactiveNode): string => node.kind);
    assert.ok(kinds.includes("directory"));
    assert.ok(kinds.includes("file"));
});

test("reactive_read returns one root per authorized project", (): void => {
    const single: ReactiveWire = wireOf(call(serviceOf(), ToolIds.workspaceReactiveRead));
    assert.equal(single.nodes, 1);
    assert.equal(single.roots.length, 1);
    assert.equal(single.roots[0].id, RootProject);
    assert.equal(single.roots[0].kind, "project");
    const both: WorkspaceAgentService = serviceOf({ projectIds: [RootProject, NestedProject] });
    const pair: ReactiveWire = wireOf(call(both, ToolIds.workspaceReactiveRead));
    assert.equal(pair.nodes, 2);
    assert.deepEqual(
        pair.roots.map((node: WorkspaceReactiveNode): string => node.id),
        [NestedProject, RootProject],
    );
    assert.deepEqual(
        pair.roots.map((node: WorkspaceReactiveNode): string => node.kind),
        ["project", "project"],
    );
    const narrowed: ReactiveWire = wireOf(call(both, ToolIds.workspaceReactiveRead, { projectId: NestedProject }));
    assert.equal(narrowed.nodes, 1);
    assert.equal(narrowed.roots[0].id, NestedProject);
});

test("reactive_write rejects unknown properties and invalid annotation values", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const invalid: Array<Record<string, unknown>> = [
        { nodeId: Target, property: "annotation", value: "x" },
        { nodeId: Target, property: "tags", value: "one" },
        { nodeId: Target, property: "tags", value: [1] },
        { nodeId: Target, property: "tags", value: tagsOf(33) },
        { nodeId: Target, property: "tags", value: ["ok", ""] },
        { nodeId: Target, property: "summary", value: "x".repeat(4097) },
        { nodeId: Target, property: "label", value: "x".repeat(4097) },
        { nodeId: Target, property: "summary", value: "" },
        { nodeId: Target, property: "summary", value: null },
        { nodeId: Target, property: "label", value: 3 },
        { nodeId: Target, property: "summary", value: { text: "x" } },
    ];
    invalid.forEach((args: Record<string, unknown>): void => {
        assert.equal(codeOf(call(host, ToolIds.workspaceReactiveWrite, args)), "invalid_arguments", JSON.stringify(args));
    });
    assert.equal(dataOf(call(host, ToolIds.workspaceReactiveRead)).cacheVersion, 0);
});

test("reactive_write accepts 4096-character annotations and 32 tags", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const summary: string = "s".repeat(4096);
    const label: string = "l".repeat(4096);
    const summaryReply: ReactiveAnnotation = annotationOf(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "summary", value: summary }),
    );
    assert.equal(summaryReply.value, summary);
    assert.equal(summaryReply.cacheVersion, 1);
    const labelReply: ReactiveAnnotation = annotationOf(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "label", value: label }),
    );
    assert.equal(labelReply.value, label);
    assert.equal(labelReply.cacheVersion, 2);
    const tags: string[] = tagsOf(32);
    const tagsReply: ReactiveAnnotation = annotationOf(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "tags", value: tags }),
    );
    assert.deepEqual(tagsReply.value, tags);
    assert.equal((tagsReply.value as string[]).length, 32);
    const duplicates: string[] = ["dup", "dup"];
    const duplicateReply: ReactiveAnnotation = annotationOf(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "tags", value: duplicates }),
    );
    assert.deepEqual(duplicateReply.value, duplicates);
    const wire: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { nodeId: Target }));
    assert.equal(wire.roots[0].summary, summary);
    assert.equal(wire.roots[0].label, label);
    assert.deepEqual(wire.roots[0].tags, duplicates);
    assert.equal(wire.cacheVersion, 4);
});

test("reactive_write reports unknown nodes and stale revisions", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    assert.equal(
        codeOf(call(host, ToolIds.workspaceReactiveWrite, { nodeId: "file:missing.ts", property: "summary", value: "x" })),
        "not_available",
    );
    assert.equal(
        codeOf(call(host, ToolIds.workspaceReactiveWrite, { nodeId: "project:missing", property: "tags", value: ["x"] })),
        "not_available",
    );
    assert.equal(
        codeOf(
            host.call(ToolIds.workspaceReactiveWrite, {
                revision: "rev.stale",
                nodeId: Target,
                property: "summary",
                value: "x",
            }),
        ),
        "revision_mismatch",
    );
    assert.equal(dataOf(call(host, ToolIds.workspaceReactiveRead)).cacheVersion, 0);
});

test("reactive_write bumps cacheVersion once and reports the ancestor chain", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    assert.equal(dataOf(call(host, ToolIds.workspaceReactiveRead)).cacheVersion, 0);
    const first: ReactiveAnnotation = annotationOf(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "label", value: "Alpha" }),
    );
    assert.equal(first.nodeId, Target);
    assert.equal(first.property, "label");
    assert.equal(first.cacheVersion, 1);
    assert.deepEqual(first.invalidated, [Target, RootProject]);
    assert.equal(first.revision, entityOf("file", "a.ts").source.revision);
    const noop: ReactiveAnnotation = annotationOf(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "label", value: "Alpha" }),
    );
    assert.equal(noop.cacheVersion, 2);
    assert.deepEqual(noop.invalidated, [Target, RootProject]);
    const leaf: ReactiveAnnotation = annotationOf(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: SymbolTarget, property: "summary", value: "leaf summary" }),
    );
    assert.equal(leaf.cacheVersion, 3);
    assert.deepEqual(leaf.invalidated, [SymbolTarget, Target, RootProject]);
    const nested: ReactiveAnnotation = annotationOf(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: LibDeepDirectory, property: "label", value: "deep" }),
    );
    assert.equal(nested.cacheVersion, 4);
    assert.deepEqual(nested.invalidated, [LibDeepDirectory, LibDirectory, RootProject]);
    const packageWrite: ReactiveAnnotation = annotationOf(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: PackageTarget, property: "summary", value: "dependency" }),
    );
    assert.equal(packageWrite.cacheVersion, 5);
    assert.deepEqual(packageWrite.invalidated, [PackageTarget, RootProject]);
    assert.equal(dataOf(call(host, ToolIds.workspaceReactiveRead)).cacheVersion, 5);
});

test("reactive_write annotations are visible to new reads and old proxies", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const beforeData: Record<string, unknown> = dataOf(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 12, limit: 2000 }));
    const before: ReactiveWire = wireDataOf(beforeData);
    const beforeFile: ReactiveProxy = findProxy((beforeData.roots as unknown as ReactiveProxy[])[0], Target)!;
    assert.equal(beforeFile.label, "a.ts");
    assert.equal(beforeFile.summary, "file a.ts");
    annotationOf(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "label", value: "Alpha file" }));
    annotationOf(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "summary", value: "annotated a.ts" }));
    annotationOf(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "tags", value: ["one", "two"] }));
    const after: WorkspaceReactiveNode = findNode(
        wireOf(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 12, limit: 2000 })),
        Target,
    )!;
    assert.equal(after.label, "Alpha file");
    assert.equal(after.summary, "annotated a.ts");
    assert.deepEqual(after.tags, ["one", "two"]);
    assert.equal(findNode(before, Target)!.label, "a.ts");
    /**
     * The override lookup happens when the node is read, so a proxy created
     * before the write reports the new annotation both on property access and
     * on serialization. That is the service's documented behavior, not a stale
     * snapshot leak; the assertion pins it rather than treating it as a bug.
     */
    assert.equal(beforeFile.label, "Alpha file");
    assert.equal(beforeFile.summary, "annotated a.ts");
    assert.deepEqual(beforeFile.tags, ["one", "two"]);
    const oldJson: WorkspaceReactiveNode = JSON.parse(JSON.stringify(beforeFile)) as WorkspaceReactiveNode;
    assert.equal(oldJson.label, "Alpha file");
    assert.equal(oldJson.summary, "annotated a.ts");
    assert.deepEqual(oldJson.tags, ["one", "two"]);
});

test("reactive_write annotations are service-local", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    annotationOf(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "label", value: "Alpha file" }));
    annotationOf(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "tags", value: ["one"] }));
    const second: WorkspaceAgentService = serviceOf();
    const secondWire: ReactiveWire = wireOf(call(second, ToolIds.workspaceReactiveRead, { maxDepth: 12, limit: 2000 }));
    const secondFile: WorkspaceReactiveNode = findNode(secondWire, Target)!;
    assert.equal(secondFile.label, "a.ts");
    assert.equal(secondFile.summary, "file a.ts");
    assert.deepEqual(secondFile.tags, []);
    assert.equal(secondWire.cacheVersion, 0);
});

test("reactive_write content needs a materialized context holding the node", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.gating");
    assert.equal(
        codeOf(call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "content", value: "next\n" })),
        "not_available",
    );
    assert.equal(
        codeOf(
            call(host, ToolIds.workspaceReactiveWrite, {
                nodeId: Target,
                property: "content",
                value: "next\n",
                contextId: "ctx.missing",
            }),
        ),
        "not_available",
    );
    const otherContext: string = materializedContext(host, [ConsumerTarget], "f.other");
    assert.equal(
        codeOf(
            call(host, ToolIds.workspaceReactiveWrite, {
                nodeId: Target,
                property: "content",
                value: "next\n",
                contextId: otherContext,
            }),
        ),
        "not_available",
    );
    const payload: WritePayload = writePayloadOf(
        call(host, ToolIds.workspaceReactiveWrite, {
            nodeId: Target,
            property: "content",
            value: "next\n",
            contextId,
        }),
    );
    assert.equal(payload.revision, "rev.1");
    assert.equal(recorded.requests.length, 1);
});

test("reactive_write content rejects directory, package and symbol targets", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const targets: Array<[string, string]> = [
        [LibDirectory, "f.directory"],
        [LibDeepDirectory, "f.deep"],
        [PackageTarget, "f.package"],
        [SymbolTarget, "f.symbol"],
    ];
    targets.forEach(([nodeId, frameId]: [string, string]): void => {
        const contextId: string = materializedContext(host, [nodeId], frameId);
        assert.equal(
            codeOf(call(host, ToolIds.workspaceReactiveWrite, { nodeId, property: "content", value: "next\n", contextId })),
            "invalid_arguments",
            nodeId,
        );
    });
    assert.equal(recorded.requests.length, 0);
});

test("reactive_write content needs a writer and previews under dryRun", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.dry");
    const payload: WritePayload = writePayloadOf(
        call(host, ToolIds.workspaceReactiveWrite, {
            nodeId: Target,
            property: "content",
            value: NextContentA,
            contextId,
            dryRun: true,
        }),
    );
    assert.equal(payload.revision, null);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.mode, "node");
    assert.equal(payload.previousRevision, entityOf("file", "a.ts").source.revision);
    assert.equal(payload.bytes, new TextEncoder().encode(NextContentA).length);
    assert.equal(payload.lines, 2);
    assert.equal(recorded.requests.length, 0);
    assert.equal(
        dataOf(call(host, ToolIds.workspaceRead, { contextId, nodeId: Target })).text,
        ContentA,
    );
    const writerless: WorkspaceAgentService = serviceOf();
    const writerlessContext: string = materializedContext(writerless, [Target], "f.writerless");
    assert.equal(
        codeOf(
            call(writerless, ToolIds.workspaceReactiveWrite, {
                nodeId: Target,
                property: "content",
                value: "next\n",
                contextId: writerlessContext,
            }),
        ),
        "write_unavailable",
    );
    const preview: WritePayload = writePayloadOf(
        call(writerless, ToolIds.workspaceReactiveWrite, {
            nodeId: Target,
            property: "content",
            value: "preview\n",
            contextId: writerlessContext,
            dryRun: true,
        }),
    );
    assert.equal(preview.revision, null);
    assert.equal(preview.dryRun, true);
    assert.equal(recorded.requests.length, 0);
});

test("reactive_write content enforces compare-and-swap", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.cas");
    assert.equal(
        codeOf(
            call(host, ToolIds.workspaceReactiveWrite, {
                nodeId: Target,
                property: "content",
                value: NextContentA,
                contextId,
                expectRevision: "rev.stale",
            }),
        ),
        "fingerprint_mismatch",
    );
    assert.equal(recorded.requests.length, 0);
    const payload: WritePayload = writePayloadOf(
        call(host, ToolIds.workspaceReactiveWrite, {
            nodeId: Target,
            property: "content",
            value: NextContentA,
            contextId,
            expectRevision: entityOf("file", "a.ts").source.revision,
        }),
    );
    assert.equal(payload.revision, "rev.1");
    assert.equal(recorded.requests.length, 1);
});

test("reactive_write content propagates refusals, throws and bad revisions", (): void => {
    const failures: Array<[string, WorkspaceWriter, string]> = [
        ["refusal", writerOutcome({ ok: false, code: "capacity_exceeded" }), "capacity_exceeded"],
        [
            "throws",
            {
                write: (): WorkspaceWriteOutcome => {
                    throw new Error("host writer failed");
                },
            },
            "internal_error",
        ],
        ["empty", writerOutcome({ ok: true, revision: "" }), "internal_error"],
        ["numeric", writerOutcome({ ok: true, revision: 7 }), "internal_error"],
        ["missing", writerOutcome({ ok: true }), "internal_error"],
    ];
    failures.forEach(([name, writer, expected]: [string, WorkspaceWriter, string]): void => {
        const host: WorkspaceAgentService = serviceOf({ writer });
        const contextId: string = materializedContext(host, [Target], `f.${name}`);
        assert.equal(
            codeOf(
                call(host, ToolIds.workspaceReactiveWrite, {
                    nodeId: Target,
                    property: "content",
                    value: "next\n",
                    contextId,
                }),
            ),
            expected,
            name,
        );
    });
});

test("reactive_write content persists and the read/reactive revision follows", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.success");
    const previousRevision: string = entityOf("file", "a.ts").source.revision;
    const payload: WritePayload = writePayloadOf(
        call(host, ToolIds.workspaceReactiveWrite, {
            nodeId: Target,
            property: "content",
            value: NextContentA,
            contextId,
        }),
    );
    assert.equal(payload.nodeId, Target);
    assert.equal(payload.path, "a.ts");
    assert.equal(payload.mode, "node");
    assert.equal(payload.dryRun, false);
    assert.equal(payload.previousRevision, previousRevision);
    assert.equal(payload.revision, "rev.1");
    assert.equal(payload.bytes, new TextEncoder().encode(NextContentA).length);
    assert.equal(payload.lines, 2);
    assert.equal(typeof(payload.remainingTokens), "number");
    assert.equal(payload.exportation.path, "a.ts");
    assert.deepEqual(
        payload.exportation.files.map((file): string => file.path),
        ["consumer.ts"],
    );
    assert.equal(payload.importation.path, "a.ts");
    assert.deepEqual(
        payload.importation.files.map((file): string => file.path),
        ["src/util.ts"],
    );
    assert.equal(recorded.requests.length, 1);
    assert.equal(recorded.requests[0].agentId, AgentId);
    assert.equal(recorded.requests[0].nodeId, Target);
    assert.equal(recorded.requests[0].uri, "a.ts");
    assert.equal(recorded.requests[0].content, NextContentA);
    assert.equal(recorded.requests[0].previousRevision, previousRevision);
    const page: Record<string, unknown> = dataOf(call(host, ToolIds.workspaceRead, { contextId, nodeId: Target }));
    assert.equal(page.text, NextContentA);
    assert.equal((page.source as { revision: string; }).revision, "rev.1");
    const reactive: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { nodeId: Target }));
    assert.equal(reactive.roots[0].revision, "rev.1");
    const tree: ReactiveWire = wireOf(call(host, ToolIds.workspaceReactiveRead, { maxDepth: 12, limit: 2000 }));
    assert.equal(findNode(tree, Target)!.revision, "rev.1");
    assert.equal(tree.cacheVersion, 1);
});

/**
 * Additional boundary observation, outside the requested matrix: after a
 * content write the service reports the writer revision from `reactive_read`
 * and `read`, but an annotation reply still carries the immutable snapshot
 * revision. Feeding that value back as `expectRevision` fails
 * `fingerprint_mismatch`, so the two surfaces disagree about the node's
 * revision. The test pins the consistency expectation; the report flags it.
 */
test("reactive_write annotation replies carry the service revision after a content write", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [Target], "f.revision");
    const content: WritePayload = writePayloadOf(
        call(host, ToolIds.workspaceReactiveWrite, {
            nodeId: Target,
            property: "content",
            value: NextContentA,
            contextId,
        }),
    );
    assert.equal(content.revision, "rev.1");
    const annotation: ReactiveAnnotation = annotationOf(
        call(host, ToolIds.workspaceReactiveWrite, { nodeId: Target, property: "summary", value: "post-write" }),
    );
    const node: WorkspaceReactiveNode = wireOf(call(host, ToolIds.workspaceReactiveRead, { nodeId: Target })).roots[0];
    const page: Record<string, unknown> = dataOf(call(host, ToolIds.workspaceRead, { contextId, nodeId: Target }));
    assert.equal(node.revision, "rev.1");
    assert.equal((page.source as { revision: string; }).revision, "rev.1");
    assert.equal(annotation.revision, node.revision, "annotation reply revision must match the node revision the service reports");
});

test("reactive_read and reactive_write handle a 200-node annotated tree", (): void => {
    const bigStore: MemoryContentStore = new MemoryContentStore();
    const inputs: StructuredWorkspaceFile[] = [{ path: "package.json", content: '{"name":"big-fixture"}' }];
    for (let index: number = 0; index < 198; index += 1) {
        inputs.push({ path: `f${String(index).padStart(3, "0")}.ts`, content: "" });
    }
    const bigSnapshot: WorkspaceSnapshot = scanStructuredWorkspace(inputs, bigStore);
    const big: WorkspaceAgentService = new WorkspaceAgentService({
        agentId: AgentId,
        projectIds: [RootProject],
        snapshot: bigSnapshot,
        store: bigStore,
    });
    const bigCall: (tool: string, args?: Record<string, unknown>) => WorkspaceResponse = (
        tool: string,
        args: Record<string, unknown> = {},
    ): WorkspaceResponse => big.call(tool, { revision: bigSnapshot.revision, ...args });
    const initial: ReactiveWire = wireOf(bigCall(ToolIds.workspaceReactiveRead, { limit: 2000 }));
    const nodes: WorkspaceReactiveNode[] = flattenNodes(initial.roots);
    assert.equal(nodes.length, 200);
    const summaries: Map<string, string> = new Map<string, string>();
    nodes.forEach((node: WorkspaceReactiveNode, index: number): void => {
        const summary: string = `summary-${index}`;
        summaries.set(node.id, summary);
        const reply: ReactiveAnnotation = annotationOf(
            bigCall(ToolIds.workspaceReactiveWrite, { nodeId: node.id, property: "summary", value: summary }),
        );
        assert.equal(reply.cacheVersion, index + 1);
    });
    const annotated: ReactiveWire = wireOf(bigCall(ToolIds.workspaceReactiveRead, { limit: 2000 }));
    const annotatedNodes: WorkspaceReactiveNode[] = flattenNodes(annotated.roots);
    assert.equal(annotatedNodes.length, 200);
    assert.equal(annotated.cacheVersion, 200);
    annotatedNodes.forEach((node: WorkspaceReactiveNode): void => {
        assert.equal(node.summary, summaries.get(node.id), node.id);
    });
});
