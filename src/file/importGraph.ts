/**
 * Static import extraction for the agent workspace.
 *
 * The extractor is deliberately a small lexical scanner rather than a regular
 * expression over lines. It first tokenizes source while discarding comments and
 * string/template bodies, then walks the token stream for `import`, `require` and
 * `export ... from` forms. That is enough to keep pseudo-edges inside comments,
 * strings and templates out of the graph without pretending to be a parser:
 * conditionally loaded modules and generated code can still be missed, and the
 * report says so via `resolved` rather than by inventing an edge.
 *
 * Specifiers are resolved against the session root only. Relative paths are
 * probed in a fixed extension order; absolute paths stay unresolved and bare
 * specifiers (including Node built-ins) remain external.
 */
import { readFileSync, statSync } from "node:fs";

import { rawDigest } from "../fingerprint/raw.ts";
import { decodeText, detectCharset } from "../syntax/charset.ts";
import type { DetectedCharset } from "../syntax/charset.ts";
import { fail } from "./errors.ts";
import type { PathSandbox } from "./path.ts";
import type { FilesystemErrorCode, ImportEdge, ImportKind, ImportReport, RootedPath } from "./types.ts";

const MaxSourceBytes: number = 4 * 1024 * 1024;

const ParseableExtensions: ReadonlySet<string> = new Set<string>([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

const SourceExtensions: readonly string[] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];

/**
 * One file read through a sandbox. `path` is root-relative and the fingerprint
 * covers the exact bytes that were measured, so a caller can persist the report
 * against the same content address a tree node would use.
 */
export interface SourceFileSnapshot {
    readonly path: string;
    readonly fingerprint: string;
    readonly text: string;
}

/**
 * One lexical token. `value` is decoded for string literals and raw for
 * identifiers, punctuation and templates. `line` is 1-based.
 */
export interface SourceToken {
    readonly kind: "identifier" | "string" | "template" | "punct";
    readonly value: string;
    readonly line: number;
}

/**
 * Result of resolving one specifier from one root-relative file.
 *
 * `resolved` means a file was found for a relative specifier, or that the
 * specifier is external and therefore intentionally not probed. `to` is the
 * resolved root-relative path for internal specifiers, the bare specifier for
 * external ones, and the unchanged absolute specifier for `/...`.
 */
export interface ResolvedSpecifier {
    readonly to: string;
    readonly resolved: boolean;
    readonly external: boolean;
}

interface ScanStringResult {
    readonly end: number;
    readonly value: string;
}

interface TemplateExpression {
    readonly start: number;
    readonly end: number;
}

interface TemplateScan {
    readonly end: number;
    readonly expressions: TemplateExpression[];
}

interface JsxTagScan {
    readonly end: number;
    readonly selfClosing: boolean;
    readonly closed: boolean;
    readonly expressions: TemplateExpression[];
}

interface JsxElementScan {
    readonly end: number;
    readonly closed: boolean;
    readonly expressions: TemplateExpression[];
}

interface ParsedImportFact {
    readonly specifier: string;
    readonly kind: ImportKind;
    readonly line: number;
}

type ReadSourceFileFn = (sandbox: PathSandbox, path: string) => SourceFileSnapshot;

type ImportFactReader = (tokens: readonly SourceToken[], index: number) => ParsedImportFact | undefined;

type ResolveImportSpecifierFn = (sandbox: PathSandbox, from: string, specifier: string) => ResolvedSpecifier;

type ExtractImportsFn = (sandbox: PathSandbox, path: string) => ImportReport;

type ImportedByFn = (sandbox: PathSandbox, target: string, candidates: readonly string[]) => ImportEdge[];

type LooksLikeJsxStartFn = (text: string, start: number, previous: SourceToken | undefined) => boolean;

type AppendExpressionTokensFn = (expressions: readonly TemplateExpression[], baseLine: number, baseOffset: number, jsxMode: boolean) => void;

/**
 * Map a filesystem errno to the closed filesystem error taxonomy.
 */
const readErrorCode: (error: unknown) => FilesystemErrorCode = (error: unknown): FilesystemErrorCode => {
    const code: string | undefined = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
        return "not_found";
    }
    if (code === "EACCES" || code === "EPERM") {
        return "permission_denied";
    }
    if (code === "EISDIR") {
        return "not_file";
    }
    return "store_failure";
};

/**
 * Read one sandboxed file for import/export extraction.
 *
 * The size limit is checked before the read and again after it: a file that
 * grows between the two checks is refused rather than silently truncated. A
 * binary charset is refused because slicing it as text would produce nonsense
 * tokens. Errors carry a code only, never a host path.
 *
 * @param sandbox - Root-confined path resolver.
 * @param path - Root-relative file path.
 * @returns Decoded text, root-relative path and content fingerprint.
 */
