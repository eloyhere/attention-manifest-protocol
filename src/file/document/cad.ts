/**
 * CAD (`.dxf`, `.dwg`) outline reader.
 *
 * DXF scope: the ASCII DXF group-code stream is read as `code` / `value` pairs. The reader
 * collects layers from the LAYER table (`0 LAYER`, `2 <name>`, optional `62 <color>`),
 * block names from the BLOCKS section (`0 BLOCK`, `2 <name>`), and counts entity types in
 * the ENTITIES section (`0 LINE`, `0 CIRCLE`, ...). Layers and blocks become `"section"`
 * entries and entity types become `"note"` entries with their occurrence count. Geometry,
 * handles, tables other than LAYER, block contents, extents, xdata and binary DXF are not
 * decoded. Missing SECTION/ENDSEC pairs and unknown group codes are tolerated; a group
 * code that is not an integer is `invalid_document`.
 *
 * DWG scope: the six-byte version stamp is recognized for R10 through R2018. R13, R14 and
 * R2000 (AC1012/AC1014/AC1015) expose an uncompressed section locator table: a signed
 * 32-bit section count at 0x15 followed by locator records from 0x19. Two encodings are
 * accepted, selected by which count/table shape fits the file:
 *
 * - The public AC15 layout used by real files: a little-endian count, then 9-byte records
 *   `{ sectionNumber: u8, seeker: i32, size: i32 }` with the two integers little-endian.
 *   The ninth byte is a leading section number, not a trailing pad byte. This shape is
 *   documented by the ACadSharp-derived acadrust reader and was confirmed against
 *   ACadSharp's public AC1014/AC1015 sample DWGs.
 * - The big-endian 8-byte `{ seeker: i32, size: i32 }` contract used by this project's
 *   synthetic fixtures. No public or production DWG using that shape was found; it is a
 *   fixture-compatibility path, not a claim about real DWG wire format.
 *
 * Every in-range locator record becomes one `"section"` entry, including zeroed records
 * that typically mark an unused/reserved section. Section payloads are not interpreted:
 * the object map, objects, object bit streams, handles, entities, layers, blocks and
 * preview images are all outside this reader. The CLASSES payload is deliberately not
 * decoded - real CLASSES sections are sentinel-framed bit streams (`BS`/`B`/text fields,
 * plus R2004+ fields), so the byte-aligned class-name table in the brief cannot be
 * produced honestly from section bytes alone. CLASSES therefore appears only as its
 * section entry; no class entries are invented.
 *
 * R2004 (AC1018) and later compress and encrypt each section (LZ77 plus Reed-Solomon) and
 * are refused with `unsupported_format`. R10/R11/R12 predate the R13 locator table and
 * are refused as well. Unknown `ACdddd` stamps are `invalid_document`.
 *
 * Limits default to `defaultDocumentLimits` and may be narrowed. In DWG outlines
 * `maxNodes` caps the locator records inspected and emitted, and
 * `maxEntriesInOutline`/`maxTextCharacters` clip the projection; any clipping sets
 * `truncated`.
 */
import { TextDecoder } from "node:util";
import {
    DocumentError, defaultDocumentLimits,
    type DocumentEntry, type DocumentEntryKind, type DocumentLimits, type DocumentLocator, type DocumentOutline,
} from "./types.ts";

const DWG_PREFIX = "AC";
const DWG_VERSION_LENGTH = 6;
/** Smallest AC15 header that can contain the section count and an empty locator table. */
const DWG_MIN_HEADER = 0x20;
const DWG_SECTION_COUNT_OFFSET = 0x15;
const DWG_SECTION_TABLE_OFFSET = 0x19;
/** Big-endian `{ seeker, size }` records required by this project's DWG fixtures. */
const CONTRACT_RECORD_BYTES = 8;
/** Little-endian `{ number, seeker, size }` records used by public AC15 DWGs. */
const AC15_RECORD_BYTES = 9;
const DWG_SECTION_PART = "dwg:sections";
const DEFAULT_LAYER_COLOR = 7;
const TABLE_PART = "dxf:tables";
const BLOCK_PART = "dxf:blocks";
const ENTITY_PART = "dxf:entities";
/** `0` records that are structural rather than entity type names. */
const NON_ENTITY_RECORDS: ReadonlySet<string> = new Set([
    "SECTION", "ENDSEC", "EOF", "TABLE", "ENDTAB", "BLOCK", "ENDBLK",
]);

function invalidDocument(message: string): DocumentError {
    return new DocumentError("invalid_document", message);
}

