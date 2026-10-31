/**
 * Bounded diff application for the workspace context layer.
 *
 * Two edit coordinate systems share one entry point: 1-based inclusive line
 * ranges for whole-line replacement, and UTF-8 byte ranges for surgical edits
 * that must not renumber lines. Both accept a batch of changes and apply it
 * from the highest offset downwards, so applying a later change never shifts
 * the coordinates of an earlier one that is still to be applied. Every batch
 * is validated against the text as it exists at that point, which means a
 * caller can trust an accepted batch: it could be applied in full or not at
 * all.
 *
 * The diff itself is not reimplemented here. `summarizeDiff` projects the
 * bounded linear-space Hirschberg implementation in `src/hook/diff.ts`, so the
 * counts and hunk coordinates an agent sees are exactly the ones the hook layer
 * reports, and a second LCS can never disagree with the first.
 *
 * Failures use a closed two-code taxonomy. `invalid_arguments` covers a range
 * that does not fit the text (a line beyond EOF, a byte offset inside a
 * multi-byte character, a negative offset); `capacity_exceeded` covers a result
 * larger than the caller's `maxChars` ceiling. The message is the code itself,
 * so a transport can forward it without echoing file content.
 */
import { diffText } from "../hook/diff.ts";
import type { DiffHunk, DiffResult } from "../hook/diff.ts";

/**
 * Closed failure codes for diff application.
 */
export type WorkspaceDiffCode = "invalid_arguments" | "capacity_exceeded";

/**
 * One classified failure in this module. The message is the code, matching the
 * filesystem and context-builder convention of never echoing content.
 */
export class WorkspaceDiffError extends Error {
    readonly code: WorkspaceDiffCode;

    constructor(code: WorkspaceDiffCode) {
        super(code);
        this.code = code;
    }
}

/**
 * One whole-line replacement. `startLine` and `endLine` are 1-based and
 * inclusive; an empty `content` deletes the selected lines.
 */
export interface LineChange {
    startLine: number;
    endLine: number;
    content: string;
}

/**
 * One byte-range replacement. `[offsetBytes, endBytes)` is replaced by the
 * UTF-8 bytes of `content`; an empty range is an insertion.
 */
export interface ByteChange {
    offsetBytes: number;
    endBytes: number;
    content: string;
}

/**
 * Hunk geometry without its lines. Starts are 1-based; an added-only hunk
 * reports the insertion point on the before side, and a removed-only hunk the
 * insertion point on the after side.
 */
export interface DiffHunkSummary {
    beforeStart: number;
    beforeLines: number;
    afterStart: number;
    afterLines: number;
}

/**
 * Projection of `DiffResult` without line text: counts, truncation and hunk
 * coordinates only.
 */
export interface DiffSummary {
    added: number;
    removed: number;
    unchanged: number;
    truncated: boolean;
    hunks: DiffHunkSummary[];
}

/**
 * Throw one classified failure.
 */
const fail: (code: WorkspaceDiffCode) => never = (code: WorkspaceDiffCode): never => {
    throw new WorkspaceDiffError(code);
};

/**
 * Enforce the optional character ceiling on an assembled result.
 *
 * @param text - Result text.
 * @param maxChars - Caller ceiling, or `undefined` for no ceiling.
 * @returns The same text when it fits.
 */
const enforceMaxChars: (text: string, maxChars: number | undefined) => string = (text: string, maxChars: number | undefined): string => {
    if (maxChars !== (void 0) && text.length > maxChars) {
        fail("capacity_exceeded");
    }
    return text;
};

/**
 * Character offsets where each logical line starts.
 *
 * The line-counting rule is the same one `splitDiffLines` uses: a trailing
 * newline terminates the last line instead of creating an empty one, and the
 * empty string has no lines. CRLF needs no special case because the offset
 * points past the whole `\r\n` pair.
 *
 * @param text - Text to index.
 * @returns Start offset per line, in document order.
 */
