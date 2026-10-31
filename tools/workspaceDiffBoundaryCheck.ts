#!/usr/bin/env node
/**
 * Boundary checks for `amp_tool_workspace_diff_read`,
 * `amp_tool_workspace_diff_write` and the pure helpers in
 * `src/context/workspaceDiff.ts`.
 *
 * The existing `workspaceDiffCheck.ts` check covers the ordinary helper paths
 * and `workspaceReactiveDiffCheck.ts` covers the happy paths of both tools.
 * This file only probes what sits on the edges: closed schema bounds, the
 * exact size ceilings, empty files, CRLF and trailing-newline shapes, 1-based
 * hunk coordinates, allocation/CAS/dryRun failures, writer misbehaviour and
 * the 5000-line diff bound. Every fixture is in memory; nothing touches disk
 * and no source file is modified.
 *
 * Run with `node tools/workspaceDiffBoundaryCheck.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import { WorkspaceDiffError, applyByteChanges, applyLineChanges, summarizeDiff } from "../src/context/workspaceDiff.ts";
import type { ByteChange, DiffSummary, LineChange, WorkspaceDiffCode } from "../src/context/workspaceDiff.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceServiceLimits, WorkspaceWriteOutcome, WorkspaceWriteRequest, WorkspaceWriter } from "../src/context/workspaceService.ts";
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import type { Frame } from "../src/frame/frame.ts";
import { ToolIds } from "../src/naming/index.ts";
import type {
    WorkspaceDiffNode,
    WorkspaceErrorCode,
    WorkspaceExportation,
    WorkspaceImportation,
    WorkspaceResponse,
} from "../src/protocol/workspace.ts";
import { scanStructuredWorkspace } from "./support/documentScanner.ts";

interface FixtureFile {
    path: string;
    content: string;
}

interface ServiceOptions {
    writer?: WorkspaceWriter;
    limits?: Partial<WorkspaceServiceLimits>;
}

interface RecordedWriter {
    writer: WorkspaceWriter;
    requests: WorkspaceWriteRequest[];
}

interface DiffWire {
    revision: string;
    roots: WorkspaceDiffNode[];
    files: number;
    nodes: number;
    truncated: boolean;
}

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
    hunks: Array<{ beforeStart: number; beforeLines: number; afterStart: number; afterLines: number; }>;
    remainingTokens: number;
    exportation: WorkspaceExportation;
    importation: WorkspaceImportation;
}

const AgentId: string = "a.boundary";
const ContentA: string = 'import { xx } from "./c.ts";\nexport const xxx = xx;\n';
const ContentC: string = "export const xx = 1;\n";
const ContentD: string = 'import { xxx } from "./a.ts";\nconsole.log(xxx);\n';
const ContentLines: string = "alpha\nbeta\ngamma\ndelta\n";
const ContentNoEol: string = "one\ntwo";
const ContentCrlf: string = "first line\r\nsecond line\r\n";
const ContentUnicode: string = "caf\u00e9\n";
const ContentCapacity: string = "012345678\nabcdef";

/**
 * `count` numbered lines, each terminated by a newline.
 */
const numberedLines: (count: number) => string = (count: number): string => {
    const lines: string[] = [];
    for (let index: number = 1; index <= count; index += 1) {
        lines.push(`line ${index}`);
    }
    return `${lines.join("\n")}\n`;
};

/**
 * 5001 lines: one past the 5000-line bound the diff projection applies.
 */
const ContentBig: string = numberedLines(5001);

/**
 * The same 5001 lines with the final line changed, so the change itself is
 * outside the bounded window.
 */
const ContentBigChanged: string = `${numberedLines(5000)}LINE 5001\n`;

const Fixture: readonly FixtureFile[] = [
    { path: "package.json", content: '{"name":"boundary"}' },
    { path: "a.ts", content: ContentA },
    { path: "c.ts", content: ContentC },
    { path: "d.ts", content: ContentD },
    { path: "empty.ts", content: "" },
    { path: "noeol.ts", content: ContentNoEol },
    { path: "crlf.ts", content: ContentCrlf },
    { path: "lines.txt", content: ContentLines },
    { path: "cap.txt", content: ContentCapacity },
    { path: "unicode.txt", content: ContentUnicode },
    { path: "big.txt", content: ContentBig },
    { path: "src/util.ts", content: "export const util = 1;\n" },
];

const Store: MemoryContentStore = new MemoryContentStore();
const Snapshot: WorkspaceSnapshot = scanStructuredWorkspace(Fixture, Store);
const Revision: string = Snapshot.revision;

const TargetA: string = "file:a.ts";
const TargetC: string = "file:c.ts";
const TargetEmpty: string = "file:empty.ts";
const TargetNoEol: string = "file:noeol.ts";
const TargetCrlf: string = "file:crlf.ts";
const TargetLines: string = "file:lines.txt";
const TargetCapacity: string = "file:cap.txt";
const TargetUnicode: string = "file:unicode.txt";
const TargetBig: string = "file:big.txt";

const entityOf: (id: string) => WorkspaceEntity = (id: string): WorkspaceEntity => {
    const found: WorkspaceEntity | undefined = Snapshot.entities.find((item: WorkspaceEntity): boolean => item.id === id);
    assert.ok(found, `entity ${id} must exist`);
    return found!;
};

const snapshotRevisionOf: (id: string) => string = (id: string): string => entityOf(id).source.revision;

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

const code: (response: WorkspaceResponse) => WorkspaceErrorCode = (response: WorkspaceResponse): WorkspaceErrorCode => {
    assert.equal(response.ok, false, JSON.stringify(response));
    if (!("error" in response)) {
        throw new Error("expected error");
    }
    return response.error.code;
};

const call: (host: WorkspaceAgentService, tool: string, args?: Record<string, unknown>) => WorkspaceResponse = (
    host: WorkspaceAgentService,
    tool: string,
    args: Record<string, unknown> = {},
): WorkspaceResponse => host.call(tool, { revision: Revision, ...args });

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
    ts: "2026-10-30T00:00:00Z",
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
        projectIds: ["project:."],
        snapshot: Snapshot,
        store: Store,
        ...(options.writer === (void 0) ? {} : { writer: options.writer }),
        ...(options.limits === (void 0) ? {} : { limits: options.limits }),
    });

const materializedContext: (host: WorkspaceAgentService, nodeIds: readonly string[], frameId?: string) => string = (
    host: WorkspaceAgentService,
    nodeIds: readonly string[],
    frameId: string = "f.boundary",
): string => {
    host.registerFrame(frameOf(frameId, nodeIds), Revision);
    const view: Record<string, unknown> = data(call(host, ToolIds.workspaceMaterialize, { frameId, budgetTokens: 4000 }));
    nodeIds.forEach((nodeId: string): void => {
        assert.ok((view.readableIds as string[]).includes(nodeId), `readable ${nodeId}`);
    });
    return view.contextId as string;
};

