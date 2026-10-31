#!/usr/bin/env node
/**
 * Regression checks for `src/context/workspaceDiff.ts`.
 *
 * Covers whole-line replacement (replace, insert, delete, batch order, CRLF and
 * a file without a trailing newline), UTF-8 byte replacement (replace, insert,
 * delete, multi-byte characters, boundary and bound rejection), the capacity
 * ceiling on both modes, and the `diffText` projection in `summarizeDiff`.
 *
 * Every case calls the real module; there are no fixtures or mocks, because the
 * interesting behaviour is the coordinate arithmetic and that is exactly what a
 * mock would hide.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkspaceDiffError, applyByteChanges, applyLineChanges, summarizeDiff } from "../src/context/workspaceDiff.ts";
import type { ByteChange, DiffSummary, LineChange, WorkspaceDiffCode } from "../src/context/workspaceDiff.ts";

/**
 * Build one whole-line change without repeating the field names.
 */
const lineChange: (startLine: number, endLine: number, content: string) => LineChange = (
    startLine: number,
    endLine: number,
    content: string,
): LineChange => ({ startLine, endLine, content });

/**
 * Build one byte-range change without repeating the field names.
 */
const byteChange: (offsetBytes: number, endBytes: number, content: string) => ByteChange = (
    offsetBytes: number,
    endBytes: number,
    content: string,
): ByteChange => ({ offsetBytes, endBytes, content });

/**
 * Assert that an action fails with one classified code of this module.
 */
const expectCode: (action: () => unknown, code: WorkspaceDiffCode) => void = (action: () => unknown, code: WorkspaceDiffCode): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof WorkspaceDiffError && error.code === code);
};

test("line mode replaces a middle line", (): void => {
    assert.equal(applyLineChanges("a\nb\nc\n", [lineChange(2, 2, "B")]), "a\nB\nc\n");
});

test("line mode replaces a multi-line range", (): void => {
    assert.equal(applyLineChanges("a\nb\nc\nd\n", [lineChange(2, 3, "X")]), "a\nX\nd\n");
    assert.equal(applyLineChanges("a\nb\nc\nd\n", [lineChange(1, 4, "only")]), "only\n");
});

test("line mode inserts lines through a one-line replacement", (): void => {
    assert.equal(applyLineChanges("a\nb\nc\n", [lineChange(2, 2, "b1\nb2")]), "a\nb1\nb2\nc\n");
});

test("line mode deletes lines with empty content", (): void => {
    assert.equal(applyLineChanges("a\nb\nc\n", [lineChange(2, 2, "")]), "a\nc\n");
    assert.equal(applyLineChanges("a\nb\nc\n", [lineChange(1, 2, "")]), "c\n");
});

test("line mode applies two changes bottom-up from unsorted input", (): void => {
    assert.equal(applyLineChanges("a\nb\nc\nd\n", [lineChange(2, 2, "B"), lineChange(4, 4, "D")]), "a\nB\nc\nD\n");
    assert.equal(applyLineChanges("a\nb\nc\nd\n", [lineChange(4, 4, "D"), lineChange(2, 2, "B")]), "a\nB\nc\nD\n");
});

test("line mode preserves CRLF terminators", (): void => {
    assert.equal(applyLineChanges("a\r\nb\r\nc\r\n", [lineChange(2, 2, "B")]), "a\r\nB\r\nc\r\n");
    assert.equal(applyLineChanges("a\r\nb\r\nc\r\n", [lineChange(2, 2, "")]), "a\r\nc\r\n");
});

test("line mode edits a file without a trailing newline", (): void => {
    assert.equal(applyLineChanges("a\nb", [lineChange(2, 2, "B")]), "a\nB");
    assert.equal(applyLineChanges("a\nb", [lineChange(2, 2, "b\nc")]), "a\nb\nc");
    assert.equal(applyLineChanges("solo", [lineChange(1, 1, "one\ntwo")]), "one\ntwo");
});

test("line mode rejects startLine 0", (): void => {
    expectCode((): string => applyLineChanges("a\nb\n", [lineChange(0, 1, "x")]), "invalid_arguments");
});

test("line mode rejects endLine below startLine", (): void => {
    expectCode((): string => applyLineChanges("a\nb\n", [lineChange(2, 1, "x")]), "invalid_arguments");
});

test("line mode rejects endLine beyond EOF", (): void => {
    expectCode((): string => applyLineChanges("a\nb\n", [lineChange(1, 3, "x")]), "invalid_arguments");
    expectCode((): string => applyLineChanges("", [lineChange(1, 1, "x")]), "invalid_arguments");
});

test("line mode validates each change against the intermediate text", (): void => {
    expectCode(
        (): string => applyLineChanges("a\nb\nc\n", [lineChange(3, 3, ""), lineChange(2, 3, "X")]),
        "invalid_arguments",
    );
});

test("line mode returns the input for an empty change list", (): void => {
    assert.equal(applyLineChanges("a\nb\n", []), "a\nb\n");
    assert.equal(applyLineChanges("", []), "");
});

test("line mode enforces maxChars", (): void => {
    expectCode((): string => applyLineChanges("abc\ndef\n", [lineChange(1, 1, "abcdef")], 5), "capacity_exceeded");
    assert.equal(applyLineChanges("a\n", [lineChange(1, 1, "abc")], 4), "abc\n");
});