export const readSourceFile: ReadSourceFileFn = (sandbox, path): SourceFileSnapshot => {
    const rooted: RootedPath = sandbox.resolve(path, "read");
    let stat: ReturnType<typeof statSync>;
    try {
        stat = statSync(rooted.absolute);
    } catch (error: unknown) {
        return fail(readErrorCode(error));
    }
    if (!stat.isFile()) {
        return fail("not_file");
    }
    if (stat.size > MaxSourceBytes) {
        return fail("quota_exceeded");
    }
    let bytes: Buffer;
    try {
        bytes = readFileSync(rooted.absolute);
    } catch (error: unknown) {
        return fail(readErrorCode(error));
    }
    if (bytes.length > MaxSourceBytes) {
        return fail("quota_exceeded");
    }
    const detected: DetectedCharset = detectCharset(bytes);
    if (detected.binary) {
        return fail("binary_file");
    }
    return {
        path: rooted.relative,
        fingerprint: rawDigest(bytes),
        text: decodeText(bytes, detected.charset),
    };
};

/**
 * Extension of a root-relative path, lowercased, or `""`.
 */
const extensionOf: (path: string) => string = (path: string): string => {
    const slash: number = path.lastIndexOf("/");
    const dot: number = path.lastIndexOf(".");
    if (dot <= slash) {
        return "";
    }
    return path.slice(dot).toLowerCase();
};

/**
 * Whether the extension is one of the JS/TS family the lexical scanner covers.
 */
export const isParseableSource: (path: string) => boolean = (path: string): boolean => ParseableExtensions.has(extensionOf(path));

/**
 * Whether the extension may contain JSX syntax. JSX-aware tokenization is
 * enabled only for `.tsx`/`.jsx`; plain `.ts` keeps `<...>` as generic/type
 * punctuation so type parameters are not mistaken for elements.
 */
export const isJsxSource: (path: string) => boolean = (path: string): boolean => {
    const extension: string = extensionOf(path);
    return extension === ".tsx" || extension === ".jsx";
};

/**
 * Whether a token before a keyword makes that keyword a property access rather
 * than a statement. The tokenizer splits `?.` into `?` and `.`, so `.` is the
 * only marker that matters.
 */
const isMemberAccess: (previous: SourceToken | undefined) => boolean = (previous: SourceToken | undefined): boolean =>
    previous !== (void 0) && previous.kind === "punct" && (previous.value === "." || previous.value === "?");

const isIdentifierStart: (char: string) => boolean = (char: string): boolean => {
    const code: number = char.charCodeAt(0);
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36 || code > 127;
};

const isIdentifierPart: (char: string) => boolean = (char: string): boolean => {
    const code: number = char.charCodeAt(0);
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 36 || code > 127;
};

const isDigit: (char: string) => boolean = (char: string): boolean => {
    const code: number = char.charCodeAt(0);
    return code >= 48 && code <= 57;
};

const countNewlines: (text: string, start: number, end: number) => number = (text: string, start: number, end: number): number => {
    let count: number = 0;
    for (let index: number = start; index < end; index += 1) {
        if (text.charCodeAt(index) === 10) {
            count += 1;
        }
    }
    return count;
};

const skipLineComment: (text: string, start: number) => number = (text: string, start: number): number => {
    let index: number = start + 2;
    while (index < text.length && text[index] !== "\n") {
        index += 1;
    }
    return index;
};

const skipBlockComment: (text: string, start: number) => number = (text: string, start: number): number => {
    let index: number = start + 2;
    while (index < text.length) {
        if (text[index] === "*" && text[index + 1] === "/") {
            return index + 2;
        }
        index += 1;
    }
    return text.length;
};

const decodeEscape: (text: string, start: number) => ScanStringResult = (text: string, start: number): ScanStringResult => {
    const next: string | undefined = text[start + 1];
    if (next === (void 0)) {
        return { end: start + 1, value: "" };
    }
    switch (next) {
        case "n": {
            return { end: start + 2, value: "\n" };
        }
        case "t": {
            return { end: start + 2, value: "\t" };
        }
        case "r": {
            return { end: start + 2, value: "\r" };
        }
        case "b": {
            return { end: start + 2, value: "\b" };
        }
        case "f": {
            return { end: start + 2, value: "\f" };
        }
        case "v": {
            return { end: start + 2, value: "\v" };
        }
        case "0": {
            return { end: start + 2, value: "\0" };
        }
        case "\n": {
            return { end: start + 2, value: "" };
        }
        case "\r": {
            return { end: start + (text[start + 2] === "\n" ? 3 : 2), value: "" };
        }
        case "x": {
            const value: number = Number.parseInt(text.slice(start + 2, start + 4), 16);
            if (Number.isFinite(value)) {
                return { end: start + 4, value: String.fromCharCode(value) };
            }
            return { end: start + 2, value: "x" };
        }
        case "u": {
            if (text[start + 2] === "{") {
                const close: number = text.indexOf("}", start + 3);
                if (close !== -1) {
                    const value: number = Number.parseInt(text.slice(start + 3, close), 16);
                    if (Number.isFinite(value)) {
                        return { end: close + 1, value: String.fromCodePoint(value) };
                    }
                }
                return { end: start + 2, value: "u" };
            }
            const value: number = Number.parseInt(text.slice(start + 2, start + 6), 16);
            if (Number.isFinite(value)) {
                return { end: start + 6, value: String.fromCharCode(value) };
            }
            return { end: start + 2, value: "u" };
        }
        default: {
            return { end: start + 2, value: next };
        }
    }
};

