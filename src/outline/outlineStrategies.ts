/**
 * Built-in outline strategies.
 *
 * Every parser here is a pure function of decoded text. None of them touch the
 * filesystem, spawn a process or import a parser library: the repository ships
 * no third-party dependency for this domain and a bounded hand-written scanner
 * is enough for an outline, which needs declarations and ranges, not a full
 * grammar or a type checker.
 *
 * The strategies are registered in `builtinOutlineStrategies` in selection
 * priority order: exact manifests first, then code and document extensions,
 * then content sniffing, then the plain-text fallback. A parser reports its own
 * `depth` values so a Markdown `###` and a TeX `\subsection` keep their
 * document meaning even when the file starts at a deeper level than the usual
 * root. All labels and details are normalized and bounded by the registry, not
 * by the parser.
 */
import { LineIndex } from "../syntax/charset.ts";
import { DefaultOutlineKeywords } from "./outlineKeywords.ts";
import { ShellStrategy } from "./shellOutline.ts";
import { SqlStrategy } from "./sqlOutline.ts";
import { VisualBasicStrategy } from "./visualBasicOutline.ts";
import type { OutlineKind, OutlineNode } from "./types.ts";
import type { OutlineMatchInput, OutlineParseInput, OutlineStrategy } from "./strategy.ts";

/**
 * One decoded source with line helpers.
 */
interface SourceLines {
    readonly text: string;
    readonly lines: readonly string[];
    readonly starts: readonly number[];
    readonly totalLines: number;
}

/**
 * Optional scanner switches. Defaults model a C-family source file; a caller
 * that parses a hash-comment or template-heavy language overrides them.
 */
interface MaskOptions {
    readonly lineComments: readonly string[];
    readonly blockComments: boolean;
    readonly strings: boolean;
    readonly template: boolean;
    readonly tripleQuotes: boolean;
    readonly regex: boolean;
    /**
     * How a `'` is read. `string` (the default) follows the C family and starts a
     * single-quoted string; `lifetime` follows Rust and only masks a complete
     * character literal, leaving lifetimes such as `'a` untouched.
     */
    readonly apostrophe?: "string" | "lifetime";
    /**
     * Whether `r#"…"#` raw strings are masked, including embedded quotes and
     * line breaks. Rust enables this so a declaration-shaped line inside a raw
     * string stays hidden.
     */
    readonly rawStrings?: boolean;
    /**
     * Whether a `url(…)` function token is read as one opaque value. CSS
     * enables this so `//` inside a protocol-relative URL is value text rather
     * than a line comment, and a brace inside a `data:` URL cannot change the
     * block structure.
     */
    readonly url?: boolean;
}

/**
 * Masked source plus brace indexing. `masked` has the same length as the input,
 * so an offset in one string is an offset in the other; comments, strings and
 * regular-expression literals are replaced by spaces while line breaks survive.
 */
interface MaskedSource {
    readonly text: string;
    readonly masked: string;
    readonly starts: readonly number[];
    readonly depthAtLine: readonly number[];
    readonly close: ReadonlyMap<number, number>;
}

/**
 * Declarative description of one outline node. Parsers use it instead of
 * building object literals with five repeated fields.
 */
interface NodeSpec {
    readonly label: string;
    readonly kind: OutlineKind;
    readonly startLine: number;
    readonly endLine: number;
    readonly depth: number;
    readonly detail?: string;
    readonly modifiers?: readonly string[];
    readonly children?: readonly OutlineNode[];
}

/**
 * One heading-like entry before hierarchy assembly.
 */
interface FlatOutlineEntry {
    readonly label: string;
    readonly kind: OutlineKind;
    readonly startLine: number;
    readonly endLine: number;
    readonly depth: number;
    readonly detail?: string;
}

/**
 * Mutable tree node used only during assembly. `endLine` is filled in once the
 * closing brace of a container is known.
 */
interface DraftOutlineNode {
    readonly label: string;
    readonly kind: OutlineKind;
    readonly startLine: number;
    endLine: number;
    readonly depth: number;
    readonly detail?: string;
    readonly children: DraftOutlineNode[];
}

/**
 * Scanner defaults: C-family comments and strings, JavaScript template
 * literals and regular-expression literals, no Python/Java triple quotes.
 */
const DefaultMaskOptions: MaskOptions = {
    lineComments: ["//"],
    blockComments: true,
    strings: true,
    template: true,
    tripleQuotes: false,
    regex: true,
};

/**
 * Characters after which a `/` starts a regular-expression literal rather than
 * a division. The set is the usual expression-prefix heuristic; it is applied
 * only when the previous significant character is not an identifier.
 */
const RegexPrefixCharacters: string = "([{=,:;!&|?+-*%^~<>";

/**
 * Keywords after which a `/` starts a regular-expression literal.
 */
const RegexPrefixKeywords: ReadonlySet<string> = new Set<string>([
    "return",
    "typeof",
    "instanceof",
    "case",
    "in",
    "of",
    "delete",
    "void",
    "new",
    "do",
    "else",
    "yield",
    "await",
    "throw",
]);

/**
 * Line starts of a text, using `\n` as the only line separator so a `\r` is
 * still part of its line for offset purposes.
 */
const lineStartsOf: (text: string) => number[] = (text: string): number[] => {
    if (text.length === 0) {
        return [];
    }
    const starts: number[] = [0];
    for (let index: number = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10 && index + 1 < text.length) {
            starts.push(index + 1);
        }
    }
    return starts;
};

/**
 * Split into logical lines, dropping the phantom empty line a trailing
 * newline would otherwise create and stripping a trailing carriage return.
 */
const splitLines: (text: string) => string[] = (text: string): string[] => {
    if (text.length === 0) {
        return [];
    }
    const lines: string[] = text.split("\n");
    if (lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines.map((line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line));
};

/**
 * 1-based line number containing one absolute offset.
 */
const lineAtOffset: (starts: readonly number[], offset: number) => number = (starts: readonly number[], offset: number): number => {
    if (starts.length === 0) {
        return 1;
    }
    let low: number = 0;
    let high: number = starts.length - 1;
    while (low < high) {
        const middle: number = Math.ceil((low + high) / 2);
        if (starts[middle] <= offset) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return low + 1;
};

/**
 * Read a source once and keep its line views consistent.
 */
const readSourceLines: (text: string) => SourceLines = (text: string): SourceLines => {
    const lines: string[] = splitLines(text);
    return { text, lines, starts: lineStartsOf(text), totalLines: lines.length };
};

/**
 * Previous non-whitespace character before an offset.
 */
const significantBefore: (text: string, index: number) => string = (text: string, index: number): string => {
    for (let cursor: number = index - 1; cursor >= 0; cursor -= 1) {
        const character: string = text[cursor];
        if (!/\s/.test(character)) {
            return character;
        }
    }
    return "";
};

/**
 * Whether a `/` at one offset may open a regular-expression literal.
 */
const regexAllowed: (text: string, index: number) => boolean = (text: string, index: number): boolean => {
    const before: string = significantBefore(text, index);
    if (before.length === 0) {
        return true;
    }
    if (RegexPrefixCharacters.includes(before)) {
        return true;
    }
    if (before === "}") {
        return true;
    }
    if (/[A-Za-z0-9_$]/.test(before)) {
        const prefix: string = text.slice(Math.max(0, index - 64), index);
        const match: RegExpExecArray | null = /([A-Za-z_$][\w$]*)\s*$/.exec(prefix);
        if (match !== null && RegexPrefixKeywords.has(match[1])) {
            return true;
        }
    }
    return false;
};

/**
 * Mask comments, strings, template literals and regular-expression literals
 * while preserving every offset and line break.
 *
 * The scanner is deliberately single-pass and bounded: it never allocates a
 * token list, so a 4 MiB file costs one string of the same length. Unterminated
 * constructs run to the end of the text instead of throwing, because an outline
 * of a half-written file is still useful.
 */
/**
 * End offset (exclusive) of a Rust character literal at `index`, or -1 when the
 * apostrophe starts a lifetime instead.
 *
 * Rust lifetimes and character literals share `'`, so a literal is only accepted
 * when its body is exactly one scalar value (or one escape sequence) followed by
 * a closing quote. `'a`, `'static` and `&'a str` therefore stay lifetimes and no
 * longer hide the braces, fields and signature text that follow them.
 */
const rustCharLiteralEnd: (text: string, index: number) => number = (text: string, index: number): number => {
    const length: number = text.length;
    let cursor: number = index + 1;
    if (cursor >= length) {
        return -1;
    }
    const first: string = text[cursor];
    if (first === "\\") {
        cursor += 1;
        if (cursor >= length) {
            return -1;
        }
        const escape: string = text[cursor];
        if (escape === "u") {
            if (text[cursor + 1] !== "{") {
                return -1;
            }
            const closing: number = text.indexOf("}", cursor + 2);
            if (closing === -1) {
                return -1;
            }
            cursor = closing + 1;
        } else if (escape === "x") {
            cursor += 3;
        } else if (escape === "'" || escape === '"' || escape === "\\" || escape === "0" || escape === "n" || escape === "r" || escape === "t") {
            cursor += 1;
        } else {
            return -1;
        }
    } else if (first === "\n" || first === "'") {
        return -1;
    } else {
        const codePoint: number | undefined = text.codePointAt(cursor);
        if (codePoint === (void 0)) {
            return -1;
        }
        cursor += codePoint > 0xffff ? 2 : 1;
    }
    return cursor < length && text[cursor] === "'" ? cursor + 1 : -1;
};

/**
 * End offset (exclusive) of a Rust raw string starting at `index`, or -1 when
 * the `r` does not begin one.
 *
 * `r"…"` and `r#"…"#` (any hash count) are supported, including embedded
 * quotes and line breaks; a `b`/`c` prefix letter is simply left in place, so
 * `br#"…"#` works too. An unterminated raw string runs to the end of the text,
 * matching how the other scanners recover from a half-written file.
 */
const rustRawStringEnd: (text: string, index: number) => number = (text: string, index: number): number => {
    const length: number = text.length;
    let cursor: number = index + 1;
    let hashes: number = 0;
    while (text[cursor] === "#") {
        hashes += 1;
        cursor += 1;
    }
    if (text[cursor] !== '"') {
        return -1;
    }
    cursor += 1;
    while (cursor < length) {
        if (text[cursor] !== '"') {
            cursor += 1;
            continue;
        }
        let probe: number = cursor + 1;
        let matched: number = 0;
        while (matched < hashes && text[probe] === "#") {
            matched += 1;
            probe += 1;
        }
        if (matched === hashes) {
            return probe;
        }
        cursor += 1;
    }
    return length;
};

const maskSource: (text: string, options?: MaskOptions) => string = (text: string, options: MaskOptions = DefaultMaskOptions): string => {
    const length: number = text.length;
    const masked: string[] = new Array<string>(length);
    const blank: (from: number, to: number) => void = (from: number, to: number): void => {
        const stop: number = Math.min(to, length);
        for (let cursor: number = from; cursor < stop; cursor += 1) {
            masked[cursor] = text[cursor] === "\n" ? "\n" : " ";
        }
    };
    let index: number = 0;
    while (index < length) {
        const character: string = text[index];
        let lineComment: boolean = false;
        for (let markerIndex: number = 0; markerIndex < options.lineComments.length; markerIndex += 1) {
            const marker: string = options.lineComments[markerIndex];
            if (character === marker[0] && text.startsWith(marker, index)) {
                lineComment = true;
                break;
            }
        }
        if (lineComment) {
            const newline: number = text.indexOf("\n", index);
            const stop: number = newline === -1 ? length : newline;
            blank(index, stop);
            index = stop;
            continue;
        }
        if (options.blockComments && character === "/" && text[index + 1] === "*") {
            const end: number = text.indexOf("*/", index + 2);
            const stop: number = end === -1 ? length : end + 2;
            blank(index, stop);
            index = stop;
            continue;
        }
        /**
         * A CSS `url(…)` token is data, not syntax: a protocol-relative URL
         * contains `//` and a `data:` URL may contain `{`, `}` and `;`. The
         * whole token is blanked so none of those characters reach the
         * structural scanner.
         */
        if (
            options.url === true &&
            (character === "u" || character === "U") &&
            text.slice(index, index + 4).toLowerCase() === "url(" &&
            (index === 0 || !/[A-Za-z0-9_-]/.test(text[index - 1]))
        ) {
            let cursor: number = index + 4;
            let quote: string = "";
            let depth: number = 1;
            let stop: number = length;
            while (cursor < length) {
                const current: string = text[cursor];
                if (current === "\\") {
                    cursor += 2;
                    continue;
                }
                if (quote.length > 0) {
                    if (current === quote) {
                        quote = "";
                    }
                    cursor += 1;
                    continue;
                }
                if (current === '"' || current === "'") {
                    quote = current;
                    cursor += 1;
                    continue;
                }
                if (current === "(") {
                    depth += 1;
                } else if (current === ")") {
                    depth -= 1;
                    if (depth === 0) {
                        stop = cursor;
                        break;
                    }
                }
                cursor += 1;
            }
            blank(index, stop);
            index = stop >= length ? length : stop + 1;
            continue;
        }
        if (options.rawStrings === true && character === "r") {
            const rawEnd: number = rustRawStringEnd(text, index);
            if (rawEnd !== -1) {
                blank(index, rawEnd);
                index = rawEnd;
                continue;
            }
        }
        if (options.tripleQuotes && (text.startsWith('"""', index) || text.startsWith("'''", index))) {
            const quote: string = text.slice(index, index + 3);
            const end: number = text.indexOf(quote, index + 3);
            const stop: number = end === -1 ? length : end + 3;
            blank(index, stop);
            index = stop;
            continue;
        }
        if (options.strings && (character === '"' || character === "'")) {
            if (character === "'" && options.apostrophe === "lifetime") {
                const literalEnd: number = rustCharLiteralEnd(text, index);
                if (literalEnd === -1) {
                    masked[index] = character;
                    index += 1;
                    continue;
                }
                blank(index, literalEnd);
                index = literalEnd;
                continue;
            }
            let cursor: number = index + 1;
            while (cursor < length) {
                const current: string = text[cursor];
                if (current === "\\") {
                    cursor += 2;
                    continue;
                }
                if (current === character) {
                    cursor += 1;
                    break;
                }
                if (current === "\n") {
                    break;
                }
                cursor += 1;
            }
            blank(index, cursor);
            index = cursor;
            continue;
        }
        if (options.template && character === "`") {
            let cursor: number = index + 1;
            let closed: boolean = false;
            while (cursor < length) {
                const current: string = text[cursor];
                if (current === "\\") {
                    cursor += 2;
                    continue;
                }
                cursor += 1;
                if (current === "`") {
                    closed = true;
                    break;
                }
            }
            blank(index, closed ? cursor : length);
            index = closed ? cursor : length;
            continue;
        }
        if (options.regex && character === "/" && regexAllowed(text, index)) {
            let cursor: number = index + 1;
            let inClass: boolean = false;
            let closed: boolean = false;
            while (cursor < length) {
                const current: string = text[cursor];
                if (current === "\\") {
                    cursor += 2;
                    continue;
                }
                if (current === "\n") {
                    break;
                }
                if (current === "[") {
                    inClass = true;
                } else if (current === "]") {
                    inClass = false;
                } else if (current === "/" && !inClass) {
                    cursor += 1;
                    closed = true;
                    break;
                }
                cursor += 1;
            }
            if (closed) {
                blank(index, cursor);
                index = cursor;
                continue;
            }
        }
        masked[index] = character;
        index += 1;
    }
    for (let cursor: number = 0; cursor < length; cursor += 1) {
        if (masked[cursor] === (void 0)) {
            masked[cursor] = " ";
        }
    }
    return masked.join("");
};

/**
 * Index the braces of a masked text: line-start depths and open/close pairs.
 * Strings and comments are already spaces, so a brace seen here is real syntax.
 */
const scanBraces: (source: SourceLines, masked: string) => MaskedSource = (source: SourceLines, masked: string): MaskedSource => {
    const starts: readonly number[] = source.starts;
    const depthAtLine: number[] = new Array<number>(Math.max(1, starts.length)).fill(0);
    const lineOfStart: Map<number, number> = new Map<number, number>();
    for (let index: number = 0; index < starts.length; index += 1) {
        lineOfStart.set(starts[index], index);
    }
    const close: Map<number, number> = new Map<number, number>();
    const stack: number[] = [];
    let depth: number = 0;
    for (let index: number = 0; index < masked.length; index += 1) {
        const atLine: number | undefined = lineOfStart.get(index);
        if (atLine !== (void 0)) {
            depthAtLine[atLine] = depth;
        }
        const character: string = masked[index];
        if (character === "{") {
            stack.push(index);
            depth += 1;
            continue;
        }
        if (character === "}") {
            const openIndex: number | undefined = stack.pop();
            if (openIndex !== (void 0)) {
                close.set(openIndex, index);
            }
            if (depth > 0) {
                depth -= 1;
            }
        }
    }
    return { text: source.text, masked, starts, depthAtLine, close };
};

/**
 * Brace depth at the start of a 1-based line.
 */
const depthAtLine: (source: MaskedSource, line: number) => number = (source: MaskedSource, line: number): number =>
    source.depthAtLine[Math.max(0, Math.min(line - 1, source.depthAtLine.length - 1))] ?? 0;

/**
 * Line of a declaration's block end. The first `{` before any `;` wins, so a
 * class/function body is matched by its closing brace and a declaration without
 * a body ends at its semicolon. An unresolvable statement reports its own line.
 */
const blockEndLine: (source: MaskedSource, startLine: number) => number = (source: MaskedSource, startLine: number): number => {
    const offset: number = source.starts[startLine - 1] ?? 0;
    const masked: string = source.masked;
    for (let index: number = offset; index < masked.length; index += 1) {
        const character: string = masked[index];
        if (character === "{") {
            const closeIndex: number | undefined = source.close.get(index);
            return closeIndex === (void 0) ? startLine : lineAtOffset(source.starts, closeIndex);
        }
        if (character === ";") {
            return lineAtOffset(source.starts, index);
        }
        if (character === "}") {
            return lineAtOffset(source.starts, index);
        }
    }
    return startLine;
};

/**
 * Build one symbol node.
 *
 * A strategy only owns the line numbers and the tree shape; the registry fills
 * the anchor `path`, the UTF-8 byte range and the final depth, because those
 * need the file anchor and the `ByteLineIndex`. The placeholder range keeps the
 * returned value a complete `OutlineNode` for direct parser tests.
 */
const outlineNode: (spec: NodeSpec) => OutlineNode = (spec: NodeSpec): OutlineNode => {
    const startLine: number = Math.max(1, Math.trunc(spec.startLine));
    const endLine: number = Math.max(startLine, Math.trunc(spec.endLine));
    return {
        isFile: false,
        isDirectory: false,
        path: "",
        type: spec.kind,
        range: { startByte: 0n, endByte: 0n, startLine: BigInt(startLine), endLine: BigInt(endLine) },
        label: spec.label,
        depth: Math.max(0, Math.trunc(spec.depth)),
        ...(spec.modifiers === (void 0) || spec.modifiers.length === 0 ? {} : { modifiers: [...spec.modifiers] }),
        ...(spec.detail === (void 0) ? {} : { detail: spec.detail }),
        children: spec.children ?? [],
    };
};

/**
 * Convert a draft tree into the public immutable-by-convention node shape.
 */
const draftToNode: (draft: DraftOutlineNode) => OutlineNode = (draft: DraftOutlineNode): OutlineNode =>
    outlineNode({
        label: draft.label,
        kind: draft.kind,
        startLine: draft.startLine,
        endLine: draft.endLine,
        depth: draft.depth,
        ...(draft.detail === (void 0) ? {} : { detail: draft.detail }),
        children: draft.children.map(draftToNode),
    });

/**
 * Assemble a flat heading list into a tree by depth, using a stack so a
 * skipped level (an `###` after an `#`) stays nested under the nearest
 * shallower heading while keeping its own declared depth.
 */
const assembleFlat: (entries: readonly FlatOutlineEntry[]) => OutlineNode[] = (entries: readonly FlatOutlineEntry[]): OutlineNode[] => {
    const roots: DraftOutlineNode[] = [];
    const stack: DraftOutlineNode[] = [];
    for (let index: number = 0; index < entries.length; index += 1) {
        const entry: FlatOutlineEntry = entries[index];
        while (stack.length > 0 && stack[stack.length - 1].depth >= entry.depth) {
            stack.pop();
        }
        const parent: DraftOutlineNode | undefined = stack.length === 0 ? undefined : stack[stack.length - 1];
        const draft: DraftOutlineNode = {
            label: entry.label,
            kind: entry.kind,
            startLine: entry.startLine,
            endLine: entry.endLine,
            depth: entry.depth,
            ...(entry.detail === (void 0) ? {} : { detail: entry.detail }),
            children: [],
        };
        if (parent === (void 0)) {
            roots.push(draft);
        } else {
            parent.children.push(draft);
        }
        stack.push(draft);
    }
    return roots.map(draftToNode);
};

/**
 * Stable sort of symbol nodes by the 1-based start line in `range`.
 */
const sortNodesByLine: (items: readonly OutlineNode[]) => OutlineNode[] = (items: readonly OutlineNode[]): OutlineNode[] =>
    [...items].sort((left: OutlineNode, right: OutlineNode): number => Number(left.range.startLine) - Number(right.range.startLine));

/**
 * ATX heading: one to six `#` followed by whitespace and an optional label.
 */
const AtxHeading: RegExp = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * Opening or closing code fence, three or more backticks or tildes.
 */
const FenceLine: RegExp = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Setext underline.
 */
const SetextUnderline: RegExp = /^ {0,3}(=+|-+)[ \t]*$/;

/**
 * Front matter `title:` entry.
 */
const FrontMatterTitle: RegExp = /^title\s*:\s*(.+)$/;

/**
 * CommonMark block-level HTML tag names. A line that starts one of these tags
 * opens a type-6 HTML block, which ends at the next blank line.
 */
const MarkdownHtmlBlockTagNames: ReadonlySet<string> = new Set<string>([
    "address", "article", "aside", "base", "basefont", "blockquote", "body",
    "caption", "center", "col", "colgroup", "dd", "details", "dialog", "dir",
    "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
    "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header",
    "hr", "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem",
    "nav", "noframes", "ol", "optgroup", "option", "p", "param", "search",
    "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
    "title", "tr", "track", "ul",
]);

/**
 * End condition for an open CommonMark HTML block.
 */
type MarkdownHtmlBlockEnd = "blank" | "raw" | "comment" | "pi" | "declaration" | "cdata";

/**
 * One open CommonMark HTML block. `tag` is only used by the raw-text variants.
 */
interface MarkdownHtmlBlock {
    readonly end: MarkdownHtmlBlockEnd;
    readonly tag: string;
}

/**
 * Type-1 HTML block: `<script>`, `<pre>`, `<style>` or `<textarea>`.
 */
const MarkdownHtmlRawStart: RegExp = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i;

/**
 * Type-6 HTML block: a block-level tag name at the start of a line.
 */
const MarkdownHtmlTagStart: RegExp = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/;

/**
 * Type-7 HTML block: one complete open or closing tag alone on a line.
 */
const MarkdownHtmlCompleteTag: RegExp = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+(?:"[^"]*"|'[^']*'|[^"'<>])*)?\/?>[ \t]*$/;

/**
 * Detect the start of a CommonMark HTML block. `undefined` means the line is
 * ordinary Markdown and may still become an ATX or setext heading.
 */
const markdownHtmlBlockStart: (line: string) => MarkdownHtmlBlock | undefined = (line: string): MarkdownHtmlBlock | undefined => {
    if (/^ {0,3}<!--/.test(line)) {
        return { end: "comment", tag: "" };
    }
    if (/^ {0,3}<!\[CDATA\[/.test(line)) {
        return { end: "cdata", tag: "" };
    }
    if (/^ {0,3}<\?/.test(line)) {
        return { end: "pi", tag: "" };
    }
    if (/^ {0,3}<![A-Za-z]/.test(line)) {
        return { end: "declaration", tag: "" };
    }
    const raw: RegExpExecArray | null = MarkdownHtmlRawStart.exec(line);
    if (raw !== null) {
        return { end: "raw", tag: raw[1].toLowerCase() };
    }
    const tag: RegExpExecArray | null = MarkdownHtmlTagStart.exec(line);
    if (tag !== null && MarkdownHtmlBlockTagNames.has(tag[1].toLowerCase())) {
        return { end: "blank", tag: "" };
    }
    if (MarkdownHtmlCompleteTag.test(line)) {
        return { end: "blank", tag: "" };
    }
    return undefined;
};

/**
 * Whether one line closes an open CommonMark HTML block. The closing line is
 * part of the block, so the caller consumes it and resets the state.
 */
const markdownHtmlBlockEnded: (block: MarkdownHtmlBlock, line: string) => boolean = (block: MarkdownHtmlBlock, line: string): boolean => {
    switch (block.end) {
        case "blank": {
            return line.trim().length === 0;
        }
        case "raw": {
            return new RegExp(`</${block.tag}\\s*>`, "i").test(line);
        }
        case "comment": {
            return line.includes("-->");
        }
        case "pi": {
            return line.includes("?>");
        }
        case "declaration": {
            return line.includes(">");
        }
        case "cdata": {
            return line.includes("]]>");
        }
        default: {
            return false;
        }
    }
};

/**
 * Parse a Markdown document.
 *
 * ATX headings, setext headings and a YAML front-matter `title` are recognized.
 * Fenced code blocks and CommonMark HTML blocks are skipped entirely, so a
 * `# comment` inside a shell example or an HTML wrapper is not mistaken for a
 * heading. Heading depth is `#`-count minus one, and a front-matter title is a
 * depth-0 heading of its own. A heading ends on the line before the next heading
 * of the same or a higher level, or at EOF.
 *
 * @param input - Decoded Markdown text.
 * @returns Heading tree.
 */
export const parseMarkdown: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    const lines: readonly string[] = source.lines;
    const total: number = source.totalLines;
    if (total === 0) {
        return [];
    }
    const entries: FlatOutlineEntry[] = [];
    let bodyStart: number = 0;
    if (lines[0].trim() === "---") {
        let closingLine: number = -1;
        let titleFound: boolean = false;
        for (let index: number = 1; index < total; index += 1) {
            const line: string = lines[index].trim();
            if (line === "---" || line === "...") {
                closingLine = index;
                break;
            }
            const match: RegExpExecArray | null = FrontMatterTitle.exec(lines[index]);
            if (match !== null && !titleFound) {
                const raw: string = match[1].trim();
                const quote: string = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : "";
                let title: string = "";
                if (quote.length > 0) {
                    const closing: number = raw.indexOf(quote, 1);
                    title = closing === -1 ? raw.slice(1) : raw.slice(1, closing);
                } else {
                    title = raw.replace(/\s+#.*$/, "").trim();
                }
                if (title.length > 0) {
                    entries.push({ label: title, kind: "heading", startLine: index + 1, endLine: index + 1, depth: 0, detail: "front matter" });
                    titleFound = true;
                }
            }
        }
        if (closingLine === -1) {
            entries.length = 0;
        } else {
            bodyStart = closingLine + 1;
        }
    }
    let fenceCharacter: string = "";
    let fenceLength: number = 0;
    let markdownHtml: MarkdownHtmlBlock | undefined;
    for (let index: number = bodyStart; index < total; index += 1) {
        const line: string = lines[index];
        if (markdownHtml !== undefined) {
            if (markdownHtmlBlockEnded(markdownHtml, line)) {
                markdownHtml = undefined;
            }
            continue;
        }
        const fence: RegExpExecArray | null = FenceLine.exec(line);
        if (fenceCharacter !== "") {
            if (fence !== null && fence[1][0] === fenceCharacter && fence[1].length >= fenceLength && fence[2].trim().length === 0) {
                fenceCharacter = "";
                fenceLength = 0;
            }
            continue;
        }
        if (fence !== null) {
            fenceCharacter = fence[1][0];
            fenceLength = fence[1].length;
            continue;
        }
        const htmlBlock: MarkdownHtmlBlock | undefined = markdownHtmlBlockStart(line);
        if (htmlBlock !== undefined) {
            if (!markdownHtmlBlockEnded(htmlBlock, line)) {
                markdownHtml = htmlBlock;
            }
            continue;
        }
        const atx: RegExpExecArray | null = AtxHeading.exec(line);
        if (atx !== null) {
            const rawLabel: string = (atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
            const level: number = atx[1].length;
            entries.push({
                label: rawLabel.length === 0 ? `heading ${level}` : rawLabel,
                kind: "heading",
                startLine: index + 1,
                endLine: index + 1,
                depth: level - 1,
            });
            continue;
        }
        if (index + 1 < total && line.trim().length > 0 && !/^\s*(?:[-*+]|>|\d+[.)])\s/.test(line)) {
            const underline: RegExpExecArray | null = SetextUnderline.exec(lines[index + 1]);
            if (underline !== null) {
                entries.push({
                    label: line.trim(),
                    kind: "heading",
                    startLine: index + 1,
                    endLine: index + 2,
                    depth: underline[1][0] === "=" ? 0 : 1,
                });
                index += 1;
            }
        }
    }
    for (let index: number = 0; index < entries.length; index += 1) {
        const entry: FlatOutlineEntry = entries[index];
        let endLine: number = total;
        for (let next: number = index + 1; next < entries.length; next += 1) {
            if (entries[next].depth <= entry.depth) {
                endLine = entries[next].startLine - 1;
                break;
            }
        }
        entries[index] = { ...entry, endLine: Math.max(entry.endLine, endLine) };
    }
    return assembleFlat(entries);
};

/**
 * Chinese volume marker, for example `第一卷` or `第 2 卷`.
 */
const TextVolume: RegExp = /^(?:第\s*[零〇一二三四五六七八九十百千两0-9]+\s*卷|卷\s*[零〇一二三四五六七八九十百千两0-9]+)/;

/**
 * English volume marker.
 */
const TextPart: RegExp = /^(?:PART|Part|part|VOLUME|Volume|volume|BOOK|Book|book)\b/;

/**
 * Chinese chapter marker, for example `第一章` or `第 12 回`.
 */
const TextChapter: RegExp = /^第\s*[零〇一二三四五六七八九十百千两0-9]+\s*[章回]/;

/**
 * English chapter marker.
 */
const TextChapterWord: RegExp = /^(?:CHAPTER|Chapter|chapter)\b/;

/**
 * Chinese section marker.
 */
const TextSection: RegExp = /^第\s*[零〇一二三四五六七八九十百千两0-9]+\s*节/;

/**
 * English section marker.
 */
const TextSectionWord: RegExp = /^(?:SECTION|Section|section)\b/;

/**
 * Plain-text title underline: a run of `=`, `-` or `~`.
 */
const TextUnderline: RegExp = /^ {0,3}(=+|-+|~+)[ \t]*$/;

/**
 * Short all-uppercase display title such as `INTRODUCTION`.
 */
const TextUpperTitle: RegExp = /^[A-Z][A-Z0-9 .,'&()/:;!?+-]{1,79}$/;

/**
 * A page number or similar bare number line.
 */
const TextNumberLine: RegExp = /^\s*\d+\s*$/;

/**
 * Indentation that marks a line as code rather than a table-of-contents entry.
 * Plain text has no fence syntax, so a tab or four leading spaces is the only
 * portable signal; a heading indented by one to three spaces still parses.
 */
const TextCodeIndent: RegExp = /^(?: {4,}|\t)/;

/**
 * Lowercase words allowed inside an English marker title: articles,
 * prepositions/conjunctions and spelled-out numbers such as `Chapter one`.
 */
const TextTitleConnectors: ReadonlySet<string> = new Set<string>([
    "a",
    "an",
    "and",
    "as",
    "at",
    "by",
    "for",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
]);

/**
 * Whether the text after an English `Part`/`Chapter`/`Section` marker is
 * title-like rather than the start of an ordinary sentence.
 *
 * A Latin word that is neither all caps, capitalized nor a connector/number
 * rejects the line; CJK and numeric tails pass because they carry no case.
 *
 * @param tail - Text after the matched marker.
 * @returns Whether the tail may belong to a heading.
 */
const textTitleTail: (tail: string) => boolean = (tail: string): boolean => {
    const words: RegExpMatchArray | null = tail.match(/[A-Za-z]+/g);
    if (words === null) {
        return true;
    }
    for (let index: number = 0; index < words.length; index += 1) {
        const word: string = words[index];
        if (word === word.toUpperCase() || /^[A-Z]/.test(word) || TextTitleConnectors.has(word.toLowerCase())) {
            continue;
        }
        return false;
    }
    return true;
};

/**
 * Parse a plain-text book or document.
 *
 * The strategy is a bounded table-of-contents scanner, not a natural-language
 * classifier. It recognizes 卷/Part/Volume as level 0, 章/Chapter as level 1,
 * 节/Section as level 2, a `===` underline as level 0, a `---`/`~~~` underline
 * as level 1, and other short all-uppercase lines as level 0. A level that has
 * no parent stays a root at its declared depth, which keeps the reported depth
 * stable across files instead of normalizing it from whatever headings happen
 * to exist.
 *
 * @param input - Decoded text.
 * @returns Section tree.
 */
export const parsePlainText: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    const lines: readonly string[] = source.lines;
    const total: number = source.totalLines;
    const entries: FlatOutlineEntry[] = [];
    for (let index: number = 0; index < total; index += 1) {
        const rawLine: string = lines[index];
        if (TextCodeIndent.test(rawLine)) {
            continue;
        }
        const line: string = rawLine.trim();
        if (line.length === 0 || TextNumberLine.test(line)) {
            continue;
        }
        const startLine: number = index + 1;
        let depth: number = -1;
        let kind: OutlineKind = "heading";
        let endLine: number = startLine;
        const partWord: RegExpExecArray | null = TextPart.exec(line);
        const chapterWord: RegExpExecArray | null = TextChapterWord.exec(line);
        const sectionWord: RegExpExecArray | null = TextSectionWord.exec(line);
        if (TextVolume.test(line) || (partWord !== null && textTitleTail(line.slice(partWord[0].length)))) {
            depth = 0;
            kind = "part";
        } else if (TextChapter.test(line) || (chapterWord !== null && textTitleTail(line.slice(chapterWord[0].length)))) {
            depth = 1;
            kind = "chapter";
        } else if (TextSection.test(line) || (sectionWord !== null && textTitleTail(line.slice(sectionWord[0].length)))) {
            depth = 2;
            kind = "section";
        } else if (index + 1 < total && line.length <= 120 && TextUnderline.test(lines[index + 1])) {
            const underline: RegExpExecArray | null = TextUnderline.exec(lines[index + 1]);
            depth = underline === null || underline[1][0] === "=" ? 0 : 1;
            endLine = index + 2;
            index += 1;
        } else if (TextUpperTitle.test(line) && /[A-Z]{2,}/.test(line)) {
            depth = 0;
        }
        if (depth < 0) {
            continue;
        }
        entries.push({ label: line, kind, startLine, endLine, depth });
    }
    for (let index: number = 0; index < entries.length; index += 1) {
        const entry: FlatOutlineEntry = entries[index];
        let endLine: number = total;
        for (let next: number = index + 1; next < entries.length; next += 1) {
            if (entries[next].depth <= entry.depth) {
                endLine = entries[next].startLine - 1;
                break;
            }
        }
        entries[index] = { ...entry, endLine: Math.max(entry.endLine, endLine) };
    }
    return assembleFlat(entries);
};

/**
 * TeX sectioning commands and their document depth.
 */
const TexHeadingDepth: ReadonlyMap<string, number> = new Map<string, number>([
    ["part", 0],
    ["chapter", 1],
    ["section", 2],
    ["subsection", 3],
    ["subsubsection", 4],
    ["paragraph", 5],
    ["subparagraph", 6],
]);

/**
 * Outline kind for a TeX sectioning command.
 */
const TexHeadingKind: ReadonlyMap<string, OutlineKind> = new Map<string, OutlineKind>([
    ["part", "part"],
    ["chapter", "chapter"],
    ["section", "section"],
    ["subsection", "subsection"],
    ["subsubsection", "subsection"],
    ["paragraph", "paragraph"],
    ["subparagraph", "paragraph"],
]);

/**
 * Sectioning command token. The optional short title and the mandatory body
 * are parsed separately, so a `]` inside braces does not truncate the optional
 * argument.
 */
const TexHeadingCommand: RegExp = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?![A-Za-z@])/g;

/**
 * Environment boundary.
 */
const TexEnvironment: RegExp = /\\(begin|end)\s*\{([^{}]*)\}/g;
const TexInputCommand: RegExp = /\\(input|include)\s*\{([^{}]*)\}/g;

/**
 * A command whose braces must be skipped when cleaning a heading label.
 */
const TexCommand: RegExp = /\\[A-Za-z@]+\*?/g;

/**
 * Index of the `}` matching the `{` at `openIndex`, or `-1`.
 */
const matchingBrace: (text: string, openIndex: number) => number = (text: string, openIndex: number): number => {
    let depth: number = 0;
    for (let index: number = openIndex; index < text.length; index += 1) {
        const character: string = text[index];
        if (character === "\\") {
            index += 1;
            continue;
        }
        if (character === "%") {
            const newline: number = text.indexOf("\n", index);
            index = newline === -1 ? text.length : newline;
            continue;
        }
        if (character === "{") {
            depth += 1;
            continue;
        }
        if (character === "}") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
};

/**
 * Turn a raw TeX heading body into a readable label.
 */
const texLabel: (raw: string) => string = (raw: string): string => raw.replace(TexCommand, " ").replace(/[{}]/g, " ").replace(/~/g, " ").trim();

/**
 * Replace a hidden TeX range with spaces while preserving newlines.
 */
const blankTexRange: (characters: string[], from: number, to: number) => void = (characters: string[], from: number, to: number): void => {
    const stop: number = Math.min(to, characters.length);
    for (let index: number = Math.max(0, from); index < stop; index += 1) {
        if (characters[index] !== "\n") {
            characters[index] = " ";
        }
    }
};

/**
 * Skip spaces, tabs and line breaks.
 */
const skipTexWhitespace: (text: string, index: number) => number = (text: string, index: number): number => {
    let cursor: number = index;
    while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t" || text[cursor] === "\r" || text[cursor] === "\n")) {
        cursor += 1;
    }
    return cursor;
};

/**
 * Index of the `]` matching the `[` at `openIndex`, or `-1`. A `]` inside
 * braces and an escaped `\]` do not close the optional argument.
 */
const matchingTexBracket: (text: string, openIndex: number) => number = (text: string, openIndex: number): number => {
    let square: number = 0;
    let braces: number = 0;
    for (let index: number = openIndex; index < text.length; index += 1) {
        const character: string = text[index];
        if (character === "\\") {
            index += 1;
            continue;
        }
        if (character === "%") {
            const newline: number = text.indexOf("\n", index);
            index = newline === -1 ? text.length - 1 : newline;
            continue;
        }
        if (character === "{") {
            braces += 1;
            continue;
        }
        if (character === "}") {
            if (braces > 0) {
                braces -= 1;
            }
            continue;
        }
        if (braces !== 0) {
            continue;
        }
        if (character === "[") {
            square += 1;
        } else if (character === "]") {
            square -= 1;
            if (square === 0) {
                return index;
            }
        }
    }
    return -1;
};

/**
 * Environment names whose body is raw text: headings and environment commands
 * inside them are data, not structure. `comment` is hidden together with both
 * boundary tags; `verbatim` keeps its begin/end markers so the environment
 * itself still appears in the outline.
 */
const TexRawEnvironments: ReadonlySet<string> = new Set<string>([
    "verbatim",
    "verbatim*",
    "Verbatim",
    "Verbatim*",
    "lstlisting",
    "minted",
    "comment",
    "comment*",
]);

interface TexRawEnvironment {
    readonly name: string;
    readonly end: number;
}

/**
 * Recognize a raw-environment opener at one offset.
 */
const texRawEnvironmentAt: (text: string, index: number) => TexRawEnvironment | undefined = (
    text: string, index: number,
): TexRawEnvironment | undefined => {
    const window: string = text.slice(index, index + 160);
    const match: RegExpExecArray | null = /^\\begin\s*\{([^{}]*)\}/.exec(window);
    if (match === null) {
        return undefined;
    }
    const name: string = match[1].trim();
    return TexRawEnvironments.has(name) ? { name, end: index + match[0].length } : undefined;
};

/**
 * End offset of one macro definition at `index`, or `-1`.
 *
 * Supported forms are `\newcommand`/`\renewcommand`/`\providecommand`/
 * `\DeclareRobustCommand` (with `{name}` or `\name`, optional arity/default
 * brackets and a braced body) and `\def`/`\gdef`/`\edef`/`\xdef` (control
 * sequence, parameter text and braced body). The whole definition is hidden so
 * commands used only for expansion cannot become document structure.
 */
const texMacroDefinitionEnd: (text: string, index: number) => number = (text: string, index: number): number => {
    const newCommand: RegExpExecArray | null = /^\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?/.exec(text.slice(index, index + 80));
    if (newCommand !== null) {
        let cursor: number = skipTexWhitespace(text, index + newCommand[0].length);
        if (text[cursor] === "{") {
            const closeName: number = matchingBrace(text, cursor);
            if (closeName === -1) {
                return -1;
            }
            cursor = skipTexWhitespace(text, closeName + 1);
        } else if (text[cursor] === "\\") {
            cursor += 1;
            while (cursor < text.length && /[A-Za-z@]/.test(text[cursor])) {
                cursor += 1;
            }
            cursor = skipTexWhitespace(text, cursor);
        } else {
            return -1;
        }
        for (let count: number = 0; count < 2 && text[cursor] === "["; count += 1) {
            const closeBracket: number = matchingTexBracket(text, cursor);
            if (closeBracket === -1) {
                return -1;
            }
            cursor = skipTexWhitespace(text, closeBracket + 1);
        }
        if (text[cursor] !== "{") {
            return -1;
        }
        const closeBody: number = matchingBrace(text, cursor);
        return closeBody === -1 ? -1 : closeBody + 1;
    }
    const plainDefinition: RegExpExecArray | null = /^\\(?:def|gdef|edef|xdef)\b/.exec(text.slice(index, index + 32));
    if (plainDefinition !== null) {
        let cursor: number = skipTexWhitespace(text, index + plainDefinition[0].length);
        if (text[cursor] !== "\\") {
            return -1;
        }
        cursor += 1;
        while (cursor < text.length && /[A-Za-z@]/.test(text[cursor])) {
            cursor += 1;
        }
        const openBody: number = text.indexOf("{", cursor);
        if (openBody === -1) {
            return -1;
        }
        const closeBody: number = matchingBrace(text, openBody);
        return closeBody === -1 ? -1 : closeBody + 1;
    }
    return -1;
};

/**
 * End offset of a `\iffalse` ... `\fi` region, including a nested
 * conditional. Comments are skipped while looking for the matching `\fi`; an
 * unterminated region runs to EOF.
 */
const texFalseConditionalEnd: (text: string, index: number) => number = (text: string, index: number): number => {
    let depth: number = 1;
    let cursor: number = index + "\\iffalse".length;
    while (cursor < text.length) {
        if (text[cursor] === "%") {
            const newline: number = text.indexOf("\n", cursor);
            cursor = newline === -1 ? text.length : newline + 1;
            continue;
        }
        if (text[cursor] !== "\\") {
            cursor += 1;
            continue;
        }
        const token: RegExpExecArray | null = /^\\(if[A-Za-z@]*|fi)\b/.exec(text.slice(cursor, cursor + 40));
        if (token === null) {
            cursor += 2;
            continue;
        }
        cursor += token[0].length;
        if (token[1] === "fi") {
            depth -= 1;
            if (depth === 0) {
                return cursor;
            }
            continue;
        }
        depth += 1;
    }
    return text.length;
};

/**
 * Mask comments and raw regions before structural scanning.
 *
 * A percent sign preceded by an odd run of backslashes is an escaped literal,
 * not a comment. `\verb`, verbatim-like environments and macro definitions are
 * hidden with the same offset-preserving replacement, so a heading-looking
 * command inside code or a macro body cannot become an outline node.
 */
const maskTexRegions: (text: string) => string = (text: string): string => {
    const characters: string[] = text.split("");
    let index: number = 0;
    while (index < text.length) {
        if (text[index] === "%") {
            const newline: number = text.indexOf("\n", index);
            const stop: number = newline === -1 ? text.length : newline;
            blankTexRange(characters, index, stop);
            index = stop;
            continue;
        }
        if (text[index] !== "\\") {
            index += 1;
            continue;
        }
        if (text.startsWith("\\iffalse", index)) {
            const conditionalEnd: number = texFalseConditionalEnd(text, index);
            blankTexRange(characters, index, conditionalEnd);
            index = conditionalEnd;
            continue;
        }
        const raw: TexRawEnvironment | undefined = texRawEnvironmentAt(text, index);
        if (raw !== undefined) {
            const literal: string = `\\end{${raw.name}}`;
            const close: number = text.indexOf(literal, raw.end);
            if (raw.name === "comment" || raw.name === "comment*") {
                const stop: number = close === -1 ? text.length : close + literal.length;
                blankTexRange(characters, index, stop);
                index = stop;
                continue;
            }
            if (close === -1) {
                blankTexRange(characters, raw.end, text.length);
                index = text.length;
                continue;
            }
            blankTexRange(characters, raw.end, close);
            index = close;
            continue;
        }
        if (text.startsWith("\\verb", index)) {
            let cursor: number = index + "\\verb".length;
            if (text[cursor] === "*") {
                cursor += 1;
            }
            const delimiter: string = text[cursor] ?? "";
            if (delimiter.length > 0 && delimiter !== "\n" && delimiter !== "\r" && !/[A-Za-z@]/.test(delimiter)) {
                let close: number = cursor + 1;
                while (close < text.length && text[close] !== delimiter && text[close] !== "\n" && text[close] !== "\r") {
                    close += 1;
                }
                if (text[close] === delimiter) {
                    close += 1;
                }
                blankTexRange(characters, index, close);
                index = close;
                continue;
            }
        }
        const macroEnd: number = texMacroDefinitionEnd(text, index);
        if (macroEnd > index) {
            blankTexRange(characters, index, macroEnd);
            index = macroEnd;
            continue;
        }
        index += 2;
    }
    return characters.join("");
};

interface TexHeadingEvent {
    readonly kind: "heading";
    readonly index: number;
    readonly startLine: number;
    readonly label: string;
    readonly nodeKind: OutlineKind;
    readonly rank: number;
}

interface TexEnvironmentEvent {
    readonly kind: "environment";
    readonly index: number;
    readonly startLine: number;
    readonly action: "begin" | "end";
    readonly name: string;
}

interface TexReferenceEvent {
    readonly kind: "reference";
    readonly index: number;
    readonly startLine: number;
    readonly label: string;
    readonly command: string;
}

type TexOutlineEvent = TexHeadingEvent | TexEnvironmentEvent | TexReferenceEvent;

interface TexDraftContainer {
    readonly node: DraftOutlineNode;
    readonly depth: number;
    readonly environment: boolean;
}

interface TexOpenEnvironment {
    readonly name: string;
    readonly node: DraftOutlineNode;
    readonly container: TexDraftContainer;
}

interface TexHeadingDraft {
    readonly node: DraftOutlineNode;
    readonly rank: number;
}

/**
 * Parse a TeX/LaTeX document.
 *
 * Sectioning commands map to their document rank: `\part` 0, `\chapter` 1,
 * `\section` 2, `\subsection` 3, `\subsubsection` 4, `\paragraph` 5 and
 * `\subparagraph` 6. Environments are attached to the heading or environment
 * that contains them; a following heading never inherits an environment as its
 * parent. `\begin{document}`/`\end{document}` is transparent because the file
 * itself is the document.
 *
 * Percent comments, `\verb`, verbatim-like environments and macro definitions
 * are masked before scanning. `\input`/`\include` become `reference` nodes with
 * the target as their label, but the target file is never resolved or read.
 *
 * @param input - Decoded TeX text.
 * @returns Section, environment and reference tree.
 */
export const parseTex: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    const masked: string = maskTexRegions(input.text);
    const starts: readonly number[] = source.starts;
    const events: TexOutlineEvent[] = [];
    const headingSpans: Array<{ readonly start: number; readonly end: number; }> = [];
    const insideHeadingSpan: (index: number) => boolean = (index: number): boolean => {
        for (let spanIndex: number = 0; spanIndex < headingSpans.length; spanIndex += 1) {
            const span: { readonly start: number; readonly end: number; } = headingSpans[spanIndex];
            if (index >= span.start && index < span.end) {
                return true;
            }
        }
        return false;
    };

    TexHeadingCommand.lastIndex = 0;
    let match: RegExpExecArray | null = TexHeadingCommand.exec(masked);
    while (match !== null) {
        const command: string = match[1];
        const tokenEnd: number = match.index + match[0].length;
        let cursor: number = skipTexWhitespace(masked, tokenEnd);
        if (masked[cursor] === "[") {
            const closeBracket: number = matchingTexBracket(masked, cursor);
            if (closeBracket === -1) {
                TexHeadingCommand.lastIndex = tokenEnd;
                match = TexHeadingCommand.exec(masked);
                continue;
            }
            cursor = skipTexWhitespace(masked, closeBracket + 1);
        }
        if (masked[cursor] !== "{") {
            TexHeadingCommand.lastIndex = tokenEnd;
            match = TexHeadingCommand.exec(masked);
            continue;
        }
        const closeIndex: number = matchingBrace(masked, cursor);
        const rawLabel: string = closeIndex === -1 ? "" : texLabel(masked.slice(cursor + 1, closeIndex));
        events.push({
            kind: "heading",
            index: match.index,
            startLine: lineAtOffset(starts, match.index),
            label: rawLabel.length === 0 ? command : rawLabel,
            nodeKind: TexHeadingKind.get(command) ?? "heading",
            rank: TexHeadingDepth.get(command) ?? 0,
        });
        headingSpans.push({ start: match.index, end: closeIndex === -1 ? tokenEnd : closeIndex + 1 });
        TexHeadingCommand.lastIndex = closeIndex === -1 ? tokenEnd : closeIndex + 1;
        match = TexHeadingCommand.exec(masked);
    }

    TexEnvironment.lastIndex = 0;
    let environmentMatch: RegExpExecArray | null = TexEnvironment.exec(masked);
    while (environmentMatch !== null) {
        if (!insideHeadingSpan(environmentMatch.index)) {
            events.push({
                kind: "environment",
                index: environmentMatch.index,
                startLine: lineAtOffset(starts, environmentMatch.index),
                action: environmentMatch[1] === "begin" ? "begin" : "end",
                name: environmentMatch[2].trim(),
            });
        }
        TexEnvironment.lastIndex = environmentMatch.index + environmentMatch[0].length;
        environmentMatch = TexEnvironment.exec(masked);
    }

    TexInputCommand.lastIndex = 0;
    let inputMatch: RegExpExecArray | null = TexInputCommand.exec(masked);
    while (inputMatch !== null) {
        const target: string = inputMatch[2].trim();
        if (target.length > 0 && !insideHeadingSpan(inputMatch.index)) {
            events.push({
                kind: "reference",
                index: inputMatch.index,
                startLine: lineAtOffset(starts, inputMatch.index),
                label: target,
                command: inputMatch[1],
            });
        }
        TexInputCommand.lastIndex = inputMatch.index + inputMatch[0].length;
        inputMatch = TexInputCommand.exec(masked);
    }

    events.sort((left: TexOutlineEvent, right: TexOutlineEvent): number => left.index - right.index);
    const roots: DraftOutlineNode[] = [];
    const stack: TexDraftContainer[] = [];
    const openEnvironments: TexOpenEnvironment[] = [];
    const headingDrafts: TexHeadingDraft[] = [];
    const attach: (node: DraftOutlineNode, parent: DraftOutlineNode | undefined) => void = (
        node: DraftOutlineNode, parent: DraftOutlineNode | undefined,
    ): void => {
        if (parent === (void 0)) {
            roots.push(node);
        } else {
            parent.children.push(node);
        }
    };

    for (let eventIndex: number = 0; eventIndex < events.length; eventIndex += 1) {
        const event: TexOutlineEvent = events[eventIndex];
        if (event.kind === "heading") {
            while (stack.length > 0) {
                const top: TexDraftContainer = stack[stack.length - 1];
                if (top.environment || top.depth >= event.rank) {
                    stack.pop();
                    continue;
                }
                break;
            }
            const parentNode: DraftOutlineNode | undefined = stack.length === 0 ? undefined : stack[stack.length - 1].node;
            const node: DraftOutlineNode = {
                label: event.label,
                kind: event.nodeKind,
                startLine: event.startLine,
                endLine: event.startLine,
                depth: event.rank,
                children: [],
            };
            attach(node, parentNode);
            stack.push({ node, depth: event.rank, environment: false });
            headingDrafts.push({ node, rank: event.rank });
            continue;
        }
        if (event.kind === "environment") {
            if (event.name === "document") {
                continue;
            }
            if (event.action === "begin") {
                const parentContainer: TexDraftContainer | undefined = stack.length === 0 ? undefined : stack[stack.length - 1];
                const depth: number = parentContainer === (void 0) ? 0 : parentContainer.depth + 1;
                const node: DraftOutlineNode = {
                    label: event.name.length === 0 ? "environment" : event.name,
                    kind: "environment",
                    startLine: event.startLine,
                    endLine: event.startLine,
                    depth,
                    children: [],
                };
                attach(node, parentContainer?.node);
                const container: TexDraftContainer = { node, depth, environment: true };
                stack.push(container);
                openEnvironments.push({ name: event.name, node, container });
                continue;
            }
            let closeIndex: number = -1;
            for (let openIndex: number = openEnvironments.length - 1; openIndex >= 0; openIndex -= 1) {
                if (openEnvironments[openIndex].name === event.name) {
                    closeIndex = openIndex;
                    break;
                }
            }
            if (closeIndex === -1) {
                continue;
            }
            const closing: TexOpenEnvironment[] = openEnvironments.splice(closeIndex);
            for (let closeIndexInner: number = 0; closeIndexInner < closing.length; closeIndexInner += 1) {
                const frame: TexOpenEnvironment = closing[closeIndexInner];
                frame.node.endLine = Math.max(frame.node.startLine, event.startLine);
                const stackPosition: number = stack.indexOf(frame.container);
                if (stackPosition !== -1) {
                    stack.splice(stackPosition, 1);
                }
            }
            continue;
        }
        const parentContainer: TexDraftContainer | undefined = stack.length === 0 ? undefined : stack[stack.length - 1];
        const depth: number = parentContainer === (void 0) ? 0 : parentContainer.depth + 1;
        const node: DraftOutlineNode = {
            label: event.label,
            kind: "reference",
            startLine: event.startLine,
            endLine: event.startLine,
            depth,
            detail: `\\${event.command}{${event.label}}`,
            children: [],
        };
        attach(node, parentContainer?.node);
    }

    for (let index: number = 0; index < openEnvironments.length; index += 1) {
        openEnvironments[index].node.endLine = Math.max(openEnvironments[index].node.startLine, source.totalLines);
    }
    for (let index: number = 0; index < headingDrafts.length; index += 1) {
        const current: TexHeadingDraft = headingDrafts[index];
        let endLine: number = source.totalLines;
        for (let next: number = index + 1; next < headingDrafts.length; next += 1) {
            if (headingDrafts[next].rank <= current.rank) {
                endLine = headingDrafts[next].node.startLine - 1;
                break;
            }
        }
        current.node.endLine = Math.max(current.node.startLine, endLine);
    }
    const containDraft: (node: DraftOutlineNode) => void = (node: DraftOutlineNode): void => {
        let endLine: number = node.endLine;
        for (let index: number = 0; index < node.children.length; index += 1) {
            containDraft(node.children[index]);
            endLine = Math.max(endLine, node.children[index].endLine);
        }
        node.endLine = endLine;
    };
    for (let index: number = 0; index < roots.length; index += 1) {
        containDraft(roots[index]);
    }
    return roots.map(draftToNode);
};
/**
 * Custom property or preprocessor variable declaration inside or beside a
 * rule. A value may continue on the next lines, so the pattern captures the
 * whole segment up to the closing `;`/`}` rather than a single line.
 */
const CssVariable: RegExp = /^\s*(--[A-Za-z0-9_-]+|\$[A-Za-z0-9_-]+)\s*:\s*([\s\S]*)$/;

/**
 * Block comment inside a selector prelude or a declaration value.
 */
const CssBlockComment: RegExp = /\/\*[\s\S]*?\*\//g;

/**
 * `//` line comment at a line start or after whitespace. Applied only to the
 * preprocessor flavours, where `//` really is a comment; `.css` keeps the
 * characters because an unquoted `url(//host/path)` is a value.
 */
const CssLineComment: RegExp = /(^|\s)\/\/[^\n]*/g;

/**
 * Parse a CSS/SCSS/Less stylesheet.
 *
 * Every block's prelude becomes a `section` node nested at its brace depth: a
 * top-level selector, a nested selector such as `&:hover`, or an at-rule
 * header such as `@media (min-width: 40rem)`. A rule inside `@media` or
 * `@supports` therefore keeps its place in the outline instead of being used
 * only for brace counting. Custom properties (`--x`) and preprocessor
 * variables (`$x`) declared directly in a block become `property` children in
 * document order; a variable at the top level is a root property. A variable
 * declared on the same line as its block (`a { --gap: 8px; }`) is found too.
 *
 * Comments and strings are masked before scanning, so a `{` inside a
 * `url("...")` or a comment never changes the structure. `//` is a comment
 * only for `.scss`/`.less` and for Vue style blocks parsed through this
 * function; in `.css` it is ordinary value text, which keeps an unquoted
 * protocol-relative URL and every rule after it intact. A block without a
 * matching `}` runs to the last line of the text instead of collapsing to its
 * selector line.
 *
 * @param input - Decoded stylesheet text.
 * @returns Selector, at-rule and variable tree.
 */
export const parseCss: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const preprocessor: boolean = !hasExtension(baseNameOf(input.path), [".css"]);
    const masked: string = maskSource(input.text, {
        lineComments: preprocessor ? ["//"] : [],
        blockComments: true,
        strings: true,
        template: false,
        tripleQuotes: false,
        regex: false,
        url: true,
    });
    const starts: readonly number[] = source.starts;
    const roots: DraftOutlineNode[] = [];
    const stack: DraftOutlineNode[] = [];
    let segmentStart: number = 0;
    /**
     * First non-whitespace offset of a masked segment, so a leading comment or
     * blank line does not move a node's start line.
     */
    const firstSignificant: (from: number, to: number) => number = (from: number, to: number): number => {
        let cursor: number = from;
        while (cursor < to && /\s/.test(masked[cursor])) {
            cursor += 1;
        }
        return cursor;
    };
    /**
     * Last non-whitespace offset of a masked segment, used for a declaration's
     * end line when the value spans several lines.
     */
    const lastSignificant: (from: number, to: number) => number = (from: number, to: number): number => {
        let cursor: number = to - 1;
        while (cursor >= from && /\s/.test(masked[cursor])) {
            cursor -= 1;
        }
        return Math.max(from, cursor);
    };
    /**
     * Raw source of a segment with the comments that may decorate a selector or
     * a value removed. Only the preprocessor flavours drop `//` comments.
     */
    const cleanRaw: (from: number, to: number) => string = (from: number, to: number): string => {
        const raw: string = input.text.slice(from, to).replace(CssBlockComment, " ");
        return preprocessor ? raw.replace(CssLineComment, "$1") : raw;
    };
    const attach: (draft: DraftOutlineNode) => void = (draft: DraftOutlineNode): void => {
        const parent: DraftOutlineNode | undefined = stack.length === 0 ? undefined : stack[stack.length - 1];
        if (parent === (void 0)) {
            roots.push(draft);
            return;
        }
        parent.children.push(draft);
    };
    /**
     * Turn the segment before a `;` or a `}` into a property node when it is a
     * custom property or a preprocessor variable. Plain declarations, at-rules
     * without a block and nested selectors are intentionally ignored.
     */
    const addProperty: (from: number, to: number) => void = (from: number, to: number): void => {
        const match: RegExpExecArray | null = CssVariable.exec(masked.slice(from, to));
        if (match === null) {
            return;
        }
        const rawMatch: RegExpExecArray | null = CssVariable.exec(cleanRaw(from, to));
        const value: string = (rawMatch === null ? "" : rawMatch[2]).replace(/;\s*$/, "").trim();
        const startLine: number = lineAtOffset(starts, firstSignificant(from, to));
        const endLine: number = Math.max(startLine, lineAtOffset(starts, lastSignificant(from, to)));
        attach({
            label: match[1],
            kind: "property",
            startLine,
            endLine,
            depth: stack.length,
            ...(value.length === 0 ? {} : { detail: value }),
            children: [],
        });
    };
    /**
     * Open one block: its prelude is the selector/at-rule label, its brace
     * depth is the nesting depth, and its end line is filled in at the closing
     * brace.
     */
    const openBlock: (from: number, open: number) => void = (from: number, open: number): void => {
        const label: string = cleanRaw(from, open).trim();
        const startLine: number = lineAtOffset(starts, firstSignificant(from, open));
        const draft: DraftOutlineNode = { label, kind: "section", startLine, endLine: startLine, depth: stack.length, children: [] };
        attach(draft);
        stack.push(draft);
    };
    for (let index: number = 0; index < masked.length; index += 1) {
        const character: string = masked[index];
        if (character === "{") {
            openBlock(segmentStart, index);
            segmentStart = index + 1;
            continue;
        }
        if (character === "}") {
            addProperty(segmentStart, index);
            const closed: DraftOutlineNode | undefined = stack.pop();
            if (closed !== (void 0)) {
                closed.endLine = Math.max(closed.startLine, lineAtOffset(starts, index));
            }
            segmentStart = index + 1;
            continue;
        }
        if (character === ";") {
            addProperty(segmentStart, index);
            segmentStart = index + 1;
        }
    }
    addProperty(segmentStart, masked.length);
    while (stack.length > 0) {
        const closed: DraftOutlineNode = stack.pop()!;
        closed.endLine = Math.max(closed.startLine, source.totalLines);
    }
    /**
     * Drop blocks whose prelude was empty. Only malformed markup can produce
     * one, and a nameless block has nothing an outline consumer could anchor
     * to.
     */
    const keepNamed: (drafts: readonly DraftOutlineNode[]) => DraftOutlineNode[] = (drafts: readonly DraftOutlineNode[]): DraftOutlineNode[] =>
        drafts
            .filter((draft: DraftOutlineNode): boolean => draft.label.length > 0)
            .map((draft: DraftOutlineNode): DraftOutlineNode => ({ ...draft, children: keepNamed(draft.children) }));
    return keepNamed(roots).map(draftToNode);
};

/**
 * Sass indented-syntax variable: `$name: value`.
 */
const SassVariable: RegExp = /^(\$[A-Za-z_][\w-]*)\s*:\s*(.*)$/;

/**
 * Sass indented-syntax mixin or function definition.
 */
const SassMixin: RegExp = /^@(?:mixin|function)\s+([A-Za-z_][\w-]*)/;

/**
 * Sass property line: a name, a colon and a value separated by whitespace. A
 * selector such as `a:hover` has no space after its colon and stays a selector.
 */
const SassProperty: RegExp = /^([A-Za-z_][\w-]*)\s*:\s+\S/;

/**
 * Sass directives that never open a block, so they carry no outline structure.
 * `@else` is included because it belongs to the preceding `@if`.
 */
const SassIgnoredDirective: RegExp = /^@(?:include|import|use|forward|extend|debug|warn|error|return|content|else)\b/;

/**
 * Parse a Sass stylesheet written in the indented syntax (`.sass`).
 *
 * Sass has no braces: a selector, mixin or nested property owns the following
 * deeper-indented lines, exactly like Python. The scanner uses that indentation
 * to build the tree and masks line comments, block comments and strings first.
 * Each significant line is classified as:
 *
 * - `$name: value` -> `property` (a Sass variable, detail is the value);
 * - `@mixin name` / `@function name` -> `macro`;
 * - `name: value` with a space after the colon -> `property`;
 * - anything else -> `section`, which is what a selector, a nested selector
 *   such as `&:hover` and a control-flow at-rule such as `@media` are.
 *
 * One-line directives (`@include`, `@use`, `@extend`, ...) are skipped because
 * they open no block. A property value may itself be an indented block; the
 * outer property still becomes a node and the nested lines become its children.
 *
 * @param input - Decoded Sass text.
 * @returns Selector/variable/mixin tree.
 */
export const parseSass: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const masked: string = maskSource(input.text, {
        lineComments: ["//"],
        blockComments: true,
        strings: true,
        template: false,
        tripleQuotes: false,
        regex: false,
    });
    const maskedLines: readonly string[] = splitLines(masked);
    const roots: MutableOutlineNode[] = [];
    const stack: Array<{ readonly indent: number; readonly node: MutableOutlineNode; }> = [];
    let lastContent: number = 0;
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const maskedLine: string = maskedLines[line - 1] ?? "";
        if (maskedLine.trim().length === 0) {
            continue;
        }
        const raw: string = (source.lines[line - 1] ?? "").trim();
        if (raw.length === 0) {
            continue;
        }
        const indent: number = pythonIndent(maskedLine);
        const before: number = lastContent;
        lastContent = line;
        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
            const closed: { readonly indent: number; readonly node: MutableOutlineNode; } = stack.pop()!;
            closed.node.endLine = Math.max(closed.node.startLine, before);
        }
        const variable: RegExpExecArray | null = SassVariable.exec(raw);
        const mixin: RegExpExecArray | null = SassMixin.exec(raw);
        const property: RegExpExecArray | null = SassProperty.exec(raw);
        let label: string = "";
        let kind: OutlineKind = "section";
        let detail: string = "";
        if (variable !== null) {
            label = variable[1];
            kind = "property";
            detail = variable[2].trim();
        } else if (mixin !== null) {
            label = mixin[1];
            kind = "macro";
            detail = raw;
        } else if (SassIgnoredDirective.test(raw)) {
            continue;
        } else if (property !== null) {
            label = property[1];
            kind = "property";
            detail = raw;
        } else {
            label = raw;
        }
        if (label.length === 0) {
            continue;
        }
        const parent: MutableOutlineNode | undefined = stack.length === 0 ? undefined : stack[stack.length - 1].node;
        const node: MutableOutlineNode = {
            label,
            kind,
            startLine: line,
            endLine: line,
            depth: parent === (void 0) ? 0 : parent.depth + 1,
            ...(detail.length === 0 ? {} : { detail }),
            children: [],
        };
        if (parent === (void 0)) {
            roots.push(node);
        } else {
            parent.children.push(node);
        }
        stack.push({ indent, node });
    }
    while (stack.length > 0) {
        const closed: { readonly indent: number; readonly node: MutableOutlineNode; } = stack.pop()!;
        closed.node.endLine = Math.max(closed.node.startLine, lastContent);
    }
    return roots.map(mutableToNode);
};

