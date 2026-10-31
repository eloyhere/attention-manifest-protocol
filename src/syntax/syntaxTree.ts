/**
 * Lossless, read-only syntax trees.
 *
 * This is a concrete syntax tree (CST) rather than a type-checked compiler AST:
 * every non-whitespace token is represented exactly once, ranges point back to
 * UTF-8 bytes and 1-based lines, and declarations/blocks form a hierarchy. It
 * never evaluates code, imports a module, resolves types or executes a parser
 * binary, which is the only safe default for an agent reading an untrusted
 * workspace.
 *
 * The tree is deliberately language-neutral. A TypeScript `class`, a Java
 * `class` and a C++ `struct` all become declaration nodes with the same shape;
 * a caller that needs language semantics reads `language` and the token text.
 */
import { rawDigest } from "../fingerprint/raw.ts";
import type { Charset } from "./types.ts";
import type { SourceRange as OutlineRange } from "./types.ts";
import { fail } from "../file/errors.ts";
import { DefaultSyntaxRegistry } from "./syntaxRegistry.ts";
import type { SyntaxFamily, SyntaxLanguage, SyntaxNodeKind, SyntaxRegistry, SyntaxTokenKind } from "./syntaxRegistry.ts";

/**
 * Re-export the registry types so a consumer can import everything syntax
 * related from one module.
 */
export type { SyntaxLanguage, SyntaxNodeKind, SyntaxTokenKind } from "./syntaxRegistry.ts";
export { DefaultSyntaxRegistry, SyntaxRegistry, createSyntaxRegistry, syntaxLanguageOf } from "./syntaxRegistry.ts";
export type { SyntaxLanguageDefinition, SyntaxNodeKindDefinition, SyntaxTokenKindDefinition } from "./syntaxRegistry.ts";
export type { SyntaxLanguage as SyntaxLanguageId, SyntaxNodeKind as SyntaxNodeKindId, SyntaxTokenKind as SyntaxTokenKindId } from "./syntaxRegistry.ts";

/**
 * One lexical token with an exact UTF-8 byte / 1-based line range.
 */
export interface SyntaxToken {
    readonly kind: SyntaxTokenKind;
    readonly text: string;
    readonly range: OutlineRange;
}

/**
 * One syntax node. `tokens` are the tokens owned directly by this node; the
 * tree-level `tokens` array is the complete stream, so no token is lost when a
 * declaration body is nested.
 */
export interface SyntaxNode {
    readonly kind: SyntaxNodeKind;
    readonly name?: string;
    readonly detail?: string;
    readonly range: OutlineRange;
    readonly children: SyntaxNode[];
    readonly tokens: SyntaxToken[];
}

/**
 * Complete syntax tree for one file.
 */
export interface SyntaxTree {
    readonly path: string;
    readonly language: SyntaxLanguage;
    readonly fingerprint: string;
    readonly charset: Charset;
    readonly root: SyntaxNode;
    readonly tokens: SyntaxToken[];
    readonly tokenCount: number;
    readonly nodeCount: number;
    readonly truncated: boolean;
}

/**
 * Wire projection: bigint ranges become decimal strings, matching the outline
 * and file tools.
 */
export interface WireSyntaxToken extends Omit<SyntaxToken, "range"> {
    readonly range: { startByte: string; endByte: string; startLine: string; endLine: string; };
}

/**
 * Wire node.
 */
export interface WireSyntaxNode extends Omit<SyntaxNode, "range" | "children" | "tokens"> {
    readonly range: { startByte: string; endByte: string; startLine: string; endLine: string; };
    readonly children: readonly WireSyntaxNode[];
    readonly tokens: readonly WireSyntaxToken[];
}

/**
 * Wire tree.
 */
export interface WireSyntaxTree extends Omit<SyntaxTree, "root" | "tokens"> {
    readonly root: WireSyntaxNode;
    readonly tokens: readonly WireSyntaxToken[];
}

