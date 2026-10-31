/**
 * Shell/Bash outline strategy.
 *
 * The parser is a bounded line scanner over decoded text. It never touches the
 * filesystem, spawns a process or imports a shell parser: an outline needs
 * declarations and ranges, not a full grammar or an execution environment.
 *
 * Shell is harder to scan than a brace language because a `#` is only a
 * comment at the start of a word, single quotes have no escapes, double quotes
 * span lines, and a here-document body is data even when it looks exactly like
 * code. The parser therefore masks first and classifies second:
 *
 * 1. `maskShellSource` replaces comments, quoted strings, `$(...)`, `${...}`,
 *    backtick substitutions and here-document bodies with spaces while keeping
 *    every UTF-16 offset and line break. Masked syntax can therefore never
 *    produce a declaration, and a brace inside a string cannot change a
 *    function's end line.
 * 2. Functions are located by their header (`name() {`, `function name {`,
 *    `function name() {`) and paired with the matching `}` from a brace index.
 * 3. Closed control blocks (`if`/`fi`, `for`/`while`/`until`/`select`/`done`,
 *    `case`/`esac`) become optional `section` nodes. Token position decides
 *    whether a reserved word opens a block, so `echo if` is not a block.
 * 4. Assignments (`NAME=value`, `export`, `readonly`, `declare`, `typeset`,
 *    `local`), `source`/`.` includes and `alias` entries become leaf nodes.
 * 5. Node depth is the number of open functions and sections that strictly
 *    contain the declaration line, so nesting is source-ordered and bounded.
 *
 * The module exports only `ShellStrategy` and `parseShell`; registration is
 * owned by `outlineStrategies.ts`. Until `ShellStrategy` is appended to
 * `builtinOutlineStrategies`, callers can use
 * `new OutlineRegistry([ShellStrategy])` or call `parseShell` directly.
 */
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
 * Masked text plus the absolute offsets where a `#` comment started. The
 * offsets let a label keep string contents while dropping a trailing comment.
 */
interface ShellMask {
    readonly text: string;
    readonly comments: readonly number[];
}

/**
 * One pending here-document body. `stripTabs` mirrors the `<<-` form, whose
 * closing delimiter may be indented with tabs.
 */
interface HeredocSpec {
    readonly delimiter: string;
    readonly stripTabs: boolean;
}

/**
 * One flat outline entry before depths and hierarchy are assigned. `endLine` is
 * mutable because a function's brace pair or a block's closer is discovered
 * after the declaration has been recorded.
 */
interface ShellEntry {
    readonly label: string;
    readonly kind: OutlineKind;
    readonly startLine: number;
    endLine: number;
    depth: number;
    readonly detail?: string;
    readonly keyword?: string;
}

/**
 * A mutable tree node used only during assembly.
 */
interface DraftShellNode {
    readonly label: string;
    readonly kind: OutlineKind;
    readonly startLine: number;
    readonly endLine: number;
    readonly depth: number;
    readonly detail?: string;
    readonly children: DraftShellNode[];
}

/**
 * Everything the classification passes share after masking.
 */
interface ShellScanContext {
    readonly source: SourceLines;
    readonly masked: string;
    readonly maskedLines: readonly string[];
    readonly visibleLines: readonly string[];
    readonly starts: readonly number[];
    readonly braceClose: ReadonlyMap<number, number>;
}

/**
 * Line starts of a text, using `\n` as the only line separator.
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
 * Split into logical lines, dropping the phantom empty line a trailing newline
 * would create and stripping a trailing carriage return.
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
 * Characters after which a `#` starts a comment. Shell only treats `#` as a
 * comment at a word boundary, so `foo#bar`, `$#` and `${#x}` keep their `#`.
 */
const ShellCommentBoundary: string = ";|&(){}";

/**
 * Whether the `#` at one offset opens a comment.
 */
const isShellCommentStart: (text: string, index: number) => boolean = (text: string, index: number): boolean => {
    if (index === 0) {
        return true;
    }
    const previous: string = text[index - 1];
    return /\s/.test(previous) || ShellCommentBoundary.includes(previous);
};

