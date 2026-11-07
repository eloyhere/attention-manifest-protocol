import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Optional, isString } from "semantic-typescript";
import { decodeText, detectCharset, encodeText, defaultCharset, normalizeToLf, type CharsetInfo } from "./charset.ts";
import { NodeFileLock, lockPathOf } from "./lock.ts";
import { WorkspaceError } from "../workspace/types.ts";
import type { FileLease, FileRef, FileStoragePort, StoredBytes, StoredFile } from "./types.ts";
import type { FileTreeHost, FileTreeMetadata, FileTreeOperation, FileTreeRead, FileTreeRootScope, FileTreeScope } from "./tree.ts";

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface NodeFileStorageOptions {
    /** Absolute workspace root; every path is resolved and confined under it. */
    readonly root: string;
    readonly clock?: () => string;
    /** Files larger than this are refused instead of being loaded as text. */
    readonly maxFileBytes?: number;
    readonly lockTtlMilliseconds?: number;
    readonly fsync?: boolean;
    readonly createRoot?: boolean;
}

function errno(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const code = (error as NodeJS.ErrnoException).code;
    return isString(code) ? code : undefined;
}

function toStorageError(action: string, error: unknown): WorkspaceError {
    const code = errno(error);
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return new WorkspaceError("read_only", `cannot ${action}: ${code}`);
    if (code === "ENOSPC" || code === "EDQUOT") return new WorkspaceError("io_error", `cannot ${action}: no space left`);
    return new WorkspaceError("io_error", `cannot ${action}: ${error instanceof Error ? error.message : String(error)}`);
}

function fsyncDirectory(directory: string): void {
    try {
        const fd = openSync(directory, "r");
        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
    } catch {
        /* directory fsync is unavailable on some platforms (notably Windows) */
    }
}

