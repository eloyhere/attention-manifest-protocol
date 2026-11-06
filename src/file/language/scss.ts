import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("scss", "scss");
export const definition: LanguageDefinition = Object.freeze({
    id: "scss", displayName: "SCSS",
    extensions: Object.freeze([".scss"]), mimeTypes: Object.freeze(["text/x-scss", "text/scss"]),
    support: "outline", parser,
});