const scanString: (text: string, start: number) => ScanStringResult = (text: string, start: number): ScanStringResult => {
    const quote: string = text[start];
    let index: number = start + 1;
    let value: string = "";
    while (index < text.length) {
        const char: string = text[index];
        if (char === "\\") {
            const escape: ScanStringResult = decodeEscape(text, index);
            value += escape.value;
            index = escape.end;
            continue;
        }
        if (char === quote) {
            return { end: index + 1, value };
        }
        if (char === "\n" || char === "\r") {
            return { end: index, value };
        }
        value += char;
        index += 1;
    }
    return { end: text.length, value };
};

const skipTemplateExpression: (text: string, start: number) => number = (text: string, start: number): number => {
    let index: number = start;
    let depth: number = 1;
    while (index < text.length) {
        const char: string = text[index];
        if (char === "'" || char === '"') {
            index = scanString(text, index).end;
            continue;
        }
        if (char === "`") {
            index = scanTemplateEnd(text, index);
            continue;
        }
        if (char === "/" && text[index + 1] === "/") {
            index = skipLineComment(text, index);
            continue;
        }
        if (char === "/" && text[index + 1] === "*") {
            index = skipBlockComment(text, index);
            continue;
        }
        if (char === "{") {
            depth += 1;
            index += 1;
            continue;
        }
        if (char === "}") {
            depth -= 1;
            index += 1;
            if (depth === 0) {
                return index;
            }
            continue;
        }
        index += 1;
    }
    return text.length;
};

const scanTemplateEnd: (text: string, start: number) => number = (text: string, start: number): number => {
    let index: number = start + 1;
    while (index < text.length) {
        const char: string = text[index];
        if (char === "\\") {
            index += 2;
            continue;
        }
        if (char === "`") {
            return index + 1;
        }
        if (char === "$" && text[index + 1] === "{") {
            index = skipTemplateExpression(text, index + 2);
            continue;
        }
        index += 1;
    }
    return text.length;
};

/**
 * Scan a template literal and report its `${...}` expression ranges.
 *
 * Literal text remains opaque, so `import` text inside a template is never a
 * token. Expression contents are returned as source ranges so the tokenizer can
 * process a real `import()` even though the surrounding template is skipped.
 */
const scanTemplateRange: (text: string, start: number) => TemplateScan = (text: string, start: number): TemplateScan => {
    let index: number = start + 1;
    const expressions: TemplateExpression[] = [];
    while (index < text.length) {
        const char: string = text[index];
        if (char === "\\") {
            index += 2;
            continue;
        }
        if (char === "`") {
            return { end: index + 1, expressions };
        }
        if (char === "$" && text[index + 1] === "{") {
            const expressionStart: number = index + 2;
            const expressionEnd: number = skipTemplateExpression(text, expressionStart);
            const bodyEnd: number = expressionEnd > expressionStart && text[expressionEnd - 1] === "}" ? expressionEnd - 1 : expressionEnd;
            expressions.push({ start: expressionStart, end: bodyEnd });
            index = expressionEnd;
            continue;
        }
        index += 1;
    }
    return { end: text.length, expressions };
};

const isWhitespaceChar: (char: string) => boolean = (char: string): boolean =>
    char === " " || char === "\t" || char === "\r" || char === "\n" || char === "\f" || char === "\v";

const isJsxTagNamePart: (char: string) => boolean = (char: string): boolean => isIdentifierPart(char) || char === "." || char === "-" || char === ":";

/**
 * Consume one opening tag or fragment and collect `${...}`-like attribute
 * expressions. The tag is closed when `>` is reached; `/>` marks a
 * self-closing element. An EOF before `>` returns `closed: false`, which makes
 * the tokenizer fall back to normal punctuation instead of swallowing the rest
 * of the file.
 */
