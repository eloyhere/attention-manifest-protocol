/**
 * Atomic workspace writes with compare-and-swap guards and a write journal.
 *
 * The write path is intentionally conservative:
 *
 * - the target is resolved through the session sandbox before any I/O;
 * - the current fingerprint is computed from the bytes that are actually
 *   present, so `expectFingerprint` is a real CAS rather than a cached guess;
 * - the new bytes go to a same-directory `.amp-*.tmp` file that is `fsync`ed
 *   and renamed over the target, so a reader never observes a half-written
 *   file;
 * - the parent chain is created only when `createParents` is set, and every
 *   created level is re-checked against the sandbox;
 * - `dryRun` performs every check and builds a projected node without touching
 *   the disk.
 *
 * In-process writers serialize on `(sessionId, rootId, relativePath)`. That is
 * not a cross-process lock: a second process is caught by the CAS fingerprint,
 * which is why the journal records both the previous and the next fingerprint.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Hash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";

import type { SessionRoot } from "../session/types.ts";
import { NamedLocks } from "../concurrency/namedLocks.ts";
import { rawDigest } from "../fingerprint/raw.ts";
import { countLines, decodeText, detectCharset, encodeText } from "../syntax/charset.ts";
import type { DetectedCharset } from "../syntax/charset.ts";
import { fail, isFilesystemError } from "./errors.ts";
import { buildFileNode } from "./file.ts";
import { describeFile, extensionOfPath, nameOfPath } from "./metadata.ts";
import type { NodeDescription } from "./metadata.ts";
import type { PathSandbox } from "./path.ts";
import { byteRangeFingerprint, locateLineSpan } from "./read.ts";
import type { LineSpan } from "./read.ts";
import type { Charset } from "../syntax/types.ts";
import type { FileNode, RootedPath, WriteJournalEntry, WriteMode, WriteRequest, WriteResult } from "./types.ts";
import type { WorkspaceTree } from "./tree.ts";
import { creationTime, formatIsoTime, formatNodeTime } from "./time.ts";

/**
 * Default ceiling for the resulting file size, in bytes.
 */
const DefaultWriteBytes: number = 4 * 1024 * 1024;

/**
 * Hard ceiling for the resulting file size, regardless of host configuration.
 */
const MaxWriteBytes: number = 64 * 1024 * 1024;

/**
 * Chunk size used when fingerprinting an existing file without loading it.
 */
const HashChunkBytes: number = 64 * 1024;

/**
 * Text encodings accepted by {@link WriteRequest.encoding}.
 */
type TextEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "latin1";

/**
 * Options for {@link writeFile}.
 *
 * `maxBytes` bounds the *resulting* file size, not the incoming fragment; an
 * append is checked against the old size plus the new bytes. `journal` receives
 * one metadata record per successful non-dry write. `tree` is refreshed after
 * the rename so a workspace snapshot cannot keep the old fingerprint.
 */
export interface WriteOptions {
    readonly maxBytes?: number;
    readonly journal?: (entry: WriteJournalEntry) => void;
    readonly tree?: WorkspaceTree;
    readonly timeZone?: "local" | "utc";
}

/**
 * Context captured before the lock is taken, so the critical section is a pure
 * function of already-validated values.
 */
interface WriteContext {
    readonly sandbox: PathSandbox;
    readonly sessionId: string;
    readonly rooted: RootedPath;
    readonly mode: WriteMode;
    readonly request: WriteRequest;
    readonly content: string | Uint8Array;
    readonly options: WriteOptions;
    readonly maxBytes: number;
    readonly dryRun: boolean;
    readonly createParents: boolean;
    readonly timeZone: "local" | "utc";
}

/**
 * Extract an `errno` code from an unknown thrown value without trusting it.
 */
const errorCode: (error: unknown) => string = (error: unknown): string => {
    if (typeof(error) !== "object" || error === null) {
        return "";
    }
    const code: unknown = (error as { code?: unknown; }).code;
    return typeof(code) === "string" ? code : "";
};

/**
 * Translate a host filesystem failure into the closed domain taxonomy. The
 * original message is dropped on purpose: it embeds absolute paths.
 */
const mapFsError: (error: unknown) => never = (error: unknown): never => {
    if (isFilesystemError(error)) {
        throw error;
    }
    switch (errorCode(error)) {
        case "ENOENT": {
            return fail("not_found");
        }
        case "EEXIST": {
            return fail("already_exists");
        }
        case "EACCES":
        case "EPERM":
        case "EROFS": {
            return fail("permission_denied");
        }
        case "EISDIR": {
            return fail("not_file");
        }
        case "ENOTDIR": {
            return fail("not_directory");
        }
        case "ENAMETOOLONG": {
            return fail("invalid_path");
        }
        case "ELOOP": {
            return fail("symlink_denied");
        }
        case "ENOSPC":
        case "EDQUOT": {
            return fail("quota_exceeded");
        }
        default: {
            return fail("internal_error");
        }
    }
};

/**
 * Run a best-effort cleanup without masking the failure that caused it.
 */
const quietly: (action: () => void) => void = (action: () => void): void => {
    try {
        action();
    } catch {
        return;
    }
};

/**
 * Resolve a positive safe integer option, clamping it to `maximum`.
 *
 * @param value - Caller value, or `undefined` for the default.
 * @param fallback - Default when the value is absent.
 * @param maximum - Inclusive upper bound.
 * @returns The effective value.
 */
