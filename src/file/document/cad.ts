/**
 * CAD (`.dxf`) outline reader with an explicit DWG refusal.
 *
 * Scope: the ASCII DXF group-code stream is read as `code` / `value` pairs. The reader
 * collects layers from the LAYER table (`0 LAYER`, `2 <name>`, optional `62 <color>`),
 * block names from the BLOCKS section (`0 BLOCK`, `2 <name>`), and counts entity types in
 * the ENTITIES section (`0 LINE`, `0 CIRCLE`, ...). Layers and blocks become `"section"`
 * entries and entity types become `"note"` entries with their occurrence count.
 *
 * This is a structural preview, not a DXF implementation: geometry, handles, tables other
 * than LAYER, block contents, extents, xdata, binary DXF and DWG payloads are not decoded.
 * Missing SECTION/ENDSEC pairs and unknown group codes are tolerated; a group code that is
 * not an integer is `invalid_document`. DWG (signature `AC10`) is proprietary binary and is
 * refused with `unsupported_format` - export DXF for an outline.
 *
 * Limits default to `defaultDocumentLimits` and may be narrowed; once the entry or text
 * budget is exhausted the outline is clipped and `truncated` is set.
 */
import { TextDecoder } from "node:util";
import {
    DocumentError, defaultDocumentLimits,
    type DocumentEntry, type DocumentEntryKind, type DocumentLimits, type DocumentLocator, type DocumentOutline,
} from "./types.ts";

const DWG_PREFIX = "AC10";
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

function isDwg(bytes: Uint8Array): boolean {
    if (bytes.length < DWG_PREFIX.length) return false;
    for (let index = 0; index < DWG_PREFIX.length; index += 1) {
        if (bytes[index] !== DWG_PREFIX.charCodeAt(index)) return false;
    }
    return true;
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

/**
 * Reads a DXF outline. DWG input is refused before decoding because its `AC10` signature
 * marks a proprietary binary format; there is no attempt to guess at DWG internals.
 */
export function parseCad(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("cad input must be a Uint8Array");
    if (isDwg(bytes)) {
        throw new DocumentError("unsupported_format", "DWG is a proprietary binary format; export DXF for an outline");
    }
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
