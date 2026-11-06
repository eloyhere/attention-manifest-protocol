import { parseMax3d } from "../document/max3d.ts";
import type { DocumentParserPort } from "../document/types.ts";
import type { LanguageDefinition } from "./types.ts";

/** Binary entrance shared by `.3ds` chunk streams and `.max` containers (which are refused). */
export const documentParser: DocumentParserPort = Object.freeze({
    language: "max3d",
    parse: (bytes: Uint8Array) => parseMax3d(bytes),
});

/** 3ds Max and 3D Studio files are binary; they never take the text-outline path. */
export const definition: LanguageDefinition = Object.freeze({
    id: "max3d", displayName: "3ds Max",
    extensions: Object.freeze([".max", ".3ds"]),
    mimeTypes: Object.freeze(["application/x-3dsmax", "application/x-3ds"]),
    support: "document",
    documentParser,
});
