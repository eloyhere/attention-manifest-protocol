/** Errors raised by binary document parsing; they never carry raw library exceptions. */
export type DocumentErrorCode =
    | "invalid_zip"
    | "unsupported_zip"
    | "limit_exceeded"
    | "invalid_xml"
    | "invalid_document"
    | "unsupported_format";

export class DocumentError extends Error {
    readonly code: DocumentErrorCode;

    constructor(code: DocumentErrorCode, message: string) {
        super(message);
        this.name = "DocumentError";
        this.code = code;
    }
}

/** Where an entry lives inside the source document, independent of any text projection. */
export type DocumentLocator = {
    readonly part: string;
    readonly paragraph?: number;
    readonly sheet?: string;
    readonly cell?: string;
    readonly slide?: number;
};

export type DocumentEntryKind = "heading" | "paragraph" | "table" | "sheet" | "cell" | "slide" | "section" | "note";

export interface DocumentEntry {
    readonly id: string;
    readonly parentId?: string;
    readonly kind: DocumentEntryKind;
    readonly name: string;
    readonly summary: string;
    readonly locator: DocumentLocator;
}

/**
 * Structural outline of a binary document. It is a preview projection only: it carries
 * locators into the original parts, never a claim that the bytes can be edited as text.
 */
export interface DocumentOutline {
    readonly language: string;
    readonly entries: readonly DocumentEntry[];
    /** Plain-text projection used for search/preview; not the document itself. */
    readonly text: string;
    readonly truncated: boolean;
}

export interface DocumentParserPort {
    readonly language: string;
    parse(bytes: Uint8Array): DocumentOutline;
}

export interface DocumentLimits {
    readonly maxEntries?: number;
    readonly maxEntryBytes?: number;
    readonly maxTotalBytes?: number;
    readonly maxExpansionRatio?: number;
    readonly maxNodes?: number;
    readonly maxDepth?: number;
    readonly maxEntriesInOutline?: number;
    readonly maxTextCharacters?: number;
}

export const defaultDocumentLimits: Required<DocumentLimits> = Object.freeze({
    maxEntries: 512,
    maxEntryBytes: 16 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxExpansionRatio: 200,
    maxNodes: 400_000,
    maxDepth: 128,
    maxEntriesInOutline: 20_000,
    maxTextCharacters: 2_000_000,
});