const diffReadOf: (host: WorkspaceAgentService, args?: Record<string, unknown>) => DiffWire = (
    host: WorkspaceAgentService,
    args: Record<string, unknown> = {},
): DiffWire => data(call(host, ToolIds.workspaceDiffRead, args)) as unknown as DiffWire;

const diffWriteOf: (host: WorkspaceAgentService, args: Record<string, unknown>) => DiffWritePayload = (
    host: WorkspaceAgentService,
    args: Record<string, unknown>,
): DiffWritePayload => data(call(host, ToolIds.workspaceDiffWrite, args)) as unknown as DiffWritePayload;

const diffNodesOf: (nodes: readonly WorkspaceDiffNode[]) => WorkspaceDiffNode[] = (nodes: readonly WorkspaceDiffNode[]): WorkspaceDiffNode[] =>
    nodes.flatMap((node: WorkspaceDiffNode): WorkspaceDiffNode[] => [node, ...diffNodesOf(node.children)]);

const diffNodeOf: (wire: DiffWire, id: string) => WorkspaceDiffNode | undefined = (
    wire: DiffWire,
    id: string,
): WorkspaceDiffNode | undefined => diffNodesOf(wire.roots).find((node: WorkspaceDiffNode): boolean => node.id === id);

const diffFilePathsOf: (wire: DiffWire) => string[] = (wire: DiffWire): string[] =>
    diffNodesOf(wire.roots)
        .filter((node: WorkspaceDiffNode): boolean => node.kind === "file")
        .map((node: WorkspaceDiffNode): string => node.path);

const recordingWriter: () => RecordedWriter = (): RecordedWriter => {
    const requests: WorkspaceWriteRequest[] = [];
    const writer: WorkspaceWriter = {
        write: (request: WorkspaceWriteRequest): WorkspaceWriteOutcome => {
            requests.push({ ...request });
            return { ok: true, revision: `rev.${requests.length}` };
        },
    };
    return { writer, requests };
};

const refusingWriter: (codeValue: WorkspaceErrorCode) => RecordedWriter = (codeValue: WorkspaceErrorCode): RecordedWriter => {
    const requests: WorkspaceWriteRequest[] = [];
    const writer: WorkspaceWriter = {
        write: (request: WorkspaceWriteRequest): WorkspaceWriteOutcome => {
            requests.push({ ...request });
            return { ok: false, code: codeValue };
        },
    };
    return { writer, requests };
};

const blankRevisionWriter: () => RecordedWriter = (): RecordedWriter => {
    const requests: WorkspaceWriteRequest[] = [];
    const writer: WorkspaceWriter = {
        write: (request: WorkspaceWriteRequest): WorkspaceWriteOutcome => {
            requests.push({ ...request });
            return { ok: true, revision: "" };
        },
    };
    return { writer, requests };
};

const lineChange: (startLine: number, endLine: number, content: string) => LineChange = (
    startLine: number,
    endLine: number,
    content: string,
): LineChange => ({ startLine, endLine, content });

const byteChange: (offsetBytes: number, endBytes: number, content: string) => ByteChange = (
    offsetBytes: number,
    endBytes: number,
    content: string,
): ByteChange => ({ offsetBytes, endBytes, content });

const expectDiffCode: (action: () => unknown, expected: WorkspaceDiffCode) => void = (
    action: () => unknown,
    expected: WorkspaceDiffCode,
): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof WorkspaceDiffError && error.code === expected && error.message === expected);
};

/**
 * Run one `diff_write` and assert that this particular edit mode was selected.
 */
const writeWithStrategy: (
    host: WorkspaceAgentService,
    nodeId: string,
    contextId: string,
    args: Record<string, unknown>,
    strategy: string,
) => DiffWritePayload = (
    host: WorkspaceAgentService,
    nodeId: string,
    contextId: string,
    args: Record<string, unknown>,
    strategy: string,
): DiffWritePayload => {
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId, ...args });
    assert.equal(payload.strategy, strategy);
    return payload;
};

test("diff_read scope: an unknown projectId is not_available", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    assert.equal(code(call(host, ToolIds.workspaceDiffRead, { projectId: "project:missing" })), "not_available");
});

test("diff_read scope: a non-project projectId is invalid_arguments", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    assert.equal(code(call(host, ToolIds.workspaceDiffRead, { projectId: TargetA })), "invalid_arguments");
});

test("diff_read schema: limit 1 and 2000 are accepted, 0 and 2001 are rejected", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    assert.equal(diffReadOf(host, { limit: 1 }).truncated, true);
    const full: DiffWire = diffReadOf(host, { limit: 2000 });
    assert.equal(full.truncated, false);
    assert.equal(full.nodes, 14);
    assert.equal(full.files, 12);
    assert.equal(code(call(host, ToolIds.workspaceDiffRead, { limit: 0 })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffRead, { limit: 2001 })), "invalid_arguments");
});

test("diff_read includeContent without a contextId is not_available", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    assert.equal(code(call(host, ToolIds.workspaceDiffRead, { includeContent: true })), "not_available");
    assert.equal(code(call(host, ToolIds.workspaceDiffRead, { includeContent: true, contextId: "ctx.missing" })), "not_available");
});

test("diff_read includeContent truncates a readable file to maxReadChars", (): void => {
    const host: WorkspaceAgentService = serviceOf({ limits: { maxReadChars: 8 } });
    const contextId: string = materializedContext(host, [TargetA]);
    const wire: DiffWire = diffReadOf(host, { includeContent: true, contextId });
    const file: WorkspaceDiffNode = diffNodeOf(wire, TargetA)!;
    assert.equal(file.contentOmitted, false);
    assert.equal(file.content, ContentA.slice(0, 8));
    assert.equal((file.content as string).length, 8);
    assert.equal(file.bytes, new TextEncoder().encode(ContentA).length);
});

test("diff_read includeContent omits a file outside the context", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const contextId: string = materializedContext(host, [TargetA]);
    const wire: DiffWire = diffReadOf(host, { includeContent: true, contextId });
    const outside: WorkspaceDiffNode = diffNodeOf(wire, TargetC)!;
    assert.equal(outside.content, null);
    assert.equal(outside.contentOmitted, true);
    const project: WorkspaceDiffNode = wire.roots[0];
    assert.equal(project.content, null);
    assert.equal(project.contentOmitted, false);
});

