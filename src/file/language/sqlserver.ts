import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("sqlserver", "sql");
export const definition: LanguageDefinition = Object.freeze({
    id: "sqlserver", displayName: "SQL Server",
    extensions: Object.freeze([".sql"]), mimeTypes: Object.freeze(["application/vnd.microsoft.sql"]),
    support: "outline", parser,
});
