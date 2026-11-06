import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet, isString, useFrom } from "semantic-typescript";
import type { OutlineParserPort, ParsedOutlineNode } from "../outline.ts";
import { SourceText, freezeRange } from "../range.ts";
import type { LanguageDefinition } from "./types.ts";

/**
 * Read-only structural outline scanning for XML-family documents. This is a tolerant
 * tag-shape preview, not an XML processor: it never validates schemas, resolves
 * entities, reads DTD contents or follows external references.
 */

const STRUCTURAL_LOCAL_NAMES = new SynchronousUnorderedSet<string>([
    "catalog", "book", "part", "chapter", "section", "subsection", "article", "topic", "topicref", "map",
    "module", "package", "project", "target", "task", "item", "entry", "record", "table", "view", "field",
    "schema", "element", "complextype", "simpletype", "service", "port", "binding", "group", "folder", "file",
    "node", "resource",
]);

/** Priority order for the label attribute: the first present attribute wins. */
const LABEL_ATTRIBUTES: readonly string[] = Object.freeze(["id", "xml:id", "name", "key"]);
const LABEL_ATTRIBUTE_NAMES = new SynchronousUnorderedSet<string>(LABEL_ATTRIBUTES);
const SUMMARY_ATTRIBUTE_NAMES = new SynchronousUnorderedSet<string>(["id", "xml:id", "name", "key", "class", "type", "ref", "href"]);

const NAME_LIMIT = 120;
const SUMMARY_LIMIT = 240;

interface MutableNode {
    readonly id: string;
    readonly name: string;
    readonly summary: string;
    readonly start: number;
    end: number;
    readonly parentId?: string;
}

interface OpenElement {
    readonly qualified: string;
    readonly local: string;
    readonly ancestor?: string;
    readonly node?: MutableNode;
}

interface EndTag {
    readonly name: string;
    readonly end: number;
}

interface StartTag {
    readonly qualified: string;
    readonly local: string;
    readonly selfClosing: boolean;
    readonly end: number;
    readonly label: Optional<string>;
    readonly attributesSummary: string;
}

function isWhitespace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isNameStart(code: number): boolean {
    return code === 0x5f || code === 0x3a || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
        || (code >= 0x80 && !Number.isNaN(code));
}

function isNameChar(code: number): boolean {
    return isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2e || code === 0x2d || code === 0xb7;
}

function skipWhitespace(source: string, from: number): number {
    let cursor = from;
    while (cursor < source.length && isWhitespace(source.charCodeAt(cursor))) cursor += 1;
    return cursor;
}

/** Qualified name to its local part; display and structural matching ignore the prefix. */
function localName(qualified: string): string {
    const separator = qualified.lastIndexOf(":");
    const local = separator < 0 ? qualified : qualified.slice(separator + 1);
    return local.length > 0 ? local : qualified;
}

function truncate(value: string, limit: number): string {
    if (value.length <= limit) return value;
    let end = limit;
    const last = value.charCodeAt(end - 1);
    // Never split a surrogate pair: an astral character counts as one unit boundary.
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return value.slice(0, end);
}

function decodeEntity(entity: string): string | undefined {
    switch (entity) {
        case "amp": return "&";
        case "lt": return "<";
        case "gt": return ">";
        case "quot": return "\"";
        case "apos": return "'";
        default: break;
    }
    if (!entity.startsWith("#")) return undefined;
    const body = entity.slice(1);
    const hexadecimal = body.startsWith("x") || body.startsWith("X");
    const digits = hexadecimal ? body.slice(1) : body;
    if (digits.length === 0 || digits.length > 8) return undefined;
    if (hexadecimal ? !/^[0-9a-fA-F]+$/.test(digits) : !/^[0-9]+$/.test(digits)) return undefined;
    const code = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
    return String.fromCodePoint(code);
}

/** Decodes predefined and numeric references; unknown references are preserved verbatim. */
function decodeEntities(value: string): string {
    if (!value.includes("&")) return value;
    const into: string[] = [];
    let cursor = 0;
    while (cursor < value.length) {
        const ampersand = value.indexOf("&", cursor);
        if (ampersand < 0) {
            into.push(value.slice(cursor));
            break;
        }
        into.push(value.slice(cursor, ampersand));
        const semicolon = value.indexOf(";", ampersand + 1);
        if (semicolon < 0) {
            into.push(value.slice(ampersand));
            break;
        }
        if (semicolon - ampersand > 32) {
            into.push("&");
            cursor = ampersand + 1;
            continue;
        }
        const decoded = decodeEntity(value.slice(ampersand + 1, semicolon));
        into.push(decoded === undefined ? value.slice(ampersand, semicolon + 1) : decoded);
        cursor = semicolon + 1;
    }
    return into.join("");
}

function selectLabel(candidates: SynchronousUnorderedMap<string, string>): Optional<string> {
    for (const attribute of LABEL_ATTRIBUTES) {
        const value = candidates.get(attribute);
        if (value.isPresent()) return Optional.of(value.get());
    }
    return Optional.empty<string>();
}

