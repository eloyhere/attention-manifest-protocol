/**
 * WordprocessingML (`.docx`) outline reader.
 *
 * Scope: only the main document body in `word/document.xml`. Body-level `w:p`
 * paragraphs and `w:tbl` tables are projected; `w:sectPr`, content controls and
 * any other body child are ignored. Headers, footers, footnotes/endnotes,
 * comments, text boxes, images, embedded objects, tracked changes and style
 * inheritance are not interpreted, and no macro or relationship part is read.
 *
 * The outline is a read-only preview, never an editable text projection of the
 * package. `locator.paragraph` is the 1-based body paragraph sequence (empty
 * paragraphs included) and `locator.part` names the source XML part.
 *
 * Budgets default to `defaultDocumentLimits` and may be narrowed through the
 * optional `limits` argument. Once the entry or character budget is reached,
 * the outline is clipped and `truncated` is set; malformed input still raises
 * `DocumentError` instead of yielding an empty outline.
 */
import { Optional } from "semantic-typescript";
import { assertNotLegacy } from "./legacy.ts";
import {
    DocumentError, defaultDocumentLimits, type DocumentEntry, type DocumentEntryKind, type DocumentLimits, type DocumentLocator,
    type DocumentOutline,
} from "./types.ts";
import { attrOf, childrenNamed, findAll, firstChild, parseXml, textOf, type XmlNode } from "./xml.ts";
import { ZipArchive } from "./zip.ts";

const DOCUMENT_PART = "word/document.xml";
const MAX_NAME_CHARACTERS = 120;
const HEADING_STYLE = /^(Heading[1-9]|Title)$/i;

interface EntryDraft {
    readonly id: string;
    readonly kind: DocumentEntryKind;
    readonly name: string;
    readonly summary: string;
    readonly locator: DocumentLocator;
}

/**
 * Accumulates entries while enforcing the outline budgets. A rejected entry
 * means the budget is exhausted, so callers stop walking the document.
 */
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

function invalidDocument(message: string): DocumentError {
    return new DocumentError("invalid_document", message);
}

/** Reads the main document part, mapping undecodable UTF-8 to a document error. */
function readDocumentPart(zip: ZipArchive): string {
    let part: Optional<string>;
    try {
        part = zip.text(DOCUMENT_PART);
    } catch {
        throw invalidDocument(`${DOCUMENT_PART} is not valid UTF-8`);
    }
    if (part.isEmpty()) throw invalidDocument(`${DOCUMENT_PART} is missing`);
    return part.get();
}

/** Direct text of every descendant `t` element, in document order. */
function textInside(node: XmlNode, local: string): string {
    return findAll(node, local).map(textOf).join("");
}

/** `pPr/pStyle/@val`, used only to classify a paragraph; style inheritance is not resolved. */
function paragraphStyle(paragraph: XmlNode): Optional<string> {
    return firstChild(paragraph, "pPr")
        .flatMap(properties => firstChild(properties, "pStyle"))
        .flatMap(style => Optional.ofNullable(attrOf(style, "val")));
}

/** Rows joined by newlines, cells joined by `" | "`. */
function tableSummary(table: XmlNode): string {
    return childrenNamed(table, "tr")
        .map(row => childrenNamed(row, "tc").map(cell => textInside(cell, "t")).join(" | "))
        .join("\n");
}

export function parseDocx(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("docx input must be a Uint8Array");
    assertNotLegacy(bytes, "Word", ".docx");
    const zip = ZipArchive.open(bytes, limits);
    const documentNode = parseXml(readDocumentPart(zip), limits);
    if (documentNode.local !== "document") throw invalidDocument(`${DOCUMENT_PART} has no w:document root`);
    const body = firstChild(documentNode, "body");
    if (body.isEmpty()) throw invalidDocument(`${DOCUMENT_PART} has no w:body`);

    const builder = new OutlineBuilder(limits);
    let paragraphNumber = 0;
    let tableNumber = 0;
    for (const child of body.get().children) {
        if (child.local === "p") {
            paragraphNumber += 1;
            const text = textInside(child, "t");
            if (text.trim() === "") continue;
            const style = paragraphStyle(child).orElse(undefined);
            const kind: DocumentEntryKind = typeof style === "string" && HEADING_STYLE.test(style) ? "heading" : "paragraph";
            const added = builder.add({
                id: `word:paragraph:${paragraphNumber}`,
                kind,
                name: text,
                summary: text,
                locator: { part: DOCUMENT_PART, paragraph: paragraphNumber },
            });
            if (!added) break;
        } else if (child.local === "tbl") {
            tableNumber += 1;
            const added = builder.add({
                id: `word:table:${tableNumber}`,
                kind: "table",
                name: `Table ${tableNumber}`,
                summary: tableSummary(child),
                locator: { part: DOCUMENT_PART },
            });
            if (!added) break;
        }
    }
    return builder.outline("word");
}