/**
 * Here-document introducer: `<<`, `<<-`, then a quoted or bare delimiter.
 */
const ShellHereDoc: RegExp = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_.-]*))/;

/**
 * Mask shell syntax while preserving every offset and line break.
 *
 * Comment bodies, single- and double-quoted strings, `$(...)`, `${...}`,
 * backtick substitutions and here-document bodies are replaced by spaces.
 * Unterminated constructs run to the end of the text instead of throwing,
 * because an outline of a half-written script is still useful.
 *
 * @param text - Decoded shell text.
 * @returns Masked text plus the absolute offsets of comment starts.
 */
const maskShellSource: (text: string) => ShellMask = (text: string): ShellMask => {
    const length: number = text.length;
    const masked: string[] = text.split("");
    const comments: number[] = [];
    const pending: HeredocSpec[] = [];
    const blank: (from: number, to: number) => void = (from: number, to: number): void => {
        const stop: number = Math.min(to, length);
        for (let cursor: number = from; cursor < stop; cursor += 1) {
            const character: string = masked[cursor];
            if (character !== "\n" && character !== "\r") {
                masked[cursor] = " ";
            }
        }
    };
    /**
     * Blank a balanced substitution from its opening `$`. Quotes inside the
     * substitution are skipped so `$(echo ")")` closes at the correct paren.
     */
    const maskBalanced: (start: number, open: string, close: string) => number = (start: number, open: string, close: string): number => {
        let depth: number = 0;
        let cursor: number = start;
        let quote: string = "";
        while (cursor < length) {
            const character: string = text[cursor];
            if (quote.length > 0) {
                if (character === "\\" && quote === '"') {
                    cursor += 2;
                    continue;
                }
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
            if (character === "\\") {
                cursor += 2;
                continue;
            }
            if (character === open) {
                depth += 1;
            } else if (character === close) {
                depth -= 1;
                if (depth === 0) {
                    cursor += 1;
                    break;
                }
            }
            cursor += 1;
        }
        const stop: number = Math.min(cursor, length);
        blank(start, stop);
        return stop;
    };
    let index: number = 0;
    while (index < length) {
        if (pending.length > 0 && (index === 0 || text[index - 1] === "\n")) {
            const newline: number = text.indexOf("\n", index);
            const lineEnd: number = newline === -1 ? length : newline;
            const rawLine: string = text.slice(index, lineEnd).replace(/\r$/, "");
            const current: HeredocSpec = pending[0];
            const candidate: string = current.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
            blank(index, lineEnd);
            if (candidate === current.delimiter) {
                pending.shift();
            }
            index = newline === -1 ? length : newline + 1;
            continue;
        }
        const character: string = text[index];
        if (character === "\\") {
            index = Math.min(length, index + 2);
            continue;
        }
        if (character === "'") {
            /**
             * A POSIX single-quoted string has no escapes but may span lines,
             * so the scan continues to the closing quote (or EOF) instead of
             * stopping at the newline.
             */
            let cursor: number = index + 1;
            while (cursor < length && text[cursor] !== "'") {
                cursor += 1;
            }
            const stop: number = cursor < length ? cursor + 1 : length;
            blank(index, stop);
            index = stop;
            continue;
        }
        if (character === '"') {
            let cursor: number = index + 1;
            while (cursor < length) {
                if (text[cursor] === "\\") {
                    cursor += 2;
                    continue;
                }
                if (text[cursor] === '"') {
                    cursor += 1;
                    break;
                }
                cursor += 1;
            }
            const stop: number = Math.min(cursor, length);
            blank(index, stop);
            index = stop;
            continue;
        }
        if (character === "#" && isShellCommentStart(text, index)) {
            comments.push(index);
            const newline: number = text.indexOf("\n", index);
            const stop: number = newline === -1 ? length : newline;
            blank(index, stop);
            index = stop;
            continue;
        }
        if (character === "$" && text[index + 1] === "(") {
            index = maskBalanced(index, "(", ")");
            continue;
        }
        if (character === "$" && text[index + 1] === "{") {
            index = maskBalanced(index, "{", "}");
            continue;
        }
        /**
         * A bare `((...))` arithmetic command can contain `<<` (a shift) and
         * `;` (a C-style `for` header), both of which would otherwise be read
         * as a here-document or a command separator. Mask the whole command.
         */
        if (character === "(" && text[index + 1] === "(") {
            index = maskBalanced(index, "(", ")");
            continue;
        }
        if (character === "`") {
            let cursor: number = index + 1;
            while (cursor < length) {
                if (text[cursor] === "\\") {
                    cursor += 2;
                    continue;
                }
                if (text[cursor] === "`") {
                    cursor += 1;
                    break;
                }
                cursor += 1;
            }
            const stop: number = Math.min(cursor, length);
            blank(index, stop);
            index = stop;
            continue;
        }
        if (character === "<" && text[index + 1] === "<" && text[index + 2] !== "<") {
            const match: RegExpExecArray | null = ShellHereDoc.exec(text.slice(index, Math.min(length, index + 256)));
            if (match !== null) {
                const delimiter: string = match[2] ?? match[3] ?? match[4] ?? "";
                if (delimiter.length > 0) {
                    pending.push({ delimiter, stripTabs: match[1] === "-" });
                    index += match[0].length;
                    continue;
                }
            }
        }
        index += 1;
    }
    return { text: masked.join(""), comments };
};

/**
 * Index the braces of a masked text. Strings, comments and substitutions are
 * already spaces, so a brace seen here is real shell syntax.
 */
const scanShellBraces: (masked: string) => ReadonlyMap<number, number> = (masked: string): ReadonlyMap<number, number> => {
    const close: Map<number, number> = new Map<number, number>();
    const stack: number[] = [];
    for (let index: number = 0; index < masked.length; index += 1) {
        const character: string = masked[index];
        if (character === "{") {
            stack.push(index);
            continue;
        }
        if (character === "}") {
            const openIndex: number | undefined = stack.pop();
            if (openIndex !== (void 0)) {
                close.set(openIndex, index);
            }
        }
    }
    return close;
};

/**
 * Function header with the `function` keyword, with or without `()`.
 */
const ShellFunctionKeyword: RegExp = /^(\s*)function\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:\(\s*\))?\s*/;

