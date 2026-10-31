/**
 * SQL outline support for MySQL, SQLite, PostgreSQL, SQL Server and Oracle.
 *
 * The parser is a bounded hand-written scanner, like every other strategy in
 * this repository: an outline needs declarations, ranges and a few structural
 * relationships, not a full SQL grammar. The module has three layers:
 *
 * - `SqlDialectRegistry` scores dialect markers so one `.sql` file can be
 *   attributed to one of the five dialects. Scoring is additive and bounded.
 *   `postgresql` is the explicit fallback because a plain ANSI script carries
 *   no dialect-specific token; SQLite is only reported when SQLite markers are
 *   actually present.
 * - `parseSql` masks comments, quoted strings, quoted identifiers and
 *   PostgreSQL dollar-quoted bodies, splits the script into statements on
 *   `;`, `DELIMITER`, `GO` and the Oracle `/` terminator, then emits one node
 *   per recognized DDL object plus its columns and constraints.
 * - `SqlStrategy` registers the parser for `.sql` with category `data`.
 *
 * Selection is deliberately narrow: `matches` only accepts `.sql`, so adding
 * the strategy to `builtinOutlineStrategies` cannot change the strategy chosen
 * for any other extension or exact file name. The dialect itself is reported
 * through node `detail` (always prefixed with `<dialect>:`), because the
 * registry owns `OutlineResult.strategy` and its value must stay the stable
 * tag `sql`.
 *
 * Deterministic by construction: no filesystem access, no process spawn, no
 * third-party parser. Unterminated comments, strings or parentheses run to the
 * end of the text instead of throwing, because an outline of a half-written
 * migration is still useful. The parser is a heuristic scanner, not a SQL
 * parser: see `docs/testing/languages/sqlReport.md` for the exact limits.
 */
import type { OutlineMatchInput, OutlineParseInput, OutlineStrategy } from "./strategy.ts";
import type { OutlineKind, OutlineNode } from "./types.ts";

/**
 * SQL dialects this module can attribute and parse.
 */
export type SqlDialect = "mysql" | "sqlite" | "postgresql" | "sqlserver" | "oracle";

/**
 * One dialect detection marker.
 *
 * `pattern` is a regular expression source, compiled with the `gim` flags by the
 * registry. `weight` lets a distinctive token (a `VARCHAR2` column) outvote a
 * generic one (a bare `NUMBER`); it defaults to 1.
 */
export interface SqlDialectMarker {
    readonly pattern: string;
    readonly weight?: number;
}

/**
 * Registration description of one dialect: its stable id, a human label and
 * the markers whose occurrences contribute to its detection score.
 */
export interface SqlDialectDefinition {
    readonly dialect: SqlDialect;
    readonly label: string;
    readonly markers: readonly (string | SqlDialectMarker)[];
}

/**
 * Detection score of one dialect for one text.
 */
export interface SqlDialectScore {
    readonly dialect: SqlDialect;
    readonly score: number;
}

/**
 * The five supported dialects, in built-in registration order. Ties in
 * detection scoring are resolved by this order.
 */
export const SqlDialects: readonly SqlDialect[] = ["mysql", "sqlite", "postgresql", "sqlserver", "oracle"];

/**
 * Fallback dialect when no marker matches. A plain ANSI script is closer to
 * PostgreSQL than to any other supported dialect, so PostgreSQL is the honest
 * "unknown but standard" answer; SQLite has to earn detection with a real
 * SQLite marker.
 */
const SqlFallbackDialect: SqlDialect = "postgresql";

/**
 * Flags every marker is compiled with. `m` makes line anchors work, `i` matches
 * SQL keyword casing, and `g` allows the registry to count occurrences.
 */
const SqlMarkerFlags: string = "gim";

/**
 * Occurrences one marker may contribute. The cap keeps a generated dump with
 * 100k `GO` lines from dominating the score and bounds detection work.
 */
const MaxSqlMarkerHits: number = 16;

/**
 * One compiled marker with its effective weight.
 */
interface CompiledSqlMarker {
    readonly regex: RegExp;
    readonly weight: number;
}

/**
 * Whether a string is one of the five dialect ids.
 *
 * @param value - Candidate dialect string.
 * @returns `true` when the value is a supported dialect.
 */
const isSqlDialect: (value: string) => value is SqlDialect = (value: string): value is SqlDialect =>
    SqlDialects.includes(value as SqlDialect);

/**
 * Compile one marker and resolve its weight.
 *
 * @param dialect - Dialect the marker belongs to, used in error messages.
 * @param marker - Marker source or descriptor.
 * @returns Compiled marker.
 */
const compileSqlMarker: (dialect: SqlDialect, marker: string | SqlDialectMarker) => CompiledSqlMarker = (
    dialect: SqlDialect,
    marker: string | SqlDialectMarker,
): CompiledSqlMarker => {
    const descriptor: SqlDialectMarker = typeof(marker) === "string" ? { pattern: marker } : marker;
    if (typeof(descriptor) !== "object" || descriptor === null || typeof(descriptor.pattern) !== "string" || descriptor.pattern.length === 0) {
        throw new Error(`invalid SQL dialect marker: ${dialect}`);
    }
    const declared: number | undefined = descriptor.weight;
    const weight: number = declared === (void 0) || !Number.isFinite(declared) || declared <= 0 ? 1 : declared;
    try {
        return { regex: new RegExp(descriptor.pattern, SqlMarkerFlags), weight };
    } catch {
        throw new Error(`invalid SQL dialect marker: ${dialect}`);
    }
};

/**
 * Registry of SQL dialect definitions.
 *
 * Registration order is tie-break priority. A registry is intentionally small:
 * five built-in dialects, each described by markers instead of a grammar. A
 * consumer that only needs detection can use `DefaultSqlDialectRegistry`
 * directly; a consumer that wants an isolated table can create an empty
 * registry and register its own definitions.
 */
export class SqlDialectRegistry {
    private readonly order: SqlDialect[] = [];
    private readonly definitions: Map<SqlDialect, SqlDialectDefinition> = new Map<SqlDialect, SqlDialectDefinition>();
    private readonly compiled: Map<SqlDialect, readonly CompiledSqlMarker[]> = new Map<SqlDialect, readonly CompiledSqlMarker[]>();

    constructor(definitions: readonly SqlDialectDefinition[] = []) {
        for (let index: number = 0; index < definitions.length; index += 1) {
            this.register(definitions[index].dialect, definitions[index]);
        }
    }

    /**
     * Append one dialect definition.
     *
     * @param dialect - Dialect id; must match `definition.dialect`.
     * @param definition - Label and markers.
     */
    register(dialect: SqlDialect, definition: SqlDialectDefinition): void {
        if (!isSqlDialect(dialect)) {
            throw new Error("invalid SQL dialect");
        }
        if (typeof(definition) !== "object" || definition === null) {
            throw new Error("invalid SQL dialect definition");
        }
        if (definition.dialect !== dialect) {
            throw new Error(`SQL dialect mismatch: ${dialect}`);
        }
        if (this.definitions.has(dialect)) {
            throw new Error(`duplicate SQL dialect: ${dialect}`);
        }
        if (!Array.isArray(definition.markers) || definition.markers.length === 0) {
            throw new Error(`SQL dialect has no markers: ${dialect}`);
        }
        const compiled: CompiledSqlMarker[] = definition.markers.map(
            (marker: string | SqlDialectMarker): CompiledSqlMarker => compileSqlMarker(dialect, marker),
        );
        this.definitions.set(dialect, definition);
        this.compiled.set(dialect, compiled);
        this.order.push(dialect);
    }

    /**
     * Definitions in registration order.
     *
     * @returns Registered definitions.
     */
    list(): readonly SqlDialectDefinition[] {
        return this.order.map((dialect: SqlDialect): SqlDialectDefinition => this.definitions.get(dialect) as SqlDialectDefinition);
    }

    /**
     * Registered dialect ids in registration order.
     *
     * @returns Dialect ids.
     */
    dialects(): readonly SqlDialect[] {
        return [...this.order];
    }

    /**
     * Definition registered for one id.
     *
     * @param dialect - Dialect id.
     * @returns The definition, or `undefined` when it is not registered.
     */
    definitionOf(dialect: SqlDialect): SqlDialectDefinition | undefined {
        return this.definitions.get(dialect);
    }

