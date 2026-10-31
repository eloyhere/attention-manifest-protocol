/**
 * Streaming file fingerprints.
 *
 * Files are read with `openSync`/`readSync` in fixed-size chunks and fed to an
 * incremental hasher; `readFileSync` is never used for content. Two reasons, and
 * both are correctness, not performance:
 *
 * 1. Memory. The portable SHA-256 implementation in `algorithm.ts` hashes
 *    in place; a whole-file read plus the padded copy that `sha256Hex` needs
 *    would cost roughly 3x the file size. A 1 MiB chunk keeps that flat.
 * 2. Binary safety. The legacy path decoded the file as UTF-8, so `0x80` and
 *    `0x81` both became U+FFFD and produced the same digest. `mode: "bytes"`
 *    hashes the octets, and `mode: "text"` uses a fatal decoder so invalid
 *    UTF-8 is an error instead of a silent replacement.
 *
 * A file fingerprint covers content and length only —not the path, not the
 * inode, not the mode. `fingerprintFileMeta` exists for "did this path change",
 * and it is explicitly weak; see its documentation.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";

import { assertBackend, bytesToHex, createHasher } from "./algorithm.ts";
import type { AlgorithmId, ByteHasher } from "./algorithm.ts";
import { FingerprintIOError, NormalizationRejected, describeError } from "./error.ts";
import { FileMetaPolicy, Policy } from "./policy.ts";
import { SchemeName, createPayloadHasher, fingerprintPayload, shortForm } from "./preimage.ts";
import type { Fingerprint, FingerprintRef } from "./preimage.ts";
import { encodeUtf8Strict, normalizeTextNfc } from "./text.ts";

/**
 * How the octets are turned into a payload. `bytes` hashes them verbatim;
 * `text` decodes strictly, then applies `text/utf8+nfc+lf`, so a line-ending or
 * BOM change does not change the digest while invalid UTF-8 does.
 */
export type FileFingerprintMode = "bytes" | "text";

/**
 * Option shape for `fingerprintFile`.
 *
 * `chunkBytes` exists for tests and for callers that already read in a fixed
 * block size; it must not change the digest, which the check verifies with 1,
 * 7 and 1 MiB chunks.
 */
export interface FileFingerprintOptions {
    readonly algorithm?: AlgorithmId;
    readonly mode?: FileFingerprintMode;
    readonly chunkBytes?: number;
}

/**
 * A file fingerprint plus the on-disk size.
 *
 * `size` is the file's byte length; `ref.bytes` is the payload that was hashed.
 * They are equal for `mode: "bytes"` and differ for `mode: "text"` when
 * normalisation changes the UTF-8 length (for example, CRLF folding), which is
 * why both numbers are reported instead of one.
 */
export interface FileFingerprint extends Fingerprint {
    readonly size: number;
}

/**
 * Default read size: 1 MiB balances syscall count against the memory a caller
 * is willing to lend to a hash. It is a constant, not a magic number, because
 * `tree.ts` shares it.
 */
const DefaultChunkBytes: number = 1024 * 1024;

type ReadOnlyFlag = "r";
const ReadOnlyFlags: ReadOnlyFlag = "r";

/**
 * Validate the chunk size once, in one place, so a zero or negative value fails
 * before a file is opened instead of producing an infinite loop of zero-byte
 * reads.
 */
export const resolveChunkBytes: (value: number | undefined) => number = (value: number | undefined): number => {
    if (value === (void 0)) {
        return DefaultChunkBytes;
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`chunkBytes must be a positive safe integer, received ${value}`);
    }
    return value;
};

const lstatOrThrow: (path: string) => Stats = (path: string): Stats => {
    try {
        return lstatSync(path);
    } catch (error: unknown) {
        throw new FingerprintIOError([`cannot stat ${path}: ${describeError(error)}`]);
    }
};

const statOrThrow: (path: string) => BigIntStats = (path: string): BigIntStats => {
    try {
        return statSync(path, { bigint: true });
    } catch (error: unknown) {
        throw new FingerprintIOError([`cannot stat ${path}: ${describeError(error)}`]);
    }
};

const openOrThrow: (path: string) => number = (path: string): number => {
    try {
        return openSync(path, ReadOnlyFlags);
    } catch (error: unknown) {
        throw new FingerprintIOError([`cannot open ${path}: ${describeError(error)}`]);
    }
};

