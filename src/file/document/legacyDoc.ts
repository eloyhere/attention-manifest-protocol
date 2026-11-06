/**
 * Binary Word (`.doc`, MS-DOC / Word 97-2003) outline reader.
 *
 * A Word 97-2003 document is an OLE Compound File Binary (CFB) container with
 * two payloads: `WordDocument` holds the FIB and the character data, and
 * `0Table` / `1Table` holds the piece table (CLX) and the rest of the document
 * tables. This reader parses the FIB, locates the CLX through the FIB's
 * `fibRgFcLcb` array (falling back to the fixed Word 97 offset when the array
 * is truncated), decodes the piece table (`PlcPcd`), and concatenates the
 * pieces from `WordDocument`. Compressed pieces are single-byte code page 1252
 * data addressed by `fc / 2`; uncompressed pieces are UTF-16LE at `fc`.
 *
 * The projection is deliberately narrow: only plain text and paragraph
 * boundaries are recovered. Paragraph marks (`\r`), section marks (`\x0C`),
 * line breaks (`\x0B`), table cell/row marks (`\x07`), field markers
 * (`\x13`/`\x14`/`\x15`), picture placeholders (`\x01`) and other control
 * characters are handled as text separators or dropped. Formatting, styles,
 * tables, fields, comments and embedded objects are not interpreted, and the
 * non-main stories (headers, footers, footnotes) are not separated from the
 * main text: the outline simply follows the piece order. Nothing here writes
 * back to the document. Heading detection is therefore not implemented: every
 * paragraph is a `paragraph` entry, plus an optional `heading` entry for the
 * CFB `Title` property.
 *
 * Budgets default to `defaultDocumentLimits` and may be narrowed through the
 * optional `limits` argument. `maxEntriesInOutline` and `maxTextCharacters`
 * clip the outline and set `truncated`; `maxNodes` caps the number of
 * non-empty paragraphs processed and raises `limit_exceeded` when exceeded.
 * Structural corruption (wrong `wIdent`, unsupported `nFib`, missing streams,
 * out-of-range CLX/piece data) raises `invalid_document`; an encrypted
 * document raises `unsupported_format`.
 */
import { CFB_DIRECTORY_FLOOR, cfbStream, readCfb } from "./cfb.ts";
import {
    DocumentError, defaultDocumentLimits, type DocumentEntry, type DocumentEntryKind, type DocumentLimits, type DocumentLocator,
    type DocumentOutline,
} from "./types.ts";

/** FIB identifier of every Word 97-2003 document. */
const WORD_IDENT = 0xa5ec;
/** `nFib` values this reader understands: Word 97, 2000, XP and 2003. */
const SUPPORTED_NFIB: readonly number[] = Object.freeze([0x00c1, 0x00d9, 0x0101, 0x0112]);
/** `FibBase` is the fixed first 32 bytes of the FIB. */
const FIB_BASE_BYTES = 32;
/** `flags` field inside `FibBase`. */
const FIB_FLAGS_OFFSET = 0x0a;
/** `fEncrypted`: the document is encrypted and its text is not readable. */
const FIB_ENCRYPTED = 0x0100;
/** `fWhichTblStm`: selects `1Table` instead of `0Table`. */
const FIB_WHICH_TABLE_STREAM = 0x0200;
/** 0-based pair index of `fcClx`/`lcbClx` in `fibRgFcLcb97`. */
const FC_CLX_PAIR_INDEX = 33;
/** Fixed `fcClx` offset in the Word 97+ FIB, used when the array entry is unavailable. */
const FC_CLX_FALLBACK_OFFSET = 0x01a2;
/** Fixed `lcbClx` offset in the Word 97+ FIB. */
const LCB_CLX_FALLBACK_OFFSET = 0x01a6;
/** CLX record types: a formatting PRC and the piece table's Pcdt. */
const CLX_PRC = 0x01;
const CLX_PCDT = 0x02;
const CP_BYTES = 4;
const PCD_BYTES = 8;
const PLC_PCD_RECORD_BYTES = CP_BYTES + PCD_BYTES;
/** `FcCompressed.fCompressed`; the low 30 bits carry the file offset. */
const FC_COMPRESSED = 0x40000000;
const FC_OFFSET_MASK = 0x3fffffff;
/** A paragraph name is the first 80 characters of its first line. */
const MAX_PARAGRAPH_NAME_CHARACTERS = 80;
/** One paragraph summary never exceeds this many characters. */
const MAX_PARAGRAPH_CHARACTERS = 2000;
const WORD_DOCUMENT_PART = "doc:WordDocument";
const PROPERTIES_PART = "doc:properties";
const TITLE_ID = "doc:title";

