import { parseCad } from "../document/cad.ts";
import type { DocumentParserPort } from "../document/types.ts";
import type { LanguageDefinition } from "./types.ts";

/** DXF outline adapter; DWG input is recognized and refused with `unsupported_format`. */
export const documentParser: DocumentParserPort = Object.freeze({ language: "cad", parse: parseCad });

export const definition: LanguageDefinition = Object.freeze({
    id: "cad", displayName: "CAD",
    extensions: Object.freeze([".dxf", ".dwg", ".dwt"]),
    mimeTypes: Object.freeze(["image/vnd.dxf", "application/acad"]),
    support: "document",
    documentParser,
});
