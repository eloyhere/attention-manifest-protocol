/**
 * Read-only Office document parsing.
 *
 * The agent workspace exposes `outline`, `import`, `export` and `dependency`
 * for files, so an Office container must answer the same questions as a source
 * file: what is inside, what does it point at, and what does it expose? This
 * module does that without a third-party parser or a runtime dependency:
 *
 * - OOXML (`.docx`, `.xlsx`, `.pptx`) is a ZIP of XML parts. `zip.ts` reads the
 *   archive and a bounded tag scanner below reads the parts. The scanner is
 *   deliberately not a DOM: it records tag spans, attributes and matching close
 *   indices, which is enough to walk paragraphs, slides, sheets and formulas
 *   with a hard tag/depth limit.
 * - Legacy binaries (`.doc`, `.xls`, `.ppt`, `.pub`) are OLE Compound Files.
 *   `cfb.ts` extracts named streams and this module recovers printable
 *   UTF-16LE/ASCII text. That recovery is heuristic and reported as such.
 * - Access databases (`.accdb`, `.mdb`) use the Jet/ACE format rather than CFB.
 *   The header is recognised and catalog names are recovered on a best-effort
 *   basis; no page or column semantics are claimed.
 * - Anything else is `kind: "unknown"` with an explicit warning instead of a
 *   guessed parse.
 *
 * Parsing is not semantic validation. Word headers/footnotes/comments,
 * PowerPoint layouts/notes/charts, Excel formula results and Access table
 * definitions are outside the model. Every result therefore carries warnings
 * that name the unsupported surface; `officeImports`, `officeExports` and
 * `officeReferences` expose the facts that were actually recovered.
 */
import { lstatSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { posix } from "node:path";

import { rawDigest } from "../fingerprint/raw.ts";
import { readCfb } from "../file/cfb.ts";
import type { CfbEntry } from "../file/cfb.ts";
import { fail, isFilesystemError } from "../file/errors.ts";
import { hasOfficeOutlineParser, registerOfficeOutlineParser } from "./officeBridge.ts";
import type { PathSandbox } from "../file/path.ts";
import type { OutlineKind, OutlineNode } from "./types.ts";
import type { RootedPath } from "../file/types.ts";
import { readZipEntries, zipText } from "../file/zip.ts";

/**
 * Coarse Office family, derived from the file extension and, for OOXML, from
 * the parts in the package when the extension is uninformative.
 */
export type OfficeKind = "word" | "excel" | "powerpoint" | "publisher" | "access" | "unknown";

/**
 * Container format. `ole` also covers legacy Access database files, which are
 * binary Jet/ACE files rather than CFB containers; the value names the legacy
 * binary family rather than the exact on-disk serialization.
 */
export type OfficeFormat = "ooxml" | "ole" | "unknown";

/**
 * Section kinds used by the outline projection.
 */
export type OfficeSectionKind = "heading" | "slide" | "sheet" | "table" | "query" | "form" | "report" | "section" | "paragraph";

/**
 * One structural element of a document.
 *
 * `index` is the zero-based document order across the whole tree, so a consumer
 * can use `index + 1` as a stable synthetic line number even though Office
 * formats do not have source lines. `children` preserves hierarchy for
 * headings, slides and sheets.
 */
export interface OfficeSection {
    id: string;
    label: string;
    kind: OfficeSectionKind;
    depth: number;
    index: number;
    children: OfficeSection[];
}

/**
 * One outbound relationship or embedded object.
 *
 * `from` identifies the source element when that is meaningful (an Excel cell
 * address, for example); elsewhere it is the document path. `target` is a URL,
 * an internal part name, a formula reference or a defined name. `detail` is an
 * optional short classification hint.
 */
export interface OfficeReference {
    kind: "hyperlink" | "external-link" | "embedded" | "formula" | "bookmark" | "named-range";
    from: string;
    target: string;
    detail?: string;
}

/**
 * Complete best-effort parse of one Office file.
 *
 * `fingerprint` is the content-address ref of the whole file (`sha256:<hex>`),
 * not of the extracted sections. It matches the tree node fingerprint, so
 * import/export/dependency reports can use it as a cache key without re-reading
 * the container.
 */
export interface OfficeDocument {
    path: string;
    kind: OfficeKind;
    format: OfficeFormat;
    bytes: bigint;
    fingerprint: string;
    sections: OfficeSection[];
    references: OfficeReference[];
    imports: string[];
    exports: string[];
    metadata: Record<string, string>;
    warnings: string[];
}

/**
 * Largest Office file `parseOffice` will load. Legacy containers and OOXML
 * packages can be much larger than a text outline; `parseOffice` still applies
 * the same 64 MiB ceiling as the rest of the bounded readers.
 */
export const OfficeMaxDocumentBytes: number = 64 * 1024 * 1024;

/**
 * Largest Office file the outline bridge accepts from raw bytes.
 *
 * `outline.ts` owns its own 4 MiB text ceiling and routes Office containers
 * through `readOutlineBytes` before calling the registered parser. Keeping the
 * same value here means a direct `officeOutlineParser` caller gets
 * `quota_exceeded` before any container walk, never `binary_file`, and the two
 * entry points agree on the bound.
 */
export const OfficeMaxOutlineBytes: number = 4 * 1024 * 1024;

const MaxSections: number = 2000;
const MaxReferences: number = 2000;
const MaxImports: number = 500;
const MaxExports: number = 1000;
const MaxWarnings: number = 48;
const MaxLabelLength: number = 200;
const MaxDetailLength: number = 200;
const MaxTextFragments: number = 500;
const MaxRawFragments: number = 4096;
const MaxTextScanBytes: number = 48 * 1024 * 1024;
const MaxXmlTags: number = 200000;
const MaxXmlDepth: number = 256;
const MaxRelationshipTargets: number = 500;

/**
 * Extensions recognized as Office documents. The map is lowercase; `isOfficeFile`
 * and `kindFromPath` both fold the caller path before lookup.
 */
const OfficeExtensions: Readonly<Record<string, OfficeKind>> = {
    ".docx": "word",
    ".doc": "word",
    ".xlsx": "excel",
    ".xls": "excel",
    ".pptx": "powerpoint",
    ".ppt": "powerpoint",
    ".pub": "publisher",
    ".accdb": "access",
    ".mdb": "access",
};

/**
 * Fold a path to its lowercase extension. A dot-file or a path without an
 * extension yields an empty string.
 *
 * @param path - Caller path.
 * @returns Lowercase extension including the dot, or `""`.
 */
const extensionOf: (path: string) => string = (path: string): string => {
    const lower: string = path.toLowerCase();
    const slash: number = lower.lastIndexOf("/");
    const name: string = slash === -1 ? lower : lower.slice(slash + 1);
    const dot: number = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot);
};

/**
 * Classify a path by extension.
 *
 * @param path - Caller path.
 * @returns Office family, or `unknown`.
 */
const kindFromPath: (path: string) => OfficeKind = (path: string): OfficeKind => OfficeExtensions[extensionOf(path)] ?? "unknown";

/**
 * Whether a path names a supported Office document. The check is purely
 * syntactic: a file with a `.docx` suffix that is not a ZIP is still routed to
 * the Office parser so it can report a structured warning.
 *
 * @param path - Root-relative or absolute path.
 * @returns Whether the extension is one of the supported Office extensions.
 */
export const isOfficeFile: (path: string) => boolean = (path: string): boolean => kindFromPath(path) !== "unknown";

/**
 * Collapse whitespace and bound a label.
 *
 * @param value - Raw label.
 * @param fallback - Text used when the label is empty.
 * @returns A compact label.
 */
const cleanLabel: (value: string, fallback: string) => string = (value: string, fallback: string): string => {
    const text: string = value.replace(/\s+/g, " ").trim();
    const chosen: string = text.length === 0 ? fallback : text;
    return chosen.slice(0, MaxLabelLength);
};

/**
 * Collapse whitespace and bound a detail/target string.
 *
 * @param value - Raw value.
 * @returns A compact value.
 */
const cleanDetail: (value: string) => string = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, MaxDetailLength);

/**
 * Read ASCII bytes from a buffer without assuming a zero terminator.
 *
 * @param bytes - Source bytes.
 * @param offset - Start offset.
 * @param length - Maximum byte count.
 * @returns Printable ASCII characters only.
 */
const asciiAt: (bytes: Uint8Array, offset: number, length: number) => string = (bytes: Uint8Array, offset: number, length: number): string => {
    const end: number = Math.min(bytes.length, offset + length);
    let value: string = "";
    for (let index: number = offset; index < end; index += 1) {
        const code: number = bytes[index];
        if (code < 0x20 || code > 0x7e) {
            break;
        }
        value += String.fromCharCode(code);
    }
    return value;
};

/**
 * Extract an errno code from an unknown thrown value without trusting it.
 *
 * @param error - Caught value.
 * @returns The string code, or `""`.
 */
const errorCode: (error: unknown) => string = (error: unknown): string => {
    if (typeof(error) !== "object" || error === null) {
        return "";
    }
    const code: unknown = (error as { readonly code?: unknown }).code;
    return typeof(code) === "string" ? code : "";
};

/**
 * Translate a host filesystem failure into the closed domain taxonomy.
 *
 * @param error - Caught value.
 * @returns Never; throws a classified error.
 */
const mapFsError: (error: unknown) => never = (error: unknown): never => {
    if (isFilesystemError(error)) {
        throw error;
    }
    switch (errorCode(error)) {
        case "ENOENT": {
            return fail("not_found");
        }
        case "EACCES":
        case "EPERM": {
            return fail("permission_denied");
        }
        case "EISDIR": {
            return fail("not_file");
        }
        case "ENOTDIR": {
            return fail("not_directory");
        }
        case "ELOOP": {
            return fail("symlink_denied");
        }
        case "ENOSPC":
        case "EDQUOT": {
            return fail("quota_exceeded");
        }
        default: {
            return fail("internal_error");
        }
    }
};

/**
 * `lstat` through the domain error taxonomy.
 *
 * @param absolute - Host absolute path.
 * @returns File stats.
 */
