import { Optional, isObject, isString } from "semantic-typescript";
import { createDefaultLanguageRegistry } from "../language/builtins.ts";
import type { LanguageRegistry } from "../language/registry.ts";
import { DocumentError, type DocumentEntry, type DocumentOutline } from "./types.ts";

export interface DocumentOutlineOptions {
    readonly registry?: LanguageRegistry;
    /** Forces a language id instead of resolving it from the path. */
    readonly language?: string;
}

function validateEntry(entry: unknown, index: number): DocumentEntry {
    if (!isObject(entry)) throw new DocumentError("invalid_document", `entry ${index} is not an object`);
    const value = entry as Record<string, unknown>;
    if (!isString(value.id) || !value.id || !isString(value.kind) || !isString(value.name)
        || !isString(value.summary) || !isObject(value.locator)) {
        throw new DocumentError("invalid_document", `entry ${index} is malformed`);
    }
    return Object.freeze({
        id: value.id, kind: value.kind as DocumentEntry["kind"], name: value.name, summary: value.summary,
        ...(isString(value.parentId) ? { parentId: value.parentId } : {}),
        locator: Object.freeze({ ...(value.locator as Record<string, unknown>) }) as DocumentEntry["locator"],
    });
}

/**
 * Builds the structural outline of a binary document from its raw bytes.
 * Text formats must go through `createFileOutline` instead.
 */
export function createDocumentOutline(path: string, bytes: Uint8Array, options: DocumentOutlineOptions = {}): DocumentOutline {
    if (!isString(path) || !path.trim()) throw new TypeError("document path is required");
    if (!(bytes instanceof Uint8Array)) throw new TypeError("document bytes must be a Uint8Array");
    const registry = options.registry ?? createDefaultLanguageRegistry();
    const explicit = Optional.ofNullable(options.language).flatMap(id => registry.find(id));
    const resolved = explicit.isPresent() ? explicit : registry.resolve(path).map(match => match.language);
    if (resolved.isEmpty()) throw new DocumentError("unsupported_format", `no document format is registered for ${path}`);
    const definition = resolved.get();
    const parser = definition.documentParser;
    if (!parser) {
        throw new DocumentError("unsupported_format",
            `${path} resolves to ${definition.id}, which has no binary outline parser; legacy or proprietary formats need a host adapter`);
    }
    const outline = parser.parse(bytes);
    if (!isObject(outline) || !Array.isArray(outline.entries) || !isString(outline.text) || typeof outline.truncated !== "boolean") {
        throw new DocumentError("invalid_document", `${definition.id} parser returned a malformed outline`);
    }
    const entries = Object.freeze(outline.entries.map(validateEntry));
    return Object.freeze({ language: definition.id, entries, text: outline.text, truncated: outline.truncated });
}
