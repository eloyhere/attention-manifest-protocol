/**
 * SpreadsheetML (`.xlsx`) outline reader.
 *
 * Scope: the workbook sheet list (`xl/workbook.xml`), the workbook relationships
 * (`xl/_rels/workbook.xml.rels`), the shared string table
 * (`xl/sharedStrings.xml`) and each worksheet's cached cell values. Formulas are
 * not evaluated; only a cached `<v>`/inline string is projected. Styles, number
 * formats, merged/defined ranges, tables, pivot tables, charts, external links,
 * macros and comments are not interpreted.
 *
 * Sheet entries are emitted in workbook order (zero-based `index` in
 * `xlsx:sheet:{index}`), immediately followed by that sheet's cell entries.
 * `locator.part` is the resolved package part, `locator.sheet` the workbook
 * sheet name and `locator.cell` the cell reference. Relationship targets are
 * confined to `xl/`: external relationships and targets containing `..` are
 * ignored, never read.
 *
 * Budgets default to `defaultDocumentLimits` and may be narrowed through the
 * optional `limits` argument: at most 20,000 outline entries, 2,000 cell entries
 * per sheet and 2,000,000 summary characters. A single cell value is clamped to
 * 2,000 characters. Clipping sets `truncated`; malformed packages raise
 * `DocumentError` instead of yielding an empty outline.
 */
import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet, isString } from "semantic-typescript";
import { assertNotLegacy } from "./legacy.ts";
import {
    DocumentError, defaultDocumentLimits, type DocumentEntry, type DocumentEntryKind, type DocumentLimits, type DocumentLocator,
    type DocumentOutline,
} from "./types.ts";
import { attrOf, childrenNamed, findAll, firstChild, parseXml, textOf, type XmlNode } from "./xml.ts";
import { ZipArchive } from "./zip.ts";

const WORKBOOK_PART = "xl/workbook.xml";
const WORKBOOK_RELATIONSHIPS_PART = "xl/_rels/workbook.xml.rels";
const SHARED_STRINGS_PART = "xl/sharedStrings.xml";
const MAX_NAME_CHARACTERS = 120;
const MAX_CELL_CHARACTERS = 2_000;
const MAX_CELLS_PER_SHEET = 2_000;
const CELL_REFERENCE = /^[A-Z]{1,3}[1-9][0-9]*$/;
const SHARED_STRING_INDEX = /^[0-9]+$/;

interface SheetDefinition {
    readonly name: string;
    readonly relationshipId: string;
}

interface PartTarget {
    readonly kind: "part";
    readonly part: string;
}

interface IgnoredTarget {
    readonly kind: "ignored";
}

type RelationshipTarget = PartTarget | IgnoredTarget;

const IGNORED_TARGET: RelationshipTarget = Object.freeze({ kind: "ignored" });

interface CellDraft {
    readonly ref: string;
    readonly value: string;
}

