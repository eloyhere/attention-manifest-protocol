/**
 * Outline range → read/write bridge boundary checks.
 *
 * A node's outline range must address exactly the same span the workspace read
 * and write tools use, including the UTF-8 BOM offset, half-open bytes and
 * inclusive lines. The final tests feed the converted address back into the
 * real splice helpers so a passing conversion cannot disagree with the tool.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyByteChanges, applyLineChanges } from "../src/context/workspaceDiff.ts";
import { outlineAddress, outlineBomOffset, outlineByteRange, outlineLineRange, readByteRequest, readLineRequest, writeByteRequest, writeLineRequest } from "../src/outline/rangeBridge.ts";
import { OutlineRangeError } from "../src/outline/rangeBridge.ts";

const range = (startByte: bigint, endByte: bigint, startLine: bigint, endLine: bigint) => ({ startByte, endByte, startLine, endLine });

/**
 * 0-based UTF-16 offsets of every line start, the same rule the workspace read
 * and write paths use.
 */
const lineStarts = (text: string): number[] => {
    const starts: number[] = [0];
    for (let index: number = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) starts.push(index + 1);
    }
    return starts;
};
const code = (error: unknown): string => error instanceof OutlineRangeError ? error.code : `unexpected:${String(error)}`;

test("BOM offsets: utf-8-bom subtracts the prefix, other charsets do not", (): void => {
    assert.equal(outlineBomOffset("utf-8-bom"), 3);
    for (const charset of ["utf-8", "utf-16le", "utf-16be", "latin1", "none"] as const) assert.equal(outlineBomOffset(charset), 0);
    const decoded = outlineByteRange(range(9n, 20n, 2n, 2n), "utf-8-bom");
    assert.deepEqual(decoded, { offsetBytes: 6, endBytes: 17, byteLength: 11 });
    const plain = outlineByteRange(range(9n, 20n, 2n, 2n), "utf-8");
    assert.deepEqual(plain, { offsetBytes: 9, endBytes: 20, byteLength: 11 });
    const full = outlineAddress(range(3n, 10n, 1n, 2n), "utf-8-bom");
    assert.equal(full.bomOffset, 3);
    assert.deepEqual(full.byteRange, { offsetBytes: 0, endBytes: 7, byteLength: 7 });
});

test("a range wholly inside the BOM has no writable address", (): void => {
    assert.throws(() => outlineByteRange(range(1n, 3n, 1n, 1n), "utf-8-bom"), (error: unknown): boolean => code(error) === "invalid_range");
    assert.doesNotThrow(() => outlineByteRange(range(3n, 3n, 1n, 1n), "utf-8-bom"));
});

test("invalid, reversed and representability edges fail closed instead of clamping", (): void => {
    assert.throws(() => outlineLineRange(range(0n, 1n, 0n, 1n)), (error: unknown): boolean => code(error) === "invalid_range");
    assert.throws(() => outlineLineRange(range(0n, 1n, 3n, 2n)), (error: unknown): boolean => code(error) === "invalid_range");
    assert.throws(() => outlineLineRange(range(0n, 5n, 1n, 2n), 1), (error: unknown): boolean => code(error) === "range_out_of_bounds");
    assert.throws(() => outlineByteRange(range(4n, 2n, 1n, 1n), "utf-8"), (error: unknown): boolean => code(error) === "invalid_range");
    assert.throws(() => outlineByteRange(range(0n, 5n, 1n, 1n), "utf-8", 4), (error: unknown): boolean => code(error) === "range_out_of_bounds");
    const huge: bigint = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    assert.throws(() => outlineLineRange(range(0n, 1n, 1n, huge)), (error: unknown): boolean => code(error) === "range_not_representable");
    assert.throws(() => outlineByteRange(range(huge, huge + 1n, 1n, 1n), "utf-8"), (error: unknown): boolean => code(error) === "range_not_representable");
    const max: number = Number.MAX_SAFE_INTEGER;
    assert.equal(outlineLineRange(range(0n, 1n, 1n, BigInt(max)), max).endLine, max);
    assert.throws(() => outlineLineRange(range(0n, 1n, 1n, 1n), Number.NaN), (error: unknown): boolean => code(error) === "invalid_range");
    assert.throws(() => outlineLineRange(range(0n, 1n, 1n, 1n), -1), (error: unknown): boolean => code(error) === "invalid_range");
    assert.throws(() => outlineLineRange({ startLine: 0 as unknown as bigint, endLine: 1n, startByte: 0n, endByte: 0n }), (error: unknown): boolean => code(error) === "invalid_range");
});

