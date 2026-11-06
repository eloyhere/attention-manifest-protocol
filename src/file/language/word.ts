import { parseWord } from "../document/office.ts";
import type { DocumentParserPort } from "../document/types.ts";
import type { LanguageDefinition } from "./types.ts";

export const documentParser: DocumentParserPort = Object.freeze({ language: "word", parse: parseWord });

export const definition: LanguageDefinition = Object.freeze({
    id: "word", displayName: "Word document",
    extensions: Object.freeze([".doc", ".docx", ".docm"]),
    mimeTypes: Object.freeze(["application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]),
    support: "document",
    documentParser,
});
