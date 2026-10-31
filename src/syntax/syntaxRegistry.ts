/**
 * Syntax registry.
 *
 * Languages, token categories and node categories are data, not three frozen
 * unions spread across the parser. A host can add a language (or override an
 * extension) without editing `syntaxTree.ts`; the parser only asks the registry
 * for the language definition and the allowed token/node ids it already knows
 * how to construct.
 *
 * The three public type aliases stay plain strings on purpose: the registry is
 * the authority, so a value that did not pass `register*` is rejected at the
 * boundary instead of being accepted by the type system and failing later.
 */
import type { SourceRange as OutlineRange } from "./types.ts";

/**
 * Registered language id. Built-ins include `typescript`, `python`, `html`,
 * `vue`, `json`, `markdown`, `tex` and `plainText`.
 */
export type SyntaxLanguage = string;

/**
 * Registered token id. Built-ins: `keyword`, `identifier`, `number`, `string`,
 * `comment`, `punctuation`, `text`.
 */
export type SyntaxTokenKind = string;

/**
 * Registered node id. Built-ins: `SourceFile`, `Block`, `Declaration`, `Class`,
 * `Interface`, `Struct`, `Trait`, `Enum`, `Namespace`, `Function`, `Method`,
 * `Property`, `Import`, `Export`, `Parameter`, `Tag`, `Attribute`, `Text`,
 * `Heading`, `Rule`, `Comment`.
 */
export type SyntaxNodeKind = string;

/**
 * Coarse parser family. It selects the tree builder, not the language id.
 */
export type SyntaxFamily = "code" | "python" | "markup" | "text" | "json" | "style";

/**
 * One language definition.
 */
export interface SyntaxLanguageDefinition {
    readonly id: SyntaxLanguage;
    readonly family: SyntaxFamily;
    readonly extensions: readonly string[];
    readonly lineComment?: string;
    readonly blockStart?: string;
    readonly blockEnd?: string;
    readonly keywords?: readonly string[];
}

/**
 * One token-category definition.
 */
export interface SyntaxTokenKindDefinition {
    readonly id: SyntaxTokenKind;
    readonly description: string;
}

/**
 * One node-category definition.
 */
export interface SyntaxNodeKindDefinition {
    readonly id: SyntaxNodeKind;
    readonly category: "container" | "declaration" | "token" | "markup" | "text";
}

/**
 * Lexical rules derived from one language definition.
 */
export interface SyntaxRule {
    readonly lineComment?: string;
    readonly blockStart?: string;
    readonly blockEnd?: string;
    readonly family: SyntaxFamily;
}

const IdPattern: RegExp = /^[a-z][A-Za-z0-9]*$/;

/**
 * A mutable registry with duplicate and shape checks. The default instance is
 * populated once at module load; `createSyntaxRegistry()` returns an empty one
 * for a host that wants a different catalog.
 */
export class SyntaxRegistry {
    private readonly languageById: Map<SyntaxLanguage, SyntaxLanguageDefinition> = new Map<SyntaxLanguage, SyntaxLanguageDefinition>();
    private readonly languageByExtension: Map<string, SyntaxLanguage> = new Map<string, SyntaxLanguage>();
    private readonly tokenKinds: Map<SyntaxTokenKind, SyntaxTokenKindDefinition> = new Map<SyntaxTokenKind, SyntaxTokenKindDefinition>();
    private readonly nodeKinds: Map<SyntaxNodeKind, SyntaxNodeKindDefinition> = new Map<SyntaxNodeKind, SyntaxNodeKindDefinition>();

    /**
     * Register one language. An empty id, a duplicate id, a duplicate
     * extension, an invalid extension or an unknown family is rejected.
     */
    registerLanguage(definition: SyntaxLanguageDefinition): this {
        if (definition === null || typeof(definition) !== "object") {
            throw new TypeError("language definition must be an object");
        }
        if (!IdPattern.test(definition.id) || definition.id.length > 32) {
            throw new RangeError(`invalid syntax language id ${JSON.stringify(definition.id)}`);
        }
        if (this.languageById.has(definition.id)) {
            throw new Error(`duplicate syntax language ${definition.id}`);
        }
        if (!["code", "python", "markup", "text", "json", "style"].includes(definition.family)) {
            throw new RangeError(`unknown syntax family ${definition.family}`);
        }
        const extensions: string[] = [];
        for (let index: number = 0; index < definition.extensions.length; index += 1) {
            const extension: string = definition.extensions[index].toLowerCase().replace(/^\./, "");
            if (!/^[a-z0-9]+$/.test(extension)) {
                throw new RangeError(`invalid syntax extension ${definition.extensions[index]}`);
            }
            if (this.languageByExtension.has(extension) && this.languageByExtension.get(extension) !== definition.id) {
                throw new Error(`duplicate syntax extension ${extension}`);
            }
            extensions.push(extension);
        }
        const stored: SyntaxLanguageDefinition = {
            ...definition,
            extensions: Object.freeze(extensions),
            ...(definition.keywords === (void 0) ? {} : { keywords: Object.freeze([...definition.keywords]) }),
        };
        this.languageById.set(definition.id, Object.freeze(stored));
        extensions.forEach((extension: string): void => {
            this.languageByExtension.set(extension, definition.id);
        });
        return this;
    }

