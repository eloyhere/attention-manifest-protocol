import { isString } from "semantic-typescript";
import type { OutlineParserPort, ParsedOutlineNode } from "../outline.ts";
import { SourceText, freezeRange } from "../range.ts";
import type { LanguageDefinition } from "./types.ts";

/**
 * Read-only structural outline for JSON-family documents. The scanner is a single
 * pass over the source and produces one symbol node per object property and per
 * expanded array element. It never evaluates values: numbers stay source text.
 *
 * Tolerance is deliberately JSONC/JSON5-shaped but predictable: line and block
 * comments, trailing commas, and `NaN`/`Infinity` number text are accepted;
 * single-quoted strings and unquoted keys are rejected with a `SyntaxError`.
 * A container is expanded only while the depth budget lasts, an array only for
 * its first `MAX_ARRAY_ITEMS` elements, and the whole file only up to
 * `MAX_NODES` nodes. Budget cuts never throw; structural errors always do.
 */

/** Root value is container depth 1; deeper containers are scanned but not expanded. */
const MAX_DEPTH = 6;
const MAX_NODES = 2000;
const MAX_ARRAY_ITEMS = 50;
const STRING_PREVIEW = 60;

type TokenType = "{" | "}" | "[" | "]" | "," | ":" | "string" | "number" | "literal" | "eof";

interface Token {
    readonly type: TokenType;
    readonly start: number;
    readonly end: number;
    readonly value: string;
}

interface MutableNode {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly kind: "symbol";
    readonly parentId?: string;
    summary: string;
    start: number;
    end: number;
}

type Label =
    | { readonly kind: "property"; readonly name: string; readonly start: number }
    | { readonly kind: "element"; readonly index: number; readonly name: string; readonly start: number };

interface ContainerResult {
    readonly end: number;
    readonly kind: "object" | "array";
    readonly count: number;
    readonly truncated: boolean;
}

interface SkippedValue {
    readonly end: number;
    readonly kind: "object" | "array" | "scalar";
    readonly count: number;
}

interface SkipFrame {
    readonly kind: "object" | "array";
    state: "keyOrClose" | "colon" | "valueOrClose" | "commaOrClose";
    count: number;
}

function isWhitespace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isDigit(code: number): boolean {
    return code >= 0x30 && code <= 0x39;
}

function isIdentifierChar(code: number): boolean {
    return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)
        || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x24;
}

/** `line:column` is always 1-based and computed from `SourceText`. */
function fail(text: SourceText, index: number, message: string): never {
    const line = text.lineAt(index);
    const column = index - (text.lineStarts[line] ?? 0) + 1;
    throw new SyntaxError(`${message} at ${line + 1}:${column}`);
}

function describeToken(source: string, token: Token): string {
    if (token.type === "eof") return "end of input";
    const raw = source.slice(token.start, Math.min(token.end, token.start + 24));
    return token.end - token.start > 24 ? `"${raw}…"` : `"${raw}"`;
}

function skipTrivia(source: string, text: SourceText, from: number): number {
    let cursor = from;
    while (cursor < source.length) {
        if (isWhitespace(source.charCodeAt(cursor))) {
            cursor += 1;
            continue;
        }
        if (source.startsWith("//", cursor)) {
            const newline = source.indexOf("\n", cursor + 2);
            cursor = newline < 0 ? source.length : newline + 1;
            continue;
        }
        if (source.startsWith("/*", cursor)) {
            const close = source.indexOf("*/", cursor + 2);
            if (close < 0) fail(text, cursor, "unterminated block comment");
            cursor = close + 2;
            continue;
        }
        break;
    }
    return cursor;
}

function readString(source: string, text: SourceText, start: number): Token {
    let cursor = start + 1;
    const parts: string[] = [];
    while (cursor < source.length) {
        const char = source[cursor]!;
        if (char === "\"") return { type: "string", start, end: cursor + 1, value: parts.join("") };
        if (char === "\\") {
            const escape = source[cursor + 1];
            if (escape === undefined) break;
            switch (escape) {
                case "\"": parts.push("\""); cursor += 2; break;
                case "\\": parts.push("\\"); cursor += 2; break;
                case "/": parts.push("/"); cursor += 2; break;
                case "b": parts.push("\b"); cursor += 2; break;
                case "f": parts.push("\f"); cursor += 2; break;
                case "n": parts.push("\n"); cursor += 2; break;
                case "r": parts.push("\r"); cursor += 2; break;
                case "t": parts.push("\t"); cursor += 2; break;
                case "u": {
                    const hex = source.slice(cursor + 2, cursor + 6);
                    if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) fail(text, cursor, "invalid unicode escape");
                    parts.push(String.fromCharCode(Number.parseInt(hex, 16)));
                    cursor += 6;
                    break;
                }
                default:
                    fail(text, cursor, `invalid escape sequence "\\${escape}"`);
            }
            continue;
        }
        if (char === "\n" || char === "\r") fail(text, cursor, "unterminated string");
        parts.push(char);
        cursor += 1;
    }
    fail(text, start, "unterminated string");
}

