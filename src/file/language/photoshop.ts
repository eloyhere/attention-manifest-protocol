import { parsePsd } from "../document/photoshop.ts";
import type { DocumentParserPort } from "../document/types.ts";
import type { LanguageDefinition } from "./types.ts";

/** PSD v1 and PSB v2 outline adapter: layer tree, groups, names, bounds; pixel data is not decoded. */
export const documentParser: DocumentParserPort = Object.freeze({ language: "photoshop", parse: parsePsd });

export const definition: LanguageDefinition = Object.freeze({
    id: "photoshop", displayName: "Adobe Photoshop",
    extensions: Object.freeze([".psd", ".psb", ".psdt"]),
    mimeTypes: Object.freeze(["image/vnd.adobe.photoshop", "application/x-photoshop"]),
    support: "document",
    documentParser,
});