const scanJsxTag: (text: string, start: number) => JsxTagScan = (text: string, start: number): JsxTagScan => {
    let index: number = start + 1;
    const expressions: TemplateExpression[] = [];
    if (text[index] === ">") {
        return { end: index + 1, selfClosing: false, closed: true, expressions };
    }
    const first: string | undefined = text[index];
    if (first === (void 0) || !isIdentifierStart(first)) {
        return { end: start + 1, selfClosing: false, closed: false, expressions };
    }
    index += 1;
    while (index < text.length && isJsxTagNamePart(text[index])) {
        index += 1;
    }
    while (index < text.length) {
        const char: string = text[index];
        if (char === '"' || char === "'") {
            const quote: string = char;
            index += 1;
            while (index < text.length) {
                if (text[index] === "\\") {
                    index += 2;
                    continue;
                }
                if (text[index] === quote) {
                    index += 1;
                    break;
                }
                index += 1;
            }
            continue;
        }
        if (char === "{") {
            const expressionStart: number = index + 1;
            const expressionEnd: number = skipTemplateExpression(text, expressionStart);
            if (expressionEnd === text.length && text[expressionEnd - 1] !== "}") {
                return { end: text.length, selfClosing: false, closed: false, expressions };
            }
            expressions.push({ start: expressionStart, end: expressionEnd - 1 });
            index = expressionEnd;
            continue;
        }
        if (char === "/" && text[index + 1] === ">") {
            return { end: index + 2, selfClosing: true, closed: true, expressions };
        }
        if (char === ">") {
            return { end: index + 1, selfClosing: false, closed: true, expressions };
        }
        index += 1;
    }
    return { end: text.length, selfClosing: false, closed: false, expressions };
};

/**
 * Consume one complete JSX element/fragment and return every embedded
 * expression range. Nested elements recurse, so their text is skipped while
 * their expressions survive. An unterminated element returns `closed: false`.
 */
const scanJsxElement: (text: string, start: number) => JsxElementScan = (text: string, start: number): JsxElementScan => {
    const opening: JsxTagScan = scanJsxTag(text, start);
    if (!opening.closed) {
        return { end: start + 1, closed: false, expressions: [] };
    }
    if (opening.selfClosing) {
        return { end: opening.end, closed: true, expressions: opening.expressions };
    }
    const expressions: TemplateExpression[] = [...opening.expressions];
    let index: number = opening.end;
    while (index < text.length) {
        const char: string = text[index];
        if (char === "{") {
            const expressionStart: number = index + 1;
            const expressionEnd: number = skipTemplateExpression(text, expressionStart);
            if (expressionEnd === text.length && text[expressionEnd - 1] !== "}") {
                return { end: start + 1, closed: false, expressions: [] };
            }
            expressions.push({ start: expressionStart, end: expressionEnd - 1 });
            index = expressionEnd;
            continue;
        }
        if (char === "<") {
            if (text[index + 1] === "/") {
                let close: number = index + 2;
                while (close < text.length && text[close] !== ">") {
                    close += 1;
                }
                return close < text.length ? { end: close + 1, closed: true, expressions } : { end: start + 1, closed: false, expressions: [] };
            }
            if (text[index + 1] === "!") {
                let close: number = index + 2;
                while (close < text.length && text[close] !== ">") {
                    close += 1;
                }
                if (close >= text.length) {
                    return { end: start + 1, closed: false, expressions: [] };
                }
                index = close + 1;
                continue;
            }
            if (text[index + 1] === ">" || (text[index + 1] !== (void 0) && isIdentifierStart(text[index + 1]))) {
                const nested: JsxElementScan = scanJsxElement(text, index);
                if (!nested.closed) {
                    return { end: start + 1, closed: false, expressions: [] };
                }
                for (let expressionIndex: number = 0; expressionIndex < nested.expressions.length; expressionIndex += 1) {
                    expressions.push(nested.expressions[expressionIndex]);
                }
                index = nested.end;
                continue;
            }
        }
        index += 1;
    }
    return { end: start + 1, closed: false, expressions: [] };
};

const JsxPrecedingPunctuation: ReadonlySet<string> = new Set<string>(["=", "(", "[", ",", ":", ";", "?", "&", "|", ">", "{", "}"]);

const JsxPrecedingKeywords: ReadonlySet<string> = new Set<string>(["await", "case", "default", "do", "else", "return", "yield"]);

const canStartJsx: (previous: SourceToken | undefined) => boolean = (previous: SourceToken | undefined): boolean => {
    if (previous === (void 0)) {
        return true;
    }
    if (previous.kind === "punct") {
        return JsxPrecedingPunctuation.has(previous.value);
    }
    if (previous.kind === "identifier") {
        return JsxPrecedingKeywords.has(previous.value);
    }
    return false;
};

/**
 * Decide whether `<` opens JSX rather than a comparison or a generic. The check
 * is conservative: the previous token must allow an expression, the next token
 * must look like a tag name or fragment, and `<T,>` (the TSX generic-arrow
 * spelling) is rejected because a comma cannot follow a tag name.
 */