/**
 * Parse a Sass stylesheet. `.sass` uses the indented syntax and goes through
 * `parseSass`; `.scss` and `.less` keep the brace scanner in `parseCss`.
 *
 * The strategy id stays `scss` for the whole Sass family, so a caller that only
 * knows "this is Sass" keeps one tag while the grammar difference is handled
 * here instead of at selection time.
 *
 * @param input - Decoded Sass/SCSS text.
 * @returns Selector/variable/mixin tree.
 */
export const parseScss: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] =>
    hasExtension(baseNameOf(input.path), [".sass"]) ? parseSass(input) : parseCss(input);

/**
 * Result of a JSON/JSONC parse attempt. `ok: false` means the caller should use
 * the indentation fallback instead of failing the tool.
 */
interface JsonDocument {
    readonly ok: boolean;
    readonly value: unknown;
}

/**
 * A parsed top-level member with its located line.
 */
interface JsonMember {
    readonly label: string;
    readonly detail: string;
    readonly startLine: number;
}

/**
 * Whether a value is a plain record.
 */
const isRecord: (value: unknown) => value is Record<string, unknown> = (value: unknown): value is Record<string, unknown> =>
    typeof(value) === "object" && value !== null && !Array.isArray(value);

/**
 * Remove `//` and block comments outside strings while preserving offsets.
 */
const stripJsonComments: (text: string) => string = (text: string): string => {
    const characters: string[] = text.split("");
    let index: number = 0;
    while (index < text.length) {
        const character: string = text[index];
        if (character === '"') {
            index += 1;
            while (index < text.length) {
                if (text[index] === "\\") {
                    index += 2;
                    continue;
                }
                if (text[index] === '"' || text[index] === "\n") {
                    index += 1;
                    break;
                }
                index += 1;
            }
            continue;
        }
        if (character === "/" && text[index + 1] === "/") {
            const newline: number = text.indexOf("\n", index);
            const stop: number = newline === -1 ? text.length : newline;
            for (let cursor: number = index; cursor < stop; cursor += 1) {
                characters[cursor] = " ";
            }
            index = stop;
            continue;
        }
        if (character === "/" && text[index + 1] === "*") {
            const end: number = text.indexOf("*/", index + 2);
            const stop: number = end === -1 ? text.length : end + 2;
            for (let cursor: number = index; cursor < stop; cursor += 1) {
                if (text[cursor] !== "\n") {
                    characters[cursor] = " ";
                }
            }
            index = stop;
            continue;
        }
        index += 1;
    }
    return characters.join("");
};

/**
 * Parse JSON first, then JSONC (comments and trailing commas).
 */
const parseJsonDocument: (text: string) => JsonDocument = (text: string): JsonDocument => {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch {
        const cleaned: string = stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1");
        try {
            return { ok: true, value: JSON.parse(cleaned) };
        } catch {
            return { ok: false, value: undefined };
        }
    }
};

/**
 * Short factual detail for one JSON value.
 */
const jsonPreview: (value: unknown) => string = (value: unknown): string => {
    if (Array.isArray(value)) {
        return `[${value.length}]`;
    }
    if (isRecord(value)) {
        return `{${Object.keys(value).length}}`;
    }
    const encoded: string | undefined = JSON.stringify(value);
    return encoded === (void 0) ? "" : encoded;
};

/**
 * Locate a quoted JSON key at or after an offset, preferring the sequential
 * search so a repeated key name still points at the right occurrence.
 */
const findJsonKey: (text: string, key: string, fromOffset: number) => number = (text: string, key: string, fromOffset: number): number => {
    const literal: string = JSON.stringify(key);
    let index: number = text.indexOf(literal, fromOffset);
    if (index === -1) {
        index = text.indexOf(literal);
    }
    return index === -1 ? Math.max(0, fromOffset) : index;
};

/**
 * Build key nodes for a parsed object.
 */
const jsonObjectMembers: (value: Record<string, unknown>) => JsonMember[] = (value: Record<string, unknown>): JsonMember[] =>
    Object.keys(value)
        .slice(0, 100)
        .map((key: string): JsonMember => ({ label: key, detail: jsonPreview(value[key]), startLine: 1 }));

/**
 * Build member nodes for a top-level object using located key lines.
 */
const jsonObjectNodes: (value: Record<string, unknown>, source: SourceLines) => OutlineNode[] = (value: Record<string, unknown>, source: SourceLines): OutlineNode[] => {
    const members: JsonMember[] = jsonObjectMembers(value);
    let offset: number = 0;
    const located: JsonMember[] = members.map((member: JsonMember): JsonMember => {
        const found: number = findJsonKey(source.text, member.label, offset);
        offset = found + 1;
        return { ...member, startLine: lineAtOffset(source.starts, found) };
    });
    return located.map((member: JsonMember, index: number): OutlineNode => {
        const next: JsonMember | undefined = located[index + 1];
        const endLine: number = next === (void 0) ? source.totalLines : Math.max(member.startLine, next.startLine - 1);
        return outlineNode({
            label: member.label,
            kind: "key",
            startLine: member.startLine,
            endLine,
            depth: 0,
            detail: member.detail,
        });
    });
};

/**
 * Locate one array element by its JSON token; structures located by their
 * opening bracket, primitives by their encoded literal.
 */
const findArrayToken: (text: string, value: unknown, fromOffset: number) => number = (text: string, value: unknown, fromOffset: number): number => {
    const needle: string = Array.isArray(value) ? "[" : isRecord(value) ? "{" : JSON.stringify(value) ?? "";
    const index: number = needle.length === 0 ? -1 : text.indexOf(needle, fromOffset);
    return index === -1 ? Math.max(0, fromOffset) : index;
};

/**
 * Build nodes for a top-level array, capped at 100 elements.
 */
const jsonArrayNodes: (value: readonly unknown[], source: SourceLines) => OutlineNode[] = (value: readonly unknown[], source: SourceLines): OutlineNode[] => {
    const members: JsonMember[] = [];
    let offset: number = 0;
    for (let index: number = 0; index < Math.min(value.length, 100); index += 1) {
        const found: number = findArrayToken(source.text, value[index], offset);
        offset = found + 1;
        members.push({ label: `[${index}]`, detail: jsonPreview(value[index]), startLine: lineAtOffset(source.starts, found) });
    }
    return members.map((member: JsonMember, index: number): OutlineNode => {
        const next: JsonMember | undefined = members[index + 1];
        const endLine: number = next === (void 0) ? source.totalLines : Math.max(member.startLine, next.startLine - 1);
        return outlineNode({ label: member.label, kind: "key", startLine: member.startLine, endLine, depth: 0, detail: member.detail });
    });
};

/**
 * Fallback for invalid JSON: top-level keys found by indentation. Keys at the
 * smallest indentation win, because that is the nesting level the file meant as
 * its top level.
 */
const jsonFallbackNodes: (source: SourceLines) => OutlineNode[] = (source: SourceLines): OutlineNode[] => {
    const pattern: RegExp = /^(\s*)"((?:[^"\\]|\\.)+)"\s*:/;
    const found: Array<{ readonly key: string; readonly line: number; readonly indent: number; }> = [];
    for (let index: number = 0; index < source.totalLines; index += 1) {
        const match: RegExpExecArray | null = pattern.exec(source.lines[index]);
        if (match !== null) {
            found.push({ key: match[2], line: index + 1, indent: match[1].length });
        }
    }
    if (found.length === 0) {
        return [];
    }
    let minimum: number = found[0].indent;
    for (let index: number = 1; index < found.length; index += 1) {
        minimum = Math.min(minimum, found[index].indent);
    }
    const top: Array<{ readonly key: string; readonly line: number; readonly indent: number; }> = found
        .filter((item): boolean => item.indent === minimum)
        .slice(0, 100);
    return top.map((item, index: number): OutlineNode => {
        const next: { readonly key: string; readonly line: number; readonly indent: number; } | undefined = top[index + 1];
        const endLine: number = next === (void 0) ? source.totalLines : Math.max(item.line, next.line - 1);
        return outlineNode({ label: item.key, kind: "key", startLine: item.line, endLine, depth: 0 });
    });
};

/**
 * Parse a JSON or JSONC document.
 *
 * A valid document reports its top-level object keys (or up to 100 array
 * elements) with lines located by scanning the source text, because JSON itself
 * has no line numbers. An invalid document falls back to an indentation scan of
 * quoted `"key":` lines instead of failing the tool.
 *
 * @param input - Decoded JSON text.
 * @returns Key tree.
 */
export const parseJson: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    const parsed: JsonDocument = parseJsonDocument(input.text);
    if (parsed.ok) {
        if (Array.isArray(parsed.value)) {
            return jsonArrayNodes(parsed.value, source);
        }
        if (isRecord(parsed.value)) {
            return jsonObjectNodes(parsed.value, source);
        }
        return [];
    }
    return jsonFallbackNodes(source);
};

/**
 * Mutable node used by indentation- and container-based parsers.
 */
interface MutableOutlineNode {
    readonly label: string;
    readonly kind: OutlineKind;
    readonly startLine: number;
    endLine: number;
    readonly depth: number;
    readonly detail?: string;
    readonly modifiers?: readonly string[];
    readonly children: MutableOutlineNode[];
}

/**
 * One container (class, namespace, module, impl) while its children are being
 * collected.
 */
interface ContainerDraft {
    readonly node: MutableOutlineNode;
    readonly startLine: number;
    readonly endLine: number;
    readonly kind: OutlineKind;
    readonly depth: number;
}

/**
 * Convert a mutable draft tree into public symbol nodes.
 */
const mutableToNode: (node: MutableOutlineNode) => OutlineNode = (node: MutableOutlineNode): OutlineNode =>
    outlineNode({
        label: node.label,
        kind: node.kind,
        startLine: node.startLine,
        endLine: node.endLine,
        depth: node.depth,
        ...(node.modifiers === (void 0) || node.modifiers.length === 0 ? {} : { modifiers: [...node.modifiers] }),
        ...(node.detail === (void 0) ? {} : { detail: node.detail }),
        children: node.children.map(mutableToNode),
    });

/**
 * Innermost container that strictly encloses a line. The declaration line of a
 * container is not inside itself, which keeps a nested type from being
 * classified as a member of the container it declares.
 */
const innermostContainer: (containers: readonly ContainerDraft[], line: number) => ContainerDraft | undefined = (containers: readonly ContainerDraft[], line: number): ContainerDraft | undefined => {
    let best: ContainerDraft | undefined;
    for (let index: number = 0; index < containers.length; index += 1) {
        const container: ContainerDraft = containers[index];
        if (container.startLine < line && line <= container.endLine && (best === (void 0) || container.startLine > best.startLine)) {
            best = container;
        }
    }
    return best;
};

/**
 * Keywords that can precede `(` without being a function declaration.
 */