test("a single-line node reports one line and a positive read budget", (): void => {
    const one = outlineAddress(range(4n, 9n, 2n, 2n), "utf-8");
    assert.deepEqual(one.lineRange, { startLine: 2, endLine: 2, lineCount: 1 });
    assert.deepEqual(readLineRequest(one), { startLine: 2, maxLines: 1 });
    assert.deepEqual(readByteRequest(one), { offsetBytes: 4, maxBytes: 5 });
    const empty = outlineAddress(range(4n, 4n, 2n, 2n), "utf-8");
    assert.deepEqual(readByteRequest(empty), { offsetBytes: 4, maxBytes: 1 });
});

test("an empty file and a zero-length node still convert without throwing", (): void => {
    const empty = outlineAddress(range(0n, 0n, 1n, 1n), "utf-8", { totalLines: 0, totalBytes: 0 });
    assert.deepEqual(empty.lineRange, { startLine: 1, endLine: 1, lineCount: 1 });
    assert.deepEqual(readLineRequest(empty), { startLine: 1, maxLines: 1 });
    const bomOnly = outlineAddress(range(3n, 3n, 1n, 1n), "utf-8-bom", { totalBytes: 0 });
    assert.deepEqual(bomOnly.byteRange, { offsetBytes: 0, endBytes: 0, byteLength: 0 });
});

test("a converted line address selects exactly the node text in the write path", (): void => {
    const text: string = "package a;\n\nclass Box {\n  name = \"x\";\n}\n";
    const starts: number[] = lineStarts(text);
    // Node "class Box" spans lines 3-5.
    const address = outlineAddress(range(0n, 0n, 3n, 5n), "utf-8", { totalLines: starts.length - 1 });
    const { startLine, endLine } = writeLineRequest(address);
    assert.equal(startLine, 3);
    assert.equal(endLine, 5);
    const replaced: string = applyLineChanges(text, [{ startLine, endLine, content: "class Box {\n}\n" }]);
    assert.equal(replaced, "package a;\n\nclass Box {\n}\n");
    const removed: string = applyLineChanges(text, [{ startLine, endLine, content: "" }]);
    assert.equal(removed, "package a;\n\n");
});

test("a converted byte address splices exactly the node bytes, BOM included", (): void => {
    const decoded: string = "alpha\nβeta\ngamma\n";
    const withBom: Uint8Array = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(decoded)]);
    // Outline measures the raw file: "βeta" starts after "alpha\n" plus the BOM.
    const prefixBytes: number = 3 + Buffer.byteLength("alpha\n", "utf8");
    const betaBytes: number = Buffer.byteLength("βeta\n", "utf8");
    const address = outlineAddress(range(BigInt(prefixBytes), BigInt(prefixBytes + betaBytes), 2n, 2n), "utf-8-bom", { totalBytes: Buffer.byteLength(decoded, "utf8") });
    assert.equal(address.byteRange.offsetBytes, Buffer.byteLength("alpha\n", "utf8"));
    const { offsetBytes, endBytes } = writeByteRequest(address);
    assert.equal(new TextDecoder().decode(withBom.subarray(offsetBytes + 3, endBytes + 3)), "βeta\n");
    const spliced: string = applyByteChanges(decoded, [{ offsetBytes, endBytes, content: "δέλτα\n" }]);
    assert.equal(spliced, "alpha\nδέλτα\ngamma\n");
});

test("line and byte addresses of the same node describe the same text", (): void => {
    const text: string = "// 中文注释\nfunction add(a, b) {\n  return a + b;\n}\n";
    const encoded: Uint8Array = new TextEncoder().encode(text);
    const starts: number[] = lineStarts(text);
    const startLine: number = 2;
    const endLine: number = 4;
    const startByte: bigint = BigInt(Buffer.byteLength(text.slice(0, starts[startLine - 1]), "utf8"));
    const endByte: bigint = endLine < starts.length ? BigInt(Buffer.byteLength(text.slice(0, starts[endLine]), "utf8")) : BigInt(encoded.length);
    const address = outlineAddress(range(startByte, endByte, BigInt(startLine), BigInt(endLine)), "utf-8", { totalLines: starts.length - 1, totalBytes: encoded.length });
    const byLine: string = text.slice(starts[address.lineRange.startLine - 1], endLine < starts.length ? starts[endLine] : text.length);
    const byByte: string = new TextDecoder().decode(encoded.subarray(address.byteRange.offsetBytes, address.byteRange.endBytes));
    assert.equal(byByte, byLine);
    assert.match(byByte, /^function add/);
});