const looksLikeJsxStart: LooksLikeJsxStartFn = (text, start, previous): boolean => {
    if (!canStartJsx(previous)) {
        return false;
    }
    const next: string | undefined = text[start + 1];
    if (next === ">") {
        return true;
    }
    if (next === (void 0) || next === "/" || next === "!" || !isIdentifierStart(next)) {
        return false;
    }
    let index: number = start + 2;
    while (index < text.length && isJsxTagNamePart(text[index])) {
        index += 1;
    }
    const after: string | undefined = text[index];
    if (after === (void 0) || after === ",") {
        return false;
    }
    return after === ">" || after === "/" || after === "{" || isWhitespaceChar(after) || isIdentifierStart(after);
};

const scanRegexEnd: (text: string, start: number) => number = (text: string, start: number): number => {
    let index: number = start + 1;
    let inClass: boolean = false;
    while (index < text.length) {
        const char: string = text[index];
        if (char === "\\") {
            index += 2;
            continue;
        }
        if (char === "\n" || char === "\r") {
            return -1;
        }
        if (char === ";" && !inClass) {
            return -1;
        }
        if (char === "[") {
            inClass = true;
            index += 1;
            continue;
        }
        if (char === "]") {
            inClass = false;
            index += 1;
            continue;
        }
        if (char === "/" && !inClass) {
            index += 1;
            while (index < text.length && isIdentifierPart(text[index])) {
                index += 1;
            }
            return index;
        }
        index += 1;
    }
    return -1;
};

/**
 * Tokenize JavaScript/TypeScript well enough to find module keywords.
 *
 * Comments, strings, template literal text, JSX text and regular-expression
 * literals are consumed as opaque units, which is what makes pseudo-imports in
 * those regions invisible. `${...}` expressions inside a template and
 * `{...}` expressions inside JSX are tokenized recursively, so a real dynamic
 * import there is still reported. The scanner is not a full lexer:
 * regex-versus-division is resolved by attempting to close a regex before a
 * newline or semicolon; a lone division slash falls back to punctuation, and a
 * regex candidate never manufactures an edge because its body stays opaque.
 *
 * @param text - Decoded source text.
 * @param jsx - Whether JSX elements should be skipped as opaque regions.
 * @returns Tokens in source order, with 1-based line numbers.
 */
export const tokenizeSource: (text: string, jsx?: boolean) => SourceToken[] = (text: string, jsx: boolean = false): SourceToken[] => {
    const tokens: SourceToken[] = [];
    const appendExpressionTokens: AppendExpressionTokensFn = (expressions, baseLine, baseOffset, jsxMode): void => {
        for (let expressionIndex: number = 0; expressionIndex < expressions.length; expressionIndex += 1) {
            const expression: TemplateExpression = expressions[expressionIndex];
            const expressionLine: number = baseLine + countNewlines(text, baseOffset, expression.start);
            const expressionTokens: SourceToken[] = tokenizeSource(text.slice(expression.start, expression.end), jsxMode);
            for (let tokenIndex: number = 0; tokenIndex < expressionTokens.length; tokenIndex += 1) {
                const expressionToken: SourceToken = expressionTokens[tokenIndex];
                tokens.push({ kind: expressionToken.kind, value: expressionToken.value, line: expressionLine + expressionToken.line - 1 });
            }
        }
    };
    let index: number = 0;
    let line: number = 1;
    while (index < text.length) {
        const char: string = text[index];
        const next: string | undefined = text[index + 1];
        if (char === "\n") {
            line += 1;
            index += 1;
            continue;
        }
        if (char === " " || char === "\t" || char === "\r" || char === "\f" || char === "\v" || char === "\uFEFF") {
            index += 1;
            continue;
        }
        if (index === 0 && char === "#" && next === "!") {
            index = skipLineComment(text, index);
            continue;
        }
        if (char === "/" && next === "/") {
            index = skipLineComment(text, index);
            continue;
        }
        if (char === "/" && next === "*") {
            const end: number = skipBlockComment(text, index);
            line += countNewlines(text, index, end);
            index = end;
            continue;
        }
        if (char === "'" || char === '"') {
            const result: ScanStringResult = scanString(text, index);
            tokens.push({ kind: "string", value: result.value, line });
            line += countNewlines(text, index, result.end);
            index = result.end;
            continue;
        }
        if (char === "`") {
            const template: TemplateScan = scanTemplateRange(text, index);
            tokens.push({ kind: "template", value: text.slice(index, template.end), line });
            appendExpressionTokens(template.expressions, line, index, jsx);
            line += countNewlines(text, index, template.end);
            index = template.end;
            continue;
        }
        if (jsx && char === "<" && looksLikeJsxStart(text, index, tokens[tokens.length - 1])) {
            const element: JsxElementScan = scanJsxElement(text, index);
            if (element.closed) {
                appendExpressionTokens(element.expressions, line, index, true);
                line += countNewlines(text, index, element.end);
                index = element.end;
                continue;
            }
        }
        if (isIdentifierStart(char)) {
            let end: number = index + 1;
            while (end < text.length && isIdentifierPart(text[end])) {
                end += 1;
            }
            tokens.push({ kind: "identifier", value: text.slice(index, end), line });
            index = end;
            continue;
        }
        if (isDigit(char)) {
            let end: number = index + 1;
            while (end < text.length) {
                const part: string = text[end];
                const exponentSign: boolean = (part === "+" || part === "-") && (text[end - 1] === "e" || text[end - 1] === "E");
                if (!isIdentifierPart(part) && part !== "." && !exponentSign) {
                    break;
                }
                end += 1;
            }
            index = end;
            continue;
        }
        if (char === "/") {
            const end: number = scanRegexEnd(text, index);
            if (end !== -1) {
                line += countNewlines(text, index, end);
                index = end;
                continue;
            }
        }
        tokens.push({ kind: "punct", value: char, line });
        index += 1;
    }
    return tokens;
};

