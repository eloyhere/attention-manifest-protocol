/**
 * Legacy PowerPoint (`.ppt`) outline reader.
 *
 * Scope: the presentation is an OLE Compound File Binary (CFB) container with a
 * `PowerPoint Document` stream. That stream is a tree of MS-PPT records with an
 * 8-byte header (`recVerInstance u16`, `recType u16`, `recLen u32`); a record
 * whose low version nibble is `0x0F` is a candidate container. This reader walks
 * the record tree through the known record-sequence containers (document,
 * slide, drawing and OfficeArt containers), collects the text atoms
 * (`TextCharsAtom` 0x0FA0, UTF-16LE; `TextBytesAtom` 0x0FA8, CP1252/Latin-1)
 * that appear inside each `Slide` container (0x03EE) in stream order, and
 * projects one entry per slide that has text. Slide ordinals are counted from
 * the `Slide` containers themselves, so a textless slide keeps its ordinal and
 * produces no entry.
 *
 * Inside a text body, CR (`\r`) separates paragraphs, a vertical tab (`\x0B`)
 * is a line break within a paragraph and CR/LF runs collapse to one paragraph
 * break. Separate text atoms are treated as separate text bodies, so their
 * texts are joined with a paragraph break before splitting. The title is the
 * first non-empty paragraph (trimmed, at most 120 characters) and the summary
 * joins every non-empty paragraph with `\n`.
 *
 * Deliberately not interpreted: the `SlideListWithText`/`SlidePersistAtom`
 * outline cache, notes pages (`Notes` 0x03F0) and masters (`MainMaster`
 * 0x03F8) are skipped and never contribute text. Unknown records and containers
 * (including embedded OLE/control/VBA storages) are ignored by seeking past
 * their `recLen`, as MS-PPT requires. Animations, drawing geometry, OfficeArt
 * shape properties, pictures, charts, tables, hyperlinks, comments and embedded
 * media are not decoded. Text is a preview projection only: locators point back
 * into the original stream.
 *
 * Budgets default to `defaultDocumentLimits` and may be narrowed through the
 * optional `limits` argument. `maxNodes` caps the number of records visited and
 * `maxDepth` caps container nesting; both raise `limit_exceeded` when exhausted.
 * `maxEntriesInOutline` and `maxTextCharacters` clip the outline and set
 * `truncated` instead. A malformed record (header shorter than 8 bytes or a
 * length that runs past its parent) raises `invalid_document`.
 */
import { CFB_DIRECTORY_FLOOR, cfbStream, readCfb, type CfbFile } from "./cfb.ts";
import { isLegacyOle } from "./legacy.ts";
import {
    DocumentError, defaultDocumentLimits, type DocumentEntry, type DocumentEntryKind, type DocumentLimits,
    type DocumentLocator, type DocumentOutline,
} from "./types.ts";

const POWERPOINT_PART = "ppt:PowerPoint Document";
const RECORD_HEADER_BYTES = 8;
const CONTAINER_VERSION = 0x000f;
const SLIDE_CONTAINER = 0x03ee;
const NOTES_CONTAINER = 0x03f0;
const MAIN_MASTER_CONTAINER = 0x03f8;
const DOCUMENT_CONTAINER = 0x03e8;
const PPDRAWING_CONTAINER = 0x040c;
const PPDRAWING_GROUP_CONTAINER = 0x040b;
/** OfficeArt record types (`DggContainer`, `SpContainer`, `ClientTextbox`, ...). */
const OFFICE_ART_MIN = 0xf000;
const OFFICE_ART_MAX = 0xf1ff;
const TEXT_CHARS_ATOM = 0x0fa0;
const TEXT_BYTES_ATOM = 0x0fa8;
const MAX_NAME_CHARACTERS = 120;
const PARAGRAPH_BREAK = "\r";

function invalidDocument(message: string): DocumentError {
    return new DocumentError("invalid_document", message);
}

function limitExceeded(message: string): DocumentError {
    return new DocumentError("limit_exceeded", message);
}

/** Decodes UTF-16LE code units; a trailing odd byte is ignored. */
function decodeUtf16Le(bytes: Uint8Array): string {
    let text = "";
    for (let index = 0; index + 1 < bytes.length; index += 2) {
        text += String.fromCharCode(bytes[index]! | (bytes[index + 1]! << 8));
    }
    return text;
}

let windows1252: TextDecoder | undefined;

/** Decodes 8-bit text as CP1252, falling back to Latin-1 when the decoder is unavailable. */
function decodeSingleByteText(bytes: Uint8Array): string {
    try {
        windows1252 ??= new TextDecoder("windows-1252");
        return windows1252.decode(bytes);
    } catch {
        let text = "";
        for (const byte of bytes) text += String.fromCharCode(byte);
        return text;
    }
}

/**
 * Normalizes one slide's text bodies into non-empty paragraphs: CR/LF runs are
 * paragraph breaks, a vertical tab is an intra-paragraph line break and every
 * paragraph is trimmed. Text atoms are separate bodies, so they are joined with
 * a paragraph break first.
 */
function slideParagraphs(texts: readonly string[]): readonly string[] {
    const combined = texts.join(PARAGRAPH_BREAK)
        .replace(/\r\n/g, PARAGRAPH_BREAK)
        .replace(/\n/g, PARAGRAPH_BREAK)
        .replace(/\r+/g, PARAGRAPH_BREAK);
    const paragraphs: string[] = [];
    for (const raw of combined.split(PARAGRAPH_BREAK)) {
        const paragraph = raw.replace(/\u000b/g, "\n").trim();
        if (paragraph !== "") paragraphs.push(paragraph);
    }
    return paragraphs;
}

interface EntryDraft {
    readonly id: string;
    readonly kind: DocumentEntryKind;
    readonly name: string;
    readonly summary: string;
    readonly locator: DocumentLocator;
}

