/**
 * Export extraction for the agent workspace.
 *
 * The report is intentionally declaration-level: an agent that is about to
 * change a module surface needs names, kinds, a bounded signature and the
 * re-export edges, not a full syntax tree. The scanner shares the lexical
 * tokenizer used by import extraction so comments, strings and templates cannot
 * manufacture an export.
 *
 * `export * from` and `export * as ns from` have no symbol name in TypeScript's
 * own model, so they are recorded as re-export edges with the local name `*` or
 * `ns`. A named re-export also produces one `ExportSymbol` per exported name,
 * which is what a consumer of the report actually wants to enumerate.
 */
import { LineIndex } from "../syntax/charset.ts";
import { isJsxSource, isParseableSource, readSourceFile, resolveImportSpecifier, tokenizeSource } from "./importGraph.ts";
import type { ResolvedSpecifier, SourceFileSnapshot, SourceToken } from "./importGraph.ts";
import type { PathSandbox } from "./path.ts";
import type { ExportKind, ExportReport, ExportSymbol, ImportEdge } from "./types.ts";

const MaxExports: number = 5000;
const SignatureLimit: number = 200;

/**
 * A re-export edge.
 *
 * `ImportEdge` has no name field, and the filesystem types are frozen. The
 * local subtype keeps the base edge contract intact while recording the
 * exported name that the `reexports` array is meant to describe: `*` for a star
 * re-export, the namespace name for `export * as ns`, and the exported name for
 * `export { x } from`.
 */
export interface ReexportEdge extends ImportEdge {
    readonly name: string;
}

interface NamedExportEntry {
    readonly local: string;
    readonly exported: string;
}

interface NamedExportClause {
    readonly entries: NamedExportEntry[];
    readonly closeIndex: number;
}

interface ExportExtraction {
    readonly exports: ExportSymbol[];
    readonly reexports: ReexportEdge[];
    readonly truncated: boolean;
}

type NamedClauseParser = (tokens: readonly SourceToken[], openIndex: number) => NamedExportClause;

type ReexportEdgeFactory = (sandbox: PathSandbox, from: string, specifier: string, name: string, line: number) => ReexportEdge;

type ExportExtractionFn = (tokens: readonly SourceToken[], text: string, from: string, sandbox: PathSandbox) => ExportExtraction;

type ExtractExportsFn = (sandbox: PathSandbox, path: string) => ExportReport;

interface FollowingDeclaratorsInput {
    readonly tokens: readonly SourceToken[];
    readonly start: number;
    readonly kind: ExportKind;
    readonly line: number;
    readonly signature: string;
    readonly exports: ExportSymbol[];
}

type FollowingDeclaratorCollector = (input: FollowingDeclaratorsInput) => boolean;

const DeclarationKinds: ReadonlyMap<string, ExportKind> = new Map<string, ExportKind>([
    ["function", "function"],
    ["class", "class"],
    ["interface", "interface"],
    ["type", "type"],
    ["enum", "enum"],
    ["const", "const"],
    ["let", "let"],
    ["var", "var"],
    ["namespace", "namespace"],
    ["module", "namespace"],
]);

const DeclarationModifiers: ReadonlySet<string> = new Set<string>(["async", "abstract", "declare"]);

const StatementKeywords: ReadonlySet<string> = new Set<string>([
    "export",
    "import",
    "const",
    "let",
    "var",
    "function",
    "class",
    "interface",
    "enum",
    "namespace",
]);

const collapseWhitespace: (value: string) => string = (value: string): string => value.replace(/\s+/g, " ").trim();

const signatureAt: (index: LineIndex, line: number) => string = (index: LineIndex, line: number): string =>
    collapseWhitespace(index.slice(line, 1).text).slice(0, SignatureLimit);

const isMemberAccess: (previous: SourceToken | undefined) => boolean = (previous: SourceToken | undefined): boolean =>
    previous !== (void 0) && previous.kind === "punct" && (previous.value === "." || previous.value === "?");

/**
 * Collect local declaration kinds so `export { local }` can use the declaration
 * kind instead of the `const` fallback. This is a name map, not scope analysis:
 * duplicate names in nested scopes collapse to the last declaration, which is
 * acceptable for a descriptive report.
 */
