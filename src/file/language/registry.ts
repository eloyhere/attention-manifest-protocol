import { Optional, SynchronousOrderedMap, SynchronousUnorderedMap, SynchronousUnorderedSet, isFunction, isObject, isString, useFrom } from "semantic-typescript";
import type { LanguageDefinition, LanguageMatch, LanguageParseResult, LanguageRegistryOptions } from "./types.ts";
import type { OutlineParserPort, ParsedOutlineNode } from "../outline.ts";
import { SourceText, freezeRange, isRange } from "../range.ts";

const clone = <T>(value: T): T => structuredClone(value);
const parserWrapper = (language: string, original: OutlineParserPort): OutlineParserPort => {
    const parse = original.parse.bind(original);
    return Object.freeze({ language, parse });
};
const freezeDefinition = (value: LanguageDefinition): LanguageDefinition => Object.freeze({
    id: value.id, displayName: value.displayName, support: value.support,
    extensions: Object.freeze([...value.extensions]), mimeTypes: Object.freeze([...value.mimeTypes]),
    ...(value.parser ? { parser: parserWrapper(value.id, value.parser) } : {}), ...(value.loadParser ? { loadParser: value.loadParser } : {}),
    ...(value.documentParser ? { documentParser: Object.freeze({ language: value.id, parse: value.documentParser.parse.bind(value.documentParser) }) } : {}),
});
const freezeNode = (value: ParsedOutlineNode): ParsedOutlineNode => Object.freeze({
    ...clone(value), range: freezeRange(value.range),
});
const normalized = (value: string): string => value.trim().toLowerCase();

export function validateParsedNodes(source: string, parsed: unknown): readonly ParsedOutlineNode[] {
    if (!isString(source)) throw new TypeError("source must be a string");
    if (!Array.isArray(parsed)) throw new TypeError("parser must return an array of nodes");
    const text = new SourceText(source);
    const nodeById = new SynchronousUnorderedMap<string, ParsedOutlineNode>();
    for (const candidate of parsed as readonly unknown[]) {
        if (!isObject(candidate)) throw new TypeError("parser returned an invalid outline node");
        const value = candidate as Record<string, unknown>;
        if (!isString(value.id) || !value.id.trim()
            || (value.kind !== "heading" && value.kind !== "symbol")
            || !isString(value.name) || !isString(value.summary)
            || (value.parentId !== undefined && (!isString(value.parentId) || !value.parentId.trim()))
            || !isRange(value.range)) throw new TypeError("parser returned an invalid outline node");
        if (value.range.startLine > text.lineCount || value.range.endLine > text.lineCount
            || value.range.endByte > text.byteLength) throw new TypeError(`invalid range for outline node ${value.id}`);
        if (nodeById.containsKey(value.id)) throw new TypeError(`duplicate outline node id: ${value.id}`);
        nodeById.put(value.id, value as unknown as ParsedOutlineNode);
    }
    for (const candidate of nodeById.values()) {
        if (candidate.parentId === undefined) continue;
        const ancestorIds = new SynchronousUnorderedSet<string>();
        let ancestor: ParsedOutlineNode | undefined = candidate;
        while (ancestor?.parentId !== undefined) {
            if (ancestorIds.contains(ancestor.id)) throw new TypeError(`parent cycle for outline node ${candidate.id}`);
            ancestorIds.add(ancestor.id);
            const next = nodeById.get(ancestor.parentId);
            if (next.isEmpty()) throw new TypeError(`unknown parent for outline node ${ancestor.id}`);
            const parentNode = next.get();
            if (ancestor.range.startLine < parentNode.range.startLine || ancestor.range.endLine > parentNode.range.endLine
                || ancestor.range.startByte < parentNode.range.startByte || ancestor.range.endByte > parentNode.range.endByte) throw new TypeError(`outline range is outside its parent for node ${ancestor.id}`);
            ancestor = parentNode;
        }
    }
    return Object.freeze(useFrom(parsed as readonly ParsedOutlineNode[]).map(freezeNode).toCollectable().toArray());
}

