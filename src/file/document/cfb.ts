/**
 * Read-only OLE Compound File Binary (CFB) container reader.
 *
 * A CFB file is the container behind legacy Office documents, 3ds Max `.max`
 * scenes and SolidWorks parts/assemblies/drawings. This module implements the
 * complete container read path: both versions of the header (v3 with 512-byte
 * sectors and v4 with 4096-byte sectors), the header DIFAT plus chained DIFAT
 * sectors, the FAT, the directory red-black tree (`child`/`left`/`right` links
 * are walked as a parent/child hierarchy), regular stream chains, the mini
 * stream and its mini FAT, and the `\u0005SummaryInformation` /
 * `\u0005DocumentSummaryInformation` property-set streams.
 *
 * Scope ends at the container. The payload of a stream is returned byte-for-byte
 * by `cfbStream` but is never interpreted here: 3ds Max scene graphs and
 * SolidWorks feature trees/configuration/dimension data live in proprietary
 * streams whose formats are not public, so this module makes no claim about
 * their semantics.
 *
 * All structural reads are budgeted. Directory entries are capped by
 * `maxEntriesInOutline` (the document projections use `CFB_DIRECTORY_FLOOR` so
 * a narrow outline budget truncates instead of rejecting the container), every
 * stream is capped by `maxEntryBytes` and the cumulative stream bytes by
 * `maxTotalBytes`, every chain by `maxNodes`, and storage nesting by
 * `maxDepth`. Cycles, out-of-range sectors and malformed directory links raise
 * `DocumentError("invalid_document", ...)`; exhausted budgets raise
 * `DocumentError("limit_exceeded", ...)`.
 *
 * Property sets are decoded best-effort: a missing or unsupported property is
 * skipped instead of failing the container read, and only string-shaped values
 * (VT_LPSTR, VT_LPWSTR and VT_FILETIME rendered as an ISO-8601 timestamp) are
 * surfaced through `CfbProperties`. Numeric values such as VT_I2/VT_I4 are not
 * coerced to text.
 */
import {
    Optional, SynchronousUnorderedMap, SynchronousUnorderedSet, isNumber, isString,
} from "semantic-typescript";
import {
    DocumentError, defaultDocumentLimits, type DocumentEntry, type DocumentEntryKind, type DocumentLimits,
    type DocumentLocator, type DocumentOutline,
} from "./types.ts";

/** One directory entry of a compound file, in DFS order (parents before children). */
export interface CfbEntry {
    readonly name: string;
    readonly kind: "root" | "storage" | "stream";
    /** Container-relative path, for example `Root/Storage/Stream`; the root is `Root`. */
    readonly path: string;
    readonly parentPath?: string;
    /** Declared stream size in bytes; storages and the root report 0. */
    readonly size: number;
    /** Lower-case GUID string, or all zeroes when the entry declares no CLSID. */
    readonly clsid: string;
    /** Creation FILETIME rendered as ISO-8601, omitted when zero or unrepresentable. */
    readonly createdAt?: string;
    /** Last-modification FILETIME rendered as ISO-8601, omitted when zero or unrepresentable. */
    readonly modifiedAt?: string;
}

/** Human-readable string properties recovered from the two summary streams. */
export interface CfbProperties {
    readonly [name: string]: string;
}

export interface CfbFile {
    readonly entries: readonly CfbEntry[];
    readonly properties: CfbProperties;
    readonly majorVersion: number;
    readonly sectorSize: number;
}

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const MAXREGSECT = 0xfffffffa;
const NOSTREAM = 0xffffffff;
const HEADER_BYTES = 512;
const DIRECTORY_ENTRY_BYTES = 128;
const MINI_SECTOR_BYTES = 64;
const MINI_SECTOR_SHIFT = 6;
const MAX_HEADER_DIFAT_ENTRIES = 109;
const MAX_PROPERTY_SETS = 16;
const MAX_PROPERTY_VALUES = 4096;
/**
 * Directory-scan floor used by the `.max` and SolidWorks projections. Those
 * parsers forward their outline budget separately, so a narrow
 * `maxEntriesInOutline` must truncate the projection rather than make the
 * container unreadable.
 */
export const CFB_DIRECTORY_FLOOR = 16_384;
const MAX_NAME_CHARACTERS = 120;
const ZERO_CLSID = "00000000-0000-0000-0000-000000000000";
const SUMMARY_STREAM_NAME = "\u0005SummaryInformation";
const DOCUMENT_SUMMARY_STREAM_NAME = "\u0005DocumentSummaryInformation";

/** Raw SummaryInformation property ids (PIDSI_*). */
const SUMMARY_PROPERTY_NAMES: Readonly<Record<number, string>> = Object.freeze({
    2: "Title",
    3: "Subject",
    4: "Author",
    5: "Keywords",
    6: "Comments",
    8: "LastSavedBy",
    9: "RevisionNumber",
    12: "CreateTime",
    13: "LastSaveTime",
    // Some producers put Manager/Company in SummaryInformation; accept them there too.
    14: "Manager",
    15: "Company",
    18: "ApplicationName",
});

/** Raw DocumentSummaryInformation property ids (PIDDSI_*). */
const DOCUMENT_SUMMARY_PROPERTY_NAMES: Readonly<Record<number, string>> = Object.freeze({
    2: "Category",
    4: "ByteCount",
    14: "Manager",
    15: "Company",
});

/** FMTID of the user-defined section of DocumentSummaryInformation; its ids collide with PIDDSI. */
const USER_DEFINED_FMTID = Object.freeze([
    0x05, 0xd5, 0xcd, 0xd5, 0x9c, 0x2e, 0x1b, 0x10, 0x93, 0x97, 0x08, 0x00, 0x2b, 0x2c, 0xf9, 0xae,
] as const);