const invalidDocument = (message: string): DocumentError => new DocumentError("invalid_document", message);
const limitExceeded = (message: string): DocumentError => new DocumentError("limit_exceeded", message);

function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Cached decoder for the compressed-piece encoding, created on first use. */
let compressedDecoder: TextDecoder | undefined = undefined;

/** Decodes one compressed piece: one byte per character in code page 1252. */
function decodeCompressed(bytes: Uint8Array): string {
    compressedDecoder ??= new TextDecoder("windows-1252");
    return compressedDecoder.decode(bytes);
}

/** Decodes one uncompressed piece; a trailing odd byte cannot occur for a CP range. */
function decodeUtf16Le(bytes: Uint8Array): string {
    let text = "";
    for (let index = 0; index + 1 < bytes.length; index += 2) {
        text += String.fromCharCode(bytes[index]! | (bytes[index + 1]! << 8));
    }
    return text;
}

interface Piece {
    readonly cpStart: number;
    readonly cpEnd: number;
    readonly offset: number;
    readonly compressed: boolean;
}

interface ClxLocation {
    readonly fcClx: number;
    readonly lcbClx: number;
}

interface WordFib extends ClxLocation {
    readonly tableStreamName: string;
}

/**
 * Reads `fcClx`/`lcbClx` from `fibRgFcLcb` using the Word 97+ array layout:
 * FibBase (32) -> csw u16 -> fibRgW (csw * 2) -> cslw u16 -> fibRgLw
 * (cslw * 4) -> cbRgFcLcb u16 -> pairs of fc u32 + lcb u32. Every supported
 * `nFib` (0xC1, 0xD9, 0x101, 0x112) keeps `fcClx` at pair 33.
 *
 * Returns `undefined` when the array or its pair 33 lies outside the stream so
 * the caller can fall back to the fixed Word 97 offsets.
 */
function readClxLocationFromArray(bytes: Uint8Array): ClxLocation | undefined {
    if (bytes.length < FIB_BASE_BYTES + 2) return undefined;
    const view = viewOf(bytes);
    let offset = FIB_BASE_BYTES;
    const csw = view.getUint16(offset, true);
    offset += 2;
    const fibRgWBytes = csw * 2;
    if (offset + fibRgWBytes + 2 > bytes.length) return undefined;
    offset += fibRgWBytes;
    const cslw = view.getUint16(offset, true);
    offset += 2;
    const fibRgLwBytes = cslw * 4;
    if (offset + fibRgLwBytes + 2 > bytes.length) return undefined;
    offset += fibRgLwBytes;
    const cbRgFcLcb = view.getUint16(offset, true);
    offset += 2;
    if (cbRgFcLcb <= FC_CLX_PAIR_INDEX) return undefined;
    const pairOffset = offset + FC_CLX_PAIR_INDEX * 8;
    if (pairOffset + 8 > bytes.length) return undefined;
    return {
        fcClx: view.getUint32(pairOffset, true),
        lcbClx: view.getUint32(pairOffset + 4, true),
    };
}

/** Fixed Word 97+ offsets, used when the FIB array cannot be followed. */
function readClxLocationFromFallback(bytes: Uint8Array): ClxLocation | undefined {
    if (bytes.length < LCB_CLX_FALLBACK_OFFSET + 4) return undefined;
    const view = viewOf(bytes);
    return {
        fcClx: view.getUint32(FC_CLX_FALLBACK_OFFSET, true),
        lcbClx: view.getUint32(LCB_CLX_FALLBACK_OFFSET, true),
    };
}

/** Validates the FIB and locates the CLX. */
function readFib(bytes: Uint8Array): WordFib {
    if (bytes.length < FIB_BASE_BYTES) throw invalidDocument("WordDocument stream is shorter than the Word FIB");
    const view = viewOf(bytes);
    const wIdent = view.getUint16(0, true);
    if (wIdent !== WORD_IDENT) {
        throw invalidDocument(`WordDocument stream has wIdent 0x${wIdent.toString(16)}, expected 0xa5ec`);
    }
    const nFib = view.getUint16(2, true);
    if (!SUPPORTED_NFIB.includes(nFib)) throw invalidDocument(`unsupported Word nFib 0x${nFib.toString(16)}`);
    const flags = view.getUint16(FIB_FLAGS_OFFSET, true);
    if ((flags & FIB_ENCRYPTED) !== 0) throw new DocumentError("unsupported_format", "encrypted Word document");
    const tableStreamName = (flags & FIB_WHICH_TABLE_STREAM) !== 0 ? "1Table" : "0Table";
    const clx = readClxLocationFromArray(bytes) ?? readClxLocationFromFallback(bytes);
    if (clx === undefined) throw invalidDocument("Word FIB does not contain a usable Clx location");
    return { tableStreamName, ...clx };
}