/**
 * Function header in the POSIX form, `name() {`.
 */
const ShellFunctionParens: RegExp = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)\s*\(\s*\)\s*/;

/**
 * Reserved words that can never name a function definition.
 */
const ShellReservedNames: ReadonlySet<string> = new Set<string>([
    "if",
    "then",
    "elif",
    "else",
    "fi",
    "for",
    "while",
    "until",
    "do",
    "done",
    "case",
    "esac",
    "in",
    "select",
    "function",
    "time",
    "coproc",
]);

/**
 * Reserved word that opens a closed block and the kind used to pair its closer.
 */
const ShellOpeners: ReadonlyMap<string, string> = new Map<string, string>([
    ["if", "if"],
    ["for", "loop"],
    ["while", "loop"],
    ["until", "loop"],
    ["select", "loop"],
    ["case", "case"],
]);

/**
 * Reserved word that closes a block, mapped to the opener kind it matches.
 */
const ShellClosers: ReadonlyMap<string, string> = new Map<string, string>([
    ["fi", "if"],
    ["done", "loop"],
    ["esac", "case"],
]);

/**
 * Reserved words that keep the next word in command position.
 */
const ShellCommandPrefixes: ReadonlySet<string> = new Set<string>(["then", "do", "else", "elif", "!"]);

/**
 * Shell command separators, also used as tokenizer delimiters.
 */
const ShellSeparators: ReadonlySet<string> = new Set<string>([";", "&", "|", "(", ")", "{", "}"]);

/**
 * A redirection token. A redirection is not a command name, so it neither opens
 * a block nor ends the current command position.
 */
const ShellRedirection: RegExp = /^\d*(?:<<<|<<|>>|>&|<&|>|<)/;

/**
 * A `case` branch pattern line, for example `start)`, `*)` or `--help)`.
 */
const ShellCasePattern: RegExp = /^[^\s()]+\)/;

