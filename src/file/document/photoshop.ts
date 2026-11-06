/**
 * Photoshop (`.psd`, `.psb`) layer-tree outline reader.
 *
 * Scope: the fixed file header, the color-mode/image-resource trailers, and the layer records
 * of the layer and mask information section. Each layer record becomes one `"section"` entry
 * carrying its record ordinal (`locator.paragraph`, 1-based, in on-disk record order), the
 * layer rectangle, blend-mode key and opacity. `lsct`/`lsdk` section-dividers are interpreted:
 * a type-1 record opens a group, a type-2 record closes it, and a type-3 (bounding) group is a
 * leaf. The resulting parent/child chain is projected through `parentId`; unmatched closers are
 * ignored and groups still open at end of file keep the children collected so far. `luni`
 * Unicode names take precedence over the legacy Pascal name.
 *
 * PSD (version 1) and PSB (version 2) are both read. The format is identical except for three
 * length fields: the layer-and-mask section length, the layer-info length, and each layer
 * channel's data length are `u32` in PSD and `u64` in PSB. Every other field (rectangles,
 * channel ids, blend data, opacity, extra-data length, mask length, Pascal-name length and
 * alignment, additional-block lengths) stays 4/2/1 bytes in both versions.
 *
 * Explicitly not interpreted: channel pixel data (compression, scanlines), the image data
 * section, color-mode and image-resource payloads, the global layer mask, smart object
 * contents, text layer contents, adjustment layer parameters, layer styles, vector masks and
 * any additional-information block other than `lsct`, `lsdk` and `luni`.
 *
 * The result is a read-only preview, never an editable text projection. `locator.part` is
 * always `psd:layers`; `locator.paragraph` is the layer record index. Limits come from
 * `defaultDocumentLimits` and may be narrowed through `limits`: entry/text overflow clips and
 * sets `truncated`, `maxNodes` caps layer records plus additional-information blocks, and
 * malformed structure raises `DocumentError`.
 */
import { TextDecoder } from "node:util";
import {
    DocumentError, defaultDocumentLimits, type DocumentEntry, type DocumentEntryKind, type DocumentLimits, type DocumentLocator,
    type DocumentOutline,
} from "./types.ts";

const PSD_SIGNATURE = "8BPS";
const BLOCK_SIGNATURE = "8BIM";
const PSD_VERSION = 1;
const PSB_VERSION = 2;
const MAX_DIMENSION = 300_000;
const MAX_CHANNELS = 56;
const LAYER_LOCATOR_PART = "psd:layers";
const DEPTHS: readonly number[] = Object.freeze([1, 8, 16, 32]);
const MASK_HEADER_BYTES = 18;
const PASCAL_ALIGNMENT = 4;
const DIVIDER_OPEN = 1;
const DIVIDER_END = 2;
/** High word ceiling that keeps a `u64` inside JavaScript's safe-integer range. */
const U64_SAFE_HIGH = 0x1f_ffff;

const NAME_DECODER = new TextDecoder("utf-8");

function invalidDocument(message: string): DocumentError {
    return new DocumentError("invalid_document", message);
}

function limitExceeded(message: string): DocumentError {
    return new DocumentError("limit_exceeded", message);
}

/** Bounds-checked big-endian reader; every out-of-range access becomes invalid_document. */
class ByteReader {
    private readonly view: DataView;
    private readonly source: Uint8Array;
    private cursor = 0;

    constructor(source: Uint8Array) {
        this.source = source;
        this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    }

    get remaining(): number {
        return this.source.length - this.cursor;
    }

    private require(length: number, label: string): void {
        if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
            throw invalidDocument(`PSD is truncated while reading ${label}`);
        }
    }

    u8(label: string): number {
        this.require(1, label);
        const value = this.view.getUint8(this.cursor);
        this.cursor += 1;
        return value;
    }

    u16(label: string): number {
        this.require(2, label);
        const value = this.view.getUint16(this.cursor, false);
        this.cursor += 2;
        return value;
    }

    i16(label: string): number {
        this.require(2, label);
        const value = this.view.getInt16(this.cursor, false);
        this.cursor += 2;
        return value;
    }

    u32(label: string): number {
        this.require(4, label);
        const value = this.view.getUint32(this.cursor, false);
        this.cursor += 4;
        return value;
    }

    i32(label: string): number {
        this.require(4, label);
        const value = this.view.getInt32(this.cursor, false);
        this.cursor += 4;
        return value;
    }

    /** PSB length fields are big-endian `u64`; values beyond 2^53 are rejected, not rounded. */
    u64(label: string): number {
        this.require(8, label);
        const high = this.view.getUint32(this.cursor, false);
        const low = this.view.getUint32(this.cursor + 4, false);
        this.cursor += 8;
        if (high > U64_SAFE_HIGH) throw invalidDocument(`PSD ${label} exceeds the safe integer range`);
        return high * 0x1_0000_0000 + low;
    }

    bytes(length: number, label: string): Uint8Array {
        this.require(length, label);
        const value = this.source.subarray(this.cursor, this.cursor + length);
        this.cursor += length;
        return value;
    }

    skip(length: number, label: string): void {
        this.require(length, label);
        this.cursor += length;
    }

    /** Four one-byte characters, used for signatures and blend-mode keys. */
    ascii(length: number, label: string): string {
        let value = "";
        for (const byte of this.bytes(length, label)) value += String.fromCharCode(byte);
        return value;
    }
}