/**
 * Parses one `PlcPcd` at `start` with `lcb` bytes. The layout is `n + 1`
 * character positions (u32) followed by `n` PCDs (flags u16, fc u32, prm u16),
 * so `n = (lcb - 4) / 12`.
 */
function readPlcPcd(view: DataView, start: number, lcb: number): readonly Piece[] {
    if (lcb < CP_BYTES || (lcb - CP_BYTES) % PLC_PCD_RECORD_BYTES !== 0) {
        throw invalidDocument(`Word PlcPcd length ${lcb} is not a whole number of pieces`);
    }
    const count = (lcb - CP_BYTES) / PLC_PCD_RECORD_BYTES;
    const pcdStart = start + (count + 1) * CP_BYTES;
    const pieces: Piece[] = [];
    for (let index = 0; index < count; index += 1) {
        const cpStart = view.getUint32(start + index * CP_BYTES, true);
        const cpEnd = view.getUint32(start + (index + 1) * CP_BYTES, true);
        if (cpEnd < cpStart) throw invalidDocument(`Word piece ${index + 1} ends before it starts`);
        const pcd = pcdStart + index * PCD_BYTES;
        const fc = view.getUint32(pcd + 2, true);
        const compressed = (fc & FC_COMPRESSED) !== 0;
        const offset = compressed
            ? Math.floor((fc & FC_OFFSET_MASK) / 2)
            : fc & FC_OFFSET_MASK;
        pieces.push({ cpStart, cpEnd, offset, compressed });
    }
    return pieces;
}

/**
 * Walks the CLX: any number of `Prc` records (`0x01`, cbGrpprl u16, data)
 * followed by the `Pcdt` (`0x02`, lcb u32, `PlcPcd`). Returns the pieces in
 * document order.
 */
function readPieceTable(table: Uint8Array, fcClx: number, lcbClx: number): readonly Piece[] {
    if (lcbClx === 0) throw invalidDocument("Word Clx is empty");
    if (fcClx > table.length || lcbClx > table.length - fcClx) {
        throw invalidDocument("Word Clx is outside the table stream");
    }
    const view = viewOf(table);
    const end = fcClx + lcbClx;
    let offset = fcClx;
    while (offset < end) {
        const recordType = table[offset]!;
        if (recordType === CLX_PRC) {
            if (offset + 3 > end) throw invalidDocument("Word Clx Prc header is truncated");
            const prcBytes = view.getUint16(offset + 1, true);
            offset += 3;
            if (prcBytes > end - offset) throw invalidDocument("Word Clx Prc data is truncated");
            offset += prcBytes;
        } else if (recordType === CLX_PCDT) {
            if (offset + 5 > end) throw invalidDocument("Word Clx Pcdt header is truncated");
            const lcb = view.getUint32(offset + 1, true);
            offset += 5;
            if (lcb > end - offset) throw invalidDocument("Word Clx PlcPcd is truncated");
            return readPlcPcd(view, offset, lcb);
        } else {
            throw invalidDocument(`Word Clx has unsupported record type 0x${recordType.toString(16)}`);
        }
    }
    throw invalidDocument("Word Clx has no Pcdt");
}

/**
 * Concatenates piece text from `WordDocument`. Each piece contributes
 * `cpEnd - cpStart` characters; a compressed piece reads one byte per
 * character at the decoded `fc / 2` offset and an uncompressed piece reads two
 * bytes per character at `fc`.
 */
function readText(wordDocument: Uint8Array, pieces: readonly Piece[]): string {
    let text = "";
    for (const piece of pieces) {
        const characters = piece.cpEnd - piece.cpStart;
        if (characters === 0) continue;
        const byteLength = piece.compressed ? characters : characters * 2;
        const end = piece.offset + byteLength;
        if (end > wordDocument.length) {
            throw invalidDocument(`Word piece ${piece.cpStart}..${piece.cpEnd} is outside the WordDocument stream`);
        }
        const raw = wordDocument.subarray(piece.offset, end);
        text += piece.compressed ? decodeCompressed(raw) : decodeUtf16Le(raw);
    }
    return text;
}

/**
 * Maps Word's text control characters onto plain text: paragraph and section
 * marks become `\r`, cell/row ends become spaces, manual line breaks become
 * `\n`, and field markers, picture placeholders and every other C0/DEL control
 * character are dropped.
 */
