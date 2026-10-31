/**
 * File hooks: read, write and diff.
 *
 * `useWrite` is the only mutating hook in the whole layer. It forwards one
 * `WriteRequest` to the bound `FilesystemSession.write` and reports the
 * post-write revision from the result; it never enables the request cache,
 * because replaying a write from cache would silently skip the second write
 * and turn a "create" into a success that never touched the disk.
 *
 * `useRead` and `useDiff` are read-only. `useDiff` reconstructs the current file
 * page by page (the read contract caps one page at 2000 lines and 256 KiB) and
 * treats a missing file as the empty string, so "new file" and "deleted file"
 * are both expressible without a special request shape.
 */
import { isFilesystemError } from "../file/errors.ts";
import type { ReadPage, ReadRequest, WriteRequest, WriteResult } from "../file/types.ts";
import { rawTextDigest } from "../fingerprint/raw.ts";
import type { DiffRequest, DiffResult, DiffSource } from "./diff.ts";
import { DiffMaxLines, diffSources, textDiffSource } from "./diff.ts";
import type { Hook, HookOptions, HookSession } from "./types.ts";
import { createHook } from "./types.ts";

/**
 * Largest page the read contract returns, in lines.
 */
const ReadPageLines: number = 2000;

/**
 * Largest page the read contract returns, in UTF-8 bytes.
 */
const ReadPageBytes: number = 256 * 1024;

/**
 * Read a whole file as diff lines. A missing file is the empty side; every
 * other classified failure propagates. The fingerprint comes from the first
 * page, which already covers the entire file bytes.
 *
 * Page text is returned without a trailing newline, so a page that ends on a
 * blank line would lose that line if it were split naively. The page's
 * inclusive `startLine`/`endLine` range is authoritative; missing trailing
 * blanks are restored so a multi-page diff keeps every line.
 */
const readDiffSource: (session: HookSession, path: string) => DiffSource = (session: HookSession, path: string): DiffSource => {
    const lines: string[] = [];
    let startLine: number = 1;
    let fingerprint: string = rawTextDigest("");
    let truncated: boolean = false;
    let first: boolean = true;
    while (lines.length <= DiffMaxLines) {
        let page: ReadPage;
        try {
            page = session.read({
                path,
                startLine,
                maxLines: Math.min(ReadPageLines, DiffMaxLines + 1 - lines.length),
                maxBytes: ReadPageBytes,
            });
        } catch (error: unknown) {
            if (isFilesystemError(error) && error.code === "not_found") {
                return { lines: [], fingerprint: rawTextDigest(""), truncated: false };
            }
            throw error;
        }
        if (first) {
            fingerprint = page.fingerprint;
            first = false;
        }
        const expected: number = page.endLine - page.startLine + 1;
        if (expected > 0) {
            const pageLines: string[] = page.text.length === 0 ? [] : page.text.split("\n").map((line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line));
            for (let index: number = 0; index < pageLines.length; index += 1) {
                lines.push(pageLines[index]);
            }
            while (pageLines.length < expected) {
                lines.push("");
                pageLines.push("");
            }
        }
        if (page.nextStartLine === null) {
            break;
        }
        if (page.nextStartLine <= startLine) {
            truncated = true;
            break;
        }
        startLine = page.nextStartLine;
    }
    if (lines.length > DiffMaxLines) {
        lines.length = DiffMaxLines;
        truncated = true;
    }
    return { lines, fingerprint, truncated };
};

/**
 * Read hook. Delegates one `ReadRequest` to the session and keeps `bigint`
 * totals (`totalLines`/`totalBytes`) intact; the hook layer never projects a
 * domain value onto JSON.
 *
 * Caching is opt-in through `options.cache`. The cache key covers the request
 * only, so a host that enables it after a write should reset the hook or create
 * a new one; the default is uncached because a stale read is worse than a
 * repeated one.
 *
 * @param session - Bound filesystem session.
 * @param options - Recorder and cache options.
 * @returns Hook producing one bounded read page.
 */
export const useRead: (session: HookSession, options?: HookOptions) => Hook<ReadRequest, ReadPage> = (session: HookSession, options: HookOptions = {}): Hook<ReadRequest, ReadPage> =>
    createHook<ReadRequest, ReadPage>({
        name: "read",
        session,
        execute: (request: ReadRequest): ReadPage => session.read(request),
        pathOf: (request: ReadRequest): string => request.path,
        options,
    });

/**
 * Write hook. This is the only mutable operation in the hook layer.
 *
 * The success revision is `WriteResult.revision`, the revision the write
 * actually produced, rather than a later session read that could include an
 * unrelated change. The cache is always disabled.
 *
 * @param session - Bound filesystem session.
 * @param options - Recorder options; `cache` is ignored.
 * @returns Hook producing one write result.
 */
export const useWrite: (session: HookSession, options?: HookOptions) => Hook<WriteRequest, WriteResult> = (session: HookSession, options: HookOptions = {}): Hook<WriteRequest, WriteResult> =>
    createHook<WriteRequest, WriteResult>({
        name: "write",
        session,
        execute: (request: WriteRequest): Promise<WriteResult> => session.write(request),
        pathOf: (request: WriteRequest): string => request.path,
        revisionOf: (result: WriteResult): string => result.revision,
        options: { ...options, cache: false },
    });

/**
 * Diff hook.
 *
 * `request.before` overrides the old side and `request.content` overrides the
 * new side; an omitted side is read from the session. With both omitted the
 * file is read once and compared with itself, which reports no hunks. The
 * request cache is disabled because the result depends on the file on disk,
 * not only on the request.
 *
 * @param session - Bound filesystem session.
 * @param options - Recorder options; `cache` is ignored.
 * @returns Hook producing one bounded diff.
 */
export const useDiff: (session: HookSession, options?: HookOptions) => Hook<DiffRequest, DiffResult> = (session: HookSession, options: HookOptions = {}): Hook<DiffRequest, DiffResult> =>
    createHook<DiffRequest, DiffResult>({
        name: "diff",
        session,
        execute: (request: DiffRequest): DiffResult => {
            const beforeText: string | undefined = request.before;
            const afterText: string | undefined = request.content;
            const before: DiffSource = beforeText === (void 0) ? readDiffSource(session, request.path) : textDiffSource(beforeText);
            const after: DiffSource =
                afterText === (void 0) ? (beforeText === (void 0) ? before : readDiffSource(session, request.path)) : textDiffSource(afterText);
            return diffSources(request.path, before, after, request.context);
        },
        pathOf: (request: DiffRequest): string => request.path,
        options: { ...options, cache: false },
    });
