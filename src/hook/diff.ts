/**
 * Line diff for the workspace hook layer.
 *
 * The implementation is a linear-space LCS (Hirschberg) rather than a full
 * dynamic-programming matrix: two 5000-line inputs would otherwise allocate a
 * 25M-cell table and a diff of two generated files could exhaust the worker.
 * Hirschberg keeps only two `Int32Array` rows at a time and still reconstructs
 * the actual match list, so hunks stay stable and ordered rather than merely
 * reporting counts.
 *
 * The result is bounded by {@link DiffMaxLines}. A larger input is diffed on
 * its first 5000 lines and reports `truncated: true`; the fingerprints always
 * cover the whole input, so a truncated display is never mistaken for an
 * unchanged file.
 *
 * Every hunk line carries both coordinates. `beforeLine` and `afterLine` are
 * 1-based; on an added line `beforeLine` is the insertion point in the original
 * file, and on a removed line `afterLine` is the insertion point in the new
 * file. That makes it possible to render either side without re-counting.
 */
import { rawTextDigest } from "../fingerprint/raw.ts";

/**
 * Diff line kind. `context` lines are equal on both sides.
 */
export type DiffLineType = "add" | "remove" | "context";

/**
 * One diff line. See the module comment for the coordinate rules.
 */
export interface DiffLine {
    readonly type: DiffLineType;
    readonly text: string;
    readonly beforeLine: number;
    readonly afterLine: number;
}

/**
 * One contiguous changed region plus its context lines.
 */
export interface DiffHunk {
    readonly beforeStart: number;
    readonly beforeLines: number;
    readonly afterStart: number;
    readonly afterLines: number;
    readonly lines: readonly DiffLine[];
}

/**
 * Request accepted by `useDiff`. `before` overrides the current file as the
 * old side, and `content` overrides it as the new side; an omitted side is
 * read from the session. With both omitted the file is compared against itself
 * and therefore has no hunks.
 */
export interface DiffRequest {
    readonly path: string;
    readonly content?: string;
    readonly before?: string;
    readonly context?: number;
}

/**
 * Complete diff result.
 */
export interface DiffResult {
    readonly path: string;
    readonly beforeFingerprint: string;
    readonly afterFingerprint: string;
    readonly added: number;
    readonly removed: number;
    readonly unchanged: number;
    readonly hunks: readonly DiffHunk[];
    readonly truncated: boolean;
}

/**
 * One side of a diff. Fingerprints and truncation are carried explicitly so a
 * caller that read the file page by page does not have to reconstruct them.
 */
export interface DiffSource {
    readonly lines: readonly string[];
    readonly fingerprint: string;
    readonly truncated: boolean;
}

/**
 * Options for a diff computation.
 */
export interface DiffOptions {
    readonly context?: number;
}

/**
 * Maximum number of lines diffed per side. Beyond this the computation is
 * bounded and the result says `truncated`.
 */
export const DiffMaxLines: number = 5000;

/**
 * Default number of unchanged lines kept on each side of a change.
 */
export const DiffDefaultContext: number = 3;

/**
 * Hard ceiling for a caller-supplied context size.
 */
export const DiffMaxContext: number = 20;

/**
 * Split text into logical lines. A trailing newline terminates the last line
 * rather than creating an empty one; `\r` is stripped so CRLF files diff
 * cleanly against LF content.
 *
 * @param text - Text to split.
 * @returns Lines without terminators.
 */
