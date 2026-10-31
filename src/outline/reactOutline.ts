/**
 * React outline support.
 *
 * A `.jsx`/`.tsx` file is still TypeScript/JavaScript at the declaration level,
 * so this strategy wraps `parseTypeScript` instead of re-implementing the
 * declaration scanner: that scanner already masks comments, strings, template
 * literals and regular-expression literals, nests class members and reports
 * line ranges. `parseReact` then adds the React meaning on top of that tree:
 *
 * - a class declared with `extends React.Component` / `React.PureComponent`
 *   becomes `component`;
 * - an upper-case function/arrow that returns JSX, or a `React.memo` /
 *   `React.forwardRef` wrapper around one, becomes `component`;
 * - every hook call (`useState`, `useEffect`, `useMemo`, `useCallback`,
 *   `useRef`, `useContext`, `useReducer` and any custom `useX`) becomes one
 *   `hook` node per name, deduplicated file-wide;
 * - `interface XProps` / `type XProps` become `props`;
 * - upper-case JSX tags used inside a component become `jsx` children.
 *
 * The shared `OutlineKind` union lives in `types.ts` and is not widened here,
 * so the React-only kinds are local string literals converted at the single
 * emission point (`outlineTypeOf`). The registry copies `type` through
 * unchanged, so a caller sees `"component"` / `"hook"` / `"props"` / `"jsx"`
 * on the node; a renderer that exhaustively switches on `OutlineKind` needs
 * the union extended (see `docs/testing/languages/reactReport.md`).
 *
 * Selection is extension-gated and evidence-gated: only `.jsx`/`.tsx` files
 * whose head contains React evidence are claimed. A plain `.tsx` file with no
 * React evidence is left to the TypeScript strategy, which is why the React
 * strategy must be registered *before* the TypeScript/JavaScript strategies
 * (both also claim `.tsx`/`.jsx`; registration order is selection order).
 *
 * The parser is a bounded scanner, not a JSX grammar: it reuses the TypeScript
 * declaration tree, masks the source once more for hook/JSX evidence, and
 * bounds every forward scan. It never touches the filesystem and never throws
 * on malformed input.
 */
import { ByteLineIndex } from "../syntax/byteIndex.ts";
import { LineIndex } from "../syntax/charset.ts";
import { parseTypeScript } from "./outlineStrategies.ts";
import type { OutlineMatchInput, OutlineParseInput, OutlineStrategy } from "./strategy.ts";
import type { OutlineKind, OutlineNode, OutlineRange, OutlineType } from "./types.ts";

/**
 * Outline kinds this module adds without widening the shared `OutlineKind`
 * union. Naming them here keeps the cast in one place instead of scattering
 * string literals through the parser.
 */
export type ReactOutlineKind = "component" | "hook" | "props" | "jsx";

/**
 * React hook names that are part of the React API. Every one of them also
 * matches the generic `use[A-Z]` convention, so the list is a contract for
 * callers/tests rather than a detection shortcut.
 */
export const BuiltinReactHooks: ReadonlySet<string> = new Set<string>([
    "useState",
    "useEffect",
    "useMemo",
    "useCallback",
    "useRef",
    "useContext",
    "useReducer",
]);

/**
 * Extensions this strategy owns. The TypeScript strategy also claims `.tsx`
 * and the JavaScript strategy `.jsx`, so registration order decides the
 * winner; this strategy only matches when React evidence is present.
 */
const ReactExtensions: readonly string[] = [".tsx", ".jsx"];

/**
 * Head evidence for "this file is a React module". The patterns deliberately
 * mirror the documented contract: a `react` import/require, a `React.` member
 * access, a `jsx` pragma/word, or an upper-case JSX tag.
 */