function validateDefinition(input: LanguageDefinition): LanguageDefinition {
    if (!isObject(input) || !isString(input.id) || !input.id.trim()) throw new TypeError("language id must be non-empty");
    if (!isString(input.displayName) || !input.displayName.trim()) throw new TypeError("displayName must be non-empty");
    if (!["outline", "text", "document", "tabular", "unsupported"].includes(input.support)) throw new TypeError("invalid language support");
    if (!Array.isArray(input.extensions) || !Array.isArray(input.mimeTypes)) throw new TypeError("extensions and mimeTypes must be arrays");
    const extensions = input.extensions.map(value => {
        if (!isString(value) || !value.trim()) throw new TypeError("extension must be non-empty");
        const extension = normalized(value);
        if (!extension.startsWith(".") || extension === "." || extension.includes("/") || extension.includes("\\")) throw new TypeError(`invalid extension: ${value}`);
        return extension;
    });
    const extensionSet = new SynchronousUnorderedSet<string>();
    for (const extension of extensions) {
        if (extensionSet.contains(extension)) throw new TypeError("duplicate extension in language definition");
        extensionSet.add(extension);
    }
    const mimeTypes = input.mimeTypes.map(value => {
        if (!isString(value) || !value.trim()) throw new TypeError("MIME type must be non-empty");
        const mime = normalized(value);
        if (!/^[^\s;/]+\/[^\s;/]+$/.test(mime)) throw new TypeError(`invalid MIME type: ${value}`);
        return mime;
    });
    const mimeSet = new SynchronousUnorderedSet<string>();
    for (const mime of mimeTypes) {
        if (mimeSet.contains(mime)) throw new TypeError("duplicate MIME type in language definition");
        mimeSet.add(mime);
    }
    if (input.parser !== undefined && (!isObject(input.parser) || !isFunction(input.parser.parse) || !isString(input.parser.language))) throw new TypeError("parser must provide language and parse()");
    if (input.loadParser !== undefined && !isFunction(input.loadParser)) throw new TypeError("loadParser must be a function");
    if (input.parser !== undefined && input.loadParser !== undefined) throw new TypeError("provide parser or loadParser, not both");
    if (input.documentParser !== undefined) {
        if (!isObject(input.documentParser) || !isFunction(input.documentParser.parse) || !isString(input.documentParser.language)) {
            throw new TypeError("documentParser must provide language and parse()");
        }
        if (input.support !== "document" && input.support !== "tabular" && input.support !== "unsupported") {
            throw new TypeError("documentParser requires document, tabular or unsupported support");
        }
    }
    const id = input.id.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new TypeError("language id must be lowercase alphanumeric with . _ - separators");
    if (input.parser !== undefined && input.parser.language !== id) throw new TypeError("parser language must match definition id");
    return freezeDefinition({ ...input, id, displayName: input.displayName.trim(), extensions, mimeTypes });
}

export class LanguageRegistry {
    private readonly definitions = new SynchronousOrderedMap<string, LanguageDefinition>();
    private readonly extensionIndex = new SynchronousUnorderedMap<string, string>();
    private readonly mimeIndex = new SynchronousUnorderedMap<string, string>();
    private readonly retired = new SynchronousUnorderedSet<string>();
    private readonly parsers = new SynchronousUnorderedMap<string, OutlineParserPort>();
    private readonly parserLoaders = new SynchronousUnorderedMap<string, () => OutlineParserPort>();
    private readonly loadingParsers = new SynchronousUnorderedSet<string>();
    private epoch = 0;
    private readonly fallbackId?: string;

    constructor(options: LanguageRegistryOptions = {}) {
        this.fallbackId = Optional.ofNullable(options.fallbackId).map(normalized).orElse(undefined) as string | undefined;
        if (options.definitions) this.registerMany(options.definitions);
        if (this.fallbackId && this.find(this.fallbackId).isEmpty()) throw new TypeError(`unknown fallback language: ${this.fallbackId}`);
    }

    get version(): number { return this.epoch; }
    get currentEpoch(): number { return this.epoch; }

