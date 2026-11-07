import { createHash } from "node:crypto";
import { isFunction, isObject, isString, SynchronousUnorderedMap } from "semantic-typescript";
import type {
    ByteTarget, DiffHunk, EditMatch, EditOp, EditOptions, EditPlan, FileConflict, FileDiff, FileLease, FileOperationKind,
    FileOperationReceipt, FileRange, FileRef, FileSnapshot, FileStoragePort, FileValidation, FlushOptions, LineRead,
    LineTarget, MountOptions, OutlineEntry, OutlineProvider, ReadOptions, RegexTarget, ReloadOptions, ReplaceTarget,
    StoredBytes, StoredFile, StringTarget, UnmountOptions, WorkspaceMode, WorkspaceScope, WriteTarget,
} from "./types.ts";
import { WorkspaceError } from "../workspace/types.ts";
import { safeStringify } from "../serialization/index.ts";
import { SourceText, isRange } from "./range.ts";
import { decodeText, defaultCharset, encodeText, normalizeToLf, type CharsetInfo } from "./charset.ts";
import { createDocumentOutline } from "./document/outline.ts";
import type { DocumentOutline } from "./document/types.ts";
import {
    isWriteTarget, literalReplacement, regexReplacement, resolveRegions, selectRegions, spliceRegions,
    structuralReplacement, toEditMatches, unifiedDiff, diffHunks as structuredDiffHunks, type Region,
} from "./edit.ts";

const clone = <T>(value: T): T => isObject(value) ? structuredClone(value) as T : value;
const nowIso = (): string => new Date().toISOString();

