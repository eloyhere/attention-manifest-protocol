import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("vue", "vue");
export const definition: LanguageDefinition = Object.freeze({
    id: "vue", displayName: "Vue",
    extensions: Object.freeze([".vue"]), mimeTypes: Object.freeze(["application/x-vue", "text/x-vue"]),
    support: "outline", parser,
});