/**
 * Bounds. A file beyond `maxBytes` is refused; token/node ceilings set
 * `truncated` and stop the build instead of exhausting memory.
 */
export interface SyntaxTreeOptions {
    readonly maxBytes?: number;
    readonly maxTokens?: number;
    readonly maxNodes?: number;
    /**
     * Catalog used to resolve language, keywords and lexical rules. Omitted
     * means `DefaultSyntaxRegistry`; a host that added a language passes its own
     * registry here and through `buildSyntaxTree`.
     */
    readonly registry?: SyntaxRegistry;
}

const DefaultMaxTokens: number = 100_000;
const DefaultMaxNodes: number = 20_000;
const MaxSyntaxDepth: number = 256;

const isIdentifierStart: (character: string) => boolean = (character: string): boolean => /[\p{L}_$]/u.test(character);
const isIdentifierPart: (character: string) => boolean = (character: string): boolean => /[\p{L}\p{N}_$]/u.test(character);
const isDigit: (character: string) => boolean = (character: string): boolean => character >= "0" && character <= "9";
const isWhitespace: (character: string) => boolean = (character: string): boolean => character === " " || character === "\t" || character === "\n" || character === "\r";

const lineStartsOf: (text: string) => number[] = (text: string): number[] => {
    const starts: number[] = [0];
    for (let index: number = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) {
            starts.push(index + 1);
        }
    }
    return starts;
};

