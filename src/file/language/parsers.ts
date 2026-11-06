import { SynchronousUnorderedMap, SynchronousUnorderedSet, isString } from "semantic-typescript";
import type { OutlineNodeKind, OutlineParserPort, ParsedOutlineNode } from "../outline.ts";
import { SourceText, type Range } from "../range.ts";

/**
 * Dependency-free structural outline scanners. They read declaration shape only:
 * no compilation, type checking or evaluation is performed.
 */
export type ScanMode = "text" | "markdown" | "tex" | "javascript" | "typescript" | "c" | "cpp" | "java"
    | "csharp" | "python" | "sql" | "html" | "vue" | "css" | "scss" | "sass" | "swift" | "go";

type OutlineKind = Exclude<OutlineNodeKind, "file">;

interface Found {
    readonly kind: OutlineKind;
    readonly name: string;
    readonly start: number;
    end: number;
    readonly level?: number;
    readonly children?: readonly Found[];
    /** Explicit owner for declarations the text cannot contain, such as Go methods. */
    parent?: Found;
}

interface MaskString {
    readonly open: string;
    readonly close: string;
    readonly escape: boolean;
    readonly multiline: boolean;
    /** Keep the literal text in place; used when a later rule must read string contents (Go imports). */
    readonly preserve?: boolean;
}
interface MaskRules {
    readonly lineComments: readonly string[];
    readonly blockComments: readonly { readonly open: string; readonly close: string }[];
    readonly strings: readonly MaskString[];
}

const NOT_METHOD = new SynchronousUnorderedSet<string>([
    "if", "for", "while", "switch", "catch", "return", "sizeof", "do", "else", "new", "delete", "throw", "case", "when",
    "try", "finally", "foreach", "lock", "using", "typeof", "await", "yield", "super", "this", "function", "class",
    "const", "let", "var", "import", "export", "default", "interface", "type", "enum", "namespace", "package", "struct",
]);

function blank(chars: string[], start: number, end: number): void {
    for (let index = start; index < end; index += 1) {
        const char = chars[index];
        if (char !== "\n" && char !== "\r") chars[index] = " ";
    }
}

function maskWith(source: string, rules: MaskRules): string {
    const chars = source.split("");
    let index = 0;
    while (index < source.length) {
        const line = rules.lineComments.find(token => source.startsWith(token, index)
            && !(token === "//" && source[index - 1] === ":"));
        if (line) {
            const end = source.indexOf("\n", index);
            blank(chars, index, end < 0 ? source.length : end);
            index = end < 0 ? source.length : end;
            continue;
        }
        const block = rules.blockComments.find(token => source.startsWith(token.open, index));
        if (block) {
            const close = source.indexOf(block.close, index + block.open.length);
            const end = close < 0 ? source.length : close + block.close.length;
            blank(chars, index, end);
            index = end;
            continue;
        }
        const string = rules.strings.find(token => source.startsWith(token.open, index));
        if (string) {
            const end = stringEnd(source, index, string);
            if (!string.preserve) blank(chars, index, end);
            index = Math.max(end, index + string.open.length);
            continue;
        }
        index += 1;
    }
    return chars.join("");
}

function stringEnd(source: string, start: number, rule: MaskString): number {
    let cursor = start + rule.open.length;
    while (cursor < source.length) {
        if (rule.escape && source[cursor] === "\\") { cursor += 2; continue; }
        if (source.startsWith(rule.close, cursor)) {
            if (!rule.escape && source.startsWith(rule.close + rule.close, cursor)) { cursor += rule.close.length * 2; continue; }
            return cursor + rule.close.length;
        }
        if (!rule.multiline && source[cursor] === "\n") return cursor;
        cursor += 1;
    }
    return source.length;
}

function swiftStringEnd(source: string, start: number): number {
    let cursor = start + 1;
    while (cursor < source.length) {
        const char = source[cursor];
        if (char === "\\") {
            cursor = source[cursor + 1] === "(" ? swiftInterpolationEnd(source, cursor + 2) : cursor + 2;
            continue;
        }
        if (char === '"') return cursor + 1;
        if (char === "\n") return cursor;
        cursor += 1;
    }
    return source.length;
}

/** Skips a `\(...)` interpolation body; nested strings are consumed as opaque content. */
function swiftInterpolationEnd(source: string, start: number): number {
    let depth = 1;
    let cursor = start;
    while (cursor < source.length && depth > 0) {
        const char = source[cursor];
        if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
        else if (char === '"') { cursor = swiftStringEnd(source, cursor); continue; }
        else if (char === "\\") { cursor += 2; continue; }
        cursor += 1;
    }
    return cursor;
}

function maskSwift(source: string): string {
    const chars = source.split("");
    let index = 0;
    while (index < source.length) {
        if (source.startsWith("//", index)) {
            const end = source.indexOf("\n", index);
            blank(chars, index, end < 0 ? source.length : end);
            index = end < 0 ? source.length : end;
            continue;
        }
        if (source.startsWith("/*", index)) {
            let depth = 0;
            let cursor = index;
            while (cursor < source.length) {
                if (source.startsWith("/*", cursor)) { depth += 1; cursor += 2; continue; }
                if (source.startsWith("*/", cursor)) {
                    depth -= 1;
                    cursor += 2;
                    if (depth === 0) break;
                    continue;
                }
                cursor += 1;
            }
            const end = Math.min(cursor, source.length);
            blank(chars, index, end);
            index = end;
            continue;
        }
        if (source.startsWith('"""', index)) {
            const close = source.indexOf('"""', index + 3);
            const end = close < 0 ? source.length : close + 3;
            blank(chars, index, end);
            index = end;
            continue;
        }
        if (source[index] === '"') {
            const end = swiftStringEnd(source, index);
            blank(chars, index, end);
            index = Math.max(end, index + 1);
            continue;
        }
        index += 1;
    }
    return chars.join("");
}