/** Advances past the next `>` that is not inside a quoted value. */
function skipTagEnd(source: string, from: number): number {
    let cursor = from;
    let quote = "";
    while (cursor < source.length) {
        const char = source[cursor]!;
        if (quote.length > 0) {
            if (char === quote) quote = "";
        } else if (char === "\"" || char === "'") {
            quote = char;
        } else if (char === ">") {
            return cursor + 1;
        }
        cursor += 1;
    }
    return source.length;
}

function skipUntil(source: string, from: number, terminator: string): number {
    const close = source.indexOf(terminator, from);
    return close < 0 ? source.length : close + terminator.length;
}

function isDoctype(source: string, index: number): boolean {
    return source.slice(index, index + 9).toUpperCase() === "<!DOCTYPE";
}

/**
 * Skips `<!DOCTYPE ...>`, including an internal subset. Brackets, quotes and
 * comments inside the subset must not end the declaration early.
 */
function skipDoctype(source: string, start: number): number {
    let cursor = start + 2;
    let bracketDepth = 0;
    let quote = "";
    while (cursor < source.length) {
        const char = source[cursor]!;
        if (quote.length > 0) {
            if (char === quote) quote = "";
            cursor += 1;
            continue;
        }
        if (char === "\"" || char === "'") {
            quote = char;
            cursor += 1;
            continue;
        }
        if (source.startsWith("<!--", cursor)) {
            cursor = skipUntil(source, cursor + 4, "-->");
            continue;
        }
        if (source.startsWith("<![CDATA[", cursor)) {
            cursor = skipUntil(source, cursor + 9, "]]>");
            continue;
        }
        if (char === "[") {
            bracketDepth += 1;
            cursor += 1;
            continue;
        }
        if (char === "]") {
            if (bracketDepth > 0) bracketDepth -= 1;
            cursor += 1;
            continue;
        }
        if (char === ">" && bracketDepth === 0) return cursor + 1;
        cursor += 1;
    }
    return source.length;
}

/** Skips any other `<!...>` declaration, keeping quoted `>` characters inside it. */
function skipDeclaration(source: string, start: number): number {
    return skipTagEnd(source, start + 2);
}

function readEndTag(source: string, start: number): EndTag | undefined {
    let cursor = skipWhitespace(source, start + 2);
    if (!isNameStart(source.charCodeAt(cursor))) return undefined;
    const nameStart = cursor;
    while (cursor < source.length && isNameChar(source.charCodeAt(cursor))) cursor += 1;
    const name = source.slice(nameStart, cursor);
    return { name, end: skipTagEnd(source, cursor) };
}

function readStartTag(source: string, start: number): StartTag | undefined {
    let cursor = start + 1;
    if (cursor >= source.length || !isNameStart(source.charCodeAt(cursor))) return undefined;
    const nameStart = cursor;
    while (cursor < source.length && isNameChar(source.charCodeAt(cursor))) cursor += 1;
    const qualified = source.slice(nameStart, cursor);
    const labels = new SynchronousUnorderedMap<string, string>();
    const summary: string[] = [];
    let selfClosing = false;
    while (cursor < source.length) {
        cursor = skipWhitespace(source, cursor);
        if (cursor >= source.length) break;
        const char = source[cursor]!;
        if (char === ">") {
            cursor += 1;
            break;
        }
        if (char === "/" && source[cursor + 1] === ">") {
            cursor += 2;
            selfClosing = true;
            break;
        }
        if (char === "/") {
            cursor += 1;
            continue;
        }
        const attributeStart = cursor;
        while (cursor < source.length && isNameChar(source.charCodeAt(cursor))) cursor += 1;
        if (cursor === attributeStart) {
            cursor += 1;
            continue;
        }
        const attributeName = source.slice(attributeStart, cursor);
        const afterName = skipWhitespace(source, cursor);
        let value = "";
        let assigned = false;
        if (source[afterName] === "=") {
            assigned = true;
            cursor = skipWhitespace(source, afterName + 1);
            if (cursor >= source.length) break;
            const quote = source[cursor]!;
            if (quote === "\"" || quote === "'") {
                cursor += 1;
                const valueStart = cursor;
                while (cursor < source.length && source[cursor] !== quote) cursor += 1;
                value = source.slice(valueStart, cursor);
                if (cursor < source.length) cursor += 1;
            } else {
                const valueStart = cursor;
                while (cursor < source.length) {
                    const code = source.charCodeAt(cursor);
                    if (isWhitespace(code) || source[cursor] === ">" || (source[cursor] === "/" && source[cursor + 1] === ">")) break;
                    cursor += 1;
                }
                value = source.slice(valueStart, cursor);
            }
            if (assigned && (LABEL_ATTRIBUTE_NAMES.contains(attributeName) || SUMMARY_ATTRIBUTE_NAMES.contains(attributeName))) {
                value = decodeEntities(value);
            }
        } else {
            cursor = afterName;
        }
        if (LABEL_ATTRIBUTE_NAMES.contains(attributeName) && labels.get(attributeName).isEmpty()) labels.put(attributeName, value);
        if (assigned && SUMMARY_ATTRIBUTE_NAMES.contains(attributeName)) summary.push(`${attributeName}=${value}`);
    }
    return {
        qualified, local: localName(qualified), selfClosing, end: cursor,
        label: selectLabel(labels), attributesSummary: summary.join(" "),
    };
}

