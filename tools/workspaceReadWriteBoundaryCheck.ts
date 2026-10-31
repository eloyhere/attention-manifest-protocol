#!/usr/bin/env node
/**
 * Boundary matrix for the two oldest workspace detail tools.
 *
 * `workspaceAgentCheck.ts` covers the happy path of `amp_tool_workspace_read`
 * and `amp_tool_workspace_write` end to end. This check stays on their edges:
 * exactly-at-limit offsets, one-past-limit arguments, UTF-8 snapping, terminator
 * shapes, allocation/release authority, impact truncation, write addressing
 * modes, capacity and host-writer failures. Every assertion names the concrete
 * wire value the contract promises; comments record the few places where the
 * implementation answers something else.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceServiceLimits, WorkspaceWriteRequest, WorkspaceWriter } from "../src/context/workspaceService.ts";
import type { Frame } from "../src/frame/frame.ts";
import type { WorkspaceResponse } from "../src/protocol/workspace.ts";
import { scanStructuredWorkspace } from "./support/documentScanner.ts";

/**
 * One snapshot holds every fixture: the import graph, the encoding shapes and
 * the empty/terminator variants. Fixtures are immutable; each test builds its
 * own service, writer and Frame so budget and allocation state never leak.
 */
const Store: MemoryContentStore = new MemoryContentStore();
const ContentC: string = "export const xx = 1;\n";
const ContentA: string = 'import { xx } from "./c.ts";\nexport const xxx = xx;\n';
const ContentB: string = 'import { xxx } from "./a.ts";\nexport const yyy = xxx;\n';
const ContentD: string = 'import { xxx } from "./a.ts";\nconsole.log(xxx);\n';
const ContentE: string = 'import { xxx } from "./a.ts";\nimport "node:fs";\nimport "./missing.ts";\n';
const ContentDup: string = 'import { xx } from "./c.ts";\nimport { xx as yy } from "./c.ts";\nconsole.log(yy);\n';
const ContentExt: string = 'import "node:fs";\nimport "node:path";\nimport "node:os";\n';
const ContentSolo: string = "export const solo = 1;\n";
const ContentMutable: string = "abcdef\n";
const ContentLines: string = "one\ntwo\nthree\nfour\nfive\n";
const ContentCrlf: string = "a\r\nb\r\nc\r\n";
const ContentNoEol: string = "alpha\nbeta";
const ContentOnlyNewline: string = "\n";
const ContentEmpty: string = "";
const ContentUnicode: string = "h\u00e9llo\nw\u00f6rld\n";
const ContentEmoji: string = "\u{1F600}z\n";
const ContentLong: string = `${"x".repeat(200)}\n`;
const ContentGuide: string = "# Guide\nBODY\n";
const Snapshot: WorkspaceSnapshot = scanStructuredWorkspace(
    [
        { path: "package.json", content: '{"name":"boundary"}' },
        { path: "c.ts", content: ContentC },
        { path: "a.ts", content: ContentA },
        { path: "b.ts", content: ContentB },
        { path: "d.ts", content: ContentD },
        { path: "e.ts", content: ContentE },
        { path: "dup.ts", content: ContentDup },
        { path: "ext.ts", content: ContentExt },
        { path: "solo.ts", content: ContentSolo },
        { path: "mutable.ts", content: ContentMutable },
        { path: "lines.ts", content: ContentLines },
        { path: "crlf.ts", content: ContentCrlf },
        { path: "noeol.ts", content: ContentNoEol },
        { path: "onlynewline.ts", content: ContentOnlyNewline },
        { path: "empty.ts", content: ContentEmpty },
        { path: "unicode.ts", content: ContentUnicode },
        { path: "emoji.ts", content: ContentEmoji },
        { path: "long.ts", content: ContentLong },
        { path: "guide.md", content: ContentGuide },
        { path: "nested/x.ts", content: "export const nested = 1;\n" },
    ],
    Store,
);
const Revision: string = Snapshot.revision;
const FileA: string = "file:a.ts";
const FileB: string = "file:b.ts";
const FileC: string = "file:c.ts";
const FileD: string = "file:d.ts";
const FileE: string = "file:e.ts";
const FileDup: string = "file:dup.ts";
const FileExt: string = "file:ext.ts";
const FileSolo: string = "file:solo.ts";
const FileMutable: string = "file:mutable.ts";
const FileLines: string = "file:lines.ts";
const FileCrlf: string = "file:crlf.ts";
const FileNoEol: string = "file:noeol.ts";
const FileOnlyNewline: string = "file:onlynewline.ts";
const FileEmpty: string = "file:empty.ts";
const FileUnicode: string = "file:unicode.ts";
const FileEmoji: string = "file:emoji.ts";
const FileLong: string = "file:long.ts";
const FileGuide: string = "file:guide.md";
const Project: string = "project:.";
const Directory: string = "directory:nested";

const entityOf: (kind: string, predicate: (entity: WorkspaceEntity) => boolean, label: string) => string = (
    kind: string,
    predicate: (entity: WorkspaceEntity) => boolean,
    label: string,
): string => {
    const found: WorkspaceEntity | undefined = Snapshot.entities.find(
        (entity: WorkspaceEntity): boolean => entity.kind === kind && predicate(entity),
    );
    assert.ok(found, `${kind} ${label} must exist`);
    return found!.id;
};
const SymbolXxx: string = entityOf("symbol", (entity: WorkspaceEntity): boolean => entity.label === "xxx", "xxx");
const KnowledgeGuide: string = entityOf(
    "knowledge",
    (entity: WorkspaceEntity): boolean => entity.source.uri === "guide.md",
    "guide.md section",
);
const PackageFs: string = entityOf("package", (entity: WorkspaceEntity): boolean => entity.label === "node:fs", "node:fs");

const frame: (id: string, ids: string[], tokens?: number) => Frame = (id: string, ids: string[], tokens: number = 8000): Frame => ({
    amp: "0.1",
    kind: "frame",
    id,
    agent: "a.test",
    cycle: 0,
    ts: "2026-10-29T00:00:00Z",
    digest: "0".repeat(64),
    mode: "explore",
    slots: ids.map((nodeId: string): Frame["slots"][number] => ({
        target: { kind: "other", id: nodeId },
        role: "artifact",
        salience: 1,
        cost: {},
        why: "host selected this target",
        state: "active",
    })),
    budget: { allocated: { tokens }, spent: {} },
});