const CallLikeKeywords: ReadonlySet<string> = new Set<string>([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "sizeof",
    "typeof",
    "new",
    "delete",
    "throw",
    "do",
    "else",
    "case",
    "default",
    "try",
    "assert",
    "static_assert",
    "using",
    "typedef",
    "namespace",
    "class",
    "struct",
    "enum",
    "union",
    "template",
    "extern",
    "friend",
    "operator",
    "await",
    "yield",
]);

/**
 * TypeScript/JavaScript declaration recognized on one top-level line.
 */
interface TsDeclaration {
    readonly label: string;
    readonly kind: OutlineKind;
    readonly detail: string;
}

const TsDefaultClass: RegExp = /^export\s+default\s+(?:abstract\s+)?class(?:\s+([\p{ID_Start}_$][\p{ID_Continue}$]*))?/u;
const TsDefaultFunction: RegExp = /^export\s+default\s+(?:async\s+)?function\s*\*?\s*([\p{ID_Start}_$][\p{ID_Continue}$]*)?/u;
const TsDefaultInterface: RegExp = /^export\s+default\s+interface\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u;
const TsClassDeclaration: RegExp = /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u;
const TsInterfaceDeclaration: RegExp = /^(?:export\s+)?(?:declare\s+)?interface\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u;
const TsEnumDeclaration: RegExp = /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u;
const TsNamespaceDeclaration: RegExp = /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u;
const TsQuotedModuleDeclaration: RegExp = /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+["']([^"']+)["']/u;
const TsTypeDeclaration: RegExp = /^(?:export\s+)?(?:declare\s+)?type\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u;
const TsFunctionDeclaration: RegExp = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\p{ID_Start}_$][\p{ID_Continue}$]*)/u;
const TsVariableDeclaration: RegExp = /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u;
const TsDefaultExpression: RegExp = /^export\s+default\s+(.+?)\s*;?\s*$/u;
const TsExportList: RegExp = /^export\s*(?:\{|\*)/;
const TsMemberMethod: RegExp = /^(?:(?:public|private|protected|static|readonly|abstract|async|override|declare|get|set|accessor)\s+)*\*?\s*([#\p{ID_Start}_$][\p{ID_Continue}$]*)\s*(?:<[^>]*>)?\s*\(/u;
const TsMemberProperty: RegExp = /^(?:(?:public|private|protected|static|readonly|abstract|override|declare|accessor)\s+)*([#\p{ID_Start}_$][\p{ID_Continue}$]*)\s*[?!]?\s*(?::[^=;]*)?(?:=|;)/u;
const TsFunctionValue: RegExp = /=\s*(?:async\s+)?(?:function\b|<[^>]*>\s*)?(?:\([^)]*\)\s*(?::[^=;]*?)?=>|[\p{ID_Start}_$][\p{ID_Continue}$]*\s*=>)/u;

/**
 * Leading modifiers for a class member or top-level declaration, delegated to
 * the keyword registry so `static`, `readonly` and future modifiers do not have
 * to be repeated in this file.
 */
const tsModifiers = (line: string): readonly string[] => DefaultOutlineKeywords.leadingModifiers(line);

/**
 * Last identifier-like word before an offset, used to tell `extends { ... }`
 * apart from a real body brace.
 */
const tsWordBefore: (text: string, index: number) => string = (text: string, index: number): string => {
    let end: number = index;
    while (end > 0 && /\s/.test(text[end - 1])) {
        end -= 1;
    }
    let start: number = end;
    while (start > 0 && /[\w$]/.test(text[start - 1])) {
        start -= 1;
    }
    return text.slice(start, end);
};

/**
 * Find where a TypeScript declaration ends.
 *
 * A plain "first `{`" scan mistakes a destructured parameter or an inline type
 * literal for the body. This variant tracks parentheses/brackets, skips a
 * balanced brace in a type/pattern position (`:`/`=`/`,`/`<`/`|`/`&`/`?` or a
 * generic `extends`), and only then accepts a body brace. A declaration with no
 * body still ends at its first top-level `;`.
 */
const tsBlockEndLine: (source: MaskedSource, startLine: number) => number = (source: MaskedSource, startLine: number): number => {
    const start: number = source.starts[startLine - 1] ?? 0;
    const masked: string = source.masked;
    let parentheses: number = 0;
    let brackets: number = 0;
    for (let index: number = start; index < masked.length; index += 1) {
        const character: string = masked[index];
        if (character === "(") {
            parentheses += 1;
            continue;
        }
        if (character === ")") {
            if (parentheses > 0) {
                parentheses -= 1;
            }
            continue;
        }
        if (character === "[") {
            brackets += 1;
            continue;
        }
        if (character === "]") {
            if (brackets > 0) {
                brackets -= 1;
            }
            continue;
        }
        if (character === ";") {
            if (parentheses === 0 && brackets === 0) {
                return lineAtOffset(source.starts, index);
            }
            continue;
        }
        if (character === "}") {
            if (parentheses === 0 && brackets === 0) {
                return lineAtOffset(source.starts, index);
            }
            continue;
        }
        if (character !== "{") {
            continue;
        }
        const closeIndex: number | undefined = source.close.get(index);
        if (closeIndex === (void 0)) {
            return startLine;
        }
        if (parentheses > 0 || brackets > 0) {
            index = closeIndex;
            continue;
        }
        const before: string = significantBefore(masked, index);
        const word: string = tsWordBefore(masked, index);
        if (
            before === ":" ||
            before === "=" ||
            before === "," ||
            before === "<" ||
            before === "|" ||
            before === "&" ||
            before === "?" ||
            word === "extends"
        ) {
            index = closeIndex;
            continue;
        }
        return lineAtOffset(source.starts, closeIndex);
    }
    return startLine;
};

/**
 * Remove leading decorators from one line so `@Input() title = "x";` still
 * reports `title`. A decorator whose parenthesis is still open is treated as
 * spanning lines and yields an empty remainder; the member, if any, is then
 * seen on its own later line.
 */
const stripTsDecorators: (line: string) => string = (line: string): string => {
    let rest: string = line.trim();
    while (rest.startsWith("@")) {
        let cursor: number = 1;
        while (cursor < rest.length && /[\p{ID_Continue}$.:]/u.test(rest[cursor])) {
            cursor += 1;
        }
        while (cursor < rest.length && /\s/.test(rest[cursor])) {
            cursor += 1;
        }
        if (rest[cursor] === "<") {
            let angles: number = 0;
            for (; cursor < rest.length; cursor += 1) {
                if (rest[cursor] === "<") {
                    angles += 1;
                } else if (rest[cursor] === ">") {
                    angles -= 1;
                    if (angles === 0) {
                        cursor += 1;
                        break;
                    }
                }
            }
            while (cursor < rest.length && /\s/.test(rest[cursor])) {
                cursor += 1;
            }
        }
        if (rest[cursor] === "(") {
            let parentheses: number = 0;
            let closed: boolean = false;
            for (; cursor < rest.length; cursor += 1) {
                if (rest[cursor] === "(") {
                    parentheses += 1;
                } else if (rest[cursor] === ")") {
                    parentheses -= 1;
                    if (parentheses === 0) {
                        cursor += 1;
                        closed = true;
                        break;
                    }
                }
            }
            if (!closed) {
                return "";
            }
        }
        rest = rest.slice(cursor).trim();
    }
    return rest;
};

/**
 * One JSX tag found by `parseTsJsxTag`.
 */
interface TsJsxTag {
    readonly name: string;
    readonly end: number;
    readonly closing: boolean;
    readonly selfClosing: boolean;
}

const TsJsxExtension: RegExp = /\.(?:tsx|jsx)$/i;
const TsJsxNameStart: RegExp = /[\p{ID_Start}_$]/u;
const TsJsxNamePart: RegExp = /[\p{ID_Continue}$.:-]/u;
const TsJsxWhitespace: RegExp = /\s/;

/**
 * Whether a path accepts JSX syntax by extension.
 */
const supportsTsJsx: (path: string) => boolean = (path: string): boolean => TsJsxExtension.test(path);

/**
 * Skip one quoted JavaScript/JSX string or template body.
 */
const tsSkipQuoted: (text: string, index: number) => number = (text: string, index: number): number => {
    const quote: string = text[index];
    let cursor: number = index + 1;
    while (cursor < text.length) {
        if (text[cursor] === "\\") {
            cursor += 2;
            continue;
        }
        if (text[cursor] === quote) {
            return cursor + 1;
        }
        cursor += 1;
    }
    return text.length;
};

/**
 * Skip one line/block comment while looking for a JSX start.
 */
const tsSkipComment: (text: string, index: number) => number | undefined = (text: string, index: number): number | undefined => {
    if (text[index] !== "/") {
        return undefined;
    }
    if (text[index + 1] === "/") {
        const newline: number = text.indexOf("\n", index + 2);
        return newline === -1 ? text.length : newline;
    }
    if (text[index + 1] === "*") {
        const close: number = text.indexOf("*/", index + 2);
        return close === -1 ? text.length : close + 2;
    }
    return undefined;
};

/**
 * Parse one JSX opening/closing/fragment tag at `index` (which points at `<`).
 */
const parseTsJsxTag: (text: string, index: number) => TsJsxTag | undefined = (text: string, index: number): TsJsxTag | undefined => {
    if (text[index] !== "<") {
        return undefined;
    }
    let cursor: number = index + 1;
    if (text[cursor] === "/") {
        cursor += 1;
        if (text[cursor] === ">") {
            return { name: "", end: cursor, closing: true, selfClosing: false };
        }
        const start: number = cursor;
        while (cursor < text.length && TsJsxNamePart.test(text[cursor])) {
            cursor += 1;
        }
        if (cursor === start) {
            return undefined;
        }
        const name: string = text.slice(start, cursor);
        while (cursor < text.length && TsJsxWhitespace.test(text[cursor])) {
            cursor += 1;
        }
        if (text[cursor] !== ">") {
            return undefined;
        }
        return { name, end: cursor, closing: true, selfClosing: false };
    }
    if (text[cursor] === ">") {
        return { name: "", end: cursor, closing: false, selfClosing: false };
    }
    if (cursor >= text.length || !TsJsxNameStart.test(text[cursor])) {
        return undefined;
    }
    const start: number = cursor;
    while (cursor < text.length && TsJsxNamePart.test(text[cursor])) {
        cursor += 1;
    }
    const name: string = text.slice(start, cursor);
    let quote: string = "";
    let braces: number = 0;
    for (; cursor < text.length; cursor += 1) {
        const character: string = text[cursor];
        if (quote.length > 0) {
            if (character === "\\") {
                cursor += 1;
                continue;
            }
            if (character === quote) {
                quote = "";
            }
            continue;
        }
        if (character === '"' || character === "'" || character === "`") {
            quote = character;
            continue;
        }
        if (character === "{") {
            braces += 1;
            continue;
        }
        if (character === "}") {
            if (braces > 0) {
                braces -= 1;
            }
            continue;
        }
        if (braces > 0) {
            continue;
        }
        if (character === ">") {
            let probe: number = cursor - 1;
            while (probe > index && TsJsxWhitespace.test(text[probe])) {
                probe -= 1;
            }
            return { name, end: cursor, closing: false, selfClosing: text[probe] === "/" };
        }
    }
    return undefined;
};

/**
 * Whether a JSX element name has a matching closing tag after `from`.
 */
const hasTsJsxClosing: (text: string, name: string, from: number) => boolean = (text: string, name: string, from: number): boolean => {
    const needle: string = name.length === 0 ? "</>" : `</${name}`;
    let at: number = text.indexOf(needle, from);
    while (at !== -1) {
        if (name.length === 0) {
            return true;
        }
        const after: string = text[at + needle.length] ?? "";
        if (after === ">" || TsJsxWhitespace.test(after)) {
            return true;
        }
        at = text.indexOf(needle, at + 1);
    }
    return false;
};

/**
 * Skip one `{ ... }` expression container inside JSX, respecting strings and
 * comments so a brace in a string does not close it early.
 */
const skipTsJsxBraces: (text: string, index: number) => number = (text: string, index: number): number => {
    let depth: number = 0;
    let quote: string = "";
    for (let cursor: number = index; cursor < text.length; cursor += 1) {
        const character: string = text[cursor];
        if (quote.length > 0) {
            if (character === "\\") {
                cursor += 1;
                continue;
            }
            if (character === quote) {
                quote = "";
            }
            continue;
        }
        if (character === '"' || character === "'" || character === "`") {
            quote = character;
            continue;
        }
        const comment: number | undefined = tsSkipComment(text, cursor);
        if (comment !== (void 0)) {
            cursor = comment - 1;
            continue;
        }
        if (character === "{") {
            depth += 1;
            continue;
        }
        if (character === "}") {
            depth -= 1;
            if (depth === 0) {
                return cursor + 1;
            }
        }
    }
    return text.length;
};

/**
 * Mask JSX tags and JSX text while preserving offsets and newlines.
 *
 * Comments, code strings and template literals outside JSX are skipped rather
 * than masked, so a `<div>` mentioned in a comment cannot open an element. A
 * tag is only accepted when a matching closing tag exists (or it is
 * self-closing), which keeps TypeScript generics such as `<T>(x: T) => x` and
 * comparisons from being mistaken for JSX. Expression containers (`{...}`) are
 * left untouched so their JavaScript still participates in brace scanning and
 * is masked by `maskSource` afterwards.
 */
const maskTsJsx: (text: string) => string = (text: string): string => {
    if (text.indexOf("<") === -1) {
        return text;
    }
    const characters: string[] = text.split("");
    const blank: (from: number, to: number) => void = (from: number, to: number): void => {
        const stop: number = Math.min(to, characters.length);
        for (let cursor: number = from; cursor < stop; cursor += 1) {
            characters[cursor] = text[cursor] === "\n" ? "\n" : " ";
        }
    };
    let index: number = 0;
    while (index < text.length) {
        const comment: number | undefined = tsSkipComment(text, index);
        if (comment !== (void 0)) {
            index = comment;
            continue;
        }
        const character: string = text[index];
        if (character === '"' || character === "'" || character === "`") {
            index = tsSkipQuoted(text, index);
            continue;
        }
        if (character !== "<") {
            index += 1;
            continue;
        }
        const tag: TsJsxTag | undefined = parseTsJsxTag(text, index);
        if (tag === (void 0) || tag.closing) {
            index += 1;
            continue;
        }
        if (!tag.selfClosing && !hasTsJsxClosing(text, tag.name, tag.end + 1)) {
            index += 1;
            continue;
        }
        blank(index, tag.end + 1);
        index = tag.end + 1;
        if (tag.selfClosing) {
            continue;
        }
        const stack: string[] = [tag.name];
        while (index < text.length && stack.length > 0) {
            if (text[index] === "{") {
                index = skipTsJsxBraces(text, index);
                continue;
            }
            if (text[index] === "<") {
                const nested: TsJsxTag | undefined = parseTsJsxTag(text, index);
                if (nested === (void 0)) {
                    blank(index, index + 1);
                    index += 1;
                    continue;
                }
                blank(index, nested.end + 1);
                index = nested.end + 1;
                if (nested.closing) {
                    stack.pop();
                } else if (!nested.selfClosing) {
                    stack.push(nested.name);
                }
                continue;
            }
            let stop: number = index;
            while (stop < text.length && text[stop] !== "<" && text[stop] !== "{") {
                stop += 1;
            }
            blank(index, stop);
            index = stop;
        }
    }
    return characters.join("");
};

/**
 * Match a TypeScript/JavaScript top-level declaration.
 *
 * `originalLine` is the unmasked line, used only for a quoted
 * `declare module "name"` label because string masking removes the name.
 */
const matchTsDeclaration: (line: string, originalLine?: string) => TsDeclaration | undefined = (
    line: string, originalLine: string = "",
): TsDeclaration | undefined => {
    let match: RegExpExecArray | null = TsDefaultClass.exec(line);
    if (match !== null) {
        return { label: match[1] ?? "default", kind: "class", detail: line };
    }
    match = TsDefaultFunction.exec(line);
    if (match !== null) {
        return { label: match[1] ?? "default", kind: "function", detail: line };
    }
    match = TsDefaultInterface.exec(line);
    if (match !== null) {
        return { label: match[1], kind: "interface", detail: line };
    }
    match = TsClassDeclaration.exec(line);
    if (match !== null) {
        return { label: match[1], kind: "class", detail: line };
    }
    match = TsInterfaceDeclaration.exec(line);
    if (match !== null) {
        return { label: match[1], kind: "interface", detail: line };
    }
    match = TsEnumDeclaration.exec(line);
    if (match !== null) {
        return { label: match[1], kind: "enum", detail: line };
    }
    match = TsNamespaceDeclaration.exec(line);
    if (match !== null) {
        return { label: match[1], kind: "namespace", detail: line };
    }
    match = TsTypeDeclaration.exec(line);
    if (match !== null) {
        return { label: match[1], kind: "type", detail: line };
    }
    match = TsFunctionDeclaration.exec(line);
    if (match !== null) {
        return { label: match[1], kind: "function", detail: line };
    }
    match = TsVariableDeclaration.exec(line);
    if (match !== null) {
        return { label: match[1], kind: "variable", detail: line };
    }
    match = TsDefaultExpression.exec(line);
    if (match !== null) {
        return { label: "default", kind: "constant", detail: line };
    }
    const quoted: RegExpExecArray | null = TsQuotedModuleDeclaration.exec(originalLine.trim());
    if (quoted !== null) {
        return { label: quoted[1], kind: "namespace", detail: originalLine.trim() };
    }
    return undefined;
};

/**
 * Collect direct class members at the class-body brace depth.
 */
const parseTsMembers: (source: MaskedSource, maskedLines: readonly string[], classStart: number, classEnd: number) => OutlineNode[] = (
    source: MaskedSource, maskedLines: readonly string[], classStart: number, classEnd: number,
): OutlineNode[] => {
    const bodyDepth: number = depthAtLine(source, classStart) + 1;
    const members: OutlineNode[] = [];
    for (let line: number = classStart + 1; line < classEnd; line += 1) {
        if (depthAtLine(source, line) !== bodyDepth) {
            continue;
        }
        const raw: string = (maskedLines[line - 1] ?? "").trim();
        if (raw.length === 0 || /^static\s*\{/.test(raw)) {
            continue;
        }
        const trimmed: string = stripTsDecorators(raw);
        if (trimmed.length === 0) {
            continue;
        }
        const modifiers: readonly string[] = tsModifiers(trimmed);
        const method: RegExpExecArray | null = TsMemberMethod.exec(trimmed);
        if (method !== null && !CallLikeKeywords.has(method[1])) {
            members.push(
                outlineNode({
                    label: method[1] === "constructor" ? "constructor" : method[1],
                    kind: "method",
                    startLine: line,
                    endLine: tsBlockEndLine(source, line),
                    depth: 1,
                    detail: trimmed,
                    modifiers,
                }),
            );
            continue;
        }
        const property: RegExpExecArray | null = TsMemberProperty.exec(trimmed);
        if (property !== null && !CallLikeKeywords.has(property[1])) {
            members.push(
                outlineNode({
                    label: property[1],
                    kind: "property",
                    startLine: line,
                    endLine: tsBlockEndLine(source, line),
                    depth: 1,
                    detail: trimmed,
                    modifiers,
                }),
            );
        }
    }
    return members;
};

/**
 * Parse TypeScript/JavaScript.
 *
 * Top-level declarations (class, interface, type, enum, namespace/module,
 * function, function-valued const/let/var and `export default`) become depth-0
 * symbols. A class contributes its constructor, methods and fields as depth-1
 * children. The scanner masks comments, strings, template literals, regular
 * expressions and their escapes before brace matching, so a `class` inside a
 * string and a `{` inside a comment cannot change the tree.
 *
 * @param input - Decoded source text.
 * @returns Declaration tree.
 */
export const parseTypeScript: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const jsxSource: string = supportsTsJsx(input.path) ? maskTsJsx(input.text) : input.text;
    const masked: string = maskSource(jsxSource);
    const braced: MaskedSource = scanBraces(source, masked);
    const maskedLines: readonly string[] = splitLines(masked);
    const nodes: OutlineNode[] = [];
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        if (depthAtLine(braced, line) !== 0) {
            continue;
        }
        const raw: string = (maskedLines[line - 1] ?? "").trim();
        const trimmed: string = stripTsDecorators(raw);
        if (trimmed.length === 0 || TsExportList.test(trimmed)) {
            continue;
        }
        const declaration: TsDeclaration | undefined = matchTsDeclaration(trimmed, (source.lines[line - 1] ?? "").trim());
        if (declaration === (void 0)) {
            continue;
        }
        const endLine: number = tsBlockEndLine(braced, line);
        const children: readonly OutlineNode[] = declaration.kind === "class" ? parseTsMembers(braced, maskedLines, line, endLine) : [];
        let kind: OutlineKind = declaration.kind;
        if (declaration.kind === "variable") {
            const offset: number = source.starts[line - 1] ?? 0;
            const window: string = masked.slice(offset, Math.min(offset + 800, masked.length));
            const semicolon: number = window.indexOf(";");
            const statement: string = semicolon === -1 ? window : window.slice(0, semicolon + 1);
            if (TsFunctionValue.test(statement)) {
                kind = "function";
            } else {
                kind = /(?:^|\s)const\s/.test(declaration.detail) ? "constant" : "variable";
            }
        }
        nodes.push(
            outlineNode({
                label: declaration.label,
                kind,
                startLine: line,
                endLine,
                depth: 0,
                detail: declaration.detail,
                modifiers: tsModifiers(declaration.detail),
                children,
            }),
        );
    }
    return nodes;
};

/**
 * Indentation width of one Python line; tabs count as four columns.
 */
const pythonIndent: (line: string) => number = (line: string): number => {
    let width: number = 0;
    for (let index: number = 0; index < line.length; index += 1) {
        const character: string = line[index];
        if (character === " ") {
            width += 1;
            continue;
        }
        if (character === "\t") {
            width += 4;
            continue;
        }
        break;
    }
    return width;
};

/**
 * Python identifier pattern (PEP 3131).
 *
 * JavaScript `\w` is ASCII-only, so it cannot match Python identifiers: a
 * `Café` class is truncated to `Caf` and a `数据` class disappears. XID_Start
 * and XID_Continue are approximated with Unicode letter, number, mark and
 * connector classes.
 */
const PythonIdentifier: string = "[\\p{L}\\p{Nl}_][\\p{L}\\p{Nl}\\p{N}\\p{Mn}\\p{Mc}\\p{Pc}_]*";

/**
 * Constant-style name: an uppercase letter followed by uppercase letters,
 * digits or underscores. A leading underscore does not make a name constant,
 * so `_private = 1` is a variable while `MAX_RETRIES` is a constant.
 */
const PythonConstant: RegExp = new RegExp("^\\p{Lu}[\\p{Lu}\\p{N}_]*$", "u");

/**
 * Keywords that can look like an annotation-only binding (`lambda: 1`) but
 * never bind a name.
 */
const PythonKeywords: ReadonlySet<string> = new Set<string>([
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "case", "class", "continue",
    "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

/**
 * `class Name` declaration, Unicode-aware.
 */
const PythonClassDeclaration: RegExp = new RegExp(`^class\\s+(${PythonIdentifier})`, "u");

/**
 * `def name(` or `async def name(` declaration, Unicode-aware.
 */
const PythonFunctionDeclaration: RegExp = new RegExp(`^(?:async\\s+)?def\\s+(${PythonIdentifier})\\s*\\(`, "u");

/**
 * One bare identifier, used for assignment targets.
 */
const PythonSimpleTarget: RegExp = new RegExp(`^${PythonIdentifier}$`, "u");

/**
 * A target followed by a type annotation, e.g. `x: int`.
 */
const PythonAnnotatedTarget: RegExp = new RegExp(`^(${PythonIdentifier})\\s*:`, "u");

/**
 * An annotation-only binding, e.g. `x: int`.
 */
const PythonAnnotatedOnly: RegExp = new RegExp(`^(${PythonIdentifier})\\s*:\\s*\\S`, "u");

/**
 * An augmented assignment, e.g. `count += 1`.
 */
const PythonAugmentedTarget: RegExp = new RegExp(
    `^(${PythonIdentifier})\\s*(?:\\*\\*=|//=|>>=|<<=|\\+=|-=|\\*=|/=|%=|@=|&=|\\|=|\\^=)`,
    "u",
);

/**
 * Per-line logical-line state for Python.
 *
 * `depth[line]` is the bracket depth at the start of the line,
 * `continued[line]` says the line continues the previous statement through a
 * trailing backslash, and `origin[line]` is the first line of the logical
 * statement that contains the line.
 */
interface PythonLineState {
    readonly depth: readonly number[];
    readonly continued: readonly boolean[];
    readonly origin: readonly number[];
}

/**
 * Index the logical lines of masked Python source.
 *
 * Strings and comments are already spaces in `maskedLines`, so any bracket
 * seen here is real syntax. The closing `):` of a multi-line class/def header
 * is commonly at column zero; treating it as a continuation keeps it out of
 * the indentation stack instead of popping the class.
 *
 * @param maskedLines - Masked source lines.
 * @param totalLines - Number of logical lines.
 * @returns Depth, continuation and origin arrays indexed by 1-based line.
 */
const pythonLineStates: (maskedLines: readonly string[], totalLines: number) => PythonLineState = (
    maskedLines, totalLines,
): PythonLineState => {
    const depth: number[] = new Array<number>(totalLines + 2).fill(0);
    const continued: boolean[] = new Array<boolean>(totalLines + 2).fill(false);
    const origin: number[] = new Array<number>(totalLines + 2).fill(1);
    let current: number = 0;
    let start: number = 1;
    for (let line: number = 1; line <= totalLines; line += 1) {
        const isContinuation: boolean = line > 1 && (current > 0 || continued[line] === true);
        if (!isContinuation) {
            start = line;
        }
        depth[line] = current;
        origin[line] = start;
        const text: string = maskedLines[line - 1] ?? "";
        for (let index: number = 0; index < text.length; index += 1) {
            const character: string = text[index];
            if (character === "(" || character === "[" || character === "{") {
                current += 1;
                continue;
            }
            if (character === ")" || character === "]" || character === "}") {
                current = Math.max(0, current - 1);
            }
        }
        continued[line + 1] = /(?:^|[^\\])\\$/.test(text.trimEnd());
    }
    return { depth, continued, origin };
};

/**
 * Index of the top-level assignment `=` in one masked line, or -1 when the
 * line is not an assignment.
 *
 * A depth-zero `=` that begins a comparison, a compound operator or the walrus
 * operator is skipped, so `x == 1`, `x += 1` and `x := 1` do not look like an
 * assignment.
 *
 * @param line - Trimmed masked line.
 * @returns Zero-based index of the operator, or -1.
 */
const pythonAssignmentIndex: (line: string) => number = (line: string): number => {
    const forbidden: string = "=!<>+-*/%@&|^~:";
    let depth: number = 0;
    for (let index: number = 0; index < line.length; index += 1) {
        const character: string = line[index];
        if (character === "(" || character === "[" || character === "{") {
            depth += 1;
            continue;
        }
        if (character === ")" || character === "]" || character === "}") {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0 || character !== "=") {
            continue;
        }
        const previous: string = index === 0 ? "" : line[index - 1];
        const next: string = line[index + 1] ?? "";
        if (next === "=" || forbidden.includes(previous)) {
            continue;
        }
        return index;
    }
    return -1;
};

/**
 * Names bound by the left-hand side of one assignment.
 *
 * Attribute and subscript targets (`self.x =`, `items[0] =`) bind no new name
 * and yield nothing; a tuple target yields every simple name, including a
 * starred rest (`first, *rest`). A nested target that cannot be resolved
 * simply is skipped rather than reported partially.
 *
 * @param left - Masked text before the assignment operator.
 * @returns Bound names in source order.
 */
const pythonTargetNames: (left: string) => string[] = (left: string): string[] => {
    const text: string = left.trim();
    if (text.length === 0) {
        return [];
    }
    const annotated: RegExpExecArray | null = PythonAnnotatedTarget.exec(text);
    if (annotated !== null && !PythonKeywords.has(annotated[1])) {
        return [annotated[1]];
    }
    if (PythonSimpleTarget.test(text) && !PythonKeywords.has(text)) {
        return [text];
    }
    const unwrapped: string = text.replace(/^[\(\[]/, "").replace(/[\)\]]$/, "").trim();
    const parts: string[] = unwrapped
        .split(",")
        .map((part: string): string => part.trim())
        .filter((part: string): boolean => part.length > 0);
    if (parts.length === 0) {
        return [];
    }
    if (parts.length === 1) {
        return PythonSimpleTarget.test(parts[0]) && !PythonKeywords.has(parts[0]) ? [parts[0]] : [];
    }
    const names: string[] = [];
    for (let index: number = 0; index < parts.length; index += 1) {
        const part: string = parts[index].startsWith("*") ? parts[index].slice(1).trim() : parts[index];
        if (!PythonSimpleTarget.test(part) || PythonKeywords.has(part)) {
            return [];
        }
        names.push(part);
    }
    return names;
};

/**
 * Names bound by one assignment-family line, in source order.
 *
 * Covers plain assignment, annotated assignment, annotation-only declarations,
 * augmented assignment and tuple unpacking. Comparison expressions are not
 * assignments.
 *
 * @param line - Trimmed masked line.
 * @returns Bound names, empty when the line binds nothing at class/module scope.
 */
const pythonAssignmentTargets: (line: string) => string[] = (line: string): string[] => {
    const augmented: RegExpExecArray | null = PythonAugmentedTarget.exec(line);
    if (augmented !== null) {
        return PythonKeywords.has(augmented[1]) ? [] : [augmented[1]];
    }
    const assignment: number = pythonAssignmentIndex(line);
    if (assignment >= 0) {
        return pythonTargetNames(line.slice(0, assignment));
    }
    const annotated: RegExpExecArray | null = PythonAnnotatedOnly.exec(line);
    return annotated === null || PythonKeywords.has(annotated[1]) ? [] : [annotated[1]];
};

/**
 * Raw declaration text for `detail`.
 *
 * Masked text is safe for structure but blanks every string literal, which
 * used to collapse `label = "value"` to `label =`. Detail keeps the source line
 * so values and string annotations stay visible; the registry bounds its
 * length.
 *
 * @param source - Full source with raw lines.
 * @param line - 1-based line number.
 * @returns Trimmed raw line.
 */
const pythonDetail: (source: SourceLines, line: number) => string = (source: SourceLines, line: number): string =>
    (source.lines[line - 1] ?? "").trim();

/**
 * Parse Python.
 *
 * `class` and `def`/`async def` lines are nested by indentation, so a method is
 * a child of its class and a nested function is a child of its function. A
 * node ends on the last content line before a line at the same or a smaller
 * indent. Comments and all string forms (including triple-quoted blocks) are
 * masked first, so a `def` inside a docstring is not a symbol.
 *
 * Logical lines are tracked separately from indentation, so a header split
 * across brackets, a multi-line decorator or a trailing backslash cannot
 * detach a body from its owner. Identifiers are Unicode-aware and
 * module/class assignments cover plain, annotated, annotation-only, augmented
 * and tuple forms.
 *
 * @param input - Decoded Python text.
 * @returns Class/function tree.
 */
export const parsePython: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const masked: string = maskSource(input.text, {
        lineComments: ["#"],
        blockComments: false,
        strings: true,
        template: false,
        tripleQuotes: true,
        regex: false,
    });
    const maskedLines: readonly string[] = splitLines(masked);
    const states: PythonLineState = pythonLineStates(maskedLines, source.totalLines);
    const roots: MutableOutlineNode[] = [];
    const stack: Array<{ readonly indent: number; readonly node: MutableOutlineNode; }> = [];
    let lastContent: number = 0;
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const maskedLine: string = maskedLines[line - 1] ?? "";
        const trimmed: string = maskedLine.trim();
        if (trimmed.length === 0) {
            continue;
        }
        if (states.depth[line] > 0 || states.continued[line] === true) {
            /**
             * A continuation belongs to the logical line that opened it and
             * must not pop the indentation stack. It may extend the enclosing
             * node, except when the logical line is a decorator: a method's
             * range must not grow to include the next member's decorator.
             */
            const originLine: number = states.origin[line] ?? line;
            if (!(maskedLines[originLine - 1] ?? "").trim().startsWith("@")) {
                lastContent = line;
            }
            continue;
        }
        const indent: number = pythonIndent(maskedLine);
        const before: number = lastContent;
        const decorator: boolean = trimmed.startsWith("@");
        if (!decorator) {
            lastContent = line;
        }
        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
            const closed: { readonly indent: number; readonly node: MutableOutlineNode; } = stack.pop()!;
            closed.node.endLine = Math.max(closed.node.startLine, before);
        }
        if (decorator) {
            continue;
        }
        const detail: string = pythonDetail(source, line);
        const owner: { readonly indent: number; readonly node: MutableOutlineNode; } | undefined = stack[stack.length - 1];
        const targets: string[] = pythonAssignmentTargets(trimmed);
        if (targets.length > 0) {
            if (owner !== (void 0) && owner.node.kind === "class" && indent > owner.indent) {
                for (let index: number = 0; index < targets.length; index += 1) {
                    owner.node.children.push({
                        label: targets[index],
                        kind: "property",
                        startLine: line,
                        endLine: line,
                        depth: owner.node.depth + 1,
                        detail,
                        children: [],
                    });
                }
                continue;
            }
            if (owner === (void 0)) {
                for (let index: number = 0; index < targets.length; index += 1) {
                    roots.push({
                        label: targets[index],
                        kind: PythonConstant.test(targets[index]) ? "constant" : "variable",
                        startLine: line,
                        endLine: line,
                        depth: 0,
                        detail,
                        children: [],
                    });
                }
                continue;
            }
        }
        const classMatch: RegExpExecArray | null = PythonClassDeclaration.exec(trimmed);
        const defMatch: RegExpExecArray | null = PythonFunctionDeclaration.exec(trimmed);
        if (classMatch === null && defMatch === null) {
            continue;
        }
        const label: string = classMatch !== null ? classMatch[1] : defMatch![1];
        const enclosing: MutableOutlineNode | undefined = stack.length === 0 ? undefined : stack[stack.length - 1].node;
        const kind: OutlineKind = classMatch !== null ? "class" : enclosing?.kind === "class" ? "method" : "function";
        const parent: MutableOutlineNode | undefined = stack.length === 0 ? undefined : stack[stack.length - 1].node;
        const node: MutableOutlineNode = {
            label,
            kind,
            startLine: line,
            endLine: line,
            depth: parent === (void 0) ? 0 : parent.depth + 1,
            detail,
            children: [],
        };
        if (parent === (void 0)) {
            roots.push(node);
        } else {
            parent.children.push(node);
        }
        stack.push({ indent, node });
    }
    while (stack.length > 0) {
        const closed: { readonly indent: number; readonly node: MutableOutlineNode; } = stack.pop()!;
        closed.node.endLine = Math.max(closed.node.startLine, lastContent);
    }
    return roots.map(mutableToNode);
};

/**
 * Java identifier pattern. JavaScript `\w` is ASCII-only, so a plain
 * `[A-Za-z_$][\w$]*` truncates `Café` to `Caf` and never matches `计算`.
 * Java accepts letters, letter numbers, currency symbols and connector
 * punctuation at the start, and adds digits/marks in the continuation.
 */
const JavaIdentifier: string = "[\\p{L}\\p{Nl}\\p{Sc}_$][\\p{L}\\p{Nl}\\p{Sc}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$]*";
const JavaModifierWord: string =
    "public|protected|private|abstract|static|final|sealed|non-sealed|strictfp|synchronized|native|transient|volatile|default";
const JavaModifierPrefix: string = `(?:(?:${JavaModifierWord})\\s+)*`;
const JavaAnnotationPrefix: string = "(?:@[\\p{L}\\p{N}_.$]+(?:\\s*\\([^)]*\\))?\\s*)*";
const JavaTypeToken: string = "[\\p{L}\\p{Nl}\\p{Sc}_$][\\p{L}\\p{Nl}\\p{Sc}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$<>\\[\\],.?\\s]*?";

const JavaTypeDeclaration: RegExp = new RegExp(
    `^${JavaAnnotationPrefix}(${JavaModifierPrefix})(class|interface|enum|record)\\s+(${JavaIdentifier})`,
    "u",
);
const JavaAnnotationType: RegExp = new RegExp(`^${JavaAnnotationPrefix}(${JavaModifierPrefix})@interface\\s+(${JavaIdentifier})`, "u");
const JavaPackage: RegExp = new RegExp("^package\\s+([\\p{L}\\p{Nl}\\p{Sc}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$.]+)\\s*;", "u");
const JavaConstructor: RegExp = new RegExp(`^${JavaModifierPrefix}(${JavaIdentifier})\\s*\\(`, "u");
const JavaMethod: RegExp = new RegExp(
    `^${JavaModifierPrefix}(?:<[^>]{1,240}>\\s*)?(${JavaTypeToken})\\s+(${JavaIdentifier})\\s*\\(`,
    "u",
);
const JavaField: RegExp = new RegExp(
    `^${JavaModifierPrefix}(?:[\\p{L}\\p{Nl}\\p{Sc}_$][\\p{L}\\p{Nl}\\p{Sc}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$<>\\[\\],.?]*\\s+)+(${JavaIdentifier})\\s*(?:=|;)`,
    "u",
);

/**
 * One Java type while nested types are attached to their enclosing type.
 */
interface JavaTypeEntry {
    readonly node: OutlineNode;
    readonly startLine: number;
    readonly endLine: number;
    readonly depth: number;
}

/**
 * Modifier words of a Java declaration, in source order.
 *
 * The shared keyword registry cannot own `synchronized`, `native`, `strictfp`,
 * `transient`, `volatile` or the hyphenated `non-sealed`, so Java keeps its own
 * set instead of silently truncating the chain.
 */
const JavaModifierSet: ReadonlySet<string> = new Set<string>(JavaModifierWord.split("|"));

/**
 * Split a captured modifier prefix into words.
 */
const javaModifierWords: (captured: string) => readonly string[] = (captured: string): readonly string[] => {
    const text: string = captured.trim();
    return text.length === 0 ? [] : text.split(/\s+/);
};

/**
 * Leading modifier chain of one stripped Java line, in source order.
 */
const javaModifiers: (line: string) => readonly string[] = (line: string): readonly string[] => {
    const words: string[] = line.trim().split(/\s+/);
    const modifiers: string[] = [];
    for (let index: number = 0; index < words.length; index += 1) {
        const word: string = words[index];
        if (!JavaModifierSet.has(word)) {
            break;
        }
        modifiers.push(word);
    }
    return modifiers;
};

/**
 * Remove one or more leading annotations, including their balanced argument
 * list, from a declaration line. Java allows `@Override public void run()` on a
 * single line, and the annotation must not hide the declaration behind it.
 */
const stripLeadingJavaAnnotations: (line: string) => string = (line: string): string => {
    let rest: string = line.trim();
    for (let guard: number = 0; guard < 64 && rest.startsWith("@"); guard += 1) {
        let cursor: number = 1;
        while (cursor < rest.length && /[\p{L}\p{N}_.$]/u.test(rest[cursor])) {
            cursor += 1;
        }
        if (cursor === 1) {
            break;
        }
        let after: number = cursor;
        while (after < rest.length && /\s/.test(rest[after])) {
            after += 1;
        }
        if (rest[after] === "(") {
            let parentheses: number = 0;
            let index: number = after;
            for (; index < rest.length; index += 1) {
                if (rest[index] === "(") {
                    parentheses += 1;
                } else if (rest[index] === ")") {
                    parentheses -= 1;
                    if (parentheses === 0) {
                        index += 1;
                        break;
                    }
                }
            }
            if (parentheses !== 0) {
                return rest;
            }
            rest = rest.slice(index).trim();
            continue;
        }
        rest = rest.slice(cursor).trim();
    }
    return rest;
};

/**
 * One enum constant recovered from the constants section.
 */
interface JavaEnumConstant {
    readonly label: string;
    readonly detail: string;
    readonly startLine: number;
    readonly endLine: number;
}

/**
 * Read the enum constants that precede the first top-level `;`.
 *
 * Constants may carry argument lists (which contain parentheses and commas) and
 * class bodies, so the scanner tracks nesting and only splits on a top-level
 * comma. A constant without arguments has no other marker, which is why this is
 * a dedicated pass instead of another member regex.
 */
const javaEnumConstants: (lines: readonly string[], memberDepth: number, startLine: number, endLine: number, depthOf: (line: number) => number) => JavaEnumConstant[] = (
    lines: readonly string[], memberDepth: number, startLine: number, endLine: number, depthOf: (line: number) => number,
): JavaEnumConstant[] => {
    const constants: JavaEnumConstant[] = [];
    let text: string = "";
    let start: number = 0;
    let last: number = 0;
    let parentheses: number = 0;
    let brackets: number = 0;
    let braces: number = 0;
    let done: boolean = false;
    const identifierPattern: RegExp = new RegExp(`^(${JavaIdentifier})`, "u");
    const flush: () => void = (): void => {
        const raw: string = text.trim();
        const currentStart: number = start;
        const currentEnd: number = Math.max(start, last);
        text = "";
        start = 0;
        last = 0;
        if (raw.length === 0) {
            return;
        }
        const stripped: string = stripLeadingJavaAnnotations(raw).trim();
        if (stripped.length === 0) {
            return;
        }
        const label: RegExpExecArray | null = identifierPattern.exec(stripped);
        if (label === null) {
            return;
        }
        constants.push({ label: label[1], detail: stripped, startLine: currentStart, endLine: currentEnd });
    };
    for (let line: number = startLine; line <= endLine; line += 1) {
        if (depthOf(line) !== memberDepth) {
            continue;
        }
        const lineText: string = lines[line - 1] ?? "";
        for (let column: number = 0; column < lineText.length; column += 1) {
            const character: string = lineText[column];
            if (character === "(") {
                parentheses += 1;
            } else if (character === ")") {
                parentheses = Math.max(0, parentheses - 1);
            } else if (character === "[") {
                brackets += 1;
            } else if (character === "]") {
                brackets = Math.max(0, brackets - 1);
            } else if (character === "{") {
                braces += 1;
            } else if (character === "}") {
                braces = Math.max(0, braces - 1);
            }
            const top: boolean = parentheses === 0 && brackets === 0 && braces === 0;
            if (top && character === ";") {
                flush();
                done = true;
                break;
            }
            if (top && character === ",") {
                flush();
                continue;
            }
            if (!/\s/.test(character)) {
                if (start === 0) {
                    start = line;
                }
                last = line;
            }
            if (start !== 0) {
                text += character;
            }
        }
        if (done) {
            break;
        }
    }
    if (!done) {
        flush();
    }
    return constants;
};

/**
 * Record header components (`record Point(int x, int y)`) as properties.
 *
 * Components live in the declaration header, before any brace, so the member
 * scanner can never see them. Annotations, generic types and multi-line headers
 * are handled by scanning to the balanced closing parenthesis.
 */
const javaRecordComponents: (lines: readonly string[], startLine: number, endLine: number, depth: number) => OutlineNode[] = (
    lines: readonly string[], startLine: number, endLine: number, depth: number,
): OutlineNode[] => {
    const limit: number = Math.min(endLine, startLine + 20);
    const chunkLines: string[] = [];
    for (let line: number = startLine; line <= limit; line += 1) {
        chunkLines.push(lines[line - 1] ?? "");
    }
    const chunk: string = chunkLines.join("\n");
    const keyword: RegExpExecArray | null = new RegExp(`\\brecord\\s+(${JavaIdentifier})`, "u").exec(chunk);
    let openIndex: number = chunk.indexOf("(", keyword === null ? 0 : keyword.index + keyword[0].length);
    if (openIndex === -1) {
        return [];
    }
    const lineAt: (index: number) => number = (index: number): number => startLine + chunk.slice(0, index).split("\n").length - 1;
    const openLine: number = lineAt(openIndex);
    let parentheses: number = 0;
    let closeIndex: number = -1;
    for (let index: number = openIndex; index < chunk.length; index += 1) {
        if (chunk[index] === "(") {
            parentheses += 1;
        } else if (chunk[index] === ")") {
            parentheses -= 1;
            if (parentheses === 0) {
                closeIndex = index;
                break;
            }
        }
    }
    if (closeIndex === -1) {
        return [];
    }
    const closeLine: number = lineAt(closeIndex);
    const header: string = chunk.slice(openIndex + 1, closeIndex);
    const pieces: string[] = [];
    let piece: string = "";
    let parens: number = 0;
    let brackets: number = 0;
    let braces: number = 0;
    let angles: number = 0;
    for (let index: number = 0; index < header.length; index += 1) {
        const character: string = header[index];
        if (character === "(") {
            parens += 1;
        } else if (character === ")") {
            parens = Math.max(0, parens - 1);
        } else if (character === "[") {
            brackets += 1;
        } else if (character === "]") {
            brackets = Math.max(0, brackets - 1);
        } else if (character === "{") {
            braces += 1;
        } else if (character === "}") {
            braces = Math.max(0, braces - 1);
        } else if (character === "<") {
            angles += 1;
        } else if (character === ">") {
            angles = Math.max(0, angles - 1);
        }
        const top: boolean = parens === 0 && brackets === 0 && braces === 0 && angles === 0;
        if (top && character === ",") {
            pieces.push(piece);
            piece = "";
            continue;
        }
        piece += character;
    }
    pieces.push(piece);
    const labelPattern: RegExp = new RegExp(`(${JavaIdentifier})\\s*$`, "u");
    const components: OutlineNode[] = [];
    for (let index: number = 0; index < pieces.length; index += 1) {
        const stripped: string = stripLeadingJavaAnnotations(pieces[index]).trim();
        if (stripped.length === 0) {
            continue;
        }
        const label: RegExpExecArray | null = labelPattern.exec(stripped);
        if (label === null) {
            continue;
        }
        components.push(
            outlineNode({ label: label[1], kind: "property", startLine: openLine, endLine: closeLine, depth, detail: stripped }),
        );
    }
    return components;
};

/**
 * Body text when a type opens and closes its body on the declaration line.
 */
const javaInlineBody: (maskedLine: string) => string | undefined = (maskedLine: string): string | undefined => {
    const open: number = maskedLine.indexOf("{");
    if (open === -1) {
        return undefined;
    }
    let depth: number = 0;
    let close: number = -1;
    for (let index: number = open; index < maskedLine.length; index += 1) {
        if (maskedLine[index] === "{") {
            depth += 1;
        } else if (maskedLine[index] === "}") {
            depth -= 1;
            if (depth === 0) {
                close = index;
                break;
            }
        }
    }
    return close === -1 ? undefined : maskedLine.slice(open + 1, close);
};

/**
 * Build one member node from a declaration text, or `undefined` when the text
 * is not a constructor, method or field.
 */
const javaMemberNode: (text: string, startLine: number, endLine: number, depth: number, typeName: string) => OutlineNode | undefined = (
    text: string, startLine: number, endLine: number, depth: number, typeName: string,
): OutlineNode | undefined => {
    const constructor: RegExpExecArray | null = JavaConstructor.exec(text);
    if (constructor !== null && constructor[1] === typeName) {
        return outlineNode({ label: constructor[1], kind: "method", startLine, endLine, depth, detail: text, modifiers: javaModifiers(text) });
    }
    const method: RegExpExecArray | null = JavaMethod.exec(text);
    if (method !== null && !CallLikeKeywords.has(method[2])) {
        return outlineNode({ label: method[2], kind: "method", startLine, endLine, depth, detail: text, modifiers: javaModifiers(text) });
    }
    const field: RegExpExecArray | null = JavaField.exec(text);
    if (field !== null && !CallLikeKeywords.has(field[1])) {
        return outlineNode({ label: field[1], kind: "property", startLine, endLine, depth, detail: text, modifiers: javaModifiers(text) });
    }
    return undefined;
};

/**
 * Members of a type whose whole body sits on the declaration line.
 */
const javaInlineMembers: (body: string, line: number, depth: number, typeName: string) => OutlineNode[] = (
    body: string, line: number, depth: number, typeName: string,
): OutlineNode[] => {
    const children: OutlineNode[] = [];
    let segment: string = "";
    let parentheses: number = 0;
    let brackets: number = 0;
    let braces: number = 0;
    const flush: () => void = (): void => {
        const text: string = stripLeadingJavaAnnotations(segment.trim()).trim();
        segment = "";
        if (text.length === 0) {
            return;
        }
        const node: OutlineNode | undefined = javaMemberNode(`${text};`, line, line, depth, typeName);
        if (node !== (void 0)) {
            children.push(node);
        }
    };
    for (let index: number = 0; index < body.length; index += 1) {
        const character: string = body[index];
        if (character === "(") {
            parentheses += 1;
        } else if (character === ")") {
            parentheses = Math.max(0, parentheses - 1);
        } else if (character === "[") {
            brackets += 1;
        } else if (character === "]") {
            brackets = Math.max(0, brackets - 1);
        } else if (character === "{") {
            braces += 1;
        } else if (character === "}") {
            braces = Math.max(0, braces - 1);
            if (braces === 0 && segment.includes("(")) {
                segment += character;
                flush();
                continue;
            }
        }
        if (parentheses === 0 && brackets === 0 && braces === 0 && character === ";") {
            flush();
            continue;
        }
        segment += character;
    }
    flush();
    return children;
};

/**
 * One logical declaration joined from continuation lines.
 */
interface JavaJoinedDeclaration {
    readonly text: string;
    readonly lastLine: number;
}

/**
 * Join a member declaration whose signature is split over lines, e.g.
 * `public String` followed by `multiline(int x) {`.
 */
const javaJoinedDeclaration: (lines: readonly string[], startLine: number, endLine: number, depthOf: (line: number) => number, memberDepth: number) => JavaJoinedDeclaration | undefined = (
    lines: readonly string[], startLine: number, endLine: number, depthOf: (line: number) => number, memberDepth: number,
): JavaJoinedDeclaration | undefined => {
    const first: string = (lines[startLine - 1] ?? "").trim();
    if (first.length === 0 || /[();={}]/.test(first)) {
        return undefined;
    }
    let text: string = first;
    for (let line: number = startLine + 1; line < endLine && line <= startLine + 8; line += 1) {
        if (depthOf(line) !== memberDepth) {
            return undefined;
        }
        const next: string = (lines[line - 1] ?? "").trim();
        if (next.length === 0) {
            continue;
        }
        text = `${text} ${next}`;
        if (/[();={}]/.test(next)) {
            return { text, lastLine: line };
        }
    }
    return undefined;
};

/**
 * Deepest method node whose range contains `line` at `requiredDepth`.
 */
const javaEnclosingMethod: (entries: readonly JavaTypeEntry[], line: number, requiredDepth: number) => OutlineNode | undefined = (
    entries: readonly JavaTypeEntry[], line: number, requiredDepth: number,
): OutlineNode | undefined => {
    let best: OutlineNode | undefined;
    const visit: (node: OutlineNode) => void = (node: OutlineNode): void => {
        if (node.type === "method" && node.depth === requiredDepth) {
            const start: number = Number(node.range.startLine);
            const end: number = Number(node.range.endLine);
            if (start < line && line <= end && (best === (void 0) || start > Number(best.range.startLine))) {
                best = node;
            }
        }
        for (let index: number = 0; index < node.children.length; index += 1) {
            visit(node.children[index]);
        }
    };
    for (let index: number = 0; index < entries.length; index += 1) {
        visit(entries[index].node);
    }
    return best;
};

/**
 * Sort a Java tree by start line, recursively. Nested types are attached after
 * the member scan, so without this pass a class declared before a method would
 * appear after it.
 */
const sortJavaTree: (nodes: readonly OutlineNode[]) => OutlineNode[] = (nodes: readonly OutlineNode[]): OutlineNode[] => {
    for (let index: number = 0; index < nodes.length; index += 1) {
        const children: OutlineNode[] = nodes[index].children as OutlineNode[];
        children.sort((left: OutlineNode, right: OutlineNode): number => Number(left.range.startLine) - Number(right.range.startLine));
        sortJavaTree(children);
    }
    return [...nodes].sort((left: OutlineNode, right: OutlineNode): number => Number(left.range.startLine) - Number(right.range.startLine));
};

/**
 * Parse Java.
 *
 * A `package` statement is a depth-0 `package` node; each type declaration is a
 * class/interface/enum node at its brace depth, and its constructors, methods
 * and fields are children one level deeper. Comments, strings and text blocks
 * are masked before scanning, so a `class Fake {` inside a string is invisible.
 *
 * @param input - Decoded Java text.
 * @returns Package/type/member tree.
 */
export const parseJava: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const masked: string = maskSource(input.text, {
        lineComments: ["//"],
        blockComments: true,
        strings: true,
        template: false,
        tripleQuotes: true,
        regex: false,
    });
    const braced: MaskedSource = scanBraces(source, masked);
    const maskedLines: readonly string[] = splitLines(masked);
    const packageNodes: OutlineNode[] = [];
    const typeEntries: JavaTypeEntry[] = [];
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const trimmed: string = (maskedLines[line - 1] ?? "").trim();
        if (trimmed.length === 0) {
            continue;
        }
        const packageMatch: RegExpExecArray | null = JavaPackage.exec(trimmed);
        if (packageMatch !== null && depthAtLine(braced, line) === 0) {
            packageNodes.push(outlineNode({ label: packageMatch[1], kind: "package", startLine: line, endLine: line, depth: 0, detail: trimmed }));
            continue;
        }
        const annotation: RegExpExecArray | null = JavaAnnotationType.exec(trimmed);
        const declaration: RegExpExecArray | null = annotation === null ? JavaTypeDeclaration.exec(trimmed) : null;
        if (annotation === null && declaration === null) {
            continue;
        }
        const keyword: string = annotation !== null ? "@interface" : declaration![2];
        const typeName: string = annotation !== null ? annotation[2] : declaration![3];
        const modifierText: string = annotation !== null ? annotation[1] : declaration![1];
        const kind: OutlineKind =
            annotation !== null
                ? "interface"
                : keyword === "record"
                  ? "struct"
                  : keyword === "interface"
                    ? "interface"
                    : keyword === "enum"
                      ? "enum"
                      : "class";
        const depth: number = depthAtLine(braced, line);
        const endLine: number = blockEndLine(braced, line);
        const children: OutlineNode[] = [];
        if (kind === "enum") {
            const constants: JavaEnumConstant[] = javaEnumConstants(
                maskedLines,
                depth + 1,
                line + 1,
                Math.max(line, endLine - 1),
                (probe: number): number => depthAtLine(braced, probe),
            );
            for (let index: number = 0; index < constants.length; index += 1) {
                const constant: JavaEnumConstant = constants[index];
                children.push(
                    outlineNode({
                        label: constant.label,
                        kind: "constant",
                        startLine: constant.startLine,
                        endLine: constant.endLine,
                        depth: depth + 1,
                        detail: constant.detail,
                    }),
                );
            }
        }
        if (keyword === "record") {
            const components: OutlineNode[] = javaRecordComponents(maskedLines, line, endLine, depth + 1);
            for (let index: number = 0; index < components.length; index += 1) {
                children.push(components[index]);
            }
        }
        const consumed: Set<number> = new Set<number>();
        for (let memberLine: number = line + 1; memberLine < endLine; memberLine += 1) {
            if (consumed.has(memberLine) || depthAtLine(braced, memberLine) !== depth + 1) {
                continue;
            }
            const member: string = (maskedLines[memberLine - 1] ?? "").trim();
            if (member.length === 0 || JavaTypeDeclaration.test(member) || JavaAnnotationType.test(member)) {
                continue;
            }
            const stripped: string = stripLeadingJavaAnnotations(member).trim();
            if (stripped.length === 0) {
                continue;
            }
            let node: OutlineNode | undefined = javaMemberNode(stripped, memberLine, blockEndLine(braced, memberLine), depth + 1, typeName);
            if (node === (void 0)) {
                const joined: JavaJoinedDeclaration | undefined = javaJoinedDeclaration(
                    maskedLines,
                    memberLine,
                    endLine,
                    (probe: number): number => depthAtLine(braced, probe),
                    depth + 1,
                );
                if (joined !== (void 0)) {
                    node = javaMemberNode(joined.text, memberLine, blockEndLine(braced, memberLine), depth + 1, typeName);
                    if (node !== (void 0)) {
                        for (let consumedLine: number = memberLine + 1; consumedLine <= joined.lastLine; consumedLine += 1) {
                            consumed.add(consumedLine);
                        }
                    }
                }
            }
            if (node !== (void 0) && !(kind === "enum" && children.some((child: OutlineNode): boolean => child.type === "constant" && Number(child.range.startLine) >= memberLine && child.range.endLine <= node!.range.endLine))) {
                children.push(node);
            }
        }
        if (endLine === line) {
            const body: string | undefined = javaInlineBody(maskedLines[line - 1] ?? "");
            if (body !== (void 0)) {
                const inline: OutlineNode[] = javaInlineMembers(body, line, depth + 1, typeName);
                for (let index: number = 0; index < inline.length; index += 1) {
                    children.push(inline[index]);
                }
            }
        }
        typeEntries.push({
            node: outlineNode({
                label: typeName,
                kind,
                startLine: line,
                endLine,
                depth,
                detail: trimmed,
                modifiers: javaModifierWords(modifierText),
                children,
            }),
            startLine: line,
            endLine,
            depth,
        });
    }
    // Recover additional top-level type declarations after a completed type on
    // the same physical line (for example `class A {} class B {}`).
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const text: string = maskedLines[line - 1] ?? "";
        const declarationPattern: RegExp = new RegExp(`(?:^|[}\\s])((?:(?:${JavaModifierWord})\\s+)*)(class|interface|enum|record)\\s+(${JavaIdentifier})`, "gu");
        let match: RegExpExecArray | null = declarationPattern.exec(text);
        while (match !== null) {
            const declarationStart: number = match.index + match[0].lastIndexOf(match[2]);
            let braceDepth: number = 0;
            for (let column: number = 0; column < declarationStart; column += 1) {
                if (text[column] === "{") {
                    braceDepth += 1;
                } else if (text[column] === "}") {
                    braceDepth = Math.max(0, braceDepth - 1);
                }
            }
            const name: string = match[3];
            const alreadyParsed: boolean = typeEntries.some((entry: JavaTypeEntry): boolean => entry.startLine === line && entry.node.label === name);
            if (braceDepth === 0 && !alreadyParsed) {
                const keyword: string = match[2];
                const kind: OutlineKind = keyword === "record" ? "struct" : keyword === "interface" ? "interface" : keyword === "enum" ? "enum" : "class";
                const openBrace: number = text.indexOf("{", declarationStart);
                if (openBrace !== -1) {
                    let localDepth: number = 0;
                    let closeBrace: number = -1;
                    for (let column: number = openBrace; column < text.length; column += 1) {
                        if (text[column] === "{") {
                            localDepth += 1;
                        } else if (text[column] === "}") {
                            localDepth -= 1;
                            if (localDepth === 0) {
                                closeBrace = column;
                                break;
                            }
                        }
                    }
                    if (closeBrace !== -1) {
                        const body: string = text.slice(openBrace + 1, closeBrace);
                        const declarationEnd: number = lineAtOffset(source.starts, source.starts[line - 1] + closeBrace);
                        const children: OutlineNode[] = javaInlineMembers(body, line, 1, name);
                        typeEntries.push({
                            node: outlineNode({
                                label: name,
                                kind,
                                startLine: line,
                                endLine: declarationEnd,
                                depth: 0,
                                detail: text.slice(declarationStart).trim(),
                                modifiers: javaModifierWords(match[1]),
                                children,
                            }),
                            startLine: line,
                            endLine: declarationEnd,
                            depth: 0,
                        });
                    }
                }
            }
            match = declarationPattern.exec(text);
        }
    }
    const roots: OutlineNode[] = [...packageNodes];
    for (let index: number = 0; index < typeEntries.length; index += 1) {
        const entry: JavaTypeEntry = typeEntries[index];
        let parent: JavaTypeEntry | undefined;
        for (let candidateIndex: number = 0; candidateIndex < typeEntries.length; candidateIndex += 1) {
            const candidate: JavaTypeEntry = typeEntries[candidateIndex];
            if (candidate.depth !== entry.depth - 1 || candidate.startLine >= entry.startLine || entry.startLine > candidate.endLine) {
                continue;
            }
            if (parent === (void 0) || candidate.startLine > parent.startLine) {
                parent = candidate;
            }
        }
        if (parent !== (void 0)) {
            const parentChildren: OutlineNode[] = parent.node.children as OutlineNode[];
            parentChildren.push(entry.node);
            continue;
        }
        if (entry.depth === 0) {
            roots.push(entry.node);
            continue;
        }
        const method: OutlineNode | undefined = javaEnclosingMethod(typeEntries, entry.startLine, entry.depth - 1);
        if (method !== (void 0)) {
            const methodChildren: OutlineNode[] = method.children as OutlineNode[];
            methodChildren.push(entry.node);
        }
    }
    return sortJavaTree(roots);
};