/** Marker used to keep stream bytes reachable from `cfbStream` without widening the public shape. */
const STREAM_DATA: unique symbol = Symbol("attention-manifest-protocol.cfb.streams");

function invalidDocument(message: string): DocumentError {
    return new DocumentError("invalid_document", message);
}

function limitExceeded(message: string): DocumentError {
    return new DocumentError("limit_exceeded", message);
}

function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

function hex(value: number, width: number): string {
    return value.toString(16).padStart(width, "0");
}

/**
 * Formats the 16-byte CLSID field of a directory entry. The first three GUID
 * components are little-endian; the last eight bytes are raw.
 */
function formatClsid(bytes: Uint8Array, offset: number): string {
    const view = viewOf(bytes);
    const data1 = view.getUint32(offset, true);
    const data2 = view.getUint16(offset + 4, true);
    const data3 = view.getUint16(offset + 6, true);
    let tail = "";
    for (let index = 8; index < 16; index += 1) tail += hex(bytes[offset + index]!, 2);
    if (data1 === 0 && data2 === 0 && data3 === 0 && tail === "0000000000000000") return ZERO_CLSID;
    return `${hex(data1, 8)}-${hex(data2, 4)}-${hex(data3, 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

/**
 * Converts a Windows FILETIME (100 ns since 1601-01-01 UTC) to ISO-8601.
 * Zero, out-of-range and unrepresentable values yield `undefined` so callers
 * can omit the field instead of inventing a date.
 */
function filetimeToIso(low: number, high: number): string | undefined {
    if (!isNumber(low) || !isNumber(high)) return undefined;
    if (high < 0 || low < 0) return undefined;
    // FILETIME is a 64-bit tick count: use BigInt so 2020-era timestamps keep
    // their exact millisecond even though they exceed Number.MAX_SAFE_INTEGER.
    const ticks = (BigInt(high) << 32n) | BigInt(low);
    if (ticks <= 0n) return undefined;
    const milliseconds = Number((ticks - 116_444_736_000_000_000n) / 10_000n);
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 8_640_000_000_000_000) return undefined;
    const date = new Date(milliseconds);
    const time = date.getTime();
    if (Number.isNaN(time)) return undefined;
    return date.toISOString();
}

/** Decodes UTF-16LE code units; a trailing odd byte is ignored. */
function decodeUtf16Le(bytes: Uint8Array): string {
    let text = "";
    for (let index = 0; index + 1 < bytes.length; index += 2) {
        text += String.fromCharCode(bytes[index]! | (bytes[index + 1]! << 8));
    }
    return text;
}

function codePageLabel(codePage: number | undefined): string {
    switch (codePage) {
        case 1200: return "utf-16le";
        case 65001: return "utf-8";
        case 20127: return "us-ascii";
        case 1250: return "windows-1250";
        case 1251: return "windows-1251";
        case 1252: return "windows-1252";
        case 1253: return "windows-1253";
        case 1254: return "windows-1254";
        case 1255: return "windows-1255";
        case 1256: return "windows-1256";
        case 1257: return "windows-1257";
        case 1258: return "windows-1258";
        case 932: return "shift_jis";
        case 936: return "gbk";
        case 949: return "euc-kr";
        case 950: return "big5";
        default: return "windows-1252";
    }
}

function isKnownCodePage(value: number): boolean {
    return value === 0 || value === 1200 || value === 65001 || value === 20127
        || (value >= 1250 && value <= 1258)
        || value === 932 || value === 936 || value === 949 || value === 950;
}

function decodeCodePage(bytes: Uint8Array, codePage: number | undefined): string {
    try {
        return new TextDecoder(codePageLabel(codePage)).decode(bytes);
    } catch {
        return new TextDecoder("windows-1252").decode(bytes);
    }
}

/** Cuts at the first NUL (property strings may pad with trailing NULs) and trims. */
function cleanPropertyString(value: string): string {
    const nul = value.indexOf("\u0000");
    return (nul >= 0 ? value.slice(0, nul) : value).trim();
}

/**
 * Reads the TypedPropertyValue at `offset`. The OLEPS layout is a 2-byte type,
 * a 2-byte zero padding and then the value. A few historical writers omit the
 * padding, so string/timestamp readers try the padded layout first and fall
 * back to the unpadded one when the length or terminator is implausible.
 */
function readPropertyValue(view: DataView, bytes: Uint8Array, offset: number, codePage: number | undefined): string | undefined {
    if (offset < 0 || offset + 2 > bytes.length) return undefined;
    const type = view.getUint16(offset, true);
    if (type === 30) return readCodePageString(view, bytes, offset, codePage);
    if (type === 31) return readUnicodeString(view, bytes, offset);
    if (type === 64) return readFileTimeValue(view, bytes, offset);
    return undefined;
}

function readCodePageString(view: DataView, bytes: Uint8Array, offset: number, codePage: number | undefined): string | undefined {
    for (const base of [4, 2] as const) {
        const lengthOffset = offset + base;
        if (lengthOffset + 4 > bytes.length) continue;
        const length = view.getUint32(lengthOffset, true);
        if (length === 0) return "";
        const dataOffset = lengthOffset + 4;
        if (length > bytes.length - dataOffset) continue;
        const raw = bytes.subarray(dataOffset, dataOffset + length);
        if (raw.length === 0 || raw[raw.length - 1] !== 0) continue;
        return decodeCodePage(raw, codePage);
    }
    return undefined;
}

function readUnicodeString(view: DataView, bytes: Uint8Array, offset: number): string | undefined {
    for (const base of [4, 2] as const) {
        const lengthOffset = offset + base;
        if (lengthOffset + 4 > bytes.length) continue;
        const length = view.getUint32(lengthOffset, true);
        if (length === 0) return "";
        const dataOffset = lengthOffset + 4;
        if (length > Math.floor((bytes.length - dataOffset) / 2)) continue;
        const raw = bytes.subarray(dataOffset, dataOffset + length * 2);
        if (raw.length < 2 || raw[raw.length - 1] !== 0 || raw[raw.length - 2] !== 0) continue;
        return decodeUtf16Le(raw);
    }
    return undefined;
}

function readFileTimeValue(view: DataView, bytes: Uint8Array, offset: number): string | undefined {
    for (const base of [4, 2] as const) {
        if (offset + base + 8 > bytes.length) continue;
        const iso = filetimeToIso(view.getUint32(offset + base, true), view.getUint32(offset + base + 4, true));
        if (iso !== undefined) return iso;
    }
    return undefined;
}

function readCodePageValue(view: DataView, bytes: Uint8Array, offset: number): number | undefined {
    if (offset + 8 > bytes.length || view.getUint16(offset, true) !== 2) return undefined;
    const padded = view.getInt16(offset + 4, true);
    const bare = view.getInt16(offset + 2, true);
    if (padded !== 0 && isKnownCodePage(padded)) return padded;
    if (bare !== 0 && isKnownCodePage(bare)) return bare;
    return padded;
}

function matchesFmtid(bytes: Uint8Array, offset: number): boolean {
    for (let index = 0; index < USER_DEFINED_FMTID.length; index += 1) {
        if (bytes[offset + index] !== USER_DEFINED_FMTID[index]) return false;
    }
    return true;
}

/**
 * Parses one property-set stream and merges its string properties into
 * `values`. Structural surprises (bad byte order, clipped offsets, unknown
 * types) are ignored; this function never throws on property data.
 */
function readPropertySet(
    bytes: Uint8Array, names: Readonly<Record<number, string>>, values: SynchronousUnorderedMap<string, string>,
): void {
    if (bytes.length < 28) return;
    const view = viewOf(bytes);
    if (view.getUint16(0, true) !== 0xfffe) return;
    const declaredSets = view.getUint32(24, true);
    const availableSets = Math.floor((bytes.length - 28) / 20);
    const setCount = Math.min(declaredSets, availableSets, MAX_PROPERTY_SETS);
    for (let setIndex = 0; setIndex < setCount; setIndex += 1) {
        const descriptor = 28 + setIndex * 20;
        if (matchesFmtid(bytes, descriptor)) continue;
        const setOffset = view.getUint32(descriptor + 16, true);
        if (setOffset + 8 > bytes.length) continue;
        readPropertySetValues(view, bytes, setOffset, names, values);
    }
}

function readPropertySetValues(
    view: DataView, bytes: Uint8Array, setOffset: number,
    names: Readonly<Record<number, string>>, values: SynchronousUnorderedMap<string, string>,
): void {
    const declaredValues = view.getUint32(setOffset + 4, true);
    const availableValues = Math.floor((bytes.length - setOffset - 8) / 8);
    const valueCount = Math.min(declaredValues, availableValues, MAX_PROPERTY_VALUES);
    interface PropertyDescriptor {
        readonly id: number;
        readonly offset: number;
    }
    const descriptors: PropertyDescriptor[] = [];
    let codePage: number | undefined;
    for (let index = 0; index < valueCount; index += 1) {
        const descriptor = setOffset + 8 + index * 8;
        const id = view.getUint32(descriptor, true);
        const relative = view.getUint32(descriptor + 4, true);
        const valueOffset = setOffset + relative;
        if (valueOffset < 0 || valueOffset + 4 > bytes.length) continue;
        descriptors.push({ id, offset: valueOffset });
        if (id === 1) {
            const declaredCodePage = readCodePageValue(view, bytes, valueOffset);
            if (declaredCodePage !== undefined) codePage = declaredCodePage;
        }
    }
    for (const descriptor of descriptors) {
        if (descriptor.id === 1) continue;
        const name = names[descriptor.id];
        if (!isString(name) || name === "" || values.containsKey(name)) continue;
        const value = readPropertyValue(view, bytes, descriptor.offset, codePage);
        if (!isString(value)) continue;
        const text = cleanPropertyString(value);
        if (text !== "") values.put(name, text);
    }
}

interface CfbHeader {
    readonly majorVersion: number;
    readonly sectorSize: number;
    readonly sectorCount: number;
    readonly numFatSectors: number;
    readonly firstDirectorySector: number;
    readonly miniStreamCutoff: number;
    readonly firstMiniFatSector: number;
    readonly numMiniFatSectors: number;
    readonly firstDifatSector: number;
    readonly numDifatSectors: number;
    readonly difat: readonly number[];
}

function readHeader(bytes: Uint8Array): CfbHeader {
    if (bytes.length < HEADER_BYTES) throw invalidDocument("compound file header is truncated");
    for (let index = 0; index < SIGNATURE.length; index += 1) {
        if (bytes[index] !== SIGNATURE[index]) throw invalidDocument("compound file signature is missing");
    }
    const view = viewOf(bytes);
    const majorVersion = view.getUint16(0x1a, true);
    if (majorVersion !== 3 && majorVersion !== 4) {
        throw invalidDocument(`unsupported compound file major version ${majorVersion}`);
    }
    if (view.getUint16(0x1c, true) !== 0xfffe) {
        throw invalidDocument("compound file byte order is not little-endian");
    }
    const sectorShift = view.getUint16(0x1e, true);
    const expectedShift = majorVersion === 3 ? 9 : 12;
    if (sectorShift !== expectedShift) {
        throw invalidDocument(`compound file version ${majorVersion} requires sector shift ${expectedShift}, found ${sectorShift}`);
    }
    if (view.getUint16(0x20, true) !== MINI_SECTOR_SHIFT) {
        throw invalidDocument("compound file mini-sector shift is not 6 (64-byte mini sectors)");
    }
    // `numDirectorySectors` is advisory for a v3 file and is normally zero. The
    // directory is always followed through the FAT chain below, so a producer
    // that fills this field anyway must not make an otherwise readable file fail.
    const sectorSize = 2 ** sectorShift;
    const sectorCount = Math.max(0, Math.floor(bytes.length / sectorSize) - 1);
    const numFatSectors = view.getUint32(0x2c, true);
    const firstDirectorySector = view.getUint32(0x30, true);
    const miniStreamCutoff = view.getUint32(0x38, true);
    const firstMiniFatSector = view.getUint32(0x3c, true);
    const numMiniFatSectors = view.getUint32(0x40, true);
    const firstDifatSector = view.getUint32(0x44, true);
    const numDifatSectors = view.getUint32(0x48, true);
    if (numFatSectors > sectorCount) {
        throw invalidDocument(`compound file declares ${numFatSectors} FAT sectors but only ${sectorCount} sectors exist`);
    }
    if (numMiniFatSectors > sectorCount) {
        throw invalidDocument(`compound file declares ${numMiniFatSectors} mini FAT sectors but only ${sectorCount} sectors exist`);
    }
    if (numDifatSectors > sectorCount) {
        throw invalidDocument(`compound file declares ${numDifatSectors} DIFAT sectors but only ${sectorCount} sectors exist`);
    }
    const difat: number[] = [];
    for (let index = 0; index < MAX_HEADER_DIFAT_ENTRIES; index += 1) {
        difat.push(view.getUint32(0x4c + index * 4, true));
    }
    return {
        majorVersion, sectorSize, sectorCount, numFatSectors, firstDirectorySector, miniStreamCutoff,
        firstMiniFatSector, numMiniFatSectors, firstDifatSector, numDifatSectors, difat,
    };
}

interface SectorSpace {
    readonly sectorSize: number;
    readonly sectorCount: number;
    isRegular(sector: number): boolean;
    read(sector: number): Uint8Array;
}

function createSectorSpace(bytes: Uint8Array, header: CfbHeader): SectorSpace {
    const sectorSize = header.sectorSize;
    const sectorCount = header.sectorCount;
    const isRegular = (sector: number): boolean =>
        isNumber(sector) && Number.isInteger(sector) && sector >= 0 && sector <= MAXREGSECT
        && sector < sectorCount && (sector + 1) * sectorSize + sectorSize <= bytes.length;
    return Object.freeze({
        sectorSize,
        sectorCount,
        isRegular,
        read(sector: number): Uint8Array {
            if (!isRegular(sector)) throw invalidDocument(`compound file sector ${sector} is outside the container`);
            const offset = (sector + 1) * sectorSize;
            return bytes.subarray(offset, offset + sectorSize);
        },
    });
}

class ChainBudget {
    private used: number = 0;
    private readonly maxNodes: number;

    constructor(maxNodes: number) {
        this.maxNodes = maxNodes;
    }

    spend(label: string): void {
        this.used += 1;
        if (this.used > this.maxNodes) {
            throw limitExceeded(`compound file ${label} exceeds the ${this.maxNodes} node budget`);
        }
    }
}

function readFatTable(header: CfbHeader, sectors: SectorSpace, budget: ChainBudget): readonly number[] {
    const fatSectorIds: number[] = [];
    const seen = new SynchronousUnorderedSet<number>();
    const addFatSector = (id: number): void => {
        // `numFatSectors` is authoritative: DIFAT slots after that many entries
        // are padding, and historical writers sometimes zero-fill instead of
        // writing FREESECT. Ignore the padding rather than rejecting the file.
        if (fatSectorIds.length >= header.numFatSectors) return;
        if (!sectors.isRegular(id)) throw invalidDocument(`compound file FAT sector ${id} is outside the container`);
        if (!seen.add(id)) throw invalidDocument(`compound file lists FAT sector ${id} more than once`);
        fatSectorIds.push(id);
    };
    for (const id of header.difat) {
        if (id === FREESECT) continue;
        addFatSector(id);
    }
    if (header.numDifatSectors > 0) {
        let current = header.firstDifatSector;
        const visited = new SynchronousUnorderedSet<number>();
        for (let index = 0; index < header.numDifatSectors; index += 1) {
            if (!sectors.isRegular(current)) {
                throw invalidDocument(`compound file DIFAT sector ${current} is outside the container`);
            }
            if (!visited.add(current)) throw invalidDocument("compound file DIFAT chain contains a loop");
            budget.spend("DIFAT chain");
            const data = sectors.read(current);
            const view = viewOf(data);
            const entries = sectors.sectorSize / 4 - 1;
            for (let entry = 0; entry < entries; entry += 1) {
                const id = view.getUint32(entry * 4, true);
                if (id !== FREESECT) addFatSector(id);
            }
            const next = view.getUint32(sectors.sectorSize - 4, true);
            if (index + 1 < header.numDifatSectors) {
                if (next === ENDOFCHAIN || next === FREESECT) {
                    throw invalidDocument("compound file DIFAT chain is shorter than declared");
                }
                current = next;
            }
            // The next pointer of the final declared DIFAT sector is padding:
            // ENDOFCHAIN when spec-compliant, but historical writers leave zero. Ignore it.
        }
    }
    if (fatSectorIds.length < header.numFatSectors) {
        throw invalidDocument(
            `compound file declares ${header.numFatSectors} FAT sectors but the DIFAT lists ${fatSectorIds.length}`,
        );
    }
    const entriesPerSector = sectors.sectorSize / 4;
    const fat: number[] = [];
    for (const id of fatSectorIds) {
        const view = viewOf(sectors.read(id));
        for (let entry = 0; entry < entriesPerSector; entry += 1) {
            fat.push(view.getUint32(entry * 4, true));
        }
    }
    return Object.freeze(fat);
}

function readDirectoryChain(
    header: CfbHeader, fat: readonly number[], sectors: SectorSpace, budget: ChainBudget,
): Uint8Array {
    const start = header.firstDirectorySector;
    if (start === ENDOFCHAIN || start === FREESECT) return new Uint8Array(0);
    if (start > MAXREGSECT) {
        throw invalidDocument(`compound file directory starts at invalid sector marker 0x${start.toString(16)}`);
    }
    const chunks: Uint8Array[] = [];
    const visited = new SynchronousUnorderedSet<number>();
    let current = start;
    while (current !== ENDOFCHAIN) {
        if (current === FREESECT) throw invalidDocument("compound file directory chain reaches a free sector");
        if (current > MAXREGSECT) {
            throw invalidDocument(`compound file directory chain contains invalid sector marker 0x${current.toString(16)}`);
        }
        if (!sectors.isRegular(current)) {
            throw invalidDocument(`compound file directory sector ${current} is outside the container`);
        }
        if (!visited.add(current)) throw invalidDocument("compound file directory chain contains a loop");
        budget.spend("directory chain");
        chunks.push(sectors.read(current));
        if (current >= fat.length) {
            throw invalidDocument(`compound file FAT does not cover directory sector ${current}`);
        }
        current = fat[current]!;
    }
    return concatChunks(chunks);
}

interface DirectoryRecord {
    readonly index: number;
    readonly name: string;
    readonly kind: "root" | "storage" | "stream";
    readonly left: number;
    readonly right: number;
    readonly child: number;
    readonly clsid: string;
    readonly createdAt: string | undefined;
    readonly modifiedAt: string | undefined;
    readonly startingSector: number;
    readonly size: number;
}

function directoryEntryKind(raw: number, name: string): "root" | "storage" | "stream" {
    if (raw === 1) return "storage";
    if (raw === 2) return "stream";
    if (raw === 5) return "root";
    throw invalidDocument(`compound file entry ${name} has unsupported object type ${raw}`);
}

function decodeDirectoryName(bytes: Uint8Array, entryIndex: number, nameLength: number): string {
    if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) {
        throw invalidDocument(`compound file directory entry ${entryIndex} has an invalid name length ${nameLength}`);
    }
    const units = nameLength / 2;
    let name = "";
    for (let index = 0; index < units; index += 1) {
        const code = bytes[index * 2]! | (bytes[index * 2 + 1]! << 8);
        if (index === units - 1) {
            if (code !== 0) throw invalidDocument(`compound file directory entry ${entryIndex} name is not NUL-terminated`);
            break;
        }
        name += String.fromCharCode(code);
    }
    if (name === "") throw invalidDocument(`compound file directory entry ${entryIndex} has an empty name`);
    if (name.includes("/") || name.includes("\\") || name.includes("\u0000")) {
        throw invalidDocument(`compound file directory entry ${entryIndex} name ${name} contains a path separator`);
    }
    return name;
}

function compoundStreamSize(low: number, high: number, majorVersion: number, name: string): number {
    if (majorVersion === 3) {
        if (high !== 0) throw invalidDocument(`version 3 compound file entry ${name} declares a 64-bit stream size`);
        return low;
    }
    if (high > 0x1fffff) throw invalidDocument(`compound file entry ${name} declares an unrepresentable stream size`);
    return high * 0x100000000 + low;
}

function parseDirectory(
    directory: Uint8Array, header: CfbHeader, limits: Required<DocumentLimits>,
): readonly DirectoryRecord[] {
    const entryCount = Math.floor(directory.length / DIRECTORY_ENTRY_BYTES);
    if (entryCount === 0) return Object.freeze([]);
    const view = viewOf(directory);
    const entryLimit = isNumber(limits.maxEntriesInOutline)
        ? Math.floor(limits.maxEntriesInOutline)
        : defaultDocumentLimits.maxEntriesInOutline;
    const records: DirectoryRecord[] = [];
    for (let index = 0; index < entryCount; index += 1) {
        const offset = index * DIRECTORY_ENTRY_BYTES;
        const objectType = directory[offset + 0x42]!;
        if (objectType === 0) continue;
        if (records.length >= entryLimit) {
            throw limitExceeded(`compound file directory has more than ${entryLimit} entries`);
        }
        const nameLength = view.getUint16(offset + 0x40, true);
        const name = decodeDirectoryName(directory.subarray(offset), index, nameLength);
        const record: DirectoryRecord = {
            index,
            name,
            kind: directoryEntryKind(objectType, name),
            left: view.getUint32(offset + 0x44, true),
            right: view.getUint32(offset + 0x48, true),
            child: view.getUint32(offset + 0x4c, true),
            clsid: formatClsid(directory, offset + 0x50),
            createdAt: filetimeToIso(view.getUint32(offset + 0x64, true), view.getUint32(offset + 0x68, true)),
            modifiedAt: filetimeToIso(view.getUint32(offset + 0x6c, true), view.getUint32(offset + 0x70, true)),
            startingSector: view.getUint32(offset + 0x74, true),
            size: compoundStreamSize(
                view.getUint32(offset + 0x78, true), view.getUint32(offset + 0x7c, true), header.majorVersion, name,
            ),
        };
        records.push(record);
    }
    return Object.freeze(records);
}

function locateRoot(records: readonly DirectoryRecord[]): number {
    let root = -1;
    for (const record of records) {
        if (record.kind !== "root") continue;
        if (root >= 0) throw invalidDocument("compound file has more than one root directory entry");
        root = record.index;
    }
    if (root >= 0) return root;
    if (records.length === 0) return -1;
    throw invalidDocument("compound file has no root directory entry");
}

function readFatChain(
    start: number, size: number, fat: readonly number[], sectors: SectorSpace, budget: ChainBudget, label: string,
): Uint8Array {
    if (size <= 0) return new Uint8Array(0);
    if (start > MAXREGSECT) {
        throw invalidDocument(`compound file ${label} starts at invalid sector marker 0x${start.toString(16)}`);
    }
    const output = new Uint8Array(size);
    const visited = new SynchronousUnorderedSet<number>();
    let current = start;
    let written = 0;
    while (written < size) {
        if (current === ENDOFCHAIN) throw invalidDocument(`compound file ${label} is shorter than its declared size`);
        if (current === FREESECT) throw invalidDocument(`compound file ${label} chain reaches a free sector`);
        if (current > MAXREGSECT) {
            throw invalidDocument(`compound file ${label} chain contains invalid sector marker 0x${current.toString(16)}`);
        }
        if (!sectors.isRegular(current)) {
            throw invalidDocument(`compound file sector ${current} in ${label} is outside the container`);
        }
        if (!visited.add(current)) throw invalidDocument(`compound file ${label} chain contains a loop`);
        budget.spend(label);
        const take = Math.min(sectors.sectorSize, size - written);
        output.set(sectors.read(current).subarray(0, take), written);
        written += take;
        if (written < size) {
            if (current >= fat.length) throw invalidDocument(`compound file FAT does not cover sector ${current} in ${label}`);
            current = fat[current]!;
        }
    }
    return output;
}

class CfbReader {
    private readonly limits: Required<DocumentLimits>;
    private readonly header: CfbHeader;
    private readonly sectors: SectorSpace;
    private readonly budget: ChainBudget;
    private readonly fat: readonly number[];
    private readonly records: readonly DirectoryRecord[];
    private readonly rootIndex: number;
    private readonly entries: CfbEntry[] = [];
    private readonly streams: SynchronousUnorderedMap<string, Uint8Array> = new SynchronousUnorderedMap();
    private readonly visited: SynchronousUnorderedSet<number> = new SynchronousUnorderedSet();
    private miniStream: Uint8Array | undefined = undefined;
    private miniFat: readonly number[] | undefined = undefined;
    private totalStreamBytes: number = 0;

    constructor(bytes: Uint8Array, limits: Required<DocumentLimits>) {
        this.limits = limits;
        this.header = readHeader(bytes);
        this.sectors = createSectorSpace(bytes, this.header);
        this.budget = new ChainBudget(limits.maxNodes);
        this.fat = readFatTable(this.header, this.sectors, this.budget);
        const directory = readDirectoryChain(this.header, this.fat, this.sectors, this.budget);
        this.records = parseDirectory(directory, this.header, limits);
        this.rootIndex = locateRoot(this.records);
    }

    read(): CfbFile {
        if (this.rootIndex >= 0) this.walk();
        const file: CfbFile = {
            entries: Object.freeze([...this.entries]),
            properties: this.collectProperties(),
            majorVersion: this.header.majorVersion,
            sectorSize: this.header.sectorSize,
        };
        Object.defineProperty(file, STREAM_DATA, { value: this.streams, enumerable: false });
        return Object.freeze(file);
    }

    private walk(): void {
        const root = this.records[this.rootIndex]!;
        this.entries.push(this.toEntry(root, "Root", undefined));
        if (root.child !== NOSTREAM) this.walkChildren(root.child, "Root", 1);
    }

    private walkChildren(treeRoot: number, parentPath: string, depth: number): void {
        if (depth > this.limits.maxDepth) {
            throw limitExceeded(`compound file storage nesting exceeds the ${this.limits.maxDepth} level budget`);
        }
        const ordered = this.inorderTree(treeRoot);
        const names = new SynchronousUnorderedSet<string>();
        for (const index of ordered) {
            const record = this.records[index]!;
            if (!names.add(record.name.toUpperCase())) {
                throw invalidDocument(`compound file storage ${parentPath} contains duplicate entry ${record.name}`);
            }
            const path = `${parentPath}/${record.name}`;
            this.entries.push(this.toEntry(record, path, parentPath));
            if (record.kind === "stream") this.materializeStream(record, path);
            else if (record.child !== NOSTREAM) this.walkChildren(record.child, path, depth + 1);
        }
    }

    /** In-order walk of one sibling tree; catches cycles and shared entries. */
    private inorderTree(treeRoot: number): readonly number[] {
        const ordered: number[] = [];
        const stack: number[] = [];
        let current = treeRoot;
        while (current !== NOSTREAM || stack.length > 0) {
            while (current !== NOSTREAM) {
                if (current === this.rootIndex) {
                    if (this.rootIndex === 0) {
                        // A few producers zero-fill unused `left`/`right`/`child`
                        // fields instead of writing NOSTREAM. Entry 0 is the root and
                        // can never be a legitimate tree node, so treat that sentinel
                        // as the end of the sibling list.
                        current = NOSTREAM;
                        continue;
                    }
                    throw invalidDocument("compound file root entry appears inside a storage tree");
                }
                if (!isNumber(current) || !Number.isInteger(current) || current < 0 || current >= this.records.length) {
                    throw invalidDocument(`compound file directory references entry ${current}, which is outside the directory`);
                }
                if (!this.visited.add(current)) {
                    throw invalidDocument("compound file directory tree contains a loop or a shared entry");
                }
                this.budget.spend("directory tree");
                stack.push(current);
                current = this.records[current]!.left;
            }
            if (stack.length === 0) break;
            const index = stack.pop()!;
            ordered.push(index);
            current = this.records[index]!.right;
        }
        return ordered;
    }

    private toEntry(record: DirectoryRecord, path: string, parentPath: string | undefined): CfbEntry {
        const entry: CfbEntry = {
            name: record.name,
            kind: record.kind,
            path,
            ...(parentPath === undefined ? {} : { parentPath }),
            size: record.kind === "stream" ? record.size : 0,
            clsid: record.clsid,
            ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
            ...(record.modifiedAt === undefined ? {} : { modifiedAt: record.modifiedAt }),
        };
        return Object.freeze(entry);
    }

    private materializeStream(record: DirectoryRecord, path: string): void {
        if (record.size > this.limits.maxEntryBytes) {
            throw limitExceeded(`compound file stream ${path} declares ${record.size} bytes; the limit is ${this.limits.maxEntryBytes}`);
        }
        this.totalStreamBytes += record.size;
        if (this.totalStreamBytes > this.limits.maxTotalBytes) {
            throw limitExceeded(`compound file streams exceed the ${this.limits.maxTotalBytes} byte total budget`);
        }
        let data: Uint8Array;
        if (record.size === 0) {
            data = new Uint8Array(0);
        } else if (record.size < this.header.miniStreamCutoff) {
            data = this.readMiniChain(record.startingSector, record.size, `stream ${path}`);
        } else {
            data = readFatChain(record.startingSector, record.size, this.fat, this.sectors, this.budget, `stream ${path}`);
        }
        this.streams.put(path, data);
    }

    private ensureMiniStream(): Uint8Array {
        if (this.miniStream !== undefined) return this.miniStream;
        const root = this.records[this.rootIndex]!;
        if (root.size === 0) {
            throw invalidDocument("compound file has no mini stream for a small stream");
        }
        if (root.size > this.limits.maxTotalBytes) {
            throw limitExceeded(`compound file mini stream declares ${root.size} bytes; the total budget is ${this.limits.maxTotalBytes}`);
        }
        this.miniStream = readFatChain(root.startingSector, root.size, this.fat, this.sectors, this.budget, "mini stream");
        return this.miniStream;
    }

    private ensureMiniFat(): readonly number[] {
        if (this.miniFat !== undefined) return this.miniFat;
        if (this.header.numMiniFatSectors === 0) {
            this.miniFat = Object.freeze([] as number[]);
            return this.miniFat;
        }
        const size = this.header.numMiniFatSectors * this.header.sectorSize;
        const data = readFatChain(this.header.firstMiniFatSector, size, this.fat, this.sectors, this.budget, "mini FAT");
        const view = viewOf(data);
        const entries: number[] = [];
        for (let offset = 0; offset + 4 <= data.length; offset += 4) entries.push(view.getUint32(offset, true));
        this.miniFat = Object.freeze(entries);
        return this.miniFat;
    }

    private readMiniChain(start: number, size: number, label: string): Uint8Array {
        const miniStream = this.ensureMiniStream();
        const miniFat = this.ensureMiniFat();
        if (start > MAXREGSECT) {
            throw invalidDocument(`compound file ${label} starts at invalid mini-sector marker 0x${start.toString(16)}`);
        }
        const output = new Uint8Array(size);
        const visited = new SynchronousUnorderedSet<number>();
        let current = start;
        let written = 0;
        while (written < size) {
            if (current === ENDOFCHAIN) throw invalidDocument(`compound file ${label} is shorter than its declared size`);
            if (current === FREESECT) throw invalidDocument(`compound file ${label} mini-chain reaches a free sector`);
            if (current > MAXREGSECT) {
                throw invalidDocument(`compound file ${label} mini-chain contains invalid marker 0x${current.toString(16)}`);
            }
            const offset = current * MINI_SECTOR_BYTES;
            if (offset + MINI_SECTOR_BYTES > miniStream.length) {
                throw invalidDocument(`compound file mini sector ${current} in ${label} is outside the mini stream`);
            }
            if (!visited.add(current)) throw invalidDocument(`compound file ${label} mini-chain contains a loop`);
            this.budget.spend(label);
            const take = Math.min(MINI_SECTOR_BYTES, size - written);
            output.set(miniStream.subarray(offset, offset + take), written);
            written += take;
            if (written < size) {
                if (current >= miniFat.length) {
                    throw invalidDocument(`compound file mini FAT does not cover mini sector ${current} in ${label}`);
                }
                current = miniFat[current]!;
            }
        }
        return output;
    }

    private collectProperties(): CfbProperties {
        const values = new SynchronousUnorderedMap<string, string>();
        this.parsePropertyStream(`Root/${SUMMARY_STREAM_NAME}`, SUMMARY_PROPERTY_NAMES, values);
        this.parsePropertyStream(`Root/${DOCUMENT_SUMMARY_STREAM_NAME}`, DOCUMENT_SUMMARY_PROPERTY_NAMES, values);
        const properties: { [name: string]: string } = {};
        values.forEach((name, value) => {
            properties[name] = value;
        });
        return Object.freeze(properties);
    }

    private parsePropertyStream(
        path: string, names: Readonly<Record<number, string>>, values: SynchronousUnorderedMap<string, string>,
    ): void {
        const stream = this.streams.get(path);
        if (stream.isEmpty()) return;
        try {
            readPropertySet(stream.get(), names, values);
        } catch {
            // Property sets are metadata: a broken one never fails the container read.
        }
    }
}

/**
 * Reads a compound file. The returned entries are in DFS order (the root is
 * `Root`, then each storage immediately followed by its descendants), and
 * stream bytes are materialized under the `maxEntryBytes` / `maxTotalBytes`
 * budgets so `cfbStream` can return them without re-reading the container.
 */
export function readCfb(bytes: Uint8Array, limits: DocumentLimits = {}): CfbFile {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("compound file input must be a Uint8Array");
    const merged: Required<DocumentLimits> = { ...defaultDocumentLimits, ...limits };
    return new CfbReader(bytes, merged).read();
}

/** Stream bytes for a container path such as `Root/Storage/Stream`; empty when absent. */
export function cfbStream(file: CfbFile, path: string): Optional<Uint8Array> {
    if (!isString(path) || path === "") return Optional.empty<Uint8Array>();
    if (file === null || typeof file !== "object") return Optional.empty<Uint8Array>();
    const state = file as CfbFile & { readonly [STREAM_DATA]?: SynchronousUnorderedMap<string, Uint8Array> };
    const streams = state[STREAM_DATA];
    if (streams === undefined) return Optional.empty<Uint8Array>();
    return streams.get(path);
}

interface OutlineDraft {
    readonly id: string;
    readonly parentId?: string;
    readonly kind: DocumentEntryKind;
    readonly name: string;
    readonly summary: string;
    readonly locator: DocumentLocator;
}

class OutlineBuilder {
    private readonly entries: DocumentEntry[] = [];
    private readonly summaries: string[] = [];
    private readonly maxEntries: number;
    private readonly maxText: number;
    private textLength: number = 0;
    private truncated: boolean = false;

    constructor(limits: DocumentLimits = {}) {
        const merged = { ...defaultDocumentLimits, ...limits };
        this.maxEntries = merged.maxEntriesInOutline;
        this.maxText = merged.maxTextCharacters;
    }

    add(draft: OutlineDraft): boolean {
        if (this.entries.length >= this.maxEntries) {
            this.truncated = true;
            return false;
        }
        const separator = this.entries.length === 0 ? 0 : 1;
        const available = this.maxText - this.textLength - separator;
        if (available < 0) {
            this.truncated = true;
            return false;
        }
        let summary = draft.summary;
        if (summary.length > available) {
            if (available <= 0) {
                this.truncated = true;
                return false;
            }
            summary = summary.slice(0, available);
            this.truncated = true;
        }
        const name = draft.name.length > MAX_NAME_CHARACTERS ? draft.name.slice(0, MAX_NAME_CHARACTERS) : draft.name;
        const entry: DocumentEntry = Object.freeze({
            id: draft.id,
            kind: draft.kind,
            name,
            summary,
            locator: Object.freeze({ ...draft.locator }),
            ...(draft.parentId === undefined ? {} : { parentId: draft.parentId }),
        });
        this.entries.push(entry);
        this.summaries.push(summary);
        this.textLength += separator + summary.length;
        return true;
    }

    outline(language: string): DocumentOutline {
        let text = this.summaries.join("\n");
        if (text.length > this.maxText) {
            text = text.slice(0, this.maxText);
            this.truncated = true;
        }
        return Object.freeze({ language, entries: Object.freeze([...this.entries]), text, truncated: this.truncated });
    }
}

/**
 * Projects a parsed container into the shared document outline shape.
 *
 * Storages become `section` entries and streams become `note` entries; each
 * node's `id` is `cfb:{n}` in DFS order. The two summary property sets add
 * further `note` entries whose locator part is `cfb:properties`. The root
 * storage itself is not projected, so a valid container with no children
 * yields an empty outline.
 */
export function cfbOutline(file: CfbFile, language: string, limits: DocumentLimits = {}): DocumentOutline {
    const builder = new OutlineBuilder(limits);
    const ids = new SynchronousUnorderedMap<string, string>();
    let ordinal = 0;
    for (const entry of file.entries) {
        if (entry.kind === "root") continue;
        ordinal += 1;
        const id = `cfb:${ordinal}`;
        const parentId = entry.parentPath === undefined
            ? undefined
            : ids.get(entry.parentPath).orElse(undefined) ?? undefined;
        const isStream = entry.kind === "stream";
        const added = builder.add({
            id,
            ...(parentId === undefined ? {} : { parentId }),
            kind: isStream ? "note" : "section",
            name: isStream ? `${entry.name} (${entry.size} bytes)` : entry.name,
            summary: isStream ? `stream ${entry.size} bytes` : `${entry.path} ${entry.clsid}`,
            locator: { part: "cfb", paragraph: ordinal },
        });
        if (!added) return builder.outline(language);
        ids.put(entry.path, id);
    }
    let propertyIndex = 0;
    for (const [name, value] of Object.entries(file.properties)) {
        propertyIndex += 1;
        ordinal += 1;
        const added = builder.add({
            id: `cfb:${ordinal}`,
            kind: "note",
            name,
            summary: value,
            locator: { part: "cfb:properties", paragraph: propertyIndex },
        });
        if (!added) break;
    }
    return builder.outline(language);
}