export function fileDigest(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Normalizes the two hash spellings in use (`<hex>` and `sha256:<hex>`) for comparison. */
function hashKey(value: string): string {
    return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function scopedKey(ref: FileRef): string {
    return safeStringify([ref.tenantId, ref.rootId, ref.path]);
}

function validatePath(path: string): void {
    if (!path || path.includes("\0") || /^[A-Za-z]:/.test(path) || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => part === "" || part === "." || part === "..")) {
        throw new WorkspaceError("invalid_path", `Invalid workspace-relative path: ${path}`);
    }
}

function checkUtf8Boundary(content: string, start: number, end: number): void {
    const bytes = Buffer.from(content, "utf8");
    if ((start > 0 && (bytes[start] & 0xc0) === 0x80) || (end < bytes.length && (bytes[end] & 0xc0) === 0x80)) {
        throw new WorkspaceError("invalid_range", "byte range must align to UTF-8 code point boundaries");
    }
}

function checkRange(range: FileRange, content: string): { kind: "byte" | "line"; start: number; end: number } {
    const kind = "kind" in range ? range.kind : ("byte" in range ? "byte" : "line");
    const bounds = "kind" in range ? range : ("byte" in range ? range.byte : range.line);
    if (!Number.isSafeInteger(bounds.start) || !Number.isSafeInteger(bounds.end) || bounds.start < 0 || bounds.end < bounds.start) {
        throw new WorkspaceError("invalid_range", "range bounds must be safe nonnegative integers with end >= start");
    }
    const limit = kind === "byte" ? Buffer.byteLength(content, "utf8") : content.split("\n").length;
    if (bounds.end > limit) throw new WorkspaceError("invalid_range", "range exceeds content");
    if (kind === "byte") checkUtf8Boundary(content, bounds.start, bounds.end);
    return { kind, start: bounds.start, end: bounds.end };
}

/** Legacy `FileRange` form is normalized onto the explicit targets. */
function legacyTarget(range: FileRange): LineTarget | ByteTarget {
    const kind = "kind" in range ? range.kind : ("byte" in range ? "byte" : "line");
    const bounds = "kind" in range ? range : ("byte" in range ? range.byte : range.line);
    return kind === "line" ? { mode: "line", start: bounds.start, end: bounds.end }
        : { mode: "byte", start: bounds.start, end: bounds.end };
}

interface LeaseRecord extends FileLease { readonly expiresAtEpoch: number; }

/** Host-neutral in-memory adapter. It never opens or derives arbitrary disk paths. */
export class InMemoryFileStorage implements FileStoragePort {
    private readonly files = new SynchronousUnorderedMap<string, StoredFile>();
    private readonly binaries = new SynchronousUnorderedMap<string, Uint8Array>();
    private readonly leases = new SynchronousUnorderedMap<string, LeaseRecord>();
    private readonly fences = new SynchronousUnorderedMap<string, number>();
    private readonly clock: () => string;

    constructor(clock: () => string = nowIso) { this.clock = clock; }

    read(ref: FileRef): StoredFile | undefined {
        validatePath(ref.path);
        const key = scopedKey(ref);
        const value = this.files.get(key);
        if (value.isEmpty()) return undefined;
        if (this.binaries.containsKey(key)) throw new WorkspaceError("binary_file", `${ref.path} is stored as bytes`);
        return clone(value.get());
    }

    /** Explicit host simulation hook; it is scoped by tenant/root/path and performs no filesystem IO. */
    put(ref: FileRef, content: string): StoredFile {
        validatePath(ref.path);
        const key = scopedKey(ref);
        const previous = this.files.get(key).orElse(undefined);
        const stored: StoredFile = { ...ref, content, hash: fileDigest(content), version: previous ? previous.version + 1 : 0,
            updatedAt: this.clock(), charset: defaultCharset, size: Buffer.byteLength(content, "utf8") };
        this.files.put(key, clone(stored));
        // A text commit is authoritative: the byte view of the previous binary value is gone.
        this.binaries.remove(key);
        return clone(stored);
    }

    /** Registers opaque bytes (e.g. an Office fixture) so binary outline parsing can be exercised. */
    putBytes(ref: FileRef, bytes: Uint8Array): StoredFile {
        validatePath(ref.path);
        if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
        const key = scopedKey(ref);
        const previous = this.files.get(key).orElse(undefined);
        const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        const stored: StoredFile = { ...ref, content: "", hash, version: previous ? previous.version + 1 : 0,
            updatedAt: this.clock(), size: bytes.byteLength };
        this.files.put(key, clone(stored));
        this.binaries.put(key, new Uint8Array(bytes));
        return clone(stored);
    }

    readBytes(ref: FileRef): StoredBytes | undefined {
        validatePath(ref.path);
        const key = scopedKey(ref);
        const binary = this.binaries.get(key).orElse(undefined);
        const stored = this.files.get(key).orElse(undefined);
        if (!stored) return undefined;
        const bytes = binary ? new Uint8Array(binary) : new TextEncoder().encode(stored.content);
        return Object.freeze({ ...ref, bytes, size: bytes.byteLength, hash: stored.hash,
            version: stored.version, updatedAt: stored.updatedAt });
    }

    compareAndSwapBytes(ref: FileRef, expectedHash: string, bytes: Uint8Array, fence: number): StoredFile {
        validatePath(ref.path);
        if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
        this.assertFence(ref, fence);
        const key = scopedKey(ref);
        const current = this.files.get(key).orElse(undefined);
        if (!current) throw new WorkspaceError("not_found", `File ${ref.path} does not exist`);
        if (current.hash !== expectedHash) throw new WorkspaceError("version_conflict", "base hash changed before commit");
        const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        const next: StoredFile = { ...current, content: "", hash, version: current.version + 1,
            updatedAt: this.clock(), size: bytes.byteLength, charset: undefined };
        this.files.put(key, clone(next));
        this.binaries.put(key, new Uint8Array(bytes));
        return clone(next);
    }

    compareAndSwap(ref: FileRef, expectedHash: string, content: string, fence: number): StoredFile {
        validatePath(ref.path);
        this.assertFence(ref, fence);
        const key = scopedKey(ref);
        const current = this.files.get(key).orElse(undefined);
        if (!current) throw new WorkspaceError("not_found", `File ${ref.path} does not exist`);
        if (current.hash !== expectedHash) throw new WorkspaceError("version_conflict", "base hash changed before commit");
        const next: StoredFile = { ...current, content, hash: fileDigest(content), version: current.version + 1,
            updatedAt: this.clock(), charset: current.charset ?? defaultCharset, size: Buffer.byteLength(content, "utf8") };
        this.files.put(key, clone(next));
        this.binaries.remove(key);
        return clone(next);
    }

    acquireLease(ref: FileRef, owner: string, ttlMilliseconds = 30_000): FileLease {
        validatePath(ref.path);
        if (!owner) throw new WorkspaceError("invalid_scope", "lease owner is required");
        if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds <= 0) throw new WorkspaceError("invalid_scope", "lease TTL must be positive");
        const key = scopedKey(ref);
        if (this.files.get(key).isEmpty()) throw new WorkspaceError("not_found", `File ${ref.path} does not exist`);
        const current = this.leases.get(key).orElse(undefined);
        if (current && !this.expired(current) && current.owner !== owner) throw new WorkspaceError("fence_rejected", "file lease is held by another owner");
        const fence = (this.fences.get(key).orElse(0) as number) + 1;
        const issuedAt = Date.parse(this.clock());
        const expiresAtEpoch = issuedAt + ttlMilliseconds;
        const token = `${owner}:${fence}:${fileDigest(`${key}:${issuedAt}`)}`;
        const lease: LeaseRecord = { ...ref, owner, fence, token, expiresAt: new Date(expiresAtEpoch).toISOString(), expiresAtEpoch };
        this.fences.put(key, fence);
        this.leases.put(key, lease);
        return clone(lease);
    }

    releaseLease(lease: FileLease): void {
        const key = scopedKey(lease);
        const current = this.leases.get(key).orElse(undefined);
        if (current && current.token === lease.token) this.leases.remove(key);
    }

    private expired(lease: LeaseRecord): boolean { return Date.parse(this.clock()) >= lease.expiresAtEpoch; }

    private assertFence(ref: FileRef, fence: number): void {
        const current = this.leases.get(scopedKey(ref)).orElse(undefined);
        if (!current || this.expired(current) || current.fence !== fence) throw new WorkspaceError("fence_rejected", "lease fence is absent, expired, or old");
    }
}

