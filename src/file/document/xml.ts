import { Optional } from "semantic-typescript";
import { DocumentError, defaultDocumentLimits, type DocumentLimits } from "./types.ts";

export interface XmlNode {
    /** Qualified name exactly as written, e.g. `w:p`. */
    readonly name: string;
    /** Local name after the last `:`, e.g. `p`. */
    readonly local: string;
    readonly attrs: Readonly<Record<string, string>>;
    readonly children: readonly XmlNode[];
    /** Concatenated direct text with entities decoded. */
    readonly text: string;
}

function fail(message: string): DocumentError {
    return new DocumentError("invalid_xml", message);
}

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
});

function decodeEntities(value: string): string {
    if (!value.includes("&")) return value;
    return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
        if (body.startsWith("#x") || body.startsWith("#X")) {
            const code = Number.parseInt(body.slice(2), 16);
            if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) throw fail(`invalid character reference ${whole}`);
            return String.fromCodePoint(code);
        }
        if (body.startsWith("#")) {
            const code = Number.parseInt(body.slice(1), 10);
            if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) throw fail(`invalid character reference ${whole}`);
            return String.fromCodePoint(code);
        }
        const named = ENTITIES[body];
        if (named === undefined) throw fail(`unknown entity ${whole}`);
        return named;
    });
}

interface MutableNode {
    readonly name: string;
    readonly local: string;
    readonly attrs: Record<string, string>;
    readonly children: XmlNode[];
    text: string;
}

function attributeSource(tagBody: string): { name: string; rest: string } {
    const match = /^[A-Za-z_][\w.:-]*/.exec(tagBody);
    if (!match) throw fail(`invalid tag name near "${tagBody.slice(0, 24)}"`);
    return { name: match[0], rest: tagBody.slice(match[0].length) };
}

function readAttributes(source: string, target: Record<string, string>): void {
    let index = 0;
    while (index < source.length) {
        while (index < source.length && /\s/.test(source[index]!)) index += 1;
        if (index >= source.length) break;
        if (source[index] === "/") {
            index += 1;
            continue;
        }
        const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(source.slice(index));
        if (!nameMatch) throw fail(`invalid attribute near "${source.slice(index, index + 24)}"`);
        const name = nameMatch[0];
        index += name.length;
        while (index < source.length && /\s/.test(source[index]!)) index += 1;
        if (source[index] !== "=") throw fail(`attribute ${name} has no value`);
        index += 1;
        while (index < source.length && /\s/.test(source[index]!)) index += 1;
        const quote = source[index];
        if (quote !== '"' && quote !== "'") throw fail(`attribute ${name} is not quoted`);
        const end = source.indexOf(quote, index + 1);
        if (end < 0) throw fail(`attribute ${name} is unterminated`);
        target[name] = decodeEntities(source.slice(index + 1, end));
        index = end + 1;
    }
}

function freezeNode(node: MutableNode): XmlNode {
    return Object.freeze({
        name: node.name, local: node.local, attrs: Object.freeze({ ...node.attrs }),
        children: Object.freeze([...node.children]), text: node.text,
    });
}

/** Minimal, dependency-free XML reader for OOXML parts. DTDs and entities are rejected. */
export function parseXml(source: string, limits: DocumentLimits = {}): XmlNode {
    if (typeof source !== "string") throw new TypeError("xml source must be a string");
    const merged = { ...defaultDocumentLimits, ...limits };
    const stack: MutableNode[] = [];
    let root: XmlNode | undefined;
    let nodes = 0;
    let index = 0;
    const append = (text: string): void => {
        const current = stack.at(-1);
        if (current) current.text += text;
        else if (text.trim() !== "") throw fail("text outside the root element");
    };
    while (index < source.length) {
        const open = source.indexOf("<", index);
        if (open < 0) {
            append(decodeEntities(source.slice(index)));
            break;
        }
        if (open > index) append(decodeEntities(source.slice(index, open)));
        if (source.startsWith("<!--", open)) {
            const end = source.indexOf("-->", open + 4);
            if (end < 0) throw fail("unterminated comment");
            index = end + 3;
            continue;
        }
        if (source.startsWith("<![CDATA[", open)) {
            const end = source.indexOf("]]>", open + 9);
            if (end < 0) throw fail("unterminated CDATA section");
            append(source.slice(open + 9, end));
            index = end + 3;
            continue;
        }
        if (source.startsWith("<?", open)) {
            const end = source.indexOf("?>", open + 2);
            if (end < 0) throw fail("unterminated processing instruction");
            index = end + 2;
            continue;
        }
        if (source.startsWith("<!", open)) throw fail("doctype and entity declarations are not allowed");
        const close = source.indexOf(">", open + 1);
        if (close < 0) throw fail("unterminated tag");
        const body = source.slice(open + 1, close);
        index = close + 1;
        if (body.startsWith("/")) {
            const name = body.slice(1).trim();
            const current = stack.pop();
            if (!current || current.name !== name) throw fail(`mismatched closing tag </${name}>`);
            const frozen = freezeNode(current);
            nodes += 1;
            if (nodes > merged.maxNodes) throw new DocumentError("limit_exceeded", "xml node budget exceeded");
            const parent = stack.at(-1);
            if (parent) parent.children.push(frozen);
            else if (root === undefined) root = frozen;
            else throw fail("multiple root elements");
            continue;
        }
        const selfClosing = body.trimEnd().endsWith("/");
        const content = selfClosing ? body.trimEnd().slice(0, -1) : body;
        const { name, rest } = attributeSource(content);
        const node: MutableNode = { name, local: name.split(":").at(-1) ?? name, attrs: {}, children: [], text: "" };
        readAttributes(rest, node.attrs);
        if (selfClosing) {
            const frozen = freezeNode(node);
            nodes += 1;
            if (nodes > merged.maxNodes) throw new DocumentError("limit_exceeded", "xml node budget exceeded");
            const parent = stack.at(-1);
            if (parent) parent.children.push(frozen);
            else if (root === undefined) root = frozen;
            else throw fail("multiple root elements");
            continue;
        }
        stack.push(node);
        if (stack.length > merged.maxDepth) throw new DocumentError("limit_exceeded", "xml depth budget exceeded");
    }
    if (stack.length > 0) throw fail(`unclosed tag <${stack.at(-1)!.name}>`);
    if (!root) throw fail("no root element");
    return root;
}

export function childrenNamed(node: XmlNode, local: string): readonly XmlNode[] {
    return Object.freeze(node.children.filter(child => child.local === local));
}

export function firstChild(node: XmlNode, local: string): Optional<XmlNode> {
    return Optional.ofNullable(node.children.find(child => child.local === local));
}

export function findAll(node: XmlNode, local: string): readonly XmlNode[] {
    const found: XmlNode[] = [];
    const visit = (current: XmlNode): void => {
        for (const child of current.children) {
            if (child.local === local) found.push(child);
            visit(child);
        }
    };
    visit(node);
    return Object.freeze(found);
}

/** Depth-first concatenated text, in document order. */
export function textOf(node: XmlNode): string {
    let text = node.text;
    for (const child of node.children) text += textOf(child);
    return text;
}

/** Reads an attribute by local name, then by any of the given qualified names. */
export function attrOf(node: XmlNode, ...names: readonly string[]): string | undefined {
    for (const name of names) {
        const direct = node.attrs[name];
        if (direct !== undefined) return direct;
    }
    for (const candidate of names) {
        for (const [key, value] of Object.entries(node.attrs)) {
            if (key.split(":").at(-1) === candidate) return value;
        }
    }
    return undefined;
}
