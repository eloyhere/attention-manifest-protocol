/** Shared source encoding and position contracts. */
export type Charset = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "latin1" | "binary" | "none";

/**
 * Byte/line extent shared by syntax tokens and outline nodes. Lines are 1-based and `endLine` is
 * inclusive; byte offsets are half-open (`endByte` is the first byte after the
 * node). Both are bigint because a book or a generated file can exceed 2^53
 * bytes/lines and an outline is persisted, so a value must not lose precision
 * on the way to SQLite.
 */
export interface SourceRange {
    readonly startByte: bigint;
    readonly endByte: bigint;
    readonly startLine: bigint;
    readonly endLine: bigint;
}

