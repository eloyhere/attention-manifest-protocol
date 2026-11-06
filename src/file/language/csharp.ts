import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("csharp", "csharp");
export const definition: LanguageDefinition = Object.freeze({
    id: "csharp", displayName: "C#",
    extensions: Object.freeze([".cs", ".csx"]), mimeTypes: Object.freeze(["text/x-csharp", "text/x-cs"]),
    support: "outline", parser,
});