/**
 * Assignment name with an optional append operator.
 */
const ShellAssignment: RegExp = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

/**
 * Declaration commands whose operands may be assignments.
 */
const ShellDeclarationPrefix: RegExp = /^(export|readonly|declare|typeset|local)\b/;

/**
 * A single token inside an `alias` argument list, honoring simple quotes.
 */
const ShellAliasWord: RegExp = /(?:[^\s'"]+|'[^']*'|"[^"]*")+/g;

/**
 * `source`/`.` include with a quoted, single-quoted or bare target.
 */
const ShellSourceCommand: RegExp = /^(?:source|\.)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/;

/**
 * Split a masked line into words and single-character shell separators.
 */
const shellTokens: (line: string) => string[] = (line: string): string[] =>
    line
        .split(/([;&|(){}]|\s+)/)
        .map((part: string): string => part.trim())
        .filter((part: string): boolean => part.length > 0);

/**
 * Turn a raw block opener into a readable section label.
 *
 * The keyword is located as a whole word so a one-line `case` branch such as
 * `a) if true; then ...` labels the inner `if` instead of the whole pattern
 * line. The condition stops at the `then`/`do` that ends the header, which also
 * keeps a one-line block readable.
 */
const sectionLabel: (keyword: string, rawLine: string) => string = (keyword: string, rawLine: string): string => {
    const marker: RegExp = new RegExp(`(?:^|[\\s;&|()])${keyword}\\b`);
    const found: RegExpExecArray | null = marker.exec(rawLine);
    let body: string = found === null ? rawLine.trim() : rawLine.slice(found.index).trim();
    body = body.replace(/\s*;\s*(?:then|do)\b[\s\S]*$/, "").trim();
    body = body.replace(/\s+(?:then|do)\b[\s\S]*$/, "").trim();
    if (keyword === "case") {
        body = body.replace(/\s+in\b[\s\S]*$/, "").trim();
    }
    return body.length === 0 ? keyword : body;
};

/**
 * Locate function headers and pair each with its closing brace line.
 *
 * @param context - Masked source, line views and brace index.
 * @returns Function entries in source order.
 */
const collectFunctions: (context: ShellScanContext) => ShellEntry[] = (context: ShellScanContext): ShellEntry[] => {
    const entries: ShellEntry[] = [];
    const source: SourceLines = context.source;
    const masked: string = context.masked;
    const maskedLines: readonly string[] = context.maskedLines;
    const visibleLines: readonly string[] = context.visibleLines;
    const starts: readonly number[] = context.starts;
    const braceClose: ReadonlyMap<number, number> = context.braceClose;
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const maskedLine: string = maskedLines[line - 1] ?? "";
        if (maskedLine.trim().length === 0) {
            continue;
        }
        let match: RegExpExecArray | null = ShellFunctionKeyword.exec(maskedLine);
        let label: string = "";
        if (match !== null) {
            label = match[2];
        } else {
            match = ShellFunctionParens.exec(maskedLine);
            if (match !== null) {
                label = match[2];
            }
        }
        if (match === null || label.length === 0 || ShellReservedNames.has(label)) {
            continue;
        }
        const lineStart: number = starts[line - 1] ?? 0;
        const headerEnd: number = lineStart + match[0].length;
        let openOffset: number = -1;
        for (let cursor: number = headerEnd; cursor < lineStart + maskedLine.length; cursor += 1) {
            if (masked[cursor] === "{") {
                openOffset = cursor;
                break;
            }
        }
        if (openOffset === -1) {
            for (let next: number = line + 1; next <= source.totalLines; next += 1) {
                const nextLine: string = maskedLines[next - 1] ?? "";
                if (nextLine.trim().length === 0) {
                    continue;
                }
                if (nextLine.trim().startsWith("{")) {
                    const nextStart: number = starts[next - 1] ?? 0;
                    openOffset = nextStart + nextLine.indexOf("{");
                }
                break;
            }
        }
        let endLine: number = line;
        if (openOffset !== -1) {
            const closeOffset: number | undefined = braceClose.get(openOffset);
            if (closeOffset !== (void 0)) {
                endLine = lineAtOffset(starts, closeOffset);
            }
        }
        const detail: string = visibleLines[line - 1] ?? "";
        entries.push({
            label,
            kind: "function",
            startLine: line,
            endLine: Math.max(line, endLine),
            depth: 0,
            ...(detail.length === 0 ? {} : { detail }),
        });
    }
    return entries;
};

/**
 * Locate closed control blocks and pair each opener with its closer.
 *
 * A block starts only in command position, so `echo if` and a `case` pattern
 * named `done` do not open or close anything. An unclosed block runs to EOF; a
 * one-line block (`if true; then echo; fi`) keeps its start and end line.
 *
 * @param context - Masked source and line views.
 * @returns Section entries in source order.
 */
const collectSections: (context: ShellScanContext) => ShellEntry[] = (context: ShellScanContext): ShellEntry[] => {
    const entries: ShellEntry[] = [];
    const stack: Array<{ readonly kind: string; readonly entry: ShellEntry; }> = [];
    const source: SourceLines = context.source;
    const maskedLines: readonly string[] = context.maskedLines;
    const visibleLines: readonly string[] = context.visibleLines;
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        const tokens: string[] = shellTokens(maskedLines[line - 1] ?? "");
        let commandPosition: boolean = true;
        for (let index: number = 0; index < tokens.length; index += 1) {
            const token: string = tokens[index];
            if (ShellSeparators.has(token)) {
                commandPosition = true;
                continue;
            }
            if (ShellRedirection.test(token)) {
                continue;
            }
            if (!commandPosition) {
                continue;
            }
            /**
             * A `case` branch pattern may itself be a reserved word (`done)`,
             * `if)`). The following `)` distinguishes a pattern from a block
             * keyword, so an open loop is not closed by a pattern name.
             */
            const patternLike: boolean =
                index + 1 < tokens.length && tokens[index + 1] === ")" && stack.some((frame: { readonly kind: string; }) => frame.kind === "case");
            if (patternLike) {
                commandPosition = false;
                continue;
            }
            const openerKind: string | undefined = ShellOpeners.get(token);
            if (openerKind !== (void 0)) {
                const entry: ShellEntry = {
                    label: sectionLabel(token, visibleLines[line - 1] ?? ""),
                    kind: "section",
                    startLine: line,
                    endLine: line,
                    depth: 0,
                    keyword: token,
                };
                entries.push(entry);
                stack.push({ kind: openerKind, entry });
                commandPosition = false;
                continue;
            }
            const closerKind: string | undefined = ShellClosers.get(token);
            if (closerKind !== (void 0)) {
                for (let openIndex: number = stack.length - 1; openIndex >= 0; openIndex -= 1) {
                    if (stack[openIndex].kind !== closerKind) {
                        continue;
                    }
                    stack[openIndex].entry.endLine = line;
                    stack.length = openIndex;
                    break;
                }
                commandPosition = false;
                continue;
            }
            if (ShellCommandPrefixes.has(token)) {
                commandPosition = true;
                continue;
            }
            commandPosition = false;
        }
    }
    while (stack.length > 0) {
        const frame: { readonly kind: string; readonly entry: ShellEntry; } | undefined = stack.pop();
        if (frame !== (void 0)) {
            frame.entry.endLine = Math.max(frame.entry.startLine, source.totalLines);
        }
    }
    return entries;
};