function sanitizeText(raw: string): string {
    let text = "";
    for (let index = 0; index < raw.length; index += 1) {
        const code = raw.charCodeAt(index);
        if (code === 0x0d || code === 0x0c) {
            text += "\r";
        } else if (code === 0x07 || code === 0x09) {
            text += " ";
        } else if (code === 0x0a || code === 0x0b) {
            text += "\n";
        } else if (code >= 0x20 && code !== 0x7f) {
            text += raw[index]!;
        }
    }
    return text;
}

interface EntryDraft {
    readonly id: string;
    readonly kind: DocumentEntryKind;
    readonly name: string;
    readonly summary: string;
    readonly locator: DocumentLocator;
}

/**
 * Accumulates entries while enforcing the outline budgets. A rejected entry
 * means the entry or text budget is exhausted, so callers stop walking.
 */
class OutlineBuilder {
    private readonly entries: DocumentEntry[] = [];
    private readonly summaries: string[] = [];
    private readonly maxEntries: number;
    private readonly maxText: number;
    private textLength: number = 0;
    private truncated: boolean = false;

    constructor(limits: DocumentLimits) {
        const merged = { ...defaultDocumentLimits, ...limits };
        this.maxEntries = merged.maxEntriesInOutline;
        this.maxText = merged.maxTextCharacters;
    }

    /** Marks the outline as clipped for a reason outside the entry budgets. */
    markTruncated(): void {
        this.truncated = true;
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
        const name = draft.name;
        const entry: DocumentEntry = Object.freeze({
            id: draft.id,
            kind: draft.kind,
            name,
            summary,
            locator: Object.freeze({ ...draft.locator }),
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

export function parseDoc(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Word .doc input must be a Uint8Array");
    // `maxEntriesInOutline` and `maxNodes` are projection budgets. Keep the
    // container readable with its own floor so a narrow outline budget clips
    // the result instead of rejecting the compound file.
    const merged = { ...defaultDocumentLimits, ...limits };
    const containerLimits: DocumentLimits = {
        ...limits,
        maxEntriesInOutline: Math.max(merged.maxEntriesInOutline, CFB_DIRECTORY_FLOOR),
        maxNodes: Math.max(merged.maxNodes, defaultDocumentLimits.maxNodes),
    };
    const container = readCfb(bytes, containerLimits);
    const wordDocument = cfbStream(container, "Root/WordDocument");
    if (wordDocument.isEmpty()) throw invalidDocument("WordDocument stream is missing");
    const fib = readFib(wordDocument.get());
    const tableStream = cfbStream(container, `Root/${fib.tableStreamName}`);
    if (tableStream.isEmpty()) throw invalidDocument(`${fib.tableStreamName} stream is missing`);
    const pieces = readPieceTable(tableStream.get(), fib.fcClx, fib.lcbClx);
    const text = sanitizeText(readText(wordDocument.get(), pieces));

    const builder = new OutlineBuilder(limits);
    const title = container.properties.Title;
    if (typeof title === "string" && title !== "") {
        const added = builder.add({
            id: TITLE_ID,
            kind: "heading",
            name: title,
            summary: title,
            locator: { part: PROPERTIES_PART },
        });
        if (!added) return builder.outline("word");
    }

    let paragraphNumber = 0;
    let processedParagraphs = 0;
    for (const candidate of text.split("\r")) {
        const paragraph = candidate.trim();
        if (paragraph === "") continue;
        processedParagraphs += 1;
        if (processedParagraphs > merged.maxNodes) {
            throw limitExceeded(`Word outline scan stopped after ${merged.maxNodes} paragraphs`);
        }
        paragraphNumber += 1;
        const lineEnd = paragraph.indexOf("\n");
        const firstLine = lineEnd < 0 ? paragraph : paragraph.slice(0, lineEnd);
        const name = firstLine.slice(0, MAX_PARAGRAPH_NAME_CHARACTERS);
        const clipped = paragraph.length > MAX_PARAGRAPH_CHARACTERS;
        const summary = clipped ? paragraph.slice(0, MAX_PARAGRAPH_CHARACTERS) : paragraph;
        if (clipped) builder.markTruncated();
        const added = builder.add({
            id: `doc:paragraph:${paragraphNumber}`,
            kind: "paragraph",
            name,
            summary,
            locator: { part: WORD_DOCUMENT_PART, paragraph: paragraphNumber },
        });
        if (!added) break;
    }
    return builder.outline("word");
}
