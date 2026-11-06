import { parseArchiveOutline } from "../document/archive.ts";
import type { DocumentParserPort } from "../document/types.ts";
import type { LanguageDefinition } from "./types.ts";

export const documentParser: DocumentParserPort = Object.freeze({ language: "compress", parse: parseArchiveOutline });

export const definition: LanguageDefinition = Object.freeze({
    id: "compress", displayName: "Compressed archive",
    extensions: Object.freeze([".zip", ".tar", ".tar.gz", ".tgz", ".gz", ".7z", ".rar", ".xz", ".bz2", ".zst"]),
    mimeTypes: Object.freeze(["application/zip", "application/x-tar", "application/gzip", "application/x-7z-compressed",
        "application/vnd.rar", "application/x-xz", "application/x-bzip2", "application/zstd"]),
    support: "document",
    documentParser,
});
