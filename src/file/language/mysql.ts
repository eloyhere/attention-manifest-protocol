import { createScanningParser } from "./parsers.ts";
import type { LanguageDefinition } from "./types.ts";

export const parser = createScanningParser("mysql", "sql");
export const definition: LanguageDefinition = Object.freeze({
    id: "mysql", displayName: "MySQL",
    extensions: Object.freeze([".mysql", ".my.sql"]), mimeTypes: Object.freeze(["application/vnd.mysql"]),
    support: "outline", parser,
});
