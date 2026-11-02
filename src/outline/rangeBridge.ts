/**
 * Bridge outline ranges into the file read/write addressing contract.
 *
 * An outline node owns a `SourceRange`: half-open UTF-8 bytes and inclusive
 * 1-based lines, both `bigint`, measured against the raw file. The workspace
 * `read`, `write` and `diff_write` tools address the same file with `number`
 * fields, and byte mode counts the *decoded* text: a UTF-8 BOM is stripped
 * before decoding, so an outline byte offset is exactly `bomLength` bytes ahead
 * of the write tool's offset for the same character.
 *
 * This module is the single place that conversion happens, so a caller never
 * repeats the arithmetic. Every conversion fails closed instead of clamping:
 * a range that cannot be represented exactly, out of file bounds, or below the
 * BOM prefix is reported as a typed error code rather than a silently shifted
 * write.
 */
import type { Charset } from "../syntax/types.ts";
import type { OutlineRange } from "./types.ts";

/**
 * Closed error codes for a range that cannot address a read or a write.
 */
export type OutlineRangeErrorCode = "invalid_range" | "range_out_of_bounds" | "range_not_representable";

/**
 * Rejected conversion. `code` is intentionally a closed set so the workspace
 * tool layer can map it to `invalid_arguments` without inspecting messages.
 */
export class OutlineRangeError extends Error {
    readonly code: OutlineRangeErrorCode;
    constructor(code: OutlineRangeErrorCode) {
        super(code);
        this.name = "OutlineRangeError";
        this.code = code;
    }
}

/**
 * Line addressing for `read` (`startLine`/`maxLines`) and for `write` /
 * `diff_write` (`startLine`/`endLine`).
 */
export interface OutlineLineRange {
    readonly startLine: number;
    readonly endLine: number;
    /** Line count of the inclusive span, always at least one. */
    readonly lineCount: number;
}

/**
 * Byte addressing for `read` (`offsetBytes`/`maxBytes`) and for `write` /
 * `diff_write` (`offsetBytes`/`endBytes`), in decoded-text UTF-8 bytes.
 */
export interface OutlineByteRange {
    readonly offsetBytes: number;
    readonly endBytes: number;
    /** Byte length of the half-open span. */
    readonly byteLength: number;
}

/**
 * Both addresses of one outline node, ready for a read or a write call.
 */
export interface OutlineAddress {
    readonly lineRange: OutlineLineRange;
    readonly byteRange: OutlineByteRange;
    /** Raw-file BOM prefix that was removed from the byte address. */
    readonly bomOffset: number;
}

const fail: (code: OutlineRangeErrorCode) => never = (code: OutlineRangeErrorCode): never => {
    throw new OutlineRangeError(code);
};

/**
 * Convert one nonnegative bigint to a number without losing precision.
 * `Number.MAX_SAFE_INTEGER` is left in place, not clamped, because a clamp
 * would silently address a shorter span than the outline reported.
 */
const exact = (value: bigint, code: OutlineRangeErrorCode): number => {
    if (typeof(value) !== "bigint") {
        return fail("invalid_range");
    }
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        return fail(code);
    }
    return Number(value);
};

/**
 * Raw-file byte prefix stripped by decoding: three for `utf-8-bom`, zero for
 * every other charset. UTF-16 and latin1 outlines keep decoded-UTF-8 byte
 * offsets (documented as approximate), so they need no shift either.
 */
export const outlineBomOffset: (charset: Charset | "utf-8") => number = (charset: Charset | "utf-8"): number =>
    charset === "utf-8-bom" ? 3 : 0;

/**
 * Convert an inclusive line range. `totalLines`, when supplied, bounds the end
 * so an outline range that runs past the file is rejected instead of producing
 * a write the service would refuse anyway.
 *
 * @param range - Outline range (or any `SourceRange`).
 * @param totalLines - Optional decoded line count of the current file.
 * @returns 1-based inclusive line address.
 */
export const outlineLineRange: (range: OutlineRange, totalLines?: number) => OutlineLineRange = (
    range: OutlineRange, totalLines?: number,
): OutlineLineRange => {
    const startLine: number = exact(range.startLine, "range_not_representable");
    const endLine: number = exact(range.endLine, "range_not_representable");
    if (startLine < 1 || endLine < startLine) {
        return fail("invalid_range");
    }
    if (totalLines !== (void 0) && (!Number.isSafeInteger(totalLines) || totalLines < 0)) {
        return fail("invalid_range");
    }
    if (totalLines !== (void 0) && endLine > Math.max(1, totalLines)) {
        return fail("range_out_of_bounds");
    }
    return { startLine, endLine, lineCount: endLine - startLine + 1 };
};

