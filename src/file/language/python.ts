import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("python", "python");
export const definition: LanguageDefinition = Object.freeze({
    id: "python", displayName: "Python",
    extensions: Object.freeze([".py", ".pyw", ".pyi"]), mimeTypes: Object.freeze(["text/x-python", "application/x-python"]),
    support: "outline", parser,
});