test("diff_read ignores contextId when includeContent is absent", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const wire: DiffWire = diffReadOf(host, { contextId: "ctx.missing" });
    assert.equal(wire.files, 12);
    const files: WorkspaceDiffNode[] = diffNodesOf(wire.roots).filter((node: WorkspaceDiffNode): boolean => node.kind === "file");
    assert.equal(files.length, 12);
    files.forEach((file: WorkspaceDiffNode): void => {
        assert.equal(file.content, null);
        assert.equal(file.contentOmitted, false);
    });
});

test("diff_read metrics: an empty file reports bytes 0 and lines 0", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const file: WorkspaceDiffNode = diffNodeOf(diffReadOf(host), TargetEmpty)!;
    assert.equal(file.bytes, 0);
    assert.equal(file.lines, 0);
});

test("diff_read metrics: a file without a trailing newline has no phantom line", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const file: WorkspaceDiffNode = diffNodeOf(diffReadOf(host), TargetNoEol)!;
    assert.equal(file.bytes, 7);
    assert.equal(file.lines, 2);
});

test("diff_read metrics: a CRLF file counts carriage returns in bytes", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const file: WorkspaceDiffNode = diffNodeOf(diffReadOf(host), TargetCrlf)!;
    assert.equal(file.lines, 2);
    assert.equal(file.bytes, new TextEncoder().encode(ContentCrlf).length);
    assert.equal(file.bytes, 25);
    assert.equal((file.bytes as number) - 2, ContentCrlf.replace(/\r\n/g, "\n").length);
});

test("diff_read metrics: project and directory nodes report null bytes and lines", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const wire: DiffWire = diffReadOf(host);
    const project: WorkspaceDiffNode = wire.roots[0];
    assert.equal(project.kind, "project");
    assert.equal(project.bytes, null);
    assert.equal(project.lines, null);
    const directory: WorkspaceDiffNode = diffNodeOf(wire, "directory:src")!;
    assert.equal(directory.kind, "directory");
    assert.equal(directory.bytes, null);
    assert.equal(directory.lines, null);
});

test("diff_read filters: extension accepts bare, dotted and uppercase forms", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const expected: string[] = ["a.ts", "c.ts", "crlf.ts", "d.ts", "empty.ts", "noeol.ts", "src/util.ts"];
    const bare: DiffWire = diffReadOf(host, { extension: "ts" });
    assert.equal(bare.files, 7);
    assert.deepEqual(diffFilePathsOf(bare).sort(), expected);
    const dotted: DiffWire = diffReadOf(host, { extension: ".ts" });
    assert.deepEqual(diffFilePathsOf(dotted).sort(), expected);
    const upper: DiffWire = diffReadOf(host, { extension: "TS" });
    assert.deepEqual(diffFilePathsOf(upper).sort(), expected);
    const manifest: DiffWire = diffReadOf(host, { extension: "json" });
    assert.equal(manifest.files, 1);
    assert.deepEqual(diffFilePathsOf(manifest), ["package.json"]);
    const doubleDotted: DiffWire = diffReadOf(host, { extension: "..ts" });
    assert.deepEqual(diffFilePathsOf(doubleDotted), []);
});

test("diff_read filter: pathPrefix keeps only matching files", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const wire: DiffWire = diffReadOf(host, { pathPrefix: "src/" });
    assert.equal(wire.files, 1);
    assert.equal(wire.nodes, 3);
    assert.deepEqual(diffFilePathsOf(wire), ["src/util.ts"]);
    const directory: WorkspaceDiffNode = diffNodeOf(wire, "directory:src")!;
    assert.equal(directory.childCount, 1);
    const empty: DiffWire = diffReadOf(host, { pathPrefix: "missing/" });
    assert.equal(empty.files, 0);
    assert.equal(empty.nodes, 2);
});

test("diff_read limit 1 truncates the tree", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const wire: DiffWire = diffReadOf(host, { limit: 1 });
    assert.equal(wire.truncated, true);
    assert.equal(wire.nodes, 1);
    assert.equal(wire.files, 0);
    assert.equal(wire.roots.length, 1);
    assert.deepEqual(wire.roots[0].children, []);
    assert.equal(wire.roots[0].childCount, 12);
});

test("diff_read reports the writer revision for a file written through diff_write", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    const next: string = 'import { xx } from "./c.ts";\nexport const xxx = 3;\n';
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetA, content: next });
    assert.equal(payload.revision, "rev.1");
    assert.equal(payload.previousRevision, snapshotRevisionOf(TargetA));
    const file: WorkspaceDiffNode = diffNodeOf(diffReadOf(host), TargetA)!;
    assert.equal(file.revision, "rev.1");
    assert.notEqual(file.revision, snapshotRevisionOf(TargetA));
    assert.equal(file.bytes, new TextEncoder().encode(next).length);
    assert.equal(file.lines, 2);
    const withContent: WorkspaceDiffNode = diffNodeOf(diffReadOf(host, { includeContent: true, contextId }), TargetA)!;
    assert.equal(withContent.content, next);
    assert.equal(withContent.revision, "rev.1");
});

test("diff_write mode: no edit mode is invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA })), "invalid_arguments");
    assert.equal(recorded.requests.length, 0);
});

test("diff_write mode: two edit modes are invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    const changes: LineChange[] = [lineChange(1, 1, "x")];
    const byteChanges: ByteChange[] = [byteChange(0, 1, "y")];
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, content: "x", changes })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, content: "x", byteChanges })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, changes, byteChanges })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, content: "x", changes: [] })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, content: "x", byteChanges: [] })), "invalid_arguments");
    assert.equal(recorded.requests.length, 0);
});

test("diff_write mode: changes [] alone and byteChanges [] alone are invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, changes: [] })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, byteChanges: [] })), "invalid_arguments");
    assert.equal(recorded.requests.length, 0);
});

test("diff_write schema: more than 100 line or byte changes is invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    const manyLines: LineChange[] = Array.from({ length: 101 }, (_value: unknown, index: number): LineChange => lineChange(1, 1, `x${index}`));
    const manyBytes: ByteChange[] = Array.from({ length: 101 }, (_value: unknown, index: number): ByteChange => byteChange(0, 1, `y${index}`));
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, changes: manyLines })), "invalid_arguments");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, byteChanges: manyBytes })), "invalid_arguments");
    assert.equal(recorded.requests.length, 0);
});

