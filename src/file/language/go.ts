import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("go", "go");
export const definition: LanguageDefinition = Object.freeze({
    id: "go", displayName: "Go",
    extensions: Object.freeze([".go"]),
    mimeTypes: Object.freeze(["text/x-go", "application/vnd.go"]),
    support: "outline", parser,
});