const collectDeclarations: (tokens: readonly SourceToken[]) => Map<string, ExportKind> = (tokens: readonly SourceToken[]): Map<string, ExportKind> => {
    const declarations: Map<string, ExportKind> = new Map<string, ExportKind>();
    for (let index: number = 0; index < tokens.length; index += 1) {
        const token: SourceToken = tokens[index];
        if (token.kind !== "identifier" || isMemberAccess(tokens[index - 1])) {
            continue;
        }
        const kind: ExportKind | undefined = DeclarationKinds.get(token.value);
        if (kind === (void 0)) {
            continue;
        }
        let nameIndex: number = index + 1;
        if (token.value === "function") {
            const star: SourceToken | undefined = tokens[nameIndex];
            if (star !== (void 0) && star.kind === "punct" && star.value === "*") {
                nameIndex += 1;
            }
        }
        const nameToken: SourceToken | undefined = tokens[nameIndex];
        if (nameToken !== (void 0) && nameToken.kind === "identifier") {
            declarations.set(nameToken.value, kind);
        }
    }
    return declarations;
};

/**
 * Parse the `{ a, b as c, type D }` part of an export clause.
 */
const parseNamedClause: NamedClauseParser = (tokens, openIndex): NamedExportClause => {
    const entries: NamedExportEntry[] = [];
    let index: number = openIndex + 1;
    let depth: number = 1;
    while (index < tokens.length) {
        const token: SourceToken = tokens[index];
        if (token.kind === "punct") {
            if (token.value === "{") {
                depth += 1;
            } else if (token.value === "}") {
                depth -= 1;
                if (depth === 0) {
                    return { entries, closeIndex: index };
                }
            }
            index += 1;
            continue;
        }
        if (depth !== 1 || token.kind !== "identifier") {
            index += 1;
            continue;
        }
        let local: string = token.value;
        if (local === "type") {
            const modified: SourceToken | undefined = tokens[index + 1];
            if (modified !== (void 0) && modified.kind === "identifier" && modified.value !== "as") {
                index += 1;
                local = modified.value;
            }
        }
        let exported: string = local;
        const asToken: SourceToken | undefined = tokens[index + 1];
        if (asToken !== (void 0) && asToken.kind === "identifier" && asToken.value === "as") {
            const alias: SourceToken | undefined = tokens[index + 2];
            if (alias !== (void 0) && alias.kind === "identifier") {
                exported = alias.value;
                index += 2;
            }
        }
        entries.push({ local, exported });
        index += 1;
    }
    return { entries, closeIndex: tokens.length };
};

/**
 * Return the index just past a balanced binding pattern.
 */
const skipPatternEnd: (tokens: readonly SourceToken[], start: number) => number = (tokens: readonly SourceToken[], start: number): number => {
    const opener: SourceToken | undefined = tokens[start];
    if (opener === (void 0) || opener.kind !== "punct") {
        return start + 1;
    }
    let depth: number = 0;
    for (let index: number = start; index < tokens.length; index += 1) {
        const token: SourceToken = tokens[index];
        if (token.kind !== "punct") {
            continue;
        }
        if (token.value === "{" || token.value === "[" || token.value === "(") {
            depth += 1;
        } else if (token.value === "}" || token.value === "]" || token.value === ")") {
            depth -= 1;
            if (depth === 0) {
                return index + 1;
            }
        }
    }
    return tokens.length;
};

/**
 * Collect binding names from a destructuring pattern.
 *
 * Shorthand bindings are collected, renamed bindings contribute the bound name
 * rather than the property key, computed keys are skipped, and a default
 * expression is skipped until the next top-level comma. This is a lexical
 * approximation: defaults that themselves contain destructuring patterns are
 * not interpreted.
 */
const collectBindingNames: (tokens: readonly SourceToken[], openIndex: number) => string[] = (tokens: readonly SourceToken[], openIndex: number): string[] => {
    const names: string[] = [];
    const opener: SourceToken | undefined = tokens[openIndex];
    const objectPattern: boolean = opener !== (void 0) && opener.kind === "punct" && opener.value === "{";
    let depth: number = 0;
    let skippingDefault: boolean = false;
    for (let index: number = openIndex; index < tokens.length; index += 1) {
        const token: SourceToken = tokens[index];
        if (token.kind === "punct") {
            if (objectPattern && depth === 1 && token.value === "[") {
                index = skipPatternEnd(tokens, index) - 1;
                continue;
            }
            if (token.value === "{" || token.value === "[" || token.value === "(") {
                depth += 1;
                if (depth === 1) {
                    skippingDefault = false;
                }
                continue;
            }
            if (token.value === "}" || token.value === "]" || token.value === ")") {
                depth -= 1;
                if (depth === 0) {
                    break;
                }
                continue;
            }
            if (token.value === "=" && depth === 1) {
                skippingDefault = true;
                continue;
            }
            if (token.value === "," && depth === 1) {
                skippingDefault = false;
            }
            continue;
        }
        if (skippingDefault || token.kind !== "identifier") {
            continue;
        }
        const next: SourceToken | undefined = tokens[index + 1];
        if (next !== (void 0) && next.kind === "punct" && next.value === ":") {
            continue;
        }
        names.push(token.value);
    }
    return names;
};