test("diff_write whole-file: empty content deletes the body", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    const payload: DiffWritePayload = writeWithStrategy(host, TargetLines, contextId, { content: "" }, "whole");
    assert.equal(payload.revision, "rev.1");
    assert.equal(payload.bytes, 0);
    assert.equal(payload.lines, 0);
    assert.equal(payload.added, 0);
    assert.equal(payload.removed, 4);
    assert.equal(payload.unchanged, 0);
    assert.deepEqual(payload.hunks, [{ beforeStart: 1, beforeLines: 4, afterStart: 1, afterLines: 0 }]);
    assert.equal(recorded.requests[0].content, "");
    const reread: Record<string, unknown> = data(call(host, ToolIds.workspaceRead, { contextId, nodeId: TargetLines }));
    assert.equal(reread.text, "");
    const file: WorkspaceDiffNode = diffNodeOf(diffReadOf(host, { includeContent: true, contextId }), TargetLines)!;
    assert.equal(file.revision, "rev.1");
    assert.equal(file.bytes, 0);
    assert.equal(file.lines, 0);
    assert.equal(file.content, "");
    assert.equal(file.contentOmitted, false);
});

test("diff_write whole-file: identical content reports no change and no hunks", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetLines, content: ContentLines });
    assert.equal(payload.added, 0);
    assert.equal(payload.removed, 0);
    assert.equal(payload.unchanged, 4);
    assert.deepEqual(payload.hunks, []);
    assert.equal(payload.bytes, 23);
    assert.equal(payload.lines, 4);
    assert.equal(recorded.requests[0].content, ContentLines);
});

test("diff_write whole-file: content without a trailing newline is written verbatim", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    const next: string = "alpha\nbeta\ngamma\ndelta";
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetLines, content: next });
    assert.equal(recorded.requests[0].content, next);
    assert.equal(recorded.requests[0].content.endsWith("\n"), false);
    assert.equal(payload.bytes, 22);
    assert.equal(payload.lines, 4);
    assert.equal(payload.added, 0);
    assert.equal(payload.removed, 0);
    assert.deepEqual(payload.hunks, []);
});

test("diff_write whole-file: shorter and longer content report the expected counts", (): void => {
    const shorterWriter: RecordedWriter = recordingWriter();
    const shorterHost: WorkspaceAgentService = serviceOf({ writer: shorterWriter.writer });
    const shorterContext: string = materializedContext(shorterHost, [TargetA]);
    const shorterPayload: DiffWritePayload = diffWriteOf(shorterHost, { contextId: shorterContext, nodeId: TargetA, content: "export const xxx = 1;\n" });
    assert.equal(shorterPayload.added, 1);
    assert.equal(shorterPayload.removed, 2);
    assert.equal(shorterPayload.unchanged, 0);
    assert.deepEqual(shorterPayload.hunks, [{ beforeStart: 1, beforeLines: 2, afterStart: 1, afterLines: 1 }]);
    const longerWriter: RecordedWriter = recordingWriter();
    const longerHost: WorkspaceAgentService = serviceOf({ writer: longerWriter.writer });
    const longerContext: string = materializedContext(longerHost, [TargetA]);
    const longerPayload: DiffWritePayload = diffWriteOf(longerHost, { contextId: longerContext, nodeId: TargetA, content: `${ContentA}console.log(xxx);\n` });
    assert.equal(longerPayload.added, 1);
    assert.equal(longerPayload.removed, 0);
    assert.equal(longerPayload.unchanged, 2);
    assert.deepEqual(longerPayload.hunks, [{ beforeStart: 1, beforeLines: 2, afterStart: 1, afterLines: 3 }]);
    assert.equal(longerPayload.lines, 3);
});

test("diff_write lines: replaces the first line", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    const payload: DiffWritePayload = writeWithStrategy(host, TargetLines, contextId, { changes: [lineChange(1, 1, "ALPHA")], contextLines: 0 }, "lines");
    assert.equal(recorded.requests[0].content, "ALPHA\nbeta\ngamma\ndelta\n");
    assert.equal(payload.added, 1);
    assert.equal(payload.removed, 1);
    assert.equal(payload.unchanged, 3);
    assert.deepEqual(payload.hunks, [{ beforeStart: 1, beforeLines: 1, afterStart: 1, afterLines: 1 }]);
});

test("diff_write lines: replaces the last line", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetLines, changes: [lineChange(4, 4, "DELTA")], contextLines: 0 });
    assert.equal(recorded.requests[0].content, "alpha\nbeta\ngamma\nDELTA\n");
    assert.deepEqual(payload.hunks, [{ beforeStart: 4, beforeLines: 1, afterStart: 4, afterLines: 1 }]);
});

test("diff_write lines: replaces every line", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetLines, changes: [lineChange(1, 4, "omega")], contextLines: 0 });
    assert.equal(recorded.requests[0].content, "omega\n");
    assert.equal(payload.added, 1);
    assert.equal(payload.removed, 4);
    assert.equal(payload.unchanged, 0);
    assert.deepEqual(payload.hunks, [{ beforeStart: 1, beforeLines: 4, afterStart: 1, afterLines: 1 }]);
    assert.equal(payload.lines, 1);
});

test("diff_write lines: deletes a middle line with empty content", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetLines, changes: [lineChange(2, 2, "")], contextLines: 0 });
    assert.equal(recorded.requests[0].content, "alpha\ngamma\ndelta\n");
    assert.equal(payload.added, 0);
    assert.equal(payload.removed, 1);
    assert.equal(payload.unchanged, 3);
    assert.deepEqual(payload.hunks, [{ beforeStart: 2, beforeLines: 1, afterStart: 2, afterLines: 0 }]);
    assert.equal(payload.lines, 3);
});

test("diff_write lines: inserts lines by replacing one line with several", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetLines, changes: [lineChange(2, 2, "beta1\nbeta2")], contextLines: 0 });
    assert.equal(recorded.requests[0].content, "alpha\nbeta1\nbeta2\ngamma\ndelta\n");
    assert.equal(payload.added, 2);
    assert.equal(payload.removed, 1);
    assert.equal(payload.unchanged, 3);
    assert.deepEqual(payload.hunks, [{ beforeStart: 2, beforeLines: 1, afterStart: 2, afterLines: 2 }]);
    assert.equal(payload.lines, 5);
});

