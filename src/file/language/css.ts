import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("css", "css");
export const definition: LanguageDefinition = Object.freeze({
    id: "css", displayName: "CSS",
    extensions: Object.freeze([".css"]), mimeTypes: Object.freeze(["text/css"]),
    support: "outline", parser,
});