/**
 * Convert a half-open byte range into the decoded-text coordinates the write
 * tool uses. The BOM prefix is removed from both ends; a range that lies
 * entirely inside the BOM has no writable counterpart and is rejected.
 *
 * @param range - Outline range measured against the raw file.
 * @param charset - Charset reported for that file.
 * @param totalBytes - Optional decoded-text byte length used as an upper bound.
 * @returns Half-open decoded byte address.
 */
export const outlineByteRange: (range: OutlineRange, charset: Charset | "utf-8", totalBytes?: number) => OutlineByteRange = (
    range: OutlineRange, charset: Charset | "utf-8", totalBytes?: number,
): OutlineByteRange => {
    const bom: number = outlineBomOffset(charset);
    const start: number = exact(range.startByte, "range_not_representable");
    const end: number = exact(range.endByte, "range_not_representable");
    if (end < start || start < bom || end < bom) {
        return fail("invalid_range");
    }
    if (totalBytes !== (void 0) && (!Number.isSafeInteger(totalBytes) || totalBytes < 0)) {
        return fail("invalid_range");
    }
    const offsetBytes: number = start - bom;
    const endBytes: number = end - bom;
    if (totalBytes !== (void 0) && endBytes > totalBytes) {
        return fail("range_out_of_bounds");
    }
    return { offsetBytes, endBytes, byteLength: endBytes - offsetBytes };
};

/**
 * Current-file bounds used to reject an outdated outline range.
 */
export interface OutlineRangeBounds {
    readonly totalLines?: number;
    readonly totalBytes?: number;
}

/**
 * Convert both addresses of one node at once.
 *
 * @param range - The node's outline range.
 * @param charset - Charset of its containing file.
 * @param bounds - Optional current line and decoded byte counts.
 * @returns Line and byte addresses plus the BOM prefix that was removed.
 */
export const outlineAddress: (range: OutlineRange, charset: Charset | "utf-8", bounds?: OutlineRangeBounds) => OutlineAddress = (
    range: OutlineRange, charset: Charset | "utf-8", bounds: OutlineRangeBounds = {},
): OutlineAddress => ({
    lineRange: outlineLineRange(range, bounds.totalLines),
    byteRange: outlineByteRange(range, charset, bounds.totalBytes),
    bomOffset: outlineBomOffset(charset),
});

/**
 * Read request fields for one node. `read` pages forward, so the caller passes
 * `maxLines`/`maxBytes` from its own budget; the returned count is the whole
 * node, which a caller can compare with what came back.
 *
 * @param address - Result of `outlineAddress`.
 * @returns Line-mode `read` fields.
 */
export const readLineRequest: (address: OutlineAddress) => OutlineReadLine = (address: OutlineAddress): OutlineReadLine => ({ startLine: address.lineRange.startLine, maxLines: address.lineRange.lineCount });

/**
 * Read request fields for one node in byte mode.
 *
 * @param address - Result of `outlineAddress`.
 * @returns Byte-mode `read` fields.
 */
export type OutlineReadLine = { readonly startLine: number; readonly maxLines: number; };
export type OutlineReadByte = { readonly offsetBytes: number; readonly maxBytes: number; };
export type OutlineWriteLine = { readonly startLine: number; readonly endLine: number; };
export type OutlineWriteByte = { readonly offsetBytes: number; readonly endBytes: number; };

export const readByteRequest: (address: OutlineAddress) => OutlineReadByte = (address: OutlineAddress): OutlineReadByte => ({ offsetBytes: address.byteRange.offsetBytes, maxBytes: Math.max(1, address.byteRange.byteLength) });

/**
 * Write request fields that replace exactly the node's lines.
 *
 * @param address - Result of `outlineAddress`.
 * @returns Line-mode `write` fields.
 */
export const writeLineRequest: (address: OutlineAddress) => OutlineWriteLine = (address: OutlineAddress): OutlineWriteLine => ({ startLine: address.lineRange.startLine, endLine: address.lineRange.endLine });

/**
 * Write request fields that replace exactly the node's bytes.
 *
 * @param address - Result of `outlineAddress`.
 * @returns Byte-mode `write` fields.
 */
export const writeByteRequest: (address: OutlineAddress) => { readonly offsetBytes: number; readonly endBytes: number; } = (
    address: OutlineAddress,
): { readonly offsetBytes: number; readonly endBytes: number; } => ({ offsetBytes: address.byteRange.offsetBytes, endBytes: address.byteRange.endBytes });
