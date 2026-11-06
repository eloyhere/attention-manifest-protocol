/**
 * SolidWorks (`.sldprt`/`.sldasm`/`.slddrw`) outline reader.
 *
 * SolidWorks documents are OLE Compound File Binary (CFB) containers, and this
 * reader parses the complete container through `readCfb`: both CFB versions, the
 * DIFAT/FAT, directory tree, regular and mini stream chains, and property sets.
 * Storages become `section` entries, streams become `note` entries keyed by
 * their `Root/...` container paths, and SummaryInformation /
 * DocumentSummaryInformation string properties are appended as notes.
 *
 * What is not decoded: the feature tree, configurations, mates, dimensions,
 * drawing views, references and embedded preview data. Those live in
 * proprietary streams (for example `3DSketch`, `SwDocContentMgr` or versioned
 * `Objs` storages) whose encoding is not public, and only their container
 * name, size and CLSID are surfaced. `cfbStream` returns their raw bytes without
 * claiming a semantic interpretation.
 *
 * Non-compound input (for example a text STEP/IGES file renamed to `.sldprt`)
 * raises `invalid_document` instead of returning an empty outline. Budgets are
 * forwarded to `readCfb`; see that module for the per-stream and chain limits.
 */
import { CFB_DIRECTORY_FLOOR, cfbOutline, readCfb } from "./cfb.ts";
import { isLegacyOle } from "./legacy.ts";
import { DocumentError, defaultDocumentLimits, type DocumentLimits, type DocumentOutline } from "./types.ts";

export function parseSolidworks(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("SolidWorks input must be a Uint8Array");
    if (!isLegacyOle(bytes)) throw new DocumentError("invalid_document", "not a compounds document");
    // Decode enough directory entries to project the container, then let
    // `cfbOutline` apply the caller's (possibly narrower) outline budget.
    const merged = { ...defaultDocumentLimits, ...limits };
    const containerLimits: DocumentLimits = {
        ...limits,
        maxEntriesInOutline: Math.max(merged.maxEntriesInOutline, CFB_DIRECTORY_FLOOR),
    };
    return cfbOutline(readCfb(bytes, containerLimits), "solidworks", limits);
}