/** A character that may legally follow a number token; comments start with `/`. */
function isValueBoundary(char: string): boolean {
    return char === "," || char === "}" || char === "]" || char === ":" || char === "/" || isWhitespace(char.charCodeAt(0));
}

function numberToken(source: string, text: SourceText, start: number, end: number): Token {
    if (end < source.length && !isValueBoundary(source[end]!)) {
        fail(text, end, `unexpected character "${source[end]!}" after a number`);
    }
    return { type: "number", start, end, value: source.slice(start, end) };
}

/**
 * JSON number grammar plus `-Infinity`; `NaN` and bare `Infinity` arrive through
 * `readWord`. These are kept as text, never converted, so `number Infinity` is safe.
 */
function readNumber(source: string, text: SourceText, start: number): Token {
    let cursor = start;
    if (source.charCodeAt(cursor) === 0x2d) {
        cursor += 1;
        if (source.startsWith("Infinity", cursor)) return numberToken(source, text, start, cursor + 8);
    }
    if (source.charCodeAt(cursor) === 0x30) cursor += 1;
    else if (isDigit(source.charCodeAt(cursor))) {
        while (isDigit(source.charCodeAt(cursor))) cursor += 1;
    } else {
        fail(text, start, "invalid number");
    }
    if (source[cursor] === ".") {
        cursor += 1;
        if (!isDigit(source.charCodeAt(cursor))) fail(text, cursor, "invalid number");
        while (isDigit(source.charCodeAt(cursor))) cursor += 1;
    }
    if (source[cursor] === "e" || source[cursor] === "E") {
        cursor += 1;
        if (source[cursor] === "+" || source[cursor] === "-") cursor += 1;
        if (!isDigit(source.charCodeAt(cursor))) fail(text, cursor, "invalid fraction");
        while (isDigit(source.charCodeAt(cursor))) cursor += 1;
    }
    return numberToken(source, text, start, cursor);
}

function readWord(source: string, text: SourceText, start: number): Token {
    let cursor = start;
    while (cursor < source.length && isIdentifierChar(source.charCodeAt(cursor))) cursor += 1;
    const word = source.slice(start, cursor);
    if (word === "true" || word === "false" || word === "null") {
        return { type: "literal", start, end: cursor, value: word };
    }
    if (word === "NaN" || word === "Infinity") return { type: "number", start, end: cursor, value: word };
    fail(text, start, `unexpected identifier "${word}"`);
}

function readToken(source: string, text: SourceText, from: number): Token {
    const start = skipTrivia(source, text, from);
    if (start >= source.length) return { type: "eof", start, end: start, value: "" };
    const char = source[start]!;
    switch (char) {
        case "{": case "}": case "[": case "]": case ",": case ":":
            return { type: char, start, end: start + 1, value: char };
        case "\"":
            return readString(source, text, start);
        case "'":
            return fail(text, start, "single-quoted strings are not supported");
        case "-":
            return readNumber(source, text, start);
        default:
            if (isDigit(source.charCodeAt(start))) return readNumber(source, text, start);
            if (isIdentifierChar(source.charCodeAt(start))) return readWord(source, text, start);
            fail(text, start, `unexpected character "${char}"`);
    }
}

function isScalarToken(token: Token): boolean {
    return token.type === "string" || token.type === "number" || token.type === "literal";
}

/**
 * Iterative structural scan for a value that produces no nodes (depth budget,
 * array cap or node budget). It uses an explicit frame stack, so arbitrarily deep
 * input cannot overflow the call stack, and validates brackets, commas, colons,
 * strings and comments exactly like the emitting path.
 */