interface SheetContent {
    readonly rows: number;
    readonly cells: number;
    /** Value-bearing cells in the first `MAX_CELLS_PER_SHEET` positions. */
    readonly values: readonly CellDraft[];
    /** True when a value-bearing cell was skipped because of the per-sheet cap. */
    readonly overflow: boolean;
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

function invalidDocument(message: string): DocumentError {
    return new DocumentError("invalid_document", message);
}

/** Decodes a part, mapping undecodable UTF-8 to a document error; missing parts stay empty. */
function readOptionalPart(zip: ZipArchive, part: string): Optional<string> {
    try {
        return zip.text(part);
    } catch {
        throw invalidDocument(`part ${part} is not valid UTF-8`);
    }
}

function readRequiredPart(zip: ZipArchive, part: string, label: string): string {
    const text = readOptionalPart(zip, part);
    if (text.isEmpty()) throw invalidDocument(`${label} (${part}) is missing`);
    return text.get();
}

/** Concatenated text of every descendant `t` element, including rich-text runs. */
function joinTextNodes(node: XmlNode): string {
    return findAll(node, "t").map(textOf).join("");
}

/**
 * Resolves a relationship target to a package part. Targets are confined to the
 * `xl/` directory; absolute (`/xl/...`), workbook-relative (`worksheets/...`)
 * and already-prefixed (`xl/...`) forms are accepted, traversal is not.
 */
function resolvePart(target: string): Optional<string> {
    let value = target.trim();
    if (value === "" || value.includes("\\") || value.includes("\0") || value.includes(":")
        || value.includes("?") || value.includes("#")) {
        return Optional.empty<string>();
    }
    if (value.startsWith("/")) value = value.slice(1);
    const segments = value.split("/").filter(segment => segment !== ".");
    if (segments.length === 0 || segments.some(segment => segment === "" || segment === "..")) {
        return Optional.empty<string>();
    }
    value = segments.join("/");
    if (!value.startsWith("xl/")) value = `xl/${value}`;
    if (value === "xl/" || !value.startsWith("xl/")) return Optional.empty<string>();
    return Optional.of(value);
}

function readSheets(workbook: XmlNode): readonly SheetDefinition[] {
    const container = firstChild(workbook, "sheets");
    if (container.isEmpty()) return Object.freeze([]);
    return Object.freeze(childrenNamed(container.get(), "sheet").map((sheet, index) => {
        const rawName = attrOf(sheet, "name");
        const name = isString(rawName) && rawName.trim() !== "" ? rawName : `Sheet ${index + 1}`;
        const relationshipId = attrOf(sheet, "r:id", "id") ?? "";
        return Object.freeze({ name, relationshipId });
    }));
}

function readRelationships(zip: ZipArchive, hasSheets: boolean, limits: DocumentLimits): SynchronousUnorderedMap<string, RelationshipTarget> {
    const relationships = new SynchronousUnorderedMap<string, RelationshipTarget>();
    const part = readOptionalPart(zip, WORKBOOK_RELATIONSHIPS_PART);
    if (part.isEmpty()) {
        if (hasSheets) throw invalidDocument(`${WORKBOOK_RELATIONSHIPS_PART} is missing`);
        return relationships;
    }
    const root = parseXml(part.get(), limits);
    if (root.local !== "Relationships") throw invalidDocument(`${WORKBOOK_RELATIONSHIPS_PART} has no Relationships root`);
    for (const node of childrenNamed(root, "Relationship")) {
        const id = attrOf(node, "Id");
        if (id === undefined || relationships.containsKey(id)) continue;
        const mode = attrOf(node, "TargetMode");
        if (mode !== undefined && mode.toLowerCase() === "external") {
            relationships.put(id, IGNORED_TARGET);
            continue;
        }
        const target = attrOf(node, "Target");
        if (target === undefined) {
            relationships.put(id, IGNORED_TARGET);
            continue;
        }
        const resolved = resolvePart(target);
        relationships.put(id, resolved.isEmpty()
            ? IGNORED_TARGET
            : Object.freeze({ kind: "part", part: resolved.get() }));
    }
    return relationships;
}

function readSharedStrings(zip: ZipArchive, limits: DocumentLimits): readonly string[] {
    const part = readOptionalPart(zip, SHARED_STRINGS_PART);
    if (part.isEmpty()) return Object.freeze([]);
    const root = parseXml(part.get(), limits);
    if (root.local !== "sst") throw invalidDocument(`${SHARED_STRINGS_PART} has no sst root`);
    return Object.freeze(childrenNamed(root, "si").map(joinTextNodes));
}

/** Cached value of one cell; `undefined` when the cell is empty or unresolvable. */
function cellValue(cell: XmlNode, sharedStrings: readonly string[]): string | undefined {
    const type = attrOf(cell, "t");
    let raw: string | undefined;
    if (type === "s") {
        const value = firstChild(cell, "v");
        if (value.isEmpty()) return undefined;
        const indexText = textOf(value.get()).trim();
        if (!SHARED_STRING_INDEX.test(indexText)) return undefined;
        const index = Number(indexText);
        if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) return undefined;
        raw = sharedStrings[index];
    } else if (type === "inlineStr") {
        const inline = firstChild(cell, "is");
        if (inline.isEmpty()) return undefined;
        raw = joinTextNodes(inline.get());
    } else {
        const value = firstChild(cell, "v");
        if (value.isEmpty()) return undefined;
        raw = textOf(value.get());
    }
    if (!isString(raw)) return undefined;
    const value = raw.trim();
    return value === "" ? undefined : value;
}

