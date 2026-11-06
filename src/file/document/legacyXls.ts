/**
 * Legacy Excel (`.xls`) BIFF8 outline reader.
 *
 * Scope: the workbook is an OLE Compound File Binary (CFB) container with a
 * `Workbook` stream. This reader parses the BIFF8 record framing
 * (`id u16`, `length u16`, data, with `CONTINUE` records folded into the record
 * they continue), the globals substream (BOF, BOUNDSHEET, SST), and the cached
 * cell values of each worksheet substream: `LABELSST`, `LABEL`, `NUMBER`, `RK`,
 * `MULRK` and `FORMULA`. Formula results are never evaluated; only the cached
 * result is projected, and a cached string result is skipped because the string
 * itself lives in a separate `STRING` record that this reader does not follow.
 * RK numbers are decoded (30-bit integer or truncated IEEE-754 double, with the
 * divide-by-100 flag) and floats are formatted with JavaScript's shortest
 * round-trip decimal form.
 *
 * Not interpreted: styles and number formats (`XF`, `FORMAT`), rich-text runs
 * and phonetic/extended string data beyond skipping their bytes, comments,
 * merged cells, defined names, tables, charts, pivot tables, macros, external
 * links and drawing objects. A BIFF5 `Book` stream is detected and refused with
 * `unsupported_format`; so is an encrypted/protected workbook (`FILEPASS`).
 *
 * Each BOUNDSHEET produces one `sheet` entry in workbook order
 * (`xls:sheet:{n}`, one-based), immediately followed by that sheet's value-bearing
 * cells (`xls:cell:{n}:{A1}`). `locator.part` is the fixed pseudo-part
 * `xls:Workbook`, `locator.sheet` the sheet name and `locator.cell` the A1
 * reference. The sheet summary reports the number of distinct occupied rows and
 * the number of projected cells. Empty and whitespace-only string cells are not
 * projected; the first record for a repeated A1 reference wins.
 *
 * Budgets default to `defaultDocumentLimits` and may be narrowed through the
 * optional `limits` argument: at most `maxEntriesInOutline` entries, 2,000 cell
 * entries per sheet and `maxTextCharacters` summary characters. A single cell
 * value is clamped to 2,000 characters. Clipping sets `truncated`; malformed
 * record framing and truncated SST strings raise `DocumentError`, while an SST
 * index outside the shared string table skips that one cell.
 */
import { CFB_DIRECTORY_FLOOR, cfbStream, readCfb, type CfbFile } from "./cfb.ts";
import { isLegacyOle } from "./legacy.ts";
import {
    DocumentError, defaultDocumentLimits, type DocumentEntry, type DocumentEntryKind, type DocumentLimits,
    type DocumentLocator, type DocumentOutline,
} from "./types.ts";

const WORKBOOK_PART = "xls:Workbook";
const RECORD_HEADER_BYTES = 4;
const BOF = 0x0809;
const EOF = 0x000a;
const FILEPASS = 0x002f;
const BOUNDSHEET = 0x0085;
const SST = 0x00fc;
const CONTINUE = 0x003c;
const LABELSST = 0x00fd;
const LABEL = 0x0204;
const NUMBER = 0x0203;
const RK = 0x027e;
const MULRK = 0x00bd;
const FORMULA = 0x0006;
const COLUMN_LIMIT = 256;
const MAX_CELLS_PER_SHEET = 2_000;
const MAX_CELL_CHARACTERS = 2_000;
const MAX_NAME_CHARACTERS = 120;
/** Guards against a declared `cstUnique` far larger than the bytes that exist. */
const MAX_SST_STRINGS = 1_000_000;

/** BIFF error literals by the cached error code of a FORMULA record. */
const ERROR_LITERALS: Readonly<Record<number, string>> = Object.freeze({
    0x00: "#NULL!",
    0x07: "#DIV/0!",
    0x0f: "#VALUE!",
    0x17: "#REF!",
    0x1d: "#NAME?",
    0x24: "#NUM!",
    0x2a: "#N/A",
});

function invalidDocument(message: string): DocumentError {
    return new DocumentError("invalid_document", message);
}

function unsupportedFormat(message: string): DocumentError {
    return new DocumentError("unsupported_format", message);
}

function readUint16(bytes: Uint8Array, offset: number): number {
    return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
    return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000;
}

