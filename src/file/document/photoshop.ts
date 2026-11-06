/**
 * Photoshop (`.psd`) layer outline reader.
 *
 * Scope: the fixed file header and the layer records of the layer and mask information
 * section. Each layer record becomes one `"section"` entry carrying the record ordinal
 * (`locator.paragraph`, 1-based, in on-disk record order), the layer rectangle, blend mode
 * key and opacity. The layer name is the Pascal string stored in the record's extra data;
 * the `lsct`/`lsdk` section-divider blocks are framed and skipped but are not used to build
 * parent/child relations, so the projection stays flat.
 *
 * Explicitly not interpreted: pixel data, channel image data (compression, scanlines),
 * color mode and image resource payloads, smart object contents, text layer contents,
 * adjustment layer parameters, layer styles, vector masks, and the image data section.
 * PSB (version 2) headers are validated, then rejected with `unsupported_format`: the PSB
 * layer and mask information section uses 64-bit length fields and this reader does not
 * guess at them.
 *
 * The result is a read-only preview, never an editable text projection. `locator.part` is
 * always `psd:layers`; `locator.paragraph` is the layer record index. Limits come from
 * `defaultDocumentLimits` and may be narrowed through `limits`; once the entry or text
 * budget is exhausted the outline is clipped and `truncated` is set, while malformed
 * structure still raises `DocumentError`.
 */
import { TextDecoder } from "node:util";
import {
    DocumentError, defaultDocumentLimits,
    type DocumentEntry, type DocumentEntryKind, type DocumentLimits, type DocumentLocator, type DocumentOutline,
} from "./types.ts";

const SIGNATURE = "8BPS";
const MAX_DIMENSION = 300_000;
const MAX_CHANNELS = 56;
const LAYER_LOCATOR_PART = "psd:layers";
const DEPTHS: readonly number[] = Object.freeze([1, 8, 16, 32]);
/** Layer names are legacy Pascal strings; a non-fatal UTF-8 decode degrades gracefully. */
const NAME_DECODER = new TextDecoder("utf-8");