    register(definition: LanguageDefinition): LanguageDefinition {
        const candidate = validateDefinition(definition);
        if (this.definitions.containsKey(candidate.id) || this.retired.contains(candidate.id)) throw new TypeError(`language id is already used: ${candidate.id}`);
        for (const extension of candidate.extensions) if (this.extensionIndex.containsKey(extension)) throw new TypeError(`extension conflict: ${extension}`);
        for (const mime of candidate.mimeTypes) if (this.mimeIndex.containsKey(mime)) throw new TypeError(`MIME conflict: ${mime}`);
        this.definitions.put(candidate.id, candidate);
        for (const extension of candidate.extensions) this.extensionIndex.put(extension, candidate.id);
        for (const mime of candidate.mimeTypes) this.mimeIndex.put(mime, candidate.id);
        if (candidate.parser) this.parsers.put(candidate.id, parserWrapper(candidate.id, candidate.parser));
        if (candidate.loadParser) this.parserLoaders.put(candidate.id, candidate.loadParser);
        this.epoch += 1;
        return freezeDefinition(candidate);
    }

    registerMany(definitions: readonly LanguageDefinition[]): readonly LanguageDefinition[] {
        if (!Array.isArray(definitions)) throw new TypeError("definitions must be an array");
        const staged = new SynchronousOrderedMap<string, LanguageDefinition>();
        const stagedExtensions = new SynchronousUnorderedMap<string, string>();
        const stagedMimes = new SynchronousUnorderedMap<string, string>();
        const normalizedDefinitions = definitions.map(validateDefinition);
        for (const candidate of normalizedDefinitions) {
            if (staged.containsKey(candidate.id) || this.definitions.containsKey(candidate.id) || this.retired.contains(candidate.id)) throw new TypeError(`language id is already used: ${candidate.id}`);
            staged.put(candidate.id, candidate);
            for (const ext of candidate.extensions) {
                if (stagedExtensions.containsKey(ext) || this.extensionIndex.containsKey(ext)) throw new TypeError(`extension conflict: ${ext}`);
                stagedExtensions.put(ext, candidate.id);
            }
            for (const mime of candidate.mimeTypes) {
                if (stagedMimes.containsKey(mime) || this.mimeIndex.containsKey(mime)) throw new TypeError(`MIME conflict: ${mime}`);
                stagedMimes.put(mime, candidate.id);
            }
        }
        for (const candidate of normalizedDefinitions) this.register(candidate);
        return Object.freeze(normalizedDefinitions.map(freezeDefinition));
    }

    unregister(id: string): boolean {
        if (!isString(id)) return false;
        id = normalized(id);
        const found = this.definitions.get(id);
        if (found.isEmpty()) return false;
        const definition = found.get();
        this.definitions.remove(id);
        for (const extension of definition.extensions) this.extensionIndex.remove(extension);
        for (const mime of definition.mimeTypes) this.mimeIndex.remove(mime);
        this.parsers.remove(id);
        this.parserLoaders.remove(id);
        this.retired.add(id);
        this.epoch += 1;
        return true;
    }

    find(id: string): Optional<LanguageDefinition> { return isString(id) ? this.definitions.get(normalized(id)).map(freezeDefinition) : Optional.empty(); }
    findByExtension(extension: string): Optional<LanguageDefinition> {
        if (!isString(extension)) return Optional.empty<LanguageDefinition>();
        const trimmed = extension.trim();
        const key = normalized(trimmed.startsWith(".") ? trimmed : `.${trimmed}`);
        return this.extensionIndex.get(key).flatMap(id => this.find(id));
    }
    list(): readonly LanguageDefinition[] { return Object.freeze(useFrom(this.definitions.values().toArray()).map(freezeDefinition).toCollectable().toArray()); }
    snapshot(): Readonly<{ epoch: number; definitions: readonly LanguageDefinition[] }> {
        return Object.freeze({ epoch: this.epoch, definitions: this.list() });
    }

