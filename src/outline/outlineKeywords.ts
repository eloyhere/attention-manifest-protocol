/**
 * Outline keyword registry.
 *
 * Declaration keywords and modifiers are data: a language can add `static`,
 * `readonly` or a new variable keyword without editing every parser regex. The
 * registry classifies one word and, more usefully, extracts the leading
 * modifier chain from a line (`public static readonly`).
 *
 * It is intentionally separate from `syntaxRegistry.ts`: the syntax registry
 * classifies lexical tokens for the lossless tree, while this registry tells the
 * outline parsers which words introduce a declaration and which only modify it.
 */

/**
 * Keyword categories used by the outline builders.
 */
export type OutlineKeywordCategory = "variable" | "function" | "type" | "import" | "modifier" | "control" | "literal";

/**
 * A registry of declaration and modifier keywords.
 */
export class OutlineKeywordRegistry {
    private readonly byCategory: Map<OutlineKeywordCategory, Set<string>> = new Map<OutlineKeywordCategory, Set<string>>();
    private readonly categoryByWord: Map<string, OutlineKeywordCategory> = new Map<string, OutlineKeywordCategory>();

    /**
     * Register one word. Registering the same word in a second category keeps
     * the first category and is a no-op, so aliases cannot silently reclassify.
     */
    register(category: OutlineKeywordCategory, word: string): this {
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(word)) {
            throw new RangeError(`invalid outline keyword ${JSON.stringify(word)}`);
        }
        const existing: OutlineKeywordCategory | undefined = this.categoryByWord.get(word);
        if (existing !== (void 0)) {
            if (existing !== category) {
                throw new Error(`outline keyword ${word} is already registered as ${existing}`);
            }
            return this;
        }
        const set: Set<string> | undefined = this.byCategory.get(category);
        if (set === (void 0)) {
            this.byCategory.set(category, new Set<string>([word]));
        } else {
            set.add(word);
        }
        this.categoryByWord.set(word, category);
        return this;
    }

    /**
     * Category of one word, or `undefined`.
     */
    categoryOf(word: string): OutlineKeywordCategory | undefined {
        return this.categoryByWord.get(word);
    }

    /**
     * Whether a word is a modifier (possibly chained before a declaration).
     */
    isModifier(word: string): boolean {
        return this.categoryByWord.get(word) === "modifier";
    }

    /**
     * Whether a word introduces a variable declaration.
     */
    isVariableKeyword(word: string): boolean {
        return this.categoryByWord.get(word) === "variable";
    }

    /**
     * All words in one category, in registration order.
     */
    words(category: OutlineKeywordCategory): string[] {
        return [...(this.byCategory.get(category) ?? [])];
    }

    /**
     * Extract the leading modifier chain from a source line. The function stops
     * at the first non-modifier word, so `static count = 0` yields `["static"]`
     * and `count = 0` yields `[]`.
     */
    leadingModifiers(line: string): string[] {
        const modifiers: string[] = [];
        const words: string[] = line.trim().split(/\s+/);
        for (let index: number = 0; index < words.length; index += 1) {
            const word: string = words[index].replace(/[^A-Za-z0-9_$]/g, "");
            if (word.length === 0 || !this.isModifier(word)) {
                break;
            }
            modifiers.push(word);
        }
        return modifiers;
    }
}

/**
 * Build the default registry with the languages currently supported by the
 * outline strategies.
 */
export const createOutlineKeywordRegistry: () => OutlineKeywordRegistry = (): OutlineKeywordRegistry => {
    const registry: OutlineKeywordRegistry = new OutlineKeywordRegistry();
    ["const", "let", "var", "val", "auto"].forEach((word: string): void => {
        registry.register("variable", word);
    });
    ["function", "def", "fn", "func", "lambda"].forEach((word: string): void => {
        registry.register("function", word);
    });
    ["class", "interface", "struct", "trait", "enum", "namespace", "module", "record", "object", "union", "type"].forEach((word: string): void => {
        registry.register("type", word);
    });
    ["import", "use", "package", "from", "require", "include"].forEach((word: string): void => {
        registry.register("import", word);
    });
    [
        "export",
        "default",
        "static",
        "public",
        "private",
        "protected",
        "readonly",
        "abstract",
        "final",
        "async",
        "declare",
        "override",
        "sealed",
        "open",
        "suspend",
        "inline",
        "virtual",
        "extern",
        "pub",
        "mut",
        "unsafe",
        "get",
        "set",
        "accessor",
    ].forEach((word: string): void => {
        registry.register("modifier", word);
    });
    ["if", "else", "for", "while", "switch", "case", "catch", "return", "throw", "new", "delete", "typeof", "in", "of", "await", "yield", "try", "finally"].forEach(
        (word: string): void => {
            registry.register("control", word);
        },
    );
    ["true", "false", "null", "undefined", "this", "super"].forEach((word: string): void => {
        registry.register("literal", word);
    });
    return registry;
};

/**
 * Process-wide default used by the outline parsers.
 */
export const DefaultOutlineKeywords: OutlineKeywordRegistry = createOutlineKeywordRegistry();
