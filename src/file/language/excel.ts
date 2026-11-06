import { parseXlsx } from "../document/xlsx.ts";
import type { DocumentParserPort } from "../document/types.ts";
import type { LanguageDefinition } from "./types.ts";

export const documentParser: DocumentParserPort = Object.freeze({ language: "excel", parse: parseXlsx });

export const definition: LanguageDefinition = Object.freeze({
    id: "excel", displayName: "Excel workbook",
    extensions: Object.freeze([".xls", ".xlsx", ".xlsm"]),
    mimeTypes: Object.freeze(["application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]),
    support: "tabular",
    documentParser,
});