const addExport: (list: ExportSymbol[], symbol: ExportSymbol) => boolean = (list: ExportSymbol[], symbol: ExportSymbol): boolean => {
    if (list.length >= MaxExports) {
        return false;
    }
    list.push(symbol);
    return true;
};

/**
 * Guess whether `<` opens a type-argument list in an initializer. A comparison
 * can look identical at the token level, so the caller treats the range as
 * opaque only until a matching `>`; a failed match simply hides later
 * declarators of the same statement rather than inventing export names.
 */
const isLikelyGenericOpen: (tokens: readonly SourceToken[], index: number) => boolean = (tokens: readonly SourceToken[], index: number): boolean => {
    const previous: SourceToken | undefined = tokens[index - 1];
    const next: SourceToken | undefined = tokens[index + 1];
    if (previous === (void 0) || next === (void 0)) {
        return false;
    }
    const previousOk: boolean =
        previous.kind === "identifier" || (previous.kind === "punct" && (previous.value === ")" || previous.value === "]" || previous.value === ">"));
    const nextOk: boolean = next.kind === "identifier" || (next.kind === "punct" && (next.value === "{" || next.value === "(" || next.value === "["));
    return previousOk && nextOk;
};

/**
 * Collect additional declarators after the first one in
 * `export const a = 1, b = 2`. Depth is tracked so commas inside calls, arrays,
 * objects, arrows and template expressions do not split a declarator, a
 * heuristic angle-depth keeps generic arguments from leaking type names, and a
 * following statement keyword terminates the scan when semicolons are absent.
 */
const collectFollowingDeclarators: FollowingDeclaratorCollector = (input): boolean => {
    const tokens: readonly SourceToken[] = input.tokens;
    const start: number = input.start;
    const kind: ExportKind = input.kind;
    const line: number = input.line;
    const signature: string = input.signature;
    const exports: ExportSymbol[] = input.exports;
    let truncated: boolean = false;
    let depth: number = 0;
    let angleDepth: number = 0;
    let expectBinding: boolean = false;
    for (let index: number = start; index < tokens.length; index += 1) {
        const token: SourceToken = tokens[index];
        if (token.kind === "punct") {
            if (depth === 0 && angleDepth > 0) {
                if (token.value === ";") {
                    return truncated;
                }
                if (token.value === "<") {
                    angleDepth += 1;
                } else if (token.value === ">" && !(tokens[index - 1] !== (void 0) && tokens[index - 1].kind === "punct" && tokens[index - 1].value === "=")) {
                    angleDepth -= 1;
                }
                continue;
            }
            if (depth === 0 && token.value === "<" && !expectBinding && isLikelyGenericOpen(tokens, index)) {
                angleDepth = 1;
                continue;
            }
            if (depth === 0 && expectBinding && (token.value === "{" || token.value === "[")) {
                const names: string[] = collectBindingNames(tokens, index);
                for (let nameIndex: number = 0; nameIndex < names.length; nameIndex += 1) {
                    if (!addExport(exports, { name: names[nameIndex], kind, line, signature })) {
                        truncated = true;
                    }
                }
                index = skipPatternEnd(tokens, index) - 1;
                expectBinding = false;
                continue;
            }
            if (token.value === "{" || token.value === "[" || token.value === "(") {
                depth += 1;
                continue;
            }
            if (token.value === "}" || token.value === "]" || token.value === ")") {
                if (depth === 0) {
                    return truncated;
                }
                depth -= 1;
                continue;
            }
            if (depth !== 0) {
                continue;
            }
            if (token.value === ";") {
                return truncated;
            }
            if (token.value === ",") {
                expectBinding = true;
                continue;
            }
            if (token.value === "=") {
                expectBinding = false;
            }
            continue;
        }
        if (depth !== 0 || token.kind !== "identifier") {
            continue;
        }
        if (!isMemberAccess(tokens[index - 1]) && StatementKeywords.has(token.value)) {
            return truncated;
        }
        if (!expectBinding) {
            continue;
        }
        if (!addExport(exports, { name: token.value, kind, line, signature })) {
            truncated = true;
        }
        expectBinding = false;
    }
    return truncated;
};

const addReexport: (list: ReexportEdge[], edge: ReexportEdge) => boolean = (list: ReexportEdge[], edge: ReexportEdge): boolean => {
    if (list.length >= MaxExports) {
        return false;
    }
    list.push(edge);
    return true;
};