test("diff_write lines: applies two unsorted changes correctly", (): void => {
    const firstWriter: RecordedWriter = recordingWriter();
    const firstHost: WorkspaceAgentService = serviceOf({ writer: firstWriter.writer });
    const firstContext: string = materializedContext(firstHost, [TargetLines]);
    const firstPayload: DiffWritePayload = diffWriteOf(firstHost, {
        contextId: firstContext,
        nodeId: TargetLines,
        changes: [lineChange(4, 4, "DELTA"), lineChange(1, 1, "ALPHA")],
        contextLines: 0,
    });
    const secondWriter: RecordedWriter = recordingWriter();
    const secondHost: WorkspaceAgentService = serviceOf({ writer: secondWriter.writer });
    const secondContext: string = materializedContext(secondHost, [TargetLines]);
    const secondPayload: DiffWritePayload = diffWriteOf(secondHost, {
        contextId: secondContext,
        nodeId: TargetLines,
        changes: [lineChange(1, 1, "ALPHA"), lineChange(4, 4, "DELTA")],
        contextLines: 0,
    });
    assert.equal(firstWriter.requests[0].content, "ALPHA\nbeta\ngamma\nDELTA\n");
    assert.equal(secondWriter.requests[0].content, firstWriter.requests[0].content);
    assert.equal(firstPayload.added, 2);
    assert.equal(secondPayload.added, 2);
    assert.equal(firstPayload.removed, 2);
    assert.equal(secondPayload.removed, 2);
    assert.equal(firstPayload.unchanged, 2);
    assert.deepEqual(firstPayload.hunks, secondPayload.hunks);
});

test("diff_write lines: overlapping ranges are rejected as invalid_arguments", (): void => {
    const first: RecordedWriter = recordingWriter();
    const firstHost: WorkspaceAgentService = serviceOf({ writer: first.writer });
    const firstContext: string = materializedContext(firstHost, [TargetLines], "f.overlap.first");
    assert.equal(
        code(
            call(firstHost, ToolIds.workspaceDiffWrite, {
                contextId: firstContext,
                nodeId: TargetLines,
                changes: [lineChange(3, 3, "A"), lineChange(3, 4, "B")],
            }),
        ),
        "invalid_arguments",
    );
    const second: RecordedWriter = recordingWriter();
    const secondHost: WorkspaceAgentService = serviceOf({ writer: second.writer });
    const secondContext: string = materializedContext(secondHost, [TargetLines], "f.overlap.second");
    assert.equal(
        code(
            call(secondHost, ToolIds.workspaceDiffWrite, {
                contextId: secondContext,
                nodeId: TargetLines,
                changes: [lineChange(3, 4, "B"), lineChange(3, 3, "A")],
            }),
        ),
        "invalid_arguments",
    );
    const nested: RecordedWriter = recordingWriter();
    const nestedHost: WorkspaceAgentService = serviceOf({ writer: nested.writer });
    const nestedContext: string = materializedContext(nestedHost, [TargetLines], "f.overlap.nested");
    assert.equal(
        code(
            call(nestedHost, ToolIds.workspaceDiffWrite, {
                contextId: nestedContext,
                nodeId: TargetLines,
                changes: [lineChange(2, 3, "X"), lineChange(3, 4, "Y")],
            }),
        ),
        "invalid_arguments",
    );
    assert.deepEqual([first.requests.length, second.requests.length, nested.requests.length], [0, 0, 0]);
    /**
     * Adjacent ranges do not intersect, so the batch stays legal and applies
     * bottom-up.
     */
    const adjacent: RecordedWriter = recordingWriter();
    const adjacentHost: WorkspaceAgentService = serviceOf({ writer: adjacent.writer });
    const adjacentContext: string = materializedContext(adjacentHost, [TargetLines], "f.overlap.adjacent");
    const payload: DiffWritePayload = diffWriteOf(adjacentHost, {
        contextId: adjacentContext,
        nodeId: TargetLines,
        changes: [lineChange(2, 2, "B"), lineChange(3, 3, "C")],
    });
    assert.equal(adjacent.requests.length, 1);
    assert.equal(adjacent.requests[0].content, "alpha\nB\nC\ndelta\n");
    assert.equal(payload.lines, 4);
    expectDiffCode((): string => applyLineChanges(ContentLines, [lineChange(3, 3, "A"), lineChange(3, 4, "B")]), "invalid_arguments");
    /**
     * Byte ranges use the same fail-closed rule: overlapping ranges and two
     * insertions at the same offset have no order-independent meaning.
     */
    expectDiffCode((): string => applyByteChanges("abcdef\n", [byteChange(1, 3, "x"), byteChange(2, 4, "y")]), "invalid_arguments");
    expectDiffCode((): string => applyByteChanges("abcdef\n", [byteChange(2, 2, "x"), byteChange(2, 2, "y")]), "invalid_arguments");
    assert.equal(applyByteChanges("abcdef\n", [byteChange(1, 3, "x"), byteChange(4, 6, "y")]), "axdy\n");
});

test("diff_write lines: startLine 0 is invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetLines, changes: [lineChange(0, 1, "x")] })),
        "invalid_arguments",
    );
    assert.equal(recorded.requests.length, 0);
});

test("diff_write lines: endLine below startLine is invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetLines, changes: [lineChange(3, 2, "x")] })),
        "invalid_arguments",
    );
    assert.equal(recorded.requests.length, 0);
});

test("diff_write lines: startLine beyond EOF is invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetLines, changes: [lineChange(5, 5, "x")] })),
        "invalid_arguments",
    );
    assert.equal(recorded.requests.length, 0);
});

test("diff_write lines: endLine beyond EOF is invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetLines, changes: [lineChange(1, 5, "x")] })),
        "invalid_arguments",
    );
    assert.equal(recorded.requests.length, 0);
});

test("diff_write lines: CRLF terminators are preserved", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetCrlf]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetCrlf, changes: [lineChange(2, 2, "SECOND")], contextLines: 0 });
    assert.equal(recorded.requests[0].content, "first line\r\nSECOND\r\n");
    assert.equal(payload.bytes, 20);
    assert.equal(payload.lines, 2);
    assert.equal(payload.added, 1);
    assert.equal(payload.removed, 1);
    assert.equal(payload.unchanged, 1);
});

test("diff_write lines: edits a file with no trailing newline", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetNoEol]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetNoEol, changes: [lineChange(1, 1, "ONE")] });
    assert.equal(recorded.requests[0].content, "ONE\ntwo");
    assert.equal(payload.bytes, 7);
    assert.equal(payload.lines, 2);
});

test("diff_write lines: a change at EOF can add a new line", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetNoEol]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetNoEol, changes: [lineChange(2, 2, "two\nthree")] });
    assert.equal(recorded.requests[0].content, "one\ntwo\nthree");
    assert.equal(payload.lines, 3);
    assert.equal(payload.added, 1);
    assert.equal(payload.removed, 0);
    assert.equal(payload.unchanged, 2);
});