function nearestProducedId(stack: readonly OpenElement[]): string | undefined {
    const top = stack.at(-1);
    if (top === undefined) return undefined;
    return top.node?.id ?? top.ancestor;
}

/** Mismatched end tags are ignored; a matching local name may close a prefixed start tag. */
function closeElement(stack: OpenElement[], qualified: string, end: number): void {
    let match = -1;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]?.qualified === qualified) {
            match = index;
            break;
        }
    }
    if (match < 0) {
        const local = localName(qualified);
        for (let index = stack.length - 1; index >= 0; index -= 1) {
            if (stack[index]?.local === local) {
                match = index;
                break;
            }
        }
    }
    if (match < 0) return;
    while (stack.length > match) {
        const element = stack.pop();
        if (element?.node) element.node.end = end;
    }
}

function parseXml(source: string): readonly ParsedOutlineNode[] {
    if (!isString(source)) throw new TypeError("xml source must be a string");
    const text = new SourceText(source);
    const nodes: MutableNode[] = [];
    const stack: OpenElement[] = [];
    let cursor = 0;
    while (cursor < source.length) {
        const open = source.indexOf("<", cursor);
        if (open < 0) break;
        cursor = open;
        if (source.startsWith("<!--", cursor)) {
            cursor = skipUntil(source, cursor + 4, "-->");
            continue;
        }
        if (source.startsWith("<![CDATA[", cursor)) {
            cursor = skipUntil(source, cursor + 9, "]]>");
            continue;
        }
        if (source.startsWith("<?", cursor)) {
            cursor = skipUntil(source, cursor + 2, "?>");
            continue;
        }
        if (source.startsWith("</", cursor)) {
            const endTag = readEndTag(source, cursor);
            if (endTag === undefined) {
                cursor += 1;
                continue;
            }
            closeElement(stack, endTag.name, endTag.end);
            cursor = endTag.end;
            continue;
        }
        if (isDoctype(source, cursor)) {
            cursor = skipDoctype(source, cursor);
            continue;
        }
        if (source.startsWith("<!", cursor)) {
            cursor = skipDeclaration(source, cursor);
            continue;
        }
        const tag = readStartTag(source, cursor);
        if (tag === undefined) {
            cursor += 1;
            continue;
        }
        const parentId = nearestProducedId(stack);
        const labelValue = tag.label.isPresent() ? tag.label.get().trim() : "";
        const produced = tag.label.isPresent() || STRUCTURAL_LOCAL_NAMES.contains(tag.local.toLowerCase());
        let node: MutableNode | undefined;
        if (produced) {
            const heading = tag.attributesSummary.length > 0 ? `<${tag.qualified}> ${tag.attributesSummary}` : `<${tag.qualified}>`;
            node = {
                id: `xml:${tag.local}:${cursor}`,
                name: truncate(labelValue.length > 0 ? labelValue : tag.local, NAME_LIMIT),
                summary: truncate(heading, SUMMARY_LIMIT),
                start: cursor, end: tag.end,
                ...(parentId === undefined ? {} : { parentId }),
            };
            nodes.push(node);
        }
        if (!tag.selfClosing) {
            stack.push({
                qualified: tag.qualified, local: tag.local,
                ...(parentId === undefined ? {} : { ancestor: parentId }),
                ...(node === undefined ? {} : { node }),
            });
        }
        cursor = tag.end;
    }
    for (const element of stack) if (element.node !== undefined) element.node.end = source.length;

    return Object.freeze(useFrom(nodes).map((value): ParsedOutlineNode => Object.freeze({
        id: value.id,
        kind: "symbol",
        name: value.name,
        summary: value.summary,
        ...(value.parentId === undefined ? {} : { parentId: value.parentId }),
        range: freezeRange(text.range(value.start, value.end)),
    })).toCollectable().toArray());
}

export const parser: OutlineParserPort = Object.freeze({
    language: "xml",
    parse(source: string): readonly ParsedOutlineNode[] {
        return parseXml(source);
    },
});

export const definition: LanguageDefinition = Object.freeze({
    id: "xml", displayName: "XML",
    extensions: Object.freeze([".xml", ".xsd", ".xsl", ".xslt", ".svg", ".plist", ".xaml", ".wsdl", ".rss", ".atom", ".gpx", ".kml"]),
    mimeTypes: Object.freeze(["text/xml", "application/xml", "image/svg+xml", "application/x-plist"]),
    support: "outline", parser,
});
