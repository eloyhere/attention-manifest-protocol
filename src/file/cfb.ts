/**
 * Read-only OLE Compound File Binary (CFB) reader.
 *
 * Legacy Office files (`.doc`, `.xls`, `.ppt`, `.pub`) and many other Windows
 * containers are CFB files: a 512- or 4096-byte header, a FAT, a directory of
 * 128-byte entries and an optional "mini stream" for objects smaller than the
 * header's cutoff. This module implements exactly the read path needed to pull
 * named streams out of such a container.
 *
 * Corruption is expected on legacy or partially downloaded files, so
 * `readCfb` never throws. It returns the entries and streams it could validate
 * plus human-readable warnings for everything it skipped. A caller can decide
 * whether an empty stream map is fatal; the Office parser treats it as a
 * best-effort extraction with a warning.
 *
 * Every stream is capped at 64 MiB, chains are cycle-checked, and all sector
 * indices are validated against the buffer. The reader does not trust the
 * red-black tree links between directory entries; it walks the directory
 * sectors linearly and uses the entry names, which is sufficient for named
 * stream extraction.
 */

/**
 * One directory entry.
 *
 * `size` is the declared stream size. For a storage or root entry it describes
 * the mini stream container or is zero. A corrupt 64-bit size is reported as
 * `0xffffffff` rather than losing precision.
 */
export interface CfbEntry {
    readonly name: string;
    readonly type: "storage" | "stream" | "root";
    readonly size: number;
}

const Signature: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FreeSector: number = 0xffffffff;
const EndOfChain: number = 0xfffffffe;
const FatSector: number = 0xfffffffd;
const DifatSector: number = 0xfffffffc;
const MaxRegularSector: number = 0xfffffffa;
const MaxStreamBytes: number = 64 * 1024 * 1024;
const MaxDirectoryBytes: number = 16 * 1024 * 1024;
const DirectoryEntrySize: number = 128;
const MaxWarnings: number = 48;

/**
 * Compare the eight-byte CFB signature.
 *
 * @param bytes - Candidate container bytes.
 * @returns Whether the signature matches.
 */
const hasCfbSignature: (bytes: Uint8Array) => boolean = (bytes: Uint8Array): boolean => {
    if (bytes.length < Signature.length) {
        return false;
    }
    for (let index: number = 0; index < Signature.length; index += 1) {
        if (bytes[index] !== Signature[index]) {
            return false;
        }
    }
    return true;
};

const uint16: (view: DataView, offset: number) => number = (view: DataView, offset: number): number => view.getUint16(offset, true);

const uint32: (view: DataView, offset: number) => number = (view: DataView, offset: number): number => view.getUint32(offset, true);

/**
 * Concatenate validated byte slices into one buffer.
 *
 * @param chunks - Slices in sector order.
 * @returns A new contiguous byte array.
 */
const concatChunks: (chunks: readonly Uint8Array[]) => Uint8Array = (chunks: readonly Uint8Array[]): Uint8Array => {
    let total: number = 0;
    for (let index: number = 0; index < chunks.length; index += 1) {
        total += chunks[index].length;
    }
    const output: Uint8Array = new Uint8Array(total);
    let offset: number = 0;
    for (let index: number = 0; index < chunks.length; index += 1) {
        output.set(chunks[index], offset);
        offset += chunks[index].length;
    }
    return output;
};

/**
 * Decode a directory-entry name. Names are UTF-16LE, null-terminated, and the
 * stored length includes the terminator.
 *
 * @param directory - Contiguous directory bytes.
 * @param offset - Entry offset.
 * @param nameLength - Byte length from the entry.
 * @returns The sanitized name, or `undefined` when the length is invalid.
 */
const decodeEntryName: (directory: Uint8Array, offset: number, nameLength: number) => string | undefined = (
    directory: Uint8Array,
    offset: number,
    nameLength: number,
): string | undefined => {
    if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0 || offset + nameLength > directory.length) {
        return undefined;
    }
    const codeUnits: number = nameLength / 2 - 1;
    let name: string = "";
    for (let index: number = 0; index < codeUnits; index += 1) {
        const code: number = directory[offset + index * 2] | (directory[offset + index * 2 + 1] << 8);
        if (code === 0 || code < 0x20 || code === 0x7f) {
            return undefined;
        }
        name += String.fromCharCode(code);
    }
    return name.trim();
};