function textHash(content: string): string {
    return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * Real filesystem `FileStoragePort`: root-confined paths, cross-process lock,
 * hash-checked atomic commit (temp file + rename + fsync) and charset preservation.
 */
export class NodeFileStorage implements FileStoragePort {
    readonly root: string;
    readonly rootReal: string;
    private readonly clock: () => string;
    private readonly maxFileBytes: number;
    private readonly fsync: boolean;
    private readonly lock: NodeFileLock;

    constructor(options: NodeFileStorageOptions) {
        if (!isString(options.root) || !options.root.trim()) throw new TypeError("root is required");
        this.root = resolve(options.root);
        if (options.createRoot ?? true) mkdirSync(this.root, { recursive: true });
        this.rootReal = realpathSync(this.root);
        const max = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
        if (!Number.isSafeInteger(max) || max <= 0) throw new TypeError("maxFileBytes must be a positive safe integer");
        this.maxFileBytes = max;
        this.clock = options.clock ?? (() => new Date().toISOString());
        this.fsync = options.fsync ?? true;
        this.lock = new NodeFileLock({ fsync: this.fsync, ...(options.lockTtlMilliseconds === undefined ? {} : { defaultTtlMilliseconds: options.lockTtlMilliseconds }) });
    }

    /** Resolves a workspace-relative path, rejecting traversal and symlink escape. */
    resolvePath(path: string): string {
        if (!isString(path) || path === "" || path.includes("\0") || path.includes("\\") || path.startsWith("/")
            || /^[A-Za-z]:/.test(path) || path.split("/").some(part => part === "" || part === "." || part === "..")) {
            throw new WorkspaceError("invalid_path", `invalid workspace-relative path: ${path}`);
        }
        const candidate = join(this.rootReal, ...path.split("/"));
        const rel = relative(this.rootReal, candidate);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new WorkspaceError("invalid_path", `path escapes the workspace root: ${path}`);
        const parent = dirname(candidate);
        let parentReal: string;
        try {
            parentReal = realpathSync(parent);
        } catch {
            throw new WorkspaceError("not_found", `parent directory does not exist for ${path}`);
        }
        const parentRel = relative(this.rootReal, parentReal);
        if (parentRel.startsWith("..") || isAbsolute(parentRel)) throw new WorkspaceError("invalid_path", `path escapes the workspace root: ${path}`);
        const target = join(parentReal, basename(candidate));
        try {
            if (lstatSync(target).isSymbolicLink()) throw new WorkspaceError("invalid_path", `symbolic links are not followed: ${path}`);
        } catch (error) {
            if (error instanceof WorkspaceError) throw error;
            if (errno(error) !== "ENOENT") throw toStorageError("inspect", error);
        }
        return target;
    }

    read(ref: FileRef): StoredFile | undefined {
        const path = this.resolvePath(ref.path);
        let stat;
        try {
            stat = lstatSync(path);
        } catch (error) {
            if (errno(error) === "ENOENT") return undefined;
            throw toStorageError("read", error);
        }
        if (!stat.isFile()) return undefined;
        if (stat.size > this.maxFileBytes) throw new WorkspaceError("file_too_large", `${ref.path} is ${stat.size} bytes; limit is ${this.maxFileBytes}`);
        let bytes: Uint8Array;
        try {
            bytes = readFileSync(path);
        } catch (error) {
            throw toStorageError("read", error);
        }
        const charset = detectCharset(bytes);
        if (charset.binary) throw new WorkspaceError("binary_file", `${ref.path} is not editable text`);
        return this.stored(ref, decodeText(bytes, charset), charset, bytes.byteLength, Math.trunc(stat.mtimeMs));
    }

    /** Raw bytes for binary document outline parsing; never decoded as text. */
    readBytes(ref: FileRef): StoredBytes | undefined {
        const path = this.resolvePath(ref.path);
        let stat;
        try {
            stat = lstatSync(path);
        } catch (error) {
            if (errno(error) === "ENOENT") return undefined;
            throw toStorageError("read", error);
        }
        if (!stat.isFile()) return undefined;
        if (stat.size > this.maxFileBytes) throw new WorkspaceError("file_too_large", `${ref.path} is ${stat.size} bytes; limit is ${this.maxFileBytes}`);
        let bytes: Uint8Array;
        try {
            bytes = readFileSync(path);
        } catch (error) {
            throw toStorageError("read", error);
        }
        const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        return Object.freeze({ ...ref, bytes: new Uint8Array(bytes), size: bytes.byteLength, hash,
            version: Math.trunc(stat.mtimeMs), updatedAt: this.clock() });
    }

    compareAndSwapBytes(ref: FileRef, expectedHash: string, bytes: Uint8Array, fence: number): StoredFile {
        if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
        const path = this.resolvePath(ref.path);
        const holder = this.lock.inspect(path);
        if (holder.isEmpty() || holder.get().fence !== fence || this.lock.isExpired(holder.get())) {
            throw new WorkspaceError("fence_rejected", "lease fence is absent, expired, or old");
        }
        const current = this.readBytes(ref);
        if (!current) throw new WorkspaceError("not_found", `file ${ref.path} does not exist`);
        if (current.hash !== expectedHash) throw new WorkspaceError("version_conflict", "base hash changed before commit");
        if (bytes.byteLength > this.maxFileBytes) throw new WorkspaceError("file_too_large", `result would exceed ${this.maxFileBytes} bytes`);
        this.writeAtomic(path, bytes);
        const stat = statSync(path);
        const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        return Object.freeze({ ...ref, content: "", hash, version: Math.trunc(stat.mtimeMs),
            updatedAt: this.clock(), size: bytes.byteLength });
    }

    compareAndSwap(ref: FileRef, expectedHash: string, content: string, fence: number): StoredFile {
        const path = this.resolvePath(ref.path);
        const holder = this.lock.inspect(path);
        if (holder.isEmpty() || holder.get().fence !== fence || this.lock.isExpired(holder.get())) {
            throw new WorkspaceError("fence_rejected", "lease fence is absent, expired, or old");
        }
        const current = this.read(ref);
        if (!current) throw new WorkspaceError("not_found", `file ${ref.path} does not exist`);
        if (current.hash !== expectedHash) throw new WorkspaceError("version_conflict", "base hash changed before commit");
        const charset = current.charset ?? defaultCharset;
        if (charset.mixedEol) throw new WorkspaceError("mixed_eol", `${ref.path} mixes line endings; normalize it before editing`);
        const bytes = encodeText(content, charset);
        if (bytes.byteLength > this.maxFileBytes) throw new WorkspaceError("file_too_large", `result would exceed ${this.maxFileBytes} bytes`);
        this.writeAtomic(path, bytes);
        const stat = statSync(path);
        return this.stored(ref, normalizeToLf(content), charset, bytes.byteLength, Math.trunc(stat.mtimeMs));
    }

    acquireLease(ref: FileRef, owner: string, ttlMilliseconds?: number): FileLease {
        const path = this.resolvePath(ref.path);
        let stat;
        try {
            stat = statSync(path);
        } catch (error) {
            if (errno(error) === "ENOENT") throw new WorkspaceError("not_found", `file ${ref.path} does not exist`);
            throw toStorageError("lease", error);
        }
        if (!stat.isFile()) throw new WorkspaceError("not_found", `file ${ref.path} does not exist`);
        const handle = this.lock.acquire(path, owner, ttlMilliseconds);
        return Object.freeze({ ...ref, owner, fence: handle.record.fence, token: handle.record.token, expiresAt: handle.record.expiresAt });
    }

    releaseLease(lease: FileLease): void {
        const path = this.resolvePath(lease.path);
        this.lock.release(path, lease.token);
    }

    /** Current lock holder of a file, if any. */
    inspectLock(ref: FileRef) {
        return this.lock.inspect(this.resolvePath(ref.path));
    }

    private stored(ref: FileRef, content: string, charset: CharsetInfo, size: number, version: number): StoredFile {
        return Object.freeze({ ...ref, content, hash: textHash(content), version, updatedAt: this.clock(), charset, size });
    }

    private writeAtomic(path: string, bytes: Uint8Array): void {
        const directory = dirname(path);
        const temp = join(directory, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
        let fd: number | undefined;
        try {
            fd = openSync(temp, "wx", 0o600);
            writeSync(fd, bytes);
            if (this.fsync) fsyncSync(fd);
            closeSync(fd);
            fd = undefined;
            renameSync(temp, path);
            if (this.fsync) fsyncDirectory(directory);
        } catch (error) {
            if (fd !== undefined) {
                try {
                    closeSync(fd);
                } catch {
                    /* already closed */
                }
            }
            try {
                unlinkSync(temp);
            } catch {
                /* temp may not exist */
            }
            throw toStorageError("commit", error);
        }
    }
}

/** Real filesystem tree host for `FileTree`; reads go through the same storage adapter. */
export function createNodeFileTreeHost(storage: NodeFileStorage, scope: FileTreeRootScope): FileTreeHost {
    const revision = (): string => String(Math.trunc(statSync(storage.rootReal).mtimeMs));
    const directoryMetadata = (path: string): Optional<FileTreeMetadata> => {
        const absolute = path === "" ? storage.rootReal : storage.resolvePath(path);
        let stat;
        try {
            stat = lstatSync(absolute);
        } catch {
            return Optional.empty();
        }
        if (stat.isSymbolicLink()) return Optional.empty();
        if (stat.isDirectory()) {
            const version = Math.trunc(stat.mtimeMs);
            return Optional.of(Object.freeze({ ...scope, path, kind: "directory", version, hash: `dir:${version}`, revision: revision() }));
        }
        if (!stat.isFile()) return Optional.empty();
        try {
            const stored = storage.read({ ...scope, path });
            if (!stored) return Optional.empty();
            return Optional.of(Object.freeze({ ...scope, path, kind: "file", version: stored.version, hash: stored.hash, revision: revision() }));
        } catch {
            return Optional.empty();
        }
    };
    return Object.freeze({
        metadata: directoryMetadata,
        listChildren(target: FileTreeScope): readonly FileTreeMetadata[] {
            const absolute = target.path === "" ? storage.rootReal : storage.resolvePath(target.path);
            let entries;
            try {
                entries = readdirSync(absolute, { withFileTypes: true });
            } catch (error) {
                throw toStorageError("list directory", error);
            }
            const children: FileTreeMetadata[] = [];
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                const childPath = target.path === "" ? entry.name : `${target.path}/${entry.name}`;
                const found = directoryMetadata(childPath);
                if (found.isPresent()) children.push(found.get());
            }
            return Object.freeze(children.sort((left, right) => left.path.localeCompare(right.path)));
        },
        readFile(target: FileTreeScope): FileTreeRead {
            const stored = storage.read({ ...scope, path: target.path });
            if (!stored) throw new WorkspaceError("not_found", `file ${target.path} does not exist`);
            return Object.freeze({ ...scope, path: target.path, content: stored.content, version: stored.version,
                hash: stored.hash, revision: revision() });
        },
        authorize(_operation: FileTreeOperation): boolean {
            // Policy is the caller's responsibility; the adapter only confines paths.
            return true;
        },
        revision,
    });
}

export { NodeFileLock, lockPathOf };