const reexportEdge: ReexportEdgeFactory = (sandbox, from, specifier, name, line): ReexportEdge => {
    const resolution: ResolvedSpecifier = resolveImportSpecifier(sandbox, from, specifier);
    return {
        from,
        to: resolution.to,
        specifier,
        kind: "export-from",
        line,
        resolved: resolution.resolved,
        external: resolution.external,
        name,
    };
};

const extractionFromTokens: ExportExtractionFn = (tokens, text, from, sandbox): ExportExtraction => {
    const exports: ExportSymbol[] = [];
    const reexports: ReexportEdge[] = [];
    const declarations: Map<string, ExportKind> = collectDeclarations(tokens);
    const lineIndex: LineIndex = new LineIndex(text);
    const braceDepth: number[] = new Array<number>(tokens.length);
    let currentDepth: number = 0;
    for (let index: number = 0; index < tokens.length; index += 1) {
        braceDepth[index] = currentDepth;
        const token: SourceToken = tokens[index];
        if (token.kind === "punct" && token.value === "{") {
            currentDepth += 1;
        } else if (token.kind === "punct" && token.value === "}" && currentDepth > 0) {
            currentDepth -= 1;
        }
    }
    let truncated: boolean = false;
    for (let index: number = 0; index < tokens.length; index += 1) {
        const token: SourceToken = tokens[index];
        if (token.kind !== "identifier" || token.value !== "export" || isMemberAccess(tokens[index - 1]) || braceDepth[index] !== 0) {
            continue;
        }
        const line: number = token.line;
        const signature: string = signatureAt(lineIndex, line);
        let cursor: number = index + 1;
        const prefixed: SourceToken | undefined = tokens[cursor];
        if (
            prefixed !== (void 0) &&
            prefixed.kind === "identifier" &&
            prefixed.value === "type" &&
            tokens[cursor + 1] !== (void 0) &&
            tokens[cursor + 1].kind === "punct" &&
            (tokens[cursor + 1].value === "{" || tokens[cursor + 1].value === "*")
        ) {
            cursor += 1;
        }
        const head: SourceToken | undefined = tokens[cursor];
        if (head === (void 0)) {
            continue;
        }
        if (head.kind === "identifier" && head.value === "default") {
            if (!addExport(exports, { name: "default", kind: "default", line, signature })) {
                truncated = true;
            }
            continue;
        }
        if (head.kind === "punct" && head.value === "*") {
            let starCursor: number = cursor + 1;
            let name: string = "*";
            const asToken: SourceToken | undefined = tokens[starCursor];
            if (asToken !== (void 0) && asToken.kind === "identifier" && asToken.value === "as") {
                const namespace: SourceToken | undefined = tokens[starCursor + 1];
                if (namespace !== (void 0) && namespace.kind === "identifier") {
                    name = namespace.value;
                    starCursor += 2;
                }
            }
            const fromToken: SourceToken | undefined = tokens[starCursor];
            const specToken: SourceToken | undefined = tokens[starCursor + 1];
            if (
                fromToken === (void 0) ||
                fromToken.kind !== "identifier" ||
                fromToken.value !== "from" ||
                specToken === (void 0) ||
                specToken.kind !== "string"
            ) {
                continue;
            }
            if (!addReexport(reexports, reexportEdge(sandbox, from, specToken.value, name, line))) {
                truncated = true;
            }
            continue;
        }
        if (head.kind === "punct" && head.value === "{") {
            const clause: NamedExportClause = parseNamedClause(tokens, cursor);
            let fromIndex: number = -1;
            const fromToken: SourceToken | undefined = tokens[clause.closeIndex + 1];
            if (fromToken !== (void 0) && fromToken.kind === "identifier" && fromToken.value === "from") {
                const specToken: SourceToken | undefined = tokens[clause.closeIndex + 2];
                if (specToken !== (void 0) && specToken.kind === "string") {
                    fromIndex = clause.closeIndex + 1;
                }
            }
            if (fromIndex !== -1) {
                const specifier: string = (tokens[fromIndex + 1] as SourceToken).value;
                for (let entryIndex: number = 0; entryIndex < clause.entries.length; entryIndex += 1) {
                    const entry: NamedExportEntry = clause.entries[entryIndex];
                    if (!addExport(exports, { name: entry.exported, kind: "reexport", line, signature, reexportFrom: specifier })) {
                        truncated = true;
                    }
                    if (!addReexport(reexports, reexportEdge(sandbox, from, specifier, entry.exported, line))) {
                        truncated = true;
                    }
                }
                continue;
            }
            const rendered: string[] = [];
            for (let entryIndex: number = 0; entryIndex < clause.entries.length; entryIndex += 1) {
                const entry: NamedExportEntry = clause.entries[entryIndex];
                rendered.push(entry.local === entry.exported ? entry.local : `${entry.local} as ${entry.exported}`);
            }
            const signatureText: string = collapseWhitespace(`export { ${rendered.join(", ")} }`).slice(0, SignatureLimit);
            for (let entryIndex: number = 0; entryIndex < clause.entries.length; entryIndex += 1) {
                const entry: NamedExportEntry = clause.entries[entryIndex];
                const kind: ExportKind = declarations.get(entry.local) ?? "const";
                if (!addExport(exports, { name: entry.exported, kind, line, signature: signatureText })) {
                    truncated = true;
                }
            }
            continue;
        }
        let keywordIndex: number = cursor;
        while (keywordIndex < tokens.length) {
            const candidate: SourceToken = tokens[keywordIndex];
            if (candidate.kind !== "identifier" || !DeclarationModifiers.has(candidate.value)) {
                break;
            }
            keywordIndex += 1;
        }
        const keyword: SourceToken | undefined = tokens[keywordIndex];
        if (keyword === (void 0) || keyword.kind !== "identifier") {
            continue;
        }
        let kind: ExportKind | undefined = DeclarationKinds.get(keyword.value);
        let nameIndex: number = keywordIndex + 1;
        if (kind !== (void 0) && keyword.value === "const") {
            const enumToken: SourceToken | undefined = tokens[nameIndex];
            if (enumToken !== (void 0) && enumToken.kind === "identifier" && enumToken.value === "enum") {
                kind = "enum";
                nameIndex += 1;
            }
        }
        if (kind === (void 0)) {
            continue;
        }
        if (keyword.value === "function") {
            const star: SourceToken | undefined = tokens[nameIndex];
            if (star !== (void 0) && star.kind === "punct" && star.value === "*") {
                nameIndex += 1;
            }
        }
        const nameToken: SourceToken | undefined = tokens[nameIndex];
        if (nameToken === (void 0)) {
            continue;
        }
        if (nameToken.kind === "punct" && (kind === "const" || kind === "let" || kind === "var") && (nameToken.value === "{" || nameToken.value === "[")) {
            const bindingNames: string[] = collectBindingNames(tokens, nameIndex);
            for (let bindingIndex: number = 0; bindingIndex < bindingNames.length; bindingIndex += 1) {
                if (!addExport(exports, { name: bindingNames[bindingIndex], kind, line, signature })) {
                    truncated = true;
                }
            }
            if (
                collectFollowingDeclarators({
                    tokens,
                    start: skipPatternEnd(tokens, nameIndex),
                    kind,
                    line,
                    signature,
                    exports,
                })
            ) {
                truncated = true;
            }
            continue;
        }
        if (nameToken.kind !== "identifier") {
            continue;
        }
        if (!addExport(exports, { name: nameToken.value, kind, line, signature })) {
            truncated = true;
        }
        if (
            collectFollowingDeclarators({
                tokens,
                start: nameIndex + 1,
                kind,
                line,
                signature,
                exports,
            })
        ) {
            truncated = true;
        }
    }
    return { exports, reexports, truncated };
};

