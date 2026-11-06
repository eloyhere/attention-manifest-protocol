import { isNumber } from "semantic-typescript";

/**
 * Outline position. Lines are 0-based with an exclusive `endLine`; bytes are
 * UTF-8 offsets into the original source with an exclusive `endByte`.
 */
export interface Range {
    readonly startLine: number;
    readonly endLine: number;
    readonly startByte: number;
    readonly endByte: number;
}

export const emptyRange: Range = Object.freeze({ startLine: 0, endLine: 0, startByte: 0, endByte: 0 });

function isCount(value: unknown): value is number {
    return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

export function isRange(value: unknown): value is Range {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return isCount(candidate.startLine) && isCount(candidate.endLine) && isCount(candidate.startByte) && isCount(candidate.endByte)
        && candidate.endLine >= candidate.startLine && candidate.endByte >= candidate.startByte;
}

export function freezeRange(value: Range): Range {
    if (!isRange(value)) throw new TypeError("invalid range");
    return Object.freeze({ startLine: value.startLine, endLine: value.endLine, startByte: value.startByte, endByte: value.endByte });
}

export function unionRange(left: Range, right: Range): Range {
    return Object.freeze({
        startLine: Math.min(left.startLine, right.startLine), endLine: Math.max(left.endLine, right.endLine),
        startByte: Math.min(left.startByte, right.startByte), endByte: Math.max(left.endByte, right.endByte),
    });
}

/** Incremental line and byte index for one source string. Indices are UTF-16 offsets. */
export class SourceText {
    readonly source: string;
    readonly lineStarts: readonly number[];
    readonly byteOffsets: readonly number[];
    readonly lineCount: number;
    readonly byteLength: number;

    constructor(source: string) {
        if (typeof source !== "string") throw new TypeError("source must be a string");
        this.source = source;
        const starts = [0];
        for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
        this.lineStarts = Object.freeze(starts);
        this.lineCount = starts.length;
        const offsets = new Array<number>(source.length + 1);
        offsets[0] = 0;
        let bytes = 0;
        for (let index = 0; index < source.length;) {
            const point = source.codePointAt(index) ?? 0;
            const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
            const units = point > 0xffff ? 2 : 1;
            bytes += width;
            offsets[index + 1] = bytes;
            if (units === 2) offsets[index + 2] = bytes;
            index += units;
        }
        this.byteOffsets = Object.freeze(offsets);
        this.byteLength = bytes;
    }

    clamp(index: number): number { return Math.min(Math.max(index, 0), this.source.length); }

    lineAt(index: number): number {
        const offset = this.clamp(index);
        let low = 0;
        let high = this.lineStarts.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if ((this.lineStarts[middle] ?? 0) <= offset) low = middle + 1;
            else high = middle;
        }
        return Math.max(0, low - 1);
    }

    byteAt(index: number): number { return this.byteOffsets[this.clamp(index)] ?? this.byteLength; }

    /** Character span to an outline range; a span reaching the end of file includes the trailing line. */
    range(startIndex: number, endIndex: number): Range {
        const start = this.clamp(Math.min(startIndex, endIndex));
        const end = this.clamp(Math.max(startIndex, endIndex));
        const startLine = this.lineAt(start);
        const endLine = end >= this.source.length ? this.lineCount
            : end > start ? this.lineAt(end - 1) + 1 : startLine;
        return Object.freeze({
            startLine, endLine,
            startByte: this.byteAt(start), endByte: this.byteAt(end),
        });
    }

    /** Whole lines, `endLine` exclusive, including their trailing newlines. */
    lineRange(startLine: number, endLine: number): Range {
        const first = Math.min(Math.max(startLine, 0), this.lineCount - 1);
        const last = Math.min(Math.max(endLine, first + 1), this.lineCount);
        const start = this.lineStarts[first] ?? 0;
        const end = last < this.lineCount ? (this.lineStarts[last] ?? this.source.length) : this.source.length;
        return Object.freeze({ startLine: first, endLine: last, startByte: this.byteAt(start), endByte: this.byteAt(end) });
    }
}