    /**
     * Additive marker score for every registered dialect.
     *
     * Each marker contributes `min(occurrences, 16) * weight`; occurrences are
     * capped so algorithmically generated dumps cannot distort the score.
     *
     * @param text - Raw file text (markers are also searched in comments, which
     * is intentional: dump headers usually name the dialect).
     * @returns Score per registered dialect, in registration order.
     */
    scores(text: string): ReadonlyMap<SqlDialect, number> {
        const result: Map<SqlDialect, number> = new Map<SqlDialect, number>();
        for (let index: number = 0; index < this.order.length; index += 1) {
            const dialect: SqlDialect = this.order[index];
            const markers: readonly CompiledSqlMarker[] = this.compiled.get(dialect) ?? [];
            let total: number = 0;
            for (let markerIndex: number = 0; markerIndex < markers.length; markerIndex += 1) {
                const marker: CompiledSqlMarker = markers[markerIndex];
                let hits: number = 0;
                marker.regex.lastIndex = 0;
                let match: RegExpExecArray | null = marker.regex.exec(text);
                while (match !== null && hits < MaxSqlMarkerHits) {
                    hits += 1;
                    if (match[0].length === 0) {
                        marker.regex.lastIndex += 1;
                    }
                    match = marker.regex.exec(text);
                }
                marker.regex.lastIndex = 0;
                total += hits * marker.weight;
            }
            result.set(dialect, total);
        }
        return result;
    }

    /**
     * Best-scoring registered dialect.
     *
     * The highest score wins; a tie keeps the earlier registered dialect. When
     * every score is zero the fallback is PostgreSQL if it is registered (or if
     * the registry is empty), otherwise the first registered dialect.
     *
     * @param text - Raw file text.
     * @returns Detected dialect.
     */
    detect(text: string): SqlDialect {
        const scores: ReadonlyMap<SqlDialect, number> = this.scores(text);
        let best: SqlDialect = this.order[0] ?? SqlFallbackDialect;
        let bestScore: number = 0;
        for (let index: number = 0; index < this.order.length; index += 1) {
            const dialect: SqlDialect = this.order[index];
            const score: number = scores.get(dialect) ?? 0;
            if (score > bestScore) {
                best = dialect;
                bestScore = score;
            }
        }
        if (bestScore > 0) {
            return best;
        }
        return this.definitions.has(SqlFallbackDialect) ? SqlFallbackDialect : best;
    }
}

/**
 * Built-in marker sets.
 *
 * The markers are the documented dialect fingerprints: MySQL
 * `AUTO_INCREMENT`/`ENGINE=`/`UNSIGNED` plus the client-side `DELIMITER`
 * directive, SQLite `AUTOINCREMENT`/`PRAGMA`/`WITHOUT ROWID`, PostgreSQL
 * `SERIAL`/`BIGSERIAL`/`::`/`RETURNING`, SQL Server `IDENTITY`/bracketed
 * identifiers/`GO`/`NVARCHAR`, and Oracle
 * `NUMBER`/`VARCHAR2`/`NVARCHAR2`/`DUAL`/`ROWNUM`/`CONNECT BY`/`SEQ_`/`IDENTITY`/
 * `PL/SQL`/the `/` block terminator.
 */
const BuiltinSqlDialectDefinitions: readonly SqlDialectDefinition[] = [
    {
        dialect: "mysql",
        label: "MySQL",
        markers: [
            { pattern: "AUTO_INCREMENT", weight: 3 },
            { pattern: "ENGINE\\s*=", weight: 3 },
            { pattern: "\\bUNSIGNED\\b", weight: 1 },
            { pattern: "^[ \\t]*DELIMITER\\b", weight: 3 },
        ],
    },
    {
        dialect: "sqlite",
        label: "SQLite",
        markers: [
            { pattern: "\\bAUTOINCREMENT\\b", weight: 3 },
            { pattern: "\\bPRAGMA\\b", weight: 2 },
            { pattern: "WITHOUT\\s+ROWID", weight: 3 },
        ],
    },
    {
        dialect: "postgresql",
        label: "PostgreSQL",
        markers: [
            { pattern: "\\bBIGSERIAL\\b", weight: 3 },
            { pattern: "\\bSERIAL\\b", weight: 2 },
            { pattern: "::", weight: 2 },
            { pattern: "\\bRETURNING\\b", weight: 2 },
        ],
    },
    {
        dialect: "sqlserver",
        label: "SQL Server",
        markers: [
            { pattern: "\\bIDENTITY\\b", weight: 2 },
            { pattern: "\\[[^\\]]+\\]", weight: 1 },
            { pattern: "^[ \\t]*GO(?:[ \\t]+\\d+)?[ \\t]*$", weight: 3 },
            { pattern: "\\bNVARCHAR\\b", weight: 3 },
        ],
    },
    {
        dialect: "oracle",
        label: "Oracle",
        markers: [
            { pattern: "\\bNUMBER\\b", weight: 1 },
            { pattern: "\\bVARCHAR2\\b", weight: 3 },
            { pattern: "\\bNVARCHAR2\\b", weight: 3 },
            { pattern: "\\bDUAL\\b", weight: 3 },
            { pattern: "\\bROWNUM\\b", weight: 3 },
            { pattern: "CONNECT\\s+BY", weight: 3 },
            { pattern: "\\bSEQ_", weight: 2 },
            { pattern: "GENERATED\\s+(?:ALWAYS|BY\\s+DEFAULT)\\s+AS\\s+IDENTITY", weight: 3 },
            { pattern: "\\bIDENTITY\\b", weight: 1 },
            { pattern: "PL/SQL", weight: 3 },
            { pattern: "^[ \\t]*/[ \\t]*$", weight: 2 },
        ],
    },
];

/**
 * Registry with every built-in dialect. Detection uses this instance through
 * `detectSqlDialect`.
 */
export const DefaultSqlDialectRegistry: SqlDialectRegistry = new SqlDialectRegistry(BuiltinSqlDialectDefinitions);
export { DefaultSqlDialectRegistry as defaultSqlDialectRegistry };

/**
 * Create an empty dialect registry without built-ins.
 *
 * @returns A registry with no definitions.
 */
export const createSqlDialectRegistry: () => SqlDialectRegistry = (): SqlDialectRegistry => new SqlDialectRegistry();

/**
 * Detect the dialect of one SQL text using the built-in marker sets.
 *
 * @param text - Raw SQL text.
 * @returns Detected dialect; PostgreSQL when no marker matches.
 */
export const detectSqlDialect: (text: string) => SqlDialect = (text: string): SqlDialect => DefaultSqlDialectRegistry.detect(text);

/**
 * One decoded source with line helpers. The parser keeps the same offset space
 * as the input text so a masked copy and a raw slice line up exactly.
 */
interface SourceLines {
    readonly text: string;
    readonly lines: readonly string[];
    readonly starts: readonly number[];
    readonly totalLines: number;
}

/**
 * Line starts of a text, using `\n` as the only separator so a `\r` still
 * belongs to its line for offset purposes.
 *
 * @param text - Decoded text.
 * @returns Absolute offset of each line start.
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
 * Split into logical lines, stripping a trailing carriage return and dropping
 * the phantom empty line a trailing newline would create.
 *
 * @param text - Decoded text.
 * @returns Lines without terminators.
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
 *
 * @param starts - Line start offsets.
 * @param offset - Absolute offset; values past the end clamp to the last line.
 * @returns 1-based line number.
 */