/** Running structural budget shared by record and tagged-block reads. */
interface ScanBudget {
    readonly maxNodes: number;
    nodes: number;
}

function visitNode(budget: ScanBudget, label: string): void {
    budget.nodes += 1;
    if (budget.nodes > budget.maxNodes) {
        throw limitExceeded(`PSD outline scan stopped after ${budget.maxNodes} nodes while reading ${label}`);
    }
}

interface EntryDraft {
    readonly id: string;
    readonly parentId?: string;
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
            id: draft.id,
            kind: draft.kind,
            name: draft.name,
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

/** Truncates at the first NUL, the terminator used by both Pascal and `luni` strings. */
function atNul(value: string): string {
    const terminator = value.indexOf("\0");
    return terminator < 0 ? value : value.slice(0, terminator);
}

/** Legacy Pascal layer name; undecodable UTF-8 degrades to replacement characters. */
function decodePascalName(bytes: Uint8Array): string {
    return atNul(NAME_DECODER.decode(bytes));
}

/** `luni` payload: UTF-16BE code units with no byte-order mark. */
function decodeUtf16Be(bytes: Uint8Array): string {
    let value = "";
    for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
        value += String.fromCharCode((bytes[offset]! << 8) | bytes[offset + 1]!);
    }
    return atNul(value);
}

/** Blend-mode key rendered as printable ASCII; unusual bytes become `?`. */
function blendKey(bytes: Uint8Array): string {
    let key = "";
    for (const byte of bytes) key += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "?";
    return key;
}

interface AdditionalLayerInfo {
    readonly unicodeName?: string;
    readonly sectionType?: number;
}

/**
 * Reads the additional-information block sequence that follows the Pascal name inside a
 * layer record's extra data. Every block is `8BIM` + 4-byte key + u32 length + data, with a
 * single pad byte when the length is odd. Unknown keys are skipped by their declared length.
 */
function readAdditionalLayerInfo(extra: ByteReader, label: string, budget: ScanBudget): AdditionalLayerInfo {
    let unicodeName: string | undefined;
    let lsctType: number | undefined;
    let lsdkType: number | undefined;
    while (extra.remaining > 0) {
        if (extra.remaining < 12) {
            throw invalidDocument(`PSD ${label} has a truncated additional layer information header`);
        }
        const signature = extra.ascii(4, `${label} additional block signature`);
        if (signature !== BLOCK_SIGNATURE) {
            throw invalidDocument(`PSD ${label} has additional layer information signature '${signature}' instead of 8BIM`);
        }
        const key = extra.ascii(4, `${label} additional block key`);
        const length = extra.u32(`${label} additional block '${key}' length`);
        visitNode(budget, `${label} additional block '${key}'`);
        if (length > extra.remaining) {
            throw invalidDocument(`PSD ${label} additional block '${key}' length exceeds the extra data`);
        }
        const data = extra.bytes(length, `${label} additional block '${key}' data`);
        if (key === "lsct" || key === "lsdk") {
            if (length < 4) {
                throw invalidDocument(`PSD ${label} ${key} block is shorter than its 4-byte section type`);
            }
            const sectionType = new ByteReader(data).u32(`${label} ${key} section type`);
            if (key === "lsct") lsctType = sectionType;
            else lsdkType = sectionType;
        } else if (key === "luni") {
            if (length < 4) {
                throw invalidDocument(`PSD ${label} luni block is shorter than its 4-byte character count`);
            }
            const unicode = new ByteReader(data);
            const codeUnits = unicode.u32(`${label} luni character count`);
            if (codeUnits > Math.floor((length - 4) / 2)) {
                throw invalidDocument(`PSD ${label} luni character count exceeds the block data`);
            }
            const name = decodeUtf16Be(unicode.bytes(codeUnits * 2, `${label} luni name`));
            if (name !== "") unicodeName = name;
        }
        // Odd block payloads are padded to an even byte boundary. A missing final pad byte is
        // tolerated only at the end of the extra data, where there is nothing left to align.
        if (length % 2 === 1 && extra.remaining > 0) {
            extra.skip(1, `${label} additional block padding`);
        }
    }
    const sectionType = lsctType ?? lsdkType;
    return {
        ...(unicodeName === undefined ? {} : { unicodeName }),
        ...(sectionType === undefined ? {} : { sectionType }),
    };
}