    /**
     * Register a token category.
     */
    registerTokenKind(definition: SyntaxTokenKindDefinition): this {
        if (!IdPattern.test(definition.id) || definition.description.length === 0) {
            throw new RangeError(`invalid syntax token kind ${JSON.stringify(definition.id)}`);
        }
        if (this.tokenKinds.has(definition.id)) {
            throw new Error(`duplicate syntax token kind ${definition.id}`);
        }
        this.tokenKinds.set(definition.id, Object.freeze({ ...definition }));
        return this;
    }

    /**
     * Register a node category.
     */
    registerNodeKind(definition: SyntaxNodeKindDefinition): this {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(definition.id) || definition.id.length > 32) {
            throw new RangeError(`invalid syntax node kind ${JSON.stringify(definition.id)}`);
        }
        if (!["container", "declaration", "token", "markup", "text"].includes(definition.category)) {
            throw new RangeError(`invalid syntax node category ${definition.category}`);
        }
        if (this.nodeKinds.has(definition.id)) {
            throw new Error(`duplicate syntax node kind ${definition.id}`);
        }
        this.nodeKinds.set(definition.id, Object.freeze({ ...definition }));
        return this;
    }

    /**
     * Look up a language by id.
     */
    language(id: SyntaxLanguage): SyntaxLanguageDefinition | undefined {
        return this.languageById.get(id);
    }

    /**
     * Resolve a path's extension. Unknown extensions return `unknown`; a path
     * without an extension returns `plainText`.
     */
    languageOf(path: string): SyntaxLanguage {
        const name: string = path.split("/").pop() ?? path;
        const dot: number = name.lastIndexOf(".");
        if (dot <= 0 || dot === name.length - 1) {
            return "plainText";
        }
        return this.languageByExtension.get(name.slice(dot + 1).toLowerCase()) ?? "unknown";
    }

    /**
     * Rule object consumed by the tokenizer.
     */
    ruleOf(language: SyntaxLanguage): SyntaxRule {
        const definition: SyntaxLanguageDefinition | undefined = this.languageById.get(language);
        if (definition === (void 0)) {
            return { family: "code", lineComment: "//", blockStart: "/*", blockEnd: "*/" };
        }
        return {
            family: definition.family,
            ...(definition.lineComment === (void 0) ? {} : { lineComment: definition.lineComment }),
            ...(definition.blockStart === (void 0) ? {} : { blockStart: definition.blockStart }),
            ...(definition.blockEnd === (void 0) ? {} : { blockEnd: definition.blockEnd }),
        };
    }

    /**
     * Keyword set for one language.
     */
    keywordsOf(language: SyntaxLanguage): ReadonlySet<string> {
        return new Set<string>(this.languageById.get(language)?.keywords ?? []);
    }

    /**
     * All registered languages, in registration order.
     */
    languages(): SyntaxLanguageDefinition[] {
        return [...this.languageById.values()];
    }

    /**
     * All registered token kinds.
     */
    tokenKindsList(): SyntaxTokenKindDefinition[] {
        return [...this.tokenKinds.values()];
    }

    /**
     * All registered node kinds.
     */
    nodeKindsList(): SyntaxNodeKindDefinition[] {
        return [...this.nodeKinds.values()];
    }

    /**
     * Whether every id is registered.
     */
    hasTokenKind(id: SyntaxTokenKind): boolean {
        return this.tokenKinds.has(id);
    }

    /**
     * Whether every id is registered.
     */
    hasNodeKind(id: SyntaxNodeKind): boolean {
        return this.nodeKinds.has(id);
    }
}

const Keywords: readonly string[] = [
    "abstract",
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "final",
    "finally",
    "for",
    "from",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "module",
    "namespace",
    "new",
    "package",
    "private",
    "protected",
    "public",
    "record",
    "return",
    "static",
    "struct",
    "switch",
    "throw",
    "trait",
    "try",
    "type",
    "typeof",
    "use",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "def",
    "fn",
    "func",
    "impl",
    "mod",
    "pub",
    "match",
    "mut",
    "ref",
    "where",
    "loop",
    "unsafe",
    "extern",
    "crate",
    "self",
    "super",
    "defer",
    "go",
    "select",
    "chan",
    "map",
    "range",
    "fallthrough",
    "goto",
    "typedef",
    "union",
    "using",
    "template",
    "virtual",
    "override",
    "operator",
    "friend",
    "inline",
    "volatile",
    "signed",
    "unsigned",
    "short",
    "long",
    "float",
    "double",
    "char",
    "bool",
    "boolean",
    "byte",
    "string",
    "String",
];