interface ServiceOptions {
    writer?: WorkspaceWriter;
    limits?: Partial<WorkspaceServiceLimits>;
}
const service: (options?: ServiceOptions) => WorkspaceAgentService = (options: ServiceOptions = {}): WorkspaceAgentService =>
    new WorkspaceAgentService({
        agentId: "a.test",
        projectIds: ["project:."],
        snapshot: Snapshot,
        store: Store,
        ...options,
    });
const call: (host: WorkspaceAgentService, operation: string, args?: Record<string, unknown>) => WorkspaceResponse = (
    host: WorkspaceAgentService,
    operation: string,
    args: Record<string, unknown> = {},
): WorkspaceResponse => host.call(`amp_tool_workspace_${operation}`, { revision: Revision, ...args });
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
const materialize: (host: WorkspaceAgentService, frameId: string, budgetTokens?: number) => Record<string, unknown> = (
    host: WorkspaceAgentService,
    frameId: string,
    budgetTokens: number = 8000,
): Record<string, unknown> => data(call(host, "materialize", { frameId, budgetTokens }));
const readOf: (
    host: WorkspaceAgentService,
    contextId: string,
    nodeId: string,
    args?: Record<string, unknown>,
) => WorkspaceResponse = (
    host: WorkspaceAgentService,
    contextId: string,
    nodeId: string,
    args: Record<string, unknown> = {},
): WorkspaceResponse => call(host, "read", { contextId, nodeId, ...args });
const writeOf: (
    host: WorkspaceAgentService,
    contextId: string,
    nodeId: string,
    args: Record<string, unknown>,
) => WorkspaceResponse = (
    host: WorkspaceAgentService,
    contextId: string,
    nodeId: string,
    args: Record<string, unknown>,
): WorkspaceResponse => call(host, "write", { contextId, nodeId, ...args });

interface Ready {
    host: WorkspaceAgentService;
    view: Record<string, unknown>;
    contextId: string;
}
const ready: (ids: string[], options?: ServiceOptions, budgetTokens?: number) => Ready = (
    ids: string[],
    options: ServiceOptions = {},
    budgetTokens: number = 8000,
): Ready => {
    const host: WorkspaceAgentService = service(options);
    host.registerFrame(frame("f.ready", ids, budgetTokens), Revision);
    const view: Record<string, unknown> = materialize(host, "f.ready", budgetTokens);
    return { host, view, contextId: view.contextId as string };
};

interface WriteRecord {
    agentId: string;
    nodeId: string;
    uri: string;
    content: string;
    previousRevision: string;
}
const writerOf: (records: WriteRecord[]) => WorkspaceWriter = (records: WriteRecord[]): WorkspaceWriter => ({
    write: (request: WorkspaceWriteRequest): { ok: true; revision: string; bytes: number; } => {
        records.push({
            agentId: request.agentId,
            nodeId: request.nodeId,
            uri: request.uri,
            content: request.content,
            previousRevision: request.previousRevision,
        });
        return { ok: true, revision: `rev.${records.length}`, bytes: new TextEncoder().encode(request.content).length };
    },
});
const byteLength: (text: string) => number = (text: string): number => new TextEncoder().encode(text).length;
const textOfPage: (page: Record<string, unknown>) => string = (page: Record<string, unknown>): string => {
    assert.equal(typeof(page.text), "string");
    return page.text as string;
};
const sourceRevision: (page: Record<string, unknown>) => string = (page: Record<string, unknown>): string =>
    (page.source as { revision: string; }).revision;
const sourceUri: (page: Record<string, unknown>) => string = (page: Record<string, unknown>): string =>
    (page.source as { uri: string; }).uri;

test("character pages accept offsets zero through totalChars, reject one past the end and concatenate", (): void => {
    const { host, view, contextId }: Ready = ready([FileLines]);
    const initial: number = view.remainingTokens as number;
    const single: Record<string, unknown> = data(readOf(host, contextId, FileLines, { maxChars: 1 }));
    assert.equal(single.text, "o");
    assert.equal(single.offset, 0);
    assert.equal(single.nextOffset, 1);
    assert.equal(single.totalChars, ContentLines.length);
    assert.equal(single.tokens, 1);
    assert.equal(single.remainingTokens, initial - 1);
    const maximal: Record<string, unknown> = data(readOf(host, contextId, FileLines, { maxChars: 16000 }));
    assert.equal(maximal.text, ContentLines);
    assert.equal(maximal.offset, 0);
    assert.equal(maximal.nextOffset, null);
    assert.equal(maximal.tokens, Math.ceil(ContentLines.length / 4));
    const atEnd: Record<string, unknown> = data(readOf(host, contextId, FileLines, { offset: ContentLines.length }));
    assert.equal(atEnd.text, "");
    assert.equal(atEnd.offset, ContentLines.length);
    assert.equal(atEnd.nextOffset, null);
    assert.equal(atEnd.tokens, 0);
    assert.equal(atEnd.remainingTokens, maximal.remainingTokens);
    assert.equal(code(readOf(host, contextId, FileLines, { offset: ContentLines.length + 1 })), "invalid_arguments");
    assert.equal(code(readOf(host, contextId, FileLines, { maxChars: 0 })), "invalid_arguments");
    assert.equal(code(readOf(host, contextId, FileLines, { maxChars: 16001 })), "invalid_arguments");
    const exact: Record<string, unknown> = data(readOf(host, contextId, FileLines, { offset: 4, maxChars: 20 }));
    assert.equal(exact.text, ContentLines.slice(4));
    assert.equal(exact.nextOffset, null);
    assert.equal(exact.tokens, 5);
    const first: Record<string, unknown> = data(readOf(host, contextId, FileLines, { offset: 0, maxChars: 10 }));
    const second: Record<string, unknown> = data(readOf(host, contextId, FileLines, { offset: 10, maxChars: 10 }));
    const third: Record<string, unknown> = data(readOf(host, contextId, FileLines, { offset: 20, maxChars: 10 }));
    assert.equal(first.text, ContentLines.slice(0, 10));
    assert.equal(first.nextOffset, 10);
    assert.equal(second.text, ContentLines.slice(10, 20));
    assert.equal(second.nextOffset, 20);
    assert.equal(third.text, ContentLines.slice(20));
    assert.equal(third.nextOffset, null);
    assert.equal(`${first.text}${second.text}${third.text}`, ContentLines);
});