type DwgFamily = "pre-r13" | "ac15" | "compressed";

interface DwgVersion {
    /** Human-facing release name used in errors and reports. */
    readonly name: string;
    readonly family: DwgFamily;
}

/**
 * Recognized version stamps. R13/R14/R2000 are the only linear-section versions this
 * reader can inspect without decompressing or decrypting; the rest are recognized so the
 * caller gets a version-specific refusal instead of a generic "not a DWG".
 */
const DWG_VERSIONS: ReadonlyMap<string, DwgVersion> = new Map<string, DwgVersion>([
    ["AC1006", { name: "R10", family: "pre-r13" }],
    ["AC1009", { name: "R11/R12", family: "pre-r13" }],
    ["AC1012", { name: "R13", family: "ac15" }],
    ["AC1014", { name: "R14", family: "ac15" }],
    ["AC1015", { name: "R2000", family: "ac15" }],
    ["AC1018", { name: "R2004", family: "compressed" }],
    ["AC1021", { name: "R2007", family: "compressed" }],
    ["AC1024", { name: "R2010", family: "compressed" }],
    ["AC1027", { name: "R2013", family: "compressed" }],
    ["AC1032", { name: "R2018", family: "compressed" }],
]);

/** The `AC` prefix is the only reliable way to send a binary DWG into the DWG branch. */
function hasDwgPrefix(bytes: Uint8Array): boolean {
    return bytes.length >= DWG_PREFIX.length
        && bytes[0] === DWG_PREFIX.charCodeAt(0)
        && bytes[1] === DWG_PREFIX.charCodeAt(1);
}

function readDwgVersion(bytes: Uint8Array): string {
    let version = "";
    for (let index = 0; index < DWG_VERSION_LENGTH; index += 1) {
        version += String.fromCharCode(bytes[index]!);
    }
    return version;
}

interface Group {
    readonly code: number;
    readonly value: string;
}

/** Splits the decoded stream into group-code/value pairs; trailing blank lines are dropped. */
function readGroups(text: string): readonly Group[] {
    const lines = text.split(/\r\n|\n|\r/);
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    const groups: Group[] = [];
    for (let index = 0; index < lines.length; index += 2) {
        const codeText = lines[index]!.trim();
        if (!/^[+-]?\d+$/.test(codeText)) {
            throw invalidDocument(`DXF group code is not an integer: ${JSON.stringify(codeText)}`);
        }
        const code = Number.parseInt(codeText, 10);
        if (!Number.isSafeInteger(code)) {
            throw invalidDocument(`DXF group code is outside the safe integer range: ${codeText}`);
        }
        const value = index + 1 < lines.length ? lines[index + 1]!.trim() : "";
        groups.push({ code, value });
    }
    return groups;
}

interface LayerDraft {
    name?: string;
    color?: number;
}

interface BlockDraft {
    name?: string;
}

interface CadScan {
    readonly layers: LayerDraft[];
    readonly blocks: string[];
    readonly entities: Map<string, number>;
}

