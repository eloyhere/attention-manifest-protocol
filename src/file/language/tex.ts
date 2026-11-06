import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("tex", "tex");
export const definition: LanguageDefinition = Object.freeze({
    id: "tex", displayName: "TeX",
    extensions: Object.freeze([".tex", ".latex", ".ltx"]), mimeTypes: Object.freeze(["application/x-tex"]),
    support: "outline", parser,
});
