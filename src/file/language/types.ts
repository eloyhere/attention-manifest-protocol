import type { OutlineParserPort, ParsedOutlineNode } from "../outline.ts";
import type { DocumentParserPort } from "../document/types.ts";

export type LanguageId = string;
export type LanguageSupport = "outline" | "text" | "document" | "tabular" | "unsupported";

export interface LanguageDefinition {
    readonly id: LanguageId;
    readonly displayName: string;
    readonly extensions: readonly string[];
    readonly mimeTypes: readonly string[];
    readonly support: LanguageSupport;
    readonly parser?: OutlineParserPort;
    readonly loadParser?: () => OutlineParserPort;
    /** Binary document outline parser; only valid with `support: "document" | "tabular"`. */
    readonly documentParser?: DocumentParserPort;
}

export interface LanguageMatch {
    readonly language: LanguageDefinition;
    readonly extension?: string;
    readonly mimeType?: string;
    readonly confidence: "exact" | "fallback";
}

export interface LanguageRegistryOptions {
    readonly definitions?: readonly LanguageDefinition[];
    readonly fallbackId?: LanguageId;
}

/** Immutable point-in-time view; epoch changes on every successful registry mutation. */
export interface LanguageRegistrySnapshot {
    readonly epoch: number;
    readonly definitions: readonly LanguageDefinition[];
}

export interface LanguageParseResult {
    readonly language: LanguageDefinition;
    readonly parser: OutlineParserPort;
    readonly nodes: readonly ParsedOutlineNode[];
}