const fstatOrThrow: (fd: number, path: string) => Stats = (fd: number, path: string): Stats => {
    try {
        return fstatSync(fd);
    } catch (error: unknown) {
        throw new FingerprintIOError([`cannot stat open file ${path}: ${describeError(error)}`]);
    }
};

const readOrThrow: (fd: number, buffer: Uint8Array, path: string) => number = (fd: number, buffer: Uint8Array, path: string): number => {
    try {
        return readSync(fd, buffer, 0, buffer.length, null);
    } catch (error: unknown) {
        throw new FingerprintIOError([`cannot read ${path}: ${describeError(error)}`]);
    }
};

/**
 * Refuse anything that is not a regular file, and refuse to follow symlinks.
 *
 * Following a link would make the digest depend on where the link points, so the
 * same tree could produce different roots on two machines; the design records
 * symlinks separately (mode 4) for exactly that reason. Directories and devices
 * have no finite content stream, so they are rejected rather than partially
 * read.
 */
const inspectRegularFile: (path: string) => Stats = (path: string): Stats => {
    const stats: Stats = lstatOrThrow(path);
    if (stats.isSymbolicLink()) {
        throw new FingerprintIOError([`${path} is a symbolic link; file fingerprints never follow links`]);
    }
    if (stats.isDirectory()) {
        throw new FingerprintIOError([`${path} is a directory; use fingerprintTree instead`]);
    }
    if (!stats.isFile()) {
        throw new FingerprintIOError([`${path} is not a regular file`]);
    }
    return stats;
};

/**
 * Stream a regular file into `consume`, then prove the read matched the size
 * that was used to build the preimage header.
 *
 * The size check is the part that makes streaming sound: if a writer appends to
 * the file after `lstat` but before the last read, the digest would otherwise be
 * computed over bytes whose length disagrees with the `bytes` field, and the
 * resulting reference would verify against nothing. Failing loudly is the only
 * acceptable outcome —a truncated or extended read is not a fingerprint.
 */
const streamRegularFile: (path: string, chunkBytes: number, expectedSize: number, consume: (chunk: Uint8Array) => void) => number = (path: string, chunkBytes: number, expectedSize: number, consume: (chunk: Uint8Array) => void): number => {
    const fd: number = openOrThrow(path);
    try {
        const opened: Stats = fstatOrThrow(fd, path);
        if (opened.size !== expectedSize) {
            throw new FingerprintIOError([`${path} changed size between stat and open (expected ${expectedSize}, found ${opened.size})`]);
        }
        const buffer: Uint8Array = new Uint8Array(chunkBytes);
        let total: number = 0;
        for (;;) {
            const read: number = readOrThrow(fd, buffer, path);
            if (read === 0) {
                break;
            }
            if (total + read > expectedSize) {
                throw new FingerprintIOError([`${path} grew while being read; the fingerprint would not match its declared length`]);
            }
            consume(buffer.subarray(0, read));
            total += read;
        }
        if (total !== expectedSize) {
            throw new FingerprintIOError([`${path} shrank while being read (expected ${expectedSize}, read ${total})`]);
        }
        return total;
    } finally {
        closeSync(fd);
    }
};

/**
 * Decode one chunk of a UTF-8 stream with `fatal: true`.
 *
 * `ignoreBOM: true` keeps a leading BOM in the decoded text so `normalizeTextNfc`
 * removes exactly one of them. With the default decoder the BOM would be dropped
 * by the decoder *and* again by the policy, which would silently strip two.
 */
const decodeChunk: (decoder: TextDecoder, chunk: Uint8Array, path: string) => string = (decoder: TextDecoder, chunk: Uint8Array, path: string): string => {
    try {
        return decoder.decode(chunk, { stream: true });
    } catch (error: unknown) {
        throw new NormalizationRejected([`${path} is not valid UTF-8: ${describeError(error)}`]);
    }
};

/**
 * Flush the decoder, which is where a truncated multi-byte sequence at end of
 * file is finally rejected. Skipping this call would accept a file that ends in
 * the middle of a code point.
 */
const flushDecoder: (decoder: TextDecoder, path: string) => string = (decoder: TextDecoder, path: string): string => {
    try {
        return decoder.decode();
    } catch (error: unknown) {
        throw new NormalizationRejected([`${path} ends with an incomplete UTF-8 sequence: ${describeError(error)}`]);
    }
};