const positiveInteger: (value: number | undefined, fallback: number, maximum: number) => number = (value: number | undefined, fallback: number, maximum: number): number => {
    if (value === (void 0)) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < 1) {
        return fail("invalid_arguments");
    }
    return Math.min(value, maximum);
};

/**
 * `lstat` a path that may legitimately be absent.
 */
const statIfExists: (absolute: string) => Stats | undefined = (absolute: string): Stats | undefined => {
    try {
        return lstatSync(absolute);
    } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") {
            return undefined;
        }
        return mapFsError(error);
    }
};

/**
 * `lstat` a path that must exist.
 */
const statOrFail: (absolute: string) => Stats = (absolute: string): Stats => {
    try {
        return lstatSync(absolute);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * Read a file as bytes, translating a failure instead of leaking it.
 */
const readRegularFile: (absolute: string) => Uint8Array = (absolute: string): Uint8Array => {
    try {
        return readFileSync(absolute);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * Hash a file through a fixed-size buffer. Used for the previous fingerprint so
 * overwriting a large file does not require loading it into memory.
 */
const hashRegularFile: (absolute: string) => string = (absolute: string): string => {
    const hash: Hash = createHash("sha256");
    const buffer: Buffer = Buffer.allocUnsafe(HashChunkBytes);
    let descriptor: number | undefined = (void 0);
    try {
        descriptor = openSync(absolute, "r");
        let count: number = readSync(descriptor, buffer, 0, buffer.byteLength, null);
        while (count > 0) {
            hash.update(buffer.subarray(0, count));
            count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
        }
    } catch (error: unknown) {
        return mapFsError(error);
    } finally {
        if (descriptor !== (void 0)) {
            const openDescriptor: number = descriptor;
            quietly((): void => closeSync(openDescriptor));
        }
    }
    return `sha256:${hash.digest("hex")}`;
};

/**
 * Decode with a detected charset. A decoder failure is reported as
 * `charset_unsupported`; a classified domain error passes through unchanged.
 */
const decodePreviewText: (bytes: Uint8Array, charset: Charset) => string = (bytes: Uint8Array, charset: Charset): string => {
    try {
        return decodeText(bytes, charset);
    } catch (error: unknown) {
        if (isFilesystemError(error)) {
            throw error;
        }
        return fail("charset_unsupported");
    }
};

/**
 * Build the node a successful write would produce, without writing.
 *
 * When the target exists its current node is the base, so descriptions and
 * timestamps survive; only the content-derived fields are projected from the
 * new bytes. A new target gets a minimal node whose timestamps are "now",
 * because there is no file to inspect yet; its descriptive fields are still
 * derived from the new bytes instead of being left empty.
 */
const previewFileNode: (rooted: RootedPath, bytes: Uint8Array, timeZone: "local" | "utc") => FileNode = (rooted: RootedPath, bytes: Uint8Array, timeZone: "local" | "utc"): FileNode => {
    const detected: DetectedCharset = detectCharset(bytes);
    const charset: Charset = detected.binary ? "binary" : detected.charset;
    const lines: bigint = detected.binary ? 0n : countLines(decodePreviewText(bytes, charset));
    const fingerprint: string = rawDigest(bytes);
    const byteCount: bigint = BigInt(bytes.byteLength);
    const current: Stats | undefined = statIfExists(rooted.absolute);
    if (current !== (void 0) && current.isFile()) {
        const existing: FileNode = buildFileNode(rooted.root, rooted.relative, { timeZone });
        return { ...existing, charset, lines, bytes: byteCount, fingerprint };
    }
    const described: NodeDescription = describeFile(rooted.absolute, rooted.relative, charset, bytes);
    const now: Date = new Date();
    return {
        type: "File",
        path: rooted.relative,
        name: nameOfPath(rooted.relative),
        extension: extensionOfPath(rooted.relative),
        children: [],
        fingerprint,
        charset,
        lines,
        bytes: byteCount,
        create: formatNodeTime(now, timeZone),
        modify: formatNodeTime(now, timeZone),
        description: described.description,
        summary: described.summary,
        purpose: described.purpose,
    };
};

/**
 * Normalize and validate a write mode. `upsert` is the default because a write
 * is an assignment: it should not fail merely because the file is new.
 */
const normalizeMode: (mode: WriteMode | undefined) => WriteMode = (mode: WriteMode | undefined): WriteMode => {
    if (mode === (void 0)) {
        return "upsert";
    }
    switch (mode) {
        case "create":
        case "overwrite":
        case "upsert":
        case "append": {
            return mode;
        }
        default: {
            return fail("invalid_arguments");
        }
    }
};

/**
 * Validate a text encoding name.
 */
const normalizeEncoding: (encoding: WriteRequest["encoding"]) => TextEncoding = (encoding: WriteRequest["encoding"]): TextEncoding => {
    if (encoding === (void 0)) {
        return "utf-8";
    }
    switch (encoding) {
        case "utf-8":
        case "utf-8-bom":
        case "utf-16le":
        case "utf-16be":
        case "latin1": {
            return encoding;
        }
        default: {
            return fail("invalid_arguments");
        }
    }
};

/**
 * Encode the request content. Raw bytes may only be written as UTF-8 (the
 * default); declaring another encoding for already-encoded bytes is a caller
 * bug, not something to guess about.
 */
const encodeContent: (content: string | Uint8Array, encoding: WriteRequest["encoding"]) => Uint8Array = (content: string | Uint8Array, encoding: WriteRequest["encoding"]): Uint8Array => {
    if (typeof(content) === "string") {
        return encodeText(content, normalizeEncoding(encoding));
    }
    if (content instanceof Uint8Array) {
        if (encoding !== (void 0) && encoding !== "utf-8") {
            return fail("invalid_arguments");
        }
        return content;
    }
    return fail("invalid_arguments");
};

/**
 * Enforce the compare-and-swap precondition. `undefined` skips the check,
 * `null` requires an absent file and a string must match exactly.
 */
const checkCas: (expected: string | null | undefined, previous: string | null) => void = (expected: string | null | undefined, previous: string | null): void => {
    if (expected === (void 0)) {
        return;
    }
    if (expected !== null && typeof(expected) !== "string") {
        return fail("invalid_arguments");
    }
    if (expected === null) {
        if (previous !== null) {
            return fail("fingerprint_mismatch");
        }
        return;
    }
    if (previous !== expected) {
        return fail("fingerprint_mismatch");
    }
};

/**
 * Enforce the mode precondition against the observed file state.
 */
const checkMode: (mode: WriteMode, exists: boolean) => void = (mode: WriteMode, exists: boolean): void => {
    if (mode === "create" && exists) {
        return fail("already_exists");
    }
    if (mode === "overwrite" && !exists) {
        return fail("not_found");
    }
};

/**
 * Assemble the bytes that end up on disk. Append reads the previous bytes and
 * concatenates; every other mode writes exactly the encoded fragment. The
 * size ceiling applies to the result, so an append cannot grow past it.
 */
const finalContent: (absolute: string, encoded: Uint8Array, mode: WriteMode, current: Stats | undefined, maxBytes: number) => Uint8Array = (absolute: string, encoded: Uint8Array, mode: WriteMode, current: Stats | undefined, maxBytes: number): Uint8Array => {
    if (mode === "append" && current !== (void 0)) {
        if (current.size + encoded.byteLength > maxBytes) {
            return fail("quota_exceeded");
        }
        const previous: Uint8Array = readRegularFile(absolute);
        const combined: Uint8Array = new Uint8Array(previous.byteLength + encoded.byteLength);
        combined.set(previous, 0);
        combined.set(encoded, previous.byteLength);
        return combined;
    }
    if (encoded.byteLength > maxBytes) {
        return fail("quota_exceeded");
    }
    return encoded;
};

/**
 * Create one missing directory level after checking it against the sandbox.
 */
const makeDirectoryChain: (sandbox: PathSandbox, root: SessionRoot, relative: string) => void = (sandbox: PathSandbox, root: SessionRoot, relative: string): void => {
    const segments: string[] = relative.split("/");
    for (let index: number = 1; index <= segments.length; index += 1) {
        const current: string = segments.slice(0, index).join("/");
        const absolute: string = join(root.path, current);
        if (!sandbox.contains(root.path, absolute)) {
            return fail("path_escape");
        }
        sandbox.revalidate({ root, relative: current, absolute });
        const stat: Stats | undefined = statIfExists(absolute);
        if (stat !== (void 0)) {
            if (!stat.isDirectory()) {
                return fail("not_directory");
            }
            continue;
        }
        try {
            mkdirSync(absolute);
        } catch (error: unknown) {
            if (errorCode(error) !== "EEXIST") {
                return mapFsError(error);
            }
        }
    }
};

/**
 * Validate the existing prefix of a directory chain without creating anything.
 * Used by `dryRun`, which must reject a non-directory ancestor but must not
 * mutate the disk.
 */
const validateDirectoryChain: (sandbox: PathSandbox, root: SessionRoot, relative: string) => void = (sandbox: PathSandbox, root: SessionRoot, relative: string): void => {
    const segments: string[] = relative.split("/");
    for (let index: number = 1; index <= segments.length; index += 1) {
        const current: string = segments.slice(0, index).join("/");
        const absolute: string = join(root.path, current);
        if (!sandbox.contains(root.path, absolute)) {
            return fail("path_escape");
        }
        sandbox.revalidate({ root, relative: current, absolute });
        const stat: Stats | undefined = statIfExists(absolute);
        if (stat === (void 0)) {
            return;
        }
        if (!stat.isDirectory()) {
            return fail("not_directory");
        }
    }
};

/**
 * Ensure the target's parent directory exists (or would be creatable).
 */
const prepareParent: (sandbox: PathSandbox, rooted: RootedPath, createParents: boolean, materialize: boolean) => void = (sandbox: PathSandbox, rooted: RootedPath, createParents: boolean, materialize: boolean): void => {
    const segments: string[] = rooted.relative.split("/");
    if (segments.length <= 1) {
        return;
    }
    const parent: string = segments.slice(0, -1).join("/");
    if (createParents) {
        if (materialize) {
            makeDirectoryChain(sandbox, rooted.root, parent);
        } else {
            validateDirectoryChain(sandbox, rooted.root, parent);
        }
        return;
    }
    const absolute: string = join(rooted.root.path, parent);
    if (!sandbox.contains(rooted.root.path, absolute)) {
        return fail("path_escape");
    }
    sandbox.revalidate({ root: rooted.root, relative: parent, absolute });
    const stat: Stats | undefined = statIfExists(absolute);
    if (stat === (void 0)) {
        return fail("not_found");
    }
    if (!stat.isDirectory()) {
        return fail("not_directory");
    }
};

/**
 * Write bytes through a same-directory temporary file: write, `fsync`, close,
 * then `rename` over the target. A failure before the rename removes the
 * temporary file; the target is never truncated in place.
 */
const atomicWrite: (absolute: string, bytes: Uint8Array, modeBits: number | undefined) => void = (absolute: string, bytes: Uint8Array, modeBits: number | undefined): void => {
    const temp: string = join(dirname(absolute), `.amp-${randomBytes(8).toString("hex")}.tmp`);
    let descriptor: number | undefined = (void 0);
    let renamed: boolean = false;
    try {
        descriptor = openSync(temp, "wx", modeBits === (void 0) ? 0o666 : modeBits);
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = (void 0);
        renameSync(temp, absolute);
        renamed = true;
    } finally {
        if (descriptor !== (void 0)) {
            const openDescriptor: number = descriptor;
            quietly((): void => closeSync(openDescriptor));
        }
        if (!renamed) {
            quietly((): void => rmSync(temp, { force: true }));
        }
    }
};

/**
 * Write locks keyed by `(sessionId, rootId, relativePath)`.
 *
 * The class is exported so a host can own one registry and share it with other
 * workspace components; {@link writeFile} uses a process-wide registry because
 * its frozen signature carries no lock parameter.
 */
export class WriteLocks {
    private readonly locks: NamedLocks = new NamedLocks();

    async run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
        return this.locks.run(name, fn);
    }

    /**
     * Number of distinct lock names seen so far.
     */
    get size(): number {
        return this.locks.size;
    }
}

/**
 * Process-wide lock registry used by {@link writeFile}.
 */
const WriteLockRegistry: WriteLocks = new WriteLocks();

/**
 * Committed write plus the journal record that must be published after the
 * non-reentrant path lock is released.
 */
interface WriteCommit {
    readonly result: WriteResult;
    readonly journal: WriteJournalEntry | undefined;
    readonly relative: string;
}

/**
 * Run the checks and the write while holding the path lock. Journal creation is
 * metadata only; the callback and the tree refresh run after the lock is
 * released so a callback can safely write the same path again.
 */
const writeLocked: (context: WriteContext) => WriteCommit = (context: WriteContext): WriteCommit => {
    context.sandbox.revalidate(context.rooted);
    const current: Stats | undefined = statIfExists(context.rooted.absolute);
    if (current !== (void 0)) {
        if (current.isSymbolicLink()) {
            return fail("symlink_denied");
        }
        if (!current.isFile()) {
            return fail("not_file");
        }
    }
    const previousFingerprint: string | null = current === (void 0) ? null : hashRegularFile(context.rooted.absolute);
    checkCas(context.request.expectFingerprint, previousFingerprint);
    checkMode(context.mode, current !== (void 0));
    const encoded: Uint8Array = encodeContent(context.content, context.request.encoding);
    const bytes: Uint8Array = finalContent(context.rooted.absolute, encoded, context.mode, current, context.maxBytes);
    prepareParent(context.sandbox, context.rooted, context.createParents, !context.dryRun);
    const created: boolean = current === (void 0);
    context.sandbox.revalidate(context.rooted);
    if (context.dryRun) {
        const preview: FileNode = previewFileNode(context.rooted, bytes, context.timeZone);
        return {
            result: {
                node: preview,
                previousFingerprint,
                created,
                dryRun: true,
                bytesWritten: BigInt(bytes.byteLength),
                revision: preview.fingerprint,
            },
            journal: (void 0),
            relative: context.rooted.relative,
        };
    }
    atomicWrite(context.rooted.absolute, bytes, current === (void 0) ? (void 0) : current.mode & 0o777);
    context.sandbox.revalidate(context.rooted);
    const nextStat: Stats = statOrFail(context.rooted.absolute);
    const node: FileNode = fileNodeFromBytes(context.rooted, bytes, nextStat, context.timeZone);
    let journal: WriteJournalEntry | undefined = (void 0);
    if (context.options.journal !== (void 0)) {
        journal = {
            id: `w.${randomBytes(8).toString("hex")}`,
            sessionId: context.sessionId,
            rootId: context.rooted.root.id,
            path: context.rooted.relative,
            mode: context.mode,
            previousFingerprint,
            nextFingerprint: rawDigest(bytes),
            bytes: BigInt(bytes.byteLength),
            at: formatIsoTime(new Date()),
        };
    }
    return {
        result: {
            node,
            previousFingerprint,
            created,
            dryRun: false,
            bytesWritten: BigInt(bytes.byteLength),
            revision: node.fingerprint,
        },
        journal,
        relative: context.rooted.relative,
    };
};

/**
 * Publish the journal record and refresh the tree after the lock is released.
 */
const publishWrite: (commit: WriteCommit, options: WriteOptions) => WriteResult = (commit: WriteCommit, options: WriteOptions): WriteResult => {
    if (commit.result.dryRun) {
        return commit.result;
    }
    if (options.journal !== (void 0) && commit.journal !== (void 0)) {
        options.journal(commit.journal);
    }
    const tree: WorkspaceTree | undefined = options.tree;
    if (tree === (void 0)) {
        return commit.result;
    }
    return { ...commit.result, revision: tree.refresh(commit.relative).revision };
};

/**
 * Write one workspace file atomically.
 *
 * Order of checks matches the contract: resolve, lock, read the current file
 * and its fingerprint, CAS, mode, content encoding, size ceiling, parent
 * directory, then the atomic rename. A `dryRun` stops right after the parent
 * check and returns the projected node instead of writing.
 *
 * @param sandbox - Session sandbox that owns path resolution.
 * @param sessionId - Public session handle used for the lock and the journal.
 * @param request - Path, content, mode, CAS precondition and dry-run flag.
 * @param options - Size ceiling, journal sink, tree and timestamp mode.
 * @returns The new node, previous fingerprint and write metadata.
 */
export const writeFile: (sandbox: PathSandbox, sessionId: string, request: WriteRequest, options?: WriteOptions) => Promise<WriteResult> = async (sandbox: PathSandbox, sessionId: string, request: WriteRequest, options: WriteOptions = {}): Promise<WriteResult> => {
    if (typeof(sessionId) !== "string" || sessionId.length === 0 || sessionId.includes("\u0000")) {
        return fail("invalid_arguments");
    }
    if (typeof(request) !== "object" || request === null) {
        return fail("invalid_arguments");
    }
    const settings: WriteOptions = options === (void 0) || options === null ? {} : options;
    const mode: WriteMode = normalizeMode(request.mode);
    const maxBytes: number = positiveInteger(settings.maxBytes, DefaultWriteBytes, MaxWriteBytes);
    const rooted: RootedPath = sandbox.resolve(request.path, mode === "create" ? "create" : "write");
    if (rooted.relative === ".") {
        return fail("not_file");
    }
    const content: string | Uint8Array = request.content;
    const snapshotContent: string | Uint8Array = typeof(content) === "string" ? content : content instanceof Uint8Array ? new Uint8Array(content) : content;
    const timeZone: "local" | "utc" = settings.timeZone === "utc" ? "utc" : "local";
    const context: WriteContext = {
        sandbox,
        sessionId,
        rooted,
        mode,
        request,
        content: snapshotContent,
        options: settings,
        maxBytes,
        dryRun: request.dryRun === true,
        createParents: request.createParents === true,
        timeZone,
    };
    const lockName: string = `${sessionId}\u0000${rooted.root.id}\u0000${rooted.relative}`;
    const commit: WriteCommit = await WriteLockRegistry.run(lockName, (): WriteCommit => writeLocked(context)).catch((error: unknown): never => mapFsError(error));
    try {
        return publishWrite(commit, settings);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * Request for {@link useByte}. The target must already exist; `content`
 * replaces the half-open raw byte range `[startByte, endByte)`.
 */
export interface BytePatchRequest {
    readonly path: string;
    readonly startByte: number;
    readonly endByte: number;
    readonly content: Uint8Array;
    readonly expectFingerprint: string;
    readonly expectRangeFingerprint?: string;
    readonly dryRun?: boolean;
}

/**
 * Request for {@link useLine}. Lines are 1-based and inclusive; `endLine =
 * startLine - 1` inserts before `startLine`. `content` is encoded with the
 * file's own charset, so a UTF-16 or Latin-1 file keeps its encoding.
 */
export interface LinePatchRequest {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
    readonly expectFingerprint: string;
    readonly expectRangeFingerprint?: string;
    readonly dryRun?: boolean;
}

/**
 * Journal record for one range patch. It extends the base write record with the
 * patched span and both range fingerprints, without changing `types.ts`.
 */
export interface PatchJournalEntry extends WriteJournalEntry {
    readonly kind: "line" | "byte";
    readonly startByte: number;
    readonly endByte: number;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly previousRangeFingerprint: string;
    readonly nextRangeFingerprint: string;
    readonly nextStartByte: number;
    readonly nextEndByte: number;
    readonly previousTotalBytes: bigint;
    readonly nextTotalBytes: bigint;
}

/**
 * Options for {@link useByte} and {@link useLine}. `maxBytes` caps the resulting
 * file; line patches additionally require the current file to fit that budget
 * because the text has to be decoded.
 */
export interface WritePatchOptions extends WriteOptions {
    readonly patchJournal?: (entry: PatchJournalEntry) => void;
}

/**
 * Result of a range patch. `bytesWritten` is the final file size, matching
 * {@link WriteResult}; `previousRangeFingerprint` describes the replaced span
 * before the write and `nextRangeFingerprint` the inserted span afterwards.
 */
export interface WritePatchResult extends WriteResult {
    readonly kind: "line" | "byte";
    readonly startByte: number;
    readonly endByte: number;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly previousRangeFingerprint: string;
    readonly nextRangeFingerprint: string;
    readonly nextStartByte: number;
    readonly nextEndByte: number;
    readonly previousTotalBytes: bigint;
    readonly nextTotalBytes: bigint;
}

/**
 * One validated patch description produced under the write lock.
 */
interface PatchPlan {
    readonly kind: "line" | "byte";
    readonly startByte: number;
    readonly endByte: number;
    readonly replacement: Uint8Array;
    readonly startLine?: number;
    readonly endLine?: number;
}

/**
 * Planner receives the current raw bytes and returns the exact splice plan.
 */
type PatchPlanner = (bytes: Uint8Array) => PatchPlan;

/**
 * Values fixed before the lock is taken.
 */
interface PatchContext {
    readonly sandbox: PathSandbox;
    readonly sessionId: string;
    readonly rooted: RootedPath;
    readonly kind: "line" | "byte";
    readonly expectFingerprint: string;
    readonly expectRangeFingerprint?: string;
    readonly dryRun: boolean;
    readonly maxBytes: number;
    readonly timeZone: "local" | "utc";
}

/**
 * Committed patch plus the journal records that must be published after the
 * lock is released.
 */
interface PatchCommit {
    readonly result: WritePatchResult;
    readonly journal: WriteJournalEntry | undefined;
    readonly patchJournal: PatchJournalEntry | undefined;
    readonly relative: string;
}

/**
 * Validate a raw byte offset.
 */
const patchByteOffset: (value: number) => number = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0) {
        return fail("invalid_arguments");
    }
    return value;
};

/**
 * Validate a 1-based start line.
 */
const patchStartLine: (value: number) => number = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 1) {
        return fail("invalid_arguments");
    }
    return value;
};

/**
 * Validate an inclusive end line; `0` is the insertion point before line 1.
 */
const patchEndLine: (value: number) => number = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0) {
        return fail("invalid_arguments");
    }
    return value;
};

