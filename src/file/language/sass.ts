import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("sass", "sass");
export const definition: LanguageDefinition = Object.freeze({
    id: "sass", displayName: "Sass",
    extensions: Object.freeze([".sass"]), mimeTypes: Object.freeze(["text/x-sass", "text/sass"]),
    support: "outline", parser,
});