const CSharpNamespace: RegExp = /^namespace\s+([\p{L}_][\p{L}\p{N}_.]*)\s*([{;])?/u;
const CSharpTypeDeclaration: RegExp =
    /^(?:(?:public|protected|private|internal|abstract|sealed|static|partial|readonly|unsafe|new|ref|file)\s+)*(class|interface|struct|enum|record(?:\s+(?:class|struct))?)\s+(@?[\p{L}_][\p{L}\p{N}_]*)/u;
const CSharpConstructor: RegExp = /^(?:(?:public|protected|private|internal|static|unsafe|extern)\s+)*(@?[\p{L}_][\p{L}\p{N}_]*)\s*\(/u;
const CSharpFinalizer: RegExp = /^~([\p{L}_][\p{L}\p{N}_]*)\s*\(/u;
const CSharpMethod: RegExp =
    /^(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly)\s+)*(?:<[^>]*>\s*)?([\p{L}_][\p{L}\p{N}_<>\[\],.?]*)\s+(@?[\p{L}_][\p{L}\p{N}_]*)\s*(?:<[^>]*>)?\s*\(/u;
const CSharpProperty: RegExp =
    /^(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|required|readonly|unsafe|partial)\s+)*([\p{L}_][\p{L}\p{N}_<>\[\],.?]*)\s+(@?[\p{L}_][\p{L}\p{N}_]*)\s*(?:\{|=>)/u;
const CSharpPropertyHeader: RegExp =
    /^(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|required|readonly|unsafe|partial)\s+)*([\p{L}_][\p{L}\p{N}_<>\[\],.?]*)\s+(@?[\p{L}_][\p{L}\p{N}_]*)$/u;
const CSharpIndexer: RegExp =
    /^(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|required|readonly|unsafe|partial)\s+)*([\p{L}_][\p{L}\p{N}_<>\[\],.?]*)\s+this\s*\[/u;
const CSharpField: RegExp =
    /^(?:(?:public|protected|private|internal|static|readonly|const|volatile|new|event)\s+)*(?:[\p{L}_][\p{L}\p{N}_<>\[\],.?]*\s+)+(@?[\p{L}_][\p{L}\p{N}_]*)\s*(?:=|;)/u;

/**
 * Modifier words the shared outline keyword registry cannot own: `const` is
 * registered there as a variable keyword, and the rest are C#-only spellings.
 * Keeping them in this file leaves every other language's modifier chain alone.
 */
const CSharpExtraModifiers: ReadonlySet<string> = new Set<string>(["required", "partial", "internal", "file", "event", "const"]);

/**
 * Leading modifier chain of one C# declaration line: the shared registry plus
 * the C#-only words above. The walk stops at the first non-modifier word, so
 * `public required string Id` yields `["public", "required"]`.
 */
const csharpModifiers: (line: string) => readonly string[] = (line: string): readonly string[] => {
    const modifiers: string[] = [];
    const words: string[] = line.trim().split(/\s+/);
    for (let index: number = 0; index < words.length; index += 1) {
        const word: string = words[index].replace(/[^A-Za-z0-9_$]/g, "");
        if (word.length === 0 || (!DefaultOutlineKeywords.isModifier(word) && !CSharpExtraModifiers.has(word))) {
            break;
        }
        modifiers.push(word);
    }
    return modifiers;
};

/**
 * Blank C# verbatim strings before the general masker runs.
 *
 * `@"…"` and `$@"…"` (also `@$"…"`) may span lines and escape a quote by
 * doubling it, which the line-oriented string branch of `maskSource` cannot
 * model: a `{` inside such a literal would otherwise enter the brace scan and a
 * `}` would corrupt the enclosing range. The body is replaced by spaces while
 * every offset and line break survives. Raw strings (`"""`) are skipped and left
 * to `maskSource`, whose triple-quote branch already handles them.
 */
const maskCSharpVerbatimStrings: (text: string) => string = (text: string): string => {
    if (!text.includes('@"') && !text.includes('@$"')) {
        return text;
    }
    const characters: string[] = text.split("");
    const length: number = text.length;
    const blank: (from: number, to: number) => void = (from: number, to: number): void => {
        for (let cursor: number = from; cursor < Math.min(to, length); cursor += 1) {
            if (characters[cursor] !== "\n") {
                characters[cursor] = " ";
            }
        }
    };
    let index: number = 0;
    while (index < length) {
        const character: string = text[index];
        if (character === "/" && text[index + 1] === "/") {
            const newline: number = text.indexOf("\n", index);
            index = newline === -1 ? length : newline;
            continue;
        }
        if (character === "/" && text[index + 1] === "*") {
            const commentEnd: number = text.indexOf("*/", index + 2);
            index = commentEnd === -1 ? length : commentEnd + 2;
            continue;
        }
        if (text.startsWith('"""', index)) {
            const rawEnd: number = text.indexOf('"""', index + 3);
            index = rawEnd === -1 ? length : rawEnd + 3;
            continue;
        }
        if (character === "@" && (text[index + 1] === '"' || (text[index + 1] === "$" && text[index + 2] === '"'))) {
            const quote: number = text[index + 1] === '"' ? index + 1 : index + 2;
            let cursor: number = quote + 1;
            let closed: boolean = false;
            while (cursor < length) {
                if (text[cursor] === '"') {
                    if (text[cursor + 1] === '"') {
                        cursor += 2;
                        continue;
                    }
                    cursor += 1;
                    closed = true;
                    break;
                }
                cursor += 1;
            }
            const stop: number = closed ? cursor : length;
            blank(index, stop);
            index = stop;
            continue;
        }
        if (character === '"' || character === "'") {
            let cursor: number = index + 1;
            while (cursor < length) {
                const current: string = text[cursor];
                if (current === "\\") {
                    cursor += 2;
                    continue;
                }
                if (current === character || current === "\n") {
                    cursor += 1;
                    break;
                }
                cursor += 1;
            }
            index = cursor;
            continue;
        }
        index += 1;
    }
    return characters.join("");
};

/**
 * Remove leading C# attribute groups from a trimmed masked line, so an
 * attribute written in front of a declaration on the same line no longer hides
 * it. An unterminated group is returned unchanged and matches nothing.
 */
const stripCSharpAttributes: (line: string) => string = (line: string): string => {
    let cursor: number = 0;
    while (cursor < line.length && line[cursor] === "[") {
        let depth: number = 0;
        let end: number = -1;
        for (let index: number = cursor; index < line.length; index += 1) {
            if (line[index] === "[") {
                depth += 1;
                continue;
            }
            if (line[index] === "]") {
                depth -= 1;
                if (depth === 0) {
                    end = index;
                    break;
                }
            }
        }
        if (end === -1) {
            return line;
        }
        cursor = end + 1;
        while (cursor < line.length && /\s/.test(line[cursor])) {
            cursor += 1;
        }
    }
    return line.slice(cursor).trim();
};

/**
 * End line of a C# declaration.
 *
 * A declaration without a body ends at its semicolon, a body brace ends at its
 * matching close, and an unclosed brace means the body runs past the scanned
 * text (the 3000-line window cut it): the last scanned line is reported instead
 * of collapsing the range onto the declaration line.
 */
const csharpEndLine: (braced: MaskedSource, line: number) => number = (braced: MaskedSource, line: number): number => {
    const offset: number = braced.starts[line - 1] ?? 0;
    for (let index: number = offset; index < braced.masked.length; index += 1) {
        const character: string = braced.masked[index];
        if (character === "{") {
            const closeIndex: number | undefined = braced.close.get(index);
            return closeIndex === (void 0) ? Math.max(line, braced.depthAtLine.length) : lineAtOffset(braced.starts, closeIndex);
        }
        if (character === ";" || character === "}") {
            return lineAtOffset(braced.starts, index);
        }
    }
    return Math.max(line, braced.depthAtLine.length);
};

/**
 * 1-based number of the next non-blank masked line at or after `fromLine`, or 0
 * when the text ends first.
 */
const nextContentLine: (lines: readonly string[], fromLine: number) => number = (lines: readonly string[], fromLine: number): number => {
    for (let line: number = Math.max(1, fromLine); line <= lines.length; line += 1) {
        if ((lines[line - 1] ?? "").trim().length > 0) {
            return line;
        }
    }
    return 0;
};

/**
 * Outline kind for a C# type keyword capture: `record class` is a class and
 * `record struct` is a struct.
 */
const csharpTypeKind: (declaration: string) => OutlineKind = (declaration: string): OutlineKind => {
    if (declaration.startsWith("record")) {
        return declaration.includes("struct") ? "struct" : "class";
    }
    if (declaration === "interface") {
        return "interface";
    }
    if (declaration === "struct") {
        return "struct";
    }
    if (declaration === "enum") {
        return "enum";
    }
    return "class";
};

/**
 * Body text of a type that opens and closes on its declaration line, or
 * `undefined` when the opening brace has no matching close on that line.
 */
const csharpInlineBody: (maskedLine: string) => string | undefined = (maskedLine: string): string | undefined => {
    const open: number = maskedLine.indexOf("{");
    if (open === -1) {
        return undefined;
    }
    let depth: number = 0;
    for (let index: number = open; index < maskedLine.length; index += 1) {
        if (maskedLine[index] === "{") {
            depth += 1;
            continue;
        }
        if (maskedLine[index] === "}") {
            depth -= 1;
            if (depth === 0) {
                return maskedLine.slice(open + 1, index);
            }
        }
    }
    return undefined;
};

/**
 * Split an inline type body into member declarations at brace depth zero. A
 * member ends at a depth-zero `;` or at the `}` that closes its own body, so
 * `public int X { get; set; } public void Run() { }` yields two members.
 */
const splitCSharpInlineMembers: (body: string) => string[] = (body: string): string[] => {
    const members: string[] = [];
    let depth: number = 0;
    let start: number = 0;
    for (let index: number = 0; index < body.length; index += 1) {
        const character: string = body[index];
        if (character === "{") {
            depth += 1;
            continue;
        }
        if (character === "}") {
            depth = Math.max(0, depth - 1);
            if (depth === 0) {
                const member: string = body.slice(start, index + 1).trim();
                if (member.length > 0) {
                    members.push(member);
                }
                start = index + 1;
            }
            continue;
        }
        if (character === ";" && depth === 0) {
            const member: string = body.slice(start, index).trim();
            if (member.length > 0) {
                members.push(member);
            }
            start = index + 1;
        }
    }
    const tail: string = body.slice(start).trim();
    if (tail.length > 0) {
        members.push(tail);
    }
    return members;
};

/**
 * Per-type scan state shared by the member matcher.
 */
interface CSharpMemberContext {
    readonly braced: MaskedSource;
    readonly maskedLines: readonly string[];
}

/**
 * One declaration string handed to the member matcher.
 */
interface CSharpMemberInput {
    readonly member: string;
    readonly memberLine: number;
    readonly typeName: string;
    readonly depth: number;
    readonly context: CSharpMemberContext;
}

/**
 * Recognize one C# type member from a single masked declaration.
 *
 * The order mirrors C# ambiguity: constructor/finalizer, method, property,
 * indexer, field, then the Allman forms whose body starts on the next line.
 */
const matchCSharpMember: (input: CSharpMemberInput) => MutableOutlineNode | undefined = (input: CSharpMemberInput): MutableOutlineNode | undefined => {
    const member: string = input.member;
    const context: CSharpMemberContext = input.context;
    const modifiers: readonly string[] = csharpModifiers(member);
    const build: (label: string, kind: OutlineKind, endLine: number) => MutableOutlineNode = (
        label: string, kind: OutlineKind, endLine: number,
    ): MutableOutlineNode => ({
        label,
        kind,
        startLine: input.memberLine,
        endLine,
        depth: input.depth + 1,
        detail: member,
        modifiers,
        children: [],
    });
    const constructor: RegExpExecArray | null = CSharpConstructor.exec(member);
    if (constructor !== null) {
        const name: string = constructor[1].replace(/^@/, "");
        if (name === input.typeName) {
            return build(name, "method", csharpEndLine(context.braced, input.memberLine));
        }
    }
    const finalizer: RegExpExecArray | null = CSharpFinalizer.exec(member);
    if (finalizer !== null) {
        return build(`~${finalizer[1]}`, "method", csharpEndLine(context.braced, input.memberLine));
    }
    const method: RegExpExecArray | null = CSharpMethod.exec(member);
    if (method !== null && !CallLikeKeywords.has(method[2])) {
        return build(method[2].replace(/^@/, ""), "method", csharpEndLine(context.braced, input.memberLine));
    }
    const property: RegExpExecArray | null = CSharpProperty.exec(member);
    if (property !== null && !CallLikeKeywords.has(property[2])) {
        return build(property[2].replace(/^@/, ""), "property", csharpEndLine(context.braced, input.memberLine));
    }
    const indexer: RegExpExecArray | null = CSharpIndexer.exec(member);
    if (indexer !== null) {
        return build("this[]", "property", csharpEndLine(context.braced, input.memberLine));
    }
    const field: RegExpExecArray | null = CSharpField.exec(member);
    if (field !== null && !CallLikeKeywords.has(field[1])) {
        const kind: OutlineKind = modifiers.includes("const") ? "constant" : "property";
        return build(field[1].replace(/^@/, ""), kind, csharpEndLine(context.braced, input.memberLine));
    }
    const header: RegExpExecArray | null = CSharpPropertyHeader.exec(member);
    if (header !== null && !CallLikeKeywords.has(header[2])) {
        const next: number = nextContentLine(context.maskedLines, input.memberLine + 1);
        if (next > 0) {
            const body: string = (context.maskedLines[next - 1] ?? "").trim();
            if (body.startsWith("{") || body.startsWith("=>")) {
                return build(header[2].replace(/^@/, ""), "property", csharpEndLine(context.braced, input.memberLine));
            }
        }
    }
    return undefined;
};

/**
 * Sort a mutable C# tree by source line, recursively, so members and nested
 * types come out in document order instead of member-first order.
 */
const sortCSharpChildren: (nodes: MutableOutlineNode[]) => void = (nodes: MutableOutlineNode[]): void => {
    nodes.sort((left: MutableOutlineNode, right: MutableOutlineNode): number => left.startLine - right.startLine);
    for (let index: number = 0; index < nodes.length; index += 1) {
        sortCSharpChildren(nodes[index].children);
    }
};

/**
 * Parse C#.
 *
 * Namespaces, types and their members form a brace-depth hierarchy: a class
 * inside a namespace is one level deeper, and a method/property/field is one
 * level below its type. Comments, ordinary strings, interpolated strings, raw
 * strings and verbatim strings are masked first, so a declaration-shaped line
 * inside any of them is invisible. Attributes are accepted on their own line or
 * in front of the declaration they annotate.
 *
 * @param input - Decoded C# text.
 * @returns Namespace/type/member tree.
 */
export const parseCSharp: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const masked: string = maskSource(maskCSharpVerbatimStrings(input.text), {
        lineComments: ["//"],
        blockComments: true,
        strings: true,
        template: false,
        tripleQuotes: true,
        regex: false,
    });
    const braced: MaskedSource = scanBraces(source, masked);
    const maskedLines: readonly string[] = splitLines(masked);
    const context: CSharpMemberContext = { braced, maskedLines };
    const roots: MutableOutlineNode[] = [];
    const containers: ContainerDraft[] = [];
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const trimmed: string = (maskedLines[line - 1] ?? "").trim();
        const stripped: string = stripCSharpAttributes(trimmed);
        if (stripped.length === 0) {
            continue;
        }
        const namespaceMatch: RegExpExecArray | null = CSharpNamespace.exec(stripped);
        if (namespaceMatch !== null) {
            const fileScoped: boolean = stripped.endsWith(";");
            const endLine: number = fileScoped ? source.totalLines : csharpEndLine(braced, line);
            const depth: number = depthAtLine(braced, line);
            const node: MutableOutlineNode = {
                label: namespaceMatch[1],
                kind: "namespace",
                startLine: line,
                endLine,
                depth,
                detail: stripped,
                children: [],
            };
            const parent: ContainerDraft | undefined = innermostContainer(containers, line);
            if (parent === (void 0)) {
                roots.push(node);
            } else {
                parent.node.children.push(node);
            }
            containers.push({ node, startLine: line, endLine, kind: "namespace", depth });
            continue;
        }
        const declaration: RegExpExecArray | null = CSharpTypeDeclaration.exec(stripped);
        if (declaration === null) {
            continue;
        }
        const typeName: string = declaration[2].replace(/^@/, "");
        const kind: OutlineKind = csharpTypeKind(declaration[1]);
        const depth: number = depthAtLine(braced, line);
        const endLine: number = csharpEndLine(braced, line);
        const node: MutableOutlineNode = {
            label: typeName,
            kind,
            startLine: line,
            endLine,
            depth,
            detail: stripped,
            modifiers: csharpModifiers(stripped),
            children: [],
        };
        if (kind !== "enum") {
            for (let memberLine: number = line + 1; memberLine < endLine; memberLine += 1) {
                if (depthAtLine(braced, memberLine) !== depth + 1) {
                    continue;
                }
                const memberText: string = stripCSharpAttributes((maskedLines[memberLine - 1] ?? "").trim());
                if (memberText.length === 0 || CSharpTypeDeclaration.test(memberText)) {
                    continue;
                }
                const member: MutableOutlineNode | undefined = matchCSharpMember({
                    member: memberText,
                    memberLine,
                    typeName,
                    depth,
                    context,
                });
                if (member !== (void 0)) {
                    node.children.push(member);
                }
            }
            const inlineBody: string | undefined = csharpInlineBody(stripped);
            if (inlineBody !== (void 0)) {
                const inlineMembers: string[] = splitCSharpInlineMembers(inlineBody);
                for (let memberIndex: number = 0; memberIndex < inlineMembers.length; memberIndex += 1) {
                    const member: MutableOutlineNode | undefined = matchCSharpMember({
                        member: stripCSharpAttributes(inlineMembers[memberIndex]),
                        memberLine: line,
                        typeName,
                        depth,
                        context,
                    });
                    if (member !== (void 0)) {
                        node.children.push(member);
                    }
                }
            }
        }
        const parent: ContainerDraft | undefined = innermostContainer(containers, line);
        if (parent === (void 0)) {
            roots.push(node);
        } else {
            parent.node.children.push(node);
        }
        containers.push({ node, startLine: line, endLine, kind, depth });
    }
    sortCSharpChildren(roots);
    return roots.map(mutableToNode);
};

