import { parsePptx } from "../document/pptx.ts";
import type { DocumentParserPort } from "../document/types.ts";
import type { LanguageDefinition } from "./types.ts";

export const documentParser: DocumentParserPort = Object.freeze({ language: "powerpoint", parse: parsePptx });

export const definition: LanguageDefinition = Object.freeze({
    id: "powerpoint", displayName: "PowerPoint presentation",
    extensions: Object.freeze([".ppt", ".pptx", ".pptm"]),
    mimeTypes: Object.freeze(["application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"]),
    support: "document",
    documentParser,
});