/**
 * A range patch cannot be unsafe: the whole-file fingerprint is mandatory.
 */
const requiredFingerprint: (value: unknown) => string = (value: unknown): string =>
    typeof(value) === "string" && value.length > 0 ? value : fail("invalid_arguments");

/**
 * Optional secondary range fingerprint.
 */
const optionalFingerprint: (value: unknown) => string | undefined = (value: unknown): string | undefined =>
    value === (void 0) ? (void 0) : requiredFingerprint(value);

/**
 * Encode line replacement content in the file's own charset without a BOM. A
 * BOM belongs to the file, never to an inserted fragment.
 */
const encodeLineBody: (text: string, charset: Charset) => Uint8Array = (text: string, charset: Charset): Uint8Array => {
    switch (charset) {
        case "utf-8":
        case "utf-8-bom": {
            return new TextEncoder().encode(text);
        }
        case "utf-16le": {
            return new Uint8Array(Buffer.from(text, "utf16le"));
        }
        case "utf-16be": {
            const body: Buffer = Buffer.from(text, "utf16le");
            body.swap16();
            return new Uint8Array(body);
        }
        case "latin1": {
            return encodeText(text, "latin1");
        }
        default: {
            return fail("charset_unsupported");
        }
    }
};

/**
 * Replace one validated raw byte span in memory.
 */