/**
 * C/C++ type declaration head. A `typedef` prefix is accepted so the classic
 * `typedef struct Foo { ... } Foo;` form is recognized, and a template header
 * may contain one level of nested angle brackets.
 */
const CppTypeDeclaration: RegExp =
    /^(?:typedef\s+)?(?:template\s*<(?:[^<>]|<[^<>]*>)*>\s*)?(class|struct|enum(?:\s+class|\s+struct)?|union|namespace)\s+([A-Za-z_]\w*)?/;
const CppTemplateHeader: RegExp = /^template\s*<(?:[^<>]|<[^<>]*>)*>\s*/;
const CppMacro: RegExp = /^#\s*define\s+([A-Za-z_]\w*)/;
const CppPreprocessor: RegExp = /^#\s*([A-Za-z]+)\b(.*)$/;
const CppFunctionName: RegExp = /([A-Za-z_~]\w*)\s*$/;
const CppQualifier: RegExp = /((?:[A-Za-z_]\w*::)+)\s*$/;
const CppFieldKeywords: RegExp =
    /^(?:using|typedef|friend|static_assert|template|return|namespace|if|for|while|switch|case|default|public|private|protected|operator)\b/;

/**
 * Identifiers that are never a member name, so a declarator tail such as
 * `unsigned int` does not become a `property` node.
 */
const CppNonNames: ReadonlySet<string> = new Set<string>([
    "auto",
    "bool",
    "char",
    "char8_t",
    "char16_t",
    "char32_t",
    "class",
    "const",
    "consteval",
    "constexpr",
    "constinit",
    "decltype",
    "default",
    "delete",
    "double",
    "enum",
    "explicit",
    "extern",
    "final",
    "float",
    "friend",
    "inline",
    "int",
    "long",
    "mutable",
    "namespace",
    "new",
    "noexcept",
    "operator",
    "override",
    "private",
    "protected",
    "public",
    "register",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "struct",
    "template",
    "thread_local",
    "typedef",
    "typename",
    "union",
    "unsigned",
    "using",
    "virtual",
    "void",
    "volatile",
    "wchar_t",
]);

/**
 * Blank a leading `template <...>` header while preserving every offset, so a
 * position found in the returned line also addresses the original line.
 */
const stripCppTemplate: (line: string) => string = (line: string): string => {
    const match: RegExpExecArray | null = CppTemplateHeader.exec(line);
    if (match === null) {
        return line;
    }
    return " ".repeat(match[0].length) + line.slice(match[0].length);
};

/**
 * Index of the `)` matching the `(` at `open`, or `-1` when the pair is not
 * closed on this line.
 */
const matchingParenOnLine: (line: string, open: number) => number = (line: string, open: number): number => {
    let depth: number = 0;
    for (let index: number = open; index < line.length; index += 1) {
        const character: string = line[index];
        if (character === "(") {
            depth += 1;
        } else if (character === ")") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
};

/**
 * One source line with block/line comments removed but string and character
 * literals preserved. Used for `detail`, so a `#define LABEL "x"` keeps its
 * replacement text instead of a run of spaces.
 */
const cppDisplayLine: (raw: string) => string = (raw: string): string => {
    let output: string = "";
    let quote: string = "";
    let index: number = 0;
    while (index < raw.length) {
        const character: string = raw[index];
        if (quote !== "") {
            output += character;
            if (character === "\\") {
                output += raw[index + 1] ?? "";
                index += 2;
                continue;
            }
            if (character === quote) {
                quote = "";
            }
            index += 1;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            output += character;
            index += 1;
            continue;
        }
        if (character === "/" && raw[index + 1] === "/") {
            break;
        }
        if (character === "/" && raw[index + 1] === "*") {
            const end: number = raw.indexOf("*/", index + 2);
            index = end === -1 ? raw.length : end + 2;
            output += " ";
            continue;
        }
        output += character;
        index += 1;
    }
    return output.replace(/\s+/g, " ").trim();
};

/**
 * Result of masking preprocessor directives out of a C/C++ source.
 */
interface CppPreprocessed {
    readonly code: string;
    readonly dead: ReadonlySet<number>;
}

/**
 * One conditional-compilation frame.
 */
interface CppPreprocessorFrame {
    readonly known: boolean;
    active: boolean;
    taken: boolean;
}

/**
 * Mask preprocessor directive lines and literal `#if 0` regions.
 *
 * Directive lines are blanked in `code` so a brace or semicolon inside a macro
 * replacement list cannot corrupt brace depth, while the masked text keeps them
 * so the `#define` scanner can still read the name. Only a literal `#if 0` /
 * `#if 1` is evaluated: a `#if defined(...)` guard depends on a build
 * configuration the outline cannot know, so both branches stay visible.
 */
const preprocessCpp: (source: SourceLines, masked: string, maskedLines: readonly string[]) => CppPreprocessed = (
    source: SourceLines,
    masked: string,
    maskedLines: readonly string[],
): CppPreprocessed => {
    const characters: string[] = masked.split("");
    const dead: Set<number> = new Set<number>();
    const blankLine: (line: number) => void = (line: number): void => {
        const start: number = source.starts[line - 1] ?? 0;
        const stop: number = line < source.starts.length ? source.starts[line] : masked.length;
        for (let index: number = start; index < stop; index += 1) {
            if (characters[index] !== "\n") {
                characters[index] = " ";
            }
        }
    };
    const stack: CppPreprocessorFrame[] = [];
    let continuation: boolean = false;
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const trimmed: string = (maskedLines[line - 1] ?? "").trim();
        if (continuation) {
            dead.add(line);
            blankLine(line);
            continuation = trimmed.endsWith("\\");
            continue;
        }
        if (trimmed.startsWith("#")) {
            const directive: RegExpExecArray | null = CppPreprocessor.exec(trimmed);
            const command: string = directive === null ? "" : directive[1];
            const argument: string = directive === null ? "" : directive[2].trim();
            if (command === "if" || command === "ifdef" || command === "ifndef") {
                let known: boolean = false;
                let active: boolean = true;
                if (command === "if" && /^0\b/.test(argument)) {
                    known = true;
                    active = false;
                } else if (command === "if" && /^1\b/.test(argument)) {
                    known = true;
                }
                stack.push({ known, active, taken: known && active });
            } else if (command === "else" || command === "elif") {
                const frame: CppPreprocessorFrame | undefined = stack[stack.length - 1];
                if (frame !== (void 0)) {
                    frame.active = frame.known ? !frame.taken : true;
                    frame.taken = true;
                }
            } else if (command === "endif") {
                stack.pop();
            }
            blankLine(line);
            continuation = trimmed.endsWith("\\");
            continue;
        }
        if (!stack.every((frame: CppPreprocessorFrame): boolean => frame.active)) {
            dead.add(line);
            blankLine(line);
        }
    }
    return { code: characters.join(""), dead };
};

/**
 * One significant source line locator.
 */
interface CppLineRef {
    readonly line: number;
    readonly trimmed: string;
}

/**
 * Next non-empty, non-dead line after `fromLine`.
 */
const nextCppSignificant: (source: SourceLines, maskedLines: readonly string[], dead: ReadonlySet<number>, fromLine: number) => CppLineRef | undefined = (
    source: SourceLines,
    maskedLines: readonly string[],
    dead: ReadonlySet<number>,
    fromLine: number,
): CppLineRef | undefined => {
    for (let line: number = fromLine + 1; line <= source.totalLines; line += 1) {
        if (dead.has(line)) {
            continue;
        }
        const trimmed: string = (maskedLines[line - 1] ?? "").trim();
        if (trimmed.length === 0) {
            continue;
        }
        return { line, trimmed };
    }
    return undefined;
};

/**
 * Member names declared by one `;`-terminated line, or an empty list when the
 * line is not a data declaration. Function pointers, brace initializers and
 * method declarations are rejected here.
 */
const matchCppFieldNames: (trimmed: string) => string[] = (trimmed: string): string[] => {
    if (!trimmed.endsWith(";") || CppFieldKeywords.test(trimmed)) {
        return [];
    }
    const body: string = trimmed.slice(0, -1).trim();
    if (body.length === 0 || body.startsWith("{") || body.startsWith("}") || body.includes("{") || body.includes("}")) {
        return [];
    }
    const head: string = body.split("=")[0];
    if (head.includes("(") || head.includes(")")) {
        return [];
    }
    const names: string[] = [];
    const declarators: string[] = body.split(",");
    for (let index: number = 0; index < declarators.length; index += 1) {
        let declarator: string = declarators[index].split("=")[0].trim();
        while (/\[[^\]]*\]\s*$/.test(declarator)) {
            declarator = declarator.replace(/\[[^\]]*\]\s*$/, "").trim();
        }
        declarator = declarator.replace(/:\s*[0-9]+\s*$/, "").trim();
        const nameMatch: RegExpExecArray | null = /([A-Za-z_]\w*)\s*$/.exec(declarator);
        if (nameMatch === null || CppNonNames.has(nameMatch[1])) {
            continue;
        }
        names.push(nameMatch[1]);
    }
    return names;
};

/**
 * One callable candidate on a C/C++ line.
 */
interface CppCallableMatch {
    readonly label: string;
    readonly name: string;
    readonly qualified: boolean;
    readonly bare: boolean;
    readonly allman: boolean;
}

/**
 * Split a C-family line into a callable candidate.
 *
 * A line ending in `;` or `{` is a declaration or a definition; a line whose
 * body closes on the same line (`}`) is accepted when it also contains `{`.
 * Anything else can still be an Allman-style definition, which the caller
 * confirms by looking at the next significant line. A leading `template <...>`
 * header is blanked before the keyword check, so an inline template function is
 * not mistaken for a `template` statement. A parameter list that contains only
 * literals or numbers denotes function-style initialization, not a declaration.
 */
const matchCppCallable: (line: string, raw: string) => CppCallableMatch | undefined = (line: string, raw: string): CppCallableMatch | undefined => {
    const stripped: string = stripCppTemplate(line);
    if (CallLikeKeywords.has(stripped.split(/[\s(]/, 1)[0])) {
        return undefined;
    }
    const paren: number = stripped.indexOf("(");
    if (paren <= 0) {
        return undefined;
    }
    const prefix: string = stripped.slice(0, paren).trimEnd();
    if (prefix.includes("=") || prefix.includes("->") || prefix.endsWith(".") || /(?<!:):(?!:)/.test(prefix)) {
        return undefined;
    }
    const nameMatch: RegExpExecArray | null = CppFunctionName.exec(prefix);
    if (nameMatch === null) {
        return undefined;
    }
    const name: string = nameMatch[1];
    if (CallLikeKeywords.has(name)) {
        return undefined;
    }
    const before: string = prefix.slice(0, prefix.length - name.length).trimEnd();
    const qualifier: RegExpExecArray | null = CppQualifier.exec(before);
    const close: number = matchingParenOnLine(stripped, paren);
    const parameters: string = close === -1 ? "" : raw.slice(paren + 1, close).trim();
    const quoteFree: string = parameters.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");
    if (parameters.length > 0 && !/[A-Za-z_]/.test(quoteFree)) {
        return undefined;
    }
    let allman: boolean = false;
    if (!/[;{]\s*$/.test(stripped)) {
        if (!/\}\s*$/.test(stripped) || !stripped.includes("{")) {
            const tail: string = close === -1 ? "" : stripped.slice(close + 1);
            if (close === -1 || /[;={}]/.test(tail)) {
                return undefined;
            }
            allman = true;
        }
    }
    return { label: qualifier === null ? name : `${qualifier[1]}${name}`, name, qualified: qualifier !== null, bare: before.length === 0, allman };
};

/**
 * Parse C, C++ and Objective-C-style headers.
 *
 * `class`, `struct`, `enum`, `union` and `namespace` declarations create
 * containers, including the `typedef struct Foo { ... } Foo;` form and Allman
 * bodies whose `{` sits on the next line. Functions, constructors, destructors
 * and prototypes are children of the innermost container when there is one and
 * top-level nodes otherwise, so a prototype inside `extern "C" { ... }` is still
 * reported; a declaration inside a function body is not. A function is a
 * `method` when it is declared inside a class/struct/union or when its name is
 * qualified as `Type::name`. Data members of a class/struct become `property`
 * children, `#define` becomes a `macro` node at its own nesting level, and
 * literal `#if 0` regions are skipped. Comments and strings are masked before
 * scanning, and node depth follows the container tree rather than raw brace
 * depth, so an anonymous namespace cannot inflate it.
 *
 * @param input - Decoded C/C++ text.
 * @returns Container, member, macro and function tree.
 */
export const parseCFamily: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const masked: string = maskSource(input.text, {
        lineComments: ["//"],
        blockComments: true,
        strings: true,
        template: false,
        tripleQuotes: false,
        regex: false,
    });
    const maskedLines: readonly string[] = splitLines(masked);
    const preprocessed: CppPreprocessed = preprocessCpp(source, masked, maskedLines);
    const braced: MaskedSource = scanBraces(source, preprocessed.code);
    const dead: ReadonlySet<number> = preprocessed.dead;
    const roots: MutableOutlineNode[] = [];
    const containers: ContainerDraft[] = [];
    const callableSpans: Array<{ readonly startLine: number; readonly endLine: number; }> = [];
    const insideCallable: (line: number) => boolean = (line: number): boolean =>
        callableSpans.some((span: { readonly startLine: number; readonly endLine: number; }): boolean => span.startLine < line && line <= span.endLine);
    const rawText: (line: number) => string = (line: number): string => (source.lines[line - 1] ?? "").trim();
    const detailOf: (line: number) => string = (line: number): string => cppDisplayLine(rawText(line));
    const attach: (node: MutableOutlineNode, parent: ContainerDraft | undefined) => void = (
        node: MutableOutlineNode,
        parent: ContainerDraft | undefined,
    ): void => {
        if (parent === (void 0)) {
            roots.push(node);
            return;
        }
        parent.node.children.push(node);
    };
    const declarationKind: (headline: string) => OutlineKind = (headline: string): OutlineKind =>
        headline.startsWith("namespace") ? "namespace" : headline === "class" ? "class" : headline.startsWith("enum") ? "enum" : "struct";
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        if (dead.has(line)) {
            continue;
        }
        const trimmed: string = (maskedLines[line - 1] ?? "").trim();
        if (trimmed.length === 0) {
            continue;
        }
        if (trimmed.startsWith("#")) {
            const macro: RegExpExecArray | null = CppMacro.exec(trimmed);
            if (macro !== null && !insideCallable(line)) {
                const parent: ContainerDraft | undefined = innermostContainer(containers, line);
                attach(
                    {
                        label: macro[1],
                        kind: "macro",
                        startLine: line,
                        endLine: line,
                        depth: parent === (void 0) ? 0 : parent.depth + 1,
                        detail: detailOf(line),
                        children: [],
                    },
                    parent,
                );
            }
            continue;
        }
        if (insideCallable(line)) {
            continue;
        }
        const parent: ContainerDraft | undefined = innermostContainer(containers, line);
        const declaration: RegExpExecArray | null = CppTypeDeclaration.exec(trimmed);
        if (declaration !== null) {
            const after: string = trimmed.slice(declaration[0].length);
            const inlineTail: boolean = /^(?:\s*<[^{};]*>)?(?:\s+final)?\s*(?::[^{};]*)?[{;]/.test(after);
            const emptyTail: boolean = /^(?:\s*<[^{};]*>)?(?:\s+final)?\s*(?::[^{};]*)?$/.test(after);
            let braceLine: number = line;
            let accepted: boolean = inlineTail;
            if (!accepted && emptyTail && declaration[2] !== (void 0)) {
                const nextLine: CppLineRef | undefined = nextCppSignificant(source, maskedLines, dead, line);
                if (nextLine !== undefined && nextLine.trimmed.startsWith("{")) {
                    accepted = true;
                    braceLine = nextLine.line;
                }
            }
            if (!accepted && declaration[2] !== (void 0) && /^typedef\b/.test(trimmed) && trimmed.endsWith(";")) {
                accepted = true;
            }
            let label: string | undefined = declaration[2];
            const endLine: number = accepted ? blockEndLine(braced, braceLine) : line;
            if (label === (void 0) && accepted && /^typedef\b/.test(trimmed) && trimmed.includes("{")) {
                const sameLine: RegExpExecArray | null = /\{[^{}]*\}\s*([A-Za-z_]\w*)\s*;\s*$/.exec(trimmed);
                const closing: RegExpExecArray | null =
                    endLine === line ? null : /^\}\s*([A-Za-z_]\w*)\s*;/.exec((maskedLines[endLine - 1] ?? "").trim());
                label = sameLine === null ? (closing === null ? undefined : closing[1]) : sameLine[1];
            }
            if (accepted && label !== (void 0)) {
                const kind: OutlineKind = declarationKind(declaration[1]);
                const depth: number = parent === (void 0) ? 0 : parent.depth + 1;
                const node: MutableOutlineNode = {
                    label,
                    kind,
                    startLine: line,
                    endLine,
                    depth,
                    detail: detailOf(line),
                    children: [],
                };
                attach(node, parent);
                containers.push({ node, startLine: line, endLine, kind, depth });
                continue;
            }
        }
        const callable: CppCallableMatch | undefined = matchCppCallable(trimmed, rawText(line));
        if (callable !== undefined) {
            let endLine: number = blockEndLine(braced, line);
            let resolvable: boolean = true;
            if (callable.allman) {
                const nextLine: CppLineRef | undefined = nextCppSignificant(source, maskedLines, dead, line);
                if (nextLine === undefined || !nextLine.trimmed.startsWith("{")) {
                    resolvable = false;
                } else {
                    endLine = blockEndLine(braced, nextLine.line);
                }
            }
            const constructorName: boolean =
                parent !== (void 0) &&
                (parent.kind === "class" || parent.kind === "struct") &&
                (callable.name === parent.node.label || callable.name === `~${parent.node.label}`);
            const bareAllowed: boolean = !callable.bare || callable.qualified || constructorName || /[{}]\s*$/.test(trimmed);
            if (resolvable && bareAllowed) {
                const kind: OutlineKind = callable.qualified || (parent !== (void 0) && parent.kind !== "namespace") ? "method" : "function";
                const depth: number = parent === (void 0) ? 0 : parent.depth + 1;
                const node: MutableOutlineNode = {
                    label: callable.label,
                    kind,
                    startLine: line,
                    endLine,
                    depth,
                    detail: detailOf(line),
                    children: [],
                };
                attach(node, parent);
                callableSpans.push({ startLine: line, endLine });
                continue;
            }
        }
        if (parent !== (void 0) && (parent.kind === "class" || parent.kind === "struct")) {
            const names: string[] = matchCppFieldNames(trimmed);
            for (let index: number = 0; index < names.length; index += 1) {
                parent.node.children.push({
                    label: names[index],
                    kind: "property",
                    startLine: line,
                    endLine: line,
                    depth: parent.depth + 1,
                    detail: detailOf(line),
                    children: [],
                });
            }
        }
    }
    return roots.map(mutableToNode);
};

/**
 * One Go identifier. The Go spec allows Unicode letters, so the scanner cannot
 * use an ASCII-only character class.
 */
const GoIdentifierAt: RegExp = /^[\p{L}_][\p{L}\p{N}_]*/u;

/**
 * Go package clause.
 */
const GoPackage: RegExp = /^package\s+([\p{L}_][\p{L}\p{N}_]*)/u;

/**
 * Grouped `var ( ... )` or `const ( ... )` opener.
 */
const GoGrouped: RegExp = /^(var|const)\s*\(/u;

/**
 * One `var` or `const` keyword.
 */
const GoValueKeyword: RegExp = /^(var|const)\b/u;

/**
 * Skip spaces and tabs from one offset.
 */
const skipGoSpace: (text: string, index: number) => number = (text: string, index: number): number => {
    let cursor: number = index;
    while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) {
        cursor += 1;
    }
    return cursor;
};

/**
 * Index of the bracket matching the opener at `openIndex`, or `-1`.
 */