export interface FileWorkspaceHost extends WorkspaceScope {
    readonly storage: FileStoragePort;
    /** Optional observer invoked after mount/flush/unmount; failures are isolated from the operation. */
    readonly onFileReceipt?: (receipt: FileOperationReceipt) => void;
}

export class WorkspaceFile {
    private stateValue: FileSnapshot["state"] = "unmounted";
    private readonly modeValue: WorkspaceMode;
    private base?: StoredFile;
    private buffer = "";
    private bufferVersionValue = 0;
    private binaryValue = false;
    private binaryDirty = false;
    private bytesBuffer = new Uint8Array();
    private lease?: FileLease;
    private readonly owner: string;
    private readonly leaseTtlMilliseconds: number;
    private readonly binaryOption?: boolean;
    private readonly workspace: FileWorkspaceHost;
    private readonly outlineProvider?: OutlineProvider;
    private charsetValue: CharsetInfo = defaultCharset;
    private lastFlush?: { readonly key: string; readonly hash: string };
    readonly path: string;

    constructor(workspace: FileWorkspaceHost, path: string, options: MountOptions = {}) {
        validatePath(path);
        this.workspace = workspace;
        this.path = path;
        this.modeValue = options.mode ?? "read-only";
        this.owner = options.owner ?? `workspace:${workspace.rootId}`;
        this.leaseTtlMilliseconds = options.leaseTtlMilliseconds ?? 30_000;
        this.outlineProvider = options.outline;
        this.binaryOption = options.binary;
    }

    mount(): FileSnapshot {
        if (this.stateValue !== "unmounted") throw new WorkspaceError("already_mounted", `${this.path} is already mounted`);
        const ref = this.ref();
        const storage = this.workspace.storage;
        if (this.binaryOption === true) {
            if (!this.mountBinary(ref)) throw new WorkspaceError("not_found", `File ${this.path} does not exist`);
        } else {
            try {
                const stored = storage.read(ref);
                if (!stored) throw new WorkspaceError("not_found", `File ${this.path} does not exist`);
                this.base = stored;
                this.charsetValue = stored.charset ?? defaultCharset;
            } catch (error) {
                if (!(error instanceof WorkspaceError) || error.code !== "binary_file" || this.binaryOption === false) throw error;
                if (!this.mountBinary(ref)) throw error;
            }
        }
        if (!this.base) throw new WorkspaceError("not_found", `File ${this.path} does not exist`);
        if (this.modeValue === "writable") this.lease = storage.acquireLease(ref, this.owner, this.leaseTtlMilliseconds);
        this.buffer = "";
        this.bufferVersionValue = 0;
        this.binaryDirty = false;
        this.stateValue = "mounted";
        const snapshot = this.snapshot();
        this.emitReceipt("mount", snapshot);
        return snapshot;
    }

    /** Loads opaque bytes as the mount base; returns false when the file is absent. */
    private mountBinary(ref: FileRef): boolean {
        const storage = this.workspace.storage;
        const readBytes = storage.readBytes;
        if (!isFunction(readBytes)) throw new WorkspaceError("invalid_target", "storage cannot read raw bytes");
        const raw = readBytes.call(storage, ref);
        if (!raw) return false;
        this.binaryValue = true;
        this.bytesBuffer = new Uint8Array(raw.bytes);
        this.base = { ...ref, content: "", hash: raw.hash, version: raw.version, updatedAt: raw.updatedAt, size: raw.size };
        return true;
    }

    activate(): FileSnapshot {
        if (this.stateValue !== "mounted" || !this.base) throw new WorkspaceError("not_mounted", `${this.path} body is not mounted`);
        if (!this.binaryValue) this.buffer = this.base.content;
        this.stateValue = "active";
        return this.snapshot();
    }

    read(range?: FileRange, options: ReadOptions = {}): string {
        this.requireActive();
        this.requireText();
        this.detectStale();
        if (this.stateValue === "stale" && !options.allowStale) throw new WorkspaceError("stale", "file base version is stale");
        if (!range) return this.buffer;
        const checked = checkRange(range, this.buffer);
        if (checked.kind === "line") return this.buffer.split("\n").slice(checked.start, checked.end).join("\n");
        return Buffer.from(this.buffer, "utf8").subarray(checked.start, checked.end).toString("utf8");
    }