const registerBuiltins: (registry: SyntaxRegistry) => void = (registry: SyntaxRegistry): void => {
    registry.registerTokenKind({ id: "keyword", description: "Language keyword" });
    registry.registerTokenKind({ id: "identifier", description: "Identifier or name" });
    registry.registerTokenKind({ id: "number", description: "Numeric literal" });
    registry.registerTokenKind({ id: "string", description: "String literal, including markup text" });
    registry.registerTokenKind({ id: "comment", description: "Line or block comment" });
    registry.registerTokenKind({ id: "punctuation", description: "Delimiter or operator" });
    registry.registerTokenKind({ id: "text", description: "Unstructured text token" });

    registry.registerNodeKind({ id: "SourceFile", category: "container" });
    registry.registerNodeKind({ id: "Block", category: "container" });
    registry.registerNodeKind({ id: "Declaration", category: "declaration" });
    registry.registerNodeKind({ id: "Class", category: "declaration" });
    registry.registerNodeKind({ id: "Interface", category: "declaration" });
    registry.registerNodeKind({ id: "Struct", category: "declaration" });
    registry.registerNodeKind({ id: "Trait", category: "declaration" });
    registry.registerNodeKind({ id: "Enum", category: "declaration" });
    registry.registerNodeKind({ id: "Namespace", category: "declaration" });
    registry.registerNodeKind({ id: "Function", category: "declaration" });
    registry.registerNodeKind({ id: "Method", category: "declaration" });
    registry.registerNodeKind({ id: "Property", category: "declaration" });
    registry.registerNodeKind({ id: "Import", category: "declaration" });
    registry.registerNodeKind({ id: "Export", category: "declaration" });
    registry.registerNodeKind({ id: "Parameter", category: "token" });
    registry.registerNodeKind({ id: "Tag", category: "markup" });
    registry.registerNodeKind({ id: "Attribute", category: "markup" });
    registry.registerNodeKind({ id: "Text", category: "text" });
    registry.registerNodeKind({ id: "Heading", category: "text" });
    registry.registerNodeKind({ id: "Rule", category: "token" });
    registry.registerNodeKind({ id: "Comment", category: "token" });

    const language: (id: string, family: SyntaxFamily, extensions: readonly string[], rule?: Omit<SyntaxLanguageDefinition, "id" | "family" | "extensions" | "keywords">) => SyntaxLanguageDefinition = (
        id: string,
        family: SyntaxFamily,
        extensions: readonly string[],
        rule: Omit<SyntaxLanguageDefinition, "id" | "family" | "extensions" | "keywords"> = {},
    ): SyntaxLanguageDefinition => ({ id, family, extensions, keywords: Keywords, ...rule });
    registry.registerLanguage(language("typescript", "code", ["ts", "tsx", "mts", "cts"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("javascript", "code", ["js", "jsx", "mjs", "cjs"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("python", "python", ["py", "pyi"], { lineComment: "#", blockStart: '"""', blockEnd: '"""' }));
    registry.registerLanguage(language("java", "code", ["java"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("c", "code", ["c", "h"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("cpp", "code", ["cc", "cpp", "cxx", "hpp", "hh"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("csharp", "code", ["cs"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("go", "code", ["go"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("rust", "code", ["rs"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("vue", "markup", ["vue"], { lineComment: "//", blockStart: "<!--", blockEnd: "-->" }));
    registry.registerLanguage(language("html", "markup", ["html", "htm"], { blockStart: "<!--", blockEnd: "-->" }));
    registry.registerLanguage(language("xml", "markup", ["xml", "xsd", "xsl", "xslt", "svg", "csproj", "fsproj", "vbproj", "props", "targets"], { blockStart: "<!--", blockEnd: "-->" }));
    registry.registerLanguage(language("css", "style", ["css"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("scss", "style", ["scss", "sass", "less"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("json", "json", ["json", "jsonc"], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
    registry.registerLanguage(language("markdown", "text", ["md", "mdx", "markdown"], {}));
    registry.registerLanguage(language("tex", "text", ["tex", "ltx", "sty", "cls"], { lineComment: "%" }));
    registry.registerLanguage(language("plainText", "text", ["txt", "text"], {}));
    registry.registerLanguage(language("unknown", "code", [], { lineComment: "//", blockStart: "/*", blockEnd: "*/" }));
};

/**
 * The process-wide catalog used by the parser. It is frozen after module load;
 * a host that needs a different catalog builds one with
 * `createSyntaxRegistry()` and registers it explicitly.
 */
export const DefaultSyntaxRegistry: SyntaxRegistry = new SyntaxRegistry();
registerBuiltins(DefaultSyntaxRegistry);

/**
 * Create an empty registry for a host that wants to register a custom catalog.
 */
export const createSyntaxRegistry: () => SyntaxRegistry = (): SyntaxRegistry => new SyntaxRegistry();

/**
 * Convenience wrapper over the default catalog.
 */
export const syntaxLanguageOf: (path: string) => SyntaxLanguage = (path: string): SyntaxLanguage => DefaultSyntaxRegistry.languageOf(path);

/**
 * A range used by syntax tokens/nodes; re-exported for callers that only import
 * the registry module.
 */
export type SyntaxRange = OutlineRange;