const matchingGoBracket: (text: string, openIndex: number, open: string, close: string) => number = (
    text: string, openIndex: number, open: string, close: string,
): number => {
    let depth: number = 0;
    for (let index: number = openIndex; index < text.length; index += 1) {
        const character: string = text[index];
        if (character === open) {
            depth += 1;
        } else if (character === close) {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
};

/**
 * Read the identifier starting at `index`, or `""`.
 */
const goIdentifierAt: (text: string, index: number) => string = (text: string, index: number): string =>
    GoIdentifierAt.exec(text.slice(index))?.[0] ?? "";

/**
 * Names of one `var`/`const` spec: `a, b` becomes `["a", "b"]` and `A` becomes
 * `["A"]`. The trailing type or expression is left to the caller.
 */
const goSpecNames: (text: string) => string[] = (text: string): string[] => {
    const names: string[] = [];
    let cursor: number = skipGoSpace(text, 0);
    while (cursor < text.length) {
        const name: string = goIdentifierAt(text, cursor);
        if (name.length === 0) {
            break;
        }
        names.push(name);
        cursor = skipGoSpace(text, cursor + name.length);
        if (text[cursor] !== ",") {
            break;
        }
        cursor = skipGoSpace(text, cursor + 1);
    }
    return names;
};

/**
 * Last identifier of an embedded field or interface: `*pkg.Base[T]` becomes
 * `Base`.
 */
const goEmbeddedLabel: (text: string) => string = (text: string): string => {
    let remaining: string = text.trim();
    if (remaining.startsWith("*")) {
        remaining = remaining.slice(1).trim();
    }
    let label: string = "";
    let cursor: number = 0;
    while (cursor < remaining.length) {
        const part: string = goIdentifierAt(remaining, cursor);
        if (part.length === 0) {
            break;
        }
        label = part;
        cursor = skipGoSpace(remaining, cursor + part.length);
        if (remaining[cursor] !== ".") {
            break;
        }
        cursor = skipGoSpace(remaining, cursor + 1);
    }
    return label;
};

/**
 * Labels of one struct field line. Named fields use their identifier list;
 * anonymous fields (`Base`, `*Base`, `pkg.Base`, `Base[T]`) keep the last
 * identifier of the embedded type.
 */
const goStructFieldLabels: (trimmed: string) => string[] = (trimmed: string): string[] => {
    if (trimmed.startsWith("*")) {
        const label: string = goEmbeddedLabel(trimmed);
        return label.length === 0 ? [] : [label];
    }
    const first: string = goIdentifierAt(trimmed, 0);
    if (first.length === 0) {
        return [];
    }
    const cursor: number = skipGoSpace(trimmed, first.length);
    const next: string = trimmed[cursor] ?? "";
    if (next === "." || next === "[" || next === "") {
        const label: string = goEmbeddedLabel(trimmed);
        return label.length === 0 ? [] : [label];
    }
    return goSpecNames(trimmed);
};

/**
 * One interface member: a method signature or an embedded interface.
 */
interface GoInterfaceMember {
    readonly label: string;
    readonly kind: OutlineKind;
}

/**
 * Classify one interface body line. Type-set terms such as `~int | ~string`
 * are not outline members and return `undefined`.
 */
const goInterfaceMember: (trimmed: string) => GoInterfaceMember | undefined = (trimmed: string): GoInterfaceMember | undefined => {
    const first: string = goIdentifierAt(trimmed, 0);
    if (first.length === 0) {
        return undefined;
    }
    const cursor: number = skipGoSpace(trimmed, first.length);
    const next: string = trimmed[cursor] ?? "";
    if (next === "(") {
        return { label: first, kind: "method" };
    }
    if (next === "." || next === "[" || next === "") {
        const label: string = goEmbeddedLabel(trimmed);
        return label.length === 0 ? undefined : { label, kind: "property" };
    }
    return undefined;
};

/**
 * One Go type declaration header.
 */
interface GoTypeHeader {
    readonly label: string;
    readonly keyword: string;
}

/**
 * Split one type spec (`Name[T any] struct {` or `Alias = int`) into its name
 * and body keyword, skipping a balanced type-parameter list.
 */
const goTypeSpec: (text: string) => GoTypeHeader | undefined = (text: string): GoTypeHeader | undefined => {
    let cursor: number = skipGoSpace(text, 0);
    const label: string = goIdentifierAt(text, cursor);
    if (label.length === 0) {
        return undefined;
    }
    cursor = skipGoSpace(text, cursor + label.length);
    if (text[cursor] === "[") {
        const end: number = matchingGoBracket(text, cursor, "[", "]");
        if (end === -1) {
            return { label, keyword: "" };
        }
        cursor = skipGoSpace(text, end + 1);
    }
    const keyword: RegExpExecArray | null = /^(struct|interface|func|map|chan)\b/u.exec(text.slice(cursor));
    return { label, keyword: keyword?.[1] ?? "" };
};

/**
 * Split `type Name[T any] struct {` into its type spec.
 */
const goTypeHeader: (trimmed: string) => GoTypeHeader | undefined = (trimmed: string): GoTypeHeader | undefined => {
    if (!/^type\b/u.test(trimmed)) {
        return undefined;
    }
    return goTypeSpec(trimmed.slice(skipGoSpace(trimmed, 4)));
};

/**
 * One Go function or method header.
 */
interface GoCallableHeader {
    readonly label: string;
    readonly receiver: string;
}

/**
 * Receiver type of a method, ignoring the variable name, a pointer marker and a
 * trailing type-parameter list: `b *Box[T]` becomes `Box`.
 */
const goReceiverType: (receiver: string) => string = (receiver: string): string => {
    let text: string = receiver.trim();
    if (text.length === 0) {
        return "";
    }
    if (text[text.length - 1] === "]") {
        let depth: number = 0;
        for (let index: number = text.length - 1; index >= 0; index -= 1) {
            const character: string = text[index];
            if (character === "]") {
                depth += 1;
            } else if (character === "[") {
                depth -= 1;
                if (depth === 0) {
                    text = text.slice(0, index).trim();
                    break;
                }
            }
        }
    }
    return /([\p{L}_][\p{L}\p{N}_]*)\s*$/u.exec(text)?.[1] ?? "";
};

/**
 * Split `func Name[T any](` and `func (r *T) Name(` into a label plus a
 * receiver type. A plain function reports an empty receiver.
 */
const goCallableHeader: (trimmed: string) => GoCallableHeader | undefined = (trimmed: string): GoCallableHeader | undefined => {
    if (!/^func\b/u.test(trimmed)) {
        return undefined;
    }
    let cursor: number = skipGoSpace(trimmed, 4);
    if (trimmed[cursor] === "(") {
        const close: number = matchingGoBracket(trimmed, cursor, "(", ")");
        if (close === -1) {
            return undefined;
        }
        const receiver: string = trimmed.slice(cursor + 1, close);
        cursor = skipGoSpace(trimmed, close + 1);
        const label: string = goIdentifierAt(trimmed, cursor);
        if (label.length === 0) {
            return undefined;
        }
        cursor = skipGoSpace(trimmed, cursor + label.length);
        if (trimmed[cursor] !== "(") {
            return undefined;
        }
        return { label, receiver: goReceiverType(receiver) };
    }
    const label: string = goIdentifierAt(trimmed, cursor);
    if (label.length === 0) {
        return undefined;
    }
    cursor = skipGoSpace(trimmed, cursor + label.length);
    if (trimmed[cursor] === "[") {
        const end: number = matchingGoBracket(trimmed, cursor, "[", "]");
        if (end === -1) {
            return undefined;
        }
        cursor = skipGoSpace(trimmed, end + 1);
    }
    return trimmed[cursor] === "(" ? { label, receiver: "" } : undefined;
};

/**
 * End line of one Go declaration. A declaration with a body ends at the
 * matching brace; a brace-less declaration (alias, func type, map, signature
 * without a body) ends on the line where its parentheses and brackets balance,
 * so it never borrows the range of the next braced declaration.
 */
const goDeclarationEndLine: (source: MaskedSource, startLine: number) => number = (source: MaskedSource, startLine: number): number => {
    const offset: number = source.starts[startLine - 1] ?? 0;
    const masked: string = source.masked;
    let parentheses: number = 0;
    let brackets: number = 0;
    for (let index: number = offset; index < masked.length; index += 1) {
        const character: string = masked[index];
        if (character === "\n" && parentheses === 0 && brackets === 0) {
            return lineAtOffset(source.starts, index);
        }
        if (character === "{") {
            if (parentheses > 0 || brackets > 0) {
                continue;
            }
            const close: number | undefined = source.close.get(index);
            return close === (void 0) ? startLine : lineAtOffset(source.starts, close);
        }
        if (character === "(") {
            parentheses += 1;
        } else if (character === ")") {
            parentheses = Math.max(0, parentheses - 1);
        } else if (character === "[") {
            brackets += 1;
        } else if (character === "]") {
            brackets = Math.max(0, brackets - 1);
        }
    }
    return startLine;
};

/**
 * One spec inside a Go `type ( ... )`, `var ( ... )` or `const ( ... )` group.
 */
interface GoGroupSpec {
    readonly text: string;
    readonly startLine: number;
    readonly endLine: number;
}

/**
 * Split one parenthesised Go declaration group into its specs. Parentheses,
 * brackets and braces are balanced across lines, so a multi-line composite
 * literal, function type or struct body stays one spec instead of producing a
 * bogus node for a continuation line.
 */
const goGroupSpecs: (source: MaskedSource, startLine: number) => { readonly specs: readonly GoGroupSpec[]; readonly endLine: number; } = (
    source: MaskedSource, startLine: number,
): { readonly specs: readonly GoGroupSpec[]; readonly endLine: number; } => {
    const masked: string = source.masked;
    const lineOffset: number = source.starts[startLine - 1] ?? 0;
    const nextOffset: number = source.starts[startLine] ?? masked.length;
    const open: number = masked.indexOf("(", lineOffset);
    if (open === -1 || open >= nextOffset) {
        return { specs: [], endLine: startLine };
    }
    const specs: GoGroupSpec[] = [];
    let specStart: number = open + 1;
    let parentheses: number = 0;
    let brackets: number = 0;
    let braces: number = 0;
    let endLine: number = startLine;
    const pushSpec: (stop: number) => void = (stop: number): void => {
        let from: number = specStart;
        let to: number = stop;
        while (from < to && /\s/u.test(masked[from])) {
            from += 1;
        }
        while (to > from && /\s/u.test(masked[to - 1])) {
            to -= 1;
        }
        if (to > from) {
            specs.push({
                text: masked.slice(from, to),
                startLine: lineAtOffset(source.starts, from),
                endLine: lineAtOffset(source.starts, to - 1),
            });
        }
    };
    for (let index: number = open + 1; index < masked.length; index += 1) {
        const character: string = masked[index];
        if (character === "(") {
            parentheses += 1;
            continue;
        }
        if (character === "[") {
            brackets += 1;
            continue;
        }
        if (character === "{") {
            braces += 1;
            continue;
        }
        if (character === "]") {
            brackets = Math.max(0, brackets - 1);
            continue;
        }
        if (character === "}") {
            braces = Math.max(0, braces - 1);
            continue;
        }
        if (character === ")") {
            if (parentheses > 0) {
                parentheses -= 1;
                continue;
            }
            if (brackets === 0 && braces === 0) {
                pushSpec(index);
                endLine = lineAtOffset(source.starts, index);
                break;
            }
            continue;
        }
        if (character === "\n" && parentheses === 0 && brackets === 0 && braces === 0) {
            pushSpec(index);
            specStart = index + 1;
        }
    }
    return { specs, endLine };
};

/**
 * First line of a possibly multi-line spec, used as its node detail.
 */
const goSpecTitle: (text: string) => string = (text: string): string => text.split("\n")[0].trim();

/**
 * Parse Go.
 *
 * `package`, `func`, methods, `var`/`const` and `type` declarations are
 * top-level symbols in source order. Methods are attached to their receiver type
 * when that type is declared in the same file, and struct/interface members
 * become children sorted by source line. Type parameters, embedded fields,
 * grouped `var`/`const` blocks, interface method signatures, same-line field
 * lists and Unicode identifiers are handled. A method whose receiver type is not
 * declared here stays at the top level.
 *
 * @param input - Decoded Go text.
 * @returns Package/function/type tree.
 */
export const parseGo: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const masked: string = maskSource(input.text, {
        lineComments: ["//"],
        blockComments: true,
        strings: true,
        template: true,
        tripleQuotes: false,
        regex: false,
    });
    const braced: MaskedSource = scanBraces(source, masked);
    const maskedLines: readonly string[] = splitLines(masked);
    const nodes: OutlineNode[] = [];
    const typeNodes: Map<string, OutlineNode> = new Map<string, OutlineNode>();
    const pendingMethods: Array<{ readonly node: OutlineNode; readonly receiver: string; }> = [];

    /**
     * Append the members written on the declaration line itself, if any.
     */
    const appendInlineMembers: (node: OutlineNode, line: number) => void = (node: OutlineNode, line: number): void => {
        const text: string = maskedLines[line - 1] ?? "";
        const open: number = text.indexOf("{");
        if (open === -1) {
            return;
        }
        const close: number = matchingGoBracket(text, open, "{", "}");
        if (close === -1) {
            return;
        }
        const segments: string[] = text.slice(open + 1, close).split(";");
        for (let index: number = 0; index < segments.length; index += 1) {
            const segment: string = segments[index].trim();
            if (segment.length === 0) {
                continue;
            }
            if (node.type === "interface") {
                const member: GoInterfaceMember | undefined = goInterfaceMember(segment);
                if (member === (void 0)) {
                    continue;
                }
                (node.children as OutlineNode[]).push(
                    outlineNode({ label: member.label, kind: member.kind, startLine: line, endLine: line, depth: 1, detail: segment }),
                );
                continue;
            }
            const labels: string[] = goStructFieldLabels(segment);
            for (let labelIndex: number = 0; labelIndex < labels.length; labelIndex += 1) {
                (node.children as OutlineNode[]).push(
                    outlineNode({ label: labels[labelIndex], kind: "property", startLine: line, endLine: line, depth: 1, detail: segment }),
                );
            }
        }
    };

    for (let line: number = 1; line <= source.totalLines; line += 1) {
        if (depthAtLine(braced, line) !== 0) {
            continue;
        }
        const trimmed: string = (maskedLines[line - 1] ?? "").trim();
        if (trimmed.length === 0) {
            continue;
        }
        const packageMatch: RegExpExecArray | null = GoPackage.exec(trimmed);
        if (packageMatch !== null) {
            nodes.push(outlineNode({ label: packageMatch[1], kind: "package", startLine: line, endLine: line, depth: 0, detail: trimmed }));
            continue;
        }
        const groupedType: boolean = /^type\s*\(/u.test(trimmed);
        const grouped: RegExpExecArray | null = groupedType ? null : GoGrouped.exec(trimmed);
        if (groupedType || grouped !== null) {
            const group: { readonly specs: readonly GoGroupSpec[]; readonly endLine: number; } = goGroupSpecs(braced, line);
            if (groupedType) {
                for (let index: number = 0; index < group.specs.length; index += 1) {
                    const spec: GoGroupSpec = group.specs[index];
                    const header: GoTypeHeader | undefined = goTypeSpec(spec.text);
                    if (header === (void 0) || header.label === "_") {
                        continue;
                    }
                    const kind: OutlineKind = header.keyword === "interface" ? "interface" : header.keyword === "struct" ? "struct" : "type";
                    const node: OutlineNode = outlineNode({
                        label: header.label,
                        kind,
                        startLine: spec.startLine,
                        endLine: spec.endLine,
                        depth: 0,
                        detail: goSpecTitle(spec.text),
                    });
                    nodes.push(node);
                    typeNodes.set(header.label, node);
                }
            } else {
                const kind: OutlineKind = grouped![1] === "const" ? "constant" : "variable";
                for (let index: number = 0; index < group.specs.length; index += 1) {
                    const spec: GoGroupSpec = group.specs[index];
                    const names: string[] = goSpecNames(spec.text);
                    for (let nameIndex: number = 0; nameIndex < names.length; nameIndex += 1) {
                        if (names[nameIndex] === "_") {
                            continue;
                        }
                        nodes.push(
                            outlineNode({
                                label: names[nameIndex],
                                kind,
                                startLine: spec.startLine,
                                endLine: spec.endLine,
                                depth: 0,
                                detail: goSpecTitle(spec.text),
                            }),
                        );
                    }
                }
            }
            line = group.endLine;
            continue;
        }
        const valueKeyword: RegExpExecArray | null = GoValueKeyword.exec(trimmed);
        if (valueKeyword !== null) {
            const kind: OutlineKind = valueKeyword[1] === "const" ? "constant" : "variable";
            const names: string[] = goSpecNames(trimmed.slice(valueKeyword[0].length));
            for (let index: number = 0; index < names.length; index += 1) {
                nodes.push(outlineNode({ label: names[index], kind, startLine: line, endLine: line, depth: 0, detail: trimmed }));
            }
            continue;
        }
        const callable: GoCallableHeader | undefined = goCallableHeader(trimmed);
        if (callable !== (void 0)) {
            const node: OutlineNode = outlineNode({
                label: callable.label,
                kind: callable.receiver.length === 0 ? "function" : "method",
                startLine: line,
                endLine: goDeclarationEndLine(braced, line),
                depth: 0,
                detail: trimmed,
            });
            if (callable.receiver.length === 0) {
                nodes.push(node);
            } else {
                pendingMethods.push({ node, receiver: callable.receiver });
            }
            continue;
        }
        const typeHeader: GoTypeHeader | undefined = goTypeHeader(trimmed);
        if (typeHeader !== (void 0)) {
            const kind: OutlineKind = typeHeader.keyword === "interface" ? "interface" : typeHeader.keyword === "struct" ? "struct" : "type";
            const node: OutlineNode = outlineNode({
                label: typeHeader.label,
                kind,
                startLine: line,
                endLine: goDeclarationEndLine(braced, line),
                depth: 0,
                detail: trimmed,
            });
            nodes.push(node);
            typeNodes.set(typeHeader.label, node);
        }
    }
    for (let index: number = 0; index < pendingMethods.length; index += 1) {
        const pending: { readonly node: OutlineNode; readonly receiver: string; } = pendingMethods[index];
        const owner: OutlineNode | undefined = typeNodes.get(pending.receiver);
        if (owner === (void 0)) {
            nodes.push(pending.node);
            continue;
        }
        (owner.children as OutlineNode[]).push({ ...pending.node, depth: 1 });
    }
    typeNodes.forEach((node: OutlineNode): void => {
        if (node.type !== "struct" && node.type !== "interface") {
            return;
        }
        const start: number = Number(node.range.startLine);
        const end: number = Number(node.range.endLine);
        appendInlineMembers(node, start);
        for (let line: number = start + 1; line <= end; line += 1) {
            if (depthAtLine(braced, line) !== 1) {
                continue;
            }
            const trimmed: string = (maskedLines[line - 1] ?? "").trim();
            if (trimmed.length === 0 || trimmed === "{" || trimmed === "}") {
                continue;
            }
            if (node.type === "interface") {
                const member: GoInterfaceMember | undefined = goInterfaceMember(trimmed);
                if (member === (void 0)) {
                    continue;
                }
                (node.children as OutlineNode[]).push(
                    outlineNode({ label: member.label, kind: member.kind, startLine: line, endLine: line, depth: 1, detail: trimmed }),
                );
                continue;
            }
            const labels: string[] = goStructFieldLabels(trimmed);
            for (let index: number = 0; index < labels.length; index += 1) {
                (node.children as OutlineNode[]).push(
                    outlineNode({ label: labels[index], kind: "property", startLine: line, endLine: line, depth: 1, detail: trimmed }),
                );
            }
        }
    });
    const ordered: OutlineNode[] = [...nodes].sort((left: OutlineNode, right: OutlineNode): number =>
        Number(left.range.startLine) - Number(right.range.startLine));
    for (let index: number = 0; index < ordered.length; index += 1) {
        const children: OutlineNode[] = ordered[index].children as OutlineNode[];
        if (children.length > 1) {
            children.sort((left: OutlineNode, right: OutlineNode): number => Number(left.range.startLine) - Number(right.range.startLine));
        }
    }
    return ordered;
};

/**
 * Rust identifier: ASCII plus the Unicode identifier classes, so `struct 数据`
 * and `fn 计算` keep their declared name.
 */
const RustIdentifier: string = "[\\p{ID_Start}_][\\p{ID_Continue}]*";

/**
 * Build one Rust scanner regular expression with the Unicode flag enabled.
 */
const rustPattern: (source: string) => RegExp = (source: string): RegExp => new RegExp(source, "u");

/**
 * Rust declarations. Modifiers are accepted in any order so `pub async unsafe
 * extern "C" fn`, `pub const fn` and `async unsafe fn` all match; an `extern`
 * ABI string is already blanked by the masker, so only its spaces remain.
 */
const RustFunction: RegExp = rustPattern(`^(?:(?:pub(?:\\([^)]*\\))?|async|unsafe|const|extern)\\s+)*fn\\s+(${RustIdentifier})`);
const RustStruct: RegExp = rustPattern(`^(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+(${RustIdentifier})`);
const RustEnum: RegExp = rustPattern(`^(?:pub(?:\\([^)]*\\))?\\s+)?enum\\s+(${RustIdentifier})`);
const RustType: RegExp = rustPattern(`^(?:pub(?:\\([^)]*\\))?\\s+)?type\\s+(${RustIdentifier})`);
const RustMacro: RegExp = rustPattern(`^macro_rules!\\s*(${RustIdentifier})`);
const RustConstant: RegExp = rustPattern(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:const|static)\\s+(?:mut\\s+)?(${RustIdentifier})`);
const RustField: RegExp = rustPattern(`^(?:pub(?:\\([^)]*\\))?\\s+)?(${RustIdentifier})\\s*:`);
const RustVariant: RegExp = rustPattern(`^(${RustIdentifier})(?=\\s|$|[({=,])`);
const RustVisibilityPrefix: RegExp = /^pub(?:\([^)]*\))?\s+/u;

/**
 * Split leading `pub`/`pub(crate)` visibility from a declaration.
 */
const rustVisibility: (line: string) => { readonly modifiers: readonly string[]; readonly rest: string } = (
    line: string,
): { readonly modifiers: readonly string[]; readonly rest: string } => {
    const match: RegExpExecArray | null = RustVisibilityPrefix.exec(line);
    if (match === null) {
        return { modifiers: [], rest: line };
    }
    return { modifiers: [match[0].trim()], rest: line.slice(match[0].length) };
};

/**
 * Callable modifiers in source order: visibility first, then qualifiers.
 */
const rustFunctionModifiers: (line: string) => string[] = (line: string): string[] => {
    const visibility: { readonly modifiers: readonly string[]; readonly rest: string } = rustVisibility(line);
    const modifiers: string[] = [...visibility.modifiers];
    let rest: string = visibility.rest;
    for (;;) {
        const qualifier: RegExpExecArray | null = /^(async|unsafe|const|extern)\s+/u.exec(rest);
        if (qualifier === null) {
            return modifiers;
        }
        modifiers.push(qualifier[1]);
        rest = rest.slice(qualifier[0].length);
    }
};

/**
 * Remove leading outer attributes from a declaration line. Attribute contents
 * are bracketed, so a nested `[`/`]` pair is tracked instead of stopping at the
 * first `]`.
 */
const rustStripAttributes: (line: string) => string = (line: string): string => {
    let rest: string = line;
    for (;;) {
        const open: RegExpExecArray | null = /^#!?\[/u.exec(rest);
        if (open === null) {
            return rest;
        }
        let depth: number = 0;
        let closing: number = -1;
        for (let index: number = open[0].length - 1; index < rest.length; index += 1) {
            const character: string = rest[index];
            if (character === "[") {
                depth += 1;
            } else if (character === "]") {
                depth -= 1;
                if (depth === 0) {
                    closing = index;
                    break;
                }
            }
        }
        if (closing === -1) {
            return rest;
        }
        rest = rest.slice(closing + 1).trimStart();
    }
};

/**
 * Index of the `>` matching the `<` at `openIndex`, skipping `->`, or -1.
 */
const rustMatchingAngle: (text: string, openIndex: number) => number = (text: string, openIndex: number): number => {
    let depth: number = 0;
    for (let index: number = openIndex; index < text.length; index += 1) {
        const character: string = text[index];
        if (character === "<") {
            depth += 1;
        } else if (character === ">") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        } else if (character === "-" && text[index + 1] === ">") {
            index += 1;
        }
    }
    return -1;
};

/**
 * Index of the closing bracket matching an opening one, or -1.
 */
const rustMatchingBracket: (text: string, openIndex: number, open: string, close: string) => number = (
    text: string, openIndex: number, open: string, close: string,
): number => {
    let depth: number = 0;
    for (let index: number = openIndex; index < text.length; index += 1) {
        const character: string = text[index];
        if (character === open) {
            depth += 1;
        } else if (character === close) {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
};

/**
 * Drop one leading generic parameter list: `<T: Clone, U>`.
 */
const rustSkipGenerics: (text: string) => string = (text: string): string => {
    if (!text.startsWith("<")) {
        return text;
    }
    const end: number = rustMatchingAngle(text, 0);
    return end === -1 ? text : text.slice(end + 1).trimStart();
};

/**
 * Index where an impl target ends: the first top-level `{`, `;` or `where`.
 */
const rustTargetEnd: (text: string) => number = (text: string): number => {
    let parentheses: number = 0;
    let brackets: number = 0;
    for (let index: number = 0; index < text.length; index += 1) {
        const character: string = text[index];
        if (character === "(") {
            parentheses += 1;
        } else if (character === ")") {
            parentheses = Math.max(0, parentheses - 1);
        } else if (character === "[") {
            brackets += 1;
        } else if (character === "]") {
            brackets = Math.max(0, brackets - 1);
        } else if (parentheses === 0 && brackets === 0) {
            if (character === "{" || character === ";") {
                return index;
            }
            if (character === "w" && text.startsWith("where", index) &&
                (index === 0 || /\s/u.test(text[index - 1])) &&
                (index + 5 >= text.length || /\s/u.test(text[index + 5]))) {
                return index;
            }
        }
    }
    return -1;
};

/**
 * One `mod`/`trait`/`impl` header before its body is located.
 */
interface RustContainerHeader {
    readonly keyword: "mod" | "trait" | "impl";
    readonly label: string;
    readonly modifiers: readonly string[];
}

/**
 * Classify one `mod`, `trait` or `impl` header.
 *
 * An `impl` label includes the whole target (`impl Point`, `impl Area for
 * Point`, `impl Wrap<T>`), so an impl never reuses the path of the trait or
 * struct it belongs to; the bare name alone would collide.
 */
const rustContainerHeader: (line: string) => RustContainerHeader | undefined = (line: string): RustContainerHeader | undefined => {
    const visibility: { readonly modifiers: readonly string[]; readonly rest: string } = rustVisibility(line);
    const modifiers: string[] = [...visibility.modifiers];
    let rest: string = visibility.rest;
    const unsafePrefix: RegExpExecArray | null = /^unsafe\s+/u.exec(rest);
    if (unsafePrefix !== null) {
        modifiers.push("unsafe");
        rest = rest.slice(unsafePrefix[0].length);
    }
    const head: RegExpExecArray | null = /^(mod|trait|impl)\b\s*/u.exec(rest);
    if (head === null) {
        return undefined;
    }
    const keyword: "mod" | "trait" | "impl" = head[1] as "mod" | "trait" | "impl";
    rest = rest.slice(head[0].length);
    if (keyword !== "impl") {
        const name: RegExpExecArray | null = rustPattern(`^(${RustIdentifier})`).exec(rest);
        return name === null ? undefined : { keyword, label: name[1], modifiers };
    }
    const body: string = rustSkipGenerics(rest.trim());
    const end: number = rustTargetEnd(body);
    const target: string = (end === -1 ? body : body.slice(0, end)).trim().replace(/\s+/gu, " ");
    return { keyword, label: target.length === 0 ? "impl" : `impl ${target}`, modifiers };
};

/**
 * A Rust declaration's body extent. `openOffset` is -1 when the declaration has
 * no braced body (a `mod x;`, a tuple struct, a trait method signature).
 */
interface RustBlock {
    readonly openOffset: number;
    readonly closeOffset: number;
    readonly openLine: number;
    readonly endLine: number;
}

/**
 * Number of lines searched for a declaration's opening `{`. A declaration's
 * brace is normally on its own line or the next two; the bound stops a
 * malformed header from borrowing the body of a much later item.
 */
const RustBlockSearchLines: number = 64;

/**
 * Locate the body of one Rust declaration.
 *
 * Semicolons inside `(...)` and `[...]` are ignored, so `fn f(buf: [u8; 4])`
 * still ends at its body brace instead of at its signature line. A brace-less
 * declaration ends at its top-level semicolon, or on its own line when neither
 * a brace nor a semicolon can be found.
 */
const rustBlock: (source: MaskedSource, startLine: number) => RustBlock = (source: MaskedSource, startLine: number): RustBlock => {
    const masked: string = source.masked;
    const first: number = source.starts[startLine - 1] ?? 0;
    const windowEnd: number = startLine - 1 + RustBlockSearchLines;
    const limit: number = windowEnd < source.starts.length ? source.starts[windowEnd] : masked.length;
    let parentheses: number = 0;
    let brackets: number = 0;
    for (let index: number = first; index < masked.length; index += 1) {
        if (index >= limit && parentheses === 0 && brackets === 0) {
            break;
        }
        const character: string = masked[index];
        if (character === "(") {
            parentheses += 1;
            continue;
        }
        if (character === ")") {
            parentheses = Math.max(0, parentheses - 1);
            continue;
        }
        if (character === "[") {
            brackets += 1;
            continue;
        }
        if (character === "]") {
            brackets = Math.max(0, brackets - 1);
            continue;
        }
        if (parentheses > 0 || brackets > 0) {
            continue;
        }
        if (character === "{") {
            const close: number | undefined = source.close.get(index);
            return {
                openOffset: index,
                closeOffset: close === (void 0) ? index : close,
                openLine: lineAtOffset(source.starts, index),
                endLine: close === (void 0) ? lineAtOffset(source.starts, index) : lineAtOffset(source.starts, close),
            };
        }
        if (character === ";" || character === "}") {
            const at: number = lineAtOffset(source.starts, index);
            return { openOffset: -1, closeOffset: -1, openLine: at, endLine: at };
        }
    }
    return { openOffset: -1, closeOffset: -1, openLine: startLine, endLine: startLine };
};

/**
 * Split a comma-separated member list at bracket depth zero, so
 * `HashMap<K, V>` stays one field and a tuple variant payload stays one member.
 */
const rustSplitMembers: (text: string) => string[] = (text: string): string[] => {
    const parts: string[] = [];
    let depth: number = 0;
    let start: number = 0;
    for (let index: number = 0; index < text.length; index += 1) {
        const character: string = text[index];
        if (character === "(" || character === "[" || character === "{" || character === "<") {
            depth += 1;
        } else if (character === ")" || character === "]" || character === "}" || character === ">") {
            depth = Math.max(0, depth - 1);
        } else if (character === "-" && text[index + 1] === ">") {
            index += 1;
        } else if (character === "," && depth === 0) {
            parts.push(text.slice(start, index).trim());
            start = index + 1;
        }
    }
    parts.push(text.slice(start).trim());
    return parts.filter((part: string): boolean => part.length > 0);
};

/**
 * One property/member node inside a struct or enum.
 */
const rustMember: (label: string, startLine: number, endLine: number, depth: number, detail: string, modifiers?: readonly string[]) => MutableOutlineNode = (
    label: string, startLine: number, endLine: number, depth: number, detail: string, modifiers: readonly string[] = [],
): MutableOutlineNode => ({
    label,
    kind: "property",
    startLine,
    endLine,
    depth,
    detail,
    ...(modifiers.length === 0 ? {} : { modifiers: [...modifiers] }),
    children: [],
});

/**
 * Collect struct fields: named fields from an inline or multi-line body, and
 * ordinal members for a tuple struct (`struct Pair(u8, u8)`), whose fields have
 * no names to report.
 */
const rustStructMembers: (
    node: MutableOutlineNode,
    after: string,
    line: number,
    depth: number,
    block: RustBlock,
    maskedLines: readonly string[],
    source: MaskedSource,
) => void = (
    node: MutableOutlineNode,
    after: string,
    line: number,
    depth: number,
    block: RustBlock,
    maskedLines: readonly string[],
    source: MaskedSource,
): void => {
    if (block.openOffset >= 0) {
        if (block.openLine === block.endLine) {
            const body: string = source.masked.slice(block.openOffset + 1, block.closeOffset);
            const fields: readonly string[] = rustSplitMembers(body);
            for (let index: number = 0; index < fields.length; index += 1) {
                const field: RegExpExecArray | null = RustField.exec(fields[index]);
                if (field !== null) {
                    node.children.push(rustMember(field[1], line, line, depth + 1, fields[index], rustVisibility(fields[index]).modifiers));
                }
            }
            return;
        }
        for (let fieldLine: number = block.openLine + 1; fieldLine < block.endLine; fieldLine += 1) {
            if (depthAtLine(source, fieldLine) !== depth + 1) {
                continue;
            }
            const text: string = rustStripAttributes((maskedLines[fieldLine - 1] ?? "").trim());
            if (text.length === 0) {
                continue;
            }
            const field: RegExpExecArray | null = RustField.exec(text);
            if (field !== null) {
                node.children.push(rustMember(field[1], fieldLine, fieldLine, depth + 1, text, rustVisibility(text).modifiers));
            }
        }
        return;
    }
    const tupleBody: string = rustSkipGenerics(after.trim());
    if (!tupleBody.startsWith("(")) {
        return;
    }
    const close: number = rustMatchingBracket(tupleBody, 0, "(", ")");
    if (close === -1) {
        return;
    }
    const members: readonly string[] = rustSplitMembers(tupleBody.slice(1, close));
    for (let index: number = 0; index < members.length; index += 1) {
        node.children.push(rustMember(String(index), line, line, depth + 1, members[index], rustVisibility(members[index]).modifiers));
    }
};

/**
 * Collect enum variants. Variants are reported as `property` members (the
 * language-neutral kind set has no `variant`), with the payload kept in detail.
 */
const rustEnumVariants: (
    node: MutableOutlineNode,
    line: number,
    depth: number,
    block: RustBlock,
    maskedLines: readonly string[],
    source: MaskedSource,
) => void = (
    node: MutableOutlineNode,
    line: number,
    depth: number,
    block: RustBlock,
    maskedLines: readonly string[],
    source: MaskedSource,
): void => {
    if (block.openOffset >= 0 && block.openLine === block.endLine) {
        const body: string = source.masked.slice(block.openOffset + 1, block.closeOffset);
        const variants: readonly string[] = rustSplitMembers(body);
        for (let index: number = 0; index < variants.length; index += 1) {
            const variant: RegExpExecArray | null = RustVariant.exec(variants[index]);
            if (variant !== null) {
                node.children.push(rustMember(variant[1], line, line, depth + 1, variants[index]));
            }
        }
        return;
    }
    if (block.openOffset < 0) {
        return;
    }
    for (let variantLine: number = block.openLine + 1; variantLine < block.endLine; variantLine += 1) {
        if (depthAtLine(source, variantLine) !== depth + 1) {
            continue;
        }
        const text: string = rustStripAttributes((maskedLines[variantLine - 1] ?? "").trim());
        if (text.length === 0 || text === "}") {
            continue;
        }
        const variant: RegExpExecArray | null = RustVariant.exec(text);
        if (variant !== null) {
            node.children.push(rustMember(variant[1], variantLine, variantLine, depth + 1, text));
        }
    }
};

/**
 * Parse Rust.
 *
 * `mod`/`impl`/`trait` are containers; `fn`, `struct`, `enum`, `type`, `const`,
 * `static` and `macro_rules!` are symbols at their brace depth and nest under
 * the enclosing container. An `impl` is labelled with its whole target so it
 * does not collide with a same-named trait or struct. A callable inside a trait
 * or impl is a `method`, and functions are containers too, so an item declared
 * inside a function body nests under that function instead of being dropped.
 * Struct fields, tuple-struct fields and enum variants become `property`
 * children.
 *
 * Rust-specific masking is enabled first: lifetimes are not char literals, raw
 * strings hide embedded quotes, and an attribute on the declaration line is
 * stripped before matching. A `'` still starts a character literal when it has
 * a closing quote.
 *
 * @param input - Decoded Rust text.
 * @returns Module/impl/item tree.
 */
export const parseRust: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const masked: string = maskSource(input.text, {
        lineComments: ["//"],
        blockComments: true,
        strings: true,
        template: false,
        tripleQuotes: false,
        regex: false,
        apostrophe: "lifetime",
        rawStrings: true,
    });
    const braced: MaskedSource = scanBraces(source, masked);
    const maskedLines: readonly string[] = splitLines(masked);
    const roots: MutableOutlineNode[] = [];
    const containers: ContainerDraft[] = [];
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const detail: string = (maskedLines[line - 1] ?? "").trim();
        if (detail.length === 0) {
            continue;
        }
        const trimmed: string = rustStripAttributes(detail);
        if (trimmed.length === 0) {
            continue;
        }
        const depth: number = depthAtLine(braced, line);
        const parent: ContainerDraft | undefined = innermostContainer(containers, line);
        const header: RustContainerHeader | undefined = rustContainerHeader(trimmed);
        if (header !== undefined) {
            const block: RustBlock = rustBlock(braced, line);
            const kind: OutlineKind = header.keyword === "trait" ? "trait" : header.keyword === "impl" ? "object" : "module";
            const node: MutableOutlineNode = {
                label: header.label,
                kind,
                startLine: line,
                endLine: block.endLine,
                depth,
                detail,
                ...(header.modifiers.length === 0 ? {} : { modifiers: [...header.modifiers] }),
                children: [],
            };
            if (parent === (void 0)) {
                roots.push(node);
            } else {
                parent.node.children.push(node);
            }
            containers.push({ node, startLine: line, endLine: block.endLine, kind, depth });
            continue;
        }
        let match: RegExpExecArray | null = RustFunction.exec(trimmed);
        let kind: OutlineKind = "function";
        let modifiers: string[] = [];
        if (match !== null) {
            modifiers = rustFunctionModifiers(trimmed);
            if (parent !== (void 0) && (parent.kind === "object" || parent.kind === "trait")) {
                kind = "method";
            }
        } else {
            match = RustStruct.exec(trimmed);
            if (match !== null) {
                kind = "struct";
                modifiers = [...rustVisibility(trimmed).modifiers];
            }
        }
        if (match === null) {
            match = RustEnum.exec(trimmed);
            if (match !== null) {
                kind = "enum";
                modifiers = [...rustVisibility(trimmed).modifiers];
            }
        }
        if (match === null) {
            match = RustType.exec(trimmed);
            if (match !== null) {
                kind = "type";
                modifiers = [...rustVisibility(trimmed).modifiers];
            }
        }
        if (match === null) {
            match = RustMacro.exec(trimmed);
            if (match !== null) {
                kind = "macro";
            }
        }
        if (match === null) {
            match = RustConstant.exec(trimmed);
            if (match !== null) {
                kind = "constant";
                modifiers = [...rustVisibility(trimmed).modifiers];
                if (/^(?:pub(?:\([^)]*\))?\s+)?static\s+mut\s+/u.test(trimmed)) {
                    modifiers.push("mut");
                }
            }
        }
        if (match === null) {
            continue;
        }
        const block: RustBlock = rustBlock(braced, line);
        const node: MutableOutlineNode = {
            label: match[1],
            kind,
            startLine: line,
            endLine: block.endLine,
            depth,
            detail,
            ...(modifiers.length === 0 ? {} : { modifiers: [...modifiers] }),
            children: [],
        };
        if (parent !== (void 0)) {
            parent.node.children.push(node);
        } else if (depth === 0) {
            roots.push(node);
        }
        const after: string = trimmed.slice(match[0].length);
        if (kind === "struct") {
            rustStructMembers(node, after, line, depth, block, maskedLines, braced);
        } else if (kind === "enum") {
            rustEnumVariants(node, line, depth, block, maskedLines, braced);
        }
        if (kind === "function" || kind === "method") {
            containers.push({ node, startLine: line, endLine: block.endLine, kind, depth });
        }
    }
    return roots.map(mutableToNode);
};

/**
 * One XML element produced by the bounded scanner.
 */
interface XmlElement {
    readonly name: string;
    readonly attributes: ReadonlyMap<string, string>;
    readonly children: XmlElement[];
    readonly text: string;
    readonly startLine: number;
    endLine: number;
}

/**
 * Resolve one XML entity body: a predefined name or a numeric reference.
 */
const xmlEntityValue: (entity: string) => string | undefined = (entity: string): string | undefined => {
    switch (entity) {
        case "lt": {
            return "<";
        }
        case "gt": {
            return ">";
        }
        case "quot": {
            return '"';
        }
        case "apos": {
            return "'";
        }
        case "amp": {
            return "&";
        }
        default: {
            break;
        }
    }
    let code: number = -1;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
        code = parseInt(entity.slice(2), 16);
    } else if (entity.startsWith("#")) {
        code = parseInt(entity.slice(1), 10);
    }
    if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) {
        return undefined;
    }
    return String.fromCodePoint(code);
};

/**
 * Decode the five predefined XML entities plus numeric character references.
 * An unknown or malformed reference is preserved verbatim instead of throwing.
 *
 * `named` adds an optional lookup table for a language-specific entity subset
 * (HTML uses one because the XML predefined set is not enough for real pages).
 */
const decodeXmlEntities: (value: string, named?: ReadonlyMap<string, string>) => string = (
    value: string, named?: ReadonlyMap<string, string>,
): string => {
    if (!value.includes("&")) {
        return value;
    }
    let result: string = "";
    let index: number = 0;
    while (index < value.length) {
        const ampersand: number = value.indexOf("&", index);
        if (ampersand === -1) {
            result = `${result}${value.slice(index)}`;
            break;
        }
        result = `${result}${value.slice(index, ampersand)}`;
        const semicolon: number = value.indexOf(";", ampersand + 1);
        if (semicolon === -1) {
            result = `${result}${value.slice(ampersand)}`;
            break;
        }
        const entity: string = value.slice(ampersand + 1, semicolon);
        const decoded: string | undefined = xmlEntityValue(entity) ?? named?.get(entity);
        result = decoded === (void 0) ? `${result}${value.slice(ampersand, semicolon + 1)}` : `${result}${decoded}`;
        index = semicolon + 1;
    }
    return result;
};

/**
 * Index of the `>` that closes one markup construct, ignoring any `>` inside a
 * quoted attribute value. Returns `-1` when the construct is unterminated. XML
 * allows a literal `>` in an attribute value, so a plain `indexOf(">")` would
 * truncate tags such as `<node title="a > b">`.
 */
const xmlTagEnd: (text: string, openIndex: number) => number = (text: string, openIndex: number): number => {
    let quote: string = "";
    for (let index: number = openIndex; index < text.length; index += 1) {
        const character: string = text[index];
        if (quote.length > 0) {
            if (character === quote) {
                quote = "";
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === ">") {
            return index;
        }
    }
    return -1;
};

/**
 * Bounded XML scanner. It handles comments, processing instructions, CDATA and
 * quoted attributes, but deliberately refuses to be a validating parser: an
 * unbalanced file still yields its elements, and an element with no closing tag
 * extends to the end of the file instead of collapsing onto its start line.
 */
const parseXmlDocument: (text: string, starts: readonly number[]) => XmlElement[] = (text: string, starts: readonly number[]): XmlElement[] => {
    const roots: XmlElement[] = [];
    const stack: XmlElement[] = [];
    let index: number = 0;
    let elements: number = 0;
    const appendText: (value: string) => void = (value: string): void => {
        if (stack.length === 0 || value.trim().length === 0) {
            return;
        }
        const current: XmlElement = stack[stack.length - 1];
        if (current.text.length < 4096) {
            (current as { text: string; }).text = `${current.text}${value}`;
        }
    };
    while (index < text.length && elements < 20000) {
        const open: number = text.indexOf("<", index);
        if (open === -1) {
            break;
        }
        if (open > index) {
            appendText(decodeXmlEntities(text.slice(index, open)));
        }
        if (text.startsWith("<!--", open)) {
            const end: number = text.indexOf("-->", open + 4);
            index = end === -1 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith("<![CDATA[", open)) {
            const end: number = text.indexOf("]]>", open + 9);
            index = end === -1 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith("<?", open)) {
            const end: number = text.indexOf("?>", open + 2);
            index = end === -1 ? text.length : end + 2;
            continue;
        }
        if (text.startsWith("<!", open)) {
            const end: number = xmlTagEnd(text, open + 2);
            index = end === -1 ? text.length : end + 1;
            continue;
        }
        const closing: boolean = text.startsWith("</", open);
        const nameMatch: RegExpExecArray | null = /^<\/?([A-Za-z_:][\w:.-]*)/.exec(text.slice(open, open + 256));
        if (nameMatch === null) {
            index = open + 1;
            continue;
        }
        const name: string = nameMatch[1];
        if (closing) {
            const end: number = xmlTagEnd(text, open + 2);
            const line: number = lineAtOffset(starts, open);
            for (let depth: number = stack.length - 1; depth >= 0; depth -= 1) {
                if (stack[depth].name !== name) {
                    continue;
                }
                const closed: XmlElement = stack[depth];
                closed.endLine = line;
                /**
                 * A mismatched close implicitly ends every element opened
                 * inside the matched one: they can never receive their own
                 * closing tag after this point.
                 */
                for (let inner: number = stack.length - 1; inner > depth; inner -= 1) {
                    stack[inner].endLine = line;
                }
                stack.length = depth;
                break;
            }
            index = end === -1 ? text.length : end + 1;
            continue;
        }
        const tagEnd: number = xmlTagEnd(text, open + 1);
        if (tagEnd === -1) {
            break;
        }
        const selfClosing: boolean = text[tagEnd - 1] === "/";
        const attributes: Map<string, string> = new Map<string, string>();
        const attributePattern: RegExp = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        const inner: string = text.slice(open + nameMatch[0].length, selfClosing ? tagEnd - 1 : tagEnd);
        attributePattern.lastIndex = 0;
        let attributeMatch: RegExpExecArray | null = attributePattern.exec(inner);
        while (attributeMatch !== null) {
            attributes.set(attributeMatch[1], decodeXmlEntities(attributeMatch[2] ?? attributeMatch[3] ?? ""));
            attributeMatch = attributePattern.exec(inner);
        }
        const line: number = lineAtOffset(starts, open);
        const element: XmlElement = { name, attributes, children: [], text: "", startLine: line, endLine: line };
        elements += 1;
        if (stack.length === 0) {
            roots.push(element);
        } else {
            stack[stack.length - 1].children.push(element);
        }
        if (!selfClosing) {
            stack.push(element);
        }
        index = tagEnd + 1;
    }
    /**
     * Whatever remains on the stack never met a closing tag. Extend each open
     * element to the last line of the file so its range still addresses the
     * text that belongs to it; a start line alone is useless to a caller.
     */
    if (stack.length > 0) {
        const lastLine: number = lineAtOffset(starts, Math.max(0, text.length - 1));
        for (let depth: number = 0; depth < stack.length; depth += 1) {
            stack[depth].endLine = Math.max(stack[depth].endLine, lastLine);
        }
    }
    return roots;
};

/**
 * Local XML name without a namespace prefix.
 */
const localXmlName: (name: string) => string = (name: string): string => {
    const colon: number = name.lastIndexOf(":");
    return colon === -1 ? name : name.slice(colon + 1);
};

/**
 * First direct child with a local name.
 */
const childXml: (element: XmlElement, name: string) => XmlElement | undefined = (element: XmlElement, name: string): XmlElement | undefined =>
    element.children.find((child: XmlElement): boolean => localXmlName(child.name) === name);

/**
 * First direct child with a local name, or an empty string.
 */
const childXmlText: (element: XmlElement, name: string) => string = (element: XmlElement, name: string): string => {
    const child: XmlElement | undefined = childXml(element, name);
    return child === (void 0) ? "" : child.text.trim();
};

/**
 * Maven coordinate, omitting absent parts.
 */
const mavenCoordinate: (group: string, artifact: string, version: string) => string = (group: string, artifact: string, version: string): string =>
    [group, artifact, version].filter((part: string): boolean => part.length > 0).join(":");

/**
 * Parse a Maven POM.
 *
 * The project node carries `group:artifact:version` in `detail`; modules,
 * dependencies and plugins are direct children. A dependency detail appends
 * its scope when one is declared.
 *
 * @param input - Decoded `pom.xml` text.
 * @returns Project/module/dependency/plugin tree.
 */
export const parseMaven: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    const roots: XmlElement[] = parseXmlDocument(input.text, source.starts);
    const project: XmlElement | undefined = roots.find((element: XmlElement): boolean => localXmlName(element.name) === "project");
    if (project === (void 0)) {
        return [];
    }
    const parent: XmlElement | undefined = childXml(project, "parent");
    const group: string = childXmlText(project, "groupId") || (parent === (void 0) ? "" : childXmlText(parent, "groupId"));
    const artifact: string = childXmlText(project, "artifactId") || "pom.xml";
    const version: string = childXmlText(project, "version") || (parent === (void 0) ? "" : childXmlText(parent, "version"));
    const coordinate: string = mavenCoordinate(group, artifact, version);
    const children: OutlineNode[] = [];
    const modules: XmlElement | undefined = childXml(project, "modules");
    if (modules !== (void 0)) {
        for (let index: number = 0; index < modules.children.length; index += 1) {
            const module: XmlElement = modules.children[index];
            if (localXmlName(module.name) !== "module" || module.text.trim().length === 0) {
                continue;
            }
            children.push(
                outlineNode({
                    label: module.text.trim(),
                    kind: "module",
                    startLine: module.startLine,
                    endLine: module.endLine,
                    depth: 1,
                    detail: "module",
                }),
            );
        }
    }
    const dependencies: XmlElement | undefined = childXml(project, "dependencies");
    if (dependencies !== (void 0)) {
        for (let index: number = 0; index < dependencies.children.length; index += 1) {
            const dependency: XmlElement = dependencies.children[index];
            if (localXmlName(dependency.name) !== "dependency") {
                continue;
            }
            const dependencyGroup: string = childXmlText(dependency, "groupId");
            const dependencyArtifact: string = childXmlText(dependency, "artifactId");
            const dependencyVersion: string = childXmlText(dependency, "version");
            const scope: string = childXmlText(dependency, "scope");
            const name: string = dependencyArtifact || dependencyGroup;
            if (name.length === 0) {
                continue;
            }
            const coordinateText: string = mavenCoordinate(dependencyGroup, dependencyArtifact, dependencyVersion);
            children.push(
                outlineNode({
                    label: name,
                    kind: "dependency",
                    startLine: dependency.startLine,
                    endLine: dependency.endLine,
                    depth: 1,
                    detail: scope.length === 0 ? coordinateText : `${coordinateText}:${scope}`,
                }),
            );
        }
    }
    const build: XmlElement | undefined = childXml(project, "build");
    const plugins: XmlElement | undefined = build === (void 0) ? undefined : childXml(build, "plugins");
    if (plugins !== (void 0)) {
        for (let index: number = 0; index < plugins.children.length; index += 1) {
            const plugin: XmlElement = plugins.children[index];
            if (localXmlName(plugin.name) !== "plugin") {
                continue;
            }
            const pluginGroup: string = childXmlText(plugin, "groupId");
            const pluginArtifact: string = childXmlText(plugin, "artifactId");
            const pluginVersion: string = childXmlText(plugin, "version");
            const name: string = pluginArtifact || pluginGroup;
            if (name.length === 0) {
                continue;
            }
            children.push(
                outlineNode({
                    label: name,
                    kind: "plugin",
                    startLine: plugin.startLine,
                    endLine: plugin.endLine,
                    depth: 1,
                    detail: mavenCoordinate(pluginGroup, pluginArtifact, pluginVersion),
                }),
            );
        }
    }
    return [
        outlineNode({
            label: artifact,
            kind: "workspace",
            startLine: project.startLine,
            endLine: project.endLine,
            depth: 0,
            ...(coordinate.length === 0 ? {} : { detail: coordinate }),
            children,
        }),
    ];
};

/**
 * One TOML key/value inside a table.
 */
interface TomlEntry {
    readonly key: string;
    readonly value: string;
    readonly items: readonly string[];
    readonly itemLines: readonly number[];
    readonly line: number;
}

/**
 * One TOML table (`[name]` or `[[name]]`).
 */
interface TomlTable {
    readonly name: string;
    readonly array: boolean;
    readonly line: number;
    readonly entries: TomlEntry[];
}

/**
 * Remove an inline `#` comment while respecting quotes.
 */
const stripTomlComment: (value: string) => string = (value: string): string => {
    let quote: string = "";
    for (let index: number = 0; index < value.length; index += 1) {
        const character: string = value[index];
        if (quote.length > 0) {
            if (character === "\\" && quote === '"') {
                index += 1;
                continue;
            }
            if (character === quote) {
                quote = "";
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === "#") {
            return value.slice(0, index);
        }
    }
    return value;
};

/**
 * Unquote one TOML string item.
 */
const tomlValue: (value: string) => string = (value: string): string => {
    const trimmed: string = value.trim();
    if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
};

/**
 * Quoted strings inside a TOML array literal.
 */
const tomlArrayItems: (value: string) => string[] = (value: string): string[] => {
    const items: string[] = [];
    const pattern: RegExp = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
    let match: RegExpExecArray | null = pattern.exec(value);
    while (match !== null) {
        items.push(tomlValue(match[0]));
        match = pattern.exec(value);
    }
    return items;
};

/**
 * Bounded TOML scanner that keeps tables, keys, values, array items and lines.
 */
const parseTomlDocument: (text: string) => TomlTable[] = (text: string): TomlTable[] => {
    const source: SourceLines = readSourceLines(text);
    const tables: TomlTable[] = [{ name: "", array: false, line: 1, entries: [] }];
    let current: TomlTable = tables[0];
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const raw: string = source.lines[line - 1] ?? "";
        const section: RegExpExecArray | null = /^\s*(\[\[?)([^\]]+)\]\]?\s*$/.exec(raw);
        if (section !== null) {
            const name: string = section[2].trim().replace(/^["']|["']$/g, "");
            const array: boolean = section[1] === "[[";
            current = { name, array, line, entries: [] };
            tables.push(current);
            continue;
        }
        const pair: RegExpExecArray | null = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(raw);
        if (pair === null) {
            continue;
        }
        const key: string = tomlValue(pair[1]);
        const entryLine: number = line;
        const firstValue: string = stripTomlComment(pair[2]).trim();
        const items: string[] = [];
        const itemLines: number[] = [];
        const collectItems: (rawValue: string, atLine: number) => void = (rawValue: string, atLine: number): void => {
            const values: string[] = tomlArrayItems(rawValue);
            for (let index: number = 0; index < values.length; index += 1) {
                items.push(values[index]);
                itemLines.push(atLine);
            }
        };
        let value: string = firstValue;
        if (value.startsWith("[")) {
            collectItems(value, entryLine);
            if (!value.includes("]")) {
                let cursor: number = entryLine + 1;
                while (cursor <= source.totalLines && !value.includes("]")) {
                    const next: string = stripTomlComment(source.lines[cursor - 1] ?? "").trim();
                    collectItems(next, cursor);
                    value = `${value} ${next}`;
                    cursor += 1;
                }
                line = cursor - 1;
            }
        }
        current.entries.push({ key, value, items, itemLines, line: entryLine });
    }
    return tables;
};

/**
 * Look up one key in a table.
 */
const tomlEntry: (table: TomlTable | undefined, key: string) => TomlEntry | undefined = (table: TomlTable | undefined, key: string): TomlEntry | undefined =>
    table === (void 0) ? undefined : table.entries.find((entry: TomlEntry): boolean => entry.key === key);

/**
 * Parse a Cargo manifest.
 *
 * The package node carries `name version` in `detail`; dependency tables,
 * `[[bin]]`/`[lib]` targets and workspace members are its children.
 *
 * @param input - Decoded `Cargo.toml` text.
 * @returns Package/dependency/target tree.
 */
export const parseCargo: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    const tables: TomlTable[] = parseTomlDocument(input.text);
    const packageTable: TomlTable | undefined = tables.find((table: TomlTable): boolean => table.name === "package");
    const nameEntry: TomlEntry | undefined = tomlEntry(packageTable, "name");
    const versionEntry: TomlEntry | undefined = tomlEntry(packageTable, "version");
    const name: string = nameEntry === (void 0) ? "Cargo.toml" : tomlValue(nameEntry.value);
    const version: string = versionEntry === (void 0) ? "" : tomlValue(versionEntry.value);
    const children: OutlineNode[] = [];
    for (let index: number = 0; index < tables.length; index += 1) {
        const table: TomlTable = tables[index];
        if (table === packageTable) {
            continue;
        }
        if (table.name === "dependencies" || table.name === "dev-dependencies" || table.name === "build-dependencies" || table.name.endsWith(".dependencies")) {
            for (let entryIndex: number = 0; entryIndex < table.entries.length; entryIndex += 1) {
                const entry: TomlEntry = table.entries[entryIndex];
                children.push(
                    outlineNode({
                        label: entry.key,
                        kind: "dependency",
                        startLine: entry.line,
                        endLine: entry.line,
                        depth: 1,
                        detail: entry.value.length === 0 ? table.name : tomlValue(entry.value),
                    }),
                );
            }
            continue;
        }
        if (table.name === "bin" || table.name === "lib") {
            const targetName: TomlEntry | undefined = tomlEntry(table, "name");
            children.push(
                outlineNode({
                    label: targetName === (void 0) ? table.name : tomlValue(targetName.value),
                    kind: "target",
                    startLine: table.line,
                    endLine: table.line,
                    depth: 1,
                    detail: table.name,
                }),
            );
            continue;
        }
        if (table.name === "workspace") {
            const members: TomlEntry | undefined = tomlEntry(table, "members");
            if (members !== (void 0)) {
                for (let memberIndex: number = 0; memberIndex < members.items.length; memberIndex += 1) {
                    const memberLine: number = members.itemLines[memberIndex] ?? members.line;
                    children.push(
                        outlineNode({
                            label: members.items[memberIndex],
                            kind: "workspace",
                            startLine: memberLine,
                            endLine: memberLine,
                            depth: 1,
                            detail: "workspace",
                        }),
                    );
                }
            }
        }
    }
    return [
        outlineNode({
            label: name,
            kind: "package",
            startLine: packageTable === (void 0) ? 1 : packageTable.line,
            endLine: source.totalLines,
            depth: 0,
            ...(version.length === 0 ? {} : { detail: `${name} ${version}` }),
            children,
        }),
    ];
};