const lineStartsOf: (text: string) => number[] = (text: string): number[] => {
    const starts: number[] = [];
    if (text.length === 0) {
        return starts;
    }
    let start: number = 0;
    for (let index: number = 0; index < text.length; index += 1) {
        if (text[index] === "\n") {
            starts.push(start);
            start = index + 1;
        }
    }
    if (start < text.length) {
        starts.push(start);
    }
    return starts;
};

/**
 * Terminator a replaced span ends with, or `""` when it has none.
 *
 * @param span - Text of the replaced lines.
 * @returns `"\r\n"`, `"\n"` or `""`.
 */
const terminatorOf: (span: string) => string = (span: string): string => {
    if (span.endsWith("\r\n")) {
        return "\r\n";
    }
    return span.endsWith("\n") ? "\n" : "";
};

/**
 * Whether an offset points at a UTF-8 continuation byte, i.e. inside a
 * character. `offset === bytes.length` is a valid end position.
 */
const isContinuationByte: (bytes: Uint8Array, offset: number) => boolean = (bytes: Uint8Array, offset: number): boolean =>
    offset < bytes.length && (bytes[offset] & 0xc0) === 0x80;

/**
 * Apply whole-line replacements to `current`.
 *
 * Each change replaces the span `[start of startLine, start of the line after
 * endLine)`, or to EOF when `endLine` is the last line. A span that ends with a
 * line terminator and a replacement that does not end with `"\n"` gets the
 * span's own terminator back, so a CRLF file stays CRLF. An empty replacement
 * deletes the lines together with their separator.
 *
 * Changes are applied in descending `startLine` order and every change is
 * validated against the text as it exists after the changes above it, so two
 * changes never invalidate each other's coordinates.
 *
 * @param current - Text the ranges refer to.
 * @param changes - Line replacements, in any order.
 * @param maxChars - Optional ceiling on the resulting character count.
 * @returns The edited text.
 * @throws WorkspaceDiffError - `invalid_arguments` for a range that does not
 * fit, `capacity_exceeded` when the result exceeds `maxChars`.
 */
export const applyLineChanges: (current: string, changes: readonly LineChange[], maxChars?: number) => string = (current: string, changes: readonly LineChange[], maxChars?: number): string => {
    const ordered: LineChange[] = [...changes].sort((left: LineChange, right: LineChange): number => right.startLine - left.startLine);
    /**
     * Validate and reject overlaps against the original coordinates before any
     * splice. Two edits that share a line have no order-independent meaning, so
     * accepting them would silently drop one depending on array order.
     */
    const lineCount: number = lineStartsOf(current).length;
    ordered.forEach((change: LineChange): void => {
        if (!Number.isSafeInteger(change.startLine) || !Number.isSafeInteger(change.endLine)) {
            fail("invalid_arguments");
        }
        if (change.startLine < 1 || change.endLine < change.startLine || change.endLine > lineCount) {
            fail("invalid_arguments");
        }
    });
    for (let index: number = 1; index < ordered.length; index += 1) {
        if (ordered[index].endLine >= ordered[index - 1].startLine) {
            fail("invalid_arguments");
        }
    }
    let text: string = current;
    ordered.forEach((change: LineChange): void => {
        const starts: number[] = lineStartsOf(text);
        const lines: number = starts.length;
        const startChar: number = starts[change.startLine - 1];
        const endChar: number = change.endLine < lines ? starts[change.endLine] : text.length;
        const span: string = text.slice(startChar, endChar);
        const terminator: string = terminatorOf(span);
        const replacement: string = change.content;
        const inserted: string =
            replacement.length === 0 || terminator.length === 0 || replacement.endsWith("\n") ? replacement : `${replacement}${terminator}`;
        text = `${text.slice(0, startChar)}${inserted}${text.slice(endChar)}`;
    });
    return enforceMaxChars(text, maxChars);
};