/** Accumulates entries while enforcing the outline budgets, exactly like the PPTX reader. */
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

interface SlideDraft {
    /** Ordinal among all `Slide` containers, one-based. */
    readonly index: number;
    readonly texts: string[];
}

interface WalkState {
    readonly bytes: Uint8Array;
    readonly view: DataView;
    readonly limits: Required<DocumentLimits>;
    readonly slides: SlideDraft[];
    nodes: number;
}

/**
 * Container records whose payload is a child-record sequence this reader must
 * follow to reach slide text. Per MS-PPT an unknown record is ignored by seeking
 * forward its `recLen`, so an unknown container is never descended into; only
 * the document, slide, drawing and OfficeArt containers are transparent.
 */
function isTextBearingContainer(type: number): boolean {
    return type === DOCUMENT_CONTAINER
        || type === SLIDE_CONTAINER
        || type === PPDRAWING_CONTAINER
        || type === PPDRAWING_GROUP_CONTAINER
        || (type >= OFFICE_ART_MIN && type <= OFFICE_ART_MAX);
}

/**
 * Walks one record range. `slide` is the enclosing slide draft, if any; notes
 * and master containers are skipped without descending so their text can never
 * leak into a slide, and unknown containers are ignored as opaque records.
 * Known containers are descended into because text atoms of a slide may live
 * several drawing/OfficeArt containers deep.
 */
function walkRecords(
    state: WalkState, start: number, end: number, depth: number, slide: SlideDraft | undefined,
): void {
    let cursor = start;
    while (cursor < end) {
        if (end - cursor < RECORD_HEADER_BYTES) {
            throw invalidDocument("PowerPoint record header is truncated");
        }
        const versionInstance = state.view.getUint16(cursor, true);
        const type = state.view.getUint16(cursor + 2, true);
        const length = state.view.getUint32(cursor + 4, true);
        const dataStart = cursor + RECORD_HEADER_BYTES;
        const dataEnd = dataStart + length;
        if (dataEnd > end) {
            throw invalidDocument(`PowerPoint record 0x${type.toString(16)} extends past its parent container`);
        }
        cursor = dataEnd;
        state.nodes += 1;
        if (state.nodes > state.limits.maxNodes) {
            throw limitExceeded(`PowerPoint outline scan stopped after ${state.limits.maxNodes} records`);
        }
        const container = (versionInstance & CONTAINER_VERSION) === CONTAINER_VERSION;
        if (!container) {
            if (slide === undefined) continue;
            const payload = state.bytes.subarray(dataStart, dataEnd);
            if (type === TEXT_CHARS_ATOM) slide.texts.push(decodeUtf16Le(payload));
            else if (type === TEXT_BYTES_ATOM) slide.texts.push(decodeSingleByteText(payload));
            continue;
        }
        if (type === NOTES_CONTAINER || type === MAIN_MASTER_CONTAINER) continue;
        if (!isTextBearingContainer(type)) continue;
        if (dataStart >= dataEnd) continue;
        if (depth + 1 > state.limits.maxDepth) {
            throw limitExceeded(`PowerPoint record nesting exceeds the ${state.limits.maxDepth} level budget`);
        }
        if (type === SLIDE_CONTAINER) {
            const draft: SlideDraft = { index: state.slides.length + 1, texts: [] };
            state.slides.push(draft);
            walkRecords(state, dataStart, dataEnd, depth + 1, draft);
            continue;
        }
        walkRecords(state, dataStart, dataEnd, depth + 1, slide);
    }
}

/** CFB entry names are case-insensitive, so the stream name is matched accordingly. */
function findStreamPath(file: CfbFile, name: string): string | undefined {
    const target = name.toUpperCase();
    for (const entry of file.entries) {
        if (entry.kind === "stream" && entry.name.toUpperCase() === target) return entry.path;
    }
    return undefined;
}

/**
 * Parses a legacy PowerPoint presentation into a read-only outline. A container
 * without the `PowerPoint Document` stream and non-compound input are
 * `invalid_document`; budgets and malformed records fail with the documented
 * error codes instead of yielding a partial slide.
 */
export function parsePpt(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("ppt input must be a Uint8Array");
    if (!isLegacyOle(bytes)) throw invalidDocument("ppt input is not an OLE compound file");
    const merged = { ...defaultDocumentLimits, ...limits };
    const containerLimits: DocumentLimits = {
        ...limits,
        maxEntriesInOutline: Math.max(merged.maxEntriesInOutline, CFB_DIRECTORY_FLOOR),
    };
    const file = readCfb(bytes, containerLimits);
    const streamPath = findStreamPath(file, "PowerPoint Document");
    if (streamPath === undefined) throw invalidDocument("PowerPoint container has no PowerPoint Document stream");
    const stream = cfbStream(file, streamPath);
    if (stream.isEmpty()) throw invalidDocument("PowerPoint container has no PowerPoint Document stream");

    const content = stream.get();
    const state: WalkState = {
        bytes: content,
        view: new DataView(content.buffer, content.byteOffset, content.byteLength),
        limits: merged,
        slides: [],
        nodes: 0,
    };
    walkRecords(state, 0, state.bytes.length, 0, undefined);

    const builder = new OutlineBuilder(limits);
    for (const slide of state.slides) {
        const paragraphs = slideParagraphs(slide.texts);
        if (paragraphs.length === 0) continue;
        const added = builder.add({
            id: `ppt:slide:${slide.index}`,
            kind: "slide",
            name: paragraphs[0]!,
            summary: paragraphs.join("\n"),
            locator: { part: POWERPOINT_PART, slide: slide.index },
        });
        if (!added) break;
    }
    return builder.outline("powerpoint");
}