    /**
     * Replaces the whole buffer, or the region addressed by an explicit target.
     * Line/byte/outline targets keep the surrounding line structure; see `planWrite`.
     */
    write(content: string, target?: FileRange | WriteTarget, options: EditOptions = {}): FileSnapshot {
        return this.commit(this.planWrite(content, target, options));
    }

    /** Dry run for `write`: resolves the target without mutating the buffer. */
    planWrite(content: string, target?: FileRange | WriteTarget, options: EditOptions = {}): EditPlan {
        this.guardEdit(options);
        if (target === undefined) {
            const whole: Region = { start: 0, end: this.buffer.length, text: this.buffer };
            return Object.freeze({ mode: "file", matches: toEditMatches(this.buffer, [whole]), text: content,
                changed: content !== this.buffer, bufferVersion: this.bufferVersionValue });
        }
        const explicit: WriteTarget = isWriteTarget(target) ? target : legacyTarget(target as FileRange);
        if (explicit.mode === "outline" && !this.outlineProvider) {
            throw new WorkspaceError("outline_unavailable", "outline editing requires an outline provider on the mount");
        }
        const region = resolveRegions(this.buffer, explicit, this.outlineProvider, this.path)[0]!;
        const replacement = structuralReplacement(this.buffer, region, content);
        return Object.freeze({ mode: explicit.mode, matches: toEditMatches(this.buffer, [region]),
            text: this.buffer.slice(0, region.start) + replacement + this.buffer.slice(region.end),
            changed: true, bufferVersion: this.bufferVersionValue });
    }

    /**
     * Rewrites the region(s) addressed by `target`. `string`/`regex` require exactly one
     * match unless `occurrence` or `all: true` is given; `$` expansion applies to `regex` only.
     */
    replace(target: ReplaceTarget, replacement: string, options: EditOptions = {}): FileSnapshot {
        return this.commit(this.planReplace(target, replacement, options));
    }

    /** Dry run for `replace`: resolves matches and computes the resulting text. */
    planReplace(target: ReplaceTarget, replacement: string, options: EditOptions = {}): EditPlan {
        this.guardEdit(options);
        return this.buildReplacePlan(target, replacement);
    }

    /** Resolves every region a target addresses; raises on nothing found, never mutates. */
    locate(target: ReplaceTarget): readonly EditMatch[] {
        this.requireActive();
        this.requireText();
        this.detectStale();
        return toEditMatches(this.buffer, resolveRegions(this.buffer, target, this.outlineProvider, this.path));
    }

    /** Outline entries of the current buffer, for choosing an `outline` target id. */
    outline(): readonly OutlineEntry[] {
        this.requireActive();
        this.requireText();
        this.detectStale();
        if (!this.outlineProvider) throw new WorkspaceError("outline_unavailable", "this mount has no outline provider");
        const versionHash = fileDigest(this.buffer);
        return Object.freeze(this.outlineProvider.entries(this.path, this.buffer)
            .map(entry => entry.versionHash === undefined ? Object.freeze({ ...entry, versionHash }) : entry));
    }

    /** Bounded line read carrying the anchors (`baseHash`, `bufferVersion`) an edit needs. */
    readLines(startLine: number, count = 200, options: ReadOptions = {}): LineRead {
        this.requireActive();
        this.requireText();
        this.detectStale();
        if (this.stateValue === "stale" && !options.allowStale) throw new WorkspaceError("stale", "file base version is stale");
        if (!Number.isSafeInteger(startLine) || startLine < 0) throw new WorkspaceError("invalid_range", "startLine must be a nonnegative safe integer");
        if (!Number.isSafeInteger(count) || count <= 0) throw new WorkspaceError("invalid_range", "count must be a positive safe integer");
        const text = new SourceText(this.buffer);
        const totalLines = text.lineCount;
        const endLine = Math.min(startLine + count, totalLines);
        const startIndex = startLine >= totalLines ? this.buffer.length : (text.lineStarts[startLine] ?? this.buffer.length);
        const endIndex = endLine >= totalLines ? this.buffer.length : (text.lineStarts[endLine] ?? this.buffer.length);
        return Object.freeze({
            text: this.buffer.slice(startIndex, endIndex), range: text.range(startIndex, endIndex),
            startLine, lineCount: Math.max(0, endLine - startLine), totalLines, truncated: endLine < totalLines,
            eol: this.charsetValue.eol, baseHash: this.base?.hash ?? "", bufferVersion: this.bufferVersionValue,
        });
    }