test("line pages are 1-based, bounded and allow exactly the one-past-end empty page", (): void => {
    const { host, contextId }: Ready = ready([FileLines]);
    const first: Record<string, unknown> = data(readOf(host, contextId, FileLines, { startLine: 1, maxLines: 1 }));
    assert.equal(first.text, "one\n");
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 4);
    assert.equal(first.startLine, 1);
    assert.equal(first.endLine, 1);
    assert.equal(first.nextStartLine, 2);
    assert.equal(first.totalLines, 5);
    const last: Record<string, unknown> = data(readOf(host, contextId, FileLines, { startLine: 5, maxLines: 1 }));
    assert.equal(last.text, "five\n");
    assert.equal(last.offset, 19);
    assert.equal(last.endLine, 5);
    assert.equal(last.nextStartLine, null);
    assert.equal(last.nextOffset, null);
    const past: Record<string, unknown> = data(readOf(host, contextId, FileLines, { startLine: 6 }));
    assert.equal(past.text, "");
    assert.equal(past.offset, ContentLines.length);
    assert.equal(past.endLine, null);
    assert.equal(past.nextStartLine, null);
    assert.equal(past.nextOffset, null);
    assert.equal(past.totalLines, 5);
    assert.equal(past.tokens, 0);
    assert.equal(code(readOf(host, contextId, FileLines, { startLine: 7 })), "invalid_arguments");
    const middle: Record<string, unknown> = data(readOf(host, contextId, FileLines, { startLine: 2, maxLines: 2 }));
    assert.equal(middle.text, "two\nthree\n");
    assert.equal(middle.offset, 4);
    assert.equal(middle.endLine, 3);
    assert.equal(middle.nextStartLine, 4);
    assert.equal(middle.nextOffset, 14);
    const third: Record<string, unknown> = data(readOf(host, contextId, FileLines, { startLine: 3, maxLines: 1 }));
    assert.equal(third.text, "three\n");
    assert.equal(third.endLine, 3);
    const capped: Record<string, unknown> = data(readOf(host, contextId, FileLines, { startLine: 1, maxLines: 2000 }));
    assert.equal(capped.text, ContentLines);
    assert.equal(capped.endLine, 5);
    assert.equal(capped.nextStartLine, null);
    assert.equal(capped.nextOffset, null);
    assert.equal(code(readOf(host, contextId, FileLines, { startLine: 1, maxLines: 0 })), "invalid_arguments");
    assert.equal(code(readOf(host, contextId, FileLines, { startLine: 1, maxLines: 2001 })), "invalid_arguments");
});

test("line pages preserve CRLF, a missing trailing newline, a lone newline and emptiness", (): void => {
    const { host, contextId }: Ready = ready([FileCrlf, FileNoEol, FileOnlyNewline, FileEmpty]);
    const crlf: Record<string, unknown> = data(readOf(host, contextId, FileCrlf, { startLine: 2, maxLines: 1 }));
    assert.equal(crlf.text, "b\r\n");
    assert.equal(crlf.offset, 3);
    assert.equal(crlf.endLine, 2);
    assert.equal(crlf.nextStartLine, 3);
    assert.equal(crlf.nextOffset, 6);
    assert.equal(crlf.totalLines, 3);
    const crlfLast: Record<string, unknown> = data(readOf(host, contextId, FileCrlf, { startLine: 3, maxLines: 1 }));
    assert.equal(crlfLast.text, "c\r\n");
    assert.equal(crlfLast.nextStartLine, null);
    assert.equal(crlfLast.nextOffset, null);
    const noEolWhole: Record<string, unknown> = data(readOf(host, contextId, FileNoEol, { startLine: 1, maxLines: 2 }));
    assert.equal(noEolWhole.text, ContentNoEol);
    assert.equal(noEolWhole.offset, 0);
    assert.equal(noEolWhole.endLine, 2);
    assert.equal(noEolWhole.nextStartLine, null);
    assert.equal(noEolWhole.nextOffset, null);
    const noEolLast: Record<string, unknown> = data(readOf(host, contextId, FileNoEol, { startLine: 2, maxLines: 1 }));
    assert.equal(noEolLast.text, "beta");
    assert.equal(noEolLast.offset, 6);
    assert.equal(noEolLast.nextOffset, null);
    const lone: Record<string, unknown> = data(readOf(host, contextId, FileOnlyNewline, { startLine: 1, maxLines: 1 }));
    assert.equal(lone.text, "\n");
    assert.equal(lone.totalLines, 1);
    assert.equal(lone.endLine, 1);
    assert.equal(lone.nextStartLine, null);
    assert.equal(lone.nextOffset, null);
    const empty: Record<string, unknown> = data(readOf(host, contextId, FileEmpty, { startLine: 1, maxLines: 1 }));
    assert.equal(empty.text, "");
    assert.equal(empty.offset, 0);
    assert.equal(empty.totalLines, 0);
    assert.equal(empty.endLine, null);
    assert.equal(empty.nextStartLine, null);
    assert.equal(empty.nextOffset, null);
    assert.equal(empty.tokens, 0);
    assert.equal(code(readOf(host, contextId, FileEmpty, { startLine: 2 })), "invalid_arguments");
    const emptyChars: Record<string, unknown> = data(readOf(host, contextId, FileEmpty, {}));
    assert.equal(emptyChars.text, "");
    assert.equal(emptyChars.totalChars, 0);
    assert.equal(emptyChars.offset, 0);
    assert.equal(emptyChars.nextOffset, null);
    assert.equal(emptyChars.tokens, 0);
});

