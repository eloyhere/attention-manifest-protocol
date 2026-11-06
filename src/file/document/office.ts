import { parseDocx } from "./docx.ts";
import { parseDoc } from "./legacyDoc.ts";
import { parsePpt } from "./legacyPpt.ts";
import { parseXls } from "./legacyXls.ts";
import { isLegacyOle } from "./legacy.ts";
import { parsePptx } from "./pptx.ts";
import { parseXlsx } from "./xlsx.ts";
import type { DocumentLimits, DocumentOutline } from "./types.ts";

/**
 * Format dispatchers for the Office families: OLE compound documents go to the
 * legacy readers, ZIP packages to the OOXML readers. Both paths are read-only.
 */
export function parseWord(bytes: Uint8Array, limits?: DocumentLimits): DocumentOutline {
    return isLegacyOle(bytes) ? parseDoc(bytes, limits) : parseDocx(bytes, limits);
}

export function parseExcel(bytes: Uint8Array, limits?: DocumentLimits): DocumentOutline {
    return isLegacyOle(bytes) ? parseXls(bytes, limits) : parseXlsx(bytes, limits);
}

export function parsePowerPoint(bytes: Uint8Array, limits?: DocumentLimits): DocumentOutline {
    return isLegacyOle(bytes) ? parsePpt(bytes, limits) : parsePptx(bytes, limits);
}
