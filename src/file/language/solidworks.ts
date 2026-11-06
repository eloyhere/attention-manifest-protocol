import { parseSolidworks } from "../document/solidworks.ts";
import type { DocumentParserPort } from "../document/types.ts";
import type { LanguageDefinition } from "./types.ts";

/** SolidWorks compound documents are always refused; the port exists for uniform dispatch. */
export const documentParser: DocumentParserPort = Object.freeze({
    language: "solidworks",
    parse: (bytes: Uint8Array) => parseSolidworks(bytes),
});

/** Parts, assemblies and drawings share the OLE container and the same unsupported outcome. */
export const definition: LanguageDefinition = Object.freeze({
    id: "solidworks", displayName: "SolidWorks",
    extensions: Object.freeze([".sldprt", ".sldasm", ".slddrw"]),
    mimeTypes: Object.freeze(["application/x-solidworks", "application/x-sldprt"]),
    support: "document",
    documentParser,
});