const spliceBytes: (bytes: Uint8Array, startByte: number, endByte: number, replacement: Uint8Array) => Uint8Array = (bytes: Uint8Array, startByte: number, endByte: number, replacement: Uint8Array): Uint8Array => {
    const result: Uint8Array = new Uint8Array(bytes.byteLength - (endByte - startByte) + replacement.byteLength);
    result.set(bytes.subarray(0, startByte), 0);
    result.set(replacement, startByte);
    result.set(bytes.subarray(endByte), startByte + replacement.byteLength);
    return result;
};

/**
 * Build the node for already-known bytes plus a stat. Used by range patches so
 * a committed write does not have to read and hash the file a third time.
 */
const fileNodeFromBytes: (rooted: RootedPath, bytes: Uint8Array, stat: Stats, timeZone: "local" | "utc") => FileNode = (rooted: RootedPath, bytes: Uint8Array, stat: Stats, timeZone: "local" | "utc"): FileNode => {
    const detected: DetectedCharset = detectCharset(bytes);
    let charset: Charset = detected.binary ? "binary" : detected.charset;
    let lines: bigint = 0n;
    if (charset !== "binary") {
        try {
            lines = countLines(decodeText(bytes, charset));
        } catch {
            charset = "binary";
            lines = 0n;
        }
    }
    const described: NodeDescription = describeFile(rooted.absolute, rooted.relative, charset, bytes);
    return {
        type: "File",
        path: rooted.relative,
        name: nameOfPath(rooted.relative),
        extension: extensionOfPath(rooted.relative),
        children: [],
        fingerprint: rawDigest(bytes),
        charset,
        lines,
        bytes: BigInt(bytes.byteLength),
        create: formatNodeTime(creationTime(stat), timeZone),
        modify: formatNodeTime(new Date(stat.mtimeMs), timeZone),
        description: described.description,
        summary: described.summary,
        purpose: described.purpose,
    };
};

