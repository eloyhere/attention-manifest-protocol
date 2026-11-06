import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("typescript", "typescript");
export const definition: LanguageDefinition = Object.freeze({
    id: "typescript", displayName: "TypeScript",
    extensions: Object.freeze([".ts", ".tsx", ".mts", ".cts"]),
    mimeTypes: Object.freeze(["text/typescript", "application/typescript"]),
    support: "outline", parser,
});
