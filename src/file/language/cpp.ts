import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("cpp", "cpp");
export const definition: LanguageDefinition = Object.freeze({
    id: "cpp", displayName: "C++",
    extensions: Object.freeze([".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]),
    mimeTypes: Object.freeze(["text/x-c++", "text/x-c++hdr"]),
    support: "outline", parser,
});
