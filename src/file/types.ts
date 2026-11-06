import type { Identifier } from "../shared.ts";
import type { CharsetInfo } from "./charset.ts";
import type { Range } from "./range.ts";

export interface WorkspaceScope {
    readonly tenantId: Identifier;
    readonly rootId: Identifier;
}

export type WorkspaceMode = "read-only" | "writable";
export type FileState = "unmounted" | "mounted" | "active" | "stale" | "dirty";

export interface FileRef extends WorkspaceScope {
    readonly path: string;
}

export interface StoredFile extends FileRef {
    /** Decoded text with `\n` line endings; `charset` restores the on-disk form. */
    readonly content: string;
    readonly hash: string;
    readonly version: number;
    readonly updatedAt: string;
    /** Encoding, BOM and line-ending facts; absent means UTF-8, LF, no BOM. */
    readonly charset?: CharsetInfo;
    /** On-disk size in bytes. */
    readonly size?: number;
}

export interface FileLease extends FileRef {
    readonly owner: Identifier;
    readonly fence: number;
    readonly token: string;
    readonly expiresAt?: string;
}

export interface FileRangeBounds {
    readonly start: number;
    readonly end: number;
}

export type FileRange =
    | { readonly kind: "byte" | "line"; readonly start: number; readonly end: number }
    | { readonly byte: FileRangeBounds }
    | { readonly line: FileRangeBounds };

/** How a write locates the region it replaces. */
export type WriteMode = "line" | "byte" | "outline";
/** How a replacement locates the region, or regions, it rewrites. */
export type ReplaceMode = "string" | "regex" | "line" | "byte" | "outline";

export interface LineTarget {
    readonly mode: "line";
    /** 0-based start line. */
    readonly start: number;
    /** 0-based end line, exclusive. */
    readonly end: number;
}

export interface ByteTarget {
    readonly mode: "byte";
    /** UTF-8 byte offset, must fall on a code point boundary. */
    readonly start: number;
    /** UTF-8 byte offset, exclusive, must fall on a code point boundary. */
    readonly end: number;
}

export interface OutlineTarget {
    readonly mode: "outline";
    /** Node id from the outline of the current buffer. */
    readonly id: string;
}

export interface StringTarget {
    readonly mode: "string";
    /** Literal text. It is matched exactly, without interpreting escapes or `$` patterns. */
    readonly text: string;
    /** 1-based match ordinal, mutually exclusive with `all`. */
    readonly occurrence?: number;
    /** Rewrite every match instead of requiring exactly one. */
    readonly all?: boolean;
}

export interface RegexTarget {
    readonly mode: "regex";
    readonly pattern: string;
    /** `i`, `m`, `s`, `u`, `v`; the stateful `g` and `y` flags are rejected. */
    readonly flags?: string;
    readonly occurrence?: number;
    readonly all?: boolean;
}

export type WriteTarget = LineTarget | ByteTarget | OutlineTarget;
export type ReplaceTarget = StringTarget | RegexTarget | WriteTarget;

export interface EditOptions {
    /** Reject when the buffer changed since the caller observed this `snapshot().bufferVersion`. */
    readonly expectedBufferVersion?: number;
    /** Reject when the committed base moved away from the hash the caller read. */
    readonly expectedBaseHash?: string;
}

/** One step of a transactional multi-edit; all steps are resolved before anything mutates. */
export type EditOp =
    | { readonly kind: "write"; readonly content: string; readonly target?: FileRange | WriteTarget }
    | { readonly kind: "replace"; readonly target: ReplaceTarget; readonly replacement: string };

/** A bounded line-addressed read that carries the anchors an edit needs. */
export interface LineRead {
    readonly text: string;
    readonly range: Range;
    readonly startLine: number;
    readonly lineCount: number;
    readonly totalLines: number;
    readonly truncated: boolean;
    readonly eol: "\n" | "\r\n";
    readonly baseHash: string;
    readonly bufferVersion: number;
}

export interface FlushOptions {
    /** Retrying with the same key after a successful commit is a no-op. */
    readonly idempotencyKey?: string;
}

/** One resolved region, in document coordinates. */
export interface EditMatch extends Range {
    readonly text: string;
}

/** Dry-run result: the text that `write`/`replace` would produce and the regions it targets. */
export interface EditPlan {
    /** `file` means a whole-buffer write; `apply` is a transactional multi-edit. */
    readonly mode: WriteMode | ReplaceMode | "file" | "apply";
    readonly matches: readonly EditMatch[];
    readonly text: string;
    readonly changed: boolean;
    readonly bufferVersion: number;
}

/** One outline node that an `outline` target may address. */
export interface OutlineEntry {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly range: Range;
}

/** Host-supplied outline of the current buffer; it must be a pure function of `text`. */
export interface OutlineProvider {
    entries(path: string, text: string): readonly OutlineEntry[];
}

export interface MountOptions {
    readonly mode?: WorkspaceMode;
    readonly owner?: Identifier;
    readonly leaseTtlMilliseconds?: number;
    /** Required by `write`/`replace` targets with `mode: "outline"`. */
    readonly outline?: OutlineProvider;
    /** `true` mounts bytes only, `false` refuses non-text files; omitted auto-detects. */
    readonly binary?: boolean;
}

export interface ReadOptions {
    readonly allowStale?: boolean;
}

export interface ReloadOptions {
    readonly discardDirty?: boolean;
}

export interface UnmountOptions {
    readonly discardDirty?: boolean;
}

export interface FileSnapshot extends FileRef {
    readonly state: FileState;
    readonly mode: WorkspaceMode;
    readonly baseHash: string;
    readonly baseVersion: number;
    readonly hash: string;
    readonly version: number;
    readonly bufferVersion: number;
    readonly dirty: boolean;
    readonly stale: boolean;
    readonly encoding: CharsetInfo["encoding"];
    readonly eol: CharsetInfo["eol"];
    readonly bom: boolean;
    /** True when the file is mounted as opaque bytes (proprietary/binary formats). */
    readonly binary: boolean;
    /** On-disk size of the committed version. */
    readonly size: number;
    readonly lease?: FileLease;
}

export interface FileConflict extends FileRef {
    readonly base: StoredFile;
    readonly ours: string;
    readonly theirs: StoredFile;
}

export interface StoredBytes extends FileRef {
    readonly bytes: Uint8Array;
    readonly size: number;
    readonly hash: string;
    readonly version: number;
    readonly updatedAt: string;
}

/**
 * Host port for file bytes. Adapters MUST serialize `compareAndSwap` against concurrent
 * writers: the in-memory adapter is trivially atomic, while a real filesystem adapter needs
 * a cross-process lock plus a hash re-check immediately before the atomic replace.
 */
export interface FileStoragePort {
    read(ref: FileRef): StoredFile | undefined;
    /** Must throw `version_conflict` when the current hash differs; must not partially write. */
    compareAndSwap(ref: FileRef, expectedHash: string, content: string, fence: number): StoredFile;
    acquireLease(ref: FileRef, owner: Identifier, ttlMilliseconds?: number): FileLease;
    releaseLease(lease: FileLease): void;
    /** Optional raw byte access, required only for binary/proprietary formats. */
    readBytes?(ref: FileRef): StoredBytes | undefined;
    /** Optional byte commit; must be atomic and hash-checked like `compareAndSwap`. */
    compareAndSwapBytes?(ref: FileRef, expectedHash: string, bytes: Uint8Array, fence: number): StoredFile;
}