const statOrFail: (absolute: string) => Stats = (absolute: string): Stats => {
    try {
        return lstatSync(absolute);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * Read whole-file bytes through the domain error taxonomy.
 *
 * @param absolute - Host absolute path.
 * @returns File bytes.
 */
const readBytesOrFail: (absolute: string) => Uint8Array = (absolute: string): Uint8Array => {
    try {
        return readFileSync(absolute);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * One scanned XML tag. `start` points at `<` and `end` at the first byte after
 * `>`. `closing` and `selfClosing` are independent because `</x>` is never
 * self-closing and `<x/>` is never a close tag.
 */
interface XmlTag {
    readonly name: string;
    readonly local: string;
    readonly closing: boolean;
    readonly selfClosing: boolean;
    readonly attrs: Readonly<Record<string, string>>;
    readonly start: number;
    readonly end: number;
}

/**
 * A bounded tag list plus a matching-close index per open tag.
 */
interface XmlScan {
    readonly tags: readonly XmlTag[];
    readonly closeOf: readonly number[];
    readonly unclosed: number;
}

/**
 * Decode the five predefined XML entities and numeric character references.
 * Unknown entities are left intact so a caller can see exactly what was not
 * understood.
 *
 * @param value - Encoded text.
 * @returns Decoded text.
 */
const decodeXmlEntities: (value: string) => string = (value: string): string =>
    value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match: string, entity: string): string => {
        if (entity === "amp") {
            return "&";
        }
        if (entity === "lt") {
            return "<";
        }
        if (entity === "gt") {
            return ">";
        }
        if (entity === "quot") {
            return '"';
        }
        if (entity === "apos") {
            return "'";
        }
        if (entity === "nbsp") {
            return "\u00a0";
        }
        if (entity.startsWith("#x") || entity.startsWith("#X")) {
            const code: number = Number.parseInt(entity.slice(2), 16);
            return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        if (entity.startsWith("#")) {
            const code: number = Number.parseInt(entity.slice(1), 10);
            return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        return match;
    });

/**
 * Remove comments, CDATA markers and any residual tags from a text fragment,
 * then decode entities. Used for the content of `<w:t>`, `<a:t>`, `<f>` and
 * similar leaf elements where nested markup is not expected.
 *
 * @param value - Leaf content.
 * @returns Plain text.
 */
const xmlText: (value: string) => string = (value: string): string =>
    decodeXmlEntities(
        value
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
            .replace(/<[^>]*>/g, ""),
    );

/**
 * Find the `>` that closes a tag, ignoring `>` characters inside quoted
 * attribute values.
 *
 * @param xml - Source XML.
 * @param start - Offset of `<`.
 * @returns Offset of `>`, or `-1`.
 */
const findTagEnd: (xml: string, start: number) => number = (xml: string, start: number): number => {
    let quote: string = "";
    for (let index: number = start + 1; index < xml.length; index += 1) {
        const char: string = xml[index];
        if (quote.length > 0) {
            if (char === quote) {
                quote = "";
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === ">") {
            return index;
        }
    }
    return -1;
};

/**
 * Parse the attribute section of an open tag. Attribute values may be single or
 * double quoted; entity references are decoded.
 *
 * @param body - Tag text between `<` and `>`, trimmed.
 * @param from - Index after the tag name.
 * @returns Attribute map.
 */
const parseAttributes: (body: string, from: number) => Record<string, string> = (body: string, from: number): Record<string, string> => {
    const attrs: Record<string, string> = {};
    let index: number = from;
    while (index < body.length) {
        while (index < body.length && /\s/.test(body[index])) {
            index += 1;
        }
        if (index >= body.length || body[index] === "/") {
            break;
        }
        const equals: number = body.indexOf("=", index);
        if (equals === -1) {
            break;
        }
        const name: string = body.slice(index, equals).trim();
        let valueStart: number = equals + 1;
        while (valueStart < body.length && /\s/.test(body[valueStart])) {
            valueStart += 1;
        }
        const quote: string = body[valueStart] ?? "";
        if (quote !== '"' && quote !== "'") {
            break;
        }
        const valueEnd: number = body.indexOf(quote, valueStart + 1);
        if (valueEnd === -1) {
            break;
        }
        if (name.length > 0) {
            attrs[name] = decodeXmlEntities(body.slice(valueStart + 1, valueEnd));
        }
        index = valueEnd + 1;
    }
    return attrs;
};

/**
 * Scan XML into an ordered tag list with bounded nesting and tag count.
 *
 * This is intentionally not a validating parser. It recognises comments,
 * processing instructions, CDATA sections and doctype declarations, handles
 * quoted `>` characters and records matching close indices with a stack. A
 * document that exceeds the tag or depth ceiling throws; Office callers turn
 * that into a warning because a single oversized part should not discard the
 * rest of the package.
 *
 * @param xml - XML text.
 * @returns Tags with matching-close indices.
 */
const scanXml: (xml: string) => XmlScan = (xml: string): XmlScan => {
    const tags: XmlTag[] = [];
    const closeOf: number[] = [];
    const stack: number[] = [];
    let depth: number = 0;
    let index: number = 0;
    while (index < xml.length) {
        const start: number = xml.indexOf("<", index);
        if (start === -1) {
            break;
        }
        if (xml.startsWith("<!--", start)) {
            const end: number = xml.indexOf("-->", start + 4);
            if (end === -1) {
                break;
            }
            index = end + 3;
            continue;
        }
        if (xml.startsWith("<![CDATA[", start)) {
            const end: number = xml.indexOf("]]>", start + 9);
            if (end === -1) {
                break;
            }
            index = end + 3;
            continue;
        }
        const next: string = xml[start + 1] ?? "";
        if (next === "!" || next === "?") {
            const end: number = findTagEnd(xml, start);
            if (end === -1) {
                break;
            }
            index = end + 1;
            continue;
        }
        const end: number = findTagEnd(xml, start);
        if (end === -1) {
            throw new Error("unterminated xml tag");
        }
        const body: string = xml.slice(start + 1, end).trim();
        index = end + 1;
        if (body.length === 0) {
            continue;
        }
        const closing: boolean = body.startsWith("/");
        const content: string = closing ? body.slice(1).trim() : body;
        const selfClosing: boolean = !closing && content.endsWith("/");
        const withoutSlash: string = selfClosing ? content.slice(0, -1).trimEnd() : content;
        let nameEnd: number = 0;
        while (nameEnd < withoutSlash.length && !/\s/.test(withoutSlash[nameEnd])) {
            nameEnd += 1;
        }
        const name: string = withoutSlash.slice(0, nameEnd);
        if (name.length === 0) {
            continue;
        }
        const colon: number = name.lastIndexOf(":");
        const local: string = colon === -1 ? name : name.slice(colon + 1);
        const attrs: Record<string, string> = closing ? {} : parseAttributes(withoutSlash, nameEnd);
        const tagIndex: number = tags.length;
        tags.push({ name, local, closing, selfClosing, attrs, start, end: end + 1 });
        closeOf.push(-1);
        if (tags.length > MaxXmlTags) {
            throw new Error("xml tag limit exceeded");
        }
        if (closing) {
            depth = Math.max(0, depth - 1);
            const open: number | undefined = stack.pop();
            if (open !== (void 0)) {
                closeOf[open] = tagIndex;
            }
        } else if (!selfClosing) {
            depth += 1;
            if (depth > MaxXmlDepth) {
                throw new Error("xml nesting limit exceeded");
            }
            stack.push(tagIndex);
        }
    }
    return { tags, closeOf, unclosed: stack.length };
};

/**
 * Attribute lookup with namespace-prefix fallback: an exact `r:id` wins over a
 * bare `id`, and `w:val` is found when the caller only knows the local name.
 *
 * @param tag - Tag to inspect.
 * @param name - Qualified or local attribute name.
 * @returns Attribute value, or `""`.
 */
const xmlAttr: (tag: XmlTag, name: string) => string = (tag: XmlTag, name: string): string => {
    const direct: string | undefined = tag.attrs[name];
    if (direct !== (void 0)) {
        return direct;
    }
    const colon: number = name.lastIndexOf(":");
    const local: string = colon === -1 ? name : name.slice(colon + 1);
    const keys: readonly string[] = Object.keys(tag.attrs);
    for (let index: number = 0; index < keys.length; index += 1) {
        const key: string = keys[index];
        const keyColon: number = key.lastIndexOf(":");
        const keyLocal: string = keyColon === -1 ? key : key.slice(keyColon + 1);
        if (keyLocal === local) {
            return tag.attrs[key];
        }
    }
    return "";
};

/**
 * Text content of one element, using its precomputed matching close.
 *
 * @param xml - Source XML.
 * @param scan - Tag scan for the same source.
 * @param index - Index of the open tag.
 * @returns Decoded inner text, or `""` when the element is self-closing or
 * unclosed.
 */
const xmlInnerText: (xml: string, scan: XmlScan, index: number) => string = (xml: string, scan: XmlScan, index: number): string => {
    const tag: XmlTag = scan.tags[index];
    if (tag.selfClosing) {
        return "";
    }
    const close: number = scan.closeOf[index];
    if (close < 0) {
        return "";
    }
    return xmlText(xml.slice(tag.end, scan.tags[close].start));
};

/**
 * First child element with a given local name inside an open element.
 *
 * @param scan - Tag scan.
 * @param openIndex - Enclosing open tag.
 * @param local - Local child name.
 * @returns Index of the child, or `-1`.
 */
const xmlChild: (scan: XmlScan, openIndex: number, local: string) => number = (scan: XmlScan, openIndex: number, local: string): number => {
    const close: number = scan.closeOf[openIndex];
    const end: number = close < 0 ? scan.tags.length : close;
    for (let index: number = openIndex + 1; index < end; index += 1) {
        const tag: XmlTag = scan.tags[index];
        if (!tag.closing && tag.local === local) {
            return index;
        }
    }
    return -1;
};

/**
 * Text of the first matching child element.
 *
 * @param xml - Source XML.
 * @param scan - Tag scan.
 * @param openIndex - Enclosing open tag.
 * @param local - Local child name.
 * @returns Decoded text, or `""`.
 */
const xmlChildText: (xml: string, scan: XmlScan, openIndex: number, local: string) => string = (
    xml: string,
    scan: XmlScan,
    openIndex: number,
    local: string,
): string => {
    const child: number = xmlChild(scan, openIndex, local);
    return child === -1 ? "" : xmlInnerText(xml, scan, child);
};

/**
 * Resolve an internal OOXML relationship target against its source part.
 *
 * @param sourcePart - Part that owns the relationship.
 * @param target - Relationship target as written.
 * @returns Normalized package part name.
 */
const resolvePart: (sourcePart: string, target: string) => string = (sourcePart: string, target: string): string => {
    if (target.startsWith("/")) {
        return posix.normalize(target.slice(1)).replace(/^\.\//, "");
    }
    return posix.normalize(posix.join(posix.dirname(sourcePart), target)).replace(/^\.\//, "");
};

/**
 * Path of the relationships part for an OOXML part.
 *
 * @param part - Source part name.
 * @returns Relationships part name.
 */
const relationshipsPart: (part: string) => string = (part: string): string => {
    const directory: string = posix.dirname(part);
    const file: string = `${posix.basename(part)}.rels`;
    return directory === "." ? `_rels/${file}` : `${directory}/_rels/${file}`;
};

/**
 * One OOXML relationship, already resolved for internal targets.
 */
interface OfficeRelationship {
    readonly id: string;
    readonly type: string;
    readonly target: string;
    readonly external: boolean;
}

/**
 * Read a relationships part. Missing parts are normal (a minimal fixture or a
 * package without links), so this returns an empty list rather than warning.
 *
 * @param entries - OOXML package parts.
 * @param part - Source part name.
 * @returns Relationships in document order.
 */
const readRelationships: (entries: ReadonlyMap<string, Uint8Array>, part: string) => OfficeRelationship[] = (
    entries: ReadonlyMap<string, Uint8Array>,
    part: string,
): OfficeRelationship[] => {
    const xml: string | undefined = zipText(entries, relationshipsPart(part));
    if (xml === (void 0)) {
        return [];
    }
    const scan: XmlScan = scanXml(xml);
    const relationships: OfficeRelationship[] = [];
    for (let index: number = 0; index < scan.tags.length && relationships.length < MaxRelationshipTargets; index += 1) {
        const tag: XmlTag = scan.tags[index];
        if (tag.closing || tag.local !== "Relationship") {
            continue;
        }
        const id: string = xmlAttr(tag, "Id");
        const type: string = xmlAttr(tag, "Type");
        const rawTarget: string = xmlAttr(tag, "Target");
        if (rawTarget.length === 0) {
            continue;
        }
        const external: boolean = xmlAttr(tag, "TargetMode") === "External";
        relationships.push({
            id,
            type,
            target: external ? rawTarget : resolvePart(part, rawTarget),
            external,
        });
    }
    return relationships;
};

/**
 * Index a relationship list by id.
 *
 * @param relationships - Relationships to index.
 * @returns Id to relationship.
 */
const relationshipMap: (relationships: readonly OfficeRelationship[]) => Map<string, OfficeRelationship> = (
    relationships: readonly OfficeRelationship[],
): Map<string, OfficeRelationship> => {
    const map: Map<string, OfficeRelationship> = new Map<string, OfficeRelationship>();
    for (let index: number = 0; index < relationships.length; index += 1) {
        map.set(relationships[index].id, relationships[index]);
    }
    return map;
};

/**
 * Mutable parse context: the document being built plus dedupe sets and the
 * section budget. Keeping this in one object avoids threading eight parameters
 * through every format-specific helper.
 */
interface OfficeContext {
    readonly document: OfficeDocument;
    readonly sections: OfficeSection[];
    readonly referenceKeys: Set<string>;
    readonly exportKeys: Set<string>;
    readonly importKeys: Set<string>;
    readonly warningKeys: Set<string>;
    count: number;
    truncated: boolean;
}

/**
 * Create the empty document and its context.
 *
 * @param path - Root-relative path.
 * @param kind - Initial family guess.
 * @param format - Container format.
 * @param bytes - Complete file bytes.
 * @returns Context for one parse.
 */
const createContext: (path: string, kind: OfficeKind, format: OfficeFormat, bytes: Uint8Array) => OfficeContext = (
    path: string,
    kind: OfficeKind,
    format: OfficeFormat,
    bytes: Uint8Array,
): OfficeContext => {
    const document: OfficeDocument = {
        path,
        kind,
        format,
        bytes: BigInt(bytes.byteLength),
        fingerprint: rawDigest(bytes),
        sections: [],
        references: [],
        imports: [],
        exports: [],
        metadata: {},
        warnings: [],
    };
    return {
        document,
        sections: document.sections,
        referenceKeys: new Set<string>(),
        exportKeys: new Set<string>(),
        importKeys: new Set<string>(),
        warningKeys: new Set<string>(),
        count: 0,
        truncated: false,
    };
};

/**
 * Add a warning, deduplicated and bounded.
 *
 * @param context - Parse context.
 * @param message - Human-readable warning.
 */
const pushWarning: (context: OfficeContext, message: string) => void = (context: OfficeContext, message: string): void => {
    const clean: string = message.replace(/\s+/g, " ").trim().slice(0, 240);
    if (clean.length === 0 || context.warningKeys.has(clean) || context.document.warnings.length >= MaxWarnings) {
        return;
    }
    context.warningKeys.add(clean);
    context.document.warnings.push(clean);
};

/**
 * Set one metadata value when it is non-empty.
 *
 * @param context - Parse context.
 * @param key - Metadata key.
 * @param value - Raw value.
 */
const setMetadata: (context: OfficeContext, key: string, value: string) => void = (context: OfficeContext, key: string, value: string): void => {
    const clean: string = value.replace(/\s+/g, " ").trim().slice(0, 300);
    if (clean.length > 0) {
        context.document.metadata[key] = clean;
    }
};

/**
 * Append a section and return it, or `undefined` once the section budget is
 * exhausted. Children are appended pre-order, so `index` matches document
 * order.
 *
 * @param context - Parse context.
 * @param parent - Parent section, or `undefined` for a root section.
 * @param kind - Section kind.
 * @param label - Raw label.
 * @param depth - Hierarchy depth.
 * @returns The new section, or `undefined` when truncated.
 */
const appendSection: (
    context: OfficeContext,
    parent: OfficeSection | undefined,
    kind: OfficeSectionKind,
    label: string,
    depth: number,
) => OfficeSection | undefined = (
    context: OfficeContext,
    parent: OfficeSection | undefined,
    kind: OfficeSectionKind,
    label: string,
    depth: number,
): OfficeSection | undefined => {
    if (context.count >= MaxSections) {
        context.truncated = true;
        return undefined;
    }
    const index: number = context.count;
    context.count += 1;
    const section: OfficeSection = {
        id: `${kind}-${index}`,
        label: cleanLabel(label, `Section ${index + 1}`),
        kind,
        depth: Math.max(0, Math.trunc(depth)),
        index,
        children: [],
    };
    if (parent === (void 0)) {
        context.sections.push(section);
    } else {
        parent.children.push(section);
    }
    return section;
};

/**
 * Add an outbound reference, deduplicated by kind/from/target.
 *
 * @param context - Parse context.
 * @param reference - Reference to add.
 */
const addReference: (context: OfficeContext, reference: OfficeReference) => void = (context: OfficeContext, reference: OfficeReference): void => {
    if (context.document.references.length >= MaxReferences) {
        return;
    }
    const target: string = cleanDetail(reference.target);
    const from: string = cleanDetail(reference.from);
    if (target.length === 0) {
        return;
    }
    const key: string = `${reference.kind}\u0000${from}\u0000${target}`;
    if (context.referenceKeys.has(key)) {
        return;
    }
    context.referenceKeys.add(key);
    const detail: string = cleanDetail(reference.detail ?? "");
    context.document.references.push({
        kind: reference.kind,
        from,
        target,
        ...(detail.length === 0 ? {} : { detail }),
    });
};

/**
 * Add an external import target, deduplicated.
 *
 * @param context - Parse context.
 * @param target - URL or external path.
 */
const addImport: (context: OfficeContext, target: string) => void = (context: OfficeContext, target: string): void => {
    const clean: string = cleanDetail(target);
    if (clean.length === 0 || context.importKeys.has(clean) || context.document.imports.length >= MaxImports) {
        return;
    }
    context.importKeys.add(clean);
    context.document.imports.push(clean);
};

/**
 * Add an exported name, deduplicated.
 *
 * @param context - Parse context.
 * @param name - Exported symbol or object name.
 */
const addExport: (context: OfficeContext, name: string) => void = (context: OfficeContext, name: string): void => {
    const clean: string = cleanLabel(name, "");
    if (clean.length === 0 || context.exportKeys.has(clean) || context.document.exports.length >= MaxExports) {
        return;
    }
    context.exportKeys.add(clean);
    context.document.exports.push(clean);
};

/**
 * Read `docProps/core.xml` and `docProps/app.xml` into metadata.
 *
 * @param context - Parse context.
 * @param entries - OOXML package parts.
 */
const readDocumentProperties: (context: OfficeContext, entries: ReadonlyMap<string, Uint8Array>) => void = (
    context: OfficeContext,
    entries: ReadonlyMap<string, Uint8Array>,
): void => {
    const core: string | undefined = zipText(entries, "docProps/core.xml");
    if (core !== (void 0)) {
        const scan: XmlScan = scanXml(core);
        const fieldKeys: Readonly<Record<string, string>> = {
            title: "title",
            creator: "creator",
            lastModifiedBy: "lastModifiedBy",
            created: "created",
            modified: "modified",
            subject: "subject",
            description: "description",
            keywords: "keywords",
            category: "category",
        };
        for (let index: number = 0; index < scan.tags.length; index += 1) {
            const tag: XmlTag = scan.tags[index];
            if (tag.closing || tag.selfClosing) {
                continue;
            }
            const key: string | undefined = fieldKeys[tag.local];
            if (key === (void 0)) {
                continue;
            }
            setMetadata(context, key, xmlInnerText(core, scan, index));
        }
    }
    const app: string | undefined = zipText(entries, "docProps/app.xml");
    if (app !== (void 0)) {
        const scan: XmlScan = scanXml(app);
        const fieldKeys: Readonly<Record<string, string>> = {
            Application: "application",
            Company: "company",
            AppVersion: "appVersion",
            Pages: "pages",
            Words: "words",
            Slides: "slides",
            Worksheets: "worksheets",
        };
        for (let index: number = 0; index < scan.tags.length; index += 1) {
            const tag: XmlTag = scan.tags[index];
            if (tag.closing || tag.selfClosing) {
                continue;
            }
            const key: string | undefined = fieldKeys[tag.local];
            if (key === (void 0)) {
                continue;
            }
            setMetadata(context, key, xmlInnerText(app, scan, index));
        }
    }
};

/**
 * Heading level for a Word paragraph, from an explicit outline level (which
 * wins) or a built-in Heading/Title style id.
 *
 * @param style - Style id from `<w:pStyle w:val>`.
 * @param outline - Raw outline level from `<w:outlineLvl w:val>`.
 * @returns One-based heading level, or `0` for body text.
 */
const wordHeadingLevel: (style: string, outline: string) => number = (style: string, outline: string): number => {
    if (outline.length > 0) {
        const value: number = Number.parseInt(outline, 10);
        if (Number.isSafeInteger(value) && value >= 0 && value <= 8) {
            return value + 1;
        }
    }
    const heading: RegExpExecArray | null = /^Heading\s*([1-9])$/i.exec(style.trim());
    if (heading !== null) {
        return Number(heading[1]);
    }
    return /^Title$/i.test(style.trim()) ? 1 : 0;
};

/**
 * One Word paragraph collected from the main document body.
 */
interface WordParagraph {
    readonly text: string;
    readonly style: string;
    readonly outline: string;
}

/**
 * Parse `word/document.xml` into heading/paragraph sections plus bookmarks.
 *
 * @param context - Parse context.
 * @param entries - OOXML package parts.
 */
const parseWord: (context: OfficeContext, entries: ReadonlyMap<string, Uint8Array>) => void = (
    context: OfficeContext,
    entries: ReadonlyMap<string, Uint8Array>,
): void => {
    const xml: string | undefined = zipText(entries, "word/document.xml");
    if (xml === (void 0)) {
        pushWarning(context, "word package has no word/document.xml");
        return;
    }
    const scan: XmlScan = scanXml(xml);
    const paragraphs: WordParagraph[] = [];
    let current: { texts: string[]; style: string; outline: string } | undefined;
    let nested: number = 0;
    for (let index: number = 0; index < scan.tags.length; index += 1) {
        const tag: XmlTag = scan.tags[index];
        if (tag.local === "p" && !tag.closing) {
            if (tag.selfClosing) {
                continue;
            }
            if (current === (void 0)) {
                current = { texts: [], style: "", outline: "" };
            } else {
                nested += 1;
            }
            continue;
        }
        if (tag.local === "p" && tag.closing) {
            if (current === (void 0)) {
                continue;
            }
            if (nested > 0) {
                nested -= 1;
                continue;
            }
            paragraphs.push({ text: current.texts.join(""), style: current.style, outline: current.outline });
            current = undefined;
            continue;
        }
        if (tag.local === "bookmarkStart" && !tag.closing) {
            const bookmark: string = xmlAttr(tag, "w:name");
            if (bookmark.length > 0 && bookmark !== "_GoBack") {
                addExport(context, bookmark);
                addReference(context, { kind: "bookmark", from: context.document.path, target: bookmark, detail: "bookmark" });
            }
            continue;
        }
        if (current === (void 0)) {
            continue;
        }
        if (tag.local === "t" && !tag.closing) {
            const text: string = xmlInnerText(xml, scan, index);
            if (text.length > 0) {
                current.texts.push(text);
            }
        } else if (tag.local === "pStyle" && !tag.closing) {
            current.style = xmlAttr(tag, "w:val");
        } else if (tag.local === "outlineLvl" && !tag.closing) {
            current.outline = xmlAttr(tag, "w:val");
        } else if (tag.local === "hyperlink" && !tag.closing) {
            const anchor: string = xmlAttr(tag, "w:anchor");
            if (anchor.length > 0) {
                addReference(context, { kind: "bookmark", from: context.document.path, target: `#${anchor}`, detail: "internal bookmark" });
            }
        }
    }
    if (current !== (void 0)) {
        paragraphs.push({ text: current.texts.join(""), style: current.style, outline: current.outline });
    }
    interface HeadingFrame {
        readonly level: number;
        readonly section: OfficeSection;
    }
    const headingStack: HeadingFrame[] = [];
    for (let index: number = 0; index < paragraphs.length; index += 1) {
        const paragraph: WordParagraph = paragraphs[index];
        const text: string = cleanLabel(paragraph.text, "");
        if (text.length === 0) {
            continue;
        }
        const level: number = wordHeadingLevel(paragraph.style, paragraph.outline);
        if (level > 0) {
            while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
                headingStack.pop();
            }
            const parent: HeadingFrame | undefined = headingStack[headingStack.length - 1];
            const section: OfficeSection | undefined = appendSection(
                context,
                parent === (void 0) ? undefined : parent.section,
                "heading",
                text,
                parent === (void 0) ? level - 1 : parent.section.depth + 1,
            );
            if (section !== (void 0)) {
                headingStack.push({ level, section });
            }
        } else {
            const parent: HeadingFrame | undefined = headingStack[headingStack.length - 1];
            appendSection(context, parent === (void 0) ? undefined : parent.section, "paragraph", text, parent === (void 0) ? 0 : parent.section.depth + 1);
        }
    }
    const relationships: OfficeRelationship[] = readRelationships(entries, "word/document.xml");
    for (let index: number = 0; index < relationships.length; index += 1) {
        const relationship: OfficeRelationship = relationships[index];
        const type: string = relationship.type.toLowerCase();
        if (type.endsWith("/hyperlink")) {
            addReference(context, {
                kind: "hyperlink",
                from: context.document.path,
                target: relationship.target,
                detail: relationship.external ? "external hyperlink" : "internal hyperlink",
            });
        } else if (relationship.external) {
            addReference(context, { kind: "external-link", from: context.document.path, target: relationship.target, detail: "external relationship" });
        } else if (
            type.endsWith("/image") ||
            type.endsWith("/oleobject") ||
            type.endsWith("/package") ||
            type.endsWith("/diagramdata") ||
            type.endsWith("/chart")
        ) {
            addReference(context, { kind: "embedded", from: context.document.path, target: relationship.target, detail: "embedded part" });
        } else {
            continue;
        }
        if (relationship.external) {
            addImport(context, relationship.target);
        }
    }
    pushWarning(context, "word: main document body only; headers, footnotes, comments, revisions, text boxes and embedded objects are not expanded");
};

/**
 * One sheet definition from `xl/workbook.xml`.
 */
interface ExcelSheetDefinition {
    readonly name: string;
    readonly relationId: string;
    readonly part: string;
}

/**
 * One defined name from `xl/workbook.xml`.
 */
interface ExcelDefinedName {
    readonly name: string;
    readonly localSheetIndex: number;
    readonly formula: string;
}

/**
 * One worksheet table definition.
 */
interface ExcelTableDefinition {
    readonly name: string;
    readonly displayName: string;
    readonly ref: string;
}

/**
 * Read shared strings. The cell content is not projected into the outline, but
 * reading the part validates it and records its size; a malformed shared-string
 * part is downgraded to a warning rather than failing the workbook.
 *
 * @param context - Parse context.
 * @param entries - OOXML package parts.
 * @returns Decoded shared strings.
 */
const readSharedStrings: (context: OfficeContext, entries: ReadonlyMap<string, Uint8Array>) => string[] = (
    context: OfficeContext,
    entries: ReadonlyMap<string, Uint8Array>,
): string[] => {
    const xml: string | undefined = zipText(entries, "xl/sharedStrings.xml");
    if (xml === (void 0)) {
        return [];
    }
    try {
        const scan: XmlScan = scanXml(xml);
        const strings: string[] = [];
        for (let index: number = 0; index < scan.tags.length && strings.length < 10000; index += 1) {
            const tag: XmlTag = scan.tags[index];
            if (tag.closing || tag.selfClosing || tag.local !== "si") {
                continue;
            }
            const close: number = scan.closeOf[index];
            const end: number = close < 0 ? scan.tags.length : close;
            let text: string = "";
            for (let child: number = index + 1; child < end; child += 1) {
                const childTag: XmlTag = scan.tags[child];
                if (!childTag.closing && childTag.local === "t") {
                    text += xmlInnerText(xml, scan, child);
                }
            }
            strings.push(text);
        }
        return strings;
    } catch (error: unknown) {
        pushWarning(context, `excel: shared strings ignored (${error instanceof Error ? error.message : "parse failure"})`);
        return [];
    }
};

/**
 * Read the workbook sheet list and defined names. Sheet order is the order of
 * `<sheet>` elements; each is resolved through the workbook relationships with
 * a name-based fallback for minimal packages.
 *
 * @param context - Parse context.
 * @param entries - OOXML package parts.
 * @returns Sheets and defined names.
 */
const readWorkbook: (context: OfficeContext, entries: ReadonlyMap<string, Uint8Array>) => { sheets: ExcelSheetDefinition[]; names: ExcelDefinedName[] } = (
    context: OfficeContext,
    entries: ReadonlyMap<string, Uint8Array>,
): { sheets: ExcelSheetDefinition[]; names: ExcelDefinedName[] } => {
    const xml: string | undefined = zipText(entries, "xl/workbook.xml");
    if (xml === (void 0)) {
        pushWarning(context, "excel package has no xl/workbook.xml");
        return { sheets: [], names: [] };
    }
    const scan: XmlScan = scanXml(xml);
    const relationships: Map<string, OfficeRelationship> = relationshipMap(readRelationships(entries, "xl/workbook.xml"));
    const sheets: ExcelSheetDefinition[] = [];
    const names: ExcelDefinedName[] = [];
    for (let index: number = 0; index < scan.tags.length; index += 1) {
        const tag: XmlTag = scan.tags[index];
        if (tag.closing) {
            continue;
        }
        if (tag.local === "sheet") {
            const name: string = cleanLabel(xmlAttr(tag, "name"), `Sheet ${sheets.length + 1}`);
            const relationId: string = xmlAttr(tag, "r:id");
            const relationship: OfficeRelationship | undefined = relationships.get(relationId);
            const fallback: string = `xl/worksheets/sheet${sheets.length + 1}.xml`;
            sheets.push({ name, relationId, part: relationship === (void 0) ? fallback : relationship.target });
        } else if (tag.local === "definedName") {
            const name: string = cleanLabel(xmlAttr(tag, "name"), "");
            if (name.length === 0) {
                continue;
            }
            const localRaw: string = xmlAttr(tag, "localSheetId");
            const localSheetIndex: number = localRaw.length === 0 ? -1 : Number.parseInt(localRaw, 10);
            names.push({ name, localSheetIndex: Number.isSafeInteger(localSheetIndex) ? localSheetIndex : -1, formula: xmlInnerText(xml, scan, index) });
        }
    }
    return { sheets, names };
};

/**
 * Replace double-quoted Excel string literals with spaces, preserving offsets
 * so reference positions in the original formula remain meaningful.
 *
 * @param formula - Formula text.
 * @returns Masked character array joined back into a string.
 */
const maskFormulaStrings: (formula: string) => string = (formula: string): string => {
    const chars: string[] = formula.split("");
    let index: number = 0;
    while (index < chars.length) {
        if (chars[index] !== '"') {
            index += 1;
            continue;
        }
        chars[index] = " ";
        index += 1;
        while (index < chars.length) {
            if (chars[index] === '"') {
                if (index + 1 < chars.length && chars[index + 1] === '"') {
                    chars[index] = " ";
                    chars[index + 1] = " ";
                    index += 2;
                    continue;
                }
                chars[index] = " ";
                index += 1;
                break;
            }
            chars[index] = " ";
            index += 1;
        }
    }
    return chars.join("");
};

/**
 * Blank a matched span so a later, less specific regex cannot report the same
 * token as a different reference kind.
 *
 * @param chars - Mutable character array.
 * @param start - Match start.
 * @param length - Match length.
 */
const maskSpan: (chars: string[], start: number, length: number) => void = (chars: string[], start: number, length: number): void => {
    for (let index: number = start; index < start + length && index < chars.length; index += 1) {
        chars[index] = " ";
    }
};

/**
 * Extract A1, Sheet!A1 and [n]Sheet!A1 references from one formula.
 *
 * External workbook references are resolved through the package's external
 * link parts when available; the unresolved `[n]` form is kept otherwise. Only
 * lexical references are reported: formulas are not evaluated, shared formulas
 * are not expanded and dynamic references are not inferred.
 *
 * @param context - Parse context.
 * @param formula - Cell formula without the leading `=`.
 * @param sheetName - Sheet that owns the cell.
 * @param address - Cell address such as `B4`.
 * @param externalTargets - External link index to target path.
 */
const addFormulaReferences: (
    context: OfficeContext,
    formula: string,
    sheetName: string,
    address: string,
    externalTargets: ReadonlyMap<number, string>,
) => void = (context: OfficeContext, formula: string, sheetName: string, address: string, externalTargets: ReadonlyMap<number, string>): void => {
    if (formula.length === 0) {
        return;
    }
    const masked: string = maskFormulaStrings(formula);
    const chars: string[] = masked.split("");
    const from: string = `${sheetName}!${address}`;
    const external: RegExp = /(?:'\[(\d+)\]([^']*)'|\[(\d+)\]([A-Za-z0-9_.]+))!(\$?[A-Z]{1,3}\$?[1-9]\d*)/g;
    let match: RegExpExecArray | null = external.exec(masked);
    while (match !== null) {
        const linkIndex: number = Number(match[1] ?? match[3]);
        const targetSheet: string = match[2] ?? match[4] ?? "";
        const targetAddress: string = match[5];
        const target: string = `[${linkIndex}]${targetSheet}!${targetAddress}`;
        addReference(context, { kind: "formula", from, target, detail: "external workbook reference" });
        const resolved: string | undefined = externalTargets.get(linkIndex);
        if (resolved !== (void 0)) {
            addImport(context, resolved);
        }
        maskSpan(chars, match.index, match[0].length);
        match = external.exec(masked);
    }
    const afterExternal: string = chars.join("");
    const sheetPattern: RegExp = /(?<![\w\]'])(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!(\$?[A-Z]{1,3}\$?[1-9]\d*)/g;
    let sheetMatch: RegExpExecArray | null = sheetPattern.exec(afterExternal);
    while (sheetMatch !== null) {
        const targetSheet: string = (sheetMatch[1] ?? sheetMatch[2] ?? "").replace(/''/g, "'");
        const targetAddress: string = sheetMatch[3];
        if (!targetSheet.startsWith("[")) {
            addReference(context, { kind: "formula", from, target: `${targetSheet}!${targetAddress}`, detail: "sheet reference" });
            maskSpan(chars, sheetMatch.index, sheetMatch[0].length);
        }
        sheetMatch = sheetPattern.exec(afterExternal);
    }
    const rest: string = chars.join("");
    const plain: RegExp = /(?<![A-Za-z0-9_.$])\$?[A-Z]{1,3}\$?[1-9]\d*(?![A-Za-z0-9_(])/g;
    let plainMatch: RegExpExecArray | null = plain.exec(rest);
    while (plainMatch !== null) {
        addReference(context, { kind: "formula", from, target: plainMatch[0], detail: "cell reference" });
        plainMatch = plain.exec(rest);
    }
};

/**
 * Read external-link targets. `xl/externalLinks/externalLinkN.xml` has a
 * relationships part whose external target is the linked workbook.
 *
 * @param entries - OOXML package parts.
 * @returns External link index to target.
 */
const readExternalTargets: (entries: ReadonlyMap<string, Uint8Array>) => Map<number, string> = (
    entries: ReadonlyMap<string, Uint8Array>,
): Map<number, string> => {
    const targets: Map<number, string> = new Map<number, string>();
    const names: string[] = Array.from(entries.keys()).filter((name: string): boolean => /^xl\/externalLinks\/externalLink[0-9]+\.xml$/.test(name));
    names.sort((left: string, right: string): number => {
        const leftNumber: number = Number(/externalLink([0-9]+)\.xml$/.exec(left)?.[1] ?? 0);
        const rightNumber: number = Number(/externalLink([0-9]+)\.xml$/.exec(right)?.[1] ?? 0);
        return leftNumber - rightNumber;
    });
    for (let index: number = 0; index < names.length; index += 1) {
        const name: string = names[index];
        const linkIndex: number = Number(/externalLink([0-9]+)\.xml$/.exec(name)?.[1] ?? names.length + 1);
        const relationships: OfficeRelationship[] = readRelationships(entries, name);
        const external: OfficeRelationship | undefined = relationships.find((relationship: OfficeRelationship): boolean => relationship.external);
        if (external !== (void 0)) {
            targets.set(linkIndex, external.target);
        }
    }
    return targets;
};

/**
 * Read worksheet tables through the worksheet relationships.
 *
 * @param entries - OOXML package parts.
 * @param sheetPart - Worksheet part.
 * @returns Table definitions in relationship order.
 */
const readSheetTables: (entries: ReadonlyMap<string, Uint8Array>, sheetPart: string) => ExcelTableDefinition[] = (
    entries: ReadonlyMap<string, Uint8Array>,
    sheetPart: string,
): ExcelTableDefinition[] => {
    const relationships: OfficeRelationship[] = readRelationships(entries, sheetPart);
    const tables: ExcelTableDefinition[] = [];
    for (let index: number = 0; index < relationships.length; index += 1) {
        const relationship: OfficeRelationship = relationships[index];
        if (!relationship.type.toLowerCase().endsWith("/table") || relationship.external) {
            continue;
        }
        const xml: string | undefined = zipText(entries, relationship.target);
        if (xml === (void 0)) {
            continue;
        }
        try {
            const scan: XmlScan = scanXml(xml);
            for (let tagIndex: number = 0; tagIndex < scan.tags.length; tagIndex += 1) {
                const tag: XmlTag = scan.tags[tagIndex];
                if (tag.closing || tag.local !== "table") {
                    continue;
                }
                const name: string = cleanLabel(xmlAttr(tag, "name"), "");
                const displayName: string = cleanLabel(xmlAttr(tag, "displayName"), name);
                const ref: string = cleanLabel(xmlAttr(tag, "ref"), "");
                if (displayName.length > 0) {
                    tables.push({ name, displayName, ref });
                }
                break;
            }
        } catch {
            continue;
        }
    }
    return tables;
};

/**
 * Parse one worksheet: formulas and hyperlinks. Cell values and shared strings
 * are deliberately not emitted as outline nodes; the sheet/table/named-range
 * hierarchy is the structural contract for this format.
 *
 * @param context - Parse context.
 * @param entries - OOXML package parts.
 * @param sheet - Sheet definition.
 * @param externalTargets - External link index to target.
 * @returns Whether the worksheet part was readable.
 */
const parseWorksheet: (
    context: OfficeContext,
    entries: ReadonlyMap<string, Uint8Array>,
    sheet: ExcelSheetDefinition,
    externalTargets: ReadonlyMap<number, string>,
) => boolean = (
    context: OfficeContext,
    entries: ReadonlyMap<string, Uint8Array>,
    sheet: ExcelSheetDefinition,
    externalTargets: ReadonlyMap<number, string>,
): boolean => {
    const xml: string | undefined = zipText(entries, sheet.part);
    if (xml === (void 0)) {
        pushWarning(context, `excel: worksheet part ${sheet.part} is missing`);
        return false;
    }
    const scan: XmlScan = scanXml(xml);
    const relationships: Map<string, OfficeRelationship> = relationshipMap(readRelationships(entries, sheet.part));
    for (let index: number = 0; index < scan.tags.length; index += 1) {
        const tag: XmlTag = scan.tags[index];
        if (tag.closing) {
            continue;
        }
        if (tag.local === "c") {
            const address: string = xmlAttr(tag, "r");
            if (!/^[A-Z]{1,3}[1-9][0-9]*$/.test(address)) {
                continue;
            }
            const formula: string = xmlChildText(xml, scan, index, "f");
            if (formula.length > 0) {
                addFormulaReferences(context, formula, sheet.name, address, externalTargets);
            }
        } else if (tag.local === "hyperlink") {
            const relationshipId: string = xmlAttr(tag, "r:id");
            const location: string = xmlAttr(tag, "location");
            const relationship: OfficeRelationship | undefined = relationships.get(relationshipId);
            if (relationship !== (void 0)) {
                addReference(context, {
                    kind: "hyperlink",
                    from: `${sheet.name}!${xmlAttr(tag, "ref")}`,
                    target: relationship.target,
                    detail: relationship.external ? "external hyperlink" : "internal hyperlink",
                });
                if (relationship.external) {
                    addImport(context, relationship.target);
                }
            } else if (location.length > 0) {
                addReference(context, {
                    kind: "hyperlink",
                    from: `${sheet.name}!${xmlAttr(tag, "ref")}`,
                    target: `#${location}`,
                    detail: "internal hyperlink",
                });
            }
        }
    }
    return true;
};

/**
 * Parse an OOXML spreadsheet into sheet sections with table and named-range
 * children.
 *
 * @param context - Parse context.
 * @param entries - OOXML package parts.
 */
const parseExcel: (context: OfficeContext, entries: ReadonlyMap<string, Uint8Array>) => void = (
    context: OfficeContext,
    entries: ReadonlyMap<string, Uint8Array>,
): void => {
    const workbook: { sheets: ExcelSheetDefinition[]; names: ExcelDefinedName[] } = readWorkbook(context, entries);
    const sharedStrings: string[] = readSharedStrings(context, entries);
    const externalTargets: Map<number, string> = readExternalTargets(entries);
    for (let index: number = 0; index < externalTargets.size; index += 1) {
        const entry: [number, string] | undefined = Array.from(externalTargets.entries())[index];
        if (entry !== (void 0)) {
            addReference(context, { kind: "external-link", from: context.document.path, target: entry[1], detail: `external workbook [${entry[0]}]` });
            addImport(context, entry[1]);
        }
    }
    if (workbook.sheets.length === 0) {
        pushWarning(context, "excel: workbook defines no sheets");
    }
    for (let index: number = 0; index < workbook.sheets.length; index += 1) {
        const sheet: ExcelSheetDefinition = workbook.sheets[index];
        const sheetSection: OfficeSection | undefined = appendSection(context, undefined, "sheet", sheet.name, 0);
        try {
            parseWorksheet(context, entries, sheet, externalTargets);
        } catch (error: unknown) {
            pushWarning(context, `excel: sheet ${sheet.name} could not be parsed (${error instanceof Error ? error.message : "parse failure"})`);
        }
        const tables: ExcelTableDefinition[] = readSheetTables(entries, sheet.part);
        for (let tableIndex: number = 0; tableIndex < tables.length; tableIndex += 1) {
            const table: ExcelTableDefinition = tables[tableIndex];
            if (sheetSection !== (void 0)) {
                appendSection(context, sheetSection, "table", table.displayName, 1);
            }
            addExport(context, table.displayName);
        }
        for (let nameIndex: number = 0; nameIndex < workbook.names.length; nameIndex += 1) {
            const defined: ExcelDefinedName = workbook.names[nameIndex];
            if (defined.localSheetIndex !== index) {
                continue;
            }
            if (sheetSection !== (void 0)) {
                appendSection(context, sheetSection, "section", defined.name, 1);
            }
            addExport(context, defined.name);
            addReference(context, { kind: "named-range", from: context.document.path, target: defined.name, detail: defined.formula });
        }
    }
    const globalNames: ExcelDefinedName[] = workbook.names.filter((name: ExcelDefinedName): boolean => name.localSheetIndex < 0);
    if (globalNames.length > 0) {
        const namedSection: OfficeSection | undefined = appendSection(context, undefined, "section", "Named ranges", 0);
        for (let index: number = 0; index < globalNames.length; index += 1) {
            const defined: ExcelDefinedName = globalNames[index];
            if (namedSection !== (void 0)) {
                appendSection(context, namedSection, "section", defined.name, 1);
            }
            addExport(context, defined.name);
            addReference(context, { kind: "named-range", from: context.document.path, target: defined.name, detail: defined.formula });
        }
    }
    setMetadata(context, "excel.sheets", String(workbook.sheets.length));
    setMetadata(context, "excel.definedNames", String(workbook.names.length));
    setMetadata(context, "excel.sharedStrings", String(sharedStrings.length));
    pushWarning(
        context,
        "excel: formulas are not evaluated; cell values remain cached; shared/dynamic/external references beyond literal A1 syntax are not expanded",
    );
};

/**
 * One PowerPoint slide reference from `ppt/presentation.xml`.
 */
interface PowerPointSlide {
    readonly relationId: string;
    readonly part: string;
}

/**
 * Read the slide order through presentation relationships, with a numeric
 * part-name fallback for packages that omit the relationship part.
 *
 * @param entries - OOXML package parts.
 * @returns Slides in presentation order.
 */
const readSlides: (entries: ReadonlyMap<string, Uint8Array>) => PowerPointSlide[] = (entries: ReadonlyMap<string, Uint8Array>): PowerPointSlide[] => {
    const xml: string | undefined = zipText(entries, "ppt/presentation.xml");
    const relationships: Map<string, OfficeRelationship> = relationshipMap(readRelationships(entries, "ppt/presentation.xml"));
    const slides: PowerPointSlide[] = [];
    if (xml !== (void 0)) {
        const scan: XmlScan = scanXml(xml);
        for (let index: number = 0; index < scan.tags.length; index += 1) {
            const tag: XmlTag = scan.tags[index];
            if (tag.closing || tag.local !== "sldId") {
                continue;
            }
            const relationId: string = xmlAttr(tag, "r:id");
            const relationship: OfficeRelationship | undefined = relationships.get(relationId);
            if (relationship !== (void 0)) {
                slides.push({ relationId, part: relationship.target });
            }
        }
    }
    if (slides.length === 0) {
        const names: string[] = Array.from(entries.keys()).filter((name: string): boolean => /^ppt\/slides\/slide[0-9]+\.xml$/.test(name));
        names.sort((left: string, right: string): number => {
            const leftNumber: number = Number(/slide([0-9]+)\.xml$/.exec(left)?.[1] ?? 0);
            const rightNumber: number = Number(/slide([0-9]+)\.xml$/.exec(right)?.[1] ?? 0);
            return leftNumber - rightNumber;
        });
        for (let index: number = 0; index < names.length; index += 1) {
            slides.push({ relationId: "", part: names[index] });
        }
    }
    return slides;
};

/**
 * One scanned PowerPoint shape: whether it is a title placeholder and the text
 * paragraphs it contains.
 */
interface PowerPointShape {
    readonly title: boolean;
    readonly paragraphs: string[];
}

/**
 * Extract slide text, title placeholders and slide relationships.
 *
 * @param context - Parse context.
 * @param entries - OOXML package parts.
 * @param slide - Slide part.
 * @param ordinal - One-based slide number.
 * @returns Nothing.
 */
const parseSlide: (context: OfficeContext, entries: ReadonlyMap<string, Uint8Array>, slide: PowerPointSlide, ordinal: number) => void = (
    context: OfficeContext,
    entries: ReadonlyMap<string, Uint8Array>,
    slide: PowerPointSlide,
    ordinal: number,
): void => {
    const xml: string | undefined = zipText(entries, slide.part);
    if (xml === (void 0)) {
        pushWarning(context, `powerpoint: slide part ${slide.part} is missing`);
        appendSection(context, undefined, "slide", `Slide ${ordinal}`, 0);
        return;
    }
    const scan: XmlScan = scanXml(xml);
    const shapes: PowerPointShape[] = [];
    const paragraphs: string[] = [];
    let shape: { title: boolean; paragraphs: string[] } | undefined;
    let paragraph: string[] | undefined;
    for (let index: number = 0; index < scan.tags.length; index += 1) {
        const tag: XmlTag = scan.tags[index];
        if (tag.local === "sp") {
            if (tag.closing) {
                if (shape !== (void 0)) {
                    shapes.push({ title: shape.title, paragraphs: [...shape.paragraphs] });
                }
                shape = undefined;
                paragraph = undefined;
            } else if (!tag.selfClosing) {
                shape = { title: false, paragraphs: [] };
            }
            continue;
        }
        if (shape !== (void 0) && tag.local === "ph" && !tag.closing) {
            const placeholder: string = xmlAttr(tag, "type");
            if (placeholder === "title" || placeholder === "ctrTitle") {
                shape.title = true;
            }
        }
        if (tag.local === "p" && !tag.name.startsWith("p:") && !tag.name.startsWith("p14:")) {
            if (tag.closing) {
                if (paragraph !== (void 0)) {
                    const text: string = cleanLabel(paragraph.join(""), "");
                    if (text.length > 0) {
                        paragraphs.push(text);
                        if (shape !== (void 0)) {
                            shape.paragraphs.push(text);
                        }
                    }
                    paragraph = undefined;
                }
            } else if (paragraph === (void 0) && !tag.selfClosing) {
                paragraph = [];
            }
            continue;
        }
        if (paragraph !== (void 0) && tag.local === "t" && !tag.closing && !tag.name.startsWith("p:")) {
            const text: string = xmlInnerText(xml, scan, index);
            if (text.length > 0) {
                paragraph.push(text);
            }
        }
    }
    if (paragraph !== (void 0)) {
        const text: string = cleanLabel(paragraph.join(""), "");
        if (text.length > 0) {
            paragraphs.push(text);
        }
    }
    let title: string = "";
    for (let index: number = 0; index < shapes.length; index += 1) {
        if (shapes[index].title && shapes[index].paragraphs.length > 0) {
            title = shapes[index].paragraphs.join(" ");
            break;
        }
    }
    const slideSection: OfficeSection | undefined = appendSection(context, undefined, "slide", title.length > 0 ? title : `Slide ${ordinal}`, 0);
    if (slideSection !== (void 0)) {
        if (title.length > 0) {
            appendSection(context, slideSection, "heading", title, 1);
        }
        for (let index: number = 0; index < paragraphs.length; index += 1) {
            if (title.length > 0 && paragraphs[index] === title) {
                continue;
            }
            appendSection(context, slideSection, "paragraph", paragraphs[index], 1);
        }
    }
    const relationships: OfficeRelationship[] = readRelationships(entries, slide.part);
    for (let index: number = 0; index < relationships.length; index += 1) {
        const relationship: OfficeRelationship = relationships[index];
        const type: string = relationship.type.toLowerCase();
        if (type.endsWith("/hyperlink")) {
            addReference(context, {
                kind: "hyperlink",
                from: context.document.path,
                target: relationship.target,
                detail: relationship.external ? "external hyperlink" : "internal hyperlink",
            });
        } else if (type.endsWith("/oleobject") || type.endsWith("/package") || type.endsWith("/embedded")) {
            addReference(context, { kind: "embedded", from: context.document.path, target: relationship.target, detail: "embedded object" });
        } else {
            continue;
        }
        if (relationship.external) {
            addImport(context, relationship.target);
        }
    }
};

/**
 * Parse an OOXML presentation.
 *
 * @param context - Parse context.
 * @param entries - OOXML package parts.
 */
const parsePowerPoint: (context: OfficeContext, entries: ReadonlyMap<string, Uint8Array>) => void = (
    context: OfficeContext,
    entries: ReadonlyMap<string, Uint8Array>,
): void => {
    const slides: PowerPointSlide[] = readSlides(entries);
    if (slides.length === 0) {
        pushWarning(context, "powerpoint: presentation contains no slides");
    }
    for (let index: number = 0; index < slides.length; index += 1) {
        const fallbackNumber: number = Number(/slide([0-9]+)\.xml$/.exec(slides[index].part)?.[1] ?? 0);
        const ordinal: number = slides[index].relationId.length === 0 && Number.isSafeInteger(fallbackNumber) && fallbackNumber > 0 ? fallbackNumber : index + 1;
        try {
            parseSlide(context, entries, slides[index], ordinal);
        } catch (error: unknown) {
            pushWarning(context, `powerpoint: slide ${ordinal} could not be parsed (${error instanceof Error ? error.message : "parse failure"})`);
            appendSection(context, undefined, "slide", `Slide ${ordinal}`, 0);
        }
    }
    setMetadata(context, "powerpoint.slides", String(slides.length));
    pushWarning(context, "powerpoint: slide order and text placeholders only; layouts, masters, notes, charts, SmartArt and images are not expanded");
};

/**
 * One printable text fragment with its source offset, used to preserve
 * approximate document order when fragments from several encodings are merged.
 */
interface TextFragment {
    readonly text: string;
    readonly offset: number;
}

/**
 * Whether a UTF-16 code unit can be part of readable text. Surrogates are
 * excluded because the scanner works on individual code units; unpaired
 * surrogates are a strong signal of binary data.
 *
 * @param code - UTF-16 code unit.
 * @returns Whether the unit is printable.
 */
const isPrintableCodeUnit: (code: number) => boolean = (code: number): boolean => {
    if (code === 0x09) {
        return true;
    }
    if (code < 0x20 || code === 0x7f) {
        return false;
    }
    if (code >= 0xd800 && code <= 0xdfff) {
        return false;
    }
    if (code === 0xfeff || code === 0xfffe || code === 0xffff) {
        return false;
    }
    return true;
};

/**
 * Count Unicode letters without constructing a code-point array.
 *
 * @param text - Candidate text.
 * @returns Letter count.
 */
const letterCount: (text: string) => number = (text: string): number => {
    const matches: RegExpMatchArray | null = text.match(/\p{L}/gu);
    return matches === null ? 0 : matches.length;
};

/**
 * Detect ASCII bytes that were misread as UTF-16LE. When every code unit has
 * printable ASCII in both byte lanes, the "text" is an ASCII run viewed with
 * the wrong endianness (for example a Jet header), not real CJK text. Rejecting
 * this shape removes the biggest false-positive class from whole-file scans
 * without dropping legitimate UTF-16LE or CJK content.
 *
 * @param text - Candidate fragment.
 * @returns Whether every code unit looks like two printable ASCII bytes.
 */
const looksByteSwappedAscii: (text: string) => boolean = (text: string): boolean => {
    const chars: string[] = Array.from(text);
    if (chars.length < 4) {
        return false;
    }
    let swapped: number = 0;
    for (let index: number = 0; index < chars.length; index += 1) {
        const code: number | undefined = chars[index].codePointAt(0);
        if (code === (void 0) || code > 0xffff) {
            return false;
        }
        const high: number = code >>> 8;
        const low: number = code & 0xff;
        if (high >= 0x20 && high <= 0x7e && low >= 0x20 && low <= 0x7e) {
            swapped += 1;
        }
    }
    return swapped === chars.length;
};

/**
 * Whether a fragment is likely to be human-readable prose or a name rather
 * than binary noise. The threshold favours precision: legacy formats contain
 * many short ASCII runs inside structures, and false paragraphs are worse than
 * a missed line.
 *
 * @param text - Normalized fragment.
 * @returns Whether to keep it.
 */
const isMeaningfulFragment: (text: string) => boolean = (text: string): boolean => {
    if (text.length < 3) {
        return false;
    }
    if (looksByteSwappedAscii(text)) {
        return false;
    }
    const visible: number = text.replace(/\s/g, "").length;
    if (visible < 3) {
        return false;
    }
    const letters: number = letterCount(text);
    if (letters < 2 || letters / visible < 0.35) {
        return false;
    }
    const lower: string = text.toLowerCase();
    if (
        lower === "root entry" ||
        lower === "compobj" ||
        lower === "summaryinformation" ||
        lower === "documentsummaryinformation" ||
        lower.startsWith("standard jet db") ||
        lower.startsWith("standard ace db") ||
        lower.startsWith("microsoft ")
    ) {
        return false;
    }
    return true;
};

/**
 * Scan UTF-16LE runs at one alignment.
 *
 * @param bytes - Stream bytes.
 * @param parity - Starting byte offset (0 or 1).
 * @param sink - Collected fragments.
 * @returns Nothing; fragments are appended to `sink`.
 */
const scanUtf16: (bytes: Uint8Array, parity: number, sink: TextFragment[]) => void = (bytes: Uint8Array, parity: number, sink: TextFragment[]): void => {
    let runStart: number = -1;
    let run: string = "";
    const flush: () => void = (): void => {
        if (run.length >= 3) {
            sink.push({ text: run, offset: runStart });
        }
        runStart = -1;
        run = "";
    };
    for (let index: number = parity; index + 1 < bytes.length; index += 2) {
        if (sink.length >= MaxRawFragments) {
            flush();
            return;
        }
        const code: number = bytes[index] | (bytes[index + 1] << 8);
        if (isPrintableCodeUnit(code)) {
            if (runStart < 0) {
                runStart = index;
            }
            run += String.fromCharCode(code);
        } else {
            flush();
        }
    }
    flush();
};

/**
 * Scan printable ASCII runs.
 *
 * @param bytes - Stream bytes.
 * @param sink - Collected fragments.
 * @returns Nothing; fragments are appended to `sink`.
 */
const scanAscii: (bytes: Uint8Array, sink: TextFragment[]) => void = (bytes: Uint8Array, sink: TextFragment[]): void => {
    let runStart: number = -1;
    let run: string = "";
    const flush: () => void = (): void => {
        if (run.length >= 3) {
            sink.push({ text: run, offset: runStart });
        }
        runStart = -1;
        run = "";
    };
    for (let index: number = 0; index < bytes.length; index += 1) {
        if (sink.length >= MaxRawFragments) {
            flush();
            return;
        }
        const code: number = bytes[index];
        if (code >= 0x20 && code <= 0x7e) {
            if (runStart < 0) {
                runStart = index;
            }
            run += String.fromCharCode(code);
        } else {
            flush();
        }
    }
    flush();
};

/**
 * Recover printable text from a binary stream. UTF-16LE is tried at both byte
 * alignments, then ASCII; fragments are ordered by their source offset and
 * deduplicated after normalization. The 500-fragment ceiling is the
 * "do not turn a binary file into a wall of noise" bound.
 *
 * @param bytes - Stream bytes.
 * @returns Ordered fragments and whether raw scanning hit its own cap.
 */
const extractTextFragments: (bytes: Uint8Array) => { fragments: TextFragment[]; truncated: boolean } = (
    bytes: Uint8Array,
): { fragments: TextFragment[]; truncated: boolean } => {
    const raw: TextFragment[] = [];
    scanUtf16(bytes, 0, raw);
    /**
     * The odd alignment is only a fallback. Scanning it unconditionally turns
     * every UTF-16LE string into a second, byte-swapped "CJK" duplicate that
     * passes the letter-ratio filter; that is binary noise, not document text.
     */
    if (raw.length === 0) {
        scanUtf16(bytes, 1, raw);
    }
    if (raw.length < MaxRawFragments) {
        scanAscii(bytes, raw);
    }
    const truncated: boolean = raw.length >= MaxRawFragments;
    raw.sort((left: TextFragment, right: TextFragment): number => left.offset - right.offset);
    const fragments: TextFragment[] = [];
    const seen: Set<string> = new Set<string>();
    for (let index: number = 0; index < raw.length && fragments.length < MaxTextFragments; index += 1) {
        const text: string = raw[index].text.replace(/\s+/g, " ").trim().slice(0, 300);
        if (!isMeaningfulFragment(text) || seen.has(text)) {
            continue;
        }
        seen.add(text);
        fragments.push({ text, offset: raw[index].offset });
    }
    return { fragments, truncated };
};

/**
 * Recover text from named streams, falling back to every stream when none of
 * the preferred names exist. Total scanned bytes are bounded independently of
 * the CFB stream limit.
 *
 * @param streams - Stream map from `readCfb`.
 * @param preferred - Stream names to try first.
 * @returns Ordered fragments and whether scanning was truncated.
 */
const streamText: (streams: ReadonlyMap<string, Uint8Array>, preferred: readonly string[]) => { fragments: TextFragment[]; truncated: boolean } = (
    streams: ReadonlyMap<string, Uint8Array>,
    preferred: readonly string[],
): { fragments: TextFragment[]; truncated: boolean } => {
    const selected: Uint8Array[] = [];
    for (let index: number = 0; index < preferred.length; index += 1) {
        const stream: Uint8Array | undefined = streams.get(preferred[index]);
        if (stream !== (void 0)) {
            selected.push(stream);
        }
    }
    if (selected.length === 0) {
        streams.forEach((stream: Uint8Array): void => {
            selected.push(stream);
        });
    }
    const fragments: TextFragment[] = [];
    let scanned: number = 0;
    let truncated: boolean = false;
    for (let index: number = 0; index < selected.length; index += 1) {
        const stream: Uint8Array = selected[index];
        if (scanned >= MaxTextScanBytes) {
            truncated = true;
            break;
        }
        const allowed: Uint8Array = stream.length > MaxTextScanBytes - scanned ? stream.subarray(0, MaxTextScanBytes - scanned) : stream;
        scanned += allowed.length;
        const extracted: { fragments: TextFragment[]; truncated: boolean } = extractTextFragments(allowed);
        if (extracted.truncated) {
            truncated = true;
        }
        for (let fragmentIndex: number = 0; fragmentIndex < extracted.fragments.length && fragments.length < MaxTextFragments; fragmentIndex += 1) {
            const fragment: TextFragment = extracted.fragments[fragmentIndex];
            if (!fragments.some((candidate: TextFragment): boolean => candidate.text === fragment.text)) {
                fragments.push(fragment);
            }
        }
    }
    return { fragments, truncated };
};

/**
 * Add URL references recovered from legacy text. A URL is the one structured
 * relationship that survives text extraction reliably; everything else in a
 * legacy binary is reported as heuristic.
 *
 * @param context - Parse context.
 * @param fragments - Recovered fragments.
 */
const addUrlReferences: (context: OfficeContext, fragments: readonly TextFragment[]) => void = (
    context: OfficeContext,
    fragments: readonly TextFragment[],
): void => {
    const pattern: RegExp = /https?:\/\/[^\s"'<>)\]]+/g;
    for (let index: number = 0; index < fragments.length; index += 1) {
        let match: RegExpExecArray | null = pattern.exec(fragments[index].text);
        while (match !== null) {
            addReference(context, { kind: "hyperlink", from: context.document.path, target: match[0], detail: "legacy hyperlink" });
            addImport(context, match[0]);
            match = pattern.exec(fragments[index].text);
        }
    }
};

/**
 * Build one text-oriented section with paragraph children. A section is only
 * created when there is at least one printable fragment: an empty container or
 * a stream with no recoverable text must not look like a parsed document
 * section.
 *
 * @param context - Parse context.
 * @param label - Section label.
 * @param fragments - Paragraph fragments.
 * @returns The created section, or `undefined` when there is no text or the
 * section budget is exhausted.
 */
const appendTextSection: (context: OfficeContext, label: string, fragments: readonly TextFragment[]) => OfficeSection | undefined = (
    context: OfficeContext,
    label: string,
    fragments: readonly TextFragment[],
): OfficeSection | undefined => {
    if (fragments.length === 0) {
        pushWarning(context, `${label}: no printable text recovered`);
        return undefined;
    }
    const section: OfficeSection | undefined = appendSection(context, undefined, "section", label, 0);
    if (section === (void 0)) {
        return undefined;
    }
    for (let index: number = 0; index < fragments.length; index += 1) {
        appendSection(context, section, "paragraph", fragments[index].text, 1);
    }
    return section;
};

/**
 * Read BIFF `BOUNDSHEET` records (0x0085) from an Excel workbook stream. Sheet
 * names are the only Excel structure the legacy reader claims; cells and
 * formulas are not decoded.
 *
 * @param stream - Workbook or Book stream.
 * @returns Sheet names in workbook order.
 */
const biffSheetNames: (stream: Uint8Array) => string[] = (stream: Uint8Array): string[] => {
    const names: string[] = [];
    const seen: Set<string> = new Set<string>();
    if (stream.length < 4) {
        return names;
    }
    const view: DataView = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    let offset: number = 0;
    let records: number = 0;
    while (offset + 4 <= stream.length && records < 20000) {
        const type: number = view.getUint16(offset, true);
        const length: number = view.getUint16(offset + 2, true);
        const dataStart: number = offset + 4;
        if (dataStart + length > stream.length) {
            break;
        }
        if (type === 0x0085 && length >= 8) {
            const count: number = stream[dataStart + 6];
            const flags: number = stream[dataStart + 7];
            if (count > 0 && count <= 255) {
                const nameStart: number = dataStart + 8;
                const wide: boolean = (flags & 0x01) !== 0;
                const byteLength: number = wide ? count * 2 : count;
                if (nameStart + byteLength <= stream.length) {
                    let name: string = "";
                    for (let index: number = 0; index < count; index += 1) {
                        const code: number = wide ? stream[nameStart + index * 2] | (stream[nameStart + index * 2 + 1] << 8) : stream[nameStart + index];
                        if (code === 0 || code < 0x20) {
                            break;
                        }
                        name += String.fromCharCode(code);
                    }
                    const clean: string = cleanLabel(name, "");
                    if (clean.length > 0 && !seen.has(clean)) {
                        seen.add(clean);
                        names.push(clean);
                    }
                }
            }
        }
        offset = dataStart + length;
        records += 1;
    }
    return names;
};

/**
 * Parse a legacy OLE Office document. Text is recovered from the stream that
 * carries it in each format, then split into one section per meaningful
 * fragment. No binary field is interpreted as a document object unless the
 * format's own stream names identify it.
 *
 * @param context - Parse context.
 * @param streams - CFB streams.
 * @param kind - Document family.
 */
const parseLegacy: (context: OfficeContext, streams: ReadonlyMap<string, Uint8Array>, kind: OfficeKind) => void = (
    context: OfficeContext,
    streams: ReadonlyMap<string, Uint8Array>,
    kind: OfficeKind,
): void => {
    if (kind === "excel") {
        const workbook: Uint8Array | undefined = streams.get("Workbook") ?? streams.get("Book");
        const sheetNames: string[] = workbook === (void 0) ? [] : biffSheetNames(workbook);
        for (let index: number = 0; index < sheetNames.length; index += 1) {
            appendSection(context, undefined, "sheet", sheetNames[index], 0);
        }
        const text: { fragments: TextFragment[]; truncated: boolean } = streamText(streams, ["Workbook", "Book"]);
        appendTextSection(context, "Workbook text", text.fragments);
        addUrlReferences(context, text.fragments);
        if (text.truncated) {
            pushWarning(context, "excel: legacy text scan reached its fragment limit");
        }
        setMetadata(context, "excel.sheets", String(sheetNames.length));
        pushWarning(context, "excel: legacy BIFF text extraction is heuristic; cells, formulas and styles are not decoded");
        return;
    }
    if (kind === "word") {
        const text: { fragments: TextFragment[]; truncated: boolean } = streamText(streams, ["WordDocument"]);
        appendTextSection(context, "Word document", text.fragments);
        addUrlReferences(context, text.fragments);
        if (text.truncated) {
            pushWarning(context, "word: legacy text scan reached its fragment limit");
        }
        pushWarning(context, "word: legacy .doc text extraction is heuristic; tables, fields and formatting are not decoded");
        return;
    }
    if (kind === "powerpoint") {
        const text: { fragments: TextFragment[]; truncated: boolean } = streamText(streams, ["PowerPoint Document"]);
        appendTextSection(context, "PowerPoint presentation", text.fragments);
        addUrlReferences(context, text.fragments);
        if (text.truncated) {
            pushWarning(context, "powerpoint: legacy text scan reached its fragment limit");
        }
        pushWarning(context, "powerpoint: legacy .ppt text extraction is heuristic; slides, layouts and shapes are not decoded");
        return;
    }
    if (kind === "publisher") {
        const text: { fragments: TextFragment[]; truncated: boolean } = streamText(streams, ["Contents", "Quill", "QuillSub"]);
        appendTextSection(context, "Publisher document", text.fragments);
        addUrlReferences(context, text.fragments);
        if (text.truncated) {
            pushWarning(context, "publisher: legacy text scan reached its fragment limit");
        }
        pushWarning(context, "publisher: Publisher support is best-effort; text story order, pages, frames and layout are not decoded");
        return;
    }
    const text: { fragments: TextFragment[]; truncated: boolean } = streamText(streams, []);
    appendTextSection(context, "OLE streams", text.fragments);
    addUrlReferences(context, text.fragments);
    pushWarning(context, "ole: unrecognized document family; only printable text fragments were recovered");
};

/**
 * Access/Jet engine magic strings after the four-byte file header.
 */
const AccessMagic: readonly string[] = ["Standard Jet DB", "Standard ACE DB"];

/**
 * Detect a Jet/ACE database by its header. Access files are deliberately not
 * treated as CFB: `.mdb` and `.accdb` use a page-oriented format with this
 * signature at offset 4.
 *
 * @param bytes - Candidate file bytes.
 * @returns Engine name, or `undefined` when the header is not an Access header.
 */
const accessEngine: (bytes: Uint8Array) => string | undefined = (bytes: Uint8Array): string | undefined => {
    if (bytes.length < 24 || bytes[0] !== 0x00 || bytes[1] !== 0x01 || bytes[2] !== 0x00 || bytes[3] !== 0x00) {
        return undefined;
    }
    const magic: string = asciiAt(bytes, 4, 20);
    for (let index: number = 0; index < AccessMagic.length; index += 1) {
        if (magic.startsWith(AccessMagic[index])) {
            return AccessMagic[index];
        }
    }
    return undefined;
};

/**
 * Parse an Access database on a best-effort basis. There is no page parser
 * here, so catalog names are recovered from UTF-16LE identifier-shaped string
 * runs and classified only by a conventional prefix. The warning states that
 * limitation explicitly; no table schema or query SQL is claimed.
 *
 * @param context - Parse context.
 * @param bytes - Database bytes.
 * @param engine - Detected engine magic.
 */
const parseAccess: (context: OfficeContext, bytes: Uint8Array, engine: string) => void = (context: OfficeContext, bytes: Uint8Array, engine: string): void => {
    pushWarning(context, "access catalog best-effort: catalog names are recovered from string runs, not from table/page parsing");
    setMetadata(context, "access.engine", engine);
    /**
     * Skip the header and the first database page. Its ASCII engine magic and
     * fixed fields would otherwise be read as UTF-16LE and surface as catalog
     * candidates in an otherwise empty database.
     */
    const scanStart: number = Math.min(bytes.length, 4096);
    const scanEnd: number = Math.min(bytes.length, scanStart + MaxTextScanBytes);
    const scanned: { fragments: TextFragment[]; truncated: boolean } = extractTextFragments(bytes.subarray(scanStart, scanEnd));
    const reserved: readonly string[] = [
        "select",
        "from",
        "where",
        "table",
        "index",
        "primary",
        "foreign",
        "database",
        "access",
        "admin",
        "system",
        "standard",
        "create",
        "insert",
        "update",
        "delete",
        "query",
        "form",
        "report",
    ];
    const candidates: string[] = [];
    const seen: Set<string> = new Set<string>();
    for (let index: number = 0; index < scanned.fragments.length && candidates.length < 100; index += 1) {
        const name: string = scanned.fragments[index].text;
        if (!/^[\p{L}_][\p{L}\p{N}_ ]{1,62}$/u.test(name) || name.split(" ").length > 4) {
            continue;
        }
        const lower: string = name.toLowerCase();
        if (reserved.includes(lower) || lower.startsWith("msys") || lower.startsWith("~") || seen.has(lower)) {
            continue;
        }
        seen.add(lower);
        candidates.push(name);
    }
    if (candidates.length === 0) {
        pushWarning(context, "access: no catalog names could be recovered");
    } else {
        const catalog: OfficeSection | undefined = appendSection(context, undefined, "section", "Access catalog (best effort)", 0);
        for (let index: number = 0; index < candidates.length; index += 1) {
            const kind: OfficeSectionKind = /^(?:qry|q_)/i.test(candidates[index]) ? "query" : "table";
            if (catalog !== (void 0)) {
                appendSection(context, catalog, kind, candidates[index], 1);
            }
        }
    }
    setMetadata(context, "access.catalogCandidates", String(candidates.length));
    if (scanned.truncated) {
        pushWarning(context, "access: catalog scan reached its fragment limit");
    }
};

/**
 * Determine the OOXML family from package part names when the extension is
 * unknown or absent.
 *
 * @param entries - OOXML package parts.
 * @returns Best family guess.
 */
const kindFromParts: (entries: ReadonlyMap<string, Uint8Array>) => OfficeKind = (entries: ReadonlyMap<string, Uint8Array>): OfficeKind => {
    let word: boolean = false;
    let excel: boolean = false;
    let powerpoint: boolean = false;
    const names: readonly string[] = Array.from(entries.keys());
    for (let index: number = 0; index < names.length; index += 1) {
        if (names[index].startsWith("word/")) {
            word = true;
        } else if (names[index].startsWith("xl/")) {
            excel = true;
        } else if (names[index].startsWith("ppt/")) {
            powerpoint = true;
        }
    }
    if (word) {
        return "word";
    }
    if (excel) {
        return "excel";
    }
    if (powerpoint) {
        return "powerpoint";
    }
    return "unknown";
};

/**
 * Determine the legacy family from CFB stream names.
 *
 * @param streams - CFB streams.
 * @returns Best family guess.
 */
const kindFromStreams: (streams: ReadonlyMap<string, Uint8Array>) => OfficeKind = (streams: ReadonlyMap<string, Uint8Array>): OfficeKind => {
    if (streams.has("WordDocument")) {
        return "word";
    }
    if (streams.has("Workbook") || streams.has("Book")) {
        return "excel";
    }
    if (streams.has("PowerPoint Document")) {
        return "powerpoint";
    }
    if (streams.has("Contents") || streams.has("Quill") || streams.has("QuillSub")) {
        return "publisher";
    }
    return "unknown";
};

/**
 * Whether a byte sequence starts with a ZIP header.
 *
 * A package normally starts with a local-file header (`PK\x03\x04`), but an
 * empty archive starts with its end-of-central-directory record (`PK\x05\x06`)
 * and a spanned archive with the spanning marker (`PK\x07\x08`). All three are
 * valid ZIP starts, so all three are routed to the OOXML reader, which then
 * reports an empty package instead of "unrecognized container".
 *
 * @param bytes - Candidate bytes.
 * @returns Whether the ZIP magic is present.
 */
const hasZipMagic: (bytes: Uint8Array) => boolean = (bytes: Uint8Array): boolean =>
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06) || (bytes[2] === 0x07 && bytes[3] === 0x08));

/**
 * Whether a byte sequence starts with the CFB signature.
 *
 * @param bytes - Candidate bytes.
 * @returns Whether the CFB magic is present.
 */
const hasCfbMagic: (bytes: Uint8Array) => boolean = (bytes: Uint8Array): boolean =>
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1;

/**
 * Parse Office bytes that have already been read and validated by a caller.
 *
 * The container level is decided by magic, not extension: a `.docx` that is
 * really a CFB file is still treated as a CFB container, and a ZIP with an
 * unhelpful extension is sniffed from its parts. Extension only disambiguates
 * the document family inside a valid container.
 *
 * @param path - Root-relative path used in references and IDs.
 * @param bytes - Complete file bytes.
 * @returns Best-effort document.
 */
const parseOfficeBytes: (path: string, bytes: Uint8Array) => OfficeDocument = (path: string, bytes: Uint8Array): OfficeDocument => {
    const extensionKind: OfficeKind = kindFromPath(path);
    const format: OfficeFormat = hasZipMagic(bytes) ? "ooxml" : hasCfbMagic(bytes) || accessEngine(bytes) !== (void 0) ? "ole" : "unknown";
    const context: OfficeContext = createContext(path, extensionKind, format, bytes);
    try {
        if (format === "ooxml") {
            let entries: Map<string, Uint8Array> | undefined;
            try {
                entries = readZipEntries(bytes);
            } catch (error: unknown) {
                if (isFilesystemError(error) && error.code === "quota_exceeded") {
                    throw error;
                }
                pushWarning(context, `ooxml container rejected: ${error instanceof Error ? error.message : "parse failure"}`);
            }
            if (entries !== (void 0)) {
                const kind: OfficeKind = extensionKind === "unknown" ? kindFromParts(entries) : extensionKind;
                context.document.kind = kind;
                try {
                    readDocumentProperties(context, entries);
                } catch (error: unknown) {
                    pushWarning(context, `office properties ignored (${error instanceof Error ? error.message : "parse failure"})`);
                }
                try {
                    if (kind === "word") {
                        parseWord(context, entries);
                    } else if (kind === "excel") {
                        parseExcel(context, entries);
                    } else if (kind === "powerpoint") {
                        parsePowerPoint(context, entries);
                    } else {
                        pushWarning(context, "ooxml package does not contain word/, xl/ or ppt/ parts");
                    }
                } catch (error: unknown) {
                    pushWarning(context, `ooxml ${kind} structure ignored (${error instanceof Error ? error.message : "parse failure"})`);
                }
            } else {
                context.document.kind = extensionKind;
            }
        } else if (format === "ole") {
            const engine: string | undefined = accessEngine(bytes);
            if (engine !== (void 0)) {
                context.document.kind = "access";
                parseAccess(context, bytes, engine);
            } else {
                const cfb: { entries: CfbEntry[]; streams: Map<string, Uint8Array>; warnings: string[] } = readCfb(bytes);
                for (let index: number = 0; index < cfb.warnings.length; index += 1) {
                    pushWarning(context, cfb.warnings[index]);
                }
                const kind: OfficeKind = extensionKind === "unknown" ? kindFromStreams(cfb.streams) : extensionKind;
                context.document.kind = kind;
                if (cfb.streams.size === 0) {
                    pushWarning(context, "ole container has no readable streams");
                } else {
                    try {
                        parseLegacy(context, cfb.streams, kind);
                    } catch (error: unknown) {
                        pushWarning(context, `ole ${kind} structure ignored (${error instanceof Error ? error.message : "parse failure"})`);
                    }
                }
            }
        } else {
            context.document.kind = "unknown";
            pushWarning(context, "unrecognized office container; no structure was extracted");
        }
    } catch (error: unknown) {
        if (isFilesystemError(error)) {
            throw error;
        }
        pushWarning(context, `office parse stopped: ${error instanceof Error ? error.message : "unknown failure"}`);
    }
    if (context.truncated) {
        pushWarning(context, `office section limit ${MaxSections} reached; remaining structure was not parsed`);
    }
    return context.document;
};

/**
 * Parse one Office document, reading its bytes through the session sandbox.
 *
 * A file larger than 64 MiB is refused with `quota_exceeded` before it is read.
 * Path resolution, symlink checks and file-type checks are delegated to
 * `PathSandbox`, so this parser cannot read outside the session roots.
 *
 * @param sandbox - Session sandbox that owns path resolution.
 * @param path - Root-relative POSIX path.
 * @returns Best-effort document structure and warnings.
 */
export const parseOffice: (sandbox: PathSandbox, path: string) => OfficeDocument = (sandbox: PathSandbox, path: string): OfficeDocument => {
    const rooted: RootedPath = sandbox.resolve(path, "read");
    sandbox.revalidate(rooted);
    const stat: Stats = statOrFail(rooted.absolute);
    if (!stat.isFile()) {
        return fail("not_file");
    }
    if (stat.size > OfficeMaxDocumentBytes) {
        return fail("quota_exceeded");
    }
    sandbox.revalidate(rooted);
    const bytes: Uint8Array = readBytesOrFail(rooted.absolute);
    if (bytes.byteLength > OfficeMaxDocumentBytes) {
        return fail("quota_exceeded");
    }
    return parseOfficeBytes(rooted.relative, bytes);
};

/**
 * Map an Office section kind to the closest existing outline kind. The outline
 * vocabulary predates Office and has no `sheet`, `slide`, `table`, `query`,
 * `form` or `report` values, so those become `section` rather than inventing
 * enum members outside the shared type.
 *
 * @param kind - Office section kind.
 * @returns Outline kind.
 */
const outlineKindOf: (kind: OfficeSectionKind) => OutlineKind = (kind: OfficeSectionKind): OutlineKind => {
    if (kind === "heading") {
        return "heading";
    }
    if (kind === "paragraph") {
        return "paragraph";
    }
    return "section";
};

/**
 * Number of sections in one subtree, including the subtree root.
 *
 * @param section - Office section.
 * @returns Subtree section count.
 */
const countSections: (section: OfficeSection) => number = (section: OfficeSection): number => {
    let total: number = 1;
    for (let index: number = 0; index < section.children.length; index += 1) {
        total += countSections(section.children[index]);
    }
    return total;
};

/**
 * Highest document ordinal in one subtree. A parent's range ends at the last
 * ordinal of its deepest descendant, which keeps ranges nested and monotonic.
 *
 * @param section - Office section.
 * @returns Highest ordinal in the subtree.
 */
const lastSectionIndex: (section: OfficeSection) => number = (section: OfficeSection): number => {
    let last: number = section.index;
    for (let index: number = 0; index < section.children.length; index += 1) {
        last = Math.max(last, lastSectionIndex(section.children[index]));
    }
    return last;
};

/**
 * Build outline nodes from Office sections.
 *
 * Ranges are synthetic because Office formats expose neither text lines nor
 * part offsets. Two monotonic projections keep the tree usable:
 *
 * - `startLine`/`endLine` are the section's document ordinals: `index + 1` up
 *   to the highest ordinal in its subtree, so a parent covers its children and
 *   siblings never overlap;
 * - `startByte`/`endByte` project the same ordinal interval onto the container
 *   size, so the sections partition the file exactly once and a parent still
 *   covers its subtree.
 *
 * Both are explicitly approximate: they answer "where in document order", not
 * "at which OOXML part offset". The path is `"<file>#<section-id>"` and every
 * node is a symbol, not a file anchor.
 *
 * The raw-byte entry point enforces `OfficeMaxOutlineBytes` itself so a direct
 * caller sees `quota_exceeded` rather than handing a container to a text
 * charset detector (which would report `binary_file`). `buildOutline` applies
 * the same ceiling before it reads the file.
 *
 * @param input - Path and complete container bytes.
 * @returns Outline nodes in document order.
 */
export const officeOutlineParser: (input: { path: string; bytes: Uint8Array }) => OutlineNode[] = (input: {
    path: string;
    bytes: Uint8Array;
}): OutlineNode[] => {
    if (input.bytes.byteLength > OfficeMaxOutlineBytes) {
        return fail("quota_exceeded");
    }
    const document: OfficeDocument = parseOfficeBytes(input.path, input.bytes);
    const totalBytes: number = input.bytes.byteLength;
    let sectionCount: number = 0;
    for (let index: number = 0; index < document.sections.length; index += 1) {
        sectionCount += countSections(document.sections[index]);
    }
    const byteAt: (ordinal: number) => bigint = (ordinal: number): bigint =>
        sectionCount === 0 ? 0n : (BigInt(totalBytes) * BigInt(Math.max(0, Math.min(ordinal, sectionCount)))) / BigInt(sectionCount);
    const build: (section: OfficeSection) => OutlineNode = (section: OfficeSection): OutlineNode => {
        const last: number = lastSectionIndex(section);
        const children: OutlineNode[] = [];
        for (let index: number = 0; index < section.children.length; index += 1) {
            children.push(build(section.children[index]));
        }
        const node: OutlineNode = {
            isFile: false,
            isDirectory: false,
            path: `${input.path}#${section.id}`,
            type: outlineKindOf(section.kind),
            range: {
                startByte: byteAt(section.index),
                endByte: byteAt(last + 1),
                startLine: BigInt(section.index + 1),
                endLine: BigInt(last + 1),
            },
            label: section.label,
            depth: section.depth,
            children,
        };
        return node;
    };
    const nodes: OutlineNode[] = [];
    for (let index: number = 0; index < document.sections.length; index += 1) {
        nodes.push(build(document.sections[index]));
    }
    return nodes;
};

/**
 * Install the Office outline extractor into the shared strategy registry.
 * Idempotent: repeated calls leave the same parser registered.
 */
export const installOfficeOutlineParser: () => void = (): void => {
    if (!hasOfficeOutlineParser()) {
        registerOfficeOutlineParser(officeOutlineParser);
    }
};

/**
 * External targets of a parsed document, for dependency/import consumers.
 *
 * @param document - Parsed Office document.
 * @returns A copy of the import list.
 */
export const officeImports: (document: OfficeDocument) => string[] = (document: OfficeDocument): string[] => [...document.imports];

/**
 * Exported names of a parsed document, for export consumers.
 *
 * @param document - Parsed Office document.
 * @returns A copy of the export list.
 */
export const officeExports: (document: OfficeDocument) => string[] = (document: OfficeDocument): string[] => [...document.exports];

/**
 * Outbound references of a parsed document, for dependency consumers.
 *
 * @param document - Parsed Office document.
 * @returns A copy of the reference list.
 */
export const officeReferences: (document: OfficeDocument) => OfficeReference[] = (document: OfficeDocument): OfficeReference[] =>
    document.references.map((reference: OfficeReference): OfficeReference => ({ ...reference }));
