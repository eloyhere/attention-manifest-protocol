/**
 * 3D Studio (`.3ds`) and 3ds Max (`.max`) outline reader.
 *
 * Scope: `.max` files are rejected outright. They are a proprietary container (an
 * OLE compound file) whose scene graph is only readable by 3ds Max itself; nothing
 * of a `.max` payload is inspected. A `.3ds` file is a little-endian chunk stream
 * (`u16` id + `u32` length, the length including the 6-byte header). This reader
 * walks `MAIN3DS` (0x4d4d) -> `EDIT3DS` (0x3d3d) -> `NAMED_OBJECT` (0x4000), whose
 * payload starts with a NUL-terminated ASCII name and may continue with child
 * chunks such as `N_TRI_OBJECT` (0x4100). Each named object becomes one `section`
 * entry; entries follow chunk order, and `locator.paragraph` is the 1-based object
 * ordinal (`locator.part` is the fixed `3ds:objects` pseudo-part).
 *
 * Not interpreted: mesh vertices/faces (`0x4110`, `0x4120`, ...), normals, texture
 * coordinates, materials, lights, cameras, keyframe/animation data (`0x1400`,
 * `0x1420`), the keyframer and every `.max` container stream. Only known containers
 * are descended into; other chunk payloads (including mesh data) are skipped by
 * their declared length and are never mistaken for nested chunk headers. Chunk
 * headers are validated (remaining bytes >= 6, length >= 6, child within parent),
 * and malformed input raises `DocumentError` instead of yielding an empty outline.
 *
 * Budgets default to `defaultDocumentLimits` and may be narrowed through the
 * optional `limits` argument: `maxNodes` caps the visited chunk count (MAIN3DS is
 * the first chunk), `maxDepth` caps nesting (MAIN3DS is depth 1), while
 * `maxEntriesInOutline` and `maxTextCharacters` clip the outline and set
 * `truncated`. Byte offsets past a valid MAIN3DS chunk are ignored as trailing
 * padding.
 */
import { isLegacyOle } from "./legacy.ts";
import {
    DocumentError, defaultDocumentLimits, type DocumentEntry, type DocumentEntryKind, type DocumentLimits, type DocumentLocator,
    type DocumentOutline,
} from "./types.ts";

const MAIN3DS = 0x4d4d;
const EDIT3DS = 0x3d3d;
const NAMED_OBJECT = 0x4000;
const CHUNK_HEADER_BYTES = 6;
const OBJECTS_PART = "3ds:objects";
const MAX_NAME_CHARACTERS = 120;
const MAX_UNSUPPORTED = "3ds Max .max files use a proprietary container; export FBX/OBJ or provide an .3ds file for an outline";

const invalidDocument = (message: string): DocumentError => new DocumentError("invalid_document", message);
const limitExceeded = (message: string): DocumentError => new DocumentError("limit_exceeded", message);

/** Reads the little-endian `u16` chunk id / version at `offset`. */
const readUint16 = (bytes: Uint8Array, offset: number): number => bytes[offset]! | (bytes[offset + 1]! << 8);

/** Reads the little-endian `u32` chunk length; the top byte is multiplied to stay unsigned. */
const readUint32 = (bytes: Uint8Array, offset: number): number =>
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000;

/** Offset of the NUL that ends a NAMED_OBJECT name, or `end` when the payload has none. */
const nameTerminator = (bytes: Uint8Array, start: number, end: number): number => {
    let offset = start;
    while (offset < end && bytes[offset] !== 0) offset += 1;
    return offset;
};

/** Decodes the ASCII object name; bytes outside printable ASCII become U+FFFD. */
const decodeObjectName = (bytes: Uint8Array, start: number, end: number): string => {
    let name = "";
    for (let offset = start; offset < end; offset += 1) {
        const value = bytes[offset]!;
        name += value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : "\uFFFD";
    }
    return name;
};

/** Chunks whose payload is itself a chunk stream; every other chunk is skipped. */
const isContainer = (chunkId: number): boolean => chunkId === MAIN3DS || chunkId === EDIT3DS || chunkId === NAMED_OBJECT;