test("byte pages snap into UTF-8, consume whole characters and reconstruct the file", (): void => {
    const { host, contextId }: Ready = ready([FileUnicode, FileEmoji]);
    const totalBytes: number = byteLength(ContentUnicode);
    const head: Record<string, unknown> = data(readOf(host, contextId, FileUnicode, { offsetBytes: 0, maxBytes: 1 }));
    assert.equal(head.text, "h");
    assert.equal(head.offsetBytes, 0);
    assert.equal(head.bytesRead, 1);
    assert.equal(head.nextOffsetBytes, 1);
    assert.equal(head.nextOffset, 1);
    assert.equal(head.totalBytes, totalBytes);
    assert.equal(head.totalBytes, new TextEncoder().encode(ContentUnicode).length);
    assert.equal(head.totalChars, ContentUnicode.length);
    const snapped: Record<string, unknown> = data(readOf(host, contextId, FileUnicode, { offsetBytes: 2, maxBytes: 6 }));
    assert.equal(snapped.offsetBytes, 3);
    assert.equal(snapped.offset, 2);
    assert.equal(snapped.text, "llo\nw");
    assert.equal(snapped.bytesRead, 5);
    assert.equal(snapped.nextOffsetBytes, 8);
    assert.equal(snapped.nextOffset, 7);
    const atEnd: Record<string, unknown> = data(readOf(host, contextId, FileUnicode, { offsetBytes: totalBytes }));
    assert.equal(atEnd.text, "");
    assert.equal(atEnd.offsetBytes, totalBytes);
    assert.equal(atEnd.offset, ContentUnicode.length);
    assert.equal(atEnd.bytesRead, 0);
    assert.equal(atEnd.nextOffsetBytes, null);
    assert.equal(atEnd.nextOffset, null);
    assert.equal(code(readOf(host, contextId, FileUnicode, { offsetBytes: totalBytes + 1 })), "invalid_arguments");
    assert.equal(code(readOf(host, contextId, FileUnicode, { maxBytes: 0 })), "invalid_arguments");
    assert.equal(code(readOf(host, contextId, FileUnicode, { maxBytes: 262145 })), "invalid_arguments");
    const whole: Record<string, unknown> = data(readOf(host, contextId, FileUnicode, { offsetBytes: 0, maxBytes: 262144 }));
    assert.equal(whole.text, ContentUnicode);
    assert.equal(whole.bytesRead, totalBytes);
    assert.equal(whole.nextOffsetBytes, null);
    const emojiBytes: number = byteLength(ContentEmoji);
    const wholeChar: Record<string, unknown> = data(readOf(host, contextId, FileEmoji, { offsetBytes: 0, maxBytes: 1 }));
    assert.equal(wholeChar.text, "\u{1F600}");
    assert.equal(wholeChar.bytesRead, 4);
    assert.equal(wholeChar.nextOffsetBytes, 4);
    assert.equal(wholeChar.nextOffset, 2);
    assert.equal(wholeChar.totalBytes, emojiBytes);
    assert.equal(wholeChar.totalChars, ContentEmoji.length);
    const shifted: Record<string, unknown> = data(readOf(host, contextId, FileEmoji, { offsetBytes: 1, maxBytes: 5 }));
    assert.equal(shifted.offsetBytes, 4);
    assert.equal(shifted.offset, 2);
    assert.equal(shifted.text, "z\n");
    assert.equal(shifted.bytesRead, 2);
    assert.equal(shifted.nextOffsetBytes, null);
    let cursor: number = 0;
    let rebuilt: string = "";
    const pageOffsets: number[] = [];
    for (let pageIndex: number = 0; pageIndex < 8; pageIndex += 1) {
        const page: Record<string, unknown> = data(readOf(host, contextId, FileUnicode, { offsetBytes: cursor, maxBytes: 5 }));
        pageOffsets.push(page.offsetBytes as number);
        rebuilt += textOfPage(page);
        const next: number | null = page.nextOffsetBytes as number | null;
        if (next === null) {
            break;
        }
        assert.ok(next > cursor);
        cursor = next;
    }
    assert.equal(rebuilt, ContentUnicode);
    assert.deepEqual(pageOffsets, [0, 5, 10]);
});

test("addressing modes cannot be mixed and absent addressing fields mean characters", (): void => {
    const { host, contextId }: Ready = ready([FileLines]);
    const mixed: Record<string, unknown>[] = [
        { offset: 0, startLine: 1 },
        { maxChars: 5, offsetBytes: 0 },
        { startLine: 1, maxBytes: 5 },
        { offset: 0, maxLines: 1 },
        { offsetBytes: 0, maxLines: 1 },
    ];
    for (let index: number = 0; index < mixed.length; index += 1) {
        assert.equal(code(readOf(host, contextId, FileLines, mixed[index])), "invalid_arguments", JSON.stringify(mixed[index]));
    }
    const plain: Record<string, unknown> = data(readOf(host, contextId, FileLines));
    assert.equal(plain.text, ContentLines);
    assert.equal(plain.offset, 0);
    assert.equal(plain.nextOffset, null);
    assert.equal(plain.totalChars, ContentLines.length);
    assert.equal(Object.hasOwn(plain, "startLine"), false);
    assert.equal(Object.hasOwn(plain, "offsetBytes"), false);
});

test("pages charge ceil(chars/4), empty pages charge nothing and a one-token remainder is refused", (): void => {
    const { host, view, contextId }: Ready = ready([FileLines]);
    const initial: number = view.remainingTokens as number;
    const first: Record<string, unknown> = data(readOf(host, contextId, FileLines, { maxChars: 10 }));
    assert.equal(first.tokens, Math.ceil(10 / 4));
    assert.equal(first.remainingTokens, initial - (first.tokens as number));
    const second: Record<string, unknown> = data(readOf(host, contextId, FileLines, { offset: 10, maxChars: 10 }));
    assert.equal(second.tokens, 3);
    assert.equal(second.remainingTokens, (first.remainingTokens as number) - 3);
    const empty: Record<string, unknown> = data(readOf(host, contextId, FileLines, { offset: ContentLines.length }));
    assert.equal(empty.tokens, 0);
    assert.equal(empty.remainingTokens, second.remainingTokens);
    /**
     * A Frame allocated more tokens than its target's view costs leaves exactly
     * one token of headroom; the long line's page then costs 51 tokens and must
     * be refused instead of driving the allocation negative. The literal
     * one-token allocation cannot include any detail node, so its read is
     * `not_available`; the observable budget boundary is the one-token
     * remainder tested here.
     */
    const measure: WorkspaceAgentService = service();
    measure.registerFrame(frame("f.measure", [FileLong], 8000), Revision);
    const measured: Record<string, unknown> = materialize(measure, "f.measure");
    const tight: number = (measured.tokens as number) + 1;
    const tightHost: WorkspaceAgentService = service();
    tightHost.registerFrame(frame("f.tight", [FileLong], tight), Revision);
    const tightView: Record<string, unknown> = materialize(tightHost, "f.tight", tight);
    assert.equal(tightView.remainingTokens, 1);
    assert.deepEqual(tightView.readableIds, [FileLong]);
    const refused: WorkspaceResponse = readOf(tightHost, tightView.contextId as string, FileLong, { startLine: 1, maxLines: 1 });
    assert.equal(code(refused), "budget_exhausted");
    const caps: Record<string, unknown> = data(tightHost.call("amp_tool_workspace_capabilities", {}));
    const frames: Array<{ frameId: string; remainingTokens: number; }> = caps.frames as Array<{ frameId: string; remainingTokens: number; }>;
    assert.equal(frames[0].remainingTokens, 1);
    assert.equal(frames[0].remainingTokens >= 0, true);
    const small: Record<string, unknown> = data(readOf(tightHost, tightView.contextId as string, FileLong, { maxChars: 4 }));
    assert.equal(small.tokens, 1);
    assert.equal(small.remainingTokens, 0);
    assert.equal(code(readOf(tightHost, tightView.contextId as string, FileLong, { maxChars: 4 })), "budget_exhausted");
    const exhaustedCaps: Record<string, unknown> = data(tightHost.call("amp_tool_workspace_capabilities", {}));
    const exhaustedFrames: Array<{ frameId: string; remainingTokens: number; }> = exhaustedCaps.frames as Array<{
        frameId: string;
        remainingTokens: number;
    }>;
    assert.equal(exhaustedFrames[0].remainingTokens, 0);
    const one: Ready = ready([FileLong], {}, 1);
    assert.deepEqual(one.view.readableIds, []);
    assert.equal(code(readOf(one.host, one.contextId, FileLong)), "not_available");
});