/**
 * Parse a `pyproject.toml`.
 *
 * PEP 621 `[project]` fields, Poetry `[tool.poetry]` fields, dependency arrays,
 * optional-dependency groups, and both `[project.scripts]` and
 * `[tool.poetry.scripts]` are recognized.
 *
 * @param input - Decoded `pyproject.toml` text.
 * @returns Package/dependency/script tree.
 */
export const parsePyproject: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    const tables: TomlTable[] = parseTomlDocument(input.text);
    const projectTable: TomlTable | undefined = tables.find((table: TomlTable): boolean => table.name === "project");
    const poetryTable: TomlTable | undefined = tables.find((table: TomlTable): boolean => table.name === "tool.poetry");
    const nameEntry: TomlEntry | undefined = tomlEntry(projectTable, "name") ?? tomlEntry(poetryTable, "name");
    const versionEntry: TomlEntry | undefined = tomlEntry(projectTable, "version") ?? tomlEntry(poetryTable, "version");
    const name: string = nameEntry === (void 0) ? "pyproject.toml" : tomlValue(nameEntry.value);
    const version: string = versionEntry === (void 0) ? "" : tomlValue(versionEntry.value);
    const children: OutlineNode[] = [];
    for (let index: number = 0; index < tables.length; index += 1) {
        const table: TomlTable = tables[index];
        if (table.name === "project") {
            const dependencies: TomlEntry | undefined = tomlEntry(table, "dependencies");
            if (dependencies !== (void 0)) {
                for (let itemIndex: number = 0; itemIndex < dependencies.items.length; itemIndex += 1) {
                    const itemLine: number = dependencies.itemLines[itemIndex] ?? dependencies.line;
                    children.push(
                        outlineNode({
                            label: dependencies.items[itemIndex],
                            kind: "dependency",
                            startLine: itemLine,
                            endLine: itemLine,
                            depth: 1,
                            detail: "runtime",
                        }),
                    );
                }
            }
            continue;
        }
        if (table.name === "build-system") {
            const requires: TomlEntry | undefined = tomlEntry(table, "requires");
            if (requires !== (void 0)) {
                for (let itemIndex: number = 0; itemIndex < requires.items.length; itemIndex += 1) {
                    const itemLine: number = requires.itemLines[itemIndex] ?? requires.line;
                    children.push(
                        outlineNode({
                            label: requires.items[itemIndex],
                            kind: "dependency",
                            startLine: itemLine,
                            endLine: itemLine,
                            depth: 1,
                            detail: "build",
                        }),
                    );
                }
            }
            continue;
        }
        if (table.name === "project.optional-dependencies") {
            for (let entryIndex: number = 0; entryIndex < table.entries.length; entryIndex += 1) {
                const entry: TomlEntry = table.entries[entryIndex];
                for (let itemIndex: number = 0; itemIndex < entry.items.length; itemIndex += 1) {
                    const itemLine: number = entry.itemLines[itemIndex] ?? entry.line;
                    children.push(
                        outlineNode({
                            label: entry.items[itemIndex],
                            kind: "dependency",
                            startLine: itemLine,
                            endLine: itemLine,
                            depth: 1,
                            detail: entry.key,
                        }),
                    );
                }
            }
            continue;
        }
        const poetryGroup: RegExpExecArray | null = /^tool\.poetry\.group\.([^.]+)\.dependencies$/.exec(table.name);
        if (table.name === "tool.poetry.dependencies" || table.name === "tool.poetry.dev-dependencies" || poetryGroup !== null) {
            const poetryDetail: string = poetryGroup !== null ? poetryGroup[1] : table.name === "tool.poetry.dev-dependencies" ? "dev" : "";
            for (let entryIndex: number = 0; entryIndex < table.entries.length; entryIndex += 1) {
                const entry: TomlEntry = table.entries[entryIndex];
                if (entry.key === "python") {
                    continue;
                }
                children.push(
                    outlineNode({
                        label: entry.key,
                        kind: "dependency",
                        startLine: entry.line,
                        endLine: entry.line,
                        depth: 1,
                        detail: poetryDetail.length === 0 ? tomlValue(entry.value) : poetryDetail,
                    }),
                );
            }
            continue;
        }
        if (table.name === "project.scripts" || table.name === "tool.poetry.scripts") {
            for (let entryIndex: number = 0; entryIndex < table.entries.length; entryIndex += 1) {
                const entry: TomlEntry = table.entries[entryIndex];
                children.push(
                    outlineNode({
                        label: entry.key,
                        kind: "script",
                        startLine: entry.line,
                        endLine: entry.line,
                        depth: 1,
                        detail: tomlValue(entry.value),
                    }),
                );
            }
        }
    }
    return [
        outlineNode({
            label: name,
            kind: "package",
            startLine: projectTable === (void 0) ? 1 : projectTable.line,
            endLine: source.totalLines,
            depth: 0,
            ...(version.length === 0 ? {} : { detail: `${name} ${version}` }),
            children,
        }),
    ];
};

/**
 * Parse `go.mod`.
 *
 * The module path is the root `module` node; every `require` entry is a
 * `dependency` child with its version in `detail`, and `replace` edges become
 * `reference` children.
 *
 * @param input - Decoded `go.mod` text.
 * @returns Module/dependency tree.
 */
export const parseGoMod: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    const roots: OutlineNode[] = [];
    const children: OutlineNode[] = [];
    let moduleName: string = "";
    let moduleLine: number = 1;
    let required: boolean = false;
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const text: string = (source.lines[line - 1] ?? "").replace(/\/\/.*$/, "").trim();
        if (text.length === 0) {
            continue;
        }
        const moduleMatch: RegExpExecArray | null = /^module\s+(\S+)/.exec(text);
        if (moduleMatch !== null) {
            moduleName = moduleMatch[1];
            moduleLine = line;
            continue;
        }
        if (/^require\s*\($/.test(text)) {
            required = true;
            continue;
        }
        if (required && text === ")") {
            required = false;
            continue;
        }
        const requireMatch: RegExpExecArray | null = required ? /^(\S+)\s+(\S+)/.exec(text) : /^require\s+(\S+)\s+(\S+)/.exec(text);
        if (requireMatch !== null) {
            children.push(
                outlineNode({
                    label: requireMatch[1],
                    kind: "dependency",
                    startLine: line,
                    endLine: line,
                    depth: 1,
                    detail: requireMatch[2],
                }),
            );
            continue;
        }
        const replaceMatch: RegExpExecArray | null = /^replace\s+(\S+)(?:\s+\S+)?\s+=>\s+(\S+)/.exec(text);
        if (replaceMatch !== null) {
            children.push(
                outlineNode({
                    label: replaceMatch[1],
                    kind: "reference",
                    startLine: line,
                    endLine: line,
                    depth: 1,
                    detail: replaceMatch[2],
                }),
            );
        }
    }
    if (moduleName.length === 0 && children.length === 0) {
        return [];
    }
    roots.push(
        outlineNode({
            label: moduleName.length === 0 ? "go.mod" : moduleName,
            kind: "module",
            startLine: moduleLine,
            endLine: source.totalLines,
            depth: 0,
            ...(moduleName.length === 0 ? {} : { detail: "module" }),
            children,
        }),
    );
    return roots;
};

/**
 * Makefile target or variable definition.
 */
interface MakeEntry {
    readonly label: string;
    readonly kind: OutlineKind;
    readonly startLine: number;
    endLine: number;
    readonly detail: string;
    readonly line: number;
}

const MakeVariable: RegExp = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*(?::=|\?=|\+=|!=|=)\s*(.*)$/;
const MakeTarget: RegExp = /^([^:#=\s][^:#=]*?)\s*:(?!=)\s*(.*)$/;

/**
 * Parse a Makefile.
 *
 * Targets are `target` nodes (all names on a multi-target line are emitted) and
 * assignments are `variable` nodes. A node covers its recipe lines up to the
 * next definition. `.PHONY` and other dot-prefixed special targets are skipped
 * because they describe metadata rather than an action.
 *
 * @param input - Decoded Makefile text.
 * @returns Target/variable list.
 */
export const parseMakefile: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    const pending: MakeEntry[] = [];
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const raw: string = source.lines[line - 1] ?? "";
        if (raw.startsWith("\t") || raw.trim().length === 0 || raw.trim().startsWith("#")) {
            continue;
        }
        const variable: RegExpExecArray | null = MakeVariable.exec(raw);
        if (variable !== null) {
            pending.push({ label: variable[1], kind: "variable", startLine: line, endLine: line, detail: variable[2].trim(), line });
            continue;
        }
        const target: RegExpExecArray | null = MakeTarget.exec(raw);
        if (target === null) {
            continue;
        }
        const names: string[] = target[1].trim().split(/\s+/).filter((name: string): boolean => name.length > 0 && !name.startsWith("."));
        for (let index: number = 0; index < names.length; index += 1) {
            pending.push({ label: names[index], kind: "target", startLine: line, endLine: line, detail: target[2].trim(), line });
        }
    }
    for (let index: number = 0; index < pending.length; index += 1) {
        const entry: MakeEntry = pending[index];
        const next: MakeEntry | undefined = pending[index + 1];
        const endLine: number = next === (void 0) ? source.totalLines : next.line - 1;
        (entry as { endLine: number; }).endLine = Math.max(entry.line, endLine);
    }
    return pending.map((entry: MakeEntry): OutlineNode =>
        outlineNode({
            label: entry.label,
            kind: entry.kind,
            startLine: entry.startLine,
            endLine: entry.endLine,
            depth: 0,
            ...(entry.detail.length === 0 ? {} : { detail: entry.detail }),
        }),
    );
};

/**
 * One CMake command invocation.
 */
interface CmakeCommand {
    readonly name: string;
    readonly args: readonly string[];
    readonly startLine: number;
    readonly endLine: number;
}

/**
 * Split a CMake argument list on whitespace while honoring quotes.
 */
const cmakeArguments: (raw: string) => string[] = (raw: string): string[] => {
    const args: string[] = [];
    let current: string = "";
    let quote: string = "";
    for (let index: number = 0; index < raw.length; index += 1) {
        const character: string = raw[index];
        if (quote.length > 0) {
            if (character === quote) {
                quote = "";
                continue;
            }
            current = `${current}${character}`;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (/\s/.test(character)) {
            if (current.length > 0) {
                args.push(current);
                current = "";
            }
            continue;
        }
        current = `${current}${character}`;
    }
    if (current.length > 0) {
        args.push(current);
    }
    return args;
};

/**
 * Scan CMake command invocations with comment, quote and nested-parenthesis
 * awareness. Bounded scanning, not a full CMake grammar.
 */
const parseCmakeCommands: (text: string, starts: readonly number[]) => CmakeCommand[] = (text: string, starts: readonly number[]): CmakeCommand[] => {
    const commands: CmakeCommand[] = [];
    let index: number = 0;
    while (index < text.length) {
        const character: string = text[index];
        if (/\s/.test(character)) {
            index += 1;
            continue;
        }
        if (character === "#") {
            const newline: number = text.indexOf("\n", index);
            index = newline === -1 ? text.length : newline;
            continue;
        }
        const nameMatch: RegExpExecArray | null = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(index, index + 128));
        if (nameMatch === null) {
            index += 1;
            continue;
        }
        const startLine: number = lineAtOffset(starts, index);
        let cursor: number = index + nameMatch[1].length;
        while (cursor < text.length && /\s/.test(text[cursor])) {
            cursor += 1;
        }
        if (text[cursor] !== "(") {
            index = cursor;
            continue;
        }
        cursor += 1;
        const contentStart: number = cursor;
        let depth: number = 1;
        while (cursor < text.length && depth > 0) {
            const current: string = text[cursor];
            if (current === "#") {
                const newline: number = text.indexOf("\n", cursor);
                cursor = newline === -1 ? text.length : newline;
                continue;
            }
            if (current === '"' || current === "'") {
                const quote: string = current;
                cursor += 1;
                while (cursor < text.length) {
                    if (text[cursor] === "\\") {
                        cursor += 2;
                        continue;
                    }
                    if (text[cursor] === quote) {
                        cursor += 1;
                        break;
                    }
                    cursor += 1;
                }
                continue;
            }
            if (current === "(") {
                depth += 1;
            } else if (current === ")") {
                depth -= 1;
                if (depth === 0) {
                    break;
                }
            }
            cursor += 1;
        }
        const rawArgs: string = text.slice(contentStart, Math.max(contentStart, cursor));
        commands.push({
            name: nameMatch[1].toLowerCase(),
            args: cmakeArguments(rawArgs),
            startLine,
            endLine: lineAtOffset(starts, Math.min(cursor, Math.max(0, text.length - 1))),
        });
        index = cursor + 1;
    }
    return commands;
};

/**
 * Parse a `CMakeLists.txt` or a `*.cmake` include module.
 *
 * `project` gives the workspace node its name; executable/library targets,
 * subdirectories, link dependencies and options become children with a
 * `detail` that says what kind of entry they are. An include module usually has
 * no `project()` call, so the workspace node falls back to the file's base name.
 *
 * @param input - Decoded CMake text.
 * @returns Project/target/module/option tree.
 */
export const parseCmake: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const commands: CmakeCommand[] = parseCmakeCommands(input.text, source.starts);
    if (commands.length === 0) {
        return [];
    }
    const project: CmakeCommand | undefined = commands.find((command: CmakeCommand): boolean => command.name === "project");
    const projectName: string = project !== (void 0) && project.args.length > 0 ? project.args[0] : baseNameOf(input.path);
    const children: OutlineNode[] = [];
    for (let index: number = 0; index < commands.length; index += 1) {
        const command: CmakeCommand = commands[index];
        if (command.args.length === 0) {
            continue;
        }
        if (command.name === "add_executable" || command.name === "add_library") {
            const detail: string = command.name === "add_executable" ? "executable" : command.args[1] !== (void 0) && /^(STATIC|SHARED|MODULE|OBJECT|INTERFACE)$/.test(command.args[1]) ? `library:${command.args[1]}` : "library";
            children.push(
                outlineNode({
                    label: command.args[0],
                    kind: "target",
                    startLine: command.startLine,
                    endLine: command.endLine,
                    depth: 1,
                    detail,
                }),
            );
            continue;
        }
        if (command.name === "add_subdirectory") {
            children.push(
                outlineNode({
                    label: command.args[0],
                    kind: "module",
                    startLine: command.startLine,
                    endLine: command.endLine,
                    depth: 1,
                    detail: "subdirectory",
                }),
            );
            continue;
        }
        if (command.name === "target_link_libraries") {
            const target: string = command.args[0];
            for (let argument: number = 1; argument < command.args.length; argument += 1) {
                const library: string = command.args[argument];
                if (/^(PRIVATE|PUBLIC|INTERFACE|LINK_PRIVATE|LINK_PUBLIC|debug|optimized|general)$/.test(library) || library === target) {
                    continue;
                }
                children.push(
                    outlineNode({
                        label: library,
                        kind: "dependency",
                        startLine: command.startLine,
                        endLine: command.endLine,
                        depth: 1,
                        detail: `link:${target}`,
                    }),
                );
            }
            continue;
        }
        if (command.name === "option") {
            children.push(
                outlineNode({
                    label: command.args[0],
                    kind: "variable",
                    startLine: command.startLine,
                    endLine: command.endLine,
                    depth: 1,
                    detail: "option",
                }),
            );
        }
    }
    return [
        outlineNode({
            label: projectName,
            kind: "workspace",
            startLine: project === (void 0) ? 1 : project.startLine,
            endLine: source.totalLines,
            depth: 0,
            detail: "project",
            children,
        }),
    ];
};

/**
 * Parse a Gradle build or settings script.
 *
 * `rootProject.name` names the workspace node; `plugins`, `dependencies`,
 * `tasks` and `include` entries become child nodes. Strings are read from the
 * raw line while block boundaries come from a masked copy, so a brace in a
 * string cannot unbalance a block.
 *
 * @param input - Decoded `build.gradle`/`build.gradle.kts` text.
 * @returns Workspace/plugin/dependency/task/module tree.
 */