const stringValueOf: (token: SourceToken | undefined) => string | undefined = (token: SourceToken | undefined): string | undefined => {
    if (token === (void 0)) {
        return (void 0);
    }
    if (token.kind === "string") {
        return token.value;
    }
    if (token.kind === "template" && token.value.length >= 2 && token.value.startsWith("`") && token.value.endsWith("`") && !token.value.includes("${")) {
        return token.value.slice(1, -1);
    }
    return (void 0);
};

const findFromIndex: (tokens: readonly SourceToken[], start: number) => number = (tokens: readonly SourceToken[], start: number): number => {
    let depth: number = 0;
    for (let index: number = start; index < tokens.length; index += 1) {
        const token: SourceToken = tokens[index];
        if (token.kind === "punct") {
            if (token.value === "{" || token.value === "[" || token.value === "(") {
                depth += 1;
                continue;
            }
            if (token.value === "}" || token.value === "]" || token.value === ")") {
                if (depth > 0) {
                    depth -= 1;
                }
                continue;
            }
            if (depth === 0 && (token.value === ";" || token.value === "=")) {
                return -1;
            }
            continue;
        }
        if (depth !== 0 || token.kind !== "identifier") {
            continue;
        }
        if (token.value === "from") {
            return index;
        }
        if (token.value === "import" || token.value === "export") {
            return -1;
        }
    }
    return -1;
};

const importFactAt: ImportFactReader = (tokens, index): ParsedImportFact | undefined => {
    const token: SourceToken = tokens[index];
    if (isMemberAccess(tokens[index - 1])) {
        return (void 0);
    }
    const first: SourceToken | undefined = tokens[index + 1];
    if (first === (void 0)) {
        return (void 0);
    }
    const line: number = token.line;
    if (first.kind === "punct") {
        if (first.value === "(") {
            const specifier: string | undefined = stringValueOf(tokens[index + 2]);
            return specifier === (void 0) ? (void 0) : { specifier, kind: "dynamic", line };
        }
        if (first.value !== "{" && first.value !== "*") {
            return (void 0);
        }
    }
    if (first.kind === "string") {
        return { specifier: first.value, kind: "static", line };
    }
    let cursor: number = index + 1;
    let kind: ImportKind = "static";
    if (first.kind === "identifier" && first.value === "type") {
        const after: SourceToken | undefined = tokens[cursor + 1];
        const bindingNamedFrom: boolean = after !== (void 0) && after.kind === "identifier" && after.value === "from";
        if (!bindingNamedFrom) {
            kind = "type";
            cursor += 1;
        }
    }
    const fromIndex: number = findFromIndex(tokens, cursor);
    if (fromIndex === -1) {
        return (void 0);
    }
    const specifier: string | undefined = stringValueOf(tokens[fromIndex + 1]);
    return specifier === (void 0) ? (void 0) : { specifier, kind, line };
};

const requireFactAt: ImportFactReader = (tokens, index): ParsedImportFact | undefined => {
    if (isMemberAccess(tokens[index - 1])) {
        return (void 0);
    }
    const open: SourceToken | undefined = tokens[index + 1];
    if (open === (void 0) || open.kind !== "punct" || open.value !== "(") {
        return (void 0);
    }
    const specifier: string | undefined = stringValueOf(tokens[index + 2]);
    return specifier === (void 0) ? (void 0) : { specifier, kind: "require", line: tokens[index].line };
};

/**
 * Recognise `export ... from "specifier"` as a dependency edge.
 *
 * A star clause and a named clause take different shapes, but both end in
 * `from "specifier"`. The `type` modifier is skipped only when it precedes the
 * star or brace; `export type Foo = ...` is a declaration, not an edge.
 */