/** Decodes `count` characters at `offset`; `wide` selects UTF-16LE over 8-bit compressed text. */
function decodeCharacters(bytes: Uint8Array, offset: number, count: number, wide: boolean): string {
    let text = "";
    if (wide) {
        for (let index = 0; index < count; index += 1) {
            const at = offset + index * 2;
            text += String.fromCharCode(bytes[at]! | (bytes[at + 1]! << 8));
        }
    } else {
        for (let index = 0; index < count; index += 1) text += String.fromCharCode(bytes[offset + index]!);
    }
    return text;
}

/** An `XLUnicodeString`: `cch u16`, `flags u8` (bit 0 = UTF-16LE), characters. */
function decodeUnicodeString(bytes: Uint8Array, offset: number): string | undefined {
    if (offset + 3 > bytes.length) return undefined;
    const count = readUint16(bytes, offset);
    const wide = (bytes[offset + 2]! & 0x01) !== 0;
    const start = offset + 3;
    if (start + (wide ? count * 2 : count) > bytes.length) return undefined;
    return decodeCharacters(bytes, start, count, wide);
}

/**
 * Decodes an RK number: bit 0 divides by 100, bit 1 means the upper 30 bits are
 * a signed integer, otherwise the upper 30 bits are the high half of an IEEE-754
 * double whose low 32 bits are zero.
 */
function decodeRk(rk: number): number {
    let value: number;
    if ((rk & 0x02) !== 0) {
        const raw = rk >>> 2;
        value = (raw & 0x20000000) !== 0 ? raw - 0x40000000 : raw;
    } else {
        const scratch = new Uint8Array(8);
        const view = new DataView(scratch.buffer);
        view.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
        value = view.getFloat64(0, true);
    }
    return (rk & 0x01) !== 0 ? value / 100 : value;
}

/** Formats a cached numeric value for the outline; `String` gives the shortest round-trip form. */
function formatNumber(value: number): string {
    return String(value);
}