/**
 * Extract exported symbols and re-export edges for one file.
 *
 * Declaration forms cover `function`, `class`, `interface`, `type`, `enum`,
 * `const`, `let`, `var`, `namespace`/`module`, plus `export default`. Named
 * clauses without a `from` resolve their kind from a local declaration when the
 * scanner saw one and otherwise fall back to `const`; their signature is a
 * normalized `export { ... }` clause. Files outside the JS/TS family return an
 * empty report after the normal read/fingerprint checks.
 *
 * @param sandbox - Root-confined path resolver.
 * @param path - Root-relative file path.
 * @returns Export report for the file.
 */
export const extractExports: ExtractExportsFn = (sandbox, path): ExportReport => {
    const source: SourceFileSnapshot = readSourceFile(sandbox, path);
    if (!isParseableSource(source.path)) {
        return {
            path: source.path,
            fingerprint: source.fingerprint,
            exports: [],
            reexports: [],
            truncated: false,
        };
    }
    const extraction: ExportExtraction = extractionFromTokens(tokenizeSource(source.text, isJsxSource(source.path)), source.text, source.path, sandbox);
    return {
        path: source.path,
        fingerprint: source.fingerprint,
        exports: extraction.exports,
        reexports: extraction.reexports,
        truncated: extraction.truncated,
    };
};