test("diff_write bytes: inserts at offset 0 and at EOF", (): void => {
    const startWriter: RecordedWriter = recordingWriter();
    const startHost: WorkspaceAgentService = serviceOf({ writer: startWriter.writer });
    const startContext: string = materializedContext(startHost, [TargetCapacity], "f.insert.start");
    const startPayload: DiffWritePayload = writeWithStrategy(startHost, TargetCapacity, startContext, { byteChanges: [byteChange(0, 0, "X")] }, "bytes");
    assert.equal(startWriter.requests[0].content, "X012345678\nabcdef");
    assert.equal(startPayload.bytes, 17);
    assert.equal(startPayload.lines, 2);
    const endWriter: RecordedWriter = recordingWriter();
    const endHost: WorkspaceAgentService = serviceOf({ writer: endWriter.writer });
    const endContext: string = materializedContext(endHost, [TargetCapacity], "f.insert.end");
    const endPayload: DiffWritePayload = diffWriteOf(endHost, { contextId: endContext, nodeId: TargetCapacity, byteChanges: [byteChange(16, 16, "Z")] });
    assert.equal(endWriter.requests[0].content, "012345678\nabcdefZ");
    assert.equal(endPayload.bytes, 17);
    assert.equal(endPayload.lines, 2);
});

test("diff_write bytes: deletes every byte", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetCapacity]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetCapacity, byteChanges: [byteChange(0, 16, "")] });
    assert.equal(recorded.requests[0].content, "");
    assert.equal(payload.bytes, 0);
    assert.equal(payload.lines, 0);
    assert.equal(payload.added, 0);
    assert.equal(payload.removed, 2);
    assert.deepEqual(payload.hunks, [{ beforeStart: 1, beforeLines: 2, afterStart: 1, afterLines: 0 }]);
});

test("diff_write bytes: replaces a whole multi-byte character", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetUnicode]);
    assert.equal(new TextEncoder().encode(ContentUnicode).length, 6);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetUnicode, byteChanges: [byteChange(3, 5, "e")], contextLines: 0 });
    assert.equal(recorded.requests[0].content, "cafe\n");
    assert.equal(payload.bytes, 5);
    assert.equal(payload.lines, 1);
    assert.equal(payload.added, 1);
    assert.equal(payload.removed, 1);
    assert.equal(payload.unchanged, 0);
});

test("diff_write bytes: an offset inside a multi-byte character is invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetUnicode]);
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetUnicode, byteChanges: [byteChange(4, 5, "e")] })),
        "invalid_arguments",
    );
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetUnicode, byteChanges: [byteChange(3, 4, "e")] })),
        "invalid_arguments",
    );
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetUnicode, byteChanges: [byteChange(0, 4, "e")] })),
        "invalid_arguments",
    );
    assert.equal(recorded.requests.length, 0);
});

test("diff_write bytes: endBytes beyond the buffer is invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetUnicode]);
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetUnicode, byteChanges: [byteChange(0, 7, "x")] })),
        "invalid_arguments",
    );
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetUnicode, byteChanges: [byteChange(5, 7, "")] })),
        "invalid_arguments",
    );
    assert.equal(recorded.requests.length, 0);
});

test("diff_write bytes: negative offsets are invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetUnicode]);
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetUnicode, byteChanges: [byteChange(-1, 2, "x")] })),
        "invalid_arguments",
    );
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetUnicode, byteChanges: [byteChange(0, -1, "x")] })),
        "invalid_arguments",
    );
    assert.equal(recorded.requests.length, 0);
});

test("diff_write bytes: applies two unsorted changes correctly", (): void => {
    const firstWriter: RecordedWriter = recordingWriter();
    const firstHost: WorkspaceAgentService = serviceOf({ writer: firstWriter.writer });
    const firstContext: string = materializedContext(firstHost, [TargetCapacity], "f.bytes.first");
    diffWriteOf(firstHost, { contextId: firstContext, nodeId: TargetCapacity, byteChanges: [byteChange(11, 12, "F"), byteChange(1, 2, "B")] });
    const secondWriter: RecordedWriter = recordingWriter();
    const secondHost: WorkspaceAgentService = serviceOf({ writer: secondWriter.writer });
    const secondContext: string = materializedContext(secondHost, [TargetCapacity], "f.bytes.second");
    const secondPayload: DiffWritePayload = diffWriteOf(secondHost, {
        contextId: secondContext,
        nodeId: TargetCapacity,
        byteChanges: [byteChange(1, 2, "B"), byteChange(11, 12, "F")],
        contextLines: 0,
    });
    assert.equal(firstWriter.requests[0].content, "0B2345678\naFcdef");
    assert.equal(secondWriter.requests[0].content, firstWriter.requests[0].content);
    assert.equal(secondPayload.added, 2);
    assert.equal(secondPayload.removed, 2);
    assert.equal(secondPayload.unchanged, 0);
});

test("diff_write bytes: boundary-aligned splices stay valid UTF-8, invalid_arguments if fatal decoding ever fails", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetUnicode]);
    const probes: ByteChange[][] = [
        [byteChange(0, 0, "\u00e9")],
        [byteChange(6, 6, "!")],
        [byteChange(3, 5, "\ud834\udd1e")],
        [byteChange(0, 6, "\u00f8")],
        [byteChange(0, 3, "")],
        [byteChange(3, 5, "")],
        [byteChange(0, 3, "\u4e2d")],
    ];
    probes.forEach((probe: ByteChange[], index: number): void => {
        const response: WorkspaceResponse = call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetUnicode, byteChanges: probe, dryRun: true });
        if (response.ok) {
            const payload: DiffWritePayload = response.data as unknown as DiffWritePayload;
            assert.equal(payload.dryRun, true);
            assert.equal(payload.revision, null);
        } else {
            assert.equal(code(response), "invalid_arguments", `probe ${index} must only fail as invalid_arguments`);
        }
    });
    assert.equal(recorded.requests.length, 0);
    const real: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetUnicode, byteChanges: [byteChange(3, 5, "e")] });
    const written: string = recorded.requests[0].content;
    assert.equal(written, "cafe\n");
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(written)), written);
    assert.equal(real.bytes, 5);
});

test("diff_write capacity: a long whole content is capacity_exceeded", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer, limits: { maxWriteChars: 16 } });
    const contextId: string = materializedContext(host, [TargetCapacity]);
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetCapacity, content: "x".repeat(17) })), "capacity_exceeded");
    assert.equal(recorded.requests.length, 0);
});