/** Blanks `@Attribute` / `@Attribute(...)` prefixes so declaration patterns stay line-anchored. */
function maskSwiftAttributes(masked: string): string {
    const chars = masked.split("");
    for (const match of masked.matchAll(/@[A-Za-z_]\w*(?:\([^()\n]*\))?/g)) {
        const start = match.index ?? 0;
        blank(chars, start, start + match[0].length);
    }
    return chars.join("");
}

function maskMarkdown(source: string): string {
    const chars = source.split("");
    let fence: { readonly marker: string; readonly length: number } | undefined;
    let cursor = 0;
    while (cursor < source.length) {
        const end = source.indexOf("\n", cursor);
        const lineEnd = end < 0 ? source.length : end;
        const line = source.slice(cursor, lineEnd);
        const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.length) fence = undefined;
            blank(chars, cursor, lineEnd);
        } else if (match) {
            fence = { marker: match[1]![0]!, length: match[1]!.length };
            blank(chars, cursor, lineEnd);
        }
        cursor = lineEnd + 1;
    }
    return chars.join("");
}

function maskHtml(source: string): string {
    const chars = source.split("");
    for (const match of source.matchAll(/<!--[\s\S]*?-->/g)) blank(chars, match.index ?? 0, (match.index ?? 0) + match[0].length);
    for (const match of source.matchAll(/<(script|style)\b[^>]*>/gi)) {
        const open = (match.index ?? 0) + match[0].length;
        const closeMatch = new RegExp(`</${match[1]}>`, "i").exec(source.slice(open));
        blank(chars, open, closeMatch ? open + closeMatch.index : source.length);
    }
    return chars.join("");
}

function goRules(preserveImports: boolean): MaskRules {
    // Go raw strings (`...`) have no escapes and may span lines, so they are always masked whole.
    return { lineComments: ["//"], blockComments: [{ open: "/*", close: "*/" }],
        strings: [
            { open: "`", close: "`", escape: false, multiline: true },
            { open: '"', close: '"', escape: true, multiline: false, preserve: preserveImports },
            { open: "'", close: "'", escape: true, multiline: false },
        ] };
}

function familyRules(mode: ScanMode): MaskRules {
    if (mode === "go") return goRules(false);
    if (mode === "python") {
        return { lineComments: ["#"], blockComments: [],
            strings: [
                { open: '"""', close: '"""', escape: true, multiline: true },
                { open: "'''", close: "'''", escape: true, multiline: true },
                { open: '"', close: '"', escape: true, multiline: false },
                { open: "'", close: "'", escape: true, multiline: false },
            ] };
    }
    if (mode === "sql") {
        return { lineComments: ["--"], blockComments: [{ open: "/*", close: "*/" }],
            strings: [{ open: "'", close: "'", escape: false, multiline: true }] };
    }
    if (mode === "css" || mode === "scss" || mode === "sass") {
        return { lineComments: mode === "css" ? [] : ["//"], blockComments: [{ open: "/*", close: "*/" }],
            strings: [{ open: '"', close: '"', escape: true, multiline: false }, { open: "'", close: "'", escape: true, multiline: false }] };
    }
    if (mode === "tex") return { lineComments: ["%"], blockComments: [], strings: [] };
    const template = mode === "javascript" || mode === "typescript"
        ? [{ open: "`", close: "`", escape: true, multiline: true }] : [];
    return { lineComments: ["//"], blockComments: [{ open: "/*", close: "*/" }],
        strings: [...template,
            { open: '"', close: '"', escape: true, multiline: false },
            { open: "'", close: "'", escape: true, multiline: false }] };
}

function mask(source: string, mode: ScanMode): string {
    if (mode === "text") return source;
    if (mode === "markdown") return maskMarkdown(source);
    if (mode === "html" || mode === "vue") return maskHtml(source);
    if (mode === "swift") return maskSwift(source);
    return maskWith(source, familyRules(mode));
}

function lineEndOf(source: string, index: number): number {
    const end = source.indexOf("\n", index);
    return end < 0 ? source.length : end;
}

function braceEnd(masked: string, open: number): number {
    let depth = 0;
    let index = open;
    while (index < masked.length) {
        const char = masked[index];
        if (char === "{") depth += 1;
        else if (char === "}") {
            depth -= 1;
            if (depth === 0) return index + 1;
        }
        index += 1;
    }
    return masked.length;
}

function declarationEnd(masked: string, from: number): number {
    const firstLine = lineEndOf(masked, from);
    let depth = 0;
    let newlines = 0;
    let index = from;
    while (index < masked.length) {
        const char = masked[index];
        if (char === "(") depth += 1;
        else if (char === ")") depth = Math.max(0, depth - 1);
        else if (depth === 0 && char === "{") return braceEnd(masked, index);
        else if (depth === 0 && char === ";") return index + 1;
        else if (char === "\n") {
            newlines += 1;
            if (newlines > 8 || (depth === 0 && index > firstLine)) return firstLine;
        }
        index += 1;
    }
    return Math.max(firstLine, from);
}

function indentation(masked: string, lineStart: number): number {
    let index = lineStart;
    while (index < masked.length && (masked[index] === " " || masked[index] === "\t")) index += 1;
    return index - lineStart;
}

