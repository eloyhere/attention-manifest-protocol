/**
 * SolidWorks (`.sldprt`/`.sldasm`/`.slddrw`) outline reader.
 *
 * Scope: none. SolidWorks documents are OLE compound files whose part, assembly
 * and drawing payloads (feature tree, configurations, mates, drawing views,
 * references) live in proprietary streams that only the SolidWorks kernel can
 * interpret. Those streams are not parsed, and no OLE directory entry is read.
 * Every input therefore fails loudly instead of returning an empty outline that
 * would pass for a successful parse: compound documents raise
 * `unsupported_format` with an export/host-adapter hint, and anything else (for
 * example a text STEP/IGES file renamed to `.sldprt`) raises `invalid_document`.
 *
 * The `limits` argument is accepted so the signature matches the other document
 * parsers, but no budget can apply because no byte of a SolidWorks document is
 * ever projected into an outline.
 */
import { isLegacyOle } from "./legacy.ts";
import { DocumentError, type DocumentLimits, type DocumentOutline } from "./types.ts";

const OLE_UNSUPPORTED = "SolidWorks parts/assemblies store proprietary OLE streams; the feature tree is not parsed. "
    + "Export STEP/IGES or provide a host adapter.";

export function parseSolidworks(bytes: Uint8Array, _limits?: DocumentLimits): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("SolidWorks input must be a Uint8Array");
    if (isLegacyOle(bytes)) throw new DocumentError("unsupported_format", OLE_UNSUPPORTED);
    throw new DocumentError("invalid_document", "not a SolidWorks compound document");
}