interface LayerRecord {
    readonly summary: string;
    readonly pascalName: string;
    readonly unicodeName?: string;
    readonly sectionType?: number;
    /** Sum of the declared channel data lengths; the bytes themselves are never read. */
    readonly channelBytes: number;
}

/**
 * Reads one layer record. `layerInfo` is bounded by the layer-info section length, so a record
 * that runs past the section is invalid_document instead of silently reading channel data.
 */
function readLayerRecord(layerInfo: ByteReader, index: number, psb: boolean, budget: ScanBudget): LayerRecord {
    const label = `layer ${index}`;
    visitNode(budget, label);
    const top = layerInfo.i32(`${label} top`);
    const left = layerInfo.i32(`${label} left`);
    const bottom = layerInfo.i32(`${label} bottom`);
    const right = layerInfo.i32(`${label} right`);
    const channelCount = layerInfo.u16(`${label} channel count`);
    let channelBytes = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
        layerInfo.i16(`${label} channel id`);
        const length = psb ? layerInfo.u64(`${label} channel data length`) : layerInfo.u32(`${label} channel data length`);
        if (length > Number.MAX_SAFE_INTEGER - channelBytes) {
            throw invalidDocument(`PSD ${label} channel data lengths overflow the safe integer range`);
        }
        channelBytes += length;
    }
    const signature = layerInfo.ascii(4, `${label} blend signature`);
    if (signature !== BLOCK_SIGNATURE) {
        throw invalidDocument(`PSD ${label} has signature '${signature}' instead of 8BIM`);
    }
    const key = blendKey(layerInfo.bytes(4, `${label} blend mode key`));
    const opacity = layerInfo.u8(`${label} opacity`);
    layerInfo.u8(`${label} clipping`);
    layerInfo.u8(`${label} flags`);
    layerInfo.u8(`${label} filler`);
    const extraLength = layerInfo.u32(`${label} extra data length`);
    const extra = new ByteReader(layerInfo.bytes(extraLength, `${label} extra data`));

    const maskLength = extra.u32(`${label} mask data length`);
    if (maskLength > 0) {
        if (maskLength < MASK_HEADER_BYTES) {
            throw invalidDocument(`PSD ${label} mask data is shorter than ${MASK_HEADER_BYTES} bytes`);
        }
        extra.i32(`${label} mask top`);
        extra.i32(`${label} mask left`);
        extra.i32(`${label} mask bottom`);
        extra.i32(`${label} mask right`);
        extra.u8(`${label} mask default color`);
        extra.u8(`${label} mask flags`);
        extra.skip(maskLength - MASK_HEADER_BYTES, `${label} mask parameters`);
    }
    const rangesLength = extra.u32(`${label} blending ranges length`);
    extra.skip(rangesLength, `${label} blending ranges`);
    const nameLength = extra.u8(`${label} name length`);
    const pascalName = decodePascalName(extra.bytes(nameLength, `${label} name`));
    const padding = (PASCAL_ALIGNMENT - ((nameLength + 1) % PASCAL_ALIGNMENT)) % PASCAL_ALIGNMENT;
    extra.skip(padding, `${label} name padding`);
    const additional = readAdditionalLayerInfo(extra, label, budget);

    return {
        summary: `${right - left}×${bottom - top} @ (${left},${top}) blend=${key} opacity=${opacity}`,
        pascalName,
        channelBytes,
        ...(additional.unicodeName === undefined ? {} : { unicodeName: additional.unicodeName }),
        ...(additional.sectionType === undefined ? {} : { sectionType: additional.sectionType }),
    };
}

/** `luni` wins over the Pascal name; an empty name falls back to the record ordinal. */
function recordName(record: LayerRecord, index: number): string {
    if (record.unicodeName !== undefined && record.unicodeName !== "") return record.unicodeName;
    if (record.pascalName !== "") return record.pascalName;
    return `Layer ${index}`;
}

interface PsdHeader {
    readonly version: number;
    readonly channels: number;
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly colorMode: number;
}