function indentEnd(masked: string, lineStart: number): number {
    const firstEnd = lineEndOf(masked, lineStart);
    const base = indentation(masked, lineStart);
    let end = firstEnd;
    let cursor = firstEnd + 1;
    while (cursor < masked.length) {
        const currentEnd = lineEndOf(masked, cursor);
        const content = masked.slice(cursor, currentEnd);
        if (content.trim() !== "" && indentation(masked, cursor) <= base) break;
        if (content.trim() !== "") end = currentEnd;
        cursor = currentEnd + 1;
    }
    return Math.max(end, firstEnd);
}

function sqlEnd(masked: string, from: number): number {
    const token = /\b(BEGIN|CASE|IF|LOOP|END)\b|;/gi;
    token.lastIndex = from;
    let depth = 0;
    for (let match = token.exec(masked); match !== null; match = token.exec(masked)) {
        const word = (match[1] ?? "").toUpperCase();
        if (word === "END") {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (word !== "") { depth += 1; continue; }
        if (depth === 0) return (match.index ?? 0) + 1;
    }
    return lineEndOf(masked, from);
}

function attribute(openTag: string, name: string): string | undefined {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
    const match = pattern.exec(openTag);
    return match ? (match[2] ?? match[3] ?? match[4]) : undefined;
}

const VOID_TAGS = new SynchronousUnorderedSet<string>(["area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr"]);

const SEMANTIC_TAGS = new SynchronousUnorderedSet<string>(["html", "head", "body", "main", "header", "footer", "nav",
    "section", "article", "aside", "form", "table", "ul", "ol", "template", "script", "style", "title", "h1", "h2", "h3",
    "h4", "h5", "h6", "dialog", "details", "figure", "fieldset"]);

function htmlTagEnd(masked: string, tag: string, openTagEnd: number): number {
    if (VOID_TAGS.contains(tag)) return openTagEnd;
    const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    pattern.lastIndex = openTagEnd;
    let depth = 1;
    for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
        const selfClosing = /\/>\s*$/.test(match[0]) || VOID_TAGS.contains(tag);
        if (match[1] === "/") {
            depth -= 1;
            if (depth === 0) return (match.index ?? 0) + match[0].length;
        } else if (!selfClosing) depth += 1;
    }
    return masked.length;
}

function htmlLabel(tag: string, openTag: string): string {
    const id = attribute(openTag, "id");
    const classes = attribute(openTag, "class");
    const suffix = id ? `#${id}` : classes ? `.${classes.trim().split(/\s+/).join(".")}` : "";
    return `${tag}${suffix}`;
}

function collectHtmlList(masked: string): Found[] {
    const into: Found[] = [];
    collectHtml(masked, 0, into);
    return into;
}