function invalidDocument(message: string): DocumentError {
    return new DocumentError("invalid_document", message);
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

    get position(): number {
        return this.cursor;
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

    outline(language: string): DocumentOutline {
        let text = this.summaries.join("\n");
        if (text.length > this.maxText) {
            text = text.slice(0, this.maxText);
            this.truncated = true;
        }
        return Object.freeze({ language, entries: Object.freeze([...this.entries]), text, truncated: this.truncated });
    }
}

/** Pascal string: length byte, characters, then padding to a four-byte boundary. */
function layerName(bytes: Uint8Array): string {
    const decoded = NAME_DECODER.decode(bytes);
    const terminator = decoded.indexOf("\0");
    return terminator < 0 ? decoded : decoded.slice(0, terminator);
}

/** Blend-mode key rendered as printable ASCII; unusual bytes become `?`. */
function blendKey(bytes: Uint8Array): string {
    let key = "";
    for (const byte of bytes) key += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "?";
    return key;
}

/**
 * Frames the tagged blocks that follow the Pascal name inside a layer record's extra data.
 * `lsct`/`lsdk` are recognized by key and skipped; group nesting is not derived from them.
 * An unknown signature means the rest of the extra field is left to the caller.
 */
function skipAdditionalBlocks(extra: ByteReader, label: string): void {
    while (extra.remaining >= 12) {
        const signature = extra.ascii(4, `${label} additional block signature`);
        if (signature !== "8BIM") return;
        const key = extra.ascii(4, `${label} additional block key`);
        const length = extra.u32(`${label} additional block length`);
        if (length > extra.remaining) {
            throw invalidDocument(`PSD ${label} additional block '${key}' length exceeds the extra data`);
        }
        extra.skip(length, `${label} additional block data`);
        // Lengths are padded to an even byte count; a zero-length tail needs no padding.
        if (length % 2 !== 0 && extra.remaining > 0) extra.skip(1, `${label} additional block padding`);
    }
}

/**
 * Reads one layer record. `layerInfo` is bounded by the layer info section length, so a
 * record that runs past the section is invalid_document instead of silently reading channel
 * image data.
 */
function readLayerRecord(layerInfo: ByteReader, index: number): EntryDraft {
    const label = `layer ${index}`;
    const top = layerInfo.i32(`${label} top`);
    const left = layerInfo.i32(`${label} left`);
    const bottom = layerInfo.i32(`${label} bottom`);
    const right = layerInfo.i32(`${label} right`);
    const channelCount = layerInfo.u16(`${label} channel count`);
    for (let channel = 0; channel < channelCount; channel += 1) {
        layerInfo.i16(`${label} channel id`);
        layerInfo.u32(`${label} channel data length`);
    }
    const signature = layerInfo.ascii(4, `${label} blend signature`);
    if (signature !== "8BIM") throw invalidDocument(`PSD ${label} has signature '${signature}' instead of 8BIM`);
    const key = blendKey(layerInfo.bytes(4, `${label} blend mode key`));
    const opacity = layerInfo.u8(`${label} opacity`);
    layerInfo.u8(`${label} clipping`);
    layerInfo.u8(`${label} flags`);
    layerInfo.u8(`${label} filler`);
    const extraLength = layerInfo.u32(`${label} extra data length`);
    const extra = new ByteReader(layerInfo.bytes(extraLength, `${label} extra data`));

    const maskLength = extra.u32(`${label} mask data length`);
    if (maskLength > 0) {
        // The documented mask header is 18 bytes: a rectangle plus default color and flags.
        if (maskLength < 18) throw invalidDocument(`PSD ${label} mask data is shorter than 18 bytes`);
        extra.i32(`${label} mask top`);
        extra.i32(`${label} mask left`);
        extra.i32(`${label} mask bottom`);
        extra.i32(`${label} mask right`);
        extra.u8(`${label} mask default color`);
        extra.u8(`${label} mask flags`);
        extra.skip(maskLength - 18, `${label} mask parameters`);
    }
    const rangesLength = extra.u32(`${label} blending ranges length`);
    extra.skip(rangesLength, `${label} blending ranges`);
    const nameLength = extra.u8(`${label} name length`);
    const rawName = extra.bytes(nameLength, `${label} name`);
    const name = layerName(rawName);
    const padding = (4 - ((nameLength + 1) % 4)) % 4;
    extra.skip(padding, `${label} name padding`);
    skipAdditionalBlocks(extra, label);

    return {
        id: `psd:layer:${index}`,
        kind: "section",
        name: name.length === 0 ? `Layer ${index}` : name,
        summary: `${right - left}×${bottom - top} @ (${left},${top}) blend=${key} opacity=${opacity}`,
        locator: { part: LAYER_LOCATOR_PART, paragraph: index },
    };
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
    if (signature !== SIGNATURE) throw invalidDocument(`PSD signature is '${signature}', expected 8BPS`);
    const version = reader.u16("the PSD version");
    if (version !== 1 && version !== 2) {
        throw new DocumentError("unsupported_format", `unsupported PSD version ${version}; expected 1 (PSD) or 2 (PSB)`);
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
 * Reads a Photoshop PSD outline. PSB version 2 headers are validated and then refused:
 * PSB stores its layer lengths as 64-bit fields, which this reader does not guess at.
 */
export function parsePsd(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("psd input must be a Uint8Array");
    const reader = new ByteReader(bytes);
    const header = readHeader(reader);
    if (header.version === 2) {
        throw new DocumentError("unsupported_format",
            "PSB layer and mask information uses 64-bit length fields; this reader only outlines PSD (version 1) layers");
    }

    const colorModeLength = reader.u32("the color mode data length");
    reader.skip(colorModeLength, "the color mode data");
    const imageResourcesLength = reader.u32("the image resources length");
    reader.skip(imageResourcesLength, "the image resources");
    if (reader.remaining === 0) throw invalidDocument("PSD has no layer and mask information section");

    const sectionLength = reader.u32("the layer and mask information length");
    if (sectionLength > reader.remaining) throw invalidDocument("PSD layer and mask information length exceeds the file");
    if (sectionLength === 0) return new OutlineBuilder(limits).outline("photoshop");
    if (sectionLength < 4) throw invalidDocument("PSD layer and mask information section is shorter than its length field");
    const sectionEnd = reader.position + sectionLength;
    const layerInfoLength = reader.u32("the layer info length");
    if (layerInfoLength > sectionEnd - reader.position) {
        throw invalidDocument("PSD layer info length exceeds the layer and mask information section");
    }
    const layerInfo = new ByteReader(reader.bytes(layerInfoLength, "the layer info section"));
    const builder = new OutlineBuilder(limits);
    if (layerInfoLength > 0) {
        if (layerInfoLength < 2) throw invalidDocument("PSD layer info section is truncated before the layer count");
        const layerCount = Math.abs(layerInfo.i16("the layer count"));
        for (let index = 1; index <= layerCount; index += 1) {
            builder.add(readLayerRecord(layerInfo, index));
        }
    }
    // Channel image data follows the records inside layer info; the global mask info and
    // additional layer information follow it inside the section. Neither is interpreted.
    reader.skip(sectionEnd - reader.position, "the global layer mask information");
    return builder.outline("photoshop");
}