export const splitDiffLines: (text: string) => string[] = (text: string): string[] => {
    if (text.length === 0) {
        return [];
    }
    const lines: string[] = text.split("\n");
    if (lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines.map((line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line));
};

/**
 * Build a diff source from caller-supplied text. The fingerprint covers the
 * exact input, including its trailing newline.
 *
 * @param text - Whole text.
 * @returns Source lines, fingerprint and truncation flag.
 */
export const textDiffSource: (text: string) => DiffSource = (text: string): DiffSource => ({
    lines: splitDiffLines(text),
    fingerprint: rawTextDigest(text),
    truncated: false,
});

/**
 * The two line arrays one LCS computation works on.
 */
interface LcsSides {
    readonly a: readonly string[];
    readonly b: readonly string[];
}

/**
 * Forward LCS row for `a[aStart..aEnd)` against `b[bStart..bEnd)`.
 *
 * @returns Row where index `k` is the LCS length for the first `k` items of b.
 */
const lcsForward: (sides: LcsSides, aStart: number, aEnd: number, bStart: number, bEnd: number) => Int32Array = (sides: LcsSides, aStart: number, aEnd: number, bStart: number, bEnd: number): Int32Array => {
    const a: readonly string[] = sides.a;
    const b: readonly string[] = sides.b;
    const width: number = bEnd - bStart;
    let previous: Int32Array = new Int32Array(width + 1);
    let current: Int32Array = new Int32Array(width + 1);
    for (let index: number = aStart; index < aEnd; index += 1) {
        current[0] = 0;
        const left: string = a[index];
        for (let column: number = 1; column <= width; column += 1) {
            if (left === b[bStart + column - 1]) {
                current[column] = previous[column - 1] + 1;
            } else {
                current[column] = Math.max(previous[column], current[column - 1]);
            }
        }
        const swap: Int32Array = previous;
        previous = current;
        current = swap;
    }
    return previous;
};

/**
 * Backward LCS row. Index `k` is the LCS length of the suffix paired with the
 * last `k` items of b, which is what makes a Hirschberg split possible.
 */
const lcsBackward: (sides: LcsSides, aStart: number, aEnd: number, bStart: number, bEnd: number) => Int32Array = (sides: LcsSides, aStart: number, aEnd: number, bStart: number, bEnd: number): Int32Array => {
    const a: readonly string[] = sides.a;
    const b: readonly string[] = sides.b;
    const width: number = bEnd - bStart;
    let previous: Int32Array = new Int32Array(width + 1);
    let current: Int32Array = new Int32Array(width + 1);
    for (let index: number = aEnd - 1; index >= aStart; index -= 1) {
        current[0] = 0;
        const left: string = a[index];
        for (let column: number = 1; column <= width; column += 1) {
            if (left === b[bEnd - column]) {
                current[column] = previous[column - 1] + 1;
            } else {
                current[column] = Math.max(previous[column], current[column - 1]);
            }
        }
        const swap: Int32Array = previous;
        previous = current;
        current = swap;
    }
    return previous;
};

/**
 * Collect the matched index pairs of one LCS in order.
 *
 * The recursion splits `a` in half, picks the `b` split that maximises the sum
 * of the forward and backward LCS lengths, and recurses on both halves. Memory
 * stays O(|b|) and the result is the same match list a full LCS table would
 * produce.
 *
 * @param sides - Both line arrays.
 * @param aStart - Inclusive start in `a`.
 * @param aEnd - Exclusive end in `a`.
 * @param bStart - Inclusive start in `b`.
 * @param bEnd - Exclusive end in `b`.
 * @param matchA - Output indices in `a`.
 * @param matchB - Output indices in `b`.
 */
const collectMatches: (sides: LcsSides, aStart: number, aEnd: number, bStart: number, bEnd: number, matchA: number[], matchB: number[]) => void = (sides: LcsSides, aStart: number, aEnd: number, bStart: number, bEnd: number, matchA: number[], matchB: number[]): void => {
    if (aStart >= aEnd || bStart >= bEnd) {
        return;
    }
    const a: readonly string[] = sides.a;
    const b: readonly string[] = sides.b;
    if (aEnd - aStart === 1) {
        for (let index: number = bStart; index < bEnd; index += 1) {
            if (a[aStart] === b[index]) {
                matchA.push(aStart);
                matchB.push(index);
                return;
            }
        }
        return;
    }
    const middle: number = Math.floor((aStart + aEnd) / 2);
    const forward: Int32Array = lcsForward(sides, aStart, middle, bStart, bEnd);
    const backward: Int32Array = lcsBackward(sides, middle, aEnd, bStart, bEnd);
    const width: number = bEnd - bStart;
    let split: number = 0;
    let best: number = -1;
    for (let column: number = 0; column <= width; column += 1) {
        const score: number = forward[column] + backward[width - column];
        if (score > best) {
            best = score;
            split = column;
        }
    }
    collectMatches(sides, aStart, middle, bStart, bStart + split, matchA, matchB);
    collectMatches(sides, middle, aEnd, bStart + split, bEnd, matchA, matchB);
};

/**
 * Turn two line arrays into an ordered operation list with 1-based counters.
 *
 * @param before - Original lines.
 * @param after - New lines.
 * @returns Diff lines in document order.
 */
const diffSequences: (before: readonly string[], after: readonly string[]) => DiffLine[] = (before: readonly string[], after: readonly string[]): DiffLine[] => {
    const matchA: number[] = [];
    const matchB: number[] = [];
    collectMatches({ a: before, b: after }, 0, before.length, 0, after.length, matchA, matchB);
    const lines: DiffLine[] = [];
    let beforeIndex: number = 0;
    let afterIndex: number = 0;
    let beforeLine: number = 1;
    let afterLine: number = 1;
    for (let index: number = 0; index < matchA.length; index += 1) {
        const targetA: number = matchA[index];
        const targetB: number = matchB[index];
        while (beforeIndex < targetA) {
            lines.push({ type: "remove", text: before[beforeIndex], beforeLine, afterLine });
            beforeIndex += 1;
            beforeLine += 1;
        }
        while (afterIndex < targetB) {
            lines.push({ type: "add", text: after[afterIndex], beforeLine, afterLine });
            afterIndex += 1;
            afterLine += 1;
        }
        lines.push({ type: "context", text: before[beforeIndex], beforeLine, afterLine });
        beforeIndex += 1;
        afterIndex += 1;
        beforeLine += 1;
        afterLine += 1;
    }
    while (beforeIndex < before.length) {
        lines.push({ type: "remove", text: before[beforeIndex], beforeLine, afterLine });
        beforeIndex += 1;
        beforeLine += 1;
    }
    while (afterIndex < after.length) {
        lines.push({ type: "add", text: after[afterIndex], beforeLine, afterLine });
        afterIndex += 1;
        afterLine += 1;
    }
    return lines;
};

/**
 * Group a flat operation list into hunks with at most `context` unchanged
 * lines on either side. Two changes separated by at most `2 * context`
 * unchanged lines share one hunk.
 *
 * @param lines - Flat diff lines.
 * @param context - Unchanged lines retained on each side.
 * @returns Hunks in document order.
 */
const buildHunks: (lines: readonly DiffLine[], context: number) => DiffHunk[] = (lines: readonly DiffLine[], context: number): DiffHunk[] => {
    const changes: number[] = [];
    for (let index: number = 0; index < lines.length; index += 1) {
        if (lines[index].type !== "context") {
            changes.push(index);
        }
    }
    const hunks: DiffHunk[] = [];
    let index: number = 0;
    while (index < changes.length) {
        const start: number = Math.max(0, changes[index] - context);
        let last: number = changes[index];
        let next: number = index + 1;
        while (next < changes.length && changes[next] - last <= context * 2 + 1) {
            last = changes[next];
            next += 1;
        }
        const end: number = Math.min(lines.length, last + context + 1);
        const slice: readonly DiffLine[] = lines.slice(start, end);
        let beforeCount: number = 0;
        let afterCount: number = 0;
        for (let cursor: number = 0; cursor < slice.length; cursor += 1) {
            if (slice[cursor].type !== "add") {
                beforeCount += 1;
            }
            if (slice[cursor].type !== "remove") {
                afterCount += 1;
            }
        }
        hunks.push({
            beforeStart: slice[0].beforeLine,
            beforeLines: beforeCount,
            afterStart: slice[0].afterLine,
            afterLines: afterCount,
            lines: slice,
        });
        index = next;
    }
    return hunks;
};

/**
 * Clamp a context request into `[0, DiffMaxContext]`.
 *
 * @param value - Caller context, or `undefined` for the default.
 * @returns Effective context size.
 */
const contextOf: (value: number | undefined) => number = (value: number | undefined): number => {
    if (value === (void 0) || !Number.isSafeInteger(value)) {
        return DiffDefaultContext;
    }
    return Math.min(DiffMaxContext, Math.max(0, value));
};

/**
 * Diff two prepared sources. The fingerprints on the result always cover the
 * whole input, even when the diff was truncated to `DiffMaxLines`.
 *
 * @param path - Root-relative path the result describes.
 * @param before - Original side.
 * @param after - New side.
 * @param context - Unchanged lines retained on each side.
 * @returns Diff result with counts and hunks.
 */
export const diffSources: (path: string, before: DiffSource, after: DiffSource, context?: number) => DiffResult = (path: string, before: DiffSource, after: DiffSource, context: number = DiffDefaultContext): DiffResult => {
    const boundedContext: number = contextOf(context);
    const beforeTruncated: boolean = before.lines.length > DiffMaxLines;
    const afterTruncated: boolean = after.lines.length > DiffMaxLines;
    const beforeLines: readonly string[] = beforeTruncated ? before.lines.slice(0, DiffMaxLines) : before.lines;
    const afterLines: readonly string[] = afterTruncated ? after.lines.slice(0, DiffMaxLines) : after.lines;
    const lines: DiffLine[] = diffSequences(beforeLines, afterLines);
    let added: number = 0;
    let removed: number = 0;
    let unchanged: number = 0;
    for (let index: number = 0; index < lines.length; index += 1) {
        if (lines[index].type === "add") {
            added += 1;
        } else if (lines[index].type === "remove") {
            removed += 1;
        } else {
            unchanged += 1;
        }
    }
    return {
        path,
        beforeFingerprint: before.fingerprint,
        afterFingerprint: after.fingerprint,
        added,
        removed,
        unchanged,
        hunks: buildHunks(lines, boundedContext),
        truncated: before.truncated || after.truncated || beforeTruncated || afterTruncated,
    };
};

/**
 * Diff two texts directly.
 *
 * @param path - Root-relative path the result describes.
 * @param before - Original text.
 * @param after - New text.
 * @param options - Context size.
 * @returns Diff result.
 */
export const diffText: (path: string, before: string, after: string, options?: DiffOptions) => DiffResult = (path: string, before: string, after: string, options: DiffOptions = {}): DiffResult =>
    diffSources(path, textDiffSource(before), textDiffSource(after), options.context);