const lineAtOffset: (starts: readonly number[], offset: number) => number = (starts: readonly number[], offset: number): number => {
    if (starts.length === 0) {
        return 1;
    }
    const bounded: number = Math.max(0, Math.min(offset, Math.max(0, starts[starts.length - 1])));
    let low: number = 0;
    let high: number = starts.length - 1;
    while (low < high) {
        const middle: number = Math.ceil((low + high) / 2);
        if (starts[middle] <= bounded) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return low + 1;
};

/**
 * Read a source once and keep every line view consistent.
 *
 * @param text - Decoded text.
 * @returns Source view.
 */
const readSourceLines: (text: string) => SourceLines = (text: string): SourceLines => {
    const lines: string[] = splitLines(text);
    return { text, lines, starts: lineStartsOf(text), totalLines: lines.length };
};

/**
 * Skip whitespace from one absolute offset. Newlines are included because SQL
 * freely wraps a name, a `REFERENCES` clause or a table body across lines.
 *
 * @param text - Text being scanned.
 * @param offset - Start offset.
 * @returns First offset whose character is not whitespace.
 */
const skipSqlSpaces: (text: string, offset: number) => number = (text: string, offset: number): number => {
    let cursor: number = offset;
    while (cursor < text.length && /\s/.test(text[cursor])) {
        cursor += 1;
    }
    return cursor;
};

/**
 * Masking switches for one dialect.
 *
 * All flags exist because SQL dialects disagree about comment and quoting
 * syntax: `#` is a MySQL comment but a SQL Server temp-table prefix, brackets
 * quote identifiers only in SQL Server, `$$...$$` bodies only exist in
 * PostgreSQL, and only MySQL treats a backslash as a string escape.
 */
interface SqlMaskOptions {
    readonly hashComments: boolean;
    readonly backslashEscapes: boolean;
    readonly nestedBlockComments: boolean;
    readonly bracketQuotes: boolean;
    readonly dollarQuotes: boolean;
}

/**
 * Whether an offset is preceded only by spaces/tabs on its line. Used for `#`,
 * which is a MySQL comment anywhere but is a SQL Server temp-table prefix only
 * after an identifier, so a line-leading `#` can be masked in every dialect.
 *
 * @param text - Raw text.
 * @param index - Absolute offset of the `#`.
 * @returns `true` when nothing but indentation precedes the character.
 */
const atSqlLineStart: (text: string, index: number) => boolean = (text: string, index: number): boolean => {
    for (let cursor: number = index - 1; cursor >= 0; cursor -= 1) {
        const character: string = text[cursor];
        if (character === "\n") {
            return true;
        }
        if (character !== " " && character !== "\t") {
            return false;
        }
    }
    return true;
};

/**
 * Mask comments, strings and quoted identifiers while preserving every offset
 * and line break.
 *
 * Masked regions become spaces; a line break inside a multi-line string or
 * block comment stays a line break so line numbers do not shift. The scanner
 * is single-pass and bounded: it never allocates a token list, and an
 * unterminated construct runs to the end of the text instead of throwing.
 *
 * @param text - Decoded SQL text.
 * @param options - Dialect-specific masking switches.
 * @returns Masked text with identical length and line breaks.
 */
const maskSql: (text: string, options: SqlMaskOptions) => string = (text: string, options: SqlMaskOptions): string => {
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
        if (character === "-" && text[index + 1] === "-") {
            const newline: number = text.indexOf("\n", index);
            const stop: number = newline === -1 ? length : newline;
            blank(index, stop);
            index = stop;
            continue;
        }
        if (character === "#" && (options.hashComments || atSqlLineStart(text, index))) {
            const newline: number = text.indexOf("\n", index);
            const stop: number = newline === -1 ? length : newline;
            blank(index, stop);
            index = stop;
            continue;
        }
        if (character === "/" && text[index + 1] === "*") {
            let cursor: number = index + 2;
            let depth: number = 1;
            while (cursor < length) {
                if (options.nestedBlockComments && text[cursor] === "/" && text[cursor + 1] === "*") {
                    depth += 1;
                    cursor += 2;
                    continue;
                }
                if (text[cursor] === "*" && text[cursor + 1] === "/") {
                    depth -= 1;
                    cursor += 2;
                    if (depth === 0) {
                        break;
                    }
                    continue;
                }
                cursor += 1;
            }
            blank(index, cursor);
            index = cursor;
            continue;
        }
        if (character === "'" || character === '"' || character === "`") {
            let cursor: number = index + 1;
            while (cursor < length) {
                const current: string = text[cursor];
                if (options.backslashEscapes && current === "\\") {
                    cursor += 2;
                    continue;
                }
                if (current === character) {
                    if (text[cursor + 1] === character) {
                        cursor += 2;
                        continue;
                    }
                    cursor += 1;
                    break;
                }
                cursor += 1;
            }
            /**
             * A single-quoted value is a string literal and disappears
             * completely. A double-quoted or backtick-quoted value is an
             * identifier: its body still disappears (so a comma or semicolon
             * inside a quoted name is never syntax), but the opening delimiter
             * stays visible so a table-body item that starts with a quoted
             * column name keeps its real start offset.
             */
            blank(index + 1, cursor);
            masked[index] = character === "'" ? " " : character;
            index = cursor;
            continue;
        }
        if (options.bracketQuotes && character === "[") {
            let cursor: number = index + 1;
            while (cursor < length) {
                if (text[cursor] === "]") {
                    if (text[cursor + 1] === "]") {
                        cursor += 2;
                        continue;
                    }
                    cursor += 1;
                    break;
                }
                cursor += 1;
            }
            blank(index + 1, cursor);
            masked[index] = "[";
            index = cursor;
            continue;
        }
        if (options.dollarQuotes && character === "$") {
            const opener: RegExpExecArray | null = /^\$[A-Za-z0-9_]*\$/.exec(text.slice(index, index + 64));
            if (opener !== null) {
                const closing: number = text.indexOf(opener[0], index + opener[0].length);
                const stop: number = closing === -1 ? length : closing + opener[0].length;
                blank(index, stop);
                index = stop;
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
 * One `DELIMITER` client directive. MySQL's command-line client changes the
 * statement terminator with this line, so the outline must follow it.
 */
interface SqlDelimiterDirective {
    readonly line: number;
    readonly token: string;
}

/**
 * Client directive line: `DELIMITER $$`, `DELIMITER ;`.
 */
const SqlDelimiterLine: RegExp = /^\s*DELIMITER\s+(\S+)\s*$/i;

/**
 * Collect `DELIMITER` directives by 0-based line number.
 *
 * @param lines - Source lines without terminators.
 * @returns Directives in source order.
 */
const findSqlDelimiterDirectives: (lines: readonly string[]) => SqlDelimiterDirective[] = (lines: readonly string[]): SqlDelimiterDirective[] => {
    const directives: SqlDelimiterDirective[] = [];
    for (let line: number = 0; line < lines.length; line += 1) {
        const match: RegExpExecArray | null = SqlDelimiterLine.exec(lines[line]);
        if (match !== null) {
            directives.push({ line, token: match[1] });
        }
    }
    return directives;
};

/**
 * Blank `DELIMITER` directive lines in the masked text. The directive is client
 * syntax rather than a SQL statement, so it must not become statement content;
 * blanking preserves offsets and line breaks.
 *
 * @param masked - Masked text.
 * @param text - Raw text, used to preserve line breaks.
 * @param starts - Line start offsets.
 * @param directives - Directives to blank.
 * @returns Masked text with directive lines removed.
 */
const blankSqlDirectiveLines: (masked: string, text: string, starts: readonly number[], directives: readonly SqlDelimiterDirective[]) => string = (
    masked: string,
    text: string,
    starts: readonly number[],
    directives: readonly SqlDelimiterDirective[],
): string => {
    if (directives.length === 0) {
        return masked;
    }
    const characters: string[] = masked.split("");
    for (let index: number = 0; index < directives.length; index += 1) {
        const line: number = directives[index].line;
        const from: number = starts[line] ?? 0;
        const to: number = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
        for (let cursor: number = from; cursor < to; cursor += 1) {
            characters[cursor] = text[cursor] === "\n" ? "\n" : " ";
        }
    }
    return characters.join("");
};

/**
 * Why a statement ended. A delimiter-terminated statement is soft (a routine
 * body may continue past it); `GO`, `/` and a `DELIMITER` line are hard batch
 * boundaries and stop routine merging.
 */
type SqlBoundaryKind = "delimiter" | "batch" | "slash";

/**
 * One statement boundary discovered on a dedicated line.
 */
interface SqlBoundary {
    readonly kind: SqlBoundaryKind;
    readonly token?: string;
}

/**
 * SQL Server batch separator, optionally with a repeat count (`GO 5`).
 */
const SqlBatchLine: RegExp = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*$/i;

/**
 * Oracle SQL*Plus block terminator: a line containing only `/`.
 */
const SqlSlashLine: RegExp = /^[ \t]*\/[ \t]*$/;

/**
 * Build the line-keyed boundary table.
 *
 * `GO` is accepted in every dialect because a standalone `GO` line is not valid
 * SQL content anywhere; the Oracle `/` terminator is only accepted for Oracle
 * so a division line is never mistaken for structure.
 *
 * @param starts - Line start offsets.
 * @param maskedLines - Masked lines.
 * @param directives - `DELIMITER` directives.
 * @param dialect - Detected dialect.
 * @returns Boundary per line-start offset.
 */
const sqlBoundaries: (
    starts: readonly number[],
    maskedLines: readonly string[],
    directives: readonly SqlDelimiterDirective[],
    dialect: SqlDialect,
) => Map<number, SqlBoundary> = (
    starts: readonly number[],
    maskedLines: readonly string[],
    directives: readonly SqlDelimiterDirective[],
    dialect: SqlDialect,
): Map<number, SqlBoundary> => {
    const boundaries: Map<number, SqlBoundary> = new Map<number, SqlBoundary>();
    const directiveLines: Set<number> = new Set<number>();
    for (let index: number = 0; index < directives.length; index += 1) {
        directiveLines.add(directives[index].line);
        boundaries.set(starts[directives[index].line] ?? 0, { kind: "delimiter", token: directives[index].token });
    }
    for (let line: number = 0; line < maskedLines.length; line += 1) {
        if (directiveLines.has(line)) {
            continue;
        }
        if (SqlBatchLine.test(maskedLines[line])) {
            boundaries.set(starts[line] ?? 0, { kind: "batch" });
            continue;
        }
        if (dialect === "oracle" && SqlSlashLine.test(maskedLines[line])) {
            boundaries.set(starts[line] ?? 0, { kind: "slash" });
        }
    }
    return boundaries;
};

/**
 * One statement span in absolute offsets. `start` and `end` are trimmed to the
 * first and last non-space character of the masked statement.
 */
interface SqlSegment {
    readonly start: number;
    readonly end: number;
    readonly hardEnd: boolean;
}

/**
 * Split masked SQL into statements.
 *
 * The scanner tracks parenthesis depth so a `;` inside a function argument list
 * is not a terminator, follows `DELIMITER` tokens, and treats `GO`/`/` lines as
 * hard boundaries. It is not a grammar: a semicolon inside a MySQL routine body
 * still terminates the statement unless the script declares `DELIMITER`, which
 * is exactly the rule the MySQL client itself applies.
 *
 * @param masked - Masked SQL text.
 * @param starts - Line start offsets.
 * @param boundaries - Line-keyed hard boundaries.
 * @returns Trimmed statements in source order.
 */
const splitSqlStatements: (masked: string, starts: readonly number[], boundaries: ReadonlyMap<number, SqlBoundary>) => SqlSegment[] = (
    masked: string,
    starts: readonly number[],
    boundaries: ReadonlyMap<number, SqlBoundary>,
): SqlSegment[] => {
    const segments: SqlSegment[] = [];
    let delimiter: string = ";";
    let statementStart: number = 0;
    let parenDepth: number = 0;
    const close: (end: number, hardEnd: boolean) => void = (end: number, hardEnd: boolean): void => {
        let from: number = statementStart;
        let to: number = Math.min(end, masked.length);
        while (from < to && /\s/.test(masked[from])) {
            from += 1;
        }
        while (to > from && /\s/.test(masked[to - 1])) {
            to -= 1;
        }
        if (to > from) {
            segments.push({ start: from, end: to, hardEnd });
        }
    };
    for (let line: number = 0; line < starts.length; line += 1) {
        const lineStart: number = starts[line];
        const lineEnd: number = line + 1 < starts.length ? starts[line + 1] - 1 : masked.length;
        const boundary: SqlBoundary | undefined = boundaries.get(lineStart);
        if (boundary !== (void 0)) {
            close(lineStart, true);
            if (boundary.kind === "delimiter") {
                delimiter = boundary.token ?? ";";
            }
            statementStart = Math.min(masked.length, lineEnd + 1);
            parenDepth = 0;
            continue;
        }
        let index: number = lineStart;
        while (index < lineEnd) {
            const character: string = masked[index];
            if (character === "(") {
                parenDepth += 1;
                index += 1;
                continue;
            }
            if (character === ")") {
                parenDepth = Math.max(0, parenDepth - 1);
                index += 1;
                continue;
            }
            if (parenDepth === 0 && masked.startsWith(delimiter, index) && index + delimiter.length <= masked.length) {
                close(index, false);
                index += delimiter.length;
                statementStart = index;
                continue;
            }
            index += 1;
        }
    }
    close(masked.length, true);
    return segments;
};

/**
 * Statements that own an executable body and therefore may need to swallow
 * soft-terminated fragments: PL/SQL blocks, T-SQL procedures and triggers.
 */
const RoutineStatement: RegExp =
    /^\s*CREATE\s+(?:(?:OR\s+(?:REPLACE|ALTER))\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED|MATERIALIZED|UNIQUE|NONCLUSTERED|CLUSTERED)\s+)*(?:FUNCTION|PROCEDURE|TRIGGER|PACKAGE)\b/i;

/**
 * Tail of a closed routine body: `END`, `END;` or `END name;`.
 */
const RoutineEndTail: RegExp = /\bEND(?:\s+([\p{L}_][\p{L}\p{N}_$]*))?\s*;?\s*$/iu;

/**
 * Words after `END` that belong to a nested block (`END IF`, `END LOOP`, ...)
 * rather than to the routine body.
 */
const RoutineBlockTailWords: ReadonlySet<string> = new Set<string>(["if", "loop", "case", "while", "repeat", "for"]);

/**
 * Tokens used to track whether a routine body's block structure is closed.
 * Only words and parentheses matter; punctuation is ignored.
 */
const SqlRoutineTokens: RegExp = /[A-Za-z_][A-Za-z0-9_$]*|[()]/g;

/**
 * Words that turn a `BEGIN` into a transaction statement instead of a block.
 */
const RoutineTransactionWords: ReadonlySet<string> = new Set<string>(["TRANSACTION", "TRAN", "DISTRIBUTED", "WORK"]);

/**
 * Words that close a construct other than the routine body itself. They follow
 * `END` and were already consumed by the matching opener.
 */
const RoutineEndLabels: ReadonlySet<string> = new Set<string>(["IF", "LOOP", "CASE", "WHILE", "REPEAT", "FOR"]);

/**
 * Whether the accumulated routine text closes on a real `END`.
 *
 * @param masked - Accumulated masked routine statement.
 * @returns `true` when the last token is `END` (not `END IF`, `END LOOP`, ...).
 */
const endsWithRoutineEnd: (masked: string) => boolean = (masked: string): boolean => {
    const match: RegExpExecArray | null = RoutineEndTail.exec(masked);
    if (match === null) {
        return false;
    }
    return !RoutineBlockTailWords.has((match[1] ?? "").toLowerCase());
};

/**
 * Whether a routine statement has reached its complete form.
 *
 * The scanner keeps a small block stack instead of counting `BEGIN` and `END`
 * occurrences: a `CASE ... END` expression, an `IF ... END IF` statement and a
 * `LOOP ... END LOOP` statement each close their own construct, so the routine
 * only ends when the stack is empty and the tail is a real `END`. Counting
 * alone would stop a procedure at the first `CASE ... END` inside a `SELECT`.
 *
 * Oracle routines additionally require the `BEGIN` because their declarations
 * run from `AS`/`IS` to the first `BEGIN`; for every other dialect a routine
 * without `BEGIN` (`CREATE PROCEDURE ... AS SELECT ...;`) is complete at its
 * own terminator.
 *
 * @param masked - Accumulated masked statement.
 * @param dialect - Detected dialect.
 * @returns `true` when no further fragment belongs to the routine.
 */
const routineBodyComplete: (masked: string, dialect: SqlDialect) => boolean = (masked: string, dialect: SqlDialect): boolean => {
    const tokens: string[] = [];
    SqlRoutineTokens.lastIndex = 0;
    let match: RegExpExecArray | null = SqlRoutineTokens.exec(masked);
    while (match !== null) {
        tokens.push(match[0].toUpperCase());
        match = SqlRoutineTokens.exec(masked);
    }
    const stack: string[] = [];
    let opened: boolean = false;
    for (let index: number = 0; index < tokens.length; index += 1) {
        const token: string = tokens[index];
        const next: string = tokens[index + 1] ?? "";
        if (token === "BEGIN") {
            if (RoutineTransactionWords.has(next)) {
                continue;
            }
            stack.push(token);
            opened = true;
            continue;
        }
        if (token === "CASE") {
            stack.push(token);
            continue;
        }
        if (token === "IF" && (dialect === "oracle" || dialect === "mysql")) {
            if (next !== "NOT" && next !== "EXISTS" && next !== "(") {
                stack.push(token);
            }
            continue;
        }
        if (token === "LOOP" && (dialect === "oracle" || dialect === "mysql")) {
            stack.push(token);
            continue;
        }
        if (token === "WHILE" && dialect === "mysql") {
            stack.push(token);
            continue;
        }
        if (token === "REPEAT" && dialect === "mysql") {
            stack.push(token);
            continue;
        }
        if (token === "END") {
            stack.pop();
            if (RoutineEndLabels.has(next)) {
                index += 1;
            }
        }
    }
    if (!opened) {
        return dialect !== "oracle";
    }
    return stack.length === 0 && endsWithRoutineEnd(masked);
};

/**
 * Merge soft fragments that still belong to one routine body.
 *
 * The MySQL client needs `DELIMITER` and PostgreSQL has dollar quoting, but
 * SQL Server, SQLite and Oracle scripts commonly write a `BEGIN ... END` body
 * with plain semicolons. Without merging, such a routine node would end at its
 * first inner statement. Merging stops at a hard boundary (`GO`, `/`, a
 * `DELIMITER` line), at a completed body, or after 512 fragments.
 *
 * @param segments - Statements from `splitSqlStatements`.
 * @param masked - Masked SQL text.
 * @param dialect - Detected dialect.
 * @returns Statements with routine bodies joined.
 */
const mergeRoutineStatements: (segments: readonly SqlSegment[], masked: string, dialect: SqlDialect) => SqlSegment[] = (
    segments: readonly SqlSegment[],
    masked: string,
    dialect: SqlDialect,
): SqlSegment[] => {
    const merged: SqlSegment[] = [];
    let index: number = 0;
    while (index < segments.length) {
        const segment: SqlSegment = segments[index];
        const head: string = masked.slice(segment.start, segment.end);
        if (!RoutineStatement.test(head)) {
            merged.push(segment);
            index += 1;
            continue;
        }
        let end: number = segment.end;
        let hardEnd: boolean = segment.hardEnd;
        let consumed: number = 0;
        while (!routineBodyComplete(masked.slice(segment.start, end), dialect) && index + 1 < segments.length && consumed < 512) {
            index += 1;
            const next: SqlSegment = segments[index];
            end = next.end;
            hardEnd = next.hardEnd;
            consumed += 1;
            if (next.hardEnd) {
                break;
            }
        }
        merged.push({ start: segment.start, end, hardEnd });
        index += 1;
    }
    return merged;
};

/**
 * One SQL identifier segment.
 */
interface SqlName {
    readonly name: string;
    readonly end: number;
}

/**
 * A bare identifier: Unicode letters/digits, `_`, `$`, plus the SQL Server
 * `#`/`@` prefix so a temp table keeps its name.
 */
const SqlBareName: RegExp = /^[#@]?[\p{L}_][\p{L}\p{N}_$]*/u;

/**
 * A quoted identifier: `"x"`, `` `x` `` or `[x]`, with the doubled closing
 * character as the escape.
 */
const SqlQuotedName: RegExp = /^"(?:[^"]|"")*"|^`(?:[^`]|``)*`|^\[(?:[^\]]|\]\])*\]/u;

/**
 * Window used when reading one identifier. SQL identifiers are short; the
 * bound keeps a pathological file from allocating a huge slice per lookup.
 */
const SqlNameWindow: number = 512;

/**
 * Read one identifier segment at an offset, skipping leading spaces.
 *
 * @param text - Raw SQL text.
 * @param offset - Absolute offset.
 * @returns Decoded name and end offset, or `undefined`.
 */
const readSqlName: (text: string, offset: number) => SqlName | undefined = (text: string, offset: number): SqlName | undefined => {
    const cursor: number = skipSqlSpaces(text, offset);
    const window: string = text.slice(cursor, cursor + SqlNameWindow);
    const quoted: RegExpExecArray | null = SqlQuotedName.exec(window);
    if (quoted !== null) {
        const raw: string = quoted[0];
        const body: string = raw.slice(1, -1);
        const first: string = raw[0];
        const name: string = first === '"' ? body.replace(/""/g, '"') : first === "`" ? body.replace(/``/g, "`") : body.replace(/\]\]/g, "]");
        return name.length === 0 ? (void 0) : { name, end: cursor + raw.length };
    }
    const bare: RegExpExecArray | null = SqlBareName.exec(window);
    return bare === null ? (void 0) : { name: bare[0], end: cursor + bare[0].length };
};

