import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("oracle", "sql");
export const definition: LanguageDefinition = Object.freeze({
    id: "oracle", displayName: "Oracle SQL",
    extensions: Object.freeze([".pls", ".pks", ".pkb", ".plb"]), mimeTypes: Object.freeze(["application/vnd.oracle.sql"]),
    support: "outline", parser,
});