/**
 * Execute one patch while the path lock is held. The file must already exist;
 * the whole-file fingerprint is checked first, then the optional range
 * fingerprint, then the in-memory splice and the atomic rename.
 */
const patchLocked: (context: PatchContext, planner: PatchPlanner) => PatchCommit = (context: PatchContext, planner: PatchPlanner): PatchCommit => {
    context.sandbox.revalidate(context.rooted);
    const current: Stats | undefined = statIfExists(context.rooted.absolute);
    if (current === (void 0)) {
        return fail("not_found");
    }
    if (current.isSymbolicLink()) {
        return fail("symlink_denied");
    }
    if (!current.isFile()) {
        return fail("not_file");
    }
    if (current.size > MaxWriteBytes) {
        return fail("quota_exceeded");
    }
    const bytes: Uint8Array = readRegularFile(context.rooted.absolute);
    if (bytes.byteLength > MaxWriteBytes) {
        return fail("quota_exceeded");
    }
    const previousFingerprint: string = rawDigest(bytes);
    if (previousFingerprint !== context.expectFingerprint) {
        return fail("fingerprint_mismatch");
    }
    const plan: PatchPlan = planner(bytes);
    if (!Number.isSafeInteger(plan.startByte) || plan.startByte < 0 || !Number.isSafeInteger(plan.endByte) || plan.endByte < plan.startByte || plan.endByte > bytes.byteLength) {
        return fail("invalid_arguments");
    }
    const previousRangeFingerprint: string = byteRangeFingerprint(plan.startByte, plan.endByte, bytes.subarray(plan.startByte, plan.endByte));
    if (context.expectRangeFingerprint !== (void 0) && previousRangeFingerprint !== context.expectRangeFingerprint) {
        return fail("fingerprint_mismatch");
    }
    const nextBytes: Uint8Array = spliceBytes(bytes, plan.startByte, plan.endByte, plan.replacement);
    if (nextBytes.byteLength > context.maxBytes) {
        return fail("quota_exceeded");
    }
    const nextFingerprint: string = rawDigest(nextBytes);
    const nextStartByte: number = plan.startByte;
    const nextEndByte: number = plan.startByte + plan.replacement.byteLength;
    const nextRangeFingerprint: string = byteRangeFingerprint(nextStartByte, nextEndByte, nextBytes.subarray(nextStartByte, nextEndByte));
    const previousTotalBytes: bigint = BigInt(bytes.byteLength);
    const nextTotalBytes: bigint = BigInt(nextBytes.byteLength);
    const baseResult: WritePatchResult = {
        node: fileNodeFromBytes(context.rooted, nextBytes, current, context.timeZone),
        previousFingerprint,
        created: false,
        dryRun: context.dryRun,
        bytesWritten: nextTotalBytes,
        revision: nextFingerprint,
        kind: context.kind,
        startByte: plan.startByte,
        endByte: plan.endByte,
        startLine: plan.startLine,
        endLine: plan.endLine,
        previousRangeFingerprint,
        nextRangeFingerprint,
        nextStartByte,
        nextEndByte,
        previousTotalBytes,
        nextTotalBytes,
    };
    if (context.dryRun) {
        return { result: baseResult, journal: (void 0), patchJournal: (void 0), relative: context.rooted.relative };
    }
    context.sandbox.revalidate(context.rooted);
    atomicWrite(context.rooted.absolute, nextBytes, current.mode & 0o777);
    context.sandbox.revalidate(context.rooted);
    const nextStat: Stats = statOrFail(context.rooted.absolute);
    const node: FileNode = fileNodeFromBytes(context.rooted, nextBytes, nextStat, context.timeZone);
    const id: string = `w.${randomBytes(8).toString("hex")}`;
    const at: string = formatIsoTime(new Date());
    const journal: WriteJournalEntry = {
        id,
        sessionId: context.sessionId,
        rootId: context.rooted.root.id,
        path: context.rooted.relative,
        mode: "overwrite",
        previousFingerprint,
        nextFingerprint,
        bytes: nextTotalBytes,
        at,
    };
    const patchJournal: PatchJournalEntry = {
        ...journal,
        kind: context.kind,
        startByte: plan.startByte,
        endByte: plan.endByte,
        startLine: plan.startLine,
        endLine: plan.endLine,
        previousRangeFingerprint,
        nextRangeFingerprint,
        nextStartByte,
        nextEndByte,
        previousTotalBytes,
        nextTotalBytes,
    };
    return { result: { ...baseResult, node, revision: node.fingerprint }, journal, patchJournal, relative: context.rooted.relative };
};