const exportFromFactAt: ImportFactReader = (tokens, index): ParsedImportFact | undefined => {
    if (isMemberAccess(tokens[index - 1])) {
        return (void 0);
    }
    let cursor: number = index + 1;
    const first: SourceToken | undefined = tokens[cursor];
    if (
        first !== (void 0) &&
        first.kind === "identifier" &&
        first.value === "type" &&
        tokens[cursor + 1] !== (void 0) &&
        tokens[cursor + 1].kind === "punct" &&
        (tokens[cursor + 1].value === "{" || tokens[cursor + 1].value === "*")
    ) {
        cursor += 1;
    }
    const head: SourceToken | undefined = tokens[cursor];
    if (head === (void 0) || head.kind !== "punct") {
        return (void 0);
    }
    if (head.value === "*") {
        cursor += 1;
        const asToken: SourceToken | undefined = tokens[cursor];
        if (asToken !== (void 0) && asToken.kind === "identifier" && asToken.value === "as") {
            cursor += 2;
        }
    } else if (head.value === "{") {
        let depth: number = 1;
        cursor += 1;
        while (cursor < tokens.length && depth > 0) {
            const token: SourceToken = tokens[cursor];
            if (token.kind === "punct" && token.value === "{") {
                depth += 1;
            } else if (token.kind === "punct" && token.value === "}") {
                depth -= 1;
            }
            cursor += 1;
        }
    } else {
        return (void 0);
    }
    const fromToken: SourceToken | undefined = tokens[cursor];
    if (fromToken === (void 0) || fromToken.kind !== "identifier" || fromToken.value !== "from") {
        return (void 0);
    }
    const specifier: string | undefined = stringValueOf(tokens[cursor + 1]);
    return specifier === (void 0) ? (void 0) : { specifier, kind: "export-from", line: tokens[index].line };
};

const collectImportFacts: (tokens: readonly SourceToken[]) => ParsedImportFact[] = (tokens: readonly SourceToken[]): ParsedImportFact[] => {
    const facts: ParsedImportFact[] = [];
    for (let index: number = 0; index < tokens.length; index += 1) {
        const token: SourceToken = tokens[index];
        if (token.kind !== "identifier") {
            continue;
        }
        if (token.value === "import") {
            const fact: ParsedImportFact | undefined = importFactAt(tokens, index);
            if (fact !== (void 0)) {
                facts.push(fact);
            }
            continue;
        }
        if (token.value === "require") {
            const fact: ParsedImportFact | undefined = requireFactAt(tokens, index);
            if (fact !== (void 0)) {
                facts.push(fact);
            }
            continue;
        }
        if (token.value === "export") {
            const fact: ParsedImportFact | undefined = exportFromFactAt(tokens, index);
            if (fact !== (void 0)) {
                facts.push(fact);
            }
        }
    }
    return facts;
};

const isRelativeSpecifier: (specifier: string) => boolean = (specifier: string): boolean =>
    specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");

const baseDirectory: (path: string) => string = (path: string): string => {
    const slash: number = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
};

const normalizeRelativeSpecifier: (from: string, specifier: string) => string | undefined = (from: string, specifier: string): string | undefined => {
    const directory: string = baseDirectory(from);
    const combined: string = directory.length === 0 ? specifier : `${directory}/${specifier}`;
    const segments: string[] = [];
    const parts: string[] = combined.split("/");
    for (let index: number = 0; index < parts.length; index += 1) {
        const part: string = parts[index];
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            if (segments.length === 0) {
                return (void 0);
            }
            segments.pop();
            continue;
        }
        segments.push(part);
    }
    return segments.join("/");
};

const isFileInside: (sandbox: PathSandbox, relative: string) => boolean = (sandbox: PathSandbox, relative: string): boolean => {
    try {
        const rooted: RootedPath = sandbox.resolve(relative, "read");
        return statSync(rooted.absolute).isFile();
    } catch {
        return false;
    }
};

const hasKnownExtension: (path: string) => boolean = (path: string): boolean => /\.(?:[cm]?[jt]sx?|json)$/.test(path);

const probeRelative: (sandbox: PathSandbox, base: string) => string | undefined = (sandbox: PathSandbox, base: string): string | undefined => {
    const exact: string = base.length === 0 ? "." : base;
    if (isFileInside(sandbox, exact)) {
        return base;
    }
    for (let index: number = 0; index < SourceExtensions.length; index += 1) {
        const candidate: string = `${base}${SourceExtensions[index]}`;
        if (isFileInside(sandbox, candidate)) {
            return candidate;
        }
    }
    const prefix: string = base.length === 0 ? "" : `${base}/`;
    for (let index: number = 0; index < SourceExtensions.length; index += 1) {
        const candidate: string = `${prefix}index${SourceExtensions[index]}`;
        if (isFileInside(sandbox, candidate)) {
            return candidate;
        }
    }
    return (void 0);
};

/**
 * Resolve one import specifier against a root-relative source file.
 *
 * Relative specifiers are normalized (never allowed to climb above the root)
 * and probed as exact path, extensionless, then directory index. An unresolved
 * relative specifier still reports a guessed path so a caller can show what was
 * tried; absolute specifiers keep their original spelling and stay unresolved;
 * bare specifiers are external by definition, including `node:*`.
 *
 * @param sandbox - Root-confined path resolver used for existence checks.
 * @param from - Root-relative path of the importing file.
 * @param specifier - Raw specifier text.
 * @returns Target path plus resolved/external flags.
 */
