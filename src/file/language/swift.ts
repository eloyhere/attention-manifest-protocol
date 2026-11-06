import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("swift", "swift");
export const definition: LanguageDefinition = Object.freeze({
    id: "swift", displayName: "Swift",
    extensions: Object.freeze([".swift"]),
    mimeTypes: Object.freeze(["text/x-swift", "application/swift"]),
    support: "outline", parser,
});