/**
 * Read a dotted, possibly schema-qualified identifier.
 *
 * @param text - Raw SQL text.
 * @param offset - Absolute offset of the first segment.
 * @returns Decoded dotted name and end offset, or `undefined`.
 */
const readSqlQualifiedName: (text: string, offset: number) => SqlName | undefined = (text: string, offset: number): SqlName | undefined => {
    let cursor: number = offset;
    let name: string = "";
    let end: number = offset;
    let segments: number = 0;
    while (segments < 8) {
        const part: SqlName | undefined = readSqlName(text, cursor);
        if (part === (void 0)) {
            break;
        }
        name = segments === 0 ? part.name : `${name}.${part.name}`;
        end = part.end;
        segments += 1;
        const dot: number = skipSqlSpaces(text, end);
        if (text[dot] !== ".") {
            break;
        }
        cursor = skipSqlSpaces(text, dot + 1);
    }
    return segments === 0 ? (void 0) : { name, end };
};

/**
 * Declarative description of one outline node. Strategies only own line numbers
 * and the tree shape; the registry fills anchor path, byte range and final
 * depth, so the placeholder range keeps a direct parser test well-typed.
 */
interface SqlNodeSpec {
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
 * Build one placeholder-range node.
 *
 * @param spec - Node description.
 * @returns Outline node with zero byte range.
 */
const sqlNode: (spec: SqlNodeSpec) => OutlineNode = (spec: SqlNodeSpec): OutlineNode => {
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
 * Parsing context shared by the per-statement helpers.
 */
interface SqlBuildContext {
    readonly source: SourceLines;
    readonly masked: string;
    readonly dialect: SqlDialect;
}

/**
 * One top-level definition item inside a `CREATE TABLE` body or one
 * `ALTER TABLE` action, as absolute offsets into the masked text.
 */
interface SqlItem {
    readonly start: number;
    readonly end: number;
}

/**
 * Max characters kept in a column definition detail. The registry caps the
 * final detail at 200 characters; the tighter bound keeps a generated
 * `DEFAULT` expression from crowding out the type.
 */
const MaxSqlDefinitionLength: number = 120;

/**
 * Collapse whitespace and cut one column definition.
 *
 * The value is taken from the masked text, so a trailing `-- comment` or the
 * body of a `DEFAULT '...'` string cannot leak into the detail. Opening
 * identifier delimiters survive masking (they keep an item's real start
 * offset), so those are removed as well.
 *
 * @param value - Masked definition text.
 * @returns Normalized definition.
 */
const normalizeSqlDefinition: (value: string) => string = (value: string): string =>
    value.replace(/["`\[]/g, " ").replace(/\s+/g, " ").trim().slice(0, MaxSqlDefinitionLength);

/**
 * Split a parenthesized body or a comma-separated action list on top-level
 * commas while keeping parentheses balanced.
 *
 * @param masked - Masked SQL text.
 * @param from - Absolute start offset.
 * @param to - Absolute end offset.
 * @returns Trimmed items in source order.
 */
const splitSqlItems: (masked: string, from: number, to: number) => SqlItem[] = (masked: string, from: number, to: number): SqlItem[] => {
    const items: SqlItem[] = [];
    const append: (start: number, end: number) => void = (start: number, end: number): void => {
        let itemStart: number = start;
        let itemEnd: number = end;
        while (itemStart < itemEnd && /\s/.test(masked[itemStart])) {
            itemStart += 1;
        }
        while (itemEnd > itemStart && /\s/.test(masked[itemEnd - 1])) {
            itemEnd -= 1;
        }
        if (itemEnd > itemStart) {
            items.push({ start: itemStart, end: itemEnd });
        }
    };
    let start: number = from;
    let depth: number = 0;
    for (let index: number = from; index < to; index += 1) {
        const character: string = masked[index];
        if (character === "(") {
            depth += 1;
            continue;
        }
        if (character === ")") {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (character === "," && depth === 0) {
            append(start, index);
            start = index + 1;
        }
    }
    append(start, to);
    return items;
};

/**
 * Index of the `)` matching the `(` at `open`, or `-1` when it never closes.
 *
 * @param text - Masked text.
 * @param open - Absolute offset of `(`.
 * @param limit - Absolute offset that must not be crossed.
 * @returns Absolute offset of the matching `)`.
 */
const findMatchingParen: (text: string, open: number, limit: number) => number = (text: string, open: number, limit: number): number => {
    let depth: number = 0;
    for (let index: number = open; index < limit; index += 1) {
        const character: string = text[index];
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
 * Keywords that start a table-level constraint clause.
 */
const SqlConstraintKeywords: ReadonlySet<string> = new Set<string>([
    "PRIMARY",
    "FOREIGN",
    "UNIQUE",
    "CHECK",
    "KEY",
    "INDEX",
    "FULLTEXT",
    "SPATIAL",
    "EXCLUDE",
]);

/**
 * Words that can follow a `UNIQUE`/`KEY` clause without being an index name.
 * They guard `UNIQUE USING INDEX ...` and `UNIQUE NULLS NOT DISTINCT (...)`.
 */
const SqlConstraintNonNames: ReadonlySet<string> = new Set<string>([
    "USING",
    "INCLUDE",
    "WITH",
    "DEFERRABLE",
    "NULLS",
    "WHERE",
    "ON",
]);

/**
 * One recognized constraint head.
 */
interface SqlConstraintHead {
    readonly clause: string;
    readonly clauseStart: number;
    readonly name: string;
}

/**
 * Recognize a table-level constraint item.
 *
 * The optional `CONSTRAINT name` prefix is resolved from raw text because a
 * quoted constraint name is masked to spaces in the structural scan. The clause
 * keyword itself is read from the masked text so a `CHECK (... 'PRIMARY KEY')`
 * string can never fake a constraint.
 *
 * @param context - Parsing context.
 * @param start - Absolute item start.
 * @param end - Absolute item end.
 * @returns Constraint head, or `undefined` when the item is a column.
 */
const readSqlConstraintHead: (context: SqlBuildContext, start: number, end: number) => SqlConstraintHead | undefined = (
    context: SqlBuildContext,
    start: number,
    end: number,
): SqlConstraintHead | undefined => {
    const raw: string = context.source.text;
    const masked: string = context.masked;
    const lead: RegExpExecArray | null = /^\s*CONSTRAINT\b/i.exec(masked.slice(start, end));
    let offset: number = start;
    let name: string = "";
    if (lead !== null) {
        const after: number = start + lead[0].length;
        const quotedStart: number = skipSqlSpaces(raw, after);
        const firstCharacter: string = raw[quotedStart] ?? "";
        if (firstCharacter === '"' || firstCharacter === "`" || firstCharacter === "[") {
            const quoted: SqlName | undefined = readSqlQualifiedName(raw, quotedStart);
            if (quoted !== (void 0)) {
                name = quoted.name;
                offset = quoted.end;
            } else {
                offset = quotedStart;
            }
        } else {
            const token: SqlName | undefined = readSqlQualifiedName(raw, quotedStart);
            if (token !== (void 0) && !SqlConstraintKeywords.has(token.name.toUpperCase())) {
                name = token.name;
                offset = token.end;
            } else {
                offset = quotedStart;
            }
        }
    }
    const clause: RegExpExecArray | null =
        /^\s*(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|KEY|INDEX|FULLTEXT|SPATIAL|EXCLUDE)\b/i.exec(masked.slice(offset, end));
    if (clause === null) {
        return (void 0);
    }
    const clauseText: string = clause[1].replace(/\s+/g, " ").toUpperCase();
    const clauseStart: number = offset + clause.index + (clause[0].length - clause[1].length);
    let indexName: string = "";
    if (
        name.length === 0 &&
        (clauseText === "UNIQUE" || clauseText === "KEY" || clauseText === "INDEX" || clauseText === "FULLTEXT" || clauseText === "SPATIAL")
    ) {
        const keywordEnd: number = offset + clause.index + clause[0].length;
        const tail: RegExpExecArray | null = /^\s*(?:KEY|INDEX)\b/i.exec(masked.slice(keywordEnd, end));
        const afterTail: number = keywordEnd + (tail === null ? 0 : tail[0].length);
        const rawStart: number = skipSqlSpaces(raw, afterTail);
        if (raw[rawStart] !== "(") {
            const candidate: SqlName | undefined = readSqlName(raw, rawStart);
            if (candidate !== (void 0) && !SqlConstraintNonNames.has(candidate.name.toUpperCase())) {
                indexName = candidate.name;
            }
        }
    }
    return { clause: clauseText, clauseStart, name: name.length > 0 ? name : indexName };
};

/**
 * Read the target table of a `REFERENCES` clause.
 *
 * @param context - Parsing context.
 * @param from - Absolute offset to search from.
 * @param to - Absolute offset to stop at.
 * @returns Dotted target name, or an empty string.
 */
const readSqlReferencesTarget: (context: SqlBuildContext, from: number, to: number) => string = (
    context: SqlBuildContext,
    from: number,
    to: number,
): string => {
    const references: RegExpExecArray | null = /\bREFERENCES\b/i.exec(context.masked.slice(from, to));
    if (references === null) {
        return "";
    }
    const target: SqlName | undefined = readSqlQualifiedName(context.source.text, from + references.index + references[0].length);
    return target === (void 0) ? "" : target.name;
};

/**
 * Read the table a trigger or index attaches to (`... ON <table>`).
 *
 * @param context - Parsing context.
 * @param from - Absolute offset to search from.
 * @param to - Absolute offset to stop at.
 * @returns Dotted target name, or an empty string.
 */
const readSqlOnTarget: (context: SqlBuildContext, from: number, to: number) => string = (
    context: SqlBuildContext,
    from: number,
    to: number,
): string => {
    const on: RegExpExecArray | null = /\bON\b/i.exec(context.masked.slice(from, to));
    if (on === null) {
        return "";
    }
    const target: SqlName | undefined = readSqlQualifiedName(context.source.text, from + on.index + on[0].length);
    return target === (void 0) ? "" : target.name;
};

/**
 * Build one table-level constraint node.
 *
 * Kind mapping: `PRIMARY KEY`, `UNIQUE`, `CHECK`, `KEY`, `INDEX`, `FULLTEXT`,
 * `SPATIAL` and `EXCLUDE` become `key`; `FOREIGN KEY` becomes `dependency`
 * because it points at another table. A `REFERENCES` clause is only a
 * column-level `reference` node.
 *
 * @param context - Parsing context.
 * @param start - Absolute item start.
 * @param end - Absolute item end.
 * @param depth - Node depth.
 * @returns Constraint node, or `undefined` when the item is not a constraint.
 */
const sqlConstraintNode: (context: SqlBuildContext, start: number, end: number, depth: number) => OutlineNode | undefined = (
    context: SqlBuildContext,
    start: number,
    end: number,
    depth: number,
): OutlineNode | undefined => {
    const head: SqlConstraintHead | undefined = readSqlConstraintHead(context, start, end);
    if (head === (void 0)) {
        return (void 0);
    }
    const foreign: boolean = head.clause === "FOREIGN KEY";
    const target: string = foreign ? readSqlReferencesTarget(context, head.clauseStart, end) : "";
    const descriptor: string =
        foreign && target.length > 0 ? `foreign key -> ${target}` : head.clause.toLowerCase();
    const label: string = head.name.length > 0 ? head.name : descriptor;
    return sqlNode({
        label,
        kind: foreign ? "dependency" : "key",
        startLine: lineAtOffset(context.source.starts, start),
        endLine: lineAtOffset(context.source.starts, Math.max(start, end - 1)),
        depth,
        detail: `${context.dialect}:${descriptor}`,
    });
};

/**
 * One inline column constraint pattern.
 */
interface SqlInlineConstraint {
    readonly pattern: RegExp;
    readonly label: string;
}

/**
 * Inline column constraints reported as children of a column. `REFERENCES` is
 * handled separately because it carries a target name.
 */
const SqlInlineConstraints: readonly SqlInlineConstraint[] = [
    { pattern: /\bPRIMARY\s+KEY\b/i, label: "primary key" },
    { pattern: /\bUNIQUE\b/i, label: "unique" },
    { pattern: /\bCHECK\b/i, label: "check" },
];

/**
 * Build one column node.
 *
 * A column is `property`; its `detail` is the normalized type/definition text
 * prefixed with the dialect. Inline `PRIMARY KEY`, `UNIQUE`, `CHECK` and
 * `REFERENCES` clauses become depth-2 children (`key`/`reference`), so a
 * `REFERENCES other(id)` edge is visible without re-reading the file.
 *
 * @param context - Parsing context.
 * @param start - Absolute item start.
 * @param end - Absolute item end.
 * @param depth - Node depth.
 * @returns Column node, or `undefined` when no identifier can be read.
 */
const sqlColumnNode: (context: SqlBuildContext, start: number, end: number, depth: number) => OutlineNode | undefined = (
    context: SqlBuildContext,
    start: number,
    end: number,
    depth: number,
): OutlineNode | undefined => {
    const raw: string = context.source.text;
    const masked: string = context.masked;
    const starts: readonly number[] = context.source.starts;
    const name: SqlName | undefined = readSqlQualifiedName(raw, start);
    if (name === (void 0) || name.end > end) {
        return (void 0);
    }
    const definition: string = normalizeSqlDefinition(masked.slice(name.end, end));
    const inlineStart: number = name.end;
    const inlineMasked: string = masked.slice(inlineStart, end);
    const children: OutlineNode[] = [];
    for (let index: number = 0; index < SqlInlineConstraints.length; index += 1) {
        const inline: SqlInlineConstraint = SqlInlineConstraints[index];
        const match: RegExpExecArray | null = inline.pattern.exec(inlineMasked);
        if (match === null) {
            continue;
        }
        const line: number = lineAtOffset(starts, inlineStart + match.index);
        children.push(
            sqlNode({
                label: inline.label,
                kind: "key",
                startLine: line,
                endLine: line,
                depth: depth + 1,
                detail: `${context.dialect}:${inline.label}`,
            }),
        );
    }
    const references: RegExpExecArray | null = /\bREFERENCES\b/i.exec(inlineMasked);
    if (references !== null) {
        const target: SqlName | undefined = readSqlQualifiedName(raw, inlineStart + references.index + references[0].length);
        const line: number = lineAtOffset(starts, inlineStart + references.index);
        children.push(
            sqlNode({
                label: target === (void 0) ? "references" : `references ${target.name}`,
                kind: "reference",
                startLine: line,
                endLine: line,
                depth: depth + 1,
                detail: target === (void 0) ? `${context.dialect}:references` : `${context.dialect}:references -> ${target.name}`,
            }),
        );
    }
    return sqlNode({
        label: name.name,
        kind: "property",
        startLine: lineAtOffset(starts, start),
        endLine: lineAtOffset(starts, Math.max(start, end - 1)),
        depth,
        detail: `${context.dialect}:${definition.length === 0 ? "column" : definition}`,
        children,
    });
};

/**
 * Build one table-body item: a constraint when it starts with a constraint
 * clause, otherwise a column.
 *
 * @param context - Parsing context.
 * @param start - Absolute item start.
 * @param end - Absolute item end.
 * @param depth - Node depth.
 * @returns Definition node, or `undefined` when the item is malformed.
 */
const sqlDefinitionNode: (context: SqlBuildContext, start: number, end: number, depth: number) => OutlineNode | undefined = (
    context: SqlBuildContext,
    start: number,
    end: number,
    depth: number,
): OutlineNode | undefined => {
    const constraint: OutlineNode | undefined = sqlConstraintNode(context, start, end, depth);
    if (constraint !== (void 0)) {
        return constraint;
    }
    if (/^\s*(?:CONSTRAINT|LIKE|PERIOD)\b/i.test(context.masked.slice(start, end))) {
        return (void 0);
    }
    return sqlColumnNode(context, start, end, depth);
};

/**
 * `CREATE ...` head with its optional modifiers, MySQL definer/algorithm
 * clauses and the recognized object keyword.
 */
const SqlCreateObject: RegExp =
    /^\s*CREATE\s+(?:(OR\s+(?:REPLACE|ALTER))\s+)?(?:ALGORITHM\s*=\s*\S+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\S+\s+)?((?:(?:TEMP|TEMPORARY|UNLOGGED|MATERIALIZED|UNIQUE|NONCLUSTERED|CLUSTERED)\s+)*)(TABLE|VIEW|INDEX|TRIGGER|FUNCTION|PROCEDURE|SCHEMA|DATABASE|SEQUENCE)\b/i;

/**
 * `ALTER TABLE` with its optional `IF EXISTS`/`ONLY` qualifiers.
 */
const SqlAlterTable: RegExp = /^\s*ALTER\s+TABLE\s+(?:(?:IF\s+EXISTS|ONLY)\s+)*/i;

/**
 * `ADD` action of an `ALTER TABLE`.
 */
const SqlAddAction: RegExp = /^\s*ADD\b/i;

/**
 * `ADD COLUMN` suffix.
 */
const SqlAddColumn: RegExp = /^\s*COLUMN\s+/i;

/**
 * `ADD ... IF NOT EXISTS` suffix.
 */
const SqlAddIfNotExists: RegExp = /^\s*IF\s+NOT\s+EXISTS\s+/i;

/**
 * `ALTER COLUMN` / `MODIFY [COLUMN]` action.
 */
const SqlAlterColumnAction: RegExp = /^\s*(?:ALTER|MODIFY)\s+(?:COLUMN\s+)?/i;

/**
 * Collect the modifiers of one `CREATE` match in source order.
 *
 * @param create - Match of `SqlCreateObject`.
 * @returns Lower-case modifiers such as `or replace`, `materialized`, `unique`.
 */
const sqlCreateModifiers: (create: RegExpExecArray) => string[] = (create: RegExpExecArray): string[] => {
    const modifiers: string[] = [];
    const orReplace: string | undefined = create[1];
    if (orReplace !== (void 0)) {
        modifiers.push(orReplace.replace(/\s+/g, " ").toLowerCase());
    }
    const declared: string = (create[2] ?? "").trim().toLowerCase();
    if (declared.length > 0) {
        const parts: string[] = declared.split(/\s+/);
        for (let index: number = 0; index < parts.length; index += 1) {
            if (parts[index].length > 0) {
                modifiers.push(parts[index]);
            }
        }
    }
    return modifiers;
};

/**
 * Build one `ALTER TABLE` node. `ADD` actions become depth-1 children (a column
 * or a constraint); `ALTER COLUMN`/`MODIFY` produce a `property` child that
 * marks the column as touched.
 *
 * @param context - Parsing context.
 * @param segment - Statement span.
 * @param alter - Match of `SqlAlterTable`.
 * @returns `ALTER TABLE` node, or `undefined` when the table name is missing.
 */
const sqlAlterNode: (context: SqlBuildContext, segment: SqlSegment, alter: RegExpExecArray) => OutlineNode | undefined = (
    context: SqlBuildContext,
    segment: SqlSegment,
    alter: RegExpExecArray,
): OutlineNode | undefined => {
    const name: SqlName | undefined = readSqlQualifiedName(context.source.text, segment.start + alter[0].length);
    if (name === (void 0)) {
        return (void 0);
    }
    const children: OutlineNode[] = [];
    const actions: SqlItem[] = splitSqlItems(context.masked, name.end, segment.end);
    for (let index: number = 0; index < actions.length; index += 1) {
        const action: SqlItem = actions[index];
        const actionMasked: string = context.masked.slice(action.start, action.end);
        const add: RegExpExecArray | null = SqlAddAction.exec(actionMasked);
        if (add !== null) {
            let offset: number = action.start + add[0].length;
            const column: RegExpExecArray | null = SqlAddColumn.exec(context.masked.slice(offset, action.end));
            if (column !== null) {
                offset += column[0].length;
            }
            const notExists: RegExpExecArray | null = SqlAddIfNotExists.exec(context.masked.slice(offset, action.end));
            if (notExists !== null) {
                offset += notExists[0].length;
            }
            const child: OutlineNode | undefined = sqlDefinitionNode(context, offset, action.end, 1);
            if (child !== (void 0)) {
                children.push(child);
            }
            continue;
        }
        const alterColumn: RegExpExecArray | null = SqlAlterColumnAction.exec(actionMasked);
        if (alterColumn !== null) {
            const columnName: SqlName | undefined = readSqlQualifiedName(context.source.text, action.start + alterColumn[0].length);
            if (columnName !== (void 0)) {
                const line: number = lineAtOffset(context.source.starts, action.start);
                children.push(
                    sqlNode({
                        label: columnName.name,
                        kind: "property",
                        startLine: line,
                        endLine: line,
                        depth: 1,
                        detail: `${context.dialect}:alter column`,
                    }),
                );
            }
        }
    }
    return sqlNode({
        label: name.name,
        kind: "class",
        startLine: lineAtOffset(context.source.starts, segment.start),
        endLine: lineAtOffset(context.source.starts, Math.max(segment.start, segment.end - 1)),
        depth: 0,
        detail: `${context.dialect}:alter table`,
        children,
    });
};

/**
 * Build the node of one `CREATE ...` statement.
 *
 * Kind mapping is documented in `docs/testing/languages/sqlReport.md`:
 * table/alter-table `class`, view `type`, index `key`, trigger `method`,
 * function/procedure `function`, schema/database `namespace`, sequence
 * `object`, column `property`, constraint `key`/`dependency`, column-level
 * `REFERENCES` `reference`.
 *
 * @param context - Parsing context.
 * @param segment - Statement span.
 * @param create - Match of `SqlCreateObject`.
 * @returns The created node, or `undefined` when no name can be read.
 */
const sqlCreateNode: (context: SqlBuildContext, segment: SqlSegment, create: RegExpExecArray) => OutlineNode | undefined = (
    context: SqlBuildContext,
    segment: SqlSegment,
    create: RegExpExecArray,
): OutlineNode | undefined => {
    const source: SourceLines = context.source;
    const masked: string = context.masked;
    const dialect: SqlDialect = context.dialect;
    const modifiers: string[] = sqlCreateModifiers(create);
    const object: string = (create[3] ?? "").toUpperCase();
    let nameOffset: number = segment.start + create[0].length;
    const notExists: RegExpExecArray | null = /^\s*IF\s+NOT\s+EXISTS\s+/i.exec(masked.slice(nameOffset, segment.end));
    if (notExists !== null) {
        modifiers.push("if not exists");
        nameOffset += notExists[0].length;
    }
    const name: SqlName | undefined = readSqlQualifiedName(source.text, nameOffset);
    if (name === (void 0)) {
        return (void 0);
    }
    const startLine: number = lineAtOffset(source.starts, segment.start);
    const endLine: number = lineAtOffset(source.starts, Math.max(segment.start, segment.end - 1));
    if (object === "TABLE") {
        const children: OutlineNode[] = [];
        const bodyOpen: number = skipSqlSpaces(masked, name.end);
        if (masked[bodyOpen] === "(") {
            const bodyClose: number = findMatchingParen(masked, bodyOpen, segment.end);
            const bodyLimit: number = bodyClose === -1 ? segment.end : bodyClose;
            const items: SqlItem[] = splitSqlItems(masked, bodyOpen + 1, bodyLimit);
            for (let index: number = 0; index < items.length; index += 1) {
                const child: OutlineNode | undefined = sqlDefinitionNode(context, items[index].start, items[index].end, 1);
                if (child !== (void 0)) {
                    children.push(child);
                }
            }
        }
        if (/\bWITHOUT\s+ROWID\b/i.test(masked.slice(name.end, segment.end))) {
            modifiers.push("without rowid");
        }
        return sqlNode({ label: name.name, kind: "class", startLine, endLine, depth: 0, detail: `${dialect}:table`, modifiers, children });
    }
    if (object === "VIEW") {
        const materialized: boolean = modifiers.includes("materialized");
        return sqlNode({
            label: name.name,
            kind: "type",
            startLine,
            endLine,
            depth: 0,
            detail: `${dialect}:${materialized ? "materialized view" : "view"}`,
            modifiers,
        });
    }
    if (object === "INDEX") {
        const table: string = readSqlOnTarget(context, name.end, segment.end);
        const descriptor: string = `${modifiers.includes("unique") ? "unique index" : "index"}${table.length === 0 ? "" : ` on ${table}`}`;
        return sqlNode({ label: name.name, kind: "key", startLine, endLine, depth: 0, detail: `${dialect}:${descriptor}`, modifiers });
    }
    if (object === "TRIGGER") {
        const table: string = readSqlOnTarget(context, name.end, segment.end);
        return sqlNode({
            label: name.name,
            kind: "method",
            startLine,
            endLine,
            depth: 0,
            detail: `${dialect}:trigger${table.length === 0 ? "" : ` on ${table}`}`,
            modifiers,
        });
    }
    if (object === "FUNCTION" || object === "PROCEDURE") {
        return sqlNode({ label: name.name, kind: "function", startLine, endLine, depth: 0, detail: `${dialect}:${object.toLowerCase()}`, modifiers });
    }
    if (object === "SCHEMA" || object === "DATABASE") {
        return sqlNode({ label: name.name, kind: "namespace", startLine, endLine, depth: 0, detail: `${dialect}:${object.toLowerCase()}`, modifiers });
    }
    if (object === "SEQUENCE") {
        return sqlNode({ label: name.name, kind: "object", startLine, endLine, depth: 0, detail: `${dialect}:sequence`, modifiers });
    }
    return (void 0);
};

/**
 * Parse the statements of one SQL text.
 *
 * @param input - Decoded SQL text and its path.
 * @param dialect - Explicit dialect, or `undefined` to detect one.
 * @returns DDL outline tree in source order.
 */
export const parseSql: (input: OutlineParseInput, dialect?: SqlDialect) => OutlineNode[] = (
    input: OutlineParseInput,
    dialect?: SqlDialect,
): OutlineNode[] => {
    const source: SourceLines = readSourceLines(input.text);
    if (source.totalLines === 0) {
        return [];
    }
    const chosen: SqlDialect = dialect ?? detectSqlDialect(input.text);
    const directives: SqlDelimiterDirective[] = findSqlDelimiterDirectives(source.lines);
    const mysqlDialect: boolean = chosen === "mysql";
    const maskedBase: string = maskSql(input.text, {
        hashComments: mysqlDialect,
        backslashEscapes: mysqlDialect,
        nestedBlockComments: chosen === "postgresql",
        bracketQuotes: chosen === "sqlserver",
        dollarQuotes: chosen === "postgresql" && directives.length === 0,
    });
    const masked: string = blankSqlDirectiveLines(maskedBase, input.text, source.starts, directives);
    const maskedLines: readonly string[] = splitLines(masked);
    const boundaries: Map<number, SqlBoundary> = sqlBoundaries(source.starts, maskedLines, directives, chosen);
    const segments: SqlSegment[] = mergeRoutineStatements(splitSqlStatements(masked, source.starts, boundaries), masked, chosen);
    const context: SqlBuildContext = { source, masked, dialect: chosen };
    const nodes: OutlineNode[] = [];
    for (let index: number = 0; index < segments.length; index += 1) {
        const segment: SqlSegment = segments[index];
        const head: string = masked.slice(segment.start, segment.end);
        const create: RegExpExecArray | null = SqlCreateObject.exec(head);
        const node: OutlineNode | undefined = create !== null ? sqlCreateNode(context, segment, create) : undefined;
        if (node !== (void 0)) {
            nodes.push(node);
            continue;
        }
        const alter: RegExpExecArray | null = SqlAlterTable.exec(head);
        if (alter !== null) {
            const altered: OutlineNode | undefined = sqlAlterNode(context, segment, alter);
            if (altered !== (void 0)) {
                nodes.push(altered);
            }
        }
    }
    return [...nodes].sort((left: OutlineNode, right: OutlineNode): number => Number(left.range.startLine) - Number(right.range.startLine));
};

/**
 * Lowercase extension of a file name, including the dot.
 *
 * @param name - Base name.
 * @returns Extension, or an empty string for a dot file or no extension.
 */
const extensionOfName: (name: string) => string = (name: string): string => {
    const dot: number = name.lastIndexOf(".");
    return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot).toLowerCase();
};

/**
 * Whether a base name has one of the given extensions.
 *
 * @param name - Base name.
 * @param extensions - Lower-case extensions including the dot.
 * @returns `true` when the base name matches.
 */
const hasSqlExtension: (name: string, extensions: readonly string[]) => boolean = (name: string, extensions: readonly string[]): boolean =>
    extensions.includes(extensionOfName(name));

/**
 * Extensions owned by the SQL strategy.
 */
const SqlExtensions: readonly string[] = [".sql"];

/**
 * The `.sql` strategy.
 *
 * The id is the stable tag `sql` because `OutlineStrategy.id` is static and
 * the registry writes it to `OutlineResult.strategy` before any text is read.
 * The dialect is therefore reported on every node `detail` as
 * `<dialect>:<descriptor>`; a host that wants a per-dialect strategy id can
 * register four thin strategies whose `parse` calls `parseSql(input, dialect)`
 * (see the report's integration section).
 */
export const SqlStrategy: OutlineStrategy = {
    id: "sql",
    category: "data",
    language: "sql",
    matches: (input: OutlineMatchInput): boolean => hasSqlExtension(input.name, SqlExtensions),
    parse: (input: OutlineParseInput): OutlineNode[] => parseSql(input),
};