/**
 * Lines that are `case` branch patterns rather than commands. Such a line is
 * skipped by declaration scanning so a pattern such as `foo=bar)` does not
 * become a variable.
 *
 * @param sections - Section entries produced by `collectSections`.
 * @param maskedLines - Masked source lines.
 * @returns 1-based line numbers of case branch patterns.
 */
const collectCasePatternLines: (sections: readonly ShellEntry[], maskedLines: readonly string[]) => Set<number> = (
    sections: readonly ShellEntry[], maskedLines: readonly string[],
): Set<number> => {
    const lines: Set<number> = new Set<number>();
    for (let sectionIndex: number = 0; sectionIndex < sections.length; sectionIndex += 1) {
        const section: ShellEntry = sections[sectionIndex];
        if (section.keyword !== "case") {
            continue;
        }
        for (let line: number = section.startLine + 1; line < section.endLine; line += 1) {
            if (ShellCasePattern.test((maskedLines[line - 1] ?? "").trim())) {
                lines.add(line);
            }
        }
    }
    return lines;
};

/**
 * Read the assignment names of one declaration line.
 *
 * The scan is deliberately shallow: it walks consecutive `NAME=value` words
 * and stops at the first word that is not an assignment, so a command argument
 * such as `echo A=1` is never treated as a declaration. Values are consumed
 * only to find the next word boundary; a masked value is a run of spaces, which
 * is exactly where the next assignment may start.
 *
 * @param line - Masked, trimmed declaration line.
 * @param from - Offset just after the optional declaration command and flags.
 * @returns Assignment names in source order.
 */