function integerValue(value: string): number | undefined {
    if (!/^[+-]?\d+$/.test(value)) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Walks the group stream with a small tolerant state machine. Any `0` record ends the
 * previous layer/block record; `ENDSEC` leaves the current section; `EOF` stops the scan.
 */
function scanGroups(groups: readonly Group[]): CadScan {
    const layers: LayerDraft[] = [];
    const blocks: string[] = [];
    const entities = new Map<string, number>();
    let section: string | undefined;
    let awaitingSectionName = false;
    let currentTable: string | undefined;
    let awaitingTableName = false;
    let currentLayer: LayerDraft | undefined;
    let currentBlock: BlockDraft | undefined;

    const finishLayer = (): void => {
        if (currentLayer === undefined) return;
        const name = currentLayer.name;
        if (name !== undefined && name !== "") {
            layers.push({ name, ...(currentLayer.color === undefined ? {} : { color: currentLayer.color }) });
        }
        currentLayer = undefined;
    };
    const finishBlock = (): void => {
        if (currentBlock === undefined) return;
        const name = currentBlock.name;
        if (name !== undefined && name !== "") blocks.push(name);
        currentBlock = undefined;
    };

    for (const group of groups) {
        if (group.code === 0) {
            finishLayer();
            finishBlock();
            awaitingTableName = false;
            const token = group.value.toUpperCase();
            if (token === "EOF") break;
            if (token === "SECTION") {
                section = undefined;
                awaitingSectionName = true;
                currentTable = undefined;
                continue;
            }
            if (awaitingSectionName) awaitingSectionName = false;
            if (token === "ENDSEC") {
                section = undefined;
                awaitingSectionName = false;
                currentTable = undefined;
                continue;
            }
            if (token === "TABLE") {
                currentTable = undefined;
                awaitingTableName = true;
                continue;
            }
            if (token === "ENDTAB") {
                currentTable = undefined;
                continue;
            }
            if (token === "LAYER") {
                if (section === "TABLES" && (currentTable === undefined || currentTable === "LAYER")) {
                    currentLayer = {};
                }
                continue;
            }
            if (token === "BLOCK") {
                if (section === "BLOCKS" || section === undefined) currentBlock = {};
                continue;
            }
            if (token === "ENDBLK") continue;
            if (section === "ENTITIES" && token !== "" && !NON_ENTITY_RECORDS.has(token)) {
                entities.set(token, (entities.get(token) ?? 0) + 1);
            }
            continue;
        }

        if (group.code === 2) {
            if (awaitingSectionName) {
                section = group.value.toUpperCase();
                awaitingSectionName = false;
                continue;
            }
            if (awaitingTableName) {
                currentTable = group.value.toUpperCase();
                awaitingTableName = false;
                continue;
            }
            if (currentLayer !== undefined && currentLayer.name === undefined) {
                currentLayer.name = group.value;
                continue;
            }
            if (currentBlock !== undefined && currentBlock.name === undefined) {
                currentBlock.name = group.value;
            }
            continue;
        }

        if (group.code === 62 && currentLayer !== undefined) {
            const color = integerValue(group.value);
            if (color !== undefined) currentLayer.color = color;
        }
    }
    finishLayer();
    finishBlock();
    return { layers, blocks, entities };
}

interface EntryDraft {
    readonly id: string;
    readonly kind: DocumentEntryKind;
    readonly name: string;
    readonly summary: string;
    readonly locator: DocumentLocator;
}

/** Accumulates entries while enforcing the outline budgets. */
class OutlineBuilder {
    private readonly entries: DocumentEntry[] = [];
    private readonly summaries: string[] = [];
    private readonly maxEntries: number;
    private readonly maxText: number;
    private textLength = 0;
    private truncated = false;

    constructor(limits: DocumentLimits = {}) {
        const merged = { ...defaultDocumentLimits, ...limits };
        this.maxEntries = merged.maxEntriesInOutline;
        this.maxText = merged.maxTextCharacters;
    }

    add(draft: EntryDraft): boolean {
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
        const entry: DocumentEntry = Object.freeze({
            id: draft.id, kind: draft.kind, name: draft.name, summary,
            locator: Object.freeze({ ...draft.locator }),
        });
        this.entries.push(entry);
        this.summaries.push(summary);
        this.textLength += separator + summary.length;
        return true;
    }

    /** Records clipping that happened before any entry could be added (for example maxNodes). */
    markTruncated(): void {
        this.truncated = true;
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

/** Decodes strict UTF-8; invalid byte sequences are a malformed document, not a silent loss. */
function decodeDxf(bytes: Uint8Array): string {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw invalidDocument("DXF is not valid UTF-8 text");
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** One in-range locator record, in table order. */
interface DwgSectionRecord {
    readonly index: number;
    readonly seeker: number;
    readonly size: number;
}

interface DwgSectionTable {
    readonly records: readonly DwgSectionRecord[];
    readonly truncated: boolean;
}

/**
 * Reads one locator-record encoding, or returns undefined when the count/table shape or
 * any emitted record is outside the file. `recordBytes` is 8 for the fixture contract and
 * 9 for the public AC15 record, whose extra byte is a leading section number.
 */
function readSectionTable(
    view: DataView,
    fileLength: number,
    count: number,
    recordBytes: number,
    littleEndian: boolean,
    maxNodes: number,
): DwgSectionTable | undefined {
    if (count < 0) return undefined;
    const tableEnd = DWG_SECTION_TABLE_OFFSET + count * recordBytes;
    if (tableEnd > fileLength) return undefined;
    const limit = Math.min(count, maxNodes);
    const numberBytes = recordBytes - 8;
    const records: DwgSectionRecord[] = [];
    for (let index = 0; index < limit; index += 1) {
        const field = DWG_SECTION_TABLE_OFFSET + index * recordBytes + numberBytes;
        const seeker = view.getInt32(field, littleEndian);
        const size = view.getInt32(field + 4, littleEndian);
        if (seeker < 0 || size < 0 || seeker > fileLength || size > fileLength - seeker) {
            return undefined;
        }
        records.push({ index, seeker, size });
    }
    return { records, truncated: count > limit };
}

/** Reads only section metadata; section payloads are intentionally never touched. */
function parseDwgSections(bytes: Uint8Array, limits: DocumentLimits): DocumentOutline {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const configuredMaxNodes = limits.maxNodes ?? defaultDocumentLimits.maxNodes;
    const maxNodes = Number.isFinite(configuredMaxNodes) ? Math.max(0, Math.floor(configuredMaxNodes)) : 0;
    // The fixture contract is tried first. Real AC15 files have a little-endian count
    // whose big-endian reading is enormous, so their table cannot satisfy the 8-byte
    // shape and they fall through to the public 9-byte layout.
    const contractCount = view.getInt32(DWG_SECTION_COUNT_OFFSET, false);
    const ac15Count = view.getInt32(DWG_SECTION_COUNT_OFFSET, true);
    const table = readSectionTable(view, bytes.length, contractCount, CONTRACT_RECORD_BYTES, false, maxNodes)
        ?? readSectionTable(view, bytes.length, ac15Count, AC15_RECORD_BYTES, true, maxNodes);
    if (table === undefined) {
        throw invalidDocument(
            "DWG section locator table is outside the file or contains an out-of-range section record",
        );
    }
    const builder = new OutlineBuilder(limits);
    if (table.truncated) builder.markTruncated();
    for (const record of table.records) {
        builder.add({
            id: `cad:dwg:section:${record.index}`,
            kind: "section",
            name: `Section ${record.index}`,
            summary: `offset=${record.seeker} size=${record.size}`,
            locator: { part: DWG_SECTION_PART, paragraph: record.index + 1 },
        });
    }
    return builder.outline("cad");
}

/** Reads a DXF outline; unchanged from the original ASCII group-code projection. */
function parseDxf(bytes: Uint8Array, limits: DocumentLimits): DocumentOutline {
    const scan = scanGroups(readGroups(decodeDxf(bytes)));
    const builder = new OutlineBuilder(limits);
    for (const [index, layer] of scan.layers.entries()) {
        builder.add({
            id: `cad:layer:${index + 1}`,
            kind: "section",
            name: layer.name ?? "",
            summary: `layer color=${layer.color ?? DEFAULT_LAYER_COLOR}`,
            locator: { part: TABLE_PART },
        });
    }
    for (const [index, block] of scan.blocks.entries()) {
        builder.add({
            id: `cad:block:${index + 1}`,
            kind: "section",
            name: block,
            summary: "block",
            locator: { part: BLOCK_PART },
        });
    }
    for (const [type, count] of scan.entities) {
        builder.add({
            id: `cad:entity:${type}`,
            kind: "note",
            name: type,
            summary: `${count} entities`,
            locator: { part: ENTITY_PART },
        });
    }
    return builder.outline("cad");
}

/** Dispatches DWG by its six-byte `ACdddd` stamp; everything else stays on the DXF path. */
function parseDwg(bytes: Uint8Array, limits: DocumentLimits): DocumentOutline {
    if (bytes.length < DWG_VERSION_LENGTH) {
        throw invalidDocument("DWG is shorter than its 6-byte version string");
    }
    const version = readDwgVersion(bytes);
    const info = DWG_VERSIONS.get(version);
    if (info === undefined) {
        throw invalidDocument(`DWG version ${JSON.stringify(version)} is not recognized`);
    }
    // Compressed/encrypted and pre-R13 versions are fully identified by the version stamp,
    // so they get their specific refusal even when the header is truncated. Only the
    // linear AC15 layout needs the 0x20-byte minimum before the section table is read.
    if (info.family === "compressed") {
        throw new DocumentError("unsupported_format",
            `DWG ${info.name} sections are compressed/encrypted; export DXF (or R2000-.dwg) for an outline`);
    }
    if (info.family === "pre-r13") {
        throw new DocumentError("unsupported_format",
            `DWG ${info.name} (${version}) predates the R13 section locator table; export DXF for an outline`);
    }
    if (bytes.length < DWG_MIN_HEADER) {
        throw invalidDocument(`DWG ${info.name} header is ${bytes.length} bytes; at least 0x20 are required`);
    }
    return parseDwgSections(bytes, limits);
}

/**
 * Reads a DXF or DWG outline. Compressed/encrypted DWG versions are `unsupported_format`,
 * unknown version stamps are `invalid_document`, and section payloads are never decoded.
 */
export function parseCad(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("cad input must be a Uint8Array");
    if (hasDwgPrefix(bytes)) return parseDwg(bytes, limits);
    return parseDxf(bytes, limits);
}