interface ChunkFrame {
    cursor: number;
    readonly end: number;
    readonly depth: number;
}

interface EntryDraft {
    readonly id: string;
    readonly kind: DocumentEntryKind;
    readonly name: string;
    readonly summary: string;
    readonly locator: DocumentLocator;
}

/**
 * Accumulates entries while enforcing the outline budgets. A rejected entry means
 * the budget is exhausted, so the chunk walk stops right there.
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
            id: draft.id, kind: draft.kind, name, summary, locator: Object.freeze({ ...draft.locator }),
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

export function parseMax3d(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("3ds Max input must be a Uint8Array");
    if (isLegacyOle(bytes)) throw new DocumentError("unsupported_format", MAX_UNSUPPORTED);
    if (bytes.length < CHUNK_HEADER_BYTES) throw invalidDocument("3ds file is shorter than a chunk header");
    if (readUint16(bytes, 0) !== MAIN3DS) throw invalidDocument("3ds file does not start with a MAIN3DS (0x4d4d) chunk");
    const mainLength = readUint32(bytes, 2);
    if (mainLength < CHUNK_HEADER_BYTES) throw invalidDocument("MAIN3DS chunk length is smaller than its 6-byte header");
    if (mainLength > bytes.length) throw invalidDocument("MAIN3DS chunk extends past the end of the file");

    const budgets = { ...defaultDocumentLimits, ...limits };
    const hasChildren = mainLength > CHUNK_HEADER_BYTES;
    if (budgets.maxNodes < 1) throw limitExceeded("3ds outline scan cannot visit any chunk within the chunk budget");
    if (hasChildren && budgets.maxDepth < 2) throw limitExceeded("3ds chunk nesting exceeds the depth budget");

    const builder = new OutlineBuilder(limits);
    const stack: ChunkFrame[] = [];
    let objectIndex = 0;
    let nodeCount = 1;
    if (hasChildren) stack.push({ cursor: CHUNK_HEADER_BYTES, end: mainLength, depth: 2 });
    while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        if (frame.cursor >= frame.end) {
            stack.pop();
            continue;
        }
        if (frame.end - frame.cursor < CHUNK_HEADER_BYTES) {
            throw invalidDocument("3ds chunk header is truncated");
        }
        const chunkStart = frame.cursor;
        const chunkId = readUint16(bytes, chunkStart);
        const chunkLength = readUint32(bytes, chunkStart + 2);
        if (chunkLength < CHUNK_HEADER_BYTES) {
            throw invalidDocument(`3ds chunk 0x${chunkId.toString(16)} declares a length smaller than its 6-byte header`);
        }
        const chunkEnd = chunkStart + chunkLength;
        if (chunkEnd > frame.end) {
            throw invalidDocument(`3ds chunk 0x${chunkId.toString(16)} extends past the end of its parent chunk`);
        }
        frame.cursor = chunkEnd;
        nodeCount += 1;
        if (nodeCount > budgets.maxNodes) throw limitExceeded(`3ds outline scan stopped after ${budgets.maxNodes} chunks`);
        if (!isContainer(chunkId)) continue;

        const payloadStart = chunkStart + CHUNK_HEADER_BYTES;
        let childStart = payloadStart;
        if (chunkId === NAMED_OBJECT) {
            objectIndex += 1;
            const terminator = nameTerminator(bytes, payloadStart, chunkEnd);
            const name = decodeObjectName(bytes, payloadStart, terminator).trim();
            if (name !== "") {
                const added = builder.add({
                    id: `max3d:object:${objectIndex}`, kind: "section", name, summary: `object ${name}`,
                    locator: { part: OBJECTS_PART, paragraph: objectIndex },
                });
                if (!added) break;
            }
            childStart = terminator < chunkEnd ? terminator + 1 : chunkEnd;
        }
        if (childStart >= chunkEnd) continue;
        if (frame.depth + 1 > budgets.maxDepth) {
            throw limitExceeded(`3ds chunk nesting exceeds the depth budget of ${budgets.maxDepth}`);
        }
        stack.push({ cursor: childStart, end: chunkEnd, depth: frame.depth + 1 });
    }
    return builder.outline("max3d");
}