function readHeader(reader: ByteReader): PsdHeader {
    const signature = reader.ascii(4, "the PSD signature");
    if (signature !== PSD_SIGNATURE) throw invalidDocument(`PSD signature is '${signature}', expected 8BPS`);
    const version = reader.u16("the PSD version");
    if (version !== PSD_VERSION && version !== PSB_VERSION) {
        throw invalidDocument(`PSD version ${version} is not 1 (PSD) or 2 (PSB)`);
    }
    const reserved = reader.bytes(6, "the reserved header bytes");
    if (reserved.some(byte => byte !== 0)) throw invalidDocument("PSD reserved header bytes are not zero");
    const channels = reader.u16("the channel count");
    const height = reader.u32("the image height");
    const width = reader.u32("the image width");
    const depth = reader.u16("the bit depth");
    const colorMode = reader.u16("the color mode");
    if (channels < 1 || channels > MAX_CHANNELS) {
        throw invalidDocument(`PSD channel count ${channels} is outside 1..${MAX_CHANNELS}`);
    }
    if (width < 1 || width > MAX_DIMENSION || height < 1 || height > MAX_DIMENSION) {
        throw invalidDocument(`PSD dimensions ${width}×${height} are outside 1..${MAX_DIMENSION}`);
    }
    if (!DEPTHS.includes(depth)) throw invalidDocument(`PSD bit depth ${depth} is not 1, 8, 16 or 32`);
    if (colorMode > 9) throw invalidDocument(`PSD color mode ${colorMode} is outside 0..9`);
    return { version, channels, width, height, depth, colorMode };
}

/**
 * Reads a Photoshop PSD (version 1) or PSB (version 2) layer-tree outline. The two versions
 * differ only in the width of the section, layer-info and channel-data length fields.
 */
export function parsePsd(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("psd input must be a Uint8Array");
    const reader = new ByteReader(bytes);
    const header = readHeader(reader);
    const psb = header.version === PSB_VERSION;

    const colorModeLength = reader.u32("the color mode data length");
    reader.skip(colorModeLength, "the color mode data");
    const imageResourcesLength = reader.u32("the image resources length");
    reader.skip(imageResourcesLength, "the image resources");
    if (reader.remaining === 0) throw invalidDocument("PSD has no layer and mask information section");

    const merged = { ...defaultDocumentLimits, ...limits };
    const budget: ScanBudget = { maxNodes: merged.maxNodes, nodes: 0 };
    const builder = new OutlineBuilder(limits);
    const lengthFieldBytes = psb ? 8 : 4;

    const sectionLength = psb
        ? reader.u64("the layer and mask information length")
        : reader.u32("the layer and mask information length");
    if (sectionLength > reader.remaining) {
        throw invalidDocument("PSD layer and mask information length exceeds the file");
    }
    if (sectionLength === 0) return builder.outline("photoshop");
    if (sectionLength < lengthFieldBytes) {
        throw invalidDocument("PSD layer and mask information section is shorter than its length field");
    }
    const sectionContentBytes = sectionLength - lengthFieldBytes;
    const layerInfoLength = psb ? reader.u64("the layer info length") : reader.u32("the layer info length");
    if (layerInfoLength > sectionContentBytes) {
        throw invalidDocument("PSD layer info length exceeds the layer and mask information section");
    }
    if (layerInfoLength === 0) return builder.outline("photoshop");
    if (layerInfoLength < 2) throw invalidDocument("PSD layer info section is truncated before the layer count");

    const layerInfo = new ByteReader(reader.bytes(layerInfoLength, "the layer info section"));
    const layerCount = Math.abs(layerInfo.i16("the layer count"));
    const groupStack: string[] = [];
    let channelBytes = 0;
    for (let index = 1; index <= layerCount; index += 1) {
        const record = readLayerRecord(layerInfo, index, psb, budget);
        if (record.channelBytes > Number.MAX_SAFE_INTEGER - channelBytes) channelBytes = Number.MAX_SAFE_INTEGER;
        else channelBytes += record.channelBytes;
        const sectionType = record.sectionType;
        if (sectionType === DIVIDER_END) {
            // The closing record itself is not a layer; an unmatched closer is ignored.
            if (groupStack.length > 0) groupStack.pop();
            continue;
        }
        const id = `psd:layer:${index}`;
        const parentId = groupStack.length === 0 ? undefined : groupStack[groupStack.length - 1]!;
        builder.add({
            id,
            kind: "section",
            name: recordName(record, index),
            summary: record.summary,
            locator: { part: LAYER_LOCATOR_PART, paragraph: index },
            ...(parentId === undefined ? {} : { parentId }),
        });
        if (sectionType === DIVIDER_OPEN) groupStack.push(id);
        // A section type of 3 (boundary group) owns no children, so it is never pushed.
    }
    // The bytes after the records are the declared channel image data followed by at most a
    // little section padding. Pixel bytes are deliberately never decoded, but an unexplained
    // remainder means the layer count disagreed with the record stream.
    if (layerInfo.remaining - 3 > channelBytes) {
        throw invalidDocument("PSD layer info has unread bytes after its layer records, contradicting the layer count");
    }
    return builder.outline("photoshop");
}
