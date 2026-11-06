import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("c", "c");
export const definition: LanguageDefinition = Object.freeze({
    id: "c", displayName: "C",
    extensions: Object.freeze([".c", ".h"]), mimeTypes: Object.freeze(["text/x-c", "text/x-chdr"]),
    support: "outline", parser,
});