export const parseGradle: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const masked: string = maskSource(input.text, {
        lineComments: ["//"],
        blockComments: true,
        strings: true,
        template: false,
        tripleQuotes: true,
        regex: false,
    });
    const braced: MaskedSource = scanBraces(source, masked);
    const maskedLines: readonly string[] = splitLines(masked);
    const rawLines: readonly string[] = source.lines;
    let rootProject: string = "";
    const blockNames: readonly string[] = ["plugins", "dependencies", "tasks"];
    const blocks: Array<{ readonly kind: string; readonly startLine: number; readonly endLine: number; }> = [];
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const raw: string = rawLines[line - 1] ?? "";
        const rootMatch: RegExpExecArray | null = /^\s*rootProject\.name\s*=\s*["']([^"']+)["']/.exec(raw);
        if (rootMatch !== null && rootProject.length === 0) {
            rootProject = rootMatch[1];
        }
        const trimmed: string = (maskedLines[line - 1] ?? "").trim();
        for (let blockIndex: number = 0; blockIndex < blockNames.length; blockIndex += 1) {
            const blockName: string = blockNames[blockIndex];
            if (new RegExp(`^${blockName}\\s*\\{`).test(trimmed)) {
                blocks.push({ kind: blockName, startLine: line, endLine: blockEndLine(braced, line) });
            }
        }
    }
    const children: OutlineNode[] = [];
    for (let blockIndex: number = 0; blockIndex < blocks.length; blockIndex += 1) {
        const block: { readonly kind: string; readonly startLine: number; readonly endLine: number; } = blocks[blockIndex];
        const inlineRaw: string = rawLines[block.startLine - 1] ?? "";
        const inlineOpen: number = inlineRaw.indexOf("{");
        const inline: string = block.startLine === block.endLine && inlineOpen !== -1 ? inlineRaw.slice(inlineOpen + 1) : "";
        if (inline.length > 0) {
            if (block.kind === "plugins") {
                const pluginPattern: RegExp = /(?:id|kotlin)\s*\(?\s*["']([^"']+)["']/g;
                const inlineVersion: RegExpExecArray | null = /version\s*\(?\s*["']([^"']+)["']/.exec(inline);
                let pluginMatch: RegExpExecArray | null = pluginPattern.exec(inline);
                while (pluginMatch !== null) {
                    children.push(
                        outlineNode({
                            label: pluginMatch[1],
                            kind: "plugin",
                            startLine: block.startLine,
                            endLine: block.startLine,
                            depth: 1,
                            detail: inlineVersion === null ? "plugin" : `plugin:${inlineVersion[1]}`,
                        }),
                    );
                    pluginMatch = pluginPattern.exec(inline);
                }
            } else if (block.kind === "tasks") {
                const taskPattern: RegExp = /(?:register|create|named)\s*\(\s*["']([^"']+)["']/g;
                let taskMatch: RegExpExecArray | null = taskPattern.exec(inline);
                while (taskMatch !== null) {
                    children.push(
                        outlineNode({
                            label: taskMatch[1],
                            kind: "task",
                            startLine: block.startLine,
                            endLine: block.startLine,
                            depth: 1,
                            detail: "task",
                        }),
                    );
                    taskMatch = taskPattern.exec(inline);
                }
            } else {
                const dependencyPattern: RegExp = /([A-Za-z_]\w*)\s*\(?\s*(?:project\s*\(\s*["']([^"']+)["']|["']([^"']+)["'])/g;
                let dependencyMatch: RegExpExecArray | null = dependencyPattern.exec(inline);
                while (dependencyMatch !== null) {
                    const configuration: string = dependencyMatch[1];
                    if (dependencyMatch[2] !== (void 0)) {
                        children.push(
                            outlineNode({
                                label: dependencyMatch[2],
                                kind: "dependency",
                                startLine: block.startLine,
                                endLine: block.startLine,
                                depth: 1,
                                detail: `${configuration}:project`,
                            }),
                        );
                    } else if (dependencyMatch[3] !== (void 0) && dependencyMatch[3].includes(":")) {
                        const segments: string[] = dependencyMatch[3].split(":");
                        const label: string = segments.length >= 3 ? segments[segments.length - 2] : segments[segments.length - 1];
                        children.push(
                            outlineNode({
                                label: label.length === 0 ? dependencyMatch[3] : label,
                                kind: "dependency",
                                startLine: block.startLine,
                                endLine: block.startLine,
                                depth: 1,
                                detail: dependencyMatch[3],
                            }),
                        );
                    }
                    dependencyMatch = dependencyPattern.exec(inline);
                }
            }
            continue;
        }
        for (let line: number = block.startLine + 1; line < block.endLine; line += 1) {
            const raw: string = rawLines[line - 1] ?? "";
            if ((maskedLines[line - 1] ?? "").trim().length === 0) {
                continue;
            }
            if (block.kind === "plugins") {
                const plugin: RegExpExecArray | null = /^\s*(?:id|kotlin)\s*\(?\s*["']([^"']+)["']/.exec(raw);
                if (plugin !== null) {
                    const version: RegExpExecArray | null = /version\s*\(?\s*["']([^"']+)["']/.exec(raw);
                    children.push(
                        outlineNode({
                            label: plugin[1],
                            kind: "plugin",
                            startLine: line,
                            endLine: line,
                            depth: 1,
                            detail: version === null ? "plugin" : `plugin:${version[1]}`,
                        }),
                    );
                }
                continue;
            }
            if (block.kind === "tasks") {
                const task: RegExpExecArray | null = /^\s*(?:tasks\.)?(?:register|create|named)\s*\(\s*["']([^"']+)["']/.exec(raw);
                const groovyTask: RegExpExecArray | null = task === null ? /^\s*task\s+([A-Za-z_]\w*)/.exec(raw) : null;
                const label: string = task !== null ? task[1] : groovyTask !== null ? groovyTask[1] : "";
                if (label.length > 0) {
                    children.push(outlineNode({ label, kind: "task", startLine: line, endLine: line, depth: 1, detail: "task" }));
                }
                continue;
            }
            const project: RegExpExecArray | null = /^\s*([A-Za-z_]\w*)\s*\(?\s*project\s*\(\s*["']([^"']+)["']/.exec(raw);
            if (project !== null) {
                children.push(
                    outlineNode({
                        label: project[2],
                        kind: "dependency",
                        startLine: line,
                        endLine: line,
                        depth: 1,
                        detail: `${project[1]}:project`,
                    }),
                );
                continue;
            }
            const coordinate: RegExpExecArray | null = /^\s*([A-Za-z_]\w*)\s*\(?\s*["']([^"']+)["']/.exec(raw);
            if (coordinate !== null && coordinate[2].includes(":")) {
                const segments: string[] = coordinate[2].split(":");
                const label: string = segments.length >= 3 ? segments[segments.length - 2] : segments[segments.length - 1];
                children.push(
                    outlineNode({
                        label: label.length === 0 ? coordinate[2] : label,
                        kind: "dependency",
                        startLine: line,
                        endLine: line,
                        depth: 1,
                        detail: coordinate[2],
                    }),
                );
                continue;
            }
            const mapDependency: RegExpExecArray | null = /^\s*([A-Za-z_]\w*)\s*\(?\s*group\s*[:=]\s*["']([^"']+)["']/.exec(raw);
            if (mapDependency !== null) {
                const nameMatch: RegExpExecArray | null = /name\s*[:=]\s*["']([^"']+)["']/.exec(raw);
                const versionMatch: RegExpExecArray | null = /version\s*[:=]\s*["']([^"']+)["']/.exec(raw);
                const label: string = nameMatch === null ? mapDependency[2] : nameMatch[1];
                const detail: string = mavenCoordinate(mapDependency[2], nameMatch === null ? "" : nameMatch[1], versionMatch === null ? "" : versionMatch[1]);
                children.push(outlineNode({ label, kind: "dependency", startLine: line, endLine: line, depth: 1, detail }));
            }
        }
    }
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const raw: string = rawLines[line - 1] ?? "";
        const include: RegExpExecArray | null = /^\s*include\s*\(?\s*(.+)$/.exec(raw);
        if (include === null) {
            continue;
        }
        const quoted: RegExp = /["']([^"']+)["']/g;
        let match: RegExpExecArray | null = quoted.exec(include[1]);
        while (match !== null) {
            children.push(outlineNode({ label: match[1], kind: "module", startLine: line, endLine: line, depth: 1, detail: "include" }));
            match = quoted.exec(include[1]);
        }
    }
    const workspaceName: string = rootProject.length === 0 ? baseNameOf(input.path) : rootProject;
    return [
        outlineNode({
            label: workspaceName,
            kind: "workspace",
            startLine: 1,
            endLine: source.totalLines,
            depth: 0,
            detail: "gradle",
            children: sortNodesByLine(children),
        }),
    ];
};

/**
 * Package coordinate for an npm manifest.
 */
const npmCoordinate: (name: string, version: string) => string = (name: string, version: string): string => (version.length === 0 ? name : `${name}@${version}`);

/**
 * One JSON key locator with a monotonic search offset.
 */
interface JsonLocator {
    readonly text: string;
    readonly starts: readonly number[];
    offset: number;
}

/**
 * Locate a quoted JSON key or value at or after the locator offset.
 */
const locateJson: (locator: JsonLocator, literal: string) => number = (locator: JsonLocator, literal: string): number => {
    const found: number = findJsonKey(locator.text, literal, locator.offset);
    locator.offset = found + 1;
    return lineAtOffset(locator.starts, found);
};

/**
 * One JSON object/array span located from its key.
 */
interface JsonSpan {
    readonly startLine: number;
    readonly openIndex: number;
    readonly closeIndex: number;
}

/**
 * Offset of the `{`/`[` value opener after a key literal, or `-1`.
 */
const jsonValueOpen: (cleaned: string, literalEnd: number) => number = (cleaned: string, literalEnd: number): number => {
    let index: number = literalEnd;
    while (index < cleaned.length && /\s/.test(cleaned[index])) {
        index += 1;
    }
    if (cleaned[index] !== ":") {
        return -1;
    }
    index += 1;
    while (index < cleaned.length && /\s/.test(cleaned[index])) {
        index += 1;
    }
    return cleaned[index] === "{" || cleaned[index] === "[" ? index : -1;
};

/**
 * Matching close index for a JSON object/array opener, ignoring braces inside
 * string literals. `-1` when the structure is unterminated.
 */
const jsonClosing: (cleaned: string, openIndex: number) => number = (cleaned: string, openIndex: number): number => {
    const opener: string = cleaned[openIndex];
    const closer: string = opener === "{" ? "}" : "]";
    let depth: number = 0;
    let inString: boolean = false;
    for (let index: number = openIndex; index < cleaned.length; index += 1) {
        const character: string = cleaned[index];
        if (inString) {
            if (character === "\\") {
                index += 1;
                continue;
            }
            if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '"') {
            inString = true;
            continue;
        }
        if (character === opener) {
            depth += 1;
            continue;
        }
        if (character === closer) {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
};

/**
 * Locate the object/array value of one key. This is section-scoped, so a
 * dependency name that also appears in another group still gets the line of the
 * group it belongs to, regardless of key order in the file.
 */
const findJsonSpan: (text: string, starts: readonly number[], cleaned: string, key: string, fromOffset: number) => JsonSpan | undefined = (
    text: string, starts: readonly number[], cleaned: string, key: string, fromOffset: number,
): JsonSpan | undefined => {
    const literal: string = JSON.stringify(key);
    let offset: number = fromOffset;
    while (offset < text.length) {
        const index: number = text.indexOf(literal, offset);
        if (index === -1) {
            return undefined;
        }
        const openIndex: number = jsonValueOpen(cleaned, index + literal.length);
        if (openIndex !== -1) {
            const closeIndex: number = jsonClosing(cleaned, openIndex);
            if (closeIndex !== -1) {
                return { startLine: lineAtOffset(starts, index), openIndex, closeIndex };
            }
        }
        offset = index + literal.length;
    }
    return undefined;
};

/**
 * Line of a key (or quoted item) strictly inside one JSON span, or `-1`.
 */
const jsonLineWithin: (starts: readonly number[], text: string, key: string, span: JsonSpan) => number = (
    starts: readonly number[], text: string, key: string, span: JsonSpan,
): number => {
    const index: number = text.indexOf(JSON.stringify(key), span.openIndex + 1);
    if (index === -1 || index >= span.closeIndex) {
        return -1;
    }
    return lineAtOffset(starts, index);
};

/**
 * Parse an npm `package.json`.
 *
 * The package node carries `name@version`; scripts, workspaces and the four
 * dependency groups become children with their versions in `detail`. Invalid
 * JSON falls back to the indentation key scan instead of failing the tool.
 *
 * @param input - Decoded `package.json` text.
 * @returns Package/script/workspace/dependency tree.
 */
export const parseNpm: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    const parsed: JsonDocument = parseJsonDocument(input.text);
    const record: Record<string, unknown> | undefined = parsed.ok && isRecord(parsed.value) ? parsed.value : undefined;
    if (record === (void 0)) {
        return [
            outlineNode({
                label: "package.json",
                kind: "package",
                startLine: 1,
                endLine: source.totalLines,
                depth: 0,
                children: jsonFallbackNodes(source).map((node: OutlineNode): OutlineNode => ({ ...node, depth: 1 })),
            }),
        ];
    }
    const locator: JsonLocator = { text: input.text, starts: source.starts, offset: 0 };
    const cleaned: string = stripJsonComments(input.text);
    const name: string = typeof(record.name) === "string" ? record.name : "package.json";
    const version: string = typeof(record.version) === "string" ? record.version : "";
    const startLine: number = typeof(record.name) === "string" ? locateJson(locator, "name") : 1;
    const children: OutlineNode[] = [];
    if (isRecord(record.scripts)) {
        const scripts: Record<string, unknown> = record.scripts;
        const scriptsSpan: JsonSpan | undefined = findJsonSpan(input.text, source.starts, cleaned, "scripts", 0);
        const scriptKeys: string[] = Object.keys(scripts);
        for (let keyIndex: number = 0; keyIndex < scriptKeys.length; keyIndex += 1) {
            const key: string = scriptKeys[keyIndex];
            const inside: number = scriptsSpan === (void 0) ? -1 : jsonLineWithin(source.starts, input.text, key, scriptsSpan);
            const scriptLine: number = inside === -1 ? locateJson(locator, key) : inside;
            const scriptValue: unknown = scripts[key];
            children.push(
                outlineNode({
                    label: key,
                    kind: "script",
                    startLine: scriptLine,
                    endLine: scriptLine,
                    depth: 1,
                    detail: typeof(scriptValue) === "string" ? `${scriptValue}` : "",
                }),
            );
        }
    }
    const workspaces: unknown = record.workspaces;
    const workspaceItems: readonly unknown[] = Array.isArray(workspaces)
        ? workspaces
        : isRecord(workspaces) && Array.isArray(workspaces.packages)
          ? workspaces.packages
          : [];
    const workspacesSpan: JsonSpan | undefined = findJsonSpan(input.text, source.starts, cleaned, "workspaces", 0);
    for (let index: number = 0; index < workspaceItems.length; index += 1) {
        const item: unknown = workspaceItems[index];
        if (typeof(item) !== "string") {
            continue;
        }
        const inside: number = workspacesSpan === (void 0) ? -1 : jsonLineWithin(source.starts, input.text, item, workspacesSpan);
        const workspaceLine: number = inside === -1 ? locateJson(locator, item) : inside;
        children.push(
            outlineNode({
                label: item,
                kind: "workspace",
                startLine: workspaceLine,
                endLine: workspaceLine,
                depth: 1,
                detail: "workspace",
            }),
        );
    }
    const groups: readonly string[] = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    for (let groupIndex: number = 0; groupIndex < groups.length; groupIndex += 1) {
        const groupName: string = groups[groupIndex];
        const group: unknown = record[groupName];
        if (!isRecord(group)) {
            continue;
        }
        const groupSpan: JsonSpan | undefined = findJsonSpan(input.text, source.starts, cleaned, groupName, 0);
        const dependencyKeys: string[] = Object.keys(group);
        for (let keyIndex: number = 0; keyIndex < dependencyKeys.length; keyIndex += 1) {
            const key: string = dependencyKeys[keyIndex];
            const value: unknown = group[key];
            const inside: number = groupSpan === (void 0) ? -1 : jsonLineWithin(source.starts, input.text, key, groupSpan);
            const dependencyLine: number = inside === -1 ? locateJson(locator, key) : inside;
            children.push(
                outlineNode({
                    label: key,
                    kind: "dependency",
                    startLine: dependencyLine,
                    endLine: dependencyLine,
                    depth: 1,
                    detail: typeof(value) === "string" ? value : groupName,
                }),
            );
        }
    }
    return [
        outlineNode({
            label: name,
            kind: "package",
            startLine,
            endLine: source.totalLines,
            depth: 0,
            detail: npmCoordinate(name, version),
            children: sortNodesByLine(children),
        }),
    ];
};

/**
 * Convert one XML element subtree into outline symbols.
 */
const xmlOutlineNodes: (element: XmlElement, depth: number, opml: boolean) => OutlineNode = (element: XmlElement, depth: number, opml: boolean): OutlineNode => {
    const explicitText: string | undefined = element.attributes.get("text");
    const titleText: string | undefined = element.attributes.get("title");
    const textAttribute: string | undefined = explicitText !== (void 0) && explicitText.length > 0 ? explicitText : titleText;
    const label: string = opml && textAttribute !== (void 0) && textAttribute.length > 0 ? textAttribute : localXmlName(element.name);
    const id: string | undefined = element.attributes.get("id") ?? element.attributes.get("name");
    return outlineNode({
        label,
        kind: opml ? "heading" : "key",
        startLine: element.startLine,
        endLine: element.endLine,
        depth,
        ...(id === (void 0) || id.length === 0 ? {} : { detail: `${localXmlName(element.name)}:${id}` }),
        children: element.children.map((child: XmlElement): OutlineNode => xmlOutlineNodes(child, depth + 1, opml)),
    });
};

/**
 * One HTML start or end tag found by the bounded scanner.
 */
interface HtmlTag {
    readonly name: string;
    readonly closing: boolean;
    readonly selfClosing: boolean;
    readonly attributes: ReadonlyMap<string, string>;
    readonly start: number;
    readonly end: number;
}

/**
 * Result of one bounded tag scan. `truncated` is true when a further tag exists
 * past the 20000-tag budget, so the caller can surface the loss.
 */
interface HtmlScan {
    readonly tags: readonly HtmlTag[];
    readonly truncated: boolean;
}

/**
 * Elements whose content is raw text, not markup. A `<h1>` inside a script, a
 * style block or a textarea is character data, not a heading.
 */
const HtmlRawTextElements: ReadonlySet<string> = new Set<string>(["script", "style", "textarea"]);

/**
 * Common HTML named entities beyond the five predefined XML ones. The table is
 * deliberately a small, bounded subset: unknown names stay verbatim instead of
 * pretending the scanner implements the full HTML5 entity set.
 */
const HtmlNamedEntities: ReadonlyMap<string, string> = new Map<string, string>([
    ["nbsp", "\u00a0"],
    ["ensp", "\u2002"],
    ["emsp", "\u2003"],
    ["thinsp", "\u2009"],
    ["mdash", "\u2014"],
    ["ndash", "\u2013"],
    ["hellip", "\u2026"],
    ["copy", "\u00a9"],
    ["reg", "\u00ae"],
    ["trade", "\u2122"],
    ["laquo", "\u00ab"],
    ["raquo", "\u00bb"],
    ["lsquo", "\u2018"],
    ["rsquo", "\u2019"],
    ["ldquo", "\u201c"],
    ["rdquo", "\u201d"],
    ["times", "\u00d7"],
    ["divide", "\u00f7"],
    ["deg", "\u00b0"],
    ["plusmn", "\u00b1"],
    ["micro", "\u00b5"],
    ["para", "\u00b6"],
    ["sect", "\u00a7"],
    ["middot", "\u00b7"],
    ["bull", "\u2022"],
    ["dagger", "\u2020"],
    ["permil", "\u2030"],
    ["euro", "\u20ac"],
    ["pound", "\u00a3"],
    ["yen", "\u00a5"],
    ["cent", "\u00a2"],
    ["larr", "\u2190"],
    ["rarr", "\u2192"],
    ["uarr", "\u2191"],
    ["darr", "\u2193"],
    ["harr", "\u2194"],
    ["ne", "\u2260"],
    ["le", "\u2264"],
    ["ge", "\u2265"],
    ["asymp", "\u2248"],
    ["infin", "\u221e"],
]);

/**
 * Elements that may become a `section` node when they carry an id or label.
 */
const HtmlSectionElements: ReadonlySet<string> = new Set<string>(["section", "article", "nav", "main"]);

/**
 * Heading element name with its level.
 */
const HtmlHeading: RegExp = /^h([1-6])$/;

/**
 * Attribute pattern shared by the HTML scanner.
 */
const HtmlAttribute: RegExp = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/**
 * Scan HTML tags with comment, DOCTYPE, raw-text and quoted-attribute
 * awareness.
 *
 * The scanner is bounded and does not build a DOM: the caller receives tags,
 * attributes and offsets. Comment bodies, DOCTYPE declarations, CDATA sections,
 * processing instructions and the whole content of `<script>`/`<style>` are
 * skipped, so a pseudo-tag in a comment or a JavaScript string is never
 * structure. A malformed document yields the tags that could be read instead of
 * throwing.
 *
 * @param text - Decoded HTML text.
 * @returns Tags in source order plus whether the 20000-tag budget cut the scan.
 */
const scanHtmlTags: (text: string) => HtmlScan = (text: string): HtmlScan => {
    const tags: HtmlTag[] = [];
    let truncated: boolean = false;
    let index: number = 0;
    while (index < text.length) {
        const open: number = text.indexOf("<", index);
        if (open === -1) {
            break;
        }
        if (text.startsWith("<!--", open)) {
            const end: number = text.indexOf("-->", open + 4);
            index = end === -1 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith("<![CDATA[", open)) {
            const end: number = text.indexOf("]]>", open + 9);
            index = end === -1 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith("<!", open) || text.startsWith("<?", open)) {
            const end: number = text.indexOf(">", open + 2);
            index = end === -1 ? text.length : end + 1;
            continue;
        }
        const head: RegExpExecArray | null = /^<(\/?)([A-Za-z][\w:-]*)/.exec(text.slice(open, open + 64));
        if (head === null) {
            index = open + 1;
            continue;
        }
        const closing: boolean = head[1] === "/";
        const name: string = head[2].toLowerCase();
        let cursor: number = open + head[0].length;
        let quote: string = "";
        while (cursor < text.length) {
            const character: string = text[cursor];
            if (quote.length > 0) {
                if (character === quote) {
                    quote = "";
                }
                cursor += 1;
                continue;
            }
            if (character === '"' || character === "'") {
                quote = character;
                cursor += 1;
                continue;
            }
            if (character === ">") {
                break;
            }
            cursor += 1;
        }
        if (cursor >= text.length) {
            break;
        }
        const body: string = text.slice(open + head[0].length, cursor);
        const selfClosing: boolean = !closing && body.trimEnd().endsWith("/");
        const attributes: Map<string, string> = new Map<string, string>();
        HtmlAttribute.lastIndex = 0;
        let attribute: RegExpExecArray | null = HtmlAttribute.exec(body);
        while (attribute !== null) {
            attributes.set(
                attribute[1].toLowerCase(),
                decodeXmlEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "", HtmlNamedEntities),
            );
            attribute = HtmlAttribute.exec(body);
        }
        if (tags.length >= 20000) {
            truncated = true;
            break;
        }
        tags.push({ name, closing, selfClosing, attributes, start: open, end: cursor + 1 });
        index = cursor + 1;
        if (!closing && !selfClosing && HtmlRawTextElements.has(name)) {
            const closer: RegExp = new RegExp(`</\\s*${name}\\s*>`, "i");
            const found: RegExpExecArray | null = closer.exec(text.slice(index));
            index = found === null ? text.length : index + found.index + found[0].length;
        }
    }
    return { tags, truncated };
};

/**
 * Turn the raw inner HTML of one element into a readable label: nested tags are
 * dropped, entities are decoded and whitespace is collapsed.
 *
 * @param value - Raw inner HTML.
 * @returns Clean label, possibly empty.
 */
const htmlLabel: (value: string) => string = (value: string): string =>
    decodeXmlEntities(value.replace(/<[^>]*>/g, " "), HtmlNamedEntities).replace(/\s+/g, " ").trim();

/**
 * Index of the tag that closes the element opened at `from`, or `-1`.
 *
 * Nested elements with the same name are counted, so the outer `<section>`
 * range ends at the outer `</section>` rather than at the inner one. A
 * self-closing start tag opens no nesting level.
 */
const findHtmlClose: (tags: readonly HtmlTag[], from: number, name: string) => number = (tags: readonly HtmlTag[], from: number, name: string): number => {
    let nested: number = 0;
    for (let index: number = from + 1; index < tags.length; index += 1) {
        if (tags[index].name !== name) {
            continue;
        }
        if (tags[index].closing) {
            if (nested === 0) {
                return index;
            }
            nested -= 1;
        } else if (!tags[index].selfClosing) {
            nested += 1;
        }
    }
    return -1;
};

/**
 * Line of the last content offset before an element closes. The label of an
 * unclosed heading may sit on one line or span several, so one character is
 * subtracted from the end offset to stay on the last content line.
 */
type HtmlContentLine = (starts: readonly number[], startOffset: number, endOffset: number) => number;

const htmlContentLine: HtmlContentLine = (starts: readonly number[], startOffset: number, endOffset: number): number =>
    lineAtOffset(starts, Math.max(startOffset, endOffset - 1));

/**
 * End offset used when no closing tag exists. A self-closing element has no
 * content; a truly unclosed one runs to the next structural tag or to EOF, so
 * a missing `</h1>` does not swallow the rest of the document.
 */
const htmlUnclosedEnd: (tags: readonly HtmlTag[], from: number, tag: HtmlTag, textLength: number) => number = (
    tags: readonly HtmlTag[], from: number, tag: HtmlTag, textLength: number,
): number => {
    if (tag.selfClosing) {
        return tag.end;
    }
    for (let index: number = from + 1; index < tags.length; index += 1) {
        if (
            tags[index].closing ||
            tags[index].name === "title" ||
            HtmlHeading.test(tags[index].name) ||
            HtmlSectionElements.has(tags[index].name)
        ) {
            return tags[index].start;
        }
    }
    return textLength;
};

/**
 * One open landmark container while an HTML outline is assembled.
 */
interface HtmlContainerFrame {
    readonly name: string;
    readonly node: DraftOutlineNode | undefined;
    readonly headings: HtmlHeadingFrame[];
}

/**
 * One open heading inside the current container, used to restore the nearest
 * shallower heading as a parent.
 */
interface HtmlHeadingFrame {
    readonly level: number;
    readonly node: DraftOutlineNode;
}

/**
 * Parse an HTML document.
 *
 * The outline is the document heading tree plus labelled landmarks:
 *
 * - `<title>` is a depth-0 `heading` (the document title);
 * - `<h1>`..`<h6>` are `heading` nodes nested by their declared rank inside the
 *   currently open container. A labelled landmark contributes one depth level
 *   and an unlabelled wrapper contributes none, so a wrapper never shifts a
 *   heading's depth, while an `h1` inside a labelled `<main>` is its child;
 * - `<section>`, `<article>`, `<nav>` and `<main>` become `section` nodes when
 *   they carry an `id` or `aria-label`, nested by their container nesting;
 * - comment bodies, DOCTYPE, and the whole content of `<script>`, `<style>` and
 *   `<textarea>` are skipped, and both self-closing (`<img />`) and void
 *   (`<br>`) elements are handled;
 * - the five XML entities, numeric character references (`&#8212;`,
 *   `&#x2014;`) and a bounded common HTML entity table (`&nbsp;`, `&mdash;`,
 *   `&copy;`, ...) are decoded in labels;
 * - the tag scanner stops after 20000 tags and reports the loss through
 *   `markTruncated`, so `OutlineResult.truncated` stays truthful.
 *
 * Sections and headings are attached through explicit container and heading
 * stacks. A skipped heading level stays under the nearest shallower heading,
 * and a heading that follows a closed nested section stays under the outer
 * section instead of being pulled under the closed one.
 *
 * @param input - Decoded HTML text.
 * @returns Heading and section tree.
 */
export const parseHtml: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const scan: HtmlScan = scanHtmlTags(input.text);
    if (scan.truncated) {
        input.markTruncated?.();
    }
    const tags: readonly HtmlTag[] = scan.tags;
    if (tags.length === 0) {
        return [];
    }
    const starts: readonly number[] = source.starts;
    const roots: DraftOutlineNode[] = [];
    const containers: HtmlContainerFrame[] = [];
    const rootHeadings: HtmlHeadingFrame[] = [];
    const emittedContainerCount: () => number = (): number => {
        let count: number = 0;
        for (let frame: number = 0; frame < containers.length; frame += 1) {
            if (containers[frame].node !== (void 0)) {
                count += 1;
            }
        }
        return count;
    };
    const nearestContainer: () => DraftOutlineNode | undefined = (): DraftOutlineNode | undefined => {
        for (let frame: number = containers.length - 1; frame >= 0; frame -= 1) {
            const node: DraftOutlineNode | undefined = containers[frame].node;
            if (node !== (void 0)) {
                return node;
            }
        }
        return undefined;
    };
    const append: (node: DraftOutlineNode, parent: DraftOutlineNode | undefined) => void = (
        node: DraftOutlineNode, parent: DraftOutlineNode | undefined,
    ): void => {
        if (parent === (void 0)) {
            roots.push(node);
        } else {
            parent.children.push(node);
        }
    };
    for (let index: number = 0; index < tags.length; index += 1) {
        const tag: HtmlTag = tags[index];
        if (tag.closing) {
            for (let frame: number = containers.length - 1; frame >= 0; frame -= 1) {
                if (containers[frame].name === tag.name) {
                    containers.length = frame;
                    /**
                     * A closed landmark ends the heading context that preceded
                     * it. Without this, `<h1>…</h1><section><h2>…</h2></section>
                     * <h4>…</h4>` would nest the trailing h4 under the h1 even
                     * though the h4 is outside the section.
                     */
                    if (HtmlSectionElements.has(tag.name)) {
                        rootHeadings.length = 0;
                    }
                    break;
                }
            }
            continue;
        }
        if (tag.name === "title") {
            const close: number = findHtmlClose(tags, index, "title");
            const end: number = close === -1 ? htmlUnclosedEnd(tags, index, tag, input.text.length) : tags[close].start;
            const label: string = htmlLabel(input.text.slice(tag.end, end));
            if (label.length > 0) {
                roots.push({
                    label,
                    kind: "heading",
                    startLine: lineAtOffset(starts, tag.start),
                    endLine: close === -1 ? htmlContentLine(starts, tag.start, end) : lineAtOffset(starts, tags[close].start),
                    depth: 0,
                    children: [],
                });
            }
            if (close !== -1) {
                index = close;
            }
            continue;
        }
        const heading: RegExpExecArray | null = HtmlHeading.exec(tag.name);
        if (heading !== null) {
            const level: number = Number(heading[1]);
            const close: number = findHtmlClose(tags, index, tag.name);
            const end: number = close === -1 ? htmlUnclosedEnd(tags, index, tag, input.text.length) : tags[close].start;
            const label: string = htmlLabel(input.text.slice(tag.end, end));
            if (label.length > 0) {
                const container: HtmlContainerFrame | undefined = containers.length === 0 ? undefined : containers[containers.length - 1];
                const stack: HtmlHeadingFrame[] = container === (void 0) ? rootHeadings : container.headings;
                while (stack.length > 0 && stack[stack.length - 1].level >= level) {
                    stack.pop();
                }
                const parent: DraftOutlineNode | undefined = stack.length > 0 ? stack[stack.length - 1].node : nearestContainer();
                const node: DraftOutlineNode = {
                    label,
                    kind: "heading",
                    startLine: lineAtOffset(starts, tag.start),
                    endLine: close === -1 ? htmlContentLine(starts, tag.start, end) : lineAtOffset(starts, tags[close].start),
                    depth: emittedContainerCount() + level - 1,
                    children: [],
                };
                append(node, parent);
                stack.push({ level, node });
            }
            if (close !== -1) {
                index = close;
            }
            continue;
        }
        if (!HtmlSectionElements.has(tag.name)) {
            continue;
        }
        const label: string = htmlLabel(tag.attributes.get("id") ?? tag.attributes.get("aria-label") ?? "");
        const emitted: boolean = label.length > 0 && !tag.selfClosing;
        let sectionNode: DraftOutlineNode | undefined;
        if (emitted) {
            const close: number = findHtmlClose(tags, index, tag.name);
            const node: DraftOutlineNode = {
                label,
                kind: "section",
                startLine: lineAtOffset(starts, tag.start),
                endLine: close === -1 ? source.totalLines : lineAtOffset(starts, tags[close].start),
                depth: emittedContainerCount(),
                detail: tag.name,
                children: [],
            };
            sectionNode = node;
            append(node, nearestContainer());
        }
        if (!tag.selfClosing) {
            containers.push({ name: tag.name, node: sectionNode, headings: [] });
        }
    }
    return roots.map(draftToNode);
};

/**
 * One top-level block of a Vue single-file component.
 */
interface VueBlock {
    readonly tag: "template" | "script" | "style";
    readonly label: string;
    readonly modifiers: readonly string[];
    readonly startOffset: number;
    readonly endOffset: number;
    readonly innerStart: number;
    readonly innerEnd: number;
}

/**
 * Shift a parsed subtree by a line offset and a depth offset. Used when a Vue
 * block is parsed as if it were a standalone file.
 */
const shiftOutlineNodes: (nodes: readonly OutlineNode[], lineOffset: number, depthOffset: number) => OutlineNode[] = (
    nodes: readonly OutlineNode[], lineOffset: number, depthOffset: number,
): OutlineNode[] =>
    nodes.map((node: OutlineNode): OutlineNode => ({
        ...node,
        depth: node.depth + depthOffset,
        range: {
            ...node.range,
            startLine: node.range.startLine + BigInt(lineOffset),
            endLine: node.range.endLine + BigInt(lineOffset),
        },
        children: shiftOutlineNodes(node.children, lineOffset, depthOffset),
    }));

const byteOffsetOf: (text: string, offset: number) => bigint = (text: string, offset: number): bigint =>
    BigInt(Buffer.byteLength(text.slice(0, offset), "utf8"));

/**
 * One block start tag found at the top level of an SFC.
 */
interface VueOpenTag {
    readonly tag: "template" | "script" | "style";
    readonly attributes: string;
    readonly endOffset: number;
}

/**
 * One block close tag with the offsets needed to cut the block out.
 */
interface VueCloseTag {
    readonly closeStart: number;
    readonly endOffset: number;
}

/**
 * One parsed Vue attribute; a bare attribute has an empty value.
 */
interface VueAttribute {
    readonly name: string;
    readonly value: string;
}

/**
 * A block tag name followed by whitespace, `/` or `>`.
 */
const VueOpenTagPattern: RegExp = /^<(template|script|style)(?=[\s/>])/i;

/**
 * Mask options for script content: strings, template literals and comments are
 * blanked, so a literal `</script>` inside them cannot close the block.
 */
const VueScriptMask: MaskOptions = {
    lineComments: ["//"],
    blockComments: true,
    strings: true,
    template: true,
    tripleQuotes: false,
    regex: true,
};

/**
 * Mask options for style content: CSS comments and strings are blanked, so a
 * literal `</style>` inside them cannot close the block.
 */
const VueStyleMask: MaskOptions = {
    lineComments: ["//"],
    blockComments: true,
    strings: true,
    template: false,
    tripleQuotes: false,
    regex: false,
};

/**
 * Scan one block start tag at `open`, honoring quoted attribute values so a
 * `>` inside `data-x="a>b"` does not end the tag early.
 */
const vueOpenTagAt: (text: string, open: number) => VueOpenTag | undefined = (text: string, open: number): VueOpenTag | undefined => {
    const head: RegExpExecArray | null = VueOpenTagPattern.exec(text.slice(open, open + 16));
    if (head === null) {
        return undefined;
    }
    const start: number = open + head[0].length;
    let cursor: number = start;
    let quote: string = "";
    while (cursor < text.length) {
        const character: string = text[cursor];
        if (quote.length > 0) {
            if (character === quote) {
                quote = "";
            }
            cursor += 1;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            cursor += 1;
            continue;
        }
        if (character === ">") {
            break;
        }
        cursor += 1;
    }
    if (cursor >= text.length) {
        return undefined;
    }
    return {
        tag: head[1].toLowerCase() as "template" | "script" | "style",
        attributes: text.slice(start, cursor),
        endOffset: cursor + 1,
    };
};

/**
 * Close of a `<template>` block. Nested `<template v-if>` elements are legal, so
 * the block close is found by tag depth; comments and raw-text elements are
 * skipped by the HTML scanner. A malformed block falls back to the first literal
 * close tag instead of dropping the rest of the file.
 */
const vueTemplateClose: (text: string, innerStart: number) => VueCloseTag | undefined = (
    text: string, innerStart: number,
): VueCloseTag | undefined => {
    const tags: readonly HtmlTag[] = scanHtmlTags(text.slice(innerStart)).tags;
    let depth: number = 0;
    for (let index: number = 0; index < tags.length; index += 1) {
        const tag: HtmlTag = tags[index];
        if (tag.name !== "template") {
            continue;
        }
        if (tag.closing) {
            depth -= 1;
            if (depth < 0) {
                return { closeStart: innerStart + tag.start, endOffset: innerStart + tag.end };
            }
            continue;
        }
        if (!tag.selfClosing) {
            depth += 1;
        }
    }
    const fallback: number = text.toLowerCase().indexOf("</template>", innerStart);
    return fallback === -1 ? undefined : { closeStart: fallback, endOffset: fallback + 11 };
};

/**
 * Close of a `<script>`/`<style>` block: the first matching tag in masked
 * content, with a raw-text fallback for an unterminated string or comment.
 */
const vueContentClose: (text: string, tag: "script" | "style", innerStart: number) => VueCloseTag | undefined = (
    text: string, tag: "script" | "style", innerStart: number,
): VueCloseTag | undefined => {
    const inner: string = text.slice(innerStart);
    const masked: string = maskSource(inner, tag === "script" ? VueScriptMask : VueStyleMask);
    const closer: string = `</${tag}>`;
    let relative: number = masked.toLowerCase().indexOf(closer);
    if (relative === -1) {
        const raw: number = text.toLowerCase().indexOf(closer, innerStart);
        if (raw === -1) {
            return undefined;
        }
        relative = raw - innerStart;
    }
    const closeStart: number = innerStart + relative;
    return { closeStart, endOffset: closeStart + closer.length };
};

/**
 * Split an attribute string into names and unquoted values.
 */
const vueAttributes: (attributes: string) => VueAttribute[] = (attributes: string): VueAttribute[] => {
    const parsed: VueAttribute[] = [];
    let index: number = 0;
    while (index < attributes.length) {
        while (index < attributes.length && /\s/.test(attributes[index])) {
            index += 1;
        }
        if (index >= attributes.length) {
            break;
        }
        if (attributes[index] === "/") {
            index += 1;
            continue;
        }
        const nameStart: number = index;
        while (index < attributes.length && !/[\s=/>]/.test(attributes[index])) {
            index += 1;
        }
        const name: string = attributes.slice(nameStart, index).toLowerCase();
        while (index < attributes.length && /\s/.test(attributes[index])) {
            index += 1;
        }
        let value: string = "";
        if (attributes[index] === "=") {
            index += 1;
            while (index < attributes.length && /\s/.test(attributes[index])) {
                index += 1;
            }
            const quote: string = attributes[index] ?? "";
            if (quote === '"' || quote === "'") {
                index += 1;
                const valueStart: number = index;
                while (index < attributes.length && attributes[index] !== quote) {
                    index += 1;
                }
                value = attributes.slice(valueStart, index);
                if (index < attributes.length) {
                    index += 1;
                }
            } else {
                const valueStart: number = index;
                while (index < attributes.length && !/[\s>]/.test(attributes[index])) {
                    index += 1;
                }
                value = attributes.slice(valueStart, index);
            }
        }
        if (name.length > 0) {
            parsed.push({ name, value });
        }
    }
    return parsed;
};

/**
 * Modifiers for one block label, in canonical `setup, lang, scoped` order. A
 * quoted attribute value never contributes because names and values are parsed
 * separately.
 */
const vueBlockModifiers: (attributes: string) => string[] = (attributes: string): string[] => {
    const parsed: VueAttribute[] = vueAttributes(attributes);
    let setup: boolean = false;
    let scoped: boolean = false;
    let lang: string = "";
    for (let index: number = 0; index < parsed.length; index += 1) {
        const attribute: VueAttribute = parsed[index];
        if (attribute.name === "setup") {
            setup = true;
        } else if (attribute.name === "scoped") {
            scoped = true;
        } else if (attribute.name === "lang" && attribute.value.length > 0) {
            lang = attribute.value;
        }
    }
    const modifiers: string[] = [];
    if (setup) {
        modifiers.push("setup");
    }
    if (lang.length > 0) {
        modifiers.push(lang);
    }
    if (scoped) {
        modifiers.push("scoped");
    }
    return modifiers;
};

/**
 * Scan the top-level `<template>`, `<script>` and `<style>` blocks of an SFC.
 *
 * SFC-level comments and declarations are skipped, so a commented-out block
 * never reaches the outline. A block without a closing tag is ignored and
 * scanning resumes after its start tag.
 *
 * @param text - Decoded Vue text.
 * @returns Blocks in source order.
 */
const vueBlocks: (text: string) => VueBlock[] = (text: string): VueBlock[] => {
    const blocks: VueBlock[] = [];
    let cursor: number = 0;
    while (cursor < text.length) {
        const open: number = text.indexOf("<", cursor);
        if (open === -1) {
            break;
        }
        if (text.startsWith("<!--", open)) {
            const commentEnd: number = text.indexOf("-->", open + 4);
            cursor = commentEnd === -1 ? text.length : commentEnd + 3;
            continue;
        }
        if (text.startsWith("<!", open) || text.startsWith("<?", open)) {
            const declarationEnd: number = text.indexOf(">", open + 2);
            cursor = declarationEnd === -1 ? text.length : declarationEnd + 1;
            continue;
        }
        const tag: VueOpenTag | undefined = vueOpenTagAt(text, open);
        if (tag === (void 0)) {
            cursor = open + 1;
            continue;
        }
        if (tag.attributes.trimEnd().endsWith("/")) {
            cursor = tag.endOffset;
            continue;
        }
        const close: VueCloseTag | undefined =
            tag.tag === "template" ? vueTemplateClose(text, tag.endOffset) : vueContentClose(text, tag.tag, tag.endOffset);
        if (close === (void 0)) {
            cursor = tag.endOffset;
            continue;
        }
        const modifiers: string[] = vueBlockModifiers(tag.attributes);
        blocks.push({
            tag: tag.tag,
            label: modifiers.length === 0 ? tag.tag : `${tag.tag} (${modifiers.join(", ")})`,
            modifiers,
            startOffset: open,
            endOffset: close.endOffset,
            innerStart: tag.endOffset,
            innerEnd: close.closeStart,
        });
        cursor = close.endOffset;
    }
    return blocks;
};

/**
 * Outline kind for one top-level declaration keyword.
 */
const vueDeclarationKind: (keyword: string) => OutlineKind = (keyword: string): OutlineKind => {
    if (keyword === "class") {
        return "class";
    }
    if (keyword === "function") {
        return "function";
    }
    if (keyword === "const") {
        return "constant";
    }
    return "variable";
};

/**
 * Top-level declaration: line start, optional `export`/`async` prefix, keyword
 * and an identifier. Unicode identifiers are accepted.
 */
const VueDeclaration: RegExp = /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?(function|const|let|var|class)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu;

/**
 * Component name option, for example `name: "MyWidget"`.
 */
const VueComponentName: RegExp = /\bname\s*:\s*["']([^"']+)["']/g;

/**
 * Brace depth at one offset of a masked source. `depthAtLine` gives the depth at
 * the line start and the characters before the offset are replayed, so a
 * declaration after `if (x) {` on the same line is not treated as top-level.
 */
const vueDepthAtOffset: (source: MaskedSource, line: number, offset: number) => number = (
    source: MaskedSource, line: number, offset: number,
): number => {
    let depth: number = depthAtLine(source, line);
    const start: number = source.starts[Math.max(0, line - 1)] ?? 0;
    for (let index: number = start; index < offset; index += 1) {
        const character: string = source.masked[index];
        if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth -= 1;
        }
    }
    return depth;
};

/**
 * Last line of a declaration: the matching close brace of its body, or the
 * semicolon that ends it.
 */
const vueDeclarationEnd: (source: MaskedSource, baseLine: number, offset: number, fallbackLine: number) => number = (
    source: MaskedSource, baseLine: number, offset: number, fallbackLine: number,
): number => {
    for (let index: number = offset; index < source.masked.length; index += 1) {
        const character: string = source.masked[index];
        if (character === "{") {
            const close: number | undefined = source.close.get(index);
            return close === (void 0) ? fallbackLine : baseLine + lineAtOffset(source.starts, close) - 1;
        }
        if (character === ";" || character === "}") {
            return baseLine + lineAtOffset(source.starts, index) - 1;
        }
    }
    return fallbackLine;
};

/**
 * Symbols inside one `<script>` block: the component `name` option and the
 * top-level declarations. `baseLine` is the file line of the first inner line.
 *
 * Strings and comments are masked before scanning, nested declarations are
 * excluded by brace depth, and a declaration range covers its whole body.
 */
const vueScriptNodes: (text: string, baseLine: number) => OutlineNode[] = (text: string, baseLine: number): OutlineNode[] => {
    const nodes: OutlineNode[] = [];
    if (text.length === 0) {
        return nodes;
    }
    const source: SourceLines = readSourceLines(text);
    const masked: string = maskSource(text, VueScriptMask);
    const braced: MaskedSource = scanBraces(source, masked);
    VueComponentName.lastIndex = 0;
    let name: RegExpExecArray | null;
    while ((name = VueComponentName.exec(text)) !== null) {
        if (masked.slice(name.index, name.index + 4) !== "name") {
            continue;
        }
        const line: number = baseLine + lineAtOffset(source.starts, name.index) - 1;
        nodes.push(outlineNode({ label: name[1], kind: "class", startLine: line, endLine: line, depth: 0, detail: "component name" }));
        break;
    }
    VueDeclaration.lastIndex = 0;
    let declaration: RegExpExecArray | null;
    while ((declaration = VueDeclaration.exec(masked)) !== null) {
        const keyword: string = declaration[1];
        const label: string = declaration[2];
        const offset: number = declaration.index + declaration[0].length - label.length;
        const innerLine: number = lineAtOffset(source.starts, offset);
        if (vueDepthAtOffset(braced, innerLine, offset) !== 0) {
            continue;
        }
        const line: number = baseLine + innerLine - 1;
        const endLine: number = vueDeclarationEnd(braced, baseLine, offset, line);
        nodes.push(
            outlineNode({
                label,
                kind: vueDeclarationKind(keyword),
                startLine: line,
                endLine,
                depth: 0,
                detail: "script declaration",
            }),
        );
    }
    return nodes;
};

/**
 * Parse a Vue single-file component.
 *
 * Top-level `<template>`, `<script>` and `<style>` blocks become `section`
 * nodes. Template headings/sections are parsed with the HTML strategy, script
 * component names and top-level declarations become symbols, and style rules are
 * parsed with the CSS strategy (the Sass indented syntax is used for
 * `lang="sass"`). The blocks keep their line offsets so a caller can jump from
 * the outline to the SFC source.
 *
 * @param input - Decoded Vue text.
 * @returns Block/section tree.
 */
export const parseVue: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const blocks: VueBlock[] = vueBlocks(input.text);
    const nodes: OutlineNode[] = [];
    for (let index: number = 0; index < blocks.length; index += 1) {
        const block: VueBlock = blocks[index];
        const startLine: number = lineAtOffset(source.starts, block.startOffset);
        const endLine: number = lineAtOffset(source.starts, block.endOffset);
        const innerStartLine: number = lineAtOffset(source.starts, block.innerStart);
        const inner: string = input.text.slice(block.innerStart, block.innerEnd);
        const lineIndex: LineIndex = new LineIndex(inner);
        let children: OutlineNode[] = [];
        if (block.tag === "template") {
            children = shiftOutlineNodes(parseHtml({ path: input.path, text: inner, lineIndex }), innerStartLine - 1, 1);
        } else if (block.tag === "script") {
            children = vueScriptNodes(inner, innerStartLine).map((node: OutlineNode): OutlineNode => ({ ...node, depth: 1 }));
        } else if (block.modifiers.some((modifier: string): boolean => modifier.toLowerCase() === "sass")) {
            children = shiftOutlineNodes(parseSass({ path: input.path, text: inner, lineIndex }), innerStartLine - 1, 1);
        } else {
            children = shiftOutlineNodes(parseCss({ path: input.path, text: inner, lineIndex }), innerStartLine - 1, 1);
        }
        nodes.push({
            isFile: false,
            isDirectory: false,
            path: "",
            type: "section",
            range: {
                startByte: byteOffsetOf(input.text, block.startOffset),
                endByte: byteOffsetOf(input.text, block.endOffset),
                startLine: BigInt(startLine),
                endLine: BigInt(endLine),
            },
            label: block.label,
            depth: 0,
            ...(block.modifiers.length === 0 ? {} : { modifiers: [...block.modifiers] }),
            detail: block.tag,
            children,
        });
    }
    return nodes;
};

/**
 * Parse a generic XML document (including CSProj and configuration files).
 *
 * Every element becomes a `key` node labeled with its local tag name; an
 * `id`/`name` attribute goes to `detail`. Comments, processing instructions
 * and CDATA are skipped by the scanner.
 *
 * @param input - Decoded XML text.
 * @returns Element tree.
 */
export const parseXml: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    return parseXmlDocument(input.text, source.starts).map((element: XmlElement): OutlineNode => xmlOutlineNodes(element, 0, false));
};

/**
 * Parse an OPML outline.
 *
 * `<outline text="...">` entries become `heading` nodes nested exactly as in
 * the source, which is what an OPML reader renders.
 *
 * @param input - Decoded OPML text.
 * @returns Heading tree.
 */
export const parseOpml: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    return parseXmlDocument(input.text, source.starts).map((element: XmlElement): OutlineNode => xmlOutlineNodes(element, 0, true));
};

/**
 * Last path segment without importing a path helper.
 */
const baseNameOf: (path: string) => string = (path: string): string => {
    const slash: number = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
};

/**
 * Lowercase extension including the dot, or an empty string.
 */
const extensionOfName: (name: string) => string = (name: string): string => {
    const dot: number = name.lastIndexOf(".");
    return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot).toLowerCase();
};

/**
 * Whether a base name has one of the given extensions.
 */
const hasExtension: (name: string, extensions: readonly string[]) => boolean = (name: string, extensions: readonly string[]): boolean => {
    const extension: string = extensionOfName(name);
    return extensions.includes(extension);
};

/**
 * Case-insensitive exact-name match.
 */
const isNamed: (name: string, names: readonly string[]) => boolean = (name: string, names: readonly string[]): boolean => {
    const lower: string = name.toLowerCase();
    return names.some((candidate: string): boolean => candidate.toLowerCase() === lower);
};

/**
 * Whether a file looks like XML.
 */
const looksLikeXml: (head: string) => boolean = (head: string): boolean => /^\s*(?:<\?xml|<!--|<!doctype|<[A-Za-z_:][\w:.-]*[\s/>])/i.test(head);

const TypeScriptStrategy: OutlineStrategy = {
    id: "typescript",
    category: "code",
    language: "typescript",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".ts", ".tsx", ".mts", ".cts"]),
    parse: parseTypeScript,
};

const JavaScriptStrategy: OutlineStrategy = {
    id: "javascript",
    category: "code",
    language: "javascript",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".js", ".jsx", ".mjs", ".cjs"]),
    parse: parseTypeScript,
};

const PythonStrategy: OutlineStrategy = {
    id: "python",
    category: "code",
    language: "python",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".py", ".pyw", ".pyi"]),
    parse: parsePython,
};

const JavaStrategy: OutlineStrategy = {
    id: "java",
    category: "code",
    language: "java",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".java"]),
    parse: parseJava,
};

const CSharpStrategy: OutlineStrategy = {
    id: "csharp",
    category: "code",
    language: "csharp",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".cs"]),
    parse: parseCSharp,
};

const CStrategy: OutlineStrategy = {
    id: "c",
    category: "code",
    language: "c",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".c", ".h"]),
    parse: parseCFamily,
};

const CppStrategy: OutlineStrategy = {
    id: "cpp",
    category: "code",
    language: "cpp",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".ipp", ".tpp", ".inl"]),
    parse: parseCFamily,
};

const GoStrategy: OutlineStrategy = {
    id: "go",
    category: "code",
    language: "go",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".go"]),
    parse: parseGo,
};

const RustStrategy: OutlineStrategy = {
    id: "rust",
    category: "code",
    language: "rust",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".rs"]),
    parse: parseRust,
};

const MarkdownStrategy: OutlineStrategy = {
    id: "markdown",
    category: "prose",
    language: "markdown",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".md", ".mdx", ".markdown"]),
    parse: parseMarkdown,
};

const TexStrategy: OutlineStrategy = {
    id: "tex",
    category: "prose",
    language: "tex",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".tex", ".ltx", ".sty", ".cls"]),
    parse: parseTex,
};

const PlainTextStrategy: OutlineStrategy = {
    id: "plainText",
    category: "prose",
    matches: (input: OutlineMatchInput): boolean =>
        hasExtension(input.name, [".txt", ".text", ".log"]) || extensionOfName(input.name).length === 0,
    parse: parsePlainText,
};

const CssStrategy: OutlineStrategy = {
    id: "css",
    category: "code",
    language: "css",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".css"]),
    parse: parseCss,
};

const ScssStrategy: OutlineStrategy = {
    id: "scss",
    category: "code",
    language: "scss",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".scss", ".sass", ".less"]),
    parse: parseScss,
};

const JsonStrategy: OutlineStrategy = {
    id: "json",
    category: "data",
    language: "json",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".json", ".jsonc"]),
    parse: parseJson,
};

const HtmlStrategy: OutlineStrategy = {
    id: "html",
    category: "code",
    language: "html",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".html", ".htm"]),
    parse: parseHtml,
};

const VueStrategy: OutlineStrategy = {
    id: "vue",
    category: "code",
    language: "vue",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".vue"]),
    parse: parseVue,
};

const XmlStrategy: OutlineStrategy = {
    id: "xml",
    category: "data",
    language: "xml",
    matches: (input: OutlineMatchInput): boolean =>
        hasExtension(input.name, [".xml", ".xsd", ".xslt", ".xsl", ".svg", ".csproj", ".fsproj", ".vbproj", ".props", ".targets"]) ||
        looksLikeXml(input.head),
    parse: parseXml,
};

const OpmlStrategy: OutlineStrategy = {
    id: "opml",
    category: "prose",
    language: "opml",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, [".opml"]),
    parse: parseOpml,
};

const NpmStrategy: OutlineStrategy = {
    id: "npm",
    category: "project",
    language: "json",
    matches: (input: OutlineMatchInput): boolean => isNamed(input.name, ["package.json"]),
    parse: parseNpm,
};

const MavenStrategy: OutlineStrategy = {
    id: "maven",
    category: "project",
    language: "xml",
    matches: (input: OutlineMatchInput): boolean => isNamed(input.name, ["pom.xml"]),
    parse: parseMaven,
};

const GradleStrategy: OutlineStrategy = {
    id: "gradle",
    category: "project",
    language: "groovy",
    matches: (input: OutlineMatchInput): boolean => /^(?:build|settings|init)\.gradle(?:\.kts)?$/i.test(input.name),
    parse: parseGradle,
};

const CmakeStrategy: OutlineStrategy = {
    id: "cmake",
    category: "project",
    language: "cmake",
    matches: (input: OutlineMatchInput): boolean => isNamed(input.name, ["CMakeLists.txt"]) || hasExtension(input.name, [".cmake"]),
    parse: parseCmake,
};

const CargoStrategy: OutlineStrategy = {
    id: "cargo",
    category: "project",
    language: "toml",
    matches: (input: OutlineMatchInput): boolean => isNamed(input.name, ["Cargo.toml"]),
    parse: parseCargo,
};

const GoModStrategy: OutlineStrategy = {
    id: "gomod",
    category: "project",
    language: "gomod",
    matches: (input: OutlineMatchInput): boolean => isNamed(input.name, ["go.mod"]),
    parse: parseGoMod,
};

const PyprojectStrategy: OutlineStrategy = {
    id: "pyproject",
    category: "project",
    language: "toml",
    matches: (input: OutlineMatchInput): boolean => isNamed(input.name, ["pyproject.toml"]),
    parse: parsePyproject,
};

const MakefileStrategy: OutlineStrategy = {
    id: "makefile",
    category: "project",
    language: "make",
    matches: (input: OutlineMatchInput): boolean => {
        const lower: string = input.name.toLowerCase();
        return lower === "makefile" || lower === "gnumakefile" || lower.startsWith("makefile.") || hasExtension(input.name, [".mk"]);
    },
    parse: parseMakefile,
};

/**
 * Office container formats. Office files are ZIP or binary containers, so the
 * registry special-cases them before the text/binary gate and hands the raw
 * bytes to the registered office parser.
 */
export const OfficeOutlineExtensions: readonly string[] = [
    ".docx",
    ".doc",
    ".xlsx",
    ".xls",
    ".pptx",
    ".ppt",
    ".pub",
    ".accdb",
    ".mdb",
];

export { registerOfficeOutlineParser, hasOfficeOutlineParser, parseOffice } from "./officeBridge.ts";
export type { OfficeOutlineInput, OfficeOutlineParser } from "./officeBridge.ts";

/**
 * Reserved Office strategy. Registration keeps the strategy enumerable and
 * reserves the `office` id; `OutlineRegistry` routes Office containers through
 * `parseOffice` with raw bytes before charset detection.
 */
export const OfficeOutlineStrategy: OutlineStrategy = {
    id: "office",
    category: "data",
    language: "office",
    matches: (input: OutlineMatchInput): boolean => hasExtension(input.name, OfficeOutlineExtensions),
    parse: (): OutlineNode[] => [],
};

/**
 * Built-in strategies in selection priority order.
 *
 * Exact manifest names come before extensions, extension strategies before
 * content sniffing, and the plain-text strategy is last so `OutlineRegistry`
 * can use it as the fallback. The lowerCamel alias below is the documented
 * export name.
 */
const BuiltinOutlineStrategies: readonly OutlineStrategy[] = [
    NpmStrategy,
    MavenStrategy,
    GradleStrategy,
    CmakeStrategy,
    CargoStrategy,
    GoModStrategy,
    PyprojectStrategy,
    MakefileStrategy,
    TypeScriptStrategy,
    JavaScriptStrategy,
    PythonStrategy,
    JavaStrategy,
    CSharpStrategy,
    CStrategy,
    CppStrategy,
    GoStrategy,
    RustStrategy,
    VisualBasicStrategy,
    MarkdownStrategy,
    TexStrategy,
    CssStrategy,
    ScssStrategy,
    HtmlStrategy,
    VueStrategy,
    SqlStrategy,
    JsonStrategy,
    OfficeOutlineStrategy,
    OpmlStrategy,
    XmlStrategy,
    ShellStrategy,
    PlainTextStrategy,
];
export { BuiltinOutlineStrategies as builtinOutlineStrategies };
export { DefaultOutlineKeywords, OutlineKeywordRegistry, createOutlineKeywordRegistry } from "./outlineKeywords.ts";