test("detail handles are bound to one materialized allocation and die on release", (): void => {
    const { host, contextId }: Ready = ready([FileA, SymbolXxx, KnowledgeGuide]);
    assert.equal(code(readOf(host, contextId, FileC)), "not_available");
    assert.equal(code(readOf(host, "ctx.unknown", FileA)), "not_available");
    const foreign: WorkspaceAgentService = service();
    assert.equal(code(readOf(foreign, contextId, FileA)), "not_available");
    const released: Record<string, unknown> = data(call(host, "release", { contextId }));
    assert.equal(released.released, true);
    assert.equal(code(readOf(host, contextId, FileA)), "not_available");
});

test("symbol and knowledge pages are readable when allocated and carry their file's source", (): void => {
    const { host, contextId }: Ready = ready([FileA, FileGuide, SymbolXxx, KnowledgeGuide]);
    const filePage: Record<string, unknown> = data(readOf(host, contextId, FileA));
    const symbolPage: Record<string, unknown> = data(readOf(host, contextId, SymbolXxx));
    assert.equal(symbolPage.text, "xxx = xx");
    assert.equal(sourceUri(symbolPage), "a.ts");
    assert.equal(sourceUri(symbolPage), sourceUri(filePage));
    assert.equal(sourceRevision(symbolPage), sourceRevision(filePage));
    assert.equal((symbolPage.source as Record<string, unknown>).startLine, 2);
    assert.equal((symbolPage.source as Record<string, unknown>).endLine, 2);
    assert.deepEqual(symbolPage.importation, filePage.importation);
    assert.deepEqual(symbolPage.exportation, filePage.exportation);
    const guidePage: Record<string, unknown> = data(readOf(host, contextId, FileGuide));
    const knowledgePage: Record<string, unknown> = data(readOf(host, contextId, KnowledgeGuide));
    assert.equal(knowledgePage.text, ContentGuide);
    assert.equal(sourceUri(knowledgePage), "guide.md");
    assert.equal(sourceUri(knowledgePage), sourceUri(guidePage));
    assert.equal(sourceRevision(knowledgePage), sourceRevision(guidePage));
    assert.equal((knowledgePage.importation as Record<string, unknown>).path, "guide.md");
    assert.deepEqual((knowledgePage.importation as { files: unknown[]; }).files, []);
    assert.deepEqual((knowledgePage.exportation as { files: unknown[]; }).files, []);
});

test("impact payloads name both directions with ids, paths and 1-based lines", (): void => {
    const { host, contextId }: Ready = ready([FileA, SymbolXxx]);
    const page: Record<string, unknown> = data(readOf(host, contextId, FileA, { maxChars: 4000 }));
    assert.deepEqual(page.importation, {
        path: "a.ts",
        files: [{ id: "file:c.ts", path: "c.ts", line: 1, method: "compiler" }],
        external: [],
        externalTotal: 0,
        externalTruncated: false,
        total: 1,
        truncated: false,
    });
    assert.deepEqual(page.exportation, {
        path: "a.ts",
        files: [
            { id: "file:b.ts", path: "b.ts", line: 1, method: "compiler" },
            { id: "file:d.ts", path: "d.ts", line: 1, method: "compiler" },
            { id: "file:e.ts", path: "e.ts", line: 1, method: "compiler" },
        ],
        total: 3,
        truncated: false,
    });
    assert.equal((page.importation as { files: Array<{ id: string; }>; }).files[0].id, "file:c.ts");
    assert.equal((page.exportation as { files: Array<{ id: string; }>; }).files[1].id, FileD);
    const symbolPage: Record<string, unknown> = data(readOf(host, contextId, SymbolXxx, { maxChars: 4000 }));
    assert.deepEqual(symbolPage.importation, page.importation);
    assert.deepEqual(symbolPage.exportation, page.exportation);
});

test("impact lists separate bare packages, unresolved imports, duplicates and an empty graph", (): void => {
    const { host, contextId }: Ready = ready([FileE, FileExt, FileDup, FileSolo]);
    const ePage: Record<string, unknown> = data(readOf(host, contextId, FileE, { maxChars: 4000 }));
    assert.deepEqual(ePage.importation, {
        path: "e.ts",
        files: [{ id: "file:a.ts", path: "a.ts", line: 1, method: "compiler" }],
        external: ["node:fs"],
        externalTotal: 1,
        externalTruncated: false,
        total: 1,
        truncated: false,
    });
    assert.doesNotMatch(JSON.stringify(ePage.importation), /missing/);
    const extPage: Record<string, unknown> = data(readOf(host, contextId, FileExt, { maxChars: 4000 }));
    assert.deepEqual(extPage.importation, {
        path: "ext.ts",
        files: [],
        external: ["node:fs", "node:os", "node:path"],
        externalTotal: 3,
        externalTruncated: false,
        total: 0,
        truncated: false,
    });
    const dupPage: Record<string, unknown> = data(readOf(host, contextId, FileDup, { maxChars: 4000 }));
    assert.deepEqual(dupPage.importation, {
        path: "dup.ts",
        files: [{ id: "file:c.ts", path: "c.ts", line: 1, method: "compiler" }],
        external: [],
        externalTotal: 0,
        externalTruncated: false,
        total: 1,
        truncated: false,
    });
    assert.equal((dupPage.importation as { files: unknown[]; }).files.length, 1);
    const soloPage: Record<string, unknown> = data(readOf(host, contextId, FileSolo, { maxChars: 4000 }));
    assert.deepEqual(soloPage.importation, {
        path: "solo.ts",
        files: [],
        external: [],
        externalTotal: 0,
        externalTruncated: false,
        total: 0,
        truncated: false,
    });
    assert.deepEqual(soloPage.exportation, { path: "solo.ts", files: [], total: 0, truncated: false });
});