/**
 * Publish the journal entries and refresh the tree after the lock is released.
 * Journal callbacks must not run under the non-reentrant write lock: a callback
 * that writes the same path would otherwise deadlock.
 */
const publishPatch: (commit: PatchCommit, options: WritePatchOptions) => WritePatchResult = (commit: PatchCommit, options: WritePatchOptions): WritePatchResult => {
    if (commit.result.dryRun) {
        return commit.result;
    }
    if (options.journal !== (void 0) && commit.journal !== (void 0)) {
        options.journal(commit.journal);
    }
    if (options.patchJournal !== (void 0) && commit.patchJournal !== (void 0)) {
        options.patchJournal(commit.patchJournal);
    }
    const tree: WorkspaceTree | undefined = options.tree;
    if (tree === (void 0)) {
        return commit.result;
    }
    return { ...commit.result, revision: tree.refresh(commit.relative).revision };
};

/**
 * Replace a raw byte range of an existing file.
 *
 * The whole-file `expectFingerprint` is mandatory and is verified from the bytes
 * read under the lock; `expectRangeFingerprint` is a secondary check. The new
 * file is assembled in memory, written through a same-directory temporary file,
 * `fsync`ed and renamed, so a reader never observes a partial file.
 *
 * @param sandbox - Session sandbox that owns path resolution.
 * @param sessionId - Public session handle used for the lock and journal.
 * @param request - Path, half-open byte range, replacement bytes and CAS guards.
 * @param options - Size ceiling, journal sinks, tree and timestamp mode.
 * @returns Patch result with both fingerprint pairs and the new node.
 */
