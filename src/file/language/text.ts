import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("text", "text");
export const definition: LanguageDefinition = Object.freeze({
    id: "text", displayName: "Plain text",
    extensions: Object.freeze([".txt", ".text"]), mimeTypes: Object.freeze(["text/plain"]),
    support: "text", parser,
});