/**
 * Map one CFB object type to the public entry type.
 *
 * @param raw - Raw directory object type.
 * @returns Public type, or `undefined` for unallocated/lock entries.
 */
const entryType: (raw: number) => "storage" | "stream" | "root" | undefined = (raw: number): "storage" | "stream" | "root" | undefined => {
    if (raw === 1) {
        return "storage";
    }
    if (raw === 2) {
        return "stream";
    }
    if (raw === 5) {
        return "root";
    }
    return undefined;
};

/**
 * Read a CFB container.
 *
 * @param bytes - Container bytes.
 * @returns Parsed entries, stream contents keyed by entry name, and warnings.
 */
export const readCfb: (bytes: Uint8Array) => { entries: CfbEntry[]; streams: Map<string, Uint8Array>; warnings: string[] } = (
    bytes: Uint8Array,
): { entries: CfbEntry[]; streams: Map<string, Uint8Array>; warnings: string[] } => {
    const entries: CfbEntry[] = [];
    const streams: Map<string, Uint8Array> = new Map<string, Uint8Array>();
    const warnings: string[] = [];
    const warn: (message: string) => void = (message: string): void => {
        const clean: string = message.replace(/\s+/g, " ").trim().slice(0, 240);
        if (clean.length > 0 && warnings.length < MaxWarnings && !warnings.includes(clean)) {
            warnings.push(clean);
        }
    };
    try {
        if (bytes.length < 512) {
            warn("cfb header is truncated");
            return { entries, streams, warnings };
        }
        if (!hasCfbSignature(bytes)) {
            warn("cfb signature is missing");
            return { entries, streams, warnings };
        }
        const header: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (uint16(header, 28) !== 0xfffe) {
            warn("cfb byte order is not little-endian");
            return { entries, streams, warnings };
        }
        const sectorShift: number = uint16(header, 30);
        if (sectorShift !== 9 && sectorShift !== 12) {
            warn(`cfb sector size ${sectorShift} is unsupported`);
            return { entries, streams, warnings };
        }
        const miniSectorShift: number = uint16(header, 32);
        if (miniSectorShift !== 6) {
            warn("cfb mini-sector size is not 64 bytes");
        }
        const sectorSize: number = 2 ** sectorShift;
        const miniSectorSize: number = 64;
        const sectorCount: number = Math.floor(bytes.length / sectorSize) - 1;
        if (sectorCount <= 0) {
            warn("cfb container has no complete sectors");
            return { entries, streams, warnings };
        }
        const sectorBase: (sector: number) => number = (sector: number): number => (sector + 1) * sectorSize;
        const isRegularSector: (sector: number) => boolean = (sector: number): boolean =>
            sector >= 0 && sector < sectorCount && sectorBase(sector) + sectorSize <= bytes.length;
        const sectorBytes: (sector: number) => Uint8Array | undefined = (sector: number): Uint8Array | undefined => {
            if (!isRegularSector(sector)) {
                return undefined;
            }
            const start: number = sectorBase(sector);
            return bytes.subarray(start, start + sectorSize);
        };
        const readChain: (start: number, size: number, label: string) => Uint8Array = (start: number, size: number, label: string): Uint8Array => {
            if (size <= 0) {
                return new Uint8Array(0);
            }
            const chunks: Uint8Array[] = [];
            const visited: Set<number> = new Set<number>();
            let current: number = start;
            let remaining: number = size;
            while (remaining > 0 && current !== EndOfChain && current !== FreeSector) {
                if (!isRegularSector(current)) {
                    warn(`cfb ${label} points outside the container`);
                    break;
                }
                if (visited.has(current)) {
                    warn(`cfb ${label} contains a sector loop`);
                    break;
                }
                visited.add(current);
                const take: number = Math.min(sectorSize, remaining);
                chunks.push(bytes.subarray(sectorBase(current), sectorBase(current) + take));
                remaining -= take;
                current = current < fat.length ? fat[current] : EndOfChain;
            }
            if (remaining > 0) {
                warn(`cfb ${label} is truncated`);
            }
            return concatChunks(chunks);
        };
        const fatSectorIds: number[] = [];
        for (let index: number = 0; index < 109; index += 1) {
            const sector: number = uint32(header, 76 + index * 4);
            if (sector !== FreeSector) {
                fatSectorIds.push(sector);
            }
        }
        const difatCount: number = Math.min(uint32(header, 72), 65536);
        let difatSector: number = uint32(header, 68);
        let difatRead: number = 0;
        while (difatSector !== EndOfChain && difatSector !== FreeSector && difatRead < difatCount) {
            const data: Uint8Array | undefined = sectorBytes(difatSector);
            if (data === (void 0)) {
                warn("cfb DIFAT sector points outside the container");
                break;
            }
            const dataView: DataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const perSector: number = sectorSize / 4;
            for (let index: number = 0; index < perSector - 1; index += 1) {
                const sector: number = uint32(dataView, index * 4);
                if (sector !== FreeSector) {
                    fatSectorIds.push(sector);
                }
            }
            difatSector = uint32(dataView, sectorSize - 4);
            difatRead += 1;
        }
        if (fatSectorIds.length > sectorCount) {
            warn("cfb FAT sector count exceeds the container size");
        }
        const fat: number[] = [];
        for (let index: number = 0; index < fatSectorIds.length && index < sectorCount; index += 1) {
            const data: Uint8Array | undefined = sectorBytes(fatSectorIds[index]);
            if (data === (void 0)) {
                warn("cfb FAT sector points outside the container");
                break;
            }
            const dataView: DataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const perSector: number = sectorSize / 4;
            for (let entryIndex: number = 0; entryIndex < perSector; entryIndex += 1) {
                fat.push(uint32(dataView, entryIndex * 4));
            }
        }
        if (fat.length === 0) {
            warn("cfb FAT is empty");
            return { entries, streams, warnings };
        }
        const firstDirectorySector: number = uint32(header, 48);
        const directoryChunks: Uint8Array[] = [];
        const visitedDirectory: Set<number> = new Set<number>();
        let directorySector: number = firstDirectorySector;
        let directoryBytes: number = 0;
        while (directorySector !== EndOfChain && directorySector !== FreeSector) {
            if (!isRegularSector(directorySector)) {
                warn("cfb directory sector points outside the container");
                break;
            }
            if (visitedDirectory.has(directorySector)) {
                warn("cfb directory contains a sector loop");
                break;
            }
            visitedDirectory.add(directorySector);
            const data: Uint8Array | undefined = sectorBytes(directorySector);
            if (data === (void 0)) {
                break;
            }
            directoryChunks.push(data);
            directoryBytes += data.length;
            if (directoryBytes > MaxDirectoryBytes) {
                warn("cfb directory exceeds the 16 MiB limit");
                break;
            }
            directorySector = directorySector < fat.length ? fat[directorySector] : EndOfChain;
        }
        if (directoryChunks.length === 0) {
            warn("cfb directory is empty");
            return { entries, streams, warnings };
        }
        const directory: Uint8Array = concatChunks(directoryChunks);
        const directoryView: DataView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
        interface DirectoryRecord {
            readonly name: string;
            readonly type: "storage" | "stream" | "root";
            readonly start: number;
            readonly size: number;
        }
        const records: DirectoryRecord[] = [];
        const entryCount: number = Math.floor(directory.length / DirectoryEntrySize);
        for (let index: number = 0; index < entryCount; index += 1) {
            const offset: number = index * DirectoryEntrySize;
            const rawType: number = directory[offset + 66];
            const type: "storage" | "stream" | "root" | undefined = entryType(rawType);
            if (type === (void 0)) {
                continue;
            }
            const nameLength: number = uint16(directoryView, offset + 64);
            const name: string | undefined = decodeEntryName(directory, offset, nameLength);
            if (name === (void 0) || name.length === 0) {
                warn(`cfb directory entry ${index} has an invalid name`);
                continue;
            }
            const start: number = uint32(directoryView, offset + 116);
            const sizeLow: number = uint32(directoryView, offset + 120);
            const sizeHigh: number = uint32(directoryView, offset + 124);
            if (sizeHigh !== 0) {
                warn(`cfb stream ${name} exceeds the 32-bit size range`);
            }
            const size: number = sizeHigh === 0 ? sizeLow : 0xffffffff;
            records.push({ name, type, start, size });
            entries.push({ name, type, size });
        }
        const root: DirectoryRecord | undefined = records.find((record: DirectoryRecord): boolean => record.type === "root");
        const miniCutoff: number = uint32(header, 56);
        const firstMiniFatSector: number = uint32(header, 60);
        const miniFatCount: number = uint32(header, 64);
        let miniStream: Uint8Array = new Uint8Array(0);
        if (root !== (void 0) && root.size > 0) {
            if (root.size > MaxStreamBytes) {
                warn("cfb root mini stream exceeds the 64 MiB limit");
            } else {
                miniStream = readChain(root.start, root.size, "root mini stream");
            }
        }
        const miniFat: number[] = [];
        if (miniFatCount > 0 && firstMiniFatSector !== EndOfChain && firstMiniFatSector !== FreeSector) {
            const wanted: number = Math.min(miniFatCount, 1024) * sectorSize;
            const data: Uint8Array = readChain(firstMiniFatSector, wanted, "mini FAT");
            const dataView: DataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
            for (let offset: number = 0; offset + 4 <= data.length; offset += 4) {
                miniFat.push(uint32(dataView, offset));
            }
        }
        const readMiniChain: (start: number, size: number, label: string) => Uint8Array = (start: number, size: number, label: string): Uint8Array => {
            if (size <= 0) {
                return new Uint8Array(0);
            }
            if (miniStream.length === 0) {
                warn(`cfb ${label} needs a mini stream that is missing`);
                return new Uint8Array(0);
            }
            const chunks: Uint8Array[] = [];
            const visited: Set<number> = new Set<number>();
            let current: number = start;
            let remaining: number = size;
            while (remaining > 0 && current !== EndOfChain && current !== FreeSector) {
                const offset: number = current * miniSectorSize;
                if (current < 0 || offset + miniSectorSize > miniStream.length) {
                    warn(`cfb ${label} points outside the mini stream`);
                    break;
                }
                if (visited.has(current)) {
                    warn(`cfb ${label} contains a mini-sector loop`);
                    break;
                }
                visited.add(current);
                const take: number = Math.min(miniSectorSize, remaining);
                chunks.push(miniStream.subarray(offset, offset + take));
                remaining -= take;
                current = current < miniFat.length ? miniFat[current] : EndOfChain;
            }
            if (remaining > 0) {
                warn(`cfb ${label} is truncated`);
            }
            return concatChunks(chunks);
        };
        for (let index: number = 0; index < records.length; index += 1) {
            const record: DirectoryRecord = records[index];
            if (record.type !== "stream") {
                continue;
            }
            if (streams.has(record.name)) {
                warn(`cfb stream name ${record.name} is duplicated`);
                continue;
            }
            if (record.size > MaxStreamBytes) {
                warn(`cfb stream ${record.name} exceeds the 64 MiB limit`);
                continue;
            }
            if (record.size === 0) {
                streams.set(record.name, new Uint8Array(0));
                continue;
            }
            const data: Uint8Array =
                record.size < miniCutoff
                    ? readMiniChain(record.start, record.size, `stream ${record.name}`)
                    : readChain(record.start, record.size, `stream ${record.name}`);
            streams.set(record.name, data);
        }
        return { entries, streams, warnings };
    } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : "unknown failure";
        warn(`cfb reader stopped: ${message}`);
        return { entries, streams, warnings };
    }
};

/**
 * Expose the FAT marker names used by this module. Kept internal in practice;
 * tests and diagnostics can compare against the same constants instead of
 * duplicating magic numbers.
 */
export const CfbSectorMarkers: {
    readonly free: number;
    readonly endOfChain: number;
    readonly fat: number;
    readonly difat: number;
    readonly maxRegular: number;
} = {
    free: FreeSector,
    endOfChain: EndOfChain,
    fat: FatSector,
    difat: DifatSector,
    maxRegular: MaxRegularSector,
};