    resolve(path: string, mime?: string): Optional<LanguageMatch> {
        if (!isString(path) || !path.trim() || /[\0\r\n]/.test(path)) return Optional.empty<LanguageMatch>();
        const lastSegment = path.replace(/\\/g, "/").split("/").at(-1) ?? "";
        if (!lastSegment || lastSegment === "." || lastSegment === "..") return Optional.empty<LanguageMatch>();
        const lowerSegment = lastSegment.toLowerCase();
        let extension: string | undefined;
        for (const candidate of this.extensionIndex.keySet().toArray()) {
            if (lowerSegment.endsWith(candidate) && (extension === undefined || candidate.length > extension.length)) extension = candidate;
        }
        const mimeKey = mime === undefined ? undefined : isString(mime) ? normalized(mime) : "";
        if (mimeKey !== undefined && !/^[^\s;/]+\/[^\s;/]+$/.test(mimeKey)) return Optional.empty<LanguageMatch>();
        const extId = extension ? this.extensionIndex.get(extension).orElse(undefined) as string | undefined : undefined;
        const mimeId = mimeKey ? this.mimeIndex.get(mimeKey).orElse(undefined) as string | undefined : undefined;
        if (extId && mimeId && extId !== mimeId) return Optional.empty<LanguageMatch>();
        const id = mimeId ?? extId;
        if (id) {
            const language = this.find(id).get();
            return Optional.of(Object.freeze({ language, ...(extension && extId === id ? { extension } : {}), ...(mimeKey && mimeId === id ? { mimeType: mimeKey } : {}), confidence: "exact" as const }));
        }
        const fallback = this.fallbackId ? this.find(this.fallbackId) : Optional.empty<LanguageDefinition>();
        if (mimeKey === "application/octet-stream" && fallback.isPresent()) return Optional.empty<LanguageMatch>();
        if (fallback.isEmpty() || !["text", "unsupported"].includes(fallback.get().support)) return Optional.empty<LanguageMatch>();
        return Optional.of(Object.freeze({ language: fallback.get(), ...(extension ? { extension } : {}), ...(mimeKey ? { mimeType: mimeKey } : {}), confidence: "fallback" as const }));
    }

    load(id: string): Optional<OutlineParserPort> {
        if (!isString(id)) return Optional.empty();
        id = normalized(id);
        const definition = this.find(id);
        if (definition.isEmpty() || !["outline", "text"].includes(definition.get().support)) return Optional.empty<OutlineParserPort>();
        const existing = this.parsers.get(id);
        if (existing.isPresent()) return existing;
        const loader = this.parserLoaders.get(id);
        if (loader.isEmpty()) return Optional.empty<OutlineParserPort>();
        // Loaders can re-enter or unregister themselves; only cache for the still-current registration.
        if (this.loadingParsers.contains(id)) return Optional.empty<OutlineParserPort>();
        this.loadingParsers.add(id);
        try {
            const original = loader.get()();
            if (!isObject(original) || !isString(original.language) || !isFunction(original.parse)) throw new TypeError(`invalid parser loaded for ${id}`);
            if (original.language !== id) throw new TypeError(`parser language must match definition id: ${id}`);
            const currentDefinition = this.find(id);
            const currentLoader = this.parserLoaders.get(id);
            if (currentDefinition.isEmpty() || currentLoader.isEmpty() || currentLoader.get() !== loader.get()) return Optional.empty<OutlineParserPort>();
            const parser = parserWrapper(id, original);
            this.parsers.put(id, parser);
            return Optional.of(parser);
        } finally {
            this.loadingParsers.remove(id);
        }
    }

    requireParser(id: string): OutlineParserPort {
        const parser = this.load(id);
        if (parser.isEmpty()) throw new TypeError(`no outline parser available for ${id}`);
        return parser.get();
    }

    parse(path: string, source: string, mime?: string): Optional<LanguageParseResult> {
        if (!isString(source)) throw new TypeError("source must be a string");
        const match = this.resolve(path, mime);
        if (match.isEmpty() || !["outline", "text"].includes(match.get().language.support)) return Optional.empty<LanguageParseResult>();
        const language = match.get().language;
        const parser = this.load(language.id);
        if (parser.isEmpty()) return Optional.empty<LanguageParseResult>();
        const parsed = parser.get().parse(source);
        const nodes = validateParsedNodes(source, parsed);
        return Optional.of(Object.freeze({ language, parser: parser.get(), nodes }));
    }
}
