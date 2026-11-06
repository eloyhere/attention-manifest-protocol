import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("javascript", "javascript");
export const definition: LanguageDefinition = Object.freeze({
    id: "javascript", displayName: "JavaScript",
    extensions: Object.freeze([".js", ".jsx", ".mjs", ".cjs"]),
    mimeTypes: Object.freeze(["text/javascript", "application/javascript"]),
    support: "outline", parser,
});