test("byte mode replaces a range", (): void => {
    assert.equal(applyByteChanges("hello world", [byteChange(6, 11, "there")]), "hello there");
});

test("byte mode inserts at an offset", (): void => {
    assert.equal(applyByteChanges("hello world", [byteChange(5, 5, ",")]), "hello, world");
    assert.equal(applyByteChanges("abc", [byteChange(3, 3, "d")]), "abcd");
    assert.equal(applyByteChanges("abc", [byteChange(0, 0, "x")]), "xabc");
});

test("byte mode deletes a range", (): void => {
    assert.equal(applyByteChanges("hello world", [byteChange(5, 11, "")]), "hello");
    assert.equal(applyByteChanges("abc", [byteChange(0, 3, "")]), "");
});

test("byte mode replaces a whole multi-byte character", (): void => {
    assert.equal(applyByteChanges("café", [byteChange(3, 5, "e")]), "cafe");
    assert.equal(applyByteChanges("a中b", [byteChange(1, 4, "X")]), "aXb");
    assert.equal(applyByteChanges("a中b", [byteChange(4, 4, "Y")]), "a中Yb");
});

test("byte mode rejects an offset inside a multi-byte character", (): void => {
    expectCode((): string => applyByteChanges("café", [byteChange(4, 5, "e")]), "invalid_arguments");
    expectCode((): string => applyByteChanges("a中b", [byteChange(2, 4, "X")]), "invalid_arguments");
    expectCode((): string => applyByteChanges("a中b", [byteChange(0, 2, "X")]), "invalid_arguments");
});

test("byte mode rejects endBytes beyond the buffer", (): void => {
    expectCode((): string => applyByteChanges("abc", [byteChange(0, 4, "x")]), "invalid_arguments");
    expectCode((): string => applyByteChanges("abc", [byteChange(3, 4, "x")]), "invalid_arguments");
});

test("byte mode applies two changes descending from unsorted input", (): void => {
    assert.equal(applyByteChanges("abcdef", [byteChange(1, 2, "B"), byteChange(4, 5, "E")]), "aBcdEf");
    assert.equal(applyByteChanges("abcdef", [byteChange(4, 5, "E"), byteChange(1, 2, "B")]), "aBcdEf");
});

test("byte mode rejects a negative or non-integer offset", (): void => {
    expectCode((): string => applyByteChanges("abc", [byteChange(-1, 2, "x")]), "invalid_arguments");
    expectCode((): string => applyByteChanges("abc", [byteChange(1.5, 2, "x")]), "invalid_arguments");
    expectCode((): string => applyByteChanges("abc", [byteChange(2, 1, "x")]), "invalid_arguments");
});

test("byte mode enforces maxChars", (): void => {
    expectCode((): string => applyByteChanges("abc", [byteChange(3, 3, "de")], 4), "capacity_exceeded");
    assert.equal(applyByteChanges("abc", [byteChange(3, 3, "d")], 4), "abcd");
});

test("summarizeDiff reports identical text without hunks", (): void => {
    const summary: DiffSummary = summarizeDiff("note.txt", "alpha\nbeta\n", "alpha\nbeta\n");
    assert.equal(summary.added, 0);
    assert.equal(summary.removed, 0);
    assert.equal(summary.unchanged, 2);
    assert.equal(summary.truncated, false);
    assert.equal(summary.hunks.length, 0);
});

test("summarizeDiff reports one changed line with 1-based hunk starts", (): void => {
    const summary: DiffSummary = summarizeDiff("note.txt", "l1\nl2\nl3\nl4\nl5\nl6\n", "l1\nl2\nl3\nl4\nL5\nl6\n");
    assert.equal(summary.added, 1);
    assert.equal(summary.removed, 1);
    assert.equal(summary.unchanged, 5);
    assert.equal(summary.truncated, false);
    assert.equal(summary.hunks.length, 1);
    assert.equal(summary.hunks[0].beforeStart, 2);
    assert.equal(summary.hunks[0].afterStart, 2);
    assert.equal(summary.hunks[0].beforeLines, 5);
    assert.equal(summary.hunks[0].afterLines, 5);
});

test("summarizeDiff reports an appended line", (): void => {
    const summary: DiffSummary = summarizeDiff("note.txt", "a\nb\n", "a\nb\nc\n");
    assert.equal(summary.added, 1);
    assert.equal(summary.removed, 0);
    assert.equal(summary.unchanged, 2);
    assert.equal(summary.hunks.length, 1);
    assert.equal(summary.hunks[0].beforeStart, 1);
    assert.equal(summary.hunks[0].beforeLines, 2);
    assert.equal(summary.hunks[0].afterLines, 3);
});

test("summarizeDiff honors contextLines 0", (): void => {
    const summary: DiffSummary = summarizeDiff("note.txt", "a\nb\nc\n", "a\nB\nc\n", 0);
    assert.equal(summary.added, 1);
    assert.equal(summary.removed, 1);
    assert.equal(summary.unchanged, 2);
    assert.equal(summary.hunks.length, 1);
    assert.equal(summary.hunks[0].beforeStart, 2);
    assert.equal(summary.hunks[0].afterStart, 2);
    assert.equal(summary.hunks[0].beforeLines, 1);
    assert.equal(summary.hunks[0].afterLines, 1);
});