const readShellAssignments: (line: string, from: number) => string[] = (line: string, from: number): string[] => {
    const names: string[] = [];
    let cursor: number = from;
    while (cursor < line.length) {
        while (cursor < line.length && /\s/.test(line[cursor])) {
            cursor += 1;
        }
        if (cursor >= line.length) {
            break;
        }
        const match: RegExpExecArray | null = ShellAssignment.exec(line.slice(cursor));
        if (match === null) {
            break;
        }
        names.push(match[1]);
        cursor += match[0].length;
        while (cursor < line.length) {
            const character: string = line[cursor];
            if (/\s/.test(character) || ShellSeparators.has(character)) {
                break;
            }
            cursor += 1;
        }
    }
    return names;
};

/**
 * Collect assignment, `source`/`.` and `alias` declarations.
 *
 * @param context - Masked source and line views.
 * @param casePatternLines - Lines to skip because they are case patterns.
 * @returns Leaf entries in source order.
 */
const collectDeclarations: (context: ShellScanContext, casePatternLines: ReadonlySet<number>) => ShellEntry[] = (
    context: ShellScanContext, casePatternLines: ReadonlySet<number>,
): ShellEntry[] => {
    const entries: ShellEntry[] = [];
    const source: SourceLines = context.source;
    const maskedLines: readonly string[] = context.maskedLines;
    const visibleLines: readonly string[] = context.visibleLines;
    for (let line: number = 1; line <= source.totalLines; line += 1) {
        if (casePatternLines.has(line)) {
            continue;
        }
        const maskedLine: string = maskedLines[line - 1] ?? "";
        const trimmed: string = maskedLine.trim();
        if (trimmed.length === 0) {
            continue;
        }
        const detail: string = visibleLines[line - 1] ?? "";
        const sourceMatch: RegExpExecArray | null = ShellSourceCommand.exec(detail);
        if (sourceMatch !== null) {
            const target: string = sourceMatch[1] ?? sourceMatch[2] ?? sourceMatch[3] ?? "";
            if (target.length > 0) {
                entries.push({
                    label: target,
                    kind: "dependency",
                    startLine: line,
                    endLine: line,
                    depth: 0,
                    ...(detail.length === 0 ? {} : { detail }),
                });
            }
            continue;
        }
        const aliasMatch: RegExpExecArray | null = /^alias\s+/.exec(detail);
        if (aliasMatch !== null) {
            const argumentText: string = detail.slice(aliasMatch[0].length);
            const words: RegExpMatchArray | null = argumentText.match(ShellAliasWord);
            if (words !== null) {
                for (let index: number = 0; index < words.length; index += 1) {
                    const word: string = words[index];
                    const equals: number = word.indexOf("=");
                    if (equals <= 0) {
                        continue;
                    }
                    entries.push({
                        label: word.slice(0, equals),
                        kind: "property",
                        startLine: line,
                        endLine: line,
                        depth: 0,
                        ...(detail.length === 0 ? {} : { detail }),
                    });
                }
            }
            continue;
        }
        let cursor: number = 0;
        const prefixMatch: RegExpExecArray | null = ShellDeclarationPrefix.exec(trimmed);
        if (prefixMatch !== null) {
            cursor = prefixMatch[0].length;
            while (cursor < trimmed.length) {
                const flag: RegExpExecArray | null = /^\s+([+-][A-Za-z]+)(?=\s|$)/.exec(trimmed.slice(cursor));
                if (flag === null) {
                    break;
                }
                cursor += flag[0].length;
            }
        }
        const names: string[] = readShellAssignments(trimmed, cursor);
        for (let index: number = 0; index < names.length; index += 1) {
            const name: string = names[index];
            entries.push({
                label: name,
                kind: /^[A-Z][A-Z0-9_]*$/.test(name) ? "constant" : "variable",
                startLine: line,
                endLine: line,
                depth: 0,
                ...(detail.length === 0 ? {} : { detail }),
            });
        }
    }
    return entries;
};