const ReactEvidence: readonly RegExp[] = [
    /\bfrom\s+["']react["']/,
    /\brequire\s*\(\s*["']react["']\s*\)/,
    /\bReact\s*\./,
    /@jsx\b/i,
    /(?<![\p{ID_Continue}$.])<\s*\p{Lu}[\p{ID_Continue}$.]+(?=[\s/>])/u,
];

/**
 * Characters after which a `/` opens a regular-expression literal rather than
 * dividing. The set is the usual expression-prefix heuristic.
 */
const RegexPrefixCharacters: string = "([{=,:;!&|?+-*%^~<>";

/**
 * Keywords after which a `/` opens a regular-expression literal.
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
    if (before.length === 0 || RegexPrefixCharacters.includes(before) || before === "}") {
        return true;
    }
    if (/[A-Za-z0-9_$]/.test(before)) {
        const prefix: string = text.slice(Math.max(0, index - 64), index);
        const match: RegExpExecArray | null = /([A-Za-z_$][\w$]*)\s*$/.exec(prefix);
        return match !== null && RegexPrefixKeywords.has(match[1]);
    }
    return false;
};

/**
 * Characters after which a quote opens a JavaScript string literal: an
 * expression is expected.
 */
const StringPrefixCharacters: string = "([{=,:;!&|?+-*%^~<>";

/**
 * Keywords after which a quote opens a string literal. Module specifiers are
 * included so `from "react"` is masked.
 */
const StringPrefixKeywords: ReadonlySet<string> = new Set<string>([
    "return",
    "case",
    "throw",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "yield",
    "await",
    "do",
    "else",
    "import",
    "export",
    "from",
    "default",
    "const",
    "let",
    "var",
    "as",
    "satisfies",
    "keyof",
]);

/**
 * Whether a quote at one offset opens a JavaScript string literal.
 *
 * JSX text is not JavaScript string syntax. A prose apostrophe (`don't`) or a
 * quoted phrase in a tag body must not start a mask, otherwise the rest of the
 * line (including a nested `<Widget />`) disappears from the evidence scan. A
 * quote is therefore honored only in expression position: after an operator or
 * an opening bracket, after a `return`-like keyword, or, for a module
 * specifier, after `from`/`import`. A quote directly after an identifier is
 * prose and stays visible.
 *
 * @param text - Raw source text.
 * @param index - Offset of the quote.
 * @returns Whether the quote starts a string literal.
 */
const stringAllowed: (text: string, index: number) => boolean = (text: string, index: number): boolean => {
    const before: string = significantBefore(text, index);
    if (before.length === 0 || StringPrefixCharacters.includes(before)) {
        return true;
    }
    if (/[A-Za-z0-9_$]/.test(before)) {
        const prefix: string = text.slice(Math.max(0, index - 64), index);
        const match: RegExpExecArray | null = /([A-Za-z_$][\w$]*)\s*$/.exec(prefix);
        return match !== null && StringPrefixKeywords.has(match[1]);
    }
    return false;
};

/**
 * Mutable masking state. `characters` has the same length as `text`, so an
 * offset in one is an offset in the other.
 */
interface MaskContext {
    readonly text: string;
    readonly length: number;
    readonly characters: string[];
}

/**
 * Replace a range with spaces, preserving `\n` so line numbers stay valid.
 */
const blankMaskRange: (context: MaskContext, from: number, to: number) => void = (context: MaskContext, from: number, to: number): void => {
    const stop: number = Math.min(to, context.length);
    for (let cursor: number = from; cursor < stop; cursor += 1) {
        context.characters[cursor] = context.text[cursor] === "\n" ? "\n" : " ";
    }
};

/**
 * Mask one template literal, leaving `${...}` expressions as code.
 *
 * Template text is string content and is blanked; the expression inside a
 * placeholder is real source, so a hook call there (`${useMemo(...)}`) is still
 * visible to the hook scanner. Nested templates recurse.
 *
 * @param context - Masking state.
 * @param index - Offset of the opening backtick.
 * @returns Offset just past the closing backtick (or the end of the text).
 */
const maskTemplateLiteral: (context: MaskContext, index: number) => number = (context: MaskContext, index: number): number => {
    const text: string = context.text;
    const length: number = context.length;
    blankMaskRange(context, index, index + 1);
    let cursor: number = index + 1;
    while (cursor < length) {
        const character: string = text[cursor];
        if (character === "\\") {
            blankMaskRange(context, cursor, cursor + 2);
            cursor += 2;
            continue;
        }
        if (character === "`") {
            blankMaskRange(context, cursor, cursor + 1);
            return cursor + 1;
        }
        if (character === "$" && text[cursor + 1] === "{") {
            blankMaskRange(context, cursor, cursor + 2);
            const close: number = scanCodeMask(context, cursor + 2, true);
            if (close < length) {
                blankMaskRange(context, close, close + 1);
                cursor = close + 1;
            } else {
                cursor = length;
            }
            continue;
        }
        blankMaskRange(context, cursor, cursor + 1);
        cursor += 1;
    }
    return length;
};

/**
 * Scan code and blank comments, strings, template literals and regular
 * expression literals.
 *
 * @param context - Masking state.
 * @param index - Offset to start at.
 * @param stopAtBrace - When set, return at the `}` that closes the current
 * `${...}` expression instead of scanning past it.
 * @returns Offset of the stopping `}` (when `stopAtBrace`), or the end.
 */
const scanCodeMask: (context: MaskContext, index: number, stopAtBrace: boolean) => number = (
    context: MaskContext, index: number, stopAtBrace: boolean,
): number => {
    const text: string = context.text;
    const length: number = context.length;
    let cursor: number = index;
    let depth: number = 0;
    while (cursor < length) {
        const character: string = text[cursor];
        if (stopAtBrace) {
            if (character === "{") {
                depth += 1;
                cursor += 1;
                continue;
            }
            if (character === "}") {
                if (depth === 0) {
                    return cursor;
                }
                depth -= 1;
                cursor += 1;
                continue;
            }
        }
        if (character === "/" && text[cursor + 1] === "/") {
            /**
             * A URL inside JSX text (`https://example.test`) is prose, not a
             * line comment; a scheme directly before `//` is the guard.
             */
            const scheme: boolean = /[A-Za-z][A-Za-z0-9+.-]*:\/\/$/.test(text.slice(Math.max(0, cursor - 40), cursor + 2));
            if (!scheme) {
                const newline: number = text.indexOf("\n", cursor);
                const stop: number = newline === -1 ? length : newline;
                blankMaskRange(context, cursor, stop);
                cursor = stop;
                continue;
            }
        }
        if (character === "/" && text[cursor + 1] === "*") {
            const end: number = text.indexOf("*/", cursor + 2);
            const stop: number = end === -1 ? length : end + 2;
            blankMaskRange(context, cursor, stop);
            cursor = stop;
            continue;
        }
        if ((character === '"' || character === "'") && stringAllowed(text, cursor)) {
            let next: number = cursor + 1;
            while (next < length) {
                const current: string = text[next];
                if (current === "\\") {
                    next += 2;
                    continue;
                }
                if (current === character) {
                    next += 1;
                    break;
                }
                if (current === "\n") {
                    break;
                }
                next += 1;
            }
            blankMaskRange(context, cursor, next);
            cursor = next;
            continue;
        }
        if (character === "`") {
            cursor = maskTemplateLiteral(context, cursor);
            continue;
        }
        if (character === "/" && regexAllowed(text, cursor)) {
            let next: number = cursor + 1;
            let inClass: boolean = false;
            let closed: boolean = false;
            while (next < length) {
                const current: string = text[next];
                if (current === "\\") {
                    next += 2;
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
                    next += 1;
                    closed = true;
                    break;
                }
                next += 1;
            }
            if (closed) {
                blankMaskRange(context, cursor, next);
                cursor = next;
                continue;
            }
        }
        cursor += 1;
    }
    return length;
};

/**
 * Mask comments, strings, template literals and regular-expression literals
 * while preserving every offset and line break.
 *
 * The wrapped `parseTypeScript` masks the source internally but does not export
 * the masked text, and hook/JSX evidence must not be read out of a comment or a
 * string. The scanner keeps one string of the same length; unterminated
 * constructs run to the end of the text instead of throwing, because an
 * outline of a half-written file is still useful.
 *
 * Three evidence problems are handled explicitly:
 *
 * - JSX text is not string syntax, so a prose apostrophe or quoted phrase is
 *   not masked (see `stringAllowed`);
 * - a URL such as `https://example.test` is not a line comment (scheme guard);
 * - template literal text is masked, but `${...}` expressions are scanned as
 *   code, so a hook call inside a placeholder is still reported.
 *
 * A residual limitation is a bare `//` in JSX prose (with no URL scheme): it
 * is still read as a line comment.
 *
 * @param text - Decoded source text.
 * @returns Masked text with the same length and line breaks.
 */
const maskReactSource: (text: string) => string = (text: string): string => {
    if (text.length === 0) {
        return "";
    }
    const context: MaskContext = { text, length: text.length, characters: text.split("") };
    scanCodeMask(context, 0, false);
    return context.characters.join("");
};

/**
 * Line starts, using `\n` as the only separator so a `\r` stays in its line.
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
 * Decoded source plus the masked view and the byte index an outline range needs.
 */
interface ReactSource {
    readonly text: string;
    readonly masked: string;
    readonly starts: readonly number[];
    readonly totalLines: number;
    readonly byteIndex: ByteLineIndex;
    /**
     * Raw-file byte prefix that the decoded text no longer contains. Only a
     * UTF-8 BOM can produce it (three bytes); `reactNode` shifts every symbol
     * range by it so a directly parsed BOM file keeps raw-file offsets, which
     * is the same contract the registry applies to a decoded file.
     */
    readonly byteOffsetBase: bigint;
}

/**
 * Unicode BOM code unit. `decodeText` strips the byte-level BOM, but a caller
 * that hands the parser an already-decoded string may still carry this
 * character at offset zero.
 */
const BomCharacter: number = 0xfeff;

/**
 * Read a source once and keep the masked view and line index consistent.
 *
 * A leading BOM character is removed from the parsed text and replaced by a
 * fixed byte base, so the first `export` is still a declaration while the byte
 * ranges stay anchored to the caller's raw text.
 *
 * @param text - Decoded source text, with or without a leading BOM character.
 * @returns Source view used by the parser.
 */
const readReactSource: (text: string) => ReactSource = (text: string): ReactSource => {
    const hasBom: boolean = text.length > 0 && text.charCodeAt(0) === BomCharacter;
    const body: string = hasBom ? text.slice(1) : text;
    const starts: number[] = lineStartsOf(body);
    return {
        text: body,
        masked: maskReactSource(body),
        starts,
        totalLines: starts.length,
        byteIndex: new ByteLineIndex(body),
        byteOffsetBase: hasBom ? 3n : 0n,
    };
};

/**
 * Character offset where a 1-based line starts.
 */
const lineStartOffset: (source: ReactSource, line: number) => number = (source: ReactSource, line: number): number =>
    source.starts[Math.max(0, line - 1)] ?? 0;

/**
 * Character offset just past a 1-based line, including its newline.
 */
const lineEndOffset: (source: ReactSource, line: number) => number = (source: ReactSource, line: number): number => {
    if (line < source.totalLines) {
        return source.starts[line] ?? source.masked.length;
    }
    return source.masked.length;
};

/**
 * Escape one symbol segment so the `<file>#<symbol>` boundary stays parseable.
 * Mirrors the registry escape so a directly parsed tree has the same paths as
 * a registry-built one.
 */
const escapeSegment: (value: string) => string = (value: string): string =>
    value.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\//g, "%2F");

/**
 * Convert a React-local kind to the shared `OutlineType`.
 *
 * `OutlineKind` is owned by `types.ts`; widening it is a contract change for
 * the main integration, so this module keeps the four React kinds local and
 * performs the single controlled conversion here. No `any` is involved: the
 * literals are real strings and the registry copies `type` through unchanged.
 */
const outlineTypeOf: (kind: OutlineKind | ReactOutlineKind) => OutlineType = (kind: OutlineKind | ReactOutlineKind): OutlineType =>
    kind as unknown as OutlineType;

/**
 * Declarative description of one emitted React node range.
 */
interface ReactNodeSpec {
    readonly label: string;
    readonly kind: OutlineKind | ReactOutlineKind;
    readonly startLine: number;
    readonly endLine: number;
    readonly depth: number;
    readonly path: string;
    readonly detail?: string;
    readonly modifiers?: readonly string[];
    readonly children?: readonly OutlineNode[];
}

/**
 * Build one outline node with a real UTF-8 byte range.
 *
 * The wrapped TypeScript tree carries `0n` placeholder bytes because the
 * registry fills authoritative ranges from line numbers. Rebuilding every node
 * here means a direct `parseReact` call already returns a complete node, which
 * is what the boundary tests assert.
 */
const reactNode: (spec: ReactNodeSpec, source: ReactSource) => OutlineNode = (spec: ReactNodeSpec, source: ReactSource): OutlineNode => {
    const decodedRange: OutlineRange = source.byteIndex.range(spec.startLine, spec.endLine);
    const range: OutlineRange = source.byteOffsetBase === 0n
        ? decodedRange
        : {
              startByte: decodedRange.startByte + source.byteOffsetBase,
              endByte: decodedRange.endByte + source.byteOffsetBase,
              startLine: decodedRange.startLine,
              endLine: decodedRange.endLine,
          };
    return {
        isFile: false,
        isDirectory: false,
        path: spec.path,
        type: outlineTypeOf(spec.kind),
        range,
        label: spec.label,
        depth: Math.max(0, Math.trunc(spec.depth)),
        ...(spec.modifiers === (void 0) || spec.modifiers.length === 0 ? {} : { modifiers: [...spec.modifiers] }),
        ...(spec.detail === (void 0) || spec.detail.length === 0 ? {} : { detail: spec.detail }),
        children: spec.children ?? [],
    };
};

/**
 * Collapse whitespace and cut one evidence snippet.
 */
const cleanSnippet: (value: string) => string = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 120);

/**
 * JSX evidence: a `<` that opens a tag (or a fragment) in expression position.
 *
 * The prefix guard keeps a generic parameter list (`function Parse<T>(value: T)`)
 * and a type argument (`Array<Props>`) out of the evidence: a tag must follow
 * `return`, `=`, `(`, `,`, `:`, `?`, `&`, `|`, `>`, `;` or the range start, or
 * begin a fragment. A single-letter tag (`<T>`) is treated as a generic.
 */
const JsxEvidence: RegExp =
    /(?:^|[=({,\[:?&|>;]|\breturn\b|\bcase\b|\byield\b)\s*\(?\s*<(?:[\p{ID_Start}_$][\p{ID_Continue}$.:-]+|[A-Z](?:\s[^>]*)?>|[A-Z]\s*\/>|#[^>]*>|\/|>)/u;

/**
 * Upper-case JSX tag with a simple name. Member tags (`<List.Item>`) are
 * intentionally not collected: the dot would collide with the registry's
 * nesting separator. A single-letter tag is collected only when it is
 * self-closing or has a matching closing tag, which keeps a generic parameter
 * (`<T>`) out of the tree.
 */
const JsxTag: RegExp = /<\s*(\p{Lu}[\p{ID_Continue}$]*)(?=[\s/>])/gu;

/**
 * Hook call: a `use[A-Z]...` identifier followed by optional type arguments and
 * `(`. The one-level nested type-argument group covers `useRef<Record<string, number>>`
 * without pretending to parse arbitrary type syntax.
 */
const HookCall: RegExp = new RegExp("\\b(use\\p{Lu}[\\p{ID_Continue}$]*)\\s*(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>\\s*)?\\(", "gu");

/**
 * Index of the `)` matching the `(` at `openIndex`, or `-1`.
 */
const matchingParen: (masked: string, openIndex: number) => number = (masked: string, openIndex: number): number => {
    let depth: number = 0;
    for (let index: number = openIndex; index < masked.length; index += 1) {
        const character: string = masked[index];
        if (character === "(") {
            depth += 1;
            continue;
        }
        if (character === ")") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
};

/**
 * One hook call site before name deduplication.
 */
interface ReactHookSite {
    readonly name: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly detail: string;
}

/**
 * Whether a hook identifier is a declaration (`function useX(`) rather than a
 * call. The wrapped TypeScript tree already reports the declaration node, so
 * the call scan only has to skip it.
 */
const declarationBefore: RegExp = /(?:\bfunction|\bclass|\binterface|\btype|\bconst|\blet|\bvar)\s+$/;

/**
 * Find hook call sites in the masked source.
 *
 * A hook is reported once per name (first call wins), because an outline is a
 * symbol index rather than a call graph. `React.useState` is accepted as a
 * member call; any other receiver (`store.useThing`) is ignored. A method
 * definition (`useThing() {`) is not a call and is skipped.
 *
 * @param source - Decoded and masked source.
 * @returns First call site per hook name, in source order.
 */
const scanHookSites: (source: ReactSource) => ReactHookSite[] = (source: ReactSource): ReactHookSite[] => {
    const sites: ReactHookSite[] = [];
    const seen: Set<string> = new Set<string>();
    HookCall.lastIndex = 0;
    let match: RegExpExecArray | null = HookCall.exec(source.masked);
    while (match !== null) {
        const name: string = match[1];
        const openIndex: number = match.index + match[0].length - 1;
        const before: string = source.masked.slice(Math.max(0, match.index - 48), match.index);
        const memberCall: boolean =
            match.index > 0 &&
            source.masked[match.index - 1] === "." &&
            !/\bReact\s*$/.test(source.masked.slice(Math.max(0, match.index - 16), match.index - 1));
        const closeIndex: number = matchingParen(source.masked, openIndex);
        const startLine: number = lineAtOffset(source.starts, match.index);
        const lineStart: number = lineStartOffset(source, startLine);
        const atLineStart: boolean = source.masked.slice(lineStart, match.index).trim().length === 0;
        const methodDefinition: boolean =
            closeIndex !== -1 &&
            atLineStart &&
            /^\s*(?::[^{;]*)?\{/.test(source.masked.slice(closeIndex + 1, closeIndex + 48));
        if (!declarationBefore.test(before) && !memberCall && !methodDefinition && !seen.has(name)) {
            seen.add(name);
            const endLine: number = closeIndex === -1 ? startLine : lineAtOffset(source.starts, closeIndex);
            const raw: string = closeIndex === -1
                ? source.text.slice(match.index, Math.min(source.text.length, match.index + 80))
                : source.text.slice(match.index, closeIndex + 1);
            sites.push({ name, startLine, endLine: Math.max(startLine, endLine), detail: cleanSnippet(raw) });
        }
        HookCall.lastIndex = match.index + match[0].length;
        match = HookCall.exec(source.masked);
    }
    return sites;
};

/**
 * Bracket state used to reconcile a declaration's reported end line.
 */
interface DelimiterState {
    braces: number;
    parens: number;
    brackets: number;
}

/**
 * Whether every tracked bracket is balanced.
 */
const isBalanced: (state: DelimiterState) => boolean = (state: DelimiterState): boolean =>
    state.braces === 0 && state.parens === 0 && state.brackets === 0;

/**
 * Apply one masked character to a bracket state.
 */
const trackDelimiter: (masked: string, index: number, state: DelimiterState) => void = (masked: string, index: number, state: DelimiterState): void => {
    const character: string = masked[index];
    if (character === "{") {
        state.braces += 1;
        return;
    }
    if (character === "}") {
        state.braces = Math.max(0, state.braces - 1);
        return;
    }
    if (character === "(") {
        state.parens += 1;
        return;
    }
    if (character === ")") {
        state.parens = Math.max(0, state.parens - 1);
        return;
    }
    if (character === "[") {
        state.brackets += 1;
        return;
    }
    if (character === "]") {
        state.brackets = Math.max(0, state.brackets - 1);
    }
};

/**
 * Reconcile a line reported by the wrapped scanner with the actual bracket
 * balance of the masked source.
 *
 * `parseTypeScript` resolves a declaration end at the *first* `{` before a `;`,
 * so a declaration whose header contains an inline object type
 * (`React.memo(function Card(props: { title: string }) {` or
 * `React.FC<{ title: string }>`) is reported as a one-line range and its body
 * is invisible to the component evidence probe. When the reported end line
 * leaves a bracket open, the range is extended to the first line where the
 * declaration is balanced again. The forward scan is bounded (16 000 chars) so a
 * malformed file cannot make one node cost the rest of the file.
 *
 * @param source - Decoded and masked source.
 * @param startLine - 1-based declaration start.
 * @param reportedEndLine - End line from the wrapped TypeScript tree.
 * @returns Reported end line, or the reconciled one.
 */
const reconciledEndLine: (source: ReactSource, startLine: number, reportedEndLine: number) => number = (
    source: ReactSource, startLine: number, reportedEndLine: number,
): number => {
    const start: number = lineStartOffset(source, startLine);
    const endLine: number = Math.max(startLine, Math.min(reportedEndLine, source.totalLines));
    const reportedEnd: number = lineEndOffset(source, endLine);
    const state: DelimiterState = { braces: 0, parens: 0, brackets: 0 };
    let index: number = start;
    while (index < reportedEnd) {
        trackDelimiter(source.masked, index, state);
        index += 1;
    }
    if (isBalanced(state)) {
        return endLine;
    }
    const limit: number = Math.min(source.masked.length, start + 16000);
    while (index < limit) {
        trackDelimiter(source.masked, index, state);
        if (isBalanced(state)) {
            return lineAtOffset(source.starts, index);
        }
        index += 1;
    }
    return endLine;
};

/**
 * Effective inclusive end line of a wrapped node.
 */
const effectiveEndLine: (source: ReactSource, node: OutlineNode) => number = (source: ReactSource, node: OutlineNode): number => {
    const startLine: number = Number(node.range.startLine);
    return reconciledEndLine(source, startLine, Math.max(startLine, Number(node.range.endLine)));
};

/**
 * Start line of a wrapped node.
 */
const startLineOf: (node: OutlineNode) => number = (node: OutlineNode): number => Math.max(1, Number(node.range.startLine));

/**
 * Whether a line span contains JSX in expression position.
 */
const hasJsxBetween: (source: ReactSource, startLine: number, endLine: number) => boolean = (
    source: ReactSource, startLine: number, endLine: number,
): boolean => {
    const from: number = lineStartOffset(source, startLine);
    const to: number = lineEndOffset(source, Math.max(startLine, endLine));
    return JsxEvidence.test(source.masked.slice(from, to));
};

/**
 * Whether a wrapped declaration's effective range contains JSX.
 */
const hasJsxInNode: (source: ReactSource, node: OutlineNode) => boolean = (source: ReactSource, node: OutlineNode): boolean =>
    hasJsxBetween(source, startLineOf(node), effectiveEndLine(source, node));

/**
 * Upper-case component identifier. `\p{Lu}` keeps the check correct for a
 * Unicode identifier (`Café`, `ΔApp`); the wrapped declaration scanner may
 * report such a name, and the outline label keeps it verbatim.
 */
const ComponentName: RegExp = /^\p{Lu}[\p{ID_Continue}$]*$/u;

/**
 * Custom hook identifier (`useCounter`, `useÉchelle`).
 */
const CustomHookName: RegExp = /^use\p{Lu}[\p{ID_Continue}$]*$/u;

/**
 * A props declaration name: `Props`, `ButtonProps`, `GreetingProps`.
 */
const PropsName: RegExp = /Props$/;

/**
 * Class component base class.
 */
const ClassComponent: RegExp = /\bextends\s+(?:React\s*\.\s*)?(?:PureComponent|Component)\b/;

/**
 * `React.FC` / `React.FunctionComponent` / `React.ComponentType` annotation.
 */
const FunctionComponentType: RegExp = /:\s*(?:React\s*\.\s*)?(?:FC|FunctionComponent|ComponentType)\s*[<=(]/;

/**
 * `React.memo(...)` or `React.forwardRef(...)` wrapper (or the bare imported
 * form). The leading `[^\w$]` keeps `useMemo(` from matching `memo`.
 */
const WrapperComponent: RegExp = /(?:^|[^\w$])(?:React\s*\.\s*)?(?:memo|forwardRef)\s*(?:<[^<>()]*>\s*)?\(/;

/**
 * `export default` header.
 */
const DefaultExport: RegExp = /^export\s+default\b/;

/**
 * Anonymous default arrow header (`export default () =>`, `export default (props: Props) =>`).
 */
const DefaultArrow: RegExp = /^export\s+default\s+(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=>/;

/**
 * Role a wrapped node plays after React classification.
 */
type ReactRole = "component" | "hook" | "props" | "outline";

/**
 * Classify one wrapped declaration.
 *
 * Order matters: a `useX` function is a hook even when it returns JSX, and a
 * props interface is props before any component check runs.
 *
 * @param node - Node returned by `parseTypeScript`.
 * @param source - Decoded source for JSX evidence.
 * @returns React role.
 */
const classifyReactNode: (node: OutlineNode, source: ReactSource) => ReactRole = (node: OutlineNode, source: ReactSource): ReactRole => {
    const detail: string = node.detail ?? "";
    const type: OutlineType = node.type;
    if ((type === "interface" || type === "type") && PropsName.test(node.label)) {
        return "props";
    }
    if (type === "class" && ClassComponent.test(detail)) {
        return "component";
    }
    if (type === "function" && CustomHookName.test(node.label)) {
        return "hook";
    }
    const functionLike: boolean = type === "function" || type === "constant" || type === "variable";
    if (functionLike && ComponentName.test(node.label)) {
        if (FunctionComponentType.test(detail)) {
            return "component";
        }
        const wrapped: boolean = WrapperComponent.test(detail);
        if ((wrapped || type === "function") && hasJsxInNode(source, node)) {
            return "component";
        }
    }
    if (node.label === "default" && DefaultExport.test(detail) && /(?:function\b|=>)/.test(detail) && hasJsxInNode(source, node)) {
        return "component";
    }
    return "outline";
};

/**
 * Collect upper-case JSX tags used inside one component range.
 *
 * A tag that directly follows an identifier, `)`, `]` or `.` is a type
 * argument (`React.Component<Props>`, `Array<Item>`) and is skipped. A
 * single-letter tag is kept only when it is self-closing (`<A />`) or has a
 * matching closing tag, so a generic parameter (`<T>`) is not a child. The
 * first and last usage lines become the child's range; duplicates collapse
 * into one `jsx` child per name.
 *
 * @param source - Decoded source.
 * @param parentPath - Path of the owning component.
 * @param depth - Depth of the new children.
 * @param startLine - Inclusive component start.
 * @param endLine - Inclusive component end.
 * @returns Deduplicated `jsx` children sorted by first usage.
 */
const collectJsxChildren: (source: ReactSource, parentPath: string, depth: number, startLine: number, endLine: number) => OutlineNode[] = (
    source: ReactSource, parentPath: string, depth: number, startLine: number, endLine: number,
): OutlineNode[] => {
    const from: number = lineStartOffset(source, startLine);
    const to: number = lineEndOffset(source, Math.max(startLine, endLine));
    const text: string = source.masked.slice(from, to);
    const found: Map<string, { first: number; last: number; }> = new Map<string, { first: number; last: number; }>();
    JsxTag.lastIndex = 0;
    let match: RegExpExecArray | null = JsxTag.exec(text);
    while (match !== null) {
        const name: string = match[1];
        const previous: string = match.index > 0 ? text[match.index - 1] : "";
        const following: string = text.slice(match.index + match[0].length, match.index + match[0].length + 16);
        const generic: boolean = /[A-Za-z0-9_$)\].]/.test(previous);
        const singleLetter: boolean = name.length === 1;
        const selfClosing: boolean = /^\s*\/\s*>/.test(following);
        const paired: boolean = singleLetter && new RegExp("</\\s*" + name + "\\s*>", "u").test(text);
        const usable: boolean = !generic && (!singleLetter || selfClosing || paired);
        if (usable) {
            const line: number = lineAtOffset(source.starts, from + match.index);
            const entry: { first: number; last: number; } | undefined = found.get(name);
            if (entry === (void 0)) {
                found.set(name, { first: line, last: line });
            } else if (line > entry.last) {
                entry.last = line;
            }
        }
        JsxTag.lastIndex = match.index + match[0].length;
        match = JsxTag.exec(text);
    }
    const children: OutlineNode[] = [];
    found.forEach((lines: { first: number; last: number; }, name: string): void => {
        children.push(
            reactNode(
                {
                    label: name,
                    kind: "jsx",
                    startLine: lines.first,
                    endLine: Math.max(lines.first, lines.last),
                    depth,
                    path: `${parentPath}.${escapeSegment(name)}`,
                },
                source,
            ),
        );
    });
    children.sort((left: OutlineNode, right: OutlineNode): number => Number(left.range.startLine) - Number(right.range.startLine));
    return children;
};

/**
 * Context one rebuild pass needs.
 */
interface RebuildContext {
    readonly filePath: string;
    readonly source: ReactSource;
}

/**
 * Path segment for one node under a parent path.
 */
const nodePath: (parentPath: string, label: string, filePath: string) => string = (parentPath: string, label: string, filePath: string): string =>
    parentPath.length === 0 ? `${filePath}#${escapeSegment(label)}` : `${parentPath}.${escapeSegment(label)}`;

/**
 * Rebuild a wrapped child list, keeping the TypeScript member semantics.
 */
const rebuildChildren: (nodes: readonly OutlineNode[], parentPath: string, depth: number, context: RebuildContext) => OutlineNode[] = (
    nodes: readonly OutlineNode[], parentPath: string, depth: number, context: RebuildContext,
): OutlineNode[] => {
    const rebuilt: OutlineNode[] = [];
    for (let index: number = 0; index < nodes.length; index += 1) {
        rebuilt.push(rebuildNode(nodes[index], parentPath, depth, context, "outline"));
    }
    return rebuilt;
};

/**
 * Rebuild one wrapped node with a React role, a real byte range and a path.
 *
 * @param node - Node returned by `parseTypeScript`.
 * @param parentPath - Empty for a top-level symbol, the parent path otherwise.
 * @param depth - Zero-based depth below the file anchor.
 * @param context - File path and decoded source.
 * @param role - React role decided by `classifyReactNode`.
 * @returns New node.
 */
const rebuildNode: (node: OutlineNode, parentPath: string, depth: number, context: RebuildContext, role: ReactRole) => OutlineNode = (
    node: OutlineNode, parentPath: string, depth: number, context: RebuildContext, role: ReactRole,
): OutlineNode => {
    const label: string = node.label;
    const path: string = nodePath(parentPath, label, context.filePath);
    const startLine: number = startLineOf(node);
    const endLine: number = Math.max(startLine, effectiveEndLine(context.source, node));
    const children: OutlineNode[] = rebuildChildren(node.children, path, depth + 1, context);
    let kind: OutlineKind | ReactOutlineKind;
    if (role === "component") {
        kind = "component";
    } else if (role === "hook") {
        kind = "hook";
    } else if (role === "props") {
        kind = "props";
    } else {
        kind = node.type as OutlineKind;
    }
    if (role === "component") {
        const jsxChildren: OutlineNode[] = collectJsxChildren(context.source, path, depth + 1, startLine, endLine);
        for (let index: number = 0; index < jsxChildren.length; index += 1) {
            children.push(jsxChildren[index]);
        }
        children.sort((left: OutlineNode, right: OutlineNode): number => Number(left.range.startLine) - Number(right.range.startLine));
    }
    return reactNode(
        {
            label,
            kind,
            startLine,
            endLine,
            depth,
            path,
            ...(node.detail === (void 0) ? {} : { detail: node.detail }),
            ...(node.modifiers === (void 0) ? {} : { modifiers: node.modifiers }),
            children,
        },
        context.source,
    );
};

/**
 * End line of a whole statement, used only for the anonymous-default fallback.
 *
 * @param source - Decoded source.
 * @param startLine - 1-based statement start.
 * @returns Inclusive end line, bounded to 40 lines past the start.
 */
const statementEndLine: (source: ReactSource, startLine: number) => number = (source: ReactSource, startLine: number): number => {
    const start: number = lineStartOffset(source, startLine);
    const limit: number = Math.min(source.masked.length, start + 8000);
    let depth: number = 0;
    for (let index: number = start; index < limit; index += 1) {
        const character: string = source.masked[index];
        if (character === "(" || character === "[" || character === "{") {
            depth += 1;
            continue;
        }
        if (character === ")" || character === "]") {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (character === "}") {
            depth = Math.max(0, depth - 1);
            if (depth === 0) {
                let rest: boolean = false;
                for (let peek: number = index + 1; peek < source.masked.length; peek += 1) {
                    const next: string = source.masked[peek];
                    if (next === "\n") {
                        break;
                    }
                    if (!/\s/.test(next)) {
                        rest = true;
                        break;
                    }
                }
                if (!rest) {
                    return lineAtOffset(source.starts, index);
                }
            }
            continue;
        }
        if (character === ";" && depth === 0) {
            return lineAtOffset(source.starts, index);
        }
    }
    return Math.min(source.totalLines, startLine + 40);
};

/**
 * Find an `export default () => ...` header that the TypeScript scanner does
 * not turn into a declaration (an anonymous default arrow).
 *
 * @param source - Decoded source.
 * @param existing - Already-built top-level nodes, used to avoid a duplicate.
 * @returns Line span, or `undefined`.
 */
const findAnonymousDefaultComponent: (source: ReactSource, existing: readonly OutlineNode[]) => { readonly startLine: number; readonly endLine: number; } | undefined = (
    source: ReactSource, existing: readonly OutlineNode[],
): { readonly startLine: number; readonly endLine: number; } | undefined => {
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const from: number = lineStartOffset(source, line);
        const to: number = lineEndOffset(source, line);
        if (!/^export\s+default\b/.test(source.masked.slice(from, to).trim())) {
            continue;
        }
        const window: string = source.masked.slice(from, Math.min(source.masked.length, from + 800));
        if (!DefaultArrow.test(window)) {
            continue;
        }
        const duplicate: boolean = existing.some((node: OutlineNode): boolean => startLineOf(node) === line);
        if (duplicate) {
            continue;
        }
        const endLine: number = Math.max(line, statementEndLine(source, line));
        if (!hasJsxBetween(source, line, endLine)) {
            continue;
        }
        return { startLine: line, endLine };
    }
    return undefined;
};

/**
 * Stable sort of top-level nodes by start line.
 */
const sortByStartLine: (nodes: readonly OutlineNode[]) => OutlineNode[] = (nodes: readonly OutlineNode[]): OutlineNode[] =>
    [...nodes].sort((left: OutlineNode, right: OutlineNode): number => Number(left.range.startLine) - Number(right.range.startLine));

/**
 * Parse a React/JSX module.
 *
 * The declaration tree comes from `parseTypeScript`; this function adds the
 * React semantics described in the module header, gives every node a
 * `<file>#<symbol>` path, a UTF-8 byte range and a depth, and emits one hook
 * node per name. The result is ordered by start line at the top level. It is a
 * pure function of `input.text`.
 *
 * @param input - Decoded source text and its path.
 * @returns React symbol tree; empty for an empty file.
 */
export const parseReact: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: ReactSource = readReactSource(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    /**
     * The wrapped scanner must see the same BOM-free text the React source view
     * uses; `lineIndex` is rebuilt for that text because the original index may
     * still include the removed BOM character.
     */
    const parseInput: OutlineParseInput = { path: input.path, text: source.text, lineIndex: new LineIndex(source.text) };
    const declarations: readonly OutlineNode[] = parseTypeScript(parseInput);
    const context: RebuildContext = { filePath: input.path, source };
    const nodes: OutlineNode[] = [];
    const declaredHooks: Set<string> = new Set<string>();
    for (let index: number = 0; index < declarations.length; index += 1) {
        const declaration: OutlineNode = declarations[index];
        const role: ReactRole = classifyReactNode(declaration, source);
        if (role === "hook") {
            declaredHooks.add(declaration.label);
        }
        nodes.push(rebuildNode(declaration, "", 0, context, role));
    }
    const sites: readonly ReactHookSite[] = scanHookSites(source);
    for (let index: number = 0; index < sites.length; index += 1) {
        const site: ReactHookSite = sites[index];
        if (declaredHooks.has(site.name)) {
            continue;
        }
        nodes.push(
            reactNode(
                {
                    label: site.name,
                    kind: "hook",
                    startLine: site.startLine,
                    endLine: site.endLine,
                    depth: 0,
                    path: nodePath("", site.name, input.path),
                    detail: site.detail,
                },
                source,
            ),
        );
    }
    const anonymousDefault: { readonly startLine: number; readonly endLine: number; } | undefined = findAnonymousDefaultComponent(source, nodes);
    if (anonymousDefault !== undefined) {
        const path: string = nodePath("", "default", input.path);
        nodes.push(
            reactNode(
                {
                    label: "default",
                    kind: "component",
                    startLine: anonymousDefault.startLine,
                    endLine: anonymousDefault.endLine,
                    depth: 0,
                    path,
                    detail: "export default",
                    children: collectJsxChildren(source, path, 1, anonymousDefault.startLine, anonymousDefault.endLine),
                },
                source,
            ),
        );
    }
    return sortByStartLine(nodes);
};

/**
 * Whether a base name has a React extension.
 */
const hasReactExtension: (name: string) => boolean = (name: string): boolean => {
    const dot: number = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) {
        return false;
    }
    return ReactExtensions.includes(name.slice(dot).toLowerCase());
};

/**
 * React/JSX outline strategy.
 *
 * `matches` requires one of `.tsx`/`.jsx` *and* React evidence in the head, so
 * a plain TSX file falls through to the TypeScript strategy. Because both the
 * TypeScript and JavaScript strategies also claim these extensions, this
 * strategy has to be registered ahead of them; `docs/testing/languages/reactReport.md`
 * records the integration order.
 */
export const ReactStrategy: OutlineStrategy = {
    id: "react",
    category: "code",
    language: "react",
    matches: (input: OutlineMatchInput): boolean =>
        hasReactExtension(input.name) &&
        ReactEvidence.some((evidence: RegExp): boolean => evidence.test(input.head)),
    parse: parseReact,
};