test("maxFileLinks truncates a three-file list and reports the untruncated total", (): void => {
    const host: WorkspaceAgentService = service({ limits: { maxFileLinks: 2 } });
    host.registerFrame(frame("f.links", [FileA, FileExt], 8000), Revision);
    const view: Record<string, unknown> = materialize(host, "f.links");
    const contextId: string = view.contextId as string;
    const page: Record<string, unknown> = data(readOf(host, contextId, FileA, { maxChars: 4000 }));
    const exportation: { files: Array<Record<string, unknown>>; total: number; truncated: boolean; } = page.exportation as {
        files: Array<Record<string, unknown>>;
        total: number;
        truncated: boolean;
    };
    assert.equal(exportation.files.length, 2);
    assert.deepEqual(exportation.files.map((item: Record<string, unknown>): unknown => item.path), ["b.ts", "d.ts"]);
    assert.deepEqual(exportation.files.map((item: Record<string, unknown>): unknown => item.id), [FileB, FileD]);
    assert.equal(exportation.total, 3);
    assert.equal(exportation.truncated, true);
    assert.equal((page.importation as { total: number; }).total, 1);
    assert.equal((page.importation as { truncated: boolean; }).truncated, false);
    /**
     * `maxFileLinks` is applied to `external` as well, and the cut is reported
     * by `externalTotal`/`externalTruncated` rather than being silent.
     */
    const extPage: Record<string, unknown> = data(readOf(host, contextId, FileExt, { maxChars: 4000 }));
    const extImportation: { external: string[]; externalTotal: number; externalTruncated: boolean; total: number; truncated: boolean; } =
        extPage.importation as { external: string[]; externalTotal: number; externalTruncated: boolean; total: number; truncated: boolean; };
    assert.deepEqual(extImportation.external, ["node:fs", "node:os"]);
    assert.equal(extImportation.externalTotal, 3);
    assert.equal(extImportation.externalTruncated, true);
    assert.equal(extImportation.total, 0);
    assert.equal(extImportation.truncated, false);
});

test("project, directory and package targets never expose a readable detail page", (): void => {
    const host: WorkspaceAgentService = service({ writer: { write: (): { ok: true; revision: string; } => ({ ok: true, revision: "rev.none" }) } });
    host.registerFrame(frame("f.nonfile", [Project, Directory, PackageFs], 8000), Revision);
    const view: Record<string, unknown> = materialize(host, "f.nonfile");
    const readable: string[] = [...(view.readableIds as string[])].sort();
    assert.deepEqual(readable, [Project, Directory, PackageFs].sort());
    /**
     * The boundary matrix expects a readable page for project/directory/package
     * scopes whose `importation`/`exportation` carry `path: null` and empty
     * lists. The implementation answers `not_available` for all three because
     * `Context.expand` only holds nodes with a `detailRef`, so `impacts()`'s
     * containing-file-is-absent branch is unreachable from `read`. The write
     * side still reaches the kind check and rejects non-files.
     */
    const contextId: string = view.contextId as string;
    assert.equal(code(readOf(host, contextId, Project)), "not_available");
    assert.equal(code(readOf(host, contextId, Directory)), "not_available");
    assert.equal(code(readOf(host, contextId, PackageFs)), "not_available");
    assert.equal(code(writeOf(host, contextId, Project, { content: "x" })), "invalid_arguments");
    assert.equal(code(writeOf(host, contextId, Directory, { content: "x" })), "invalid_arguments");
    assert.equal(code(writeOf(host, contextId, PackageFs, { content: "x" })), "invalid_arguments");
});

test("whole-node writes delete a body, accept an identical body and compare-and-swap revisions", (): void => {
    const records: WriteRecord[] = [];
    const host: WorkspaceAgentService = service({ writer: writerOf(records) });
    host.registerFrame(frame("f.node", [FileA, FileMutable], 8000), Revision);
    const contextId: string = materialize(host, "f.node").contextId as string;
    const beforeA: Record<string, unknown> = data(readOf(host, contextId, FileA, { maxChars: 4000 }));
    const snapshotRevision: string = sourceRevision(beforeA);
    const same: Record<string, unknown> = data(writeOf(host, contextId, FileA, { content: ContentA, expectRevision: snapshotRevision }));
    assert.equal(same.mode, "node");
    assert.equal(same.dryRun, false);
    assert.equal(same.previousRevision, snapshotRevision);
    assert.equal(same.revision, "rev.1");
    assert.equal(same.path, "a.ts");
    assert.equal(same.bytes, byteLength(ContentA));
    assert.equal(same.lines, 2);
    assert.equal(records[0].content, ContentA);
    assert.equal(records[0].uri, "a.ts");
    assert.equal(records[0].agentId, "a.test");
    assert.equal(records[0].previousRevision, snapshotRevision);
    const reread: Record<string, unknown> = data(readOf(host, contextId, FileA, { maxChars: 4000 }));
    assert.equal(reread.text, ContentA);
    assert.equal(sourceRevision(reread), "rev.1");
    const next: Record<string, unknown> = data(
        writeOf(host, contextId, FileA, { content: "export const xxx = 2;\n", expectRevision: "rev.1" }),
    );
    assert.equal(next.revision, "rev.2");
    assert.equal(next.previousRevision, "rev.1");
    const afterNext: Record<string, unknown> = data(readOf(host, contextId, FileA, { maxChars: 4000 }));
    assert.equal(afterNext.text, "export const xxx = 2;\n");
    assert.equal(sourceRevision(afterNext), "rev.2");
    assert.equal(code(writeOf(host, contextId, FileA, { content: "stale", expectRevision: snapshotRevision })), "fingerprint_mismatch");
    assert.equal(code(writeOf(host, contextId, FileA, { content: "stale", expectRevision: "rev.0" })), "fingerprint_mismatch");
    assert.equal(records.length, 2);
    const beforeMutable: Record<string, unknown> = data(readOf(host, contextId, FileMutable, { maxChars: 4000 }));
    const mutableRevision: string = sourceRevision(beforeMutable);
    const deleted: Record<string, unknown> = data(writeOf(host, contextId, FileMutable, { content: "" }));
    assert.equal(deleted.mode, "node");
    assert.equal(deleted.bytes, 0);
    assert.equal(deleted.lines, 0);
    assert.equal(deleted.previousRevision, mutableRevision);
    assert.equal(deleted.revision, "rev.3");
    assert.equal(records[2].content, "");
    const emptyRead: Record<string, unknown> = data(readOf(host, contextId, FileMutable, { maxChars: 4000 }));
    assert.equal(emptyRead.text, "");
    assert.equal(emptyRead.totalChars, 0);
    assert.equal(emptyRead.tokens, 0);
    assert.equal(sourceRevision(emptyRead), "rev.3");
    const restored: Record<string, unknown> = data(writeOf(host, contextId, FileMutable, { content: "abc" }));
    assert.equal(restored.revision, "rev.4");
    assert.equal(records[3].previousRevision, "rev.3");
});

