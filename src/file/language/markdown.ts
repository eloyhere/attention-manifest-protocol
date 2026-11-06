import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("markdown", "markdown");
export const definition: LanguageDefinition = Object.freeze({
    id: "markdown", displayName: "Markdown",
    extensions: Object.freeze([".md", ".markdown", ".mdown"]), mimeTypes: Object.freeze(["text/markdown"]),
    support: "outline", parser,
});