/**
 * Assign each entry the number of open functions/sections that strictly contain
 * its start line, and sort entries by source position.
 *
 * A container never counts for its own declaration line (`start < line`), which
 * keeps a function header from becoming its own child. The active list is a
 * stack because shell blocks are properly nested; a container that ended before
 * the current line is popped before the next depth is measured.
 *
 * @param entries - Unordered entries; sorted in place by start line.
 */
const assignShellDepths: (entries: ShellEntry[]) => void = (entries: ShellEntry[]): void => {
    entries.sort((left: ShellEntry, right: ShellEntry): number => left.startLine - right.startLine);
    const active: ShellEntry[] = [];
    for (let index: number = 0; index < entries.length; index += 1) {
        const entry: ShellEntry = entries[index];
        while (active.length > 0 && active[active.length - 1].endLine < entry.startLine) {
            active.pop();
        }
        entry.depth = active.length;
        if (entry.kind === "function" || entry.kind === "section") {
            active.push(entry);
        }
    }
};

/**
 * Convert a draft tree into the public symbol shape. Anchor and byte range are
 * filled by the registry; the placeholder keeps the return value a complete
 * `OutlineNode` for direct parser tests.
 */
const draftToNode: (draft: DraftShellNode) => OutlineNode = (draft: DraftShellNode): OutlineNode => ({
    isFile: false,
    isDirectory: false,
    path: "",
    type: draft.kind,
    range: {
        startByte: 0n,
        endByte: 0n,
        startLine: BigInt(Math.max(1, draft.startLine)),
        endLine: BigInt(Math.max(draft.startLine, draft.endLine)),
    },
    label: draft.label,
    depth: Math.max(0, draft.depth),
    ...(draft.detail === (void 0) || draft.detail.length === 0 ? {} : { detail: draft.detail }),
    children: draft.children.map(draftToNode),
});

/**
 * Assemble sorted flat entries into a tree by depth.
 *
 * @param entries - Entries sorted by start line with depths assigned.
 * @returns Root symbol nodes.
 */
const assembleShell: (entries: readonly ShellEntry[]) => OutlineNode[] = (entries: readonly ShellEntry[]): OutlineNode[] => {
    const roots: DraftShellNode[] = [];
    const stack: DraftShellNode[] = [];
    for (let index: number = 0; index < entries.length; index += 1) {
        const entry: ShellEntry = entries[index];
        while (stack.length > 0 && stack[stack.length - 1].depth >= entry.depth) {
            stack.pop();
        }
        const draft: DraftShellNode = {
            label: entry.label,
            kind: entry.kind,
            startLine: entry.startLine,
            endLine: entry.endLine,
            depth: entry.depth,
            ...(entry.detail === (void 0) || entry.detail.length === 0 ? {} : { detail: entry.detail }),
            children: [],
        };
        if (stack.length === 0) {
            roots.push(draft);
        } else {
            stack[stack.length - 1].children.push(draft);
        }
        stack.push(draft);
    }
    return roots.map(draftToNode);
};