const lineAt: (starts: readonly number[], offset: number) => number = (starts: readonly number[], offset: number): number => {
    let low: number = 0;
    let high: number = starts.length - 1;
    while (low < high) {
        const mid: number = Math.ceil((low + high) / 2);
        if (starts[mid] <= offset) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low + 1;
};

/**
 * Tokenise one source text. Whitespace is skipped; every other character is
 * represented by exactly one token, so concatenating token text and skipped
 * whitespace reconstructs the source.
 */
const tokenize: (text: string, language: SyntaxLanguage, registry: SyntaxRegistry, maxTokens: number) => { tokens: SyntaxToken[]; truncated: boolean; } = (
    text: string,
    language: SyntaxLanguage,
    registry: SyntaxRegistry,
    maxTokens: number,
): { tokens: SyntaxToken[]; truncated: boolean; } => {
    const rule = registry.ruleOf(language);
    const keywords: ReadonlySet<string> = registry.keywordsOf(language);
    const starts: readonly number[] = lineStartsOf(text);
    const tokens: SyntaxToken[] = [];
    let offset: number = 0;
    let byte: number = 0;
    let truncated: boolean = false;
    const push: (kind: SyntaxTokenKind, start: number, end: number, startByte: number) => void = (
        kind: SyntaxTokenKind,
        start: number,
        end: number,
        startByte: number,
    ): void => {
        if (tokens.length >= maxTokens) {
            truncated = true;
            return;
        }
        const line: number = lineAt(starts, start);
        const endLine: number = lineAt(starts, Math.max(start, end - 1));
        tokens.push({
            kind,
            text: text.slice(start, end),
            range: {
                startByte: BigInt(startByte),
                endByte: BigInt(startByte + Buffer.byteLength(text.slice(start, end), "utf8")),
                startLine: BigInt(line),
                endLine: BigInt(endLine),
            },
        });
    };
    while (offset < text.length && !truncated) {
        const character: string = text[offset];
        if (isWhitespace(character)) {
            const start: number = offset;
            while (offset < text.length && isWhitespace(text[offset])) {
                offset += 1;
            }
            byte += Buffer.byteLength(text.slice(start, offset), "utf8");
            continue;
        }
        if (rule.lineComment !== (void 0) && rule.lineComment.length > 0 && text.startsWith(rule.lineComment, offset)) {
            const start: number = offset;
            const startByte: number = byte;
            while (offset < text.length && text[offset] !== "\n") {
                offset += 1;
            }
            push("comment", start, offset, startByte);
            byte += Buffer.byteLength(text.slice(start, offset), "utf8");
            continue;
        }
        if (rule.blockStart !== (void 0) && rule.blockStart.length > 0 && text.startsWith(rule.blockStart, offset)) {
            const start: number = offset;
            const startByte: number = byte;
            const close: number = text.indexOf(rule.blockEnd ?? rule.blockStart, offset + rule.blockStart.length);
            offset = close === -1 ? text.length : close + (rule.blockEnd ?? rule.blockStart).length;
            push("comment", start, offset, startByte);
            byte += Buffer.byteLength(text.slice(start, offset), "utf8");
            continue;
        }
        if (character === '"' || character === "'" || character === "`") {
            const start: number = offset;
            const startByte: number = byte;
            const quote: string = character;
            const triple: boolean = quote !== "`" && text.startsWith(`${quote}${quote}${quote}`, offset);
            const closing: string = triple ? `${quote}${quote}${quote}` : quote;
            offset += closing.length;
            while (offset < text.length) {
                if (text[offset] === "\\") {
                    offset += 2;
                    continue;
                }
                if (text.startsWith(closing, offset)) {
                    offset += closing.length;
                    break;
                }
                offset += 1;
            }
            push("string", start, offset, startByte);
            byte += Buffer.byteLength(text.slice(start, offset), "utf8");
            continue;
        }
        if (isDigit(character)) {
            const start: number = offset;
            const startByte: number = byte;
            while (offset < text.length && /[0-9A-Fa-fxXoObBeE._]/.test(text[offset])) {
                offset += 1;
            }
            push("number", start, offset, startByte);
            byte += Buffer.byteLength(text.slice(start, offset), "utf8");
            continue;
        }
        if (isIdentifierStart(character)) {
            const start: number = offset;
            const startByte: number = byte;
            offset += 1;
            while (offset < text.length && isIdentifierPart(text[offset])) {
                offset += 1;
            }
            const value: string = text.slice(start, offset);
            push(keywords.has(value) ? "keyword" : "identifier", start, offset, startByte);
            byte += Buffer.byteLength(value, "utf8");
            continue;
        }
        const startByte: number = byte;
        const width: number = text.codePointAt(offset)! > 0xffff ? 2 : 1;
        push("punctuation", offset, offset + width, startByte);
        byte += Buffer.byteLength(text.slice(offset, offset + width), "utf8");
        offset += width;
    }
    return { tokens, truncated };
};

const rangeOf: (tokens: readonly SyntaxToken[]) => OutlineRange = (tokens: readonly SyntaxToken[]): OutlineRange => {
    const first: SyntaxToken = tokens[0];
    const last: SyntaxToken = tokens[tokens.length - 1];
    return {
        startByte: first.range.startByte,
        endByte: last.range.endByte,
        startLine: first.range.startLine,
        endLine: last.range.endLine,
    };
};

const emptyRange: OutlineRange = { startByte: 0n, endByte: 0n, startLine: 1n, endLine: 1n };

interface ParseState {
    readonly tokens: readonly SyntaxToken[];
    readonly maxNodes: number;
    nodes: number;
    truncated: boolean;
}

/**
 * Find the index of the matching closing delimiter, or `end` when absent.
 */
const matchDelimiter: (tokens: readonly SyntaxToken[], start: number, end: number, open: string, close: string) => number = (
    tokens: readonly SyntaxToken[],
    start: number,
    end: number,
    open: string,
    close: string,
): number => {
    let depth: number = 0;
    for (let index: number = start; index < end; index += 1) {
        if (tokens[index].text === open) {
            depth += 1;
        } else if (tokens[index].text === close) {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return end;
};

const declarationKind: (keyword: string) => SyntaxNodeKind | undefined = (keyword: string): SyntaxNodeKind | undefined => {
    if (keyword === "class" || keyword === "object" || keyword === "record") {
        return "Class";
    }
    if (keyword === "interface") {
        return "Interface";
    }
    if (keyword === "struct") {
        return "Struct";
    }
    if (keyword === "trait") {
        return "Trait";
    }
    if (keyword === "enum") {
        return "Enum";
    }
    if (keyword === "namespace" || keyword === "module") {
        return "Namespace";
    }
    if (keyword === "function" || keyword === "def" || keyword === "fn" || keyword === "func") {
        return "Function";
    }
    if (keyword === "import" || keyword === "use" || keyword === "package") {
        return "Import";
    }
    if (keyword === "export") {
        return "Export";
    }
    if (keyword === "type" || keyword === "typedef") {
        return "Declaration";
    }
    return undefined;
};

/**
 * Build a declaration/block hierarchy from a token stream. The function is
 * deliberately permissive: malformed input still yields a tree, and any token
 * that is not owned by a declaration remains on its parent block.
 */
const parseCode: (state: ParseState) => SyntaxNode = (state: ParseState): SyntaxNode => {
    const tokens: readonly SyntaxToken[] = state.tokens;
    const parseRange: (start: number, end: number, kind: SyntaxNodeKind, name?: string, headerTokens?: number, depth?: number) => SyntaxNode = (
        start: number,
        end: number,
        kind: SyntaxNodeKind,
        name?: string,
        headerTokens: number = 0,
        depth: number = 0,
    ): SyntaxNode => {
        state.nodes += 1;
        const local: SyntaxToken[] = [];
        const children: SyntaxNode[] = [];
        let index: number = start;
        /**
         * The declaration keyword/name that opened this range belongs to this
         * node, not to a new declaration. Consuming the header first is what
         * keeps `class A { ... }` from recursively re-detecting its own
         * `class` token.
         */
        for (let header: number = 0; header < headerTokens && index < end; header += 1) {
            local.push(tokens[index]);
            index += 1;
        }
        while (index < end) {
            if (depth >= MaxSyntaxDepth || state.nodes >= state.maxNodes) {
                state.truncated = true;
                for (let remaining: number = index; remaining < end; remaining += 1) {
                    local.push(tokens[remaining]);
                }
                break;
            }
            const token: SyntaxToken = tokens[index];
            /**
             * A method or free function is an identifier followed by a
             * parenthesised parameter list and a brace body. Calls are excluded
             * by requiring the `{` after the closing `)`.
             */
            const classLike: boolean = kind === "Class" || kind === "Interface" || kind === "Struct" || kind === "Trait";
            if (classLike && token.kind === "identifier" && tokens[index + 1]?.text === "(") {
                const close: number = matchDelimiter(tokens, index + 1, end, "(", ")");
                let bodyOpen: number = -1;
                for (let lookahead: number = close + 1; lookahead < end && lookahead <= close + 16; lookahead += 1) {
                    const text: string = tokens[lookahead].text;
                    if (text === "{") {
                        bodyOpen = lookahead;
                        break;
                    }
                    if (text === ";" || text === "}" || text === "=") {
                        break;
                    }
                }
                if (bodyOpen >= 0) {
                    const bodyEnd: number = Math.min(end, blockEnd(tokens, bodyOpen, end));
                    const method: SyntaxNode = parseRange(
                        index,
                        bodyEnd,
                        kind === "Class" || kind === "Interface" || kind === "Struct" || kind === "Trait" ? "Method" : "Function",
                        token.text,
                        1,
                        depth + 1,
                    );
                    children.push(method);
                    index = Math.max(index + 1, bodyEnd);
                    continue;
                }
            }
            const declaration: SyntaxNodeKind | undefined = token.kind === "keyword" ? declarationKind(token.text) : (void 0);
            if (declaration === (void 0)) {
                local.push(token);
                index += 1;
                continue;
            }
            let nameToken: SyntaxToken | undefined = tokens[index + 1];
            let keywordIndex: number = index + 1;
            while (nameToken !== (void 0) && nameToken.text === "*") {
                keywordIndex += 1;
                nameToken = tokens[keywordIndex];
            }
            if (nameToken === (void 0) || nameToken.kind !== "identifier") {
                if (token.text === "export" || token.text === "import" || token.text === "use" || token.text === "package") {
                    const until: number = Math.max(index + 1, blockEnd(tokens, index, end));
                    children.push(parseRange(index, until, declaration, (void 0), 1, depth + 1));
                    index = until;
                    continue;
                }
                local.push(token);
                index += 1;
                continue;
            }
            const bodyStart: number = nextBodyToken(tokens, keywordIndex + 1, end);
            const bodyEnd: number = bodyStart < end ? blockEnd(tokens, bodyStart, end) : bodyStart;
            /**
             * A malformed declaration can resolve to an empty range (for
             * example `class` at EOF). Advancing by at least one token keeps the
             * parser total instead of recursing on the same index forever.
             */
            const safeEnd: number = Math.max(index + 1, Math.min(end, bodyEnd));
            const childKind: SyntaxNodeKind = declaration;
            const child: SyntaxNode = parseRange(index, safeEnd, childKind, nameToken.text, 1, depth + 1);
            children.push(child);
            index = safeEnd;
        }
        return {
            kind,
            ...(name === (void 0) ? {} : { name }),
            range: local.length === 0 && children.length === 0 ? emptyRange : rangeOf(local.length > 0 ? local : tokens.slice(start, Math.max(start + 1, end))),
            children,
            tokens: local,
        };
    };
    const first: SyntaxToken | undefined = tokens[0];
    const root: SyntaxNode = parseRange(0, tokens.length, "SourceFile");
    if (root.range.startByte === 0n && first !== (void 0)) {
        return { ...root, range: rangeOf(tokens) };
    }
    return root;
};

/**
 * End of one statement/block. Semicolon or brace group or a line break for
 * header-only forms.
 */
const blockEnd: (tokens: readonly SyntaxToken[], start: number, end: number) => number = (
    tokens: readonly SyntaxToken[],
    start: number,
    end: number,
): number => {
    let index: number = start;
    while (index < end) {
        const text: string = tokens[index].text;
        if (text === "{") {
            const close: number = matchDelimiter(tokens, index, end, "{", "}");
            return Math.min(end, close + 1);
        }
        if (text === ";") {
            return index + 1;
        }
        if (text === "}") {
            return index;
        }
        index += 1;
    }
    return end;
};

const nextBodyToken: (tokens: readonly SyntaxToken[], start: number, end: number) => number = (
    tokens: readonly SyntaxToken[],
    start: number,
    end: number,
): number => {
    for (let index: number = start; index < end; index += 1) {
        const text: string = tokens[index].text;
        if (text === "{" || text === ":" || text === "=" || text === ";") {
            return text === "{" ? index : index + 1;
        }
    }
    return end;
};

/**
 * Parse markup into a tag/text tree. This is not an HTML5 tree builder: it
 * balances tags, keeps attributes as child tokens and never executes scripts.
 */
const parseMarkup: (state: ParseState) => SyntaxNode = (state: ParseState): SyntaxNode => {
    const tokens: readonly SyntaxToken[] = state.tokens;
    const root: SyntaxNode = { kind: "SourceFile", range: tokens.length === 0 ? emptyRange : rangeOf(tokens), children: [], tokens: [] };
    const stack: SyntaxNode[] = [root];
    for (let index: number = 0; index < tokens.length; index += 1) {
        const token: SyntaxToken = tokens[index];
        const parent: SyntaxNode = stack[stack.length - 1];
        if (token.kind === "punctuation" && token.text === "<") {
            let end: number = index;
            while (end < tokens.length && tokens[end].text !== ">") {
                end += 1;
            }
            const closing: boolean = tokens[index + 1]?.text === "/";
            const nameToken: SyntaxToken | undefined = tokens[index + (closing ? 2 : 1)];
            const tagName: string = nameToken?.kind === "identifier" || nameToken?.kind === "keyword" ? nameToken.text : "";
            const node: SyntaxNode = {
                kind: "Tag",
                ...(tagName.length === 0 ? {} : { name: tagName }),
                detail: closing ? "closing" : "opening",
                range: rangeOf(tokens.slice(index, Math.min(tokens.length, end + 1))),
                children: [],
                tokens: tokens.slice(index, Math.min(tokens.length, end + 1)),
            };
            if (state.nodes >= state.maxNodes || stack.length > MaxSyntaxDepth) {
                state.truncated = true;
                for (let remaining: number = index; remaining < tokens.length; remaining += 1) {
                    parent.tokens.push(tokens[remaining]);
                }
                break;
            }
            if (closing && stack.length > 1 && stack[stack.length - 1].name === tagName) {
                stack.pop()!.children.push(node);
            } else {
                parent.children.push(node);
            }
            state.nodes += 1;
            if (!closing && tokens[end]?.text === ">" && tokens[end - 1]?.text !== "/") {
                stack.push(node);
            }
            index = end;
            continue;
        }
        parent.tokens.push(token);
    }
    return root;
};

/**
 * Parse Python by indentation. Each `class`/`def` owns the more-indented lines
 * that follow it; decorators attach to the next declaration.
 */
const parsePython: (state: ParseState, text: string) => SyntaxNode = (state: ParseState, text: string): SyntaxNode => {
    const tokens: readonly SyntaxToken[] = state.tokens;
    const lines: Map<number, SyntaxToken[]> = new Map<number, SyntaxToken[]>();
    for (let index: number = 0; index < tokens.length; index += 1) {
        const token: SyntaxToken = tokens[index];
        const line: number = Number(token.range.startLine);
        const bucket: SyntaxToken[] | undefined = lines.get(line);
        if (bucket === (void 0)) {
            lines.set(line, [token]);
        } else {
            bucket.push(token);
        }
    }
    const ordered: number[] = [...lines.keys()].sort((left: number, right: number): number => left - right);
    const sourceLines: string[] = text.split(/\r?\n/);
    const root: SyntaxNode = {
        kind: "SourceFile",
        range: tokens.length === 0 ? emptyRange : rangeOf(tokens),
        children: [],
        tokens: [],
    };
    interface Frame {
        readonly indent: number;
        readonly node: SyntaxNode;
    }
    const frames: Frame[] = [{ indent: -1, node: root }];
    let pending: SyntaxToken[] = [];
    for (let index: number = 0; index < ordered.length; index += 1) {
        const line: number = ordered[index];
        const bucket: SyntaxToken[] = lines.get(line)!;
        const raw: string = sourceLines[line - 1] ?? "";
        const leading: string = /^[ \t]*/.exec(raw)?.[0] ?? "";
        const indent: number = leading.replaceAll("\t", "    ").length;
        const first: SyntaxToken = bucket[0];
        if (first.text === "@") {
            pending.push(...bucket);
            continue;
        }
        while (frames.length > 1 && indent <= frames[frames.length - 1].indent) {
            frames.pop();
        }
        const parent: SyntaxNode = frames[frames.length - 1].node;
        /**
         * A class-scope assignment is a property, not a free token. Only the
         * direct class frame qualifies, so `self.x = ...` inside a method stays
         * with the method.
         */
        if (
            parent.kind === "Class" &&
            first.kind === "identifier" &&
            bucket.length >= 2 &&
            (bucket[1].text === "=" || (bucket[1].text === ":" && bucket.some((token: SyntaxToken): boolean => token.text === "=")))
        ) {
            const property: SyntaxNode = {
                kind: "Property",
                name: first.text,
                range: rangeOf([...pending, ...bucket]),
                children: [],
                tokens: [...pending, ...bucket],
            };
            if (state.nodes < state.maxNodes && frames.length <= MaxSyntaxDepth) {
                parent.children.push(property);
                state.nodes += 1;
            } else {
                state.truncated = true;
                parent.tokens.push(...pending, ...bucket);
            }
            pending = [];
            continue;
        }
        const declaration: SyntaxNodeKind | undefined = first.kind === "keyword" ? declarationKind(first.text) : (void 0);
        const isImport: boolean = first.text === "import" || first.text === "from";
        if (declaration !== (void 0) && bucket.length > 1 && bucket[1].kind === "identifier") {
            const node: SyntaxNode = {
                kind: isImport ? "Import" : declaration,
                name: bucket[1].text,
                range: rangeOf([...pending, ...bucket]),
                children: [],
                tokens: [...pending, ...bucket],
            };
            if (state.nodes < state.maxNodes && frames.length <= MaxSyntaxDepth) {
                parent.children.push(node);
                state.nodes += 1;
                if (!isImport) {
                    frames.push({ indent, node });
                }
            } else {
                state.truncated = true;
                parent.tokens.push(...pending, ...bucket);
            }
            pending = [];
        } else {
            parent.tokens.push(...pending, ...bucket);
            pending = [];
        }
    }
    root.tokens.push(...pending);
    return root;
};

/**
 * Parse text/markdown/TeX by headings. The full text is kept in `detail`; the
 * tree is a table of contents, not a replacement for reading the file.
 */
const parseTextTree: (state: ParseState, text: string) => SyntaxNode = (state: ParseState, text: string): SyntaxNode => {
    const root: SyntaxNode = {
        kind: "SourceFile",
        range: state.tokens.length === 0 ? emptyRange : rangeOf(state.tokens),
        children: [],
        tokens: [],
    };
    const lines: string[] = text.split(/\r?\n/);
    let current: SyntaxNode = root;
    const stack: SyntaxNode[] = [root];
    let tokenIndex: number = 0;
    for (let index: number = 0; index < lines.length; index += 1) {
        const line: string = lines[index];
        const match: RegExpExecArray | null = /^(#{1,6})\s+(.+)$/.exec(line) ?? /^(Chapter|Part|Section)\s+.+$/.exec(line);
        if (match !== null) {
            const depth: number = match[1].startsWith("#") ? match[1].length : 0;
            while (stack.length > depth + 1) {
                stack.pop();
            }
            if (state.nodes < state.maxNodes) {
                const node: SyntaxNode = {
                    kind: "Heading",
                    name: (match[2] ?? match[0]).trim(),
                    range: { startByte: 0n, endByte: 0n, startLine: BigInt(index + 1), endLine: BigInt(index + 1) },
                    children: [],
                    tokens: [],
                };
                stack[stack.length - 1].children.push(node);
                stack.push(node);
                current = node;
                state.nodes += 1;
            } else {
                state.truncated = true;
            }
        }
        while (tokenIndex < state.tokens.length && Number(state.tokens[tokenIndex].range.startLine) === index + 1) {
            current.tokens.push(state.tokens[tokenIndex]);
            tokenIndex += 1;
        }
    }
    return root;
};

/**
 * Build the tree for an already-decoded text.
 */
export const buildSyntaxTreeFromText: (path: string, text: string, language: SyntaxLanguage, options?: SyntaxTreeOptions) => SyntaxTree = (
    path: string,
    text: string,
    language: SyntaxLanguage,
    options: SyntaxTreeOptions = {},
): SyntaxTree => {
    if (
        (options.maxTokens !== (void 0) && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)) ||
        (options.maxNodes !== (void 0) && (!Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1))
    ) {
        return fail("invalid_arguments");
    }
    const maxTokens: number = Math.min(options.maxTokens ?? DefaultMaxTokens, DefaultMaxTokens);
    const maxNodes: number = Math.min(options.maxNodes ?? DefaultMaxNodes, DefaultMaxNodes);
    const registry: SyntaxRegistry = options.registry ?? DefaultSyntaxRegistry;
    const scanned: { tokens: SyntaxToken[]; truncated: boolean; } = tokenize(text, language, registry, maxTokens);
    const state: ParseState = { tokens: scanned.tokens, maxNodes, nodes: 0, truncated: scanned.truncated };
    const family: SyntaxFamily = registry.language(language)?.family ?? "code";
    if (family === "python" || family === "markup" || family === "text") {
        state.nodes = 1;
    }
    let root: SyntaxNode;
    if (family === "python") {
        root = parsePython(state, text);
    } else if (family === "markup") {
        root = parseMarkup(state);
    } else if (family === "text") {
        root = parseTextTree(state, text);
    } else {
        root = parseCode(state);
    }
    const countNodes: (node: SyntaxNode) => number = (node: SyntaxNode): number => {
        let count: number = 0;
        const pending: SyntaxNode[] = [node];
        while (pending.length > 0) {
            const current: SyntaxNode = pending.pop()!;
            count += 1;
            for (const child of current.children) {
                pending.push(child);
            }
        }
        return count;
    };
    return {
        path,
        language,
        fingerprint: rawDigest(new TextEncoder().encode(text)),
        charset: "utf-8",
        root,
        tokens: scanned.tokens,
        tokenCount: scanned.tokens.length,
        nodeCount: countNodes(root),
        truncated: state.truncated,
    };
};

const wireRange: (range: OutlineRange) => { startByte: string; endByte: string; startLine: string; endLine: string; } = (range: OutlineRange) => ({
    startByte: range.startByte.toString(),
    endByte: range.endByte.toString(),
    startLine: range.startLine.toString(),
    endLine: range.endLine.toString(),
});

const wireToken: (token: SyntaxToken) => WireSyntaxToken = (token: SyntaxToken): WireSyntaxToken => ({
    kind: token.kind,
    text: token.text,
    range: wireRange(token.range),
});

const wireNode: (node: SyntaxNode) => WireSyntaxNode = (node: SyntaxNode): WireSyntaxNode => {
    const copy: WireSyntaxNode = {
        kind: node.kind,
        ...(node.name === (void 0) ? {} : { name: node.name }),
        ...(node.detail === (void 0) ? {} : { detail: node.detail }),
        range: wireRange(node.range),
        children: [],
        tokens: node.tokens.map(wireToken),
    };
    const pending: { source: SyntaxNode; target: WireSyntaxNode; }[] = [{ source: node, target: copy }];
    while (pending.length > 0) {
        const frame = pending.pop()!;
        for (const child of frame.source.children) {
            const mapped: WireSyntaxNode = {
                kind: child.kind,
                ...(child.name === (void 0) ? {} : { name: child.name }),
                ...(child.detail === (void 0) ? {} : { detail: child.detail }),
                range: wireRange(child.range),
                children: [],
                tokens: child.tokens.map(wireToken),
            };
            (frame.target.children as WireSyntaxNode[]).push(mapped);
            pending.push({ source: child, target: mapped });
        }
    }
    return copy;
};

/**
 * Project a tree onto JSON-safe decimal strings.
 */
export const wireSyntaxTree: (tree: SyntaxTree) => WireSyntaxTree = (tree: SyntaxTree): WireSyntaxTree => ({
    ...tree,
    root: wireNode(tree.root),
    tokens: tree.tokens.map(wireToken),
});

/**
 * Recursively free a node and its children. Kept for callers that want to drop
 * a large tree from memory explicitly.
 */
export const disposeSyntaxNode: (node: SyntaxNode) => void = (node: SyntaxNode): void => {
    node.children.forEach(disposeSyntaxNode);
};