/**
 * Fingerprint a file's content.
 *
 * `mode: "bytes"` hashes the octets (`file/bytes+chunked`). `mode: "text"`
 * decodes strictly, applies the `text/utf8+nfc+lf` normalisation and hashes the
 * re-encoded payload (`file/text+nfc`); invalid UTF-8 is `NormalizationRejected`,
 * never U+FFFD. Text mode has to hold the decoded string because Unicode
 * normalisation can join characters across chunk boundaries; the read itself is
 * still streamed, and the payload is only re-encoded once.
 */
export const fingerprintFile: (path: string, options?: FileFingerprintOptions) => Promise<FileFingerprint> = async (path: string, options?: FileFingerprintOptions): Promise<FileFingerprint> => {
    const mode: string = options?.mode ?? "bytes";
    if (mode !== "bytes" && mode !== "text") {
        throw new TypeError(`unknown file mode "${mode}"; expected "bytes" or "text"`);
    }
    const algorithm: AlgorithmId = options?.algorithm ?? "sha256";
    const chunkBytes: number = resolveChunkBytes(options?.chunkBytes);
    assertBackend(algorithm);
    const stats: Stats = inspectRegularFile(path);
    const expectedSize: number = stats.size;

    if (mode === "bytes") {
        const hasher: ByteHasher = createPayloadHasher(algorithm, "file", Policy.fileBytes, expectedSize);
        streamRegularFile(path, chunkBytes, expectedSize, (chunk: Uint8Array): void => {
            hasher.update(chunk);
        });
        const digestHex: string = bytesToHex(hasher.digest());
        const ref: FingerprintRef = {
            scheme: SchemeName,
            algorithm,
            kind: "file",
            policy: Policy.fileBytes,
            bytes: expectedSize,
            digest: digestHex,
        };
        return { ref, digest: shortForm(algorithm, digestHex), size: expectedSize };
    }

    const decoder: TextDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let text: string = "";
    streamRegularFile(path, chunkBytes, expectedSize, (chunk: Uint8Array): void => {
        text += decodeChunk(decoder, chunk, path);
    });
    text += flushDecoder(decoder, path);
    const payload: Uint8Array = encodeUtf8Strict(normalizeTextNfc(text));
    const fingerprint: Fingerprint = fingerprintPayload(algorithm, "file", Policy.fileText, payload);
    return { ref: fingerprint.ref, digest: fingerprint.digest, size: expectedSize };
};

/**
 * Weak change-detection fingerprint of a file's metadata: `size\0mtimeNs`.
 *
 * This is **not an integrity fingerprint**. It cannot distinguish two files of
 * the same size and the same nanosecond mtime, it says nothing about content,
 * and both fields are attacker-controlled (a caller can set mtime with
 * `utimes`). It exists for cache invalidation and "did this path change since
 * the last sweep" decisions; use `fingerprintFile` when the question is whether
 * the content is the same. It follows symlinks, unlike the content
 * fingerprints, because it describes the object a path currently resolves to.
 *
 * The `bytes` field counts the metadata payload, not the file size —the file
 * size is embedded verbatim in the payload (`size\0mtimeNs`) so a reader can
 * recover it from the preimage description.
 */
export const fingerprintFileMeta: (path: string) => Promise<Fingerprint> = async (path: string): Promise<Fingerprint> => {
    const stats: BigIntStats = statOrThrow(path);
    const payload: Uint8Array = encodeUtf8Strict(`${stats.size}\u0000${stats.mtimeNs}`);
    return fingerprintPayload("sha256", "file", FileMetaPolicy, payload);
};

/**
 * Content digest of a regular file as bare lowercase hex, with no preimage
 * header. Used by `tree.ts`, whose leaf serialisation embeds a child digest as
 * 32 raw bytes; the file's own type and mode are bound by the leaf, so a second
 * header here would only add a field the tree format does not define.
 */
export const fileContentDigest: (path: string, expectedSize: number, chunkBytes: number) => string = (path: string, expectedSize: number, chunkBytes: number): string => {
    const hasher: ByteHasher = createHasher("sha256");
    streamRegularFile(path, chunkBytes, expectedSize, (chunk: Uint8Array): void => {
        hasher.update(chunk);
    });
    return bytesToHex(hasher.digest());
};
