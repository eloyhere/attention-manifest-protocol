import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("html", "html");
export const definition: LanguageDefinition = Object.freeze({
    id: "html", displayName: "HTML",
    extensions: Object.freeze([".html", ".htm", ".xhtml"]), mimeTypes: Object.freeze(["text/html", "application/xhtml+xml"]),
    support: "outline", parser,
});