test("diff_write capacity: a batch assembling beyond maxWriteChars is capacity_exceeded", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer, limits: { maxWriteChars: 16 } });
    const contextId: string = materializedContext(host, [TargetCapacity]);
    const changes: LineChange[] = [lineChange(1, 1, "012345678X"), lineChange(2, 2, "abcdefY")];
    assert.equal(changes[0].content.length, 10);
    assert.equal(changes[1].content.length, 7);
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetCapacity, changes })), "capacity_exceeded");
    assert.equal(recorded.requests.length, 0);
    const byteChanges: ByteChange[] = [byteChange(0, 0, "0123456789"), byteChange(16, 16, "abcdefg")];
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetCapacity, byteChanges })), "capacity_exceeded");
    assert.equal(recorded.requests.length, 0);
});

test("diff_write capacity: an exactly maxWriteChars result is accepted", (): void => {
    const wholeWriter: RecordedWriter = recordingWriter();
    const wholeHost: WorkspaceAgentService = serviceOf({ writer: wholeWriter.writer, limits: { maxWriteChars: 16 } });
    const wholeContext: string = materializedContext(wholeHost, [TargetCapacity], "f.capacity.whole");
    const wholePayload: DiffWritePayload = diffWriteOf(wholeHost, { contextId: wholeContext, nodeId: TargetCapacity, content: "0123456789abcdef" });
    assert.equal(wholePayload.revision, "rev.1");
    assert.equal(wholePayload.bytes, 16);
    assert.equal(wholeWriter.requests[0].content, "0123456789abcdef");
    const spliceWriter: RecordedWriter = recordingWriter();
    const spliceHost: WorkspaceAgentService = serviceOf({ writer: spliceWriter.writer, limits: { maxWriteChars: 16 } });
    const spliceContext: string = materializedContext(spliceHost, [TargetCapacity], "f.capacity.splice");
    const splicePayload: DiffWritePayload = diffWriteOf(spliceHost, {
        contextId: spliceContext,
        nodeId: TargetCapacity,
        changes: [lineChange(1, 1, "ABCDEFGHI")],
    });
    assert.equal(spliceWriter.requests[0].content, "ABCDEFGHI\nabcdef");
    assert.equal(splicePayload.bytes, 16);
    assert.equal(splicePayload.revision, "rev.1");
});

test("diff_write auth: an unallocated target is not_available", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetC]);
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, content: "x" })), "not_available");
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId: "ctx.missing", nodeId: TargetA, content: "x" })), "not_available");
    assert.equal(recorded.requests.length, 0);
});

test("diff_write auth: a symbol target is invalid_arguments", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const symbolId: string = symbolOf("xxx");
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [symbolId]);
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: symbolId, content: "x" })), "invalid_arguments");
    assert.equal(recorded.requests.length, 0);
});

test("diff_write CAS: a stale expectRevision is fingerprint_mismatch", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, content: "x", expectRevision: "rev.stale" })),
        "fingerprint_mismatch",
    );
    assert.equal(recorded.requests.length, 0);
    const first: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetA, content: ContentC, expectRevision: snapshotRevisionOf(TargetA) });
    assert.equal(first.revision, "rev.1");
    assert.equal(
        code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, content: "y", expectRevision: snapshotRevisionOf(TargetA) })),
        "fingerprint_mismatch",
    );
    const second: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetA, content: ContentD, expectRevision: "rev.1" });
    assert.equal(second.previousRevision, "rev.1");
    assert.equal(second.revision, "rev.2");
    assert.equal(recorded.requests.length, 2);
});

test("diff_write dryRun: returns revision null and never calls the writer", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetA, content: ContentC, dryRun: true });
    assert.equal(payload.dryRun, true);
    assert.equal(payload.revision, null);
    assert.equal(payload.previousRevision, snapshotRevisionOf(TargetA));
    assert.equal(payload.bytes, new TextEncoder().encode(ContentC).length);
    assert.equal(payload.lines, 1);
    assert.equal(recorded.requests.length, 0);
    const reread: Record<string, unknown> = data(call(host, ToolIds.workspaceRead, { contextId, nodeId: TargetA }));
    assert.equal(reread.text, ContentA);
});

test("diff_write dryRun: works without a writer while a real write is write_unavailable", (): void => {
    const host: WorkspaceAgentService = serviceOf();
    const contextId: string = materializedContext(host, [TargetA]);
    const preview: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetA, content: "preview\n", dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.revision, null);
    assert.equal(preview.bytes, 8);
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, content: "preview\n" })), "write_unavailable");
    const reread: Record<string, unknown> = data(call(host, ToolIds.workspaceRead, { contextId, nodeId: TargetA }));
    assert.equal(reread.text, ContentA);
});

test("diff_write: a writer refusal propagates its code", (): void => {
    const recorded: RecordedWriter = refusingWriter("fingerprint_mismatch");
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, content: ContentC })), "fingerprint_mismatch");
    assert.equal(recorded.requests.length, 1);
});

test("diff_write: an empty writer revision is internal_error", (): void => {
    const recorded: RecordedWriter = blankRevisionWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    assert.equal(code(call(host, ToolIds.workspaceDiffWrite, { contextId, nodeId: TargetA, content: ContentC })), "internal_error");
    assert.equal(recorded.requests.length, 1);
    const reread: Record<string, unknown> = data(call(host, ToolIds.workspaceRead, { contextId, nodeId: TargetA }));
    assert.equal(reread.text, ContentA);
});

test("diff_write: success persists and a following read sees the new text", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetA, content: ContentC });
    assert.equal(payload.revision, "rev.1");
    assert.equal(payload.nodeId, TargetA);
    assert.equal(payload.path, "a.ts");
    assert.equal(recorded.requests[0].nodeId, TargetA);
    assert.equal(recorded.requests[0].uri, "a.ts");
    const reread: Record<string, unknown> = data(call(host, ToolIds.workspaceRead, { contextId, nodeId: TargetA }));
    assert.equal(reread.text, ContentC);
    assert.equal((reread.source as { revision: string; }).revision, "rev.1");
});

test("diff_write: the reply carries exportation and importation", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetA, content: ContentA });
    assert.ok(payload.exportation);
    assert.ok(payload.importation);
    assert.equal(payload.exportation.path, "a.ts");
    assert.equal(payload.importation.path, "a.ts");
    assert.ok(Array.isArray(payload.exportation.files));
    assert.ok(Array.isArray(payload.importation.files));
    assert.ok(Array.isArray(payload.importation.external));
    assert.equal(payload.exportation.truncated, false);
    assert.equal(payload.importation.truncated, false);
    assert.equal(payload.exportation.total, 1);
    assert.equal(payload.importation.total, 1);
});

test("diff_write: hunk coordinates are 1-based", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetA]);
    const payload: DiffWritePayload = diffWriteOf(host, {
        contextId,
        nodeId: TargetA,
        changes: [lineChange(2, 2, "export const xxx = 9;")],
        contextLines: 0,
    });
    assert.deepEqual(payload.hunks, [{ beforeStart: 2, beforeLines: 1, afterStart: 2, afterLines: 1 }]);
    assert.equal(payload.hunks[0].beforeStart, 2);
    assert.equal(payload.hunks[0].afterStart, 2);
});