export const resolveImportSpecifier: ResolveImportSpecifierFn = (sandbox, from, specifier): ResolvedSpecifier => {
    if (specifier.trim().length === 0) {
        return { to: "", resolved: false, external: false };
    }
    if (specifier.startsWith("/")) {
        return { to: specifier, resolved: false, external: false };
    }
    if (!isRelativeSpecifier(specifier)) {
        return { to: specifier, resolved: true, external: true };
    }
    const base: string | undefined = normalizeRelativeSpecifier(from, specifier);
    if (base === (void 0)) {
        return { to: specifier, resolved: false, external: false };
    }
    const found: string | undefined = probeRelative(sandbox, base);
    if (found !== (void 0)) {
        return { to: found, resolved: true, external: false };
    }
    const directoryLike: boolean = specifier === "." || specifier.endsWith("/");
    const guess: string = directoryLike ? (base.length === 0 ? "index.ts" : `${base}/index.ts`) : hasKnownExtension(base) ? base : `${base}.ts`;
    return { to: guess, resolved: false, external: false };
};

/**
 * Extract module edges for one file.
 *
 * Supported forms are static imports (including side-effect imports), type-only
 * imports, `export ... from`, dynamic `import()` and `require()`. Files with a
 * non-JS/TS extension are still read and fingerprinted but produce an empty
 * edge list. `importedBy` is left empty for the service/graph layer to fill.
 *
 * @param sandbox - Root-confined path resolver.
 * @param path - Root-relative file path.
 * @returns Import report for the file.
 */
export const extractImports: ExtractImportsFn = (sandbox, path): ImportReport => {
    const source: SourceFileSnapshot = readSourceFile(sandbox, path);
    if (!isParseableSource(source.path)) {
        return {
            path: source.path,
            fingerprint: source.fingerprint,
            imports: [],
            importedBy: [],
            external: [],
            unresolved: [],
            truncated: false,
        };
    }
    const facts: ParsedImportFact[] = collectImportFacts(tokenizeSource(source.text, isJsxSource(source.path)));
    const imports: ImportEdge[] = [];
    const external: string[] = [];
    const unresolved: string[] = [];
    const seenExternal: Set<string> = new Set<string>();
    const seenUnresolved: Set<string> = new Set<string>();
    for (let index: number = 0; index < facts.length; index += 1) {
        const fact: ParsedImportFact = facts[index];
        const resolution: ResolvedSpecifier = resolveImportSpecifier(sandbox, source.path, fact.specifier);
        imports.push({
            from: source.path,
            to: resolution.to,
            specifier: fact.specifier,
            kind: fact.kind,
            line: fact.line,
            resolved: resolution.resolved,
            external: resolution.external,
        });
        if (resolution.external && !seenExternal.has(fact.specifier)) {
            seenExternal.add(fact.specifier);
            external.push(fact.specifier);
        }
        if (!resolution.resolved && !seenUnresolved.has(fact.specifier)) {
            seenUnresolved.add(fact.specifier);
            unresolved.push(fact.specifier);
        }
    }
    return {
        path: source.path,
        fingerprint: source.fingerprint,
        imports,
        importedBy: [],
        external,
        unresolved,
        truncated: false,
    };
};

/**
 * Build the reverse edge list for one target from a set of candidate files.
 *
 * Candidates that cannot be read (missing, binary, over quota) are skipped
 * rather than failing the whole reverse lookup: one unreadable file must not
 * make "who imports this?" unavailable. Duplicate edges are removed while
 * preserving candidate order.
 *
 * @param sandbox - Root-confined path resolver.
 * @param target - Root-relative target file.
 * @param candidates - Root-relative files to inspect.
 * @returns Edges that resolve to `target`.
 */
export const importedBy: ImportedByFn = (sandbox, target, candidates): ImportEdge[] => {
    let normalized: string;
    try {
        normalized = sandbox.resolve(target, "read").relative;
    } catch {
        return [];
    }
    const edges: ImportEdge[] = [];
    const seen: Set<string> = new Set<string>();
    for (let index: number = 0; index < candidates.length; index += 1) {
        let report: ImportReport;
        try {
            report = extractImports(sandbox, candidates[index]);
        } catch {
            continue;
        }
        for (let edgeIndex: number = 0; edgeIndex < report.imports.length; edgeIndex += 1) {
            const edge: ImportEdge = report.imports[edgeIndex];
            if (edge.external || !edge.resolved || edge.to !== normalized) {
                continue;
            }
            const key: string = `${edge.from}|${edge.to}|${edge.line}|${edge.specifier}|${edge.kind}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            edges.push(edge);
        }
    }
    return edges;
};