/**
 * Apply UTF-8 byte-range replacements to `current`.
 *
 * Offsets are byte offsets into the UTF-8 encoding of `current`, so an offset
 * inside a multi-byte character is rejected rather than splitting the character
 * into replacement bytes. All ranges are validated against the original byte
 * length before any splice, then applied in descending `offsetBytes` order.
 * The spliced bytes are decoded with a fatal UTF-8 decoder, so a batch can never
 * turn the text into a string that cannot be re-encoded identically.
 *
 * @param current - Text the byte ranges refer to.
 * @param changes - Byte replacements, in any order.
 * @param maxChars - Optional ceiling on the resulting character count.
 * @returns The edited text.
 * @throws WorkspaceDiffError - `invalid_arguments` for an offset that is not an
 * integer, is negative, exceeds the buffer, or splits a character;
 * `capacity_exceeded` when the result exceeds `maxChars`.
 */
export const applyByteChanges: (current: string, changes: readonly ByteChange[], maxChars?: number) => string = (current: string, changes: readonly ByteChange[], maxChars?: number): string => {
    const encoder: TextEncoder = new TextEncoder();
    const original: Uint8Array = encoder.encode(current);
    const ordered: ByteChange[] = [...changes].sort((left: ByteChange, right: ByteChange): number => right.offsetBytes - left.offsetBytes);
    ordered.forEach((change: ByteChange): void => {
        if (!Number.isSafeInteger(change.offsetBytes) || !Number.isSafeInteger(change.endBytes)) {
            fail("invalid_arguments");
        }
        if (change.offsetBytes < 0 || change.endBytes < change.offsetBytes || change.endBytes > original.length) {
            fail("invalid_arguments");
        }
        if (isContinuationByte(original, change.offsetBytes) || isContinuationByte(original, change.endBytes)) {
            fail("invalid_arguments");
        }
    });
    /**
     * Reject overlapping or co-located ranges before splicing: they have no
     * order-independent meaning, and accepting them would silently drop one
     * edit depending on array order. Adjacent ranges (`end === next.offset`)
     * are still legal because they do not intersect.
     */
    for (let index: number = 1; index < ordered.length; index += 1) {
        if (ordered[index].endBytes > ordered[index - 1].offsetBytes || ordered[index].offsetBytes === ordered[index - 1].offsetBytes) {
            fail("invalid_arguments");
        }
    }
    let bytes: Uint8Array = original;
    ordered.forEach((change: ByteChange): void => {
        const insert: Uint8Array = encoder.encode(change.content);
        const next: Uint8Array = new Uint8Array(bytes.length - (change.endBytes - change.offsetBytes) + insert.length);
        next.set(bytes.subarray(0, change.offsetBytes), 0);
        next.set(insert, change.offsetBytes);
        next.set(bytes.subarray(change.endBytes), change.offsetBytes + insert.length);
        bytes = next;
    });
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        fail("invalid_arguments");
    }
    return enforceMaxChars(text, maxChars);
};

/**
 * Summarise the diff between two texts without carrying line content.
 *
 * Delegates to `diffText` so the counts, truncation flag and hunk coordinates
 * match the hook layer exactly; only the hunk geometry is projected.
 *
 * @param path - Root-relative path the diff describes.
 * @param before - Original text.
 * @param after - New text.
 * @param contextLines - Unchanged lines kept on each side, 3 when omitted.
 * @returns Counts, truncation flag and hunk geometry.
 */
export const summarizeDiff: (path: string, before: string, after: string, contextLines?: number) => DiffSummary = (path: string, before: string, after: string, contextLines?: number): DiffSummary => {
    const result: DiffResult = diffText(path, before, after, { context: contextLines ?? 3 });
    const hunks: DiffHunkSummary[] = result.hunks.map((hunk: DiffHunk): DiffHunkSummary => ({
        beforeStart: hunk.beforeStart,
        beforeLines: hunk.beforeLines,
        afterStart: hunk.afterStart,
        afterLines: hunk.afterLines,
    }));
    return { added: result.added, removed: result.removed, unchanged: result.unchanged, truncated: result.truncated, hunks };
};