test("line writes replace first, middle and last lines, delete and expand a range and keep CRLF", (): void => {
    const records: WriteRecord[] = [];
    const host: WorkspaceAgentService = service({ writer: writerOf(records) });
    host.registerFrame(frame("f.lines", [FileLines, FileCrlf], 8000), Revision);
    const contextId: string = materialize(host, "f.lines").contextId as string;
    const invalid: Record<string, unknown>[] = [
        { content: "x", startLine: 0, endLine: 1 },
        { content: "x", startLine: 2, endLine: 1 },
        { content: "x", startLine: 6, endLine: 6 },
        { content: "x", startLine: 1, endLine: 6 },
        { content: "x", endLine: 1 },
        { content: "x", startLine: 1 },
    ];
    for (let index: number = 0; index < invalid.length; index += 1) {
        assert.equal(code(writeOf(host, contextId, FileLines, invalid[index])), "invalid_arguments", JSON.stringify(invalid[index]));
    }
    assert.equal(records.length, 0);
    const first: Record<string, unknown> = data(writeOf(host, contextId, FileLines, { content: "ONE", startLine: 1, endLine: 1 }));
    assert.equal(first.mode, "lines");
    assert.equal(first.startLine, 1);
    assert.equal(first.endLine, 1);
    assert.equal(records[0].content, "ONE\ntwo\nthree\nfour\nfive\n");
    data(writeOf(host, contextId, FileLines, { content: "THREE", startLine: 3, endLine: 3 }));
    assert.equal(records[1].content, "ONE\ntwo\nTHREE\nfour\nfive\n");
    data(writeOf(host, contextId, FileLines, { content: "FIVE", startLine: 5, endLine: 5 }));
    assert.equal(records[2].content, "ONE\ntwo\nTHREE\nfour\nFIVE\n");
    const removed: Record<string, unknown> = data(writeOf(host, contextId, FileLines, { content: "", startLine: 2, endLine: 2 }));
    assert.equal(records[3].content, "ONE\nTHREE\nfour\nFIVE\n");
    assert.equal(removed.lines, 4);
    data(writeOf(host, contextId, FileLines, { content: "a\nb\nc", startLine: 2, endLine: 2 }));
    assert.equal(records[4].content, "ONE\na\nb\nc\nfour\nFIVE\n");
    const finalRead: Record<string, unknown> = data(readOf(host, contextId, FileLines, { maxChars: 4000 }));
    assert.equal(finalRead.text, records[4].content);
    assert.equal(sourceRevision(finalRead), "rev.5");
    const crlfBefore: Record<string, unknown> = data(readOf(host, contextId, FileCrlf, { maxChars: 4000 }));
    assert.equal(crlfBefore.text, ContentCrlf);
    const crlf: Record<string, unknown> = data(writeOf(host, contextId, FileCrlf, { content: "B", startLine: 2, endLine: 2 }));
    assert.equal(crlf.mode, "lines");
    assert.equal(records[5].content, "a\r\nB\r\nc\r\n");
    const crlfRead: Record<string, unknown> = data(readOf(host, contextId, FileCrlf, { maxChars: 4000 }));
    assert.equal(crlfRead.text, "a\r\nB\r\nc\r\n");
    data(writeOf(host, contextId, FileCrlf, { content: "A1\r\nA2", startLine: 1, endLine: 1 }));
    assert.equal(records[6].content, "A1\r\nA2\r\nB\r\nc\r\n");
});

test("byte writes insert at both edges, replace a multi-byte character and delete everything", (): void => {
    const records: WriteRecord[] = [];
    const host: WorkspaceAgentService = service({ writer: writerOf(records) });
    host.registerFrame(frame("f.bytes", [FileUnicode], 8000), Revision);
    const contextId: string = materialize(host, "f.bytes").contextId as string;
    const invalid: Record<string, unknown>[] = [
        { content: "X", offsetBytes: 2, endBytes: 3 },
        { content: "X", offsetBytes: 0, endBytes: 999 },
        { content: "X", offsetBytes: 5, endBytes: 4 },
        { content: "X", endBytes: 3 },
        { content: "X", offsetBytes: 3 },
    ];
    for (let index: number = 0; index < invalid.length; index += 1) {
        assert.equal(code(writeOf(host, contextId, FileUnicode, invalid[index])), "invalid_arguments", JSON.stringify(invalid[index]));
    }
    assert.equal(records.length, 0);
    const inserted: Record<string, unknown> = data(writeOf(host, contextId, FileUnicode, { content: "START:", offsetBytes: 0, endBytes: 0 }));
    assert.equal(inserted.mode, "bytes");
    assert.equal(inserted.offsetBytes, 0);
    assert.equal(inserted.endBytes, 0);
    assert.equal(records[0].content, `START:${ContentUnicode}`);
    const prefixed: string = records[0].content;
    const prefixBytes: number = byteLength(prefixed);
    data(writeOf(host, contextId, FileUnicode, { content: "END", offsetBytes: prefixBytes, endBytes: prefixBytes }));
    assert.equal(records[1].content, `${prefixed}END`);
    const accentStart: number = byteLength("START:h");
    const accentEnd: number = accentStart + byteLength("\u00e9");
    const replaced: Record<string, unknown> = data(
        writeOf(host, contextId, FileUnicode, { content: "e", offsetBytes: accentStart, endBytes: accentEnd }),
    );
    assert.equal(replaced.mode, "bytes");
    assert.equal(replaced.offsetBytes, accentStart);
    assert.equal(replaced.endBytes, accentEnd);
    assert.equal(records[2].content, "START:hello\nw\u00f6rld\nEND");
    const allBytes: number = byteLength(records[2].content);
    const cleared: Record<string, unknown> = data(
        writeOf(host, contextId, FileUnicode, { content: "", offsetBytes: 0, endBytes: allBytes }),
    );
    assert.equal(records[3].content, "");
    assert.equal(cleared.bytes, 0);
    assert.equal(cleared.lines, 0);
    const readBack: Record<string, unknown> = data(readOf(host, contextId, FileUnicode, { maxChars: 100 }));
    assert.equal(readBack.text, "");
    assert.equal(readBack.totalChars, 0);
    assert.equal(readBack.tokens, 0);
});

