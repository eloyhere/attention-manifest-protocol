import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("java", "java");
export const definition: LanguageDefinition = Object.freeze({
    id: "java", displayName: "Java",
    extensions: Object.freeze([".java"]), mimeTypes: Object.freeze(["text/x-java-source", "text/x-java"]),
    support: "outline", parser,
});