/** One-based BIFF column index to its A1 letters (`0` -> `A`, `255` -> `IV`). */
function columnName(column: number): string {
    let value = column + 1;
    let name = "";
    while (value > 0) {
        const remainder = (value - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        value = Math.floor((value - 1) / 26);
    }
    return name;
}

interface EntryDraft {
    readonly id: string;
    readonly parentId?: string;
    readonly kind: DocumentEntryKind;
    readonly name: string;
    readonly summary: string;
    readonly locator: DocumentLocator;
}

/** Accumulates entries while enforcing the outline budgets, exactly like the XLSX reader. */
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

    /** Records clipping that happened outside the running budget (per-cell caps). */
    noteTruncated(): void {
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

interface BiffRecord {
    /** Offset of the record header inside the Workbook stream. */
    readonly offset: number;
    readonly id: number;
    readonly data: Uint8Array;
    /** Data of each CONTINUE record that follows this record, in order. */
    readonly continues: Uint8Array[];
}

/**
 * Splits the Workbook stream into BIFF records. A malformed header or a declared
 * length that runs past the stream is a structural error, never a silent stop.
 * Excel sometimes zero-fills the tail of the Workbook stream to the CFB sector
 * size, so a final all-zero run shorter than a record header is accepted as
 * alignment padding instead of being reported as a truncated record.
 */
function readRecords(stream: Uint8Array): readonly BiffRecord[] {
    const records: BiffRecord[] = [];
    let offset = 0;
    while (offset < stream.length) {
        if (stream.length - offset < RECORD_HEADER_BYTES) {
            if (isZeroRange(stream, offset, stream.length)) break;
            throw invalidDocument("BIFF record header is truncated");
        }
        const id = readUint16(stream, offset);
        const length = readUint16(stream, offset + 2);
        const dataStart = offset + RECORD_HEADER_BYTES;
        const dataEnd = dataStart + length;
        if (dataEnd > stream.length) {
            throw invalidDocument(`BIFF record 0x${id.toString(16)} extends past the end of the Workbook stream`);
        }
        const data = stream.subarray(dataStart, dataEnd);
        if (id === CONTINUE) {
            const previous = records.at(-1);
            if (previous === undefined) throw invalidDocument("BIFF stream begins with a CONTINUE record");
            previous.continues.push(data);
        } else {
            records.push({ offset, id, data, continues: [] });
        }
        offset = dataEnd;
    }
    return records;
}

function isZeroRange(bytes: Uint8Array, start: number, end: number): boolean {
    for (let index = start; index < end; index += 1) {
        if (bytes[index] !== 0) return false;
    }
    return true;
}

/**
 * Sequential reader over the SST record and its CONTINUE records.
 *
 * A string's fixed fields (`cch`, option flags, `cRun`, `cbExtRst`) MUST share
 * one record and are read as raw bytes. Its variable fields (`rgb`, `rgRun` and
 * `ExtRst`) may be extended by a CONTINUE record, whose first byte is always a
 * fresh option-flags value (fHighByte) followed by the remaining field bytes.
 * `readCharacters` consumes that byte and switches the 8-bit/UTF-16LE decoding,
 * while `skipContinuedBytes` consumes it before run and extended data.
 */
class SegmentCursor {
    private readonly segments: readonly Uint8Array[];
    private segmentIndex: number = 0;
    private offset: number = 0;

    constructor(segments: readonly Uint8Array[]) {
        this.segments = segments;
    }

    isEmpty(): boolean {
        let index = this.segmentIndex;
        let offset = this.offset;
        while (index < this.segments.length && offset >= this.segments[index]!.length) {
            index += 1;
            offset = 0;
        }
        return index >= this.segments.length;
    }

    remainingBytes(): number {
        let total = 0;
        for (let index = this.segmentIndex; index < this.segments.length; index += 1) {
            const segment = this.segments[index]!;
            total += index === this.segmentIndex ? Math.max(0, segment.length - this.offset) : segment.length;
        }
        return total;
    }

    readBytes(count: number): Uint8Array | undefined {
        const output = new Uint8Array(count);
        let written = 0;
        while (written < count) {
            const segment = this.segments[this.segmentIndex];
            if (segment === undefined) return undefined;
            if (this.offset >= segment.length) {
                this.segmentIndex += 1;
                this.offset = 0;
                continue;
            }
            const take = Math.min(count - written, segment.length - this.offset);
            output.set(segment.subarray(this.offset, this.offset + take), written);
            this.offset += take;
            written += take;
        }
        return output;
    }

    readUint8(): number | undefined {
        const bytes = this.readBytes(1);
        return bytes === undefined ? undefined : bytes[0]!;
    }

    readUint16(): number | undefined {
        const bytes = this.readBytes(2);
        return bytes === undefined ? undefined : readUint16(bytes, 0);
    }

    readUint32(): number | undefined {
        const bytes = this.readBytes(4);
        return bytes === undefined ? undefined : readUint32(bytes, 0);
    }

    /**
     * Skips bytes of a rich-text run array or of the extended (phonetic) data.
     * Those are also "variable fields" of the string, so a Continue record that
     * resumes them starts with the same one-byte fHighByte option field even
     * though the bytes themselves are not text.
     */
    skipContinuedBytes(count: number): boolean {
        let remaining = count;
        while (remaining > 0) {
            const segment = this.segments[this.segmentIndex];
            if (segment === undefined) return false;
            if (this.offset >= segment.length) {
                this.segmentIndex += 1;
                this.offset = 0;
                const resumed = this.segments[this.segmentIndex];
                if (resumed === undefined) return false;
                if (resumed.length === 0) continue;
                this.offset = 1;
                continue;
            }
            const take = Math.min(remaining, segment.length - this.offset);
            this.offset += take;
            remaining -= take;
        }
        return true;
    }

    readCharacters(count: number, wide: boolean): string | undefined {
        let text = "";
        let remaining = count;
        let highByte = wide;
        while (remaining > 0) {
            const segment = this.segments[this.segmentIndex];
            if (segment === undefined) return undefined;
            if (this.offset >= segment.length) {
                this.segmentIndex += 1;
                this.offset = 0;
                const resumed = this.segments[this.segmentIndex];
                if (resumed === undefined) return undefined;
                const flags = resumed[0];
                if (flags === undefined) return undefined;
                this.offset = 1;
                highByte = (flags & 0x01) !== 0;
                continue;
            }
            const available = highByte
                ? Math.floor((segment.length - this.offset) / 2)
                : segment.length - this.offset;
            if (available === 0) {
                // A UTF-16 code unit cannot be split between records; drop the stray byte.
                this.offset = segment.length;
                continue;
            }
            const take = Math.min(remaining, available);
            if (highByte) {
                for (let index = 0; index < take; index += 1) {
                    text += String.fromCharCode(segment[this.offset]! | (segment[this.offset + 1]! << 8));
                    this.offset += 2;
                }
            } else {
                for (let index = 0; index < take; index += 1) {
                    text += String.fromCharCode(segment[this.offset]!);
                    this.offset += 1;
                }
            }
            remaining -= take;
        }
        return text;
    }
}

/**
 * Reads one `XLUnicodeRichExtendedString`. The flags byte carries fHighByte
 * (0x01), fExtSt (0x04) and fRichSt (0x08); rich runs and extended data are
 * skipped by their declared sizes.
 */
function readSharedString(cursor: SegmentCursor): string | undefined {
    const count = cursor.readUint16();
    if (count === undefined) return undefined;
    const flags = cursor.readUint8();
    if (flags === undefined) return undefined;
    const rich = (flags & 0x08) !== 0;
    const extended = (flags & 0x04) !== 0;
    let runs = 0;
    if (rich) {
        const value = cursor.readUint16();
        if (value === undefined) return undefined;
        runs = value;
    }
    let extendedBytes = 0;
    if (extended) {
        const value = cursor.readUint32();
        if (value === undefined) return undefined;
        extendedBytes = value;
    }
    const text = cursor.readCharacters(count, (flags & 0x01) !== 0);
    if (text === undefined) return undefined;
    if (rich) {
        const bytes = runs * 4;
        if (bytes > cursor.remainingBytes() || !cursor.skipContinuedBytes(bytes)) return undefined;
    }
    if (extended) {
        if (extendedBytes > cursor.remainingBytes() || !cursor.skipContinuedBytes(extendedBytes)) return undefined;
    }
    return text;
}

/** Parses the SST record plus its CONTINUE records into the shared string table. */
function parseSharedStrings(record: BiffRecord): readonly string[] {
    const cursor = new SegmentCursor([record.data, ...record.continues]);
    if (cursor.readUint32() === undefined) throw invalidDocument("SST record is truncated");
    const unique = cursor.readUint32();
    if (unique === undefined) throw invalidDocument("SST record is truncated");
    const declared = Math.min(unique, MAX_SST_STRINGS);
    const strings: string[] = [];
    for (let index = 0; index < declared; index += 1) {
        if (cursor.isEmpty()) break;
        const value = readSharedString(cursor);
        if (value === undefined) throw invalidDocument("SST string extends past the record data");
        strings.push(value);
    }
    return Object.freeze(strings);
}

interface SheetDefinition {
    readonly name: string;
    /** `lbPlyPos`: offset of the worksheet BOF record inside the Workbook stream. */
    readonly offset: number;
}

function parseBoundsheet(data: Uint8Array, fallbackIndex: number): SheetDefinition | undefined {
    if (data.length < 8) return undefined;
    const offset = readUint32(data, 0);
    const count = data[6]!;
    const wide = (data[7]! & 0x01) !== 0;
    const start = 8;
    if (start + (wide ? count * 2 : count) > data.length) return undefined;
    const name = decodeCharacters(data, start, count, wide);
    return { offset, name: name === "" ? `Sheet ${fallbackIndex}` : name };
}

interface DecodedCell {
    readonly row: number;
    readonly column: number;
    /** `undefined` when the record carries no usable value (bad SST index, skipped result). */
    readonly value: string | undefined;
}

/** A value-bearing cell that will become an outline entry. */
interface SheetCell {
    readonly row: number;
    readonly column: number;
    readonly value: string;
}

/** Decodes one cell-bearing record; `undefined` means "not a cell record or structurally unreadable". */
function decodeCellRecord(record: BiffRecord, sharedStrings: readonly string[]): readonly DecodedCell[] | undefined {
    const data = record.data;
    switch (record.id) {
        case LABELSST: {
            if (data.length < 10) return undefined;
            const row = readUint16(data, 0);
            const column = readUint16(data, 2);
            const index = readUint32(data, 6);
            const value = index < sharedStrings.length ? sharedStrings[index] : undefined;
            return [{ row, column, value }];
        }
        case LABEL: {
            if (data.length < 6) return undefined;
            return [{
                row: readUint16(data, 0),
                column: readUint16(data, 2),
                value: decodeUnicodeString(data, 6),
            }];
        }
        case NUMBER: {
            if (data.length < 14) return undefined;
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            return [{
                row: readUint16(data, 0),
                column: readUint16(data, 2),
                value: formatNumber(view.getFloat64(6, true)),
            }];
        }
        case RK: {
            if (data.length < 10) return undefined;
            return [{
                row: readUint16(data, 0),
                column: readUint16(data, 2),
                value: formatNumber(decodeRk(readUint32(data, 6))),
            }];
        }
        case MULRK: {
            if (data.length < 12) return undefined;
            const row = readUint16(data, 0);
            const first = readUint16(data, 2);
            const last = readUint16(data, data.length - 2);
            if (last < first) return undefined;
            const count = last - first + 1;
            if (data.length < 6 + count * 6) return undefined;
            const cells: DecodedCell[] = [];
            for (let index = 0; index < count; index += 1) {
                const base = 4 + index * 6;
                cells.push({
                    row,
                    column: first + index,
                    value: formatNumber(decodeRk(readUint32(data, base + 2))),
                });
            }
            return cells;
        }
        case FORMULA: {
            if (data.length < 14) return undefined;
            const row = readUint16(data, 0);
            const column = readUint16(data, 2);
            if (data[12]! === 0xff && data[13]! === 0xff) {
                // Special cached result: type 0 string (skipped), 1 boolean, 2 error, 3 empty.
                const type = data[6]!;
                if (type === 1) return [{ row, column, value: data[8]! === 0 ? "FALSE" : "TRUE" }];
                if (type === 2) {
                    const literal = ERROR_LITERALS[data[8]!];
                    return [{ row, column, value: literal ?? "#ERROR" }];
                }
                return [{ row, column, value: undefined }];
            }
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            return [{ row, column, value: formatNumber(view.getFloat64(6, true)) }];
        }
        default: return undefined;
    }
}

interface SheetContent {
    readonly rows: number;
    readonly values: readonly SheetCell[];
    /** True when a value-bearing cell was dropped by the per-sheet cap. */
    readonly overflow: boolean;
}

/** Walks the worksheet substream at `offset` up to its EOF record. */
function readSheet(records: readonly BiffRecord[], offset: number, sharedStrings: readonly string[]): SheetContent {
    const startIndex = records.findIndex(record => record.offset === offset && record.id === BOF);
    if (startIndex < 0) return { rows: 0, values: Object.freeze([]), overflow: false };
    const rows: Set<number> = new Set();
    const seen: Set<string> = new Set();
    const values: SheetCell[] = [];
    let overflow = false;
    for (let index = startIndex + 1; index < records.length; index += 1) {
        const record = records[index]!;
        if (record.id === EOF) break;
        const cells = decodeCellRecord(record, sharedStrings);
        if (cells === undefined) continue;
        for (const cell of cells) {
            if (cell.column >= COLUMN_LIMIT) continue;
            rows.add(cell.row);
            if (cell.value === undefined) continue;
            const value = cell.value.trim();
            if (value === "") continue;
            const reference = `${cell.row}:${cell.column}`;
            if (!seen.add(reference)) continue;
            if (values.length >= MAX_CELLS_PER_SHEET) {
                overflow = true;
                continue;
            }
            values.push({ row: cell.row, column: cell.column, value });
        }
    }
    return { rows: rows.size, values: Object.freeze(values), overflow };
}

/** Best-effort BIFF5 sheet names for the unsupported-format message. */
function biff5SheetNames(stream: Uint8Array): readonly string[] {
    const names: string[] = [];
    try {
        for (const record of readRecords(stream)) {
            if (record.id !== BOUNDSHEET) continue;
            const data = record.data;
            if (data.length < 7) continue;
            const count = data[6]!;
            if (7 + count > data.length) continue;
            let name = "";
            for (let index = 0; index < count; index += 1) name += String.fromCharCode(data[7 + index]!);
            if (name !== "" && names.length < 8) names.push(name);
        }
    } catch {
        return Object.freeze([]);
    }
    return Object.freeze(names);
}

function biff5Message(stream: Uint8Array): string {
    const names = biff5SheetNames(stream);
    return names.length === 0
        ? "BIFF5 workbook is not supported; convert it to .xlsx for an outline"
        : `BIFF5 workbook is not supported; convert it to .xlsx for an outline (sheets: ${names.join(", ")})`;
}

/** CFB entry names are case-insensitive, so `workbook`, `Workbook` and `WORKBOOK` all match. */
function findStreamPath(file: CfbFile, name: string): string | undefined {
    const target = name.toUpperCase();
    for (const entry of file.entries) {
        if (entry.kind === "stream" && entry.name.toUpperCase() === target) return entry.path;
    }
    return undefined;
}

function workbookOutline(stream: Uint8Array, limits: DocumentLimits): DocumentOutline {
    const records = readRecords(stream);
    for (const record of records) {
        if (record.id === FILEPASS) throw unsupportedFormat("encrypted/protected BIFF workbook");
    }
    if (records.length === 0) throw invalidDocument("BIFF Workbook stream is empty");
    if (records[0]!.id !== BOF) throw invalidDocument("BIFF Workbook stream does not start with a BOF record");

    const sheets: SheetDefinition[] = [];
    let sharedStrings: readonly string[] = Object.freeze([]);
    let hasSharedStrings = false;
    for (const record of records) {
        if (record.id === BOUNDSHEET) {
            const sheet = parseBoundsheet(record.data, sheets.length + 1);
            if (sheet !== undefined) sheets.push(sheet);
        } else if (record.id === SST && !hasSharedStrings) {
            sharedStrings = parseSharedStrings(record);
            hasSharedStrings = true;
        }
    }

    const builder = new OutlineBuilder(limits);
    for (let position = 0; position < sheets.length; position += 1) {
        const sheet = sheets[position]!;
        const sheetIndex = position + 1;
        const content = readSheet(records, sheet.offset, sharedStrings);
        const sheetId = `xls:sheet:${sheetIndex}`;
        const added = builder.add({
            id: sheetId,
            kind: "sheet",
            name: sheet.name,
            summary: `${content.rows} rows, ${content.values.length} cells`,
            locator: { part: WORKBOOK_PART, sheet: sheet.name },
        });
        if (!added) return builder.outline("excel");
        if (content.overflow) builder.noteTruncated();
        for (const cell of content.values) {
            const reference = `${columnName(cell.column)}${cell.row + 1}`;
            if (cell.value.length > MAX_CELL_CHARACTERS) builder.noteTruncated();
            const summary = cell.value.length > MAX_CELL_CHARACTERS
                ? cell.value.slice(0, MAX_CELL_CHARACTERS)
                : cell.value;
            const cellAdded = builder.add({
                id: `xls:cell:${sheetIndex}:${reference}`,
                parentId: sheetId,
                kind: "cell",
                name: `${sheet.name}!${reference}`,
                summary,
                locator: { part: WORKBOOK_PART, sheet: sheet.name, cell: reference },
            });
            if (!cellAdded) return builder.outline("excel");
        }
    }
    return builder.outline("excel");
}

/**
 * Parses a legacy Excel workbook into a read-only outline. The container must be
 * a CFB file with a `Workbook` stream; a BIFF5 `Book` stream, an encrypted
 * workbook and non-compound input are rejected with the documented error codes.
 */
export function parseXls(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("xls input must be a Uint8Array");
    if (!isLegacyOle(bytes)) throw invalidDocument("xls input is not an OLE compound file");
    const merged = { ...defaultDocumentLimits, ...limits };
    const containerLimits: DocumentLimits = {
        ...limits,
        maxEntriesInOutline: Math.max(merged.maxEntriesInOutline, CFB_DIRECTORY_FLOOR),
    };
    const file = readCfb(bytes, containerLimits);
    const workbookPath = findStreamPath(file, "Workbook");
    if (workbookPath !== undefined) {
        const workbook = cfbStream(file, workbookPath);
        if (workbook.isPresent()) return workbookOutline(workbook.get(), limits);
    }
    const bookPath = findStreamPath(file, "Book");
    if (bookPath !== undefined) {
        const book = cfbStream(file, bookPath);
        if (book.isPresent()) throw unsupportedFormat(biff5Message(book.get()));
    }
    throw invalidDocument("xls container has no Workbook or Book stream");
}