function skipValue(source: string, text: SourceText, start: Token): SkippedValue {
    if (start.type !== "{" && start.type !== "[") {
        if (!isScalarToken(start)) fail(text, start.start, `expected a JSON value, found ${describeToken(source, start)}`);
        return { end: start.end, kind: "scalar", count: 0 };
    }
    const kind: "object" | "array" = start.type === "{" ? "object" : "array";
    const root: SkipFrame = { kind, state: kind === "object" ? "keyOrClose" : "valueOrClose", count: 0 };
    const stack: SkipFrame[] = [root];
    let cursor = start.end;
    while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        if (frame.state === "keyOrClose") {
            const token = readToken(source, text, cursor);
            cursor = token.end;
            if (token.type === "}") {
                stack.pop();
                continue;
            }
            if (token.type !== "string") {
                fail(text, token.start, `expected an object key or "}", found ${describeToken(source, token)}`);
            }
            frame.count += 1;
            frame.state = "colon";
            continue;
        }
        if (frame.state === "colon") {
            const token = readToken(source, text, cursor);
            cursor = token.end;
            if (token.type !== ":") fail(text, token.start, `expected ":" after an object key, found ${describeToken(source, token)}`);
            frame.state = "valueOrClose";
            continue;
        }
        if (frame.state === "valueOrClose") {
            const token = readToken(source, text, cursor);
            cursor = token.end;
            if (frame.kind === "array" && token.type === "]") {
                stack.pop();
                continue;
            }
            if (frame.kind === "array") frame.count += 1;
            if (token.type === "{" || token.type === "[") {
                frame.state = "commaOrClose";
                stack.push({ kind: token.type === "{" ? "object" : "array",
                    state: token.type === "{" ? "keyOrClose" : "valueOrClose", count: 0 });
                continue;
            }
            if (!isScalarToken(token)) {
                fail(text, token.start, `expected a JSON value, found ${describeToken(source, token)}`);
            }
            frame.state = "commaOrClose";
            continue;
        }
        const token = readToken(source, text, cursor);
        cursor = token.end;
        if (token.type === ",") {
            frame.state = frame.kind === "object" ? "keyOrClose" : "valueOrClose";
            continue;
        }
        if ((frame.kind === "object" && token.type === "}") || (frame.kind === "array" && token.type === "]")) {
            stack.pop();
            continue;
        }
        fail(text, token.start, `expected "," or "${frame.kind === "object" ? "}" : "]"}", found ${describeToken(source, token)}`);
    }
    return { end: cursor, kind, count: root.count };
}

/**
 * Encodes one JSONPath segment. Lone surrogates (legal after `\uD800` decoding)
 * would make `encodeURIComponent` throw, so they map to U+FFFD instead.
 */
function encodeSegment(value: string): string {
    try {
        return encodeURIComponent(value);
    } catch {
        let encoded = "";
        for (const character of value) {
            const point = character.codePointAt(0) ?? 0;
            encoded += point >= 0xd800 && point <= 0xdfff ? "%EF%BF%BD" : encodeURIComponent(character);
        }
        return encoded;
    }
}

function scalarSummary(token: Token): string {
    if (token.type === "string") {
        let preview = "";
        let chars = 0;
        for (const point of token.value) {
            if (chars < STRING_PREVIEW) preview += point;
            chars += 1;
        }
        return `string ${JSON.stringify(preview + (chars > STRING_PREVIEW ? "…" : ""))} (${chars} chars)`;
    }
    if (token.type === "number") return `number ${token.value}`;
    return token.value === "null" ? "null" : `boolean ${token.value}`;
}

function containerSummary(kind: "object" | "array", count: number, truncated: boolean): string {
    const base = kind === "object" ? `object (${count} keys)` : `array (${count} items)`;
    return truncated ? `${base} (truncated)` : base;
}

function skippedSummary(skipped: SkippedValue, truncated: boolean): string {
    return containerSummary(skipped.kind === "array" ? "array" : "object", skipped.count, truncated);
}