test("write mode follows the addressing fields and only file bodies are writable", (): void => {
    const records: WriteRecord[] = [];
    const host: WorkspaceAgentService = service({ writer: writerOf(records) });
    host.registerFrame(frame("f.mode", [FileMutable, SymbolXxx, Directory], 8000), Revision);
    const contextId: string = materialize(host, "f.mode").contextId as string;
    const lineMode: Record<string, unknown> = data(writeOf(host, contextId, FileMutable, { content: "row", startLine: 1, endLine: 1 }));
    assert.equal(lineMode.mode, "lines");
    assert.equal(records[0].content, "row\n");
    assert.equal(code(writeOf(host, contextId, FileMutable, { content: "x", offsetBytes: 0 })), "invalid_arguments");
    assert.equal(code(writeOf(host, contextId, FileMutable, { content: "x", endLine: 1 })), "invalid_arguments");
    assert.equal(code(writeOf(host, contextId, FileMutable, { content: "x", startLine: 1 })), "invalid_arguments");
    assert.equal(code(writeOf(host, contextId, SymbolXxx, { content: "x" })), "invalid_arguments");
    assert.equal(code(writeOf(host, contextId, Directory, { content: "x" })), "invalid_arguments");
    assert.equal(code(writeOf(host, contextId, FileC, { content: "x" })), "not_available");
    assert.equal(records.length, 1);
});

test("a missing writer, host refusals, empty revisions, throws and capacity all fail closed", (): void => {
    const plain: Ready = ready([FileMutable]);
    assert.equal(code(writeOf(plain.host, plain.contextId, FileMutable, { content: "x" })), "write_unavailable");
    const dry: Record<string, unknown> = data(writeOf(plain.host, plain.contextId, FileMutable, { content: "x", dryRun: true }));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.revision, null);
    assert.equal(dry.mode, "node");
    assert.equal(data(readOf(plain.host, plain.contextId, FileMutable, { maxChars: 100 })).text, ContentMutable);
    let refusalCalls: number = 0;
    const refusing: WorkspaceWriter = {
        write: (): { ok: false; code: "integrity_failure"; } => {
            refusalCalls += 1;
            return { ok: false, code: "integrity_failure" };
        },
    };
    const refused: Ready = ready([FileMutable], { writer: refusing });
    assert.equal(code(writeOf(refused.host, refused.contextId, FileMutable, { content: "x" })), "integrity_failure");
    assert.equal(refusalCalls, 1);
    const blank: WorkspaceWriter = { write: (): { ok: true; revision: string; } => ({ ok: true, revision: "" }) };
    const blankReady: Ready = ready([FileMutable], { writer: blank });
    assert.equal(code(writeOf(blankReady.host, blankReady.contextId, FileMutable, { content: "x" })), "internal_error");
    const throwing: WorkspaceWriter = {
        write: (): never => {
            throw new Error("host write failed");
        },
    };
    const throwingReady: Ready = ready([FileMutable], { writer: throwing });
    assert.equal(code(writeOf(throwingReady.host, throwingReady.contextId, FileMutable, { content: "x" })), "internal_error");
    const capacity: Ready = ready([FileMutable], { writer: writerOf([]), limits: { maxWriteChars: 5 } });
    const accepted: Record<string, unknown> = data(writeOf(capacity.host, capacity.contextId, FileMutable, { content: "12345" }));
    assert.equal(accepted.revision, "rev.1");
    assert.equal(code(writeOf(capacity.host, capacity.contextId, FileMutable, { content: "123456" })), "capacity_exceeded");
    assert.equal(code(writeOf(capacity.host, capacity.contextId, FileMutable, { content: "123456", dryRun: true })), "capacity_exceeded");
});

test("write replies reuse the read impact payload and do not charge Frame tokens", (): void => {
    const records: WriteRecord[] = [];
    const host: WorkspaceAgentService = service({ writer: writerOf(records) });
    host.registerFrame(frame("f.impact", [FileA], 8000), Revision);
    const contextId: string = materialize(host, "f.impact").contextId as string;
    const before: Record<string, unknown> = data(readOf(host, contextId, FileA, { maxChars: 4000 }));
    const written: Record<string, unknown> = data(writeOf(host, contextId, FileA, { content: "export const xxx = 7;\n" }));
    assert.deepEqual(written.importation, before.importation);
    assert.deepEqual(written.exportation, before.exportation);
    assert.equal(written.remainingTokens, before.remainingTokens);
    const after: Record<string, unknown> = data(readOf(host, contextId, FileA, { maxChars: 4000 }));
    assert.equal(after.text, "export const xxx = 7;\n");
    assert.equal(sourceRevision(after), "rev.1");
    assert.equal(after.remainingTokens, (before.remainingTokens as number) - (after.tokens as number));
    assert.equal(records.length, 1);
});

test("a symbol page fails closed with stale_detail after a write to the containing file", (): void => {
    const records: WriteRecord[] = [];
    const host: WorkspaceAgentService = service({ writer: writerOf(records) });
    host.registerFrame(frame("f.stale", [FileA, SymbolXxx], 8000), Revision);
    const contextId: string = materialize(host, "f.stale").contextId as string;
    const symbolBefore: Record<string, unknown> = data(readOf(host, contextId, SymbolXxx, { maxChars: 4000 }));
    const written: Record<string, unknown> = data(writeOf(host, contextId, FileA, { content: "export const zzz = 9;\n" }));
    assert.equal(written.revision, "rev.1");
    const fileAfter: Record<string, unknown> = data(readOf(host, contextId, FileA, { maxChars: 4000 }));
    assert.equal(fileAfter.text, "export const zzz = 9;\n");
    assert.equal(sourceRevision(fileAfter), "rev.1");
    /**
     * The snapshot extraction no longer describes the current file, so the
     * symbol page must not serve stale text with a snapshot revision; it
     * reports `stale_detail` until the host refreshes the snapshot.
     */
    assert.equal(code(readOf(host, contextId, SymbolXxx, { maxChars: 4000 })), "stale_detail");
    assert.equal(symbolBefore.text, "xxx = xx");
});
