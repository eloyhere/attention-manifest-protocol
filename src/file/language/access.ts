import { unsupportedDocumentParser } from "../document/legacy.ts";
import type { LanguageDefinition } from "./types.ts";

export const documentParser = unsupportedDocumentParser("access", "Access (.mdb/.accdb)");

export const definition: LanguageDefinition = Object.freeze({
    id: "access", displayName: "Access database",
    extensions: Object.freeze([".mdb", ".accdb"]), mimeTypes: Object.freeze(["application/x-msaccess"]),
    support: "unsupported",
    documentParser,
});
