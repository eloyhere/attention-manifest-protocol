import { unsupportedDocumentParser } from "../document/legacy.ts";
import type { LanguageDefinition } from "./types.ts";

export const documentParser = unsupportedDocumentParser("publisher", "Publisher (.pub)");

export const definition: LanguageDefinition = Object.freeze({
    id: "publisher", displayName: "Publisher document",
    extensions: Object.freeze([".pub"]), mimeTypes: Object.freeze(["application/x-mspublisher"]),
    support: "unsupported",
    documentParser,
});