    /** Raw bytes of the current buffer; binary mounts read proprietary formats here. */
    readBytes(range?: { readonly start: number; readonly end: number }): Uint8Array {
        this.requireActive();
        this.detectStale();
        const source = this.binaryValue ? this.bytesBuffer : new TextEncoder().encode(this.buffer);
        if (!range) return new Uint8Array(source);
        if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
            || range.start < 0 || range.end < range.start || range.end > source.length) {
            throw new WorkspaceError("invalid_range", "byte range is outside the buffer");
        }
        return source.slice(range.start, range.end);
    }

    /** Replaces the byte buffer of a binary mount; commit with `flush()`. */
    writeBytes(bytes: Uint8Array): FileSnapshot {
        this.requireActive();
        if (!this.binaryValue) throw new WorkspaceError("invalid_target", "file is mounted as text; use write()");
        if (this.modeValue !== "writable") throw new WorkspaceError("read_only", "file is mounted read-only");
        if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
        this.detectStale();
        if (this.stateValue === "stale") throw new WorkspaceError("stale", "file base version is stale");
        this.bytesBuffer = new Uint8Array(bytes);
        this.binaryDirty = true;
        this.bufferVersionValue += 1;
        this.stateValue = "dirty";
        return this.snapshot();
    }

    /** Structural outline of a binary document (DOCX/XLSX/PPTX/PSD/…), from the byte buffer. */
    documentOutline(options: { readonly language?: string } = {}): DocumentOutline {
        this.requireActive();
        this.detectStale();
        if (this.binaryValue) return createDocumentOutline(this.path, this.bytesBuffer, options);
        const storage = this.workspace.storage;
        const readBytes = storage.readBytes;
        if (!isFunction(readBytes)) throw new WorkspaceError("invalid_target", "storage cannot read raw bytes");
        const raw = readBytes.call(storage, this.ref());
        if (!raw) throw new WorkspaceError("not_found", `file ${this.path} does not exist`);
        return createDocumentOutline(this.path, raw.bytes, options);
    }

    /** Contextual diff of the committed base against the current buffer. */
    diff(): string {
        this.requireMounted();
        this.requireText();
        return unifiedDiff(this.base?.content ?? "", this.buffer, `a/${this.path}`, `b/${this.path}`);
    }

    /** Structured hunks for the same comparison `diff()` renders as unified text. */
    diffHunks(base: "disk" | { readonly hash: string } = "disk"): readonly DiffHunk[] {
        this.requireMounted();
        this.requireText();
        return structuredDiffHunks(this.resolveDiffBase(base).content, this.buffer);
    }

    /**
     * Structured diff carrying the baseline identity, full-diff line counts and a hunk bound.
     * The legacy `diff()` string and `diffHunks()` list stay unchanged. A stale base is still
     * diffable, matching those existing views; a binary mount is rejected as `invalid_target`.
     */
    diffStructured(base: "disk" | { readonly hash: string } = "disk", options: { readonly maxHunks?: number } = {}): FileDiff {
        this.requireMounted();
        this.requireText();
        const maxHunks = options.maxHunks ?? 500;
        if (!Number.isSafeInteger(maxHunks) || maxHunks < 0) {
            throw new WorkspaceError("invalid_target", "maxHunks must be a nonnegative safe integer");
        }
        const resolved = this.resolveDiffBase(base);
        const hunks = structuredDiffHunks(resolved.content, this.buffer);
        let added = 0;
        let removed = 0;
        for (const hunk of hunks) {
            added += hunk.added;
            removed += hunk.removed;
        }
        return Object.freeze({
            base: base === "disk" ? "disk" : Object.freeze({ hash: base.hash }),
            baseHash: resolved.hash,
            bufferVersion: this.bufferVersionValue,
            hunks: Object.freeze(hunks.slice(0, maxHunks)),
            summary: Object.freeze({ added, removed, changed: hunks.length }),
            truncated: hunks.length > maxHunks,
        });
    }

    /**
     * Validates workspace scope, base-hash integrity, buffer decodability and outline ranges.
     * The state is never mutated; findings are returned instead of thrown.
     */
    validate(): FileValidation {
        this.requireActive();
        const reasons: string[] = [];
        if (!isString(this.workspace.tenantId) || this.workspace.tenantId === ""
            || !isString(this.workspace.rootId) || this.workspace.rootId === "") reasons.push("workspace scope is incomplete");
        if (this.binaryValue) {
            if (this.base) {
                if (!this.binaryDirty) {
                    const hex = createHash("sha256").update(this.bytesBuffer).digest("hex");
                    if (this.base.hash !== hex && this.base.hash !== `sha256:${hex}`) reasons.push("byte buffer does not match the committed base hash");
                }
                const readBytes = this.workspace.storage.readBytes;
                if (isFunction(readBytes)) {
                    try {
                        const current = readBytes.call(this.workspace.storage, this.ref());
                        if (!current) reasons.push("committed file is missing from storage");
                        else if (current.hash !== this.base.hash) reasons.push("committed base no longer matches the stored byte hash");
                    } catch (error) {
                        reasons.push(`storage byte read failed: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }
            return Object.freeze({ valid: reasons.length === 0, reasons: Object.freeze(reasons) });
        }
        const base = this.base;
        const charset = base?.charset ?? this.charsetValue;
        if (base) {
            const digest = fileDigest(base.content);
            if (base.hash !== digest && base.hash !== `sha256:${digest}`) reasons.push("committed content does not match the committed base hash");
            try {
                const current = this.workspace.storage.read(this.ref());
                if (!current) reasons.push("committed file is missing from storage");
                else if (current.hash !== base.hash) reasons.push("committed base no longer matches the stored file hash");
            } catch (error) {
                reasons.push(`storage read failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (charset.binary) {
            reasons.push("committed charset marks the file as binary");
        } else {
            try {
                const decoded = decodeText(encodeText(this.buffer, charset), charset);
                if (decoded !== normalizeToLf(this.buffer)) reasons.push("buffer does not survive an encode/decode round trip");
            } catch (error) {
                reasons.push(`buffer cannot be encoded as ${charset.encoding}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (this.outlineProvider) {
            try {
                const text = new SourceText(this.buffer);
                for (const entry of this.outlineProvider.entries(this.path, this.buffer)) {
                    if (!isRange(entry.range)) reasons.push(`outline entry ${entry.id} has an invalid range`);
                    else if (entry.range.endLine > text.lineCount || entry.range.endByte > text.byteLength) {
                        reasons.push(`outline entry ${entry.id} has a range outside the buffer`);
                    }
                }
            } catch (error) {
                reasons.push(`outline provider failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return Object.freeze({ valid: reasons.length === 0, reasons: Object.freeze(reasons) });
    }

    /** Resolves a diff baseline by committed hash; only the current committed version is addressable. */
    private resolveDiffBase(base: "disk" | { readonly hash: string }): { readonly content: string; readonly hash: string } {
        if (base === "disk") return { content: this.base?.content ?? "", hash: this.base?.hash ?? "" };
        if (!isObject(base) || !isString(base.hash) || base.hash === "") {
            throw new WorkspaceError("invalid_target", "diff base must be \"disk\" or an object with a hash");
        }
        if (!this.base) throw new WorkspaceError("not_mounted", `${this.path} is not mounted`);
        if (hashKey(base.hash) === hashKey(this.base.hash)) return { content: this.base.content, hash: this.base.hash };
        try {
            const current = this.workspace.storage.read(this.ref());
            if (current && hashKey(current.hash) === hashKey(base.hash)) return { content: current.content, hash: current.hash };
        } catch {
            /* fall through to the explicit version_conflict */
        }
        throw new WorkspaceError("version_conflict", `no baseline matches hash ${base.hash}`);
    }

    /** Applies several edits atomically: every target is resolved on a scratch copy first. */
    apply(edits: readonly EditOp[], options: EditOptions = {}): FileSnapshot {
        return this.commit(this.planApply(edits, options));
    }

    planApply(edits: readonly EditOp[], options: EditOptions = {}): EditPlan {
        if (!Array.isArray(edits) || edits.length === 0) throw new WorkspaceError("invalid_target", "apply needs at least one edit");
        this.guardEdit(options);
        let scratch = this.buffer;
        const matches: EditMatch[] = [];
        for (const [index, edit] of edits.entries()) {
            if (edit.kind === "write") {
                if (edit.target === undefined) {
                    scratch = edit.content;
                    continue;
                }
                const explicit: WriteTarget = isWriteTarget(edit.target) ? edit.target : legacyTarget(edit.target as FileRange);
                const region = resolveRegions(scratch, explicit, this.outlineProvider, this.path)[0]!;
                matches.push(...toEditMatches(scratch, [region]));
                const replacement = structuralReplacement(scratch, region, edit.content);
                scratch = scratch.slice(0, region.start) + replacement + scratch.slice(region.end);
            } else if (edit.kind === "replace") {
                const regions = resolveRegions(scratch, edit.target, this.outlineProvider, this.path);
                if (edit.target.mode === "string" || edit.target.mode === "regex") {
                    const selected = selectRegions(scratch, regions, edit.target as StringTarget | RegexTarget);
                    matches.push(...toEditMatches(scratch, selected));
                    const expand = edit.target.mode === "regex" ? regexReplacement(edit.replacement, scratch) : literalReplacement(edit.replacement);
                    scratch = spliceRegions(scratch, selected, expand);
                } else {
                    const region = regions[0]!;
                    matches.push(...toEditMatches(scratch, [region]));
                    const replacement = structuralReplacement(scratch, region, edit.replacement);
                    scratch = scratch.slice(0, region.start) + replacement + scratch.slice(region.end);
                }
            } else {
                throw new WorkspaceError("invalid_target", `edit ${index} has an unknown kind`);
            }
        }
        return Object.freeze({ mode: "apply", matches: Object.freeze(matches), text: scratch,
            changed: scratch !== this.buffer, bufferVersion: this.bufferVersionValue });
    }

    flush(options: FlushOptions = {}): FileSnapshot {
        this.requireActive();
        if (this.modeValue !== "writable") throw new WorkspaceError("read_only", "file is mounted read-only");
        const snapshot = this.commitFlush(options);
        this.emitReceipt("flush", snapshot);
        return snapshot;
    }

    /** Commit half of `flush`; the public entry point emits the receipt after it returns. */
    private commitFlush(options: FlushOptions): FileSnapshot {
        if (this.binaryValue) {
            if (!this.binaryDirty) return this.snapshot();
            this.detectStale();
            if (this.stateValue === "stale") throw new WorkspaceError("stale", "dirty file has a conflicting host version");
            if (!this.lease || !this.base) throw new WorkspaceError("fence_rejected", "writable file has no lease");
            const commit = this.workspace.storage.compareAndSwapBytes;
            if (!isFunction(commit)) throw new WorkspaceError("invalid_target", "storage cannot commit raw bytes");
            const committed = commit.call(this.workspace.storage, this.ref(), this.base.hash, this.bytesBuffer, this.lease.fence);
            this.base = committed;
            this.binaryDirty = false;
            this.stateValue = "active";
            return this.snapshot();
        }
        const key = options.idempotencyKey;
        if (!this.isDirty()) {
            // A buffer can be back at the base content after an edit (or a reverting replace);
            // it is no longer dirty, so normalize the state instead of leaving it stuck at dirty.
            if (this.stateValue === "dirty") this.stateValue = "active";
            if (key !== undefined) this.lastFlush = { key, hash: this.base?.hash ?? "" };
            return this.snapshot();
        }
        if (key !== undefined && this.lastFlush?.key === key && this.lastFlush.hash === (this.base?.hash ?? "")) {
            return this.snapshot();
        }
        this.detectStale();
        if (this.stateValue === "stale") throw new WorkspaceError("stale", "dirty file has a conflicting host version");
        if (!this.lease || !this.base) throw new WorkspaceError("fence_rejected", "writable file has no lease");
        const committed = this.workspace.storage.compareAndSwap(this.ref(), this.base.hash, this.buffer, this.lease.fence);
        this.base = committed;
        this.charsetValue = committed.charset ?? this.charsetValue;
        if (key !== undefined) this.lastFlush = { key, hash: committed.hash };
        this.stateValue = "active";
        return this.snapshot();
    }

    reload(options: ReloadOptions = {}): FileSnapshot {
        this.requireActive();
        if (this.isDirty() && !options.discardDirty) throw new WorkspaceError("dirty", "reload would discard dirty buffer");
        if (this.binaryValue) {
            if (!this.mountBinary(this.ref())) throw new WorkspaceError("not_found", `File ${this.path} does not exist`);
            this.binaryDirty = false;
            this.bufferVersionValue += 1;
            this.stateValue = "active";
            return this.snapshot();
        }
        const current = this.workspace.storage.read(this.ref());
        if (!current) throw new WorkspaceError("not_found", `File ${this.path} does not exist`);
        this.base = current;
        this.charsetValue = current.charset ?? defaultCharset;
        this.buffer = current.content;
        this.bufferVersionValue += 1;
        this.stateValue = "active";
        return this.snapshot();
    }

    unmount(options: UnmountOptions = {}): void {
        this.requireMounted();
        if (this.isDirty() && !options.discardDirty) throw new WorkspaceError("dirty", "unmount would discard dirty buffer");
        const snapshot = this.snapshot();
        if (this.lease) this.workspace.storage.releaseLease(this.lease);
        this.lease = undefined;
        this.base = undefined;
        this.buffer = "";
        this.bytesBuffer = new Uint8Array();
        this.binaryValue = false;
        this.binaryDirty = false;
        this.stateValue = "unmounted";
        this.emitReceipt("unmount", snapshot);
    }

    snapshot(): FileSnapshot {
        const base = this.base;
        const charset = base?.charset ?? this.charsetValue;
        return { ...this.ref(), state: this.stateValue, mode: this.modeValue, baseHash: base?.hash ?? "", baseVersion: base?.version ?? -1,
            hash: this.binaryValue ? (this.base?.hash ?? "") : fileDigest(this.buffer), version: base?.version ?? -1,
            bufferVersion: this.bufferVersionValue, dirty: this.isDirty(),
            stale: this.stateValue === "stale", encoding: charset.encoding, eol: charset.eol, bom: charset.bom,
            binary: this.binaryValue, size: base?.size ?? 0, lease: this.lease ? clone(this.lease) : undefined };
    }

    conflict(): FileConflict | undefined {
        if (!this.base || !this.isDirty()) return undefined;
        if (this.binaryValue) {
            const readBytes = this.workspace.storage.readBytes;
            if (!isFunction(readBytes)) return undefined;
            const current = readBytes.call(this.workspace.storage, this.ref());
            if (!current || current.hash === this.base.hash) return undefined;
            const theirs: StoredFile = { ...this.ref(), content: "", hash: current.hash, version: current.version,
                updatedAt: current.updatedAt, size: current.size };
            return { ...this.ref(), base: clone(this.base), ours: "", theirs };
        }
        const current = this.workspace.storage.read(this.ref());
        return current && current.hash !== this.base.hash ? { ...this.ref(), base: clone(this.base), ours: this.buffer, theirs: current } : undefined;
    }

    get state(): FileSnapshot["state"] { return this.stateValue; }
    get mode(): WorkspaceMode { return this.modeValue; }
    get dirty(): boolean { return this.isDirty(); }
    get stale(): boolean { return this.stateValue === "stale"; }

    private commit(plan: EditPlan): FileSnapshot {
        if (plan.changed) {
            this.buffer = plan.text;
            this.bufferVersionValue += 1;
            this.stateValue = "dirty";
        }
        return this.snapshot();
    }

    private buildReplacePlan(target: ReplaceTarget, replacement: string): EditPlan {
        const regions = resolveRegions(this.buffer, target, this.outlineProvider, this.path);
        if (target.mode === "string" || target.mode === "regex") {
            const selected = selectRegions(this.buffer, regions, target as StringTarget | RegexTarget);
            const expand = target.mode === "regex" ? regexReplacement(replacement, this.buffer) : literalReplacement(replacement);
            const text = spliceRegions(this.buffer, selected, expand);
            return Object.freeze({ mode: target.mode, matches: toEditMatches(this.buffer, selected),
                text, changed: text !== this.buffer, bufferVersion: this.bufferVersionValue });
        }
        const region = regions[0]!;
        const structural = structuralReplacement(this.buffer, region, replacement);
        const text = this.buffer.slice(0, region.start) + structural + this.buffer.slice(region.end);
        return Object.freeze({ mode: target.mode, matches: toEditMatches(this.buffer, [region]),
            text, changed: text !== this.buffer, bufferVersion: this.bufferVersionValue });
    }

    private emitReceipt(kind: FileOperationKind, snapshot: FileSnapshot): void {
        const hook = this.workspace.onFileReceipt;
        if (!isFunction(hook)) return;
        const lifecycleAnchor = Object.freeze({ tenantId: this.workspace.tenantId, rootId: this.workspace.rootId });
        const receipt: FileOperationReceipt = Object.freeze({
            tenantId: this.workspace.tenantId, rootId: this.workspace.rootId, path: this.path,
            kind, version: snapshot.version, hash: snapshot.baseHash, at: nowIso(), workspaceAnchor: lifecycleAnchor,
        });
        try {
            hook(receipt);
        } catch {
            /* Receipt observers must never turn a completed file operation into a failure. */
        }
    }

    private guardEdit(options: EditOptions): void {
        this.requireActive();
        this.requireText();
        if (this.modeValue !== "writable") throw new WorkspaceError("read_only", "file is mounted read-only");
        this.detectStale();
        if (this.stateValue === "stale") throw new WorkspaceError("stale", "file base version is stale");
        if (options.expectedBufferVersion !== undefined && options.expectedBufferVersion !== this.bufferVersionValue) {
            throw new WorkspaceError("buffer_conflict", `buffer is at version ${this.bufferVersionValue}, expected ${options.expectedBufferVersion}`);
        }
        if (options.expectedBaseHash !== undefined && options.expectedBaseHash !== (this.base?.hash ?? "")) {
            throw new WorkspaceError("version_conflict", "committed base changed since it was read");
        }
    }

    private detectStale(): void {
        if (!this.base || this.stateValue === "unmounted") return;
        if (this.binaryValue) {
            const readBytes = this.workspace.storage.readBytes;
            if (!isFunction(readBytes)) return;
            const current = readBytes.call(this.workspace.storage, this.ref());
            if (!current || current.hash !== this.base.hash) this.stateValue = "stale";
            return;
        }
        const current = this.workspace.storage.read(this.ref());
        if (!current || current.hash !== this.base.hash) this.stateValue = "stale";
    }
    private requireMounted(): void { if (this.stateValue === "unmounted" || !this.base) throw new WorkspaceError("not_mounted", `${this.path} is not mounted`); }
    private requireActive(): void { this.requireMounted(); if (this.stateValue === "mounted") throw new WorkspaceError("not_mounted", `${this.path} body is not active`); }
    private requireText(): void {
        if (this.binaryValue) throw new WorkspaceError("invalid_target", "file is mounted as bytes; use readBytes/writeBytes/documentOutline");
    }
    private isDirty(): boolean {
        if (this.stateValue === "mounted") return false;
        if (this.binaryValue) return this.binaryDirty;
        return this.base !== undefined && this.buffer !== this.base.content;
    }
    private ref(): FileRef { return { tenantId: this.workspace.tenantId, rootId: this.workspace.rootId, path: this.path }; }
}
