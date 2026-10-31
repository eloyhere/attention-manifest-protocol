/**
 * UTF-8 byte offsets for 1-based line ranges.
 *
 * Outline ranges are persisted and compared across tools, so they use UTF-8
 * byte offsets, matching tree-sitter and SCIP, rather than JavaScript string
 * indices (UTF-16 code units). The segment tree stores the byte length of every
 * line and answers "where does line N start?" as a prefix sum in O(log n),
 * which keeps large-book outlines from rebuilding a byte table per node.
 *
 * Line extents are half-open on bytes (`endByte` is the first byte after the
 * range) and inclusive on lines (`endLine` is the last covered line). A line's
 * byte span includes its trailing newline so consecutive ranges tile the file
 * without gaps.
 */
import { SegmentTree } from "../structure/segmentTree.ts";
import type { SourceRange as OutlineRange } from "./types.ts";

const startsOf: (text: string) => number[] = (text: string): number[] => {
    if (text.length === 0) {
        return [];
    }
    const starts: number[] = [0];
    for (let index: number = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10 && index + 1 < text.length) {
            starts.push(index + 1);
        }
    }
    return starts;
};

export class ByteLineIndex {
    private readonly tree: SegmentTree<number>;
    private readonly starts: readonly number[];
    private readonly text: string;
    private readonly total: bigint;
    /**
     * Bytes before the decoded text (a UTF-8/UTF-16 BOM). Symbol ranges are
     * offsets in the original file, while the decoded text starts after the
     * marker; adding the base here keeps both coordinate systems consistent.
     */
    private readonly base: number;

    constructor(text: string, bomBytes: number = 0) {
        this.text = text;
        this.base = Number.isSafeInteger(bomBytes) && bomBytes > 0 ? bomBytes : 0;
        this.starts = startsOf(text);
        const lengths: number[] = [];
        for (let index: number = 0; index < this.starts.length; index += 1) {
            const from: number = this.starts[index];
            const to: number = index + 1 < this.starts.length ? this.starts[index + 1] : text.length;
            lengths.push(Buffer.byteLength(text.slice(from, to), "utf8"));
        }
        this.total = BigInt(Buffer.byteLength(text, "utf8") + this.base);
        this.tree = new SegmentTree<number>({
            size: lengths.length,
            operation: (left: number, right: number): number => left + right,
            identity: 0,
            values: lengths,
        });
    }

    /**
     * Number of logical lines. The empty file has zero lines.
     */
    get lineCount(): number {
        return this.starts.length;
    }

    /**
     * Start byte offset of a 1-based line. Lines past EOF clamp to the end.
     */
    startByte(line: number): bigint {
        if (line <= 1) {
            return BigInt(this.base);
        }
        const last: number = this.starts.length;
        if (line > last) {
            return this.total;
        }
        return BigInt(this.base + this.tree.query(0, line - 1));
    }

    /**
     * Half-open end byte offset for an inclusive line.
     */
    endByte(line: number): bigint {
        return this.startByte(line + 1);
    }

    /**
     * Byte length of the whole text.
     */
    byteLength(): bigint {
        return this.total;
    }

    /**
     * Build a half-open byte / inclusive line range. Inputs are clamped so a
     * parser can be approximate without producing an invalid range.
     */
    range(startLine: number, endLine: number): OutlineRange {
        const start: number = Math.max(1, Math.min(startLine, Math.max(1, this.starts.length)));
        const end: number = Math.max(start, Math.min(endLine, Math.max(1, this.starts.length)));
        return {
            startByte: this.startByte(start),
            endByte: this.endByte(end),
            startLine: BigInt(start),
            endLine: BigInt(end),
        };
    }

    /**
     * Range covering the entire text; used for a file anchor.
     */
    fullRange(): OutlineRange {
        return {
            startByte: 0n,
            endByte: this.total,
            startLine: 1n,
            endLine: BigInt(Math.max(1, this.starts.length)),
        };
    }

    /**
     * Source slice for a range, useful for a `detail`/signature preview.
     */
    slice(range: OutlineRange): string {
        const from: number = this.offsetOf(range.startByte);
        const to: number = this.offsetOf(range.endByte);
        return this.text.slice(from, to);
    }

    private offsetOf(byteOffset: bigint): number {
        if (byteOffset <= 0n) {
            return 0;
        }
        const target: number = Number(byteOffset);
        if (!Number.isSafeInteger(target) || target >= Number(this.total)) {
            return this.text.length;
        }
        /**
         * Line starts are already sorted, so a binary search over the byte
         * prefix positions is cheaper than another tree walk for one offset.
         */
        let low: number = 0;
        let high: number = this.starts.length - 1;
        while (low < high) {
            const mid: number = Math.ceil((low + high) / 2);
            const midByte: number = Number(this.startByte(mid + 1));
            if (midByte <= target) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        const lineStartByte: number = Number(this.startByte(low + 1));
        return this.starts[low] + (target - lineStartByte);
    }
}