/**
 * Reads `sheetData`. Raw row/cell counts feed the sheet summary; only the first
 * per-sheet window of value-bearing cells is retained for cell entries.
 */
function readWorksheet(
    zip: ZipArchive, part: string, sheetName: string, sharedStrings: readonly string[], limits: DocumentLimits,
): SheetContent {
    const xml = readOptionalPart(zip, part);
    if (xml.isEmpty()) throw invalidDocument(`worksheet part ${part} for sheet ${sheetName} is missing`);
    const root = parseXml(xml.get(), limits);
    const empty: SheetContent = Object.freeze({ rows: 0, cells: 0, values: Object.freeze([]), overflow: false });
    if (root.local !== "worksheet") return empty;
    const sheetData = firstChild(root, "sheetData");
    if (sheetData.isEmpty()) return empty;

    const values: CellDraft[] = [];
    let rows = 0;
    let cells = 0;
    let overflow = false;
    for (const row of childrenNamed(sheetData.get(), "row")) {
        rows += 1;
        for (const cell of childrenNamed(row, "c")) {
            cells += 1;
            const ref = attrOf(cell, "r");
            if (!isString(ref) || !CELL_REFERENCE.test(ref)) continue;
            const value = cellValue(cell, sharedStrings);
            if (value === undefined) continue;
            if (values.length >= MAX_CELLS_PER_SHEET) {
                overflow = true;
                continue;
            }
            values.push(Object.freeze({ ref, value }));
        }
    }
    return Object.freeze({ rows, cells, values: Object.freeze(values), overflow });
}

export function parseXlsx(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("xlsx input must be a Uint8Array");
    assertNotLegacy(bytes, "Excel", ".xlsx");
    const zip = ZipArchive.open(bytes, limits);
    const workbook = parseXml(readRequiredPart(zip, WORKBOOK_PART, "workbook part"), limits);
    if (workbook.local !== "workbook") throw invalidDocument(`${WORKBOOK_PART} has no workbook root`);

    const sheets = readSheets(workbook);
    const relationships = readRelationships(zip, sheets.length > 0, limits);
    const sharedStrings = readSharedStrings(zip, limits);
    const builder = new OutlineBuilder(limits);
    let exhausted = false;

    for (let index = 0; index < sheets.length; index += 1) {
        const sheet = sheets[index]!;
        const relationship = relationships.get(sheet.relationshipId);
        if (relationship.isEmpty()) throw invalidDocument(`sheet ${sheet.name} has no workbook relationship`);
        const target = relationship.get();
        if (target.kind === "ignored") continue;

        const content = readWorksheet(zip, target.part, sheet.name, sharedStrings, limits);
        const sheetId = `xlsx:sheet:${index}`;
        const added = builder.add({
            id: sheetId,
            kind: "sheet",
            name: sheet.name,
            summary: `${content.rows} rows, ${content.cells} cells`,
            locator: { part: target.part, sheet: sheet.name },
        });
        if (!added) break;
        if (content.overflow) builder.noteTruncated();

        const seenRefs = new SynchronousUnorderedSet<string>();
        for (const cell of content.values) {
            if (!seenRefs.add(cell.ref)) continue;
            if (cell.value.length > MAX_CELL_CHARACTERS) builder.noteTruncated();
            const value = cell.value.length > MAX_CELL_CHARACTERS ? cell.value.slice(0, MAX_CELL_CHARACTERS) : cell.value;
            const cellAdded = builder.add({
                id: `xlsx:cell:${index}:${cell.ref}`,
                parentId: sheetId,
                kind: "cell",
                name: `${sheet.name}!${cell.ref}`,
                summary: value,
                locator: { part: target.part, sheet: sheet.name, cell: cell.ref },
            });
            if (!cellAdded) {
                exhausted = true;
                break;
            }
        }
        if (exhausted) break;
    }
    return builder.outline("excel");
}