test("diff_write: input over 5000 lines changed at the end reports diffTruncated", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetBig]);
    assert.equal(ContentBig.split("\n").length, 5002);
    const payload: DiffWritePayload = diffWriteOf(host, { contextId, nodeId: TargetBig, content: ContentBigChanged });
    assert.equal(payload.diffTruncated, true);
    assert.equal(payload.added, 0);
    assert.equal(payload.removed, 0);
    assert.equal(payload.unchanged, 5000);
    assert.deepEqual(payload.hunks, []);
    assert.equal(payload.lines, 5001);
    assert.equal(payload.bytes, new TextEncoder().encode(ContentBigChanged).length);
    assert.equal(recorded.requests[0].content, ContentBigChanged);
});

test("diff_write: contextLines 0 and 20 are accepted, 21 is invalid_arguments", (): void => {
    const zeroWriter: RecordedWriter = recordingWriter();
    const zeroHost: WorkspaceAgentService = serviceOf({ writer: zeroWriter.writer });
    const zeroContext: string = materializedContext(zeroHost, [TargetLines], "f.context.zero");
    const zeroPayload: DiffWritePayload = diffWriteOf(zeroHost, {
        contextId: zeroContext,
        nodeId: TargetLines,
        changes: [lineChange(2, 2, "BETA")],
        contextLines: 0,
    });
    assert.deepEqual(zeroPayload.hunks, [{ beforeStart: 2, beforeLines: 1, afterStart: 2, afterLines: 1 }]);
    const wideWriter: RecordedWriter = recordingWriter();
    const wideHost: WorkspaceAgentService = serviceOf({ writer: wideWriter.writer });
    const wideContext: string = materializedContext(wideHost, [TargetLines], "f.context.wide");
    const widePayload: DiffWritePayload = diffWriteOf(wideHost, {
        contextId: wideContext,
        nodeId: TargetLines,
        changes: [lineChange(2, 2, "BETA")],
        contextLines: 20,
    });
    assert.deepEqual(widePayload.hunks, [{ beforeStart: 1, beforeLines: 4, afterStart: 1, afterLines: 4 }]);
    const rejectWriter: RecordedWriter = recordingWriter();
    const rejectHost: WorkspaceAgentService = serviceOf({ writer: rejectWriter.writer });
    const rejectContext: string = materializedContext(rejectHost, [TargetLines], "f.context.reject");
    assert.equal(
        code(
            call(rejectHost, ToolIds.workspaceDiffWrite, {
                contextId: rejectContext,
                nodeId: TargetLines,
                changes: [lineChange(2, 2, "BETA")],
                contextLines: 21,
            }),
        ),
        "invalid_arguments",
    );
    assert.equal(rejectWriter.requests.length, 0);
});

test("applyLineChanges: invalid ranges throw invalid_arguments", (): void => {
    expectDiffCode((): string => applyLineChanges("alpha\nbeta\n", [lineChange(0, 1, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyLineChanges("alpha\nbeta\n", [lineChange(2, 1, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyLineChanges("alpha\nbeta\n", [lineChange(1, 3, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyLineChanges("", [lineChange(1, 1, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyLineChanges("alpha\n", [lineChange(1.5, 1.5, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyLineChanges("alpha\nbeta\n", [lineChange(3, 3, "x")]), "invalid_arguments");
});

test("applyByteChanges: invalid ranges throw invalid_arguments", (): void => {
    expectDiffCode((): string => applyByteChanges("abc", [byteChange(-1, 2, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyByteChanges("abc", [byteChange(0, -1, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyByteChanges("abc", [byteChange(0, 4, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyByteChanges("abc", [byteChange(2, 1, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyByteChanges("abc", [byteChange(1.5, 2, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyByteChanges("a\u4e2db", [byteChange(2, 4, "x")]), "invalid_arguments");
    expectDiffCode((): string => applyByteChanges("a\u4e2db", [byteChange(0, 2, "x")]), "invalid_arguments");
});

test("applyLineChanges and applyByteChanges: maxChars overflow throws capacity_exceeded", (): void => {
    expectDiffCode((): string => applyLineChanges("abc\ndef\n", [lineChange(1, 1, "abcdef")], 5), "capacity_exceeded");
    expectDiffCode((): string => applyLineChanges("abc\ndef\n", [lineChange(1, 1, "abcdef"), lineChange(2, 2, "ghi")], 5), "capacity_exceeded");
    expectDiffCode((): string => applyByteChanges("abc", [byteChange(3, 3, "de")], 4), "capacity_exceeded");
    expectDiffCode((): string => applyByteChanges("abc", [byteChange(0, 0, "x"), byteChange(3, 3, "yz")], 5), "capacity_exceeded");
    assert.equal(applyLineChanges("a\n", [lineChange(1, 1, "abc")], 4), "abc\n");
    assert.equal(applyByteChanges("abc", [byteChange(3, 3, "d")], 4), "abcd");
    assert.equal(applyLineChanges("a\n", [lineChange(1, 1, "abc")], 5), "abc\n");
});

test("summarizeDiff: counts match the diff_write reply", (): void => {
    const recorded: RecordedWriter = recordingWriter();
    const host: WorkspaceAgentService = serviceOf({ writer: recorded.writer });
    const contextId: string = materializedContext(host, [TargetLines]);
    const next: string = "ALPHA\nbeta\ndelta\n";
    const payload: DiffWritePayload = diffWriteOf(host, {
        contextId,
        nodeId: TargetLines,
        changes: [lineChange(1, 1, "ALPHA"), lineChange(3, 3, "")],
        contextLines: 0,
    });
    const expected: DiffSummary = summarizeDiff("lines.txt", ContentLines, next, 0);
    assert.equal(recorded.requests[0].content, next);
    assert.equal(payload.added, expected.added);
    assert.equal(payload.removed, expected.removed);
    assert.equal(payload.unchanged, expected.unchanged);
    assert.equal(payload.diffTruncated, expected.truncated);
    assert.deepEqual(payload.hunks, expected.hunks);
    assert.equal(payload.added, 1);
    assert.equal(payload.removed, 2);
    assert.equal(payload.unchanged, 2);
    assert.deepEqual(payload.hunks, [
        { beforeStart: 1, beforeLines: 1, afterStart: 1, afterLines: 1 },
        { beforeStart: 3, beforeLines: 1, afterStart: 3, afterLines: 0 },
    ]);
});
