import { inflateRawSync } from "node:zlib";
import { Optional, SynchronousUnorderedMap, isString } from "semantic-typescript";
import { DocumentError, defaultDocumentLimits, type DocumentLimits } from "./types.ts";

export interface ZipEntry {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly size: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function invalid(message: string): DocumentError {
    return new DocumentError("invalid_zip", message);
}

function safeName(name: string): void {
    if (!isString(name) || name === "" || name.startsWith("/") || name.includes("\\") || name.includes("\0")
        || name.split("/").some(part => part === "" || part === "." || part === "..")) {
        throw new DocumentError("invalid_zip", `unsafe zip entry name: ${name}`);
    }
}

/**
 * Minimal read-only ZIP reader over a byte buffer using Node's zlib.
 * Supports stored and deflated entries; refuses encryption, zip64 and unsafe names.
 */
export class ZipArchive {
    private readonly entries = new SynchronousUnorderedMap<string, ZipEntry>();
    private readonly order: string[] = [];

    private constructor() {}

    static open(bytes: Uint8Array, limits: DocumentLimits = {}): ZipArchive {
        if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw invalid("not a zip archive");
        const merged = { ...defaultDocumentLimits, ...limits };
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let eocd = -1;
        const searchFrom = Math.max(0, bytes.length - 65_557);
        for (let offset = bytes.length - 22; offset >= searchFrom; offset -= 1) {
            if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
                eocd = offset;
                break;
            }
        }
        if (eocd < 0) throw invalid("zip end-of-central-directory record not found");
        const entryCount = view.getUint16(eocd + 10, true);
        const directorySize = view.getUint32(eocd + 12, true);
        const directoryOffset = view.getUint32(eocd + 16, true);
        if (entryCount === 0xffff || directoryOffset === 0xffffffff) throw new DocumentError("unsupported_zip", "zip64 archives are not supported");
        if (entryCount > merged.maxEntries) throw new DocumentError("limit_exceeded", `zip has ${entryCount} entries; limit is ${merged.maxEntries}`);
        if (directoryOffset + directorySize > bytes.length) throw invalid("zip central directory is out of bounds");
        const archive = new ZipArchive();
        let total = 0;
        let offset = directoryOffset;
        for (let index = 0; index < entryCount; index += 1) {
            if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw invalid("corrupt zip central directory");
            const flags = view.getUint16(offset + 8, true);
            const method = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const uncompressedSize = view.getUint32(offset + 24, true);
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localOffset = view.getUint32(offset + 42, true);
            const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
            offset += 46 + nameLength + extraLength + commentLength;
            safeName(name);
            if ((flags & 0x1) !== 0) throw new DocumentError("unsupported_zip", `encrypted zip entry: ${name}`);
            if (method !== 0 && method !== 8) throw new DocumentError("unsupported_zip", `unsupported compression method ${method} for ${name}`);
            if (archive.entries.containsKey(name)) throw new DocumentError("invalid_zip", `duplicate zip entry: ${name}`);
            if (uncompressedSize > merged.maxEntryBytes) throw new DocumentError("limit_exceeded", `zip entry ${name} exceeds ${merged.maxEntryBytes} bytes`);
            total += uncompressedSize;
            if (total > merged.maxTotalBytes) throw new DocumentError("limit_exceeded", "zip expands beyond the total size budget");
            if (uncompressedSize > Math.max(1024, compressedSize * merged.maxExpansionRatio)) {
                throw new DocumentError("limit_exceeded", `zip entry ${name} exceeds the expansion-ratio budget`);
            }
            if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw invalid(`corrupt local header for ${name}`);
            const localNameLength = view.getUint16(localOffset + 26, true);
            const localExtraLength = view.getUint16(localOffset + 28, true);
            const dataStart = localOffset + 30 + localNameLength + localExtraLength;
            if (dataStart + compressedSize > bytes.length) throw invalid(`truncated zip entry: ${name}`);
            const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
            let content: Uint8Array;
            if (method === 0) content = new Uint8Array(compressed);
            else {
                try {
                    content = new Uint8Array(inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) }));
                } catch (error) {
                    throw invalid(`cannot inflate ${name}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            if (content.length !== uncompressedSize) throw invalid(`size mismatch for ${name}`);
            archive.entries.put(name, Object.freeze({ name, bytes: content, size: content.length }));
            archive.order.push(name);
        }
        return archive;
    }

    names(): readonly string[] {
        return Object.freeze([...this.order]);
    }

    has(name: string): boolean {
        return this.entries.containsKey(name);
    }

    read(name: string): Optional<ZipEntry> {
        return this.entries.get(name);
    }

    text(name: string): Optional<string> {
        return this.entries.get(name).map(entry => new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes));
    }
}