function parseJson(source: string): readonly ParsedOutlineNode[] {
    if (!isString(source)) throw new TypeError("json source must be a string");
    const text = new SourceText(source);
    const nodes: MutableNode[] = [];
    let budgetExhausted = false;

    const emitNode = (label: Label, containerPath: string, parentId: string | undefined): MutableNode | undefined => {
        if (budgetExhausted) return undefined;
        const nodePath = label.kind === "property"
            ? `${containerPath}.${encodeSegment(label.name)}`
            : `${containerPath}[${label.index}]`;
        const node: MutableNode = {
            id: `json:${nodePath}:${label.start}`,
            name: label.name, path: nodePath, kind: "symbol", summary: "",
            start: label.start, end: label.start,
            ...(parentId === undefined ? {} : { parentId }),
        };
        nodes.push(node);
        // The node that reaches the cap is emitted whole; its children are not.
        if (nodes.length >= MAX_NODES) budgetExhausted = true;
        return node;
    };

    const parseContainer = (token: Token, depth: number, containerPath: string,
        parentId: string | undefined): ContainerResult => token.type === "{"
        ? parseObject(token, depth, containerPath, parentId)
        : parseArray(token, depth, containerPath, parentId);

    const parseValue = (token: Token, depth: number, containerPath: string, parentId: string | undefined,
        label: Label | undefined): { readonly end: number; readonly missed: boolean } => {
        if (token.type === "{" || token.type === "[") {
            if (label === undefined) {
                const container = parseContainer(token, depth, containerPath, undefined);
                return { end: container.end, missed: false };
            }
            const node = emitNode(label, containerPath, parentId);
            if (node === undefined) return { end: skipValue(source, text, token).end, missed: true };
            if (depth > MAX_DEPTH || budgetExhausted) {
                const skipped = skipValue(source, text, token);
                node.end = skipped.end;
                node.summary = skippedSummary(skipped, true);
                return { end: skipped.end, missed: false };
            }
            const container = parseContainer(token, depth, node.path, node.id);
            node.end = container.end;
            node.summary = containerSummary(container.kind, container.count, container.truncated);
            return { end: container.end, missed: false };
        }
        if (!isScalarToken(token)) fail(text, token.start, `unexpected ${describeToken(source, token)}`);
        if (label === undefined) return { end: token.end, missed: false };
        const node = emitNode(label, containerPath, parentId);
        if (node === undefined) return { end: token.end, missed: true };
        node.end = token.end;
        node.summary = scalarSummary(token);
        return { end: token.end, missed: false };
    };

    const parseObject = (token: Token, depth: number, containerPath: string,
        parentId: string | undefined): ContainerResult => {
        let cursor = token.end;
        let count = 0;
        let truncated = false;
        while (true) {
            const key = readToken(source, text, cursor);
            if (key.type === "}") return { end: key.end, kind: "object", count, truncated };
            if (key.type !== "string") {
                fail(text, key.start, `expected an object key or "}", found ${describeToken(source, key)}`);
            }
            const colon = readToken(source, text, key.end);
            if (colon.type !== ":") {
                fail(text, colon.start, `expected ":" after an object key, found ${describeToken(source, colon)}`);
            }
            const valueToken = readToken(source, text, colon.end);
            count += 1;
            const value = parseValue(valueToken, depth + 1, containerPath, parentId,
                { kind: "property", name: key.value, start: key.start });
            if (value.missed) truncated = true;
            const separator = readToken(source, text, value.end);
            if (separator.type === ",") {
                cursor = separator.end;
                continue;
            }
            if (separator.type === "}") return { end: separator.end, kind: "object", count, truncated };
            fail(text, separator.start, `expected "," or "}" after an object member, found ${describeToken(source, separator)}`);
        }
    };

    const parseArray = (token: Token, depth: number, containerPath: string,
        parentId: string | undefined): ContainerResult => {
        let cursor = token.end;
        let count = 0;
        let truncated = false;
        while (true) {
            const valueToken = readToken(source, text, cursor);
            if (valueToken.type === "]") return { end: valueToken.end, kind: "array", count, truncated };
            const index = count;
            count += 1;
            let end: number;
            if (index >= MAX_ARRAY_ITEMS) {
                truncated = true;
                end = skipValue(source, text, valueToken).end;
            } else {
                const value = parseValue(valueToken, depth + 1, containerPath, parentId,
                    { kind: "element", index, name: `[${index}]`, start: valueToken.start });
                if (value.missed) truncated = true;
                end = value.end;
            }
            const separator = readToken(source, text, end);
            if (separator.type === ",") {
                cursor = separator.end;
                continue;
            }
            if (separator.type === "]") return { end: separator.end, kind: "array", count, truncated };
            fail(text, separator.start, `expected "," or "]" after an array element, found ${describeToken(source, separator)}`);
        }
    };

    const origin = source.startsWith("\uFEFF") ? 1 : 0;
    const rootToken = readToken(source, text, origin);
    if (rootToken.type === "eof") fail(text, rootToken.start, "expected a JSON value");
    const root = parseValue(rootToken, 1, "$", undefined, undefined);
    const trailing = readToken(source, text, root.end);
    if (trailing.type !== "eof") fail(text, trailing.start, `unexpected ${describeToken(source, trailing)} after the root value`);

    return Object.freeze(nodes.map(node => Object.freeze({
        id: node.id,
        kind: "symbol" as const,
        name: node.name,
        summary: node.summary,
        ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
        range: freezeRange(text.range(node.start, node.end)),
    })));
}

export const parser: OutlineParserPort = Object.freeze({
    language: "json",
    parse(source: string): readonly ParsedOutlineNode[] {
        return parseJson(source);
    },
});

export const definition: LanguageDefinition = Object.freeze({
    id: "json", displayName: "JSON",
    extensions: Object.freeze([".json", ".jsonc", ".json5", ".geojson", ".topojson", ".webmanifest", ".har"]),
    mimeTypes: Object.freeze(["application/json", "application/ld+json", "application/manifest+json", "application/geo+json"]),
    support: "outline", parser,
});