/**
 * Parse a shell/Bash/Zsh/Ksh script.
 *
 * Recognized declarations:
 *
 * - `name() { ... }`, `function name { ... }` and `function name() { ... }`
 *   become `function` nodes ending at the matching `}`;
 * - `NAME=value`, `export NAME=value`, `readonly NAME=value`,
 *   `declare -x NAME=value`, `typeset NAME=value` and `local NAME=value`
 *   become `variable` nodes; an all-uppercase name becomes `constant`;
 * - `source file` and `. file` become `dependency` nodes carrying the target;
 * - `alias name=value` becomes a `property` node (there is no `alias` kind in
 *   `OutlineKind`, and an alias is a named mutable binding);
 * - `if`/`fi`, `for`/`while`/`until`/`select`/`done` and `case`/`esac` become
 *   `section` nodes. `case` branch patterns are not nodes.
 *
 * Comments, single/double-quoted strings, `$(...)`, `${...}`, backtick
 * substitutions and here-document bodies are masked first, so a pseudo
 * declaration in data never produces a node.
 *
 * @param input - Decoded shell text.
 * @returns Symbol tree with 1-based line ranges.
 */
export const parseShell: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const mask: ShellMask = maskShellSource(input.text);
    const maskedLines: readonly string[] = splitLines(mask.text);
    const starts: readonly number[] = source.starts;
    const commentColumns: Map<number, number> = new Map<number, number>();
    for (let index: number = 0; index < mask.comments.length; index += 1) {
        const offset: number = mask.comments[index];
        const line: number = lineAtOffset(starts, offset);
        if (!commentColumns.has(line)) {
            commentColumns.set(line, offset - (starts[line - 1] ?? 0));
        }
    }
    const visibleLines: string[] = source.lines.map((raw: string, index: number): string => {
        const column: number | undefined = commentColumns.get(index + 1);
        return (column === (void 0) ? raw : raw.slice(0, column)).trim();
    });
    const context: ShellScanContext = {
        source,
        masked: mask.text,
        maskedLines,
        visibleLines,
        starts,
        braceClose: scanShellBraces(mask.text),
    };
    const functions: ShellEntry[] = collectFunctions(context);
    const sections: ShellEntry[] = collectSections(context);
    const casePatternLines: Set<number> = collectCasePatternLines(sections, maskedLines);
    const declarations: ShellEntry[] = collectDeclarations(context, casePatternLines);
    const entries: ShellEntry[] = [...functions, ...sections, ...declarations];
    assignShellDepths(entries);
    return assembleShell(entries);
};

/**
 * File extensions that identify a shell script.
 */
const ShellExtensions: readonly string[] = [".sh", ".bash", ".zsh", ".ksh"];

/**
 * Dotfiles that are shell startup scripts even though they have no extension.
 */
const ShellDotFiles: ReadonlySet<string> = new Set<string>([".bashrc", ".zshrc"]);

/**
 * Shebang for a Bourne-family shell, with or without `/usr/bin/env`.
 */
const ShellShebang: RegExp = /^#![ \t]*(?:(?:\S*\/)?env[ \t]+(?:-[A-Za-z]+[ \t]+)*(?:\S*\/)?|(?:\S*\/)?)(?:ba|z|k)?sh\b/;

/**
 * Drop a leading byte-order mark from a sniffed head before matching a shebang.
 */
const withoutBom: (head: string) => string = (head: string): string => (head.startsWith("\uFEFF") ? head.slice(1) : head);

/**
 * Whether a base name is a shell script by extension or startup dotfile name.
 */
const hasShellName: (name: string) => boolean = (name: string): boolean => {
    const lower: string = name.toLowerCase();
    if (ShellDotFiles.has(lower)) {
        return true;
    }
    const dot: number = lower.lastIndexOf(".");
    return dot > 0 && ShellExtensions.includes(lower.slice(dot));
};

/**
 * Shell/Bash outline strategy. Registration is intentionally owned by
 * `outlineStrategies.ts`; append this object to `builtinOutlineStrategies`
 * after the extension-based strategies and before `PlainTextStrategy` so a
 * shebang sniff cannot steal a file whose extension already has a parser.
 */
export const ShellStrategy: OutlineStrategy = {
    id: "shell",
    category: "code",
    language: "shell",
    matches: (input: OutlineMatchInput): boolean => hasShellName(input.name) || ShellShebang.test(withoutBom(input.head)),
    parse: parseShell,
};