export const useByte: (sandbox: PathSandbox, sessionId: string, request: BytePatchRequest, options?: WritePatchOptions) => Promise<WritePatchResult> = async (sandbox: PathSandbox, sessionId: string, request: BytePatchRequest, options: WritePatchOptions = {}): Promise<WritePatchResult> => {
    if (typeof(sessionId) !== "string" || sessionId.length === 0 || sessionId.includes("\u0000")) {
        return fail("invalid_arguments");
    }
    if (typeof(request) !== "object" || request === null) {
        return fail("invalid_arguments");
    }
    const settings: WritePatchOptions = options === (void 0) || options === null ? {} : options;
    const expectFingerprint: string = requiredFingerprint(request.expectFingerprint);
    const expectRangeFingerprint: string | undefined = optionalFingerprint(request.expectRangeFingerprint);
    if (!(request.content instanceof Uint8Array)) {
        return fail("invalid_arguments");
    }
    const replacement: Uint8Array = new Uint8Array(request.content);
    const startByte: number = patchByteOffset(request.startByte);
    const endByte: number = patchByteOffset(request.endByte);
    if (endByte < startByte) {
        return fail("invalid_arguments");
    }
    const maxBytes: number = positiveInteger(settings.maxBytes, DefaultWriteBytes, MaxWriteBytes);
    const rooted: RootedPath = sandbox.resolve(request.path, "write");
    if (rooted.relative === ".") {
        return fail("not_file");
    }
    const context: PatchContext = {
        sandbox,
        sessionId,
        rooted,
        kind: "byte",
        expectFingerprint,
        expectRangeFingerprint,
        dryRun: request.dryRun === true,
        maxBytes,
        timeZone: settings.timeZone === "utc" ? "utc" : "local",
    };
    const planner: PatchPlanner = (bytes: Uint8Array): PatchPlan => {
        if (endByte > bytes.byteLength) {
            return fail("invalid_arguments");
        }
        return { kind: "byte", startByte, endByte, replacement };
    };
    const lockName: string = `${sessionId}\u0000${rooted.root.id}\u0000${rooted.relative}`;
    const commit: PatchCommit = await WriteLockRegistry.run(lockName, (): PatchCommit => patchLocked(context, planner)).catch((error: unknown): never => mapFsError(error));
    try {
        return publishPatch(commit, settings);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * Replace a line range of an existing text file.
 *
 * Line numbers are 1-based and inclusive. The replaced span starts at the first
 * character of `startLine` and includes the terminator of `endLine` when one
 * exists, which means `content` is inserted verbatim: include the desired
 * newline when more lines follow. Use `endLine = startLine - 1` to insert.
 *
 * @param sandbox - Session sandbox that owns path resolution.
 * @param sessionId - Public session handle used for the lock and journal.
 * @param request - Path, inclusive line range, replacement text and CAS guards.
 * @param options - Size ceiling, journal sinks, tree and timestamp mode.
 * @returns Patch result with both fingerprint pairs and the new node.
 */
export const useLine: (sandbox: PathSandbox, sessionId: string, request: LinePatchRequest, options?: WritePatchOptions) => Promise<WritePatchResult> = async (sandbox: PathSandbox, sessionId: string, request: LinePatchRequest, options: WritePatchOptions = {}): Promise<WritePatchResult> => {
    if (typeof(sessionId) !== "string" || sessionId.length === 0 || sessionId.includes("\u0000")) {
        return fail("invalid_arguments");
    }
    if (typeof(request) !== "object" || request === null) {
        return fail("invalid_arguments");
    }
    const settings: WritePatchOptions = options === (void 0) || options === null ? {} : options;
    const expectFingerprint: string = requiredFingerprint(request.expectFingerprint);
    const expectRangeFingerprint: string | undefined = optionalFingerprint(request.expectRangeFingerprint);
    if (typeof(request.content) !== "string") {
        return fail("invalid_arguments");
    }
    const content: string = request.content;
    const startLine: number = patchStartLine(request.startLine);
    const endLine: number = patchEndLine(request.endLine);
    if (endLine < startLine - 1) {
        return fail("invalid_arguments");
    }
    const maxBytes: number = positiveInteger(settings.maxBytes, DefaultWriteBytes, MaxWriteBytes);
    const rooted: RootedPath = sandbox.resolve(request.path, "write");
    if (rooted.relative === ".") {
        return fail("not_file");
    }
    const context: PatchContext = {
        sandbox,
        sessionId,
        rooted,
        kind: "line",
        expectFingerprint,
        expectRangeFingerprint,
        dryRun: request.dryRun === true,
        maxBytes,
        timeZone: settings.timeZone === "utc" ? "utc" : "local",
    };
    const planner: PatchPlanner = (bytes: Uint8Array): PatchPlan => {
        const span: LineSpan = locateLineSpan(bytes, startLine, endLine);
        return {
            kind: "line",
            startByte: span.startByte,
            endByte: span.endByte,
            replacement: encodeLineBody(content, span.charset),
            startLine,
            endLine,
        };
    };
    const lockName: string = `${sessionId}\u0000${rooted.root.id}\u0000${rooted.relative}`;
    const commit: PatchCommit = await WriteLockRegistry.run(lockName, (): PatchCommit => patchLocked(context, planner)).catch((error: unknown): never => mapFsError(error));
    try {
        return publishPatch(commit, settings);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * Create a directory inside a root. `create` requires the parent to exist and
 * fails when the target is already present; `ensure` creates the whole chain
 * and treats an existing directory as success. The root itself is always a
 * valid target for `ensure` and never for `create`.
 *
 * @param sandbox - Session sandbox that owns path resolution.
 * @param path - Root-relative POSIX directory path.
 * @param mode - `create` or `ensure`; defaults to `ensure`.
 * @returns The resolved path of the directory.
 */
export const ensureDirectory: (sandbox: PathSandbox, path: string, mode?: "create" | "ensure") => RootedPath = (sandbox: PathSandbox, path: string, mode: "create" | "ensure" = "ensure"): RootedPath => {
    if (mode !== "create" && mode !== "ensure") {
        return fail("invalid_arguments");
    }
    const rooted: RootedPath = sandbox.resolve(path, "create");
    if (rooted.relative === ".") {
        return rooted;
    }
    if (mode === "ensure") {
        makeDirectoryChain(sandbox, rooted.root, rooted.relative);
        sandbox.revalidate(rooted);
        return rooted;
    }
    if (statIfExists(rooted.absolute) !== (void 0)) {
        return fail("already_exists");
    }
    const parent: string = dirname(rooted.absolute);
    if (!sandbox.contains(rooted.root.path, parent)) {
        return fail("path_escape");
    }
    const parentStat: Stats = statOrFail(parent);
    if (!parentStat.isDirectory()) {
        return fail("not_directory");
    }
    try {
        mkdirSync(rooted.absolute);
    } catch (error: unknown) {
        return mapFsError(error);
    }
    sandbox.revalidate(rooted);
    return rooted;
};