function collectHtml(masked: string, from: number, into: Found[]): void {
    const pattern = /<([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    pattern.lastIndex = from;
    for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
        const tag = match[1]!.toLowerCase();
        const start = match.index;
        const openTag = match[0];
        const selfClosing = /\/>\s*$/.test(openTag) || VOID_TAGS.contains(tag);
        const hasIdentity = attribute(openTag, "id") !== undefined || attribute(openTag, "class") !== undefined;
        if (hasIdentity || SEMANTIC_TAGS.contains(tag)) {
            into.push({ kind: "symbol", name: htmlLabel(tag, openTag), start,
                end: selfClosing ? start + openTag.length : htmlTagEnd(masked, tag, start + openTag.length) });
        }
        if (selfClosing) pattern.lastIndex = start + openTag.length;
    }
}

function collectText(source: string): Found[] {
    const found: Found[] = [];
    let cursor = 0;
    while (cursor < source.length) {
        const end = lineEndOf(source, cursor);
        if (source.slice(cursor, end).trim() === "") { cursor = end + 1; continue; }
        const start = cursor;
        let last = end;
        let next = end + 1;
        while (next < source.length) {
            const currentEnd = lineEndOf(source, next);
            if (source.slice(next, currentEnd).trim() === "") break;
            last = currentEnd;
            next = currentEnd + 1;
        }
        const name = source.slice(start, last).trim().split("\n")[0]!.slice(0, 80);
        found.push({ kind: "symbol", name, start, end: last });
        cursor = last + 1;
    }
    return found;
}

function collectMarkdown(masked: string, source: string): Found[] {
    const text = new SourceText(source);
    const headings: Found[] = [];
    for (const match of masked.matchAll(/^( {0,3})(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
        const name = (match[3] ?? "").trim();
        if (!name) continue;
        const start = match.index ?? 0;
        headings.push({ kind: "heading", name, start, end: lineEndOf(masked, start), level: match[2]!.length });
    }
    return closeSections(headings, masked.length, text);
}

function closeSections(items: Found[], length: number, text: SourceText): Found[] {
    return items.map((item, index) => {
        const level = item.level ?? 0;
        const next = items.slice(index + 1).find(other => (other.level ?? 0) <= level);
        const endLine = next ? text.lineAt(next.start) : text.lineCount;
        const startLine = text.lineAt(item.start);
        const start = text.lineStarts[startLine] ?? item.start;
        const end = (text.lineStarts[endLine] ?? length);
        return { ...item, start, end: Math.max(end, item.end) };
    });
}

function collectTex(masked: string, source: string): Found[] {
    const text = new SourceText(source);
    const levels: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4,
        paragraph: 5, subparagraph: 6 };
    const items: Found[] = [];
    for (const match of masked.matchAll(/^[ \t]*\\(subparagraph|subsubsection|paragraph|subsection|section|chapter|part)\*?[ \t]*\{([^{}\n]+)\}/gm)) {
        const name = match[2]!.trim();
        if (!name) continue;
        const start = match.index ?? 0;
        items.push({ kind: "heading", name, start, end: lineEndOf(masked, start), level: levels[match[1]!] ?? 9 });
    }
    return closeSections(items, masked.length, text);
}

function keywordName(candidate: string | undefined): string | undefined {
    const name = candidate?.trim();
    if (!name || NOT_METHOD.contains(name)) return undefined;
    return name;
}

function collectEcmaScript(masked: string, typescript: boolean, raw: string = masked): Found[] {
    const found: Found[] = [];
    const add = (pattern: RegExp, group = 1, kind: OutlineKind = "symbol", target: string = masked): void => {
        for (const match of target.matchAll(pattern)) {
            const name = keywordName(match[group]);
            if (!name) continue;
            const start = match.index ?? 0;
            found.push({ kind, name, start, end: declarationEnd(masked, start + match[0].length - 1) });
        }
    };
    add(/^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)/gm);
    add(/^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)/gm);
    if (typescript) {
        add(/^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?interface[ \t]+([A-Za-z_$][\w$]*)/gm);
        add(/^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?type[ \t]+([A-Za-z_$][\w$]*)[ \t]*[=<]/gm);
        add(/^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(?:const[ \t]+)?enum[ \t]+([A-Za-z_$][\w$]*)/gm);
        add(/^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?namespace[ \t]+([A-Za-z_$][\w$]*)/gm);
    }
    add(/^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm);
    add(/^[ \t]*import[ \t][^\n]*?from[ \t]*["']([^"'\n]+)["']/gm, 1, "symbol", raw);
    add(/^[ \t]+(?:public[ \t]+|private[ \t]+|protected[ \t]+|static[ \t]+|readonly[ \t]+|abstract[ \t]+|async[ \t]+|override[ \t]+|declare[ \t]+|get[ \t]+|set[ \t]+|\*[ \t]*)*([A-Za-z_$#][\w$]*)[ \t]*\([^)\n]*\)[ \t]*(?::[^\n{;]+)?\{/gm);
    return found;
}

function collectCFamily(masked: string, mode: "c" | "cpp" | "java" | "csharp"): Found[] {
    const found: Found[] = [];
    const add = (pattern: RegExp, group = 1): void => {
        for (const match of masked.matchAll(pattern)) {
            const name = keywordName(match[group]);
            if (!name) continue;
            const start = match.index ?? 0;
            found.push({ kind: "symbol", name, start, end: declarationEnd(masked, start + match[0].length - 1) });
        }
    };
    add(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm);
    if (mode === "c" || mode === "cpp") {
        add(/^[ \t]*(?:typedef[ \t]+)?(?:struct|union|enum)[ \t]+([A-Za-z_]\w*)/gm);
        if (mode === "cpp") {
            add(/^[ \t]*(?:template[ \t]*<[^>\n]*>[ \t]*)?(?:class|struct)[ \t]+([A-Za-z_]\w*)/gm);
            add(/^[ \t]*namespace[ \t]+([A-Za-z_][\w:]*)/gm);
        }
    }
    if (mode === "java") {
        add(/^[ \t]*package[ \t]+([\w.]+)[ \t]*;/gm);
        add(/^[ \t]*(?:(?:public|final|abstract|sealed|non-sealed|static|strictfp)[ \t]+)*(?:class|interface|enum|record|@interface)[ \t]+([A-Za-z_$][\w$]*)/gm);
    }
    if (mode === "csharp") {
        add(/^[ \t]*namespace[ \t]+([\w.]+)/gm);
        add(/^[ \t]*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|ref|unsafe|new)[ \t]+)*(?:class|interface|enum|record|struct|delegate)[ \t]+([A-Za-z_]\w*)/gm);
    }
    const functionPattern = /^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|virtual|override|async|sealed|extern|inline|const|unsigned|signed|struct|enum|explicit|operator|noexcept)[ \t]+)*(?:[A-Za-z_][\w:<>,\[\]\*&\s]*[ \t\*&]+)+([A-Za-z_~][\w:~]*)[ \t]*\([^;{}\n]*\)[ \t]*(?:const[ \t]*)?(?:noexcept[ \t]*)?(?:throws[^{]+)?\{/gm;
    for (const match of masked.matchAll(functionPattern)) {
        const raw = match[1];
        const name = keywordName(raw?.split("::").at(-1));
        if (!name) continue;
        const start = match.index ?? 0;
        found.push({ kind: "symbol", name, start, end: declarationEnd(masked, start + match[0].length - 1) });
    }
    return found;
}

function collectPython(masked: string): Found[] {
    const found: Found[] = [];
    const add = (pattern: RegExp): void => {
        for (const match of masked.matchAll(pattern)) {
            const name = match[2]?.trim();
            if (!name) continue;
            const start = match.index ?? 0;
            const lineStart = start + (match[1]?.length ?? 0);
            found.push({ kind: "symbol", name, start: lineStart, end: indentEnd(masked, start) });
        }
    };
    add(/^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm);
    add(/^([ \t]*)class[ \t]+([A-Za-z_]\w*)/gm);
    return found;
}

const SWIFT_RESERVED = new SynchronousUnorderedSet<string>([
    "if", "else", "for", "while", "switch", "case", "default", "guard", "return", "break", "continue",
    "fallthrough", "repeat", "defer", "throw", "throws", "rethrows", "try", "catch", "do", "in", "is", "as",
    "where", "self", "Self", "super", "nil", "true", "false", "async", "await", "let", "var", "func",
    "init", "deinit", "subscript", "class", "struct", "enum", "protocol", "extension", "actor", "typealias",
    "import", "operator", "precedencegroup", "associatedtype", "inout", "mutating",
    "nonmutating", "static", "final", "override", "open", "public", "private", "fileprivate", "internal",
]);

const SWIFT_MODIFIER = "(?:public|private|fileprivate|internal|open|package|static|final|override|mutating"
    + "|nonmutating|lazy|weak|unowned|convenience|required|dynamic|indirect|nonisolated|optional|unsafe"
    + "|consuming|borrowing|distributed|class)(?:\\([^)\\n]*\\))?";
const SWIFT_MODIFIERS = `(?:${SWIFT_MODIFIER}[ \\t]+)*`;
const SWIFT_NAME = "`[^`\\n]+`|[A-Za-z_][A-Za-z0-9_]*";
const SWIFT_TYPE = new RegExp(`^[ \\t]*${SWIFT_MODIFIERS}(?:class|struct|enum|protocol|extension|actor)[ \\t]+`
    + `(${SWIFT_NAME}(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)`, "gm");
const SWIFT_FUNCTION = new RegExp(`^[ \\t]*${SWIFT_MODIFIERS}func[ \\t]+(${SWIFT_NAME})`, "gm");
const SWIFT_PROPERTY = new RegExp(`^[ \\t]*${SWIFT_MODIFIERS}(?:let|var)[ \\t]+(${SWIFT_NAME})`, "gm");
const SWIFT_TYPEALIAS = new RegExp(`^[ \\t]*${SWIFT_MODIFIERS}typealias[ \\t]+(${SWIFT_NAME})`, "gm");
const SWIFT_IMPORT = new RegExp(`^[ \\t]*${SWIFT_MODIFIERS}import[ \\t]+`
    + "(?:(?:class|struct|enum|protocol|typealias|func|let|var)[ \\t]+)?"
    + "([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)", "gm");
const SWIFT_INIT = new RegExp(`^[ \\t]*${SWIFT_MODIFIERS}init[?!]?[ \\t]*(?:<[^>\\n]*>)?[ \\t]*\\(`, "gm");
const SWIFT_DEINIT = new RegExp(`^[ \\t]*${SWIFT_MODIFIERS}deinit[ \\t]*\\{`, "gm");
const SWIFT_SUBSCRIPT = new RegExp(`^[ \\t]*${SWIFT_MODIFIERS}subscript[ \\t]*(?:<[^>\\n]*>)?[ \\t]*\\(`, "gm");

function swiftName(candidate: string | undefined): string | undefined {
    const raw = candidate?.trim();
    if (!raw) return undefined;
    if (raw.startsWith("`") && raw.endsWith("`")) {
        const name = raw.slice(1, -1).trim();
        return name || undefined;
    }
    return SWIFT_RESERVED.contains(raw) ? undefined : raw;
}

function collectSwift(masked: string): Found[] {
    const searchable = maskSwiftAttributes(masked);
    const found: Found[] = [];
    const block = (pattern: RegExp, group: number | undefined, fixed?: string): void => {
        for (const match of searchable.matchAll(pattern)) {
            const name = fixed ?? swiftName(group === undefined ? undefined : match[group]);
            if (!name) continue;
            const start = match.index ?? 0;
            found.push({ kind: "symbol", name, start, end: declarationEnd(searchable, start + match[0].length - 1) });
        }
    };
    const line = (pattern: RegExp): void => {
        for (const match of searchable.matchAll(pattern)) {
            const name = swiftName(match[1]);
            if (!name) continue;
            const start = match.index ?? 0;
            found.push({ kind: "symbol", name, start, end: lineEndOf(searchable, start) });
        }
    };
    block(SWIFT_TYPE, 1);
    block(SWIFT_FUNCTION, 1);
    block(SWIFT_INIT, undefined, "init");
    block(SWIFT_DEINIT, undefined, "deinit");
    block(SWIFT_SUBSCRIPT, undefined, "subscript");
    line(SWIFT_PROPERTY);
    line(SWIFT_TYPEALIAS);
    line(SWIFT_IMPORT);
    return found;
}

const GO_KEYWORDS = new SynchronousUnorderedSet<string>([
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go",
    "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type",
    "var",
]);

interface GoNamedNode {
    readonly name: string;
    readonly node: Found;
}

interface GoMethodNode {
    readonly receiver: string;
    readonly node: Found;
}

const GO_PACKAGE = /^[ \t]*package[ \t]+([A-Za-z_]\w*)/gm;
const GO_IMPORT_SINGLE = /^[ \t]*import[ \t]+(?:(?:[._]|[A-Za-z_]\w*)[ \t]+)?"([^"\n]+)"/gm;
const GO_IMPORT_BLOCK = /^[ \t]*import[ \t]*\(/gm;
const GO_TYPE = /^[ \t]*type[ \t]+([A-Za-z_]\w*)[ \t]*(?:\[[^\]\n]*\])?[ \t]*(?:=|[A-Za-z_*\[(<])/gm;
const GO_FUNC = /^[ \t]*func[ \t]+(?:\(([^)\n]*)\)[ \t]*)?([A-Za-z_]\w*)[ \t]*(?:\[[^\]\n]*\])?[ \t]*\(/gm;
const GO_VALUE = /^[ \t]*(?:const|var)[ \t]+([A-Za-z_]\w*)/gm;
const GO_GROUP = /^[ \t]*(const|var|type)[ \t]*\(/gm;
const GO_SPEC_NAME = /^[ \t]*([A-Za-z_]\w*)/;

function goName(candidate: string | undefined): string | undefined {
    const name = candidate?.trim();
    if (!name || GO_KEYWORDS.contains(name)) return undefined;
    return name;
}

/** Index of the `)` matching the `(` at `open`; strings and comments are already blanked. */
function parenEnd(masked: string, open: number): number {
    let depth = 0;
    let index = open;
    while (index < masked.length) {
        const char = masked[index];
        if (char === "(") depth += 1;
        else if (char === ")") {
            depth -= 1;
            if (depth === 0) return index;
        }
        index += 1;
    }
    return masked.length;
}

/**
 * Go declaration end: a body brace opens on the declaration line (or after a multi-line
 * signature); otherwise the declaration ends at the first newline outside any brackets. This
 * deliberately avoids the shared `declarationEnd` look-ahead, which would let a value-less
 * `var` spec swallow the next spec's composite literal.
 */
function goDeclarationEnd(masked: string, from: number): number {
    let depth = 0;
    let index = from;
    while (index < masked.length) {
        const char = masked[index];
        if (char === "(" || char === "[") depth += 1;
        else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
        else if (depth === 0 && char === "{") return braceEnd(masked, index);
        else if (char === "\n" && depth === 0) return index;
        index += 1;
    }
    return masked.length;
}

/** Base type name of a method receiver such as `s *Server` or `s *Server[T]`. */
function goReceiverName(receiver: string | undefined): string | undefined {
    const text = receiver?.replace(/\[[^\[\]\n]*\]/g, " ").trim();
    if (!text) return undefined;
    const identifiers = text.match(/[A-Za-z_]\w*/g);
    return identifiers?.at(-1);
}

/** Specs inside `const (...)`, `var (...)` and `type (...)`; only base-indented lines start a spec. */
function collectGoGroupSpecs(masked: string, open: number, close: number): Found[] {
    const lines: { readonly start: number; readonly indent: number; readonly text: string }[] = [];
    let cursor = open + 1;
    while (cursor < close) {
        const end = Math.min(lineEndOf(masked, cursor), close);
        const text = masked.slice(cursor, end);
        if (text.trim() !== "") lines.push({ start: cursor, indent: indentation(masked, cursor), text });
        cursor = end + 1;
    }
    if (lines.length === 0) return [];
    let base = Number.MAX_SAFE_INTEGER;
    for (const line of lines) base = Math.min(base, line.indent);
    const found: Found[] = [];
    for (const line of lines) {
        if (line.indent !== base) continue;
        const match = GO_SPEC_NAME.exec(line.text);
        const name = goName(match?.[1]);
        if (match === null || name === undefined) continue;
        const nameStart = line.start + match[0].length - match[1]!.length;
        const end = Math.min(goDeclarationEnd(masked, nameStart), close);
        if (end <= line.start) continue;
        found.push({ kind: "symbol", name, start: line.start, end });
    }
    return found;
}

/**
 * Go methods are declared beside their receiver type, not inside it, so plain text containment
 * cannot own them. Attach each method to the receiver type declared earlier in the file; the
 * outline range widening then keeps the parent span covering its methods.
 */
function attachGoMethods(types: readonly GoNamedNode[], methods: readonly GoMethodNode[]): void {
    if (types.length === 0 || methods.length === 0) return;
    for (const method of methods) {
        const owner = types.find(type => type.name === method.receiver && type.node.start < method.node.start);
        if (owner !== undefined) method.node.parent = owner.node;
    }
}

function collectGo(masked: string, imports: string): Found[] {
    const found: Found[] = [];
    const types: GoNamedNode[] = [];
    const methods: GoMethodNode[] = [];
    for (const match of masked.matchAll(GO_PACKAGE)) {
        const name = goName(match[1]);
        if (name === undefined) continue;
        const start = match.index ?? 0;
        found.push({ kind: "symbol", name, start, end: lineEndOf(masked, start) });
    }
    for (const match of imports.matchAll(GO_IMPORT_SINGLE)) {
        const name = match[1]?.trim();
        if (!name) continue;
        const start = match.index ?? 0;
        found.push({ kind: "symbol", name, start, end: lineEndOf(imports, start) });
    }
    for (const match of imports.matchAll(GO_IMPORT_BLOCK)) {
        const open = (match.index ?? 0) + match[0].length - 1;
        const close = parenEnd(imports, open);
        for (const path of imports.slice(open + 1, close).matchAll(/"([^"\n]+)"/g)) {
            const name = path[1]?.trim();
            if (!name) continue;
            const start = open + 1 + (path.index ?? 0);
            found.push({ kind: "symbol", name, start, end: lineEndOf(imports, start) });
        }
    }
    for (const match of masked.matchAll(GO_TYPE)) {
        const name = goName(match[1]);
        if (name === undefined) continue;
        const start = match.index ?? 0;
        const node: Found = { kind: "symbol", name, start, end: goDeclarationEnd(masked, start + match[0].length - 1) };
        found.push(node);
        types.push({ name, node });
    }
    for (const match of masked.matchAll(GO_GROUP)) {
        const keyword = match[1]!;
        const open = (match.index ?? 0) + match[0].length - 1;
        const close = parenEnd(masked, open);
        for (const spec of collectGoGroupSpecs(masked, open, close)) {
            found.push(spec);
            if (keyword === "type") types.push({ name: spec.name, node: spec });
        }
    }
    for (const match of masked.matchAll(GO_VALUE)) {
        const name = goName(match[1]);
        if (name === undefined) continue;
        const start = match.index ?? 0;
        found.push({ kind: "symbol", name, start, end: goDeclarationEnd(masked, start + match[0].length - 1) });
    }
    for (const match of masked.matchAll(GO_FUNC)) {
        const name = goName(match[2]);
        if (name === undefined) continue;
        const start = match.index ?? 0;
        const node: Found = { kind: "symbol", name, start, end: goDeclarationEnd(masked, start + match[0].length - 1) };
        found.push(node);
        const receiver = goReceiverName(match[1]);
        if (receiver !== undefined) methods.push({ receiver, node });
    }
    attachGoMethods(types, methods);
    return found;
}
function collectSql(masked: string): Found[] {
    const found: Found[] = [];
    const pattern = /^[ \t]*(?:CREATE|ALTER|DROP)[ \t]+(?:OR[ \t]+REPLACE[ \t]+)?(?:TEMP(?:ORARY)?[ \t]+)?(TABLE|VIEW|PROCEDURE|PROC|FUNCTION|TRIGGER|INDEX|TYPE|PACKAGE(?:[ \t]+BODY)?)[ \t]+(?:IF[ \t]+(?:NOT[ \t]+)?EXISTS[ \t]+)?("[^"\n]+"|`[^`\n]+`|\[[^\]\n]+\]|[\w.$#]+)/gim;
    for (const match of masked.matchAll(pattern)) {
        const raw = match[2] ?? "";
        const name = raw.startsWith("[") ? raw.slice(1, -1) : raw.startsWith("`") || raw.startsWith('"') ? raw.slice(1, -1) : raw;
        if (!name) continue;
        const start = match.index ?? 0;
        found.push({ kind: "symbol", name, start, end: sqlEnd(masked, start) });
    }
    return found;
}

function collectStyles(masked: string, mode: "css" | "scss" | "sass"): Found[] {
    const found: Found[] = [];
    const push = (name: string, start: number, end: number): void => { if (name.trim()) found.push({ kind: "symbol", name: name.trim(), start, end }); };
    if (mode === "sass") {
        for (const match of masked.matchAll(/^([ \t]*)\$([\w-]+)[ \t]*:/gm)) {
            const start = match.index ?? 0;
            push(`$${match[2]}`, start, indentEnd(masked, start));
        }
        for (const match of masked.matchAll(/^([ \t]*)@(mixin|function)[ \t]+([\w-]+)/gm)) {
            const start = match.index ?? 0;
            push(`@${match[2]} ${match[3]}`, start, indentEnd(masked, start));
        }
        for (const match of masked.matchAll(/^([ \t]*)@include[ \t]+([\w-]+)/gm)) {
            const start = match.index ?? 0;
            push(`@include ${match[2]}`, start, lineEndOf(masked, start));
        }
        for (const match of masked.matchAll(/^([ \t]*)([.#%][\w-][^{}\n]*?)[ \t]*$/gm)) {
            const start = match.index ?? 0;
            push(match[2]!, start, indentEnd(masked, start));
        }
        for (const match of masked.matchAll(/^([ \t]+)([\w-]+)[ \t]*:[ \t]*[^\n]*$/gm)) {
            const start = match.index ?? 0;
            push(match[2]!, start, lineEndOf(masked, start));
        }
        return found;
    }
    if (mode === "scss") {
        for (const match of masked.matchAll(/^([ \t]*)\$([\w-]+)[ \t]*:/gm)) push(`$${match[2]}`, match.index ?? 0, lineEndOf(masked, match.index ?? 0));
        for (const match of masked.matchAll(/^([ \t]*)@(mixin|function)[ \t]+([\w-]+)/gm)) {
            const start = match.index ?? 0;
            push(`@${match[2]} ${match[3]}`, start, declarationEnd(masked, start + match[0].length - 1));
        }
        for (const match of masked.matchAll(/^([ \t]*)@(include|extend)[ \t]+([^\n;{]+)/gm)) {
            const start = match.index ?? 0;
            push(`@${match[2]} ${match[3]!.trim()}`, start, lineEndOf(masked, start));
        }
    }
    for (const match of masked.matchAll(/^([ \t]*)([^{};\n@][^{};\n]*?)[ \t]*\{/gm)) {
        const selector = match[2]!.trim();
        if (!selector || selector.startsWith("--")) continue;
        const start = match.index ?? 0;
        const brace = masked.indexOf("{", start + (match[0].length - 1));
        push(selector, start, brace >= 0 ? braceEnd(masked, brace) : lineEndOf(masked, start));
    }
    for (const match of masked.matchAll(/^([ \t]*)@(media|supports|container|layer|keyframes|font-face|page|property|import|use|forward)[ \t]*([^{;\n]*)/gm)) {
        const start = match.index ?? 0;
        const label = `@${match[2]}${match[3]!.trim() ? ` ${match[3]!.trim()}` : ""}`;
        const brace = masked.indexOf("{", start);
        push(label, start, brace >= 0 && brace < lineEndOf(masked, start) + 1 ? braceEnd(masked, brace) : lineEndOf(masked, start));
    }
    return found;
}

function collectVue(masked: string, source: string): Found[] {
    const found: Found[] = [];
    for (const match of masked.matchAll(/<(template|script|style)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi)) {
        const tag = match[1]!.toLowerCase();
        const openTag = match[0];
        const start = match.index ?? 0;
        const contentStart = start + openTag.length;
        const closePattern = new RegExp(`</${tag}>`, "gi");
        closePattern.lastIndex = contentStart;
        const close = closePattern.exec(masked);
        const contentEnd = close ? close.index : source.length;
        const end = close ? close.index + close[0].length : source.length;
        const setup = tag === "script" && /\bsetup\b/i.test(openTag);
        const label = tag === "script" ? `script${setup ? " setup" : ""}` : tag;
        const children: Found[] = [];
        const inner = source.slice(contentStart, contentEnd);
        if (tag === "template") {
            children.push(...shift(collectHtmlList(maskHtml(inner)), contentStart));
        } else if (tag === "script") {
            const lang = (attribute(openTag, "lang") ?? "js").toLowerCase();
            const nested = collectEcmaScript(maskWith(inner, familyRules("typescript")), lang === "ts" || lang === "typescript" || lang === "tsx");
            children.push(...shift(nested, contentStart));
        } else {
            const lang = (attribute(openTag, "lang") ?? "css").toLowerCase();
            const nested = collectStyles(maskWith(inner, familyRules("css")), lang === "scss" ? "scss" : lang === "sass" ? "sass" : "css");
            children.push(...shift(nested, contentStart));
        }
        found.push({ kind: "symbol", name: label, start, end, children });
    }
    return found;
}

function shift(items: readonly Found[], offset: number): Found[] {
    return items.map(item => ({ ...item, start: item.start + offset, end: item.end + offset,
        ...(item.children ? { children: shift(item.children, offset) } : {}) }));
}

function collect(mode: ScanMode, source: string): Found[] {
    const masked = mask(source, mode);
    if (mode === "text") return collectText(source);
    if (mode === "markdown") return collectMarkdown(masked, source);
    if (mode === "tex") return collectTex(masked, source);
    if (mode === "javascript") return collectEcmaScript(masked, false, source);
    if (mode === "typescript") return collectEcmaScript(masked, true, source);
    if (mode === "python") return collectPython(masked);
    if (mode === "sql") return collectSql(masked);
    if (mode === "html") return collectHtmlList(masked);
    if (mode === "vue") return collectVue(masked, source);
    if (mode === "css" || mode === "scss" || mode === "sass") return collectStyles(masked, mode);
    if (mode === "swift") return collectSwift(masked);
    if (mode === "go") return collectGo(masked, maskWith(source, goRules(true)));
    return collectCFamily(masked, mode);
}

interface MutableNode {
    readonly id: string;
    readonly kind: OutlineKind;
    readonly name: string;
    readonly start: number;
    readonly end: number;
    readonly parentId?: string;
    range: Range;
}

function flatten(items: readonly Found[]): Found[] {
    const output: Found[] = [];
    for (const item of items) {
        output.push(item);
        if (item.children) output.push(...flatten(item.children));
    }
    return output;
}

export function createScanningParser(language: string, mode: ScanMode): OutlineParserPort {
    return Object.freeze({
        language,
        parse(source: string): readonly ParsedOutlineNode[] {
            if (!isString(source)) throw new TypeError("source must be a string");
            const text = new SourceText(source);
            const found = flatten(collect(mode, source)).filter(item => item.end > item.start);
            const sorted = found.slice().sort((left, right) => left.start - right.start || right.end - left.end
                || left.name.localeCompare(right.name));
            const occurrence = new SynchronousUnorderedMap<string, number>();
            const nodes: MutableNode[] = [];
            const stack: MutableNode[] = [];
            const assigned: { readonly found: Found; readonly id: string }[] = [];
            for (const item of sorted) {
                while (stack.length > 0 && stack.at(-1)!.end <= item.start) stack.pop();
                const key = `${item.kind}:${item.name}`;
                const count = occurrence.get(key).get(0) + 1;
                occurrence.put(key, count);
                const id = `${language}:${item.kind}:${encodeURIComponent(item.name)}:${count}:${item.start}`;
                const explicit = item.parent === undefined ? undefined
                    : assigned.find(entry => entry.found === item.parent)?.id;
                const node: MutableNode = {
                    id, kind: item.kind, name: item.name, start: item.start, end: item.end,
                    ...(explicit !== undefined ? { parentId: explicit }
                        : stack.length > 0 ? { parentId: stack.at(-1)!.id } : {}),
                    range: text.range(item.start, item.end),
                };
                nodes.push(node);
                assigned.push({ found: item, id });
                stack.push(node);
            }
            // Heuristic spans may clip a parent; widen parents so containment always holds.
            const byId = new SynchronousUnorderedMap<string, MutableNode>();
            for (const node of nodes) byId.put(node.id, node);
            for (const node of nodes) {
                let parent = node.parentId === undefined ? undefined : byId.get(node.parentId).orElse(undefined);
                while (parent) {
                    parent.range = {
                        startLine: Math.min(parent.range.startLine, node.range.startLine),
                        endLine: Math.max(parent.range.endLine, node.range.endLine),
                        startByte: Math.min(parent.range.startByte, node.range.startByte),
                        endByte: Math.max(parent.range.endByte, node.range.endByte),
                    };
                    parent = parent.parentId === undefined ? undefined : byId.get(parent.parentId).orElse(undefined);
                }
            }
            return Object.freeze(nodes.map(node => Object.freeze({
                id: node.id, kind: node.kind, name: node.name, summary: `${node.kind} ${node.name}`,
                ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
                range: Object.freeze(node.range),
            })));
        },
    });
}
