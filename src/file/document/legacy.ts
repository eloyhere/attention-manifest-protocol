import { DocumentError, type DocumentOutline, type DocumentParserPort } from "./types.ts";

/** OLE compound-file signature used by .doc/.xls/.ppt/.mdb/.pub. */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

export function isLegacyOle(bytes: Uint8Array): boolean {
    if (!(bytes instanceof Uint8Array) || bytes.length < OLE_SIGNATURE.length) return false;
    return OLE_SIGNATURE.every((value, index) => bytes[index] === value);
}

/**
 * Legacy formats share the OLE container and proprietary payloads; they are not parsed
 * here. Fail loudly instead of reporting an empty outline.
 */
export function assertNotLegacy(bytes: Uint8Array, format: string, target: string): void {
    if (isLegacyOle(bytes)) {
        throw new DocumentError("unsupported_format", `${format} uses the legacy OLE container; convert it to ${target} to get an outline`);
    }
}

/** A parser that always refuses, used for formats that need a host adapter. */
export function unsupportedDocumentParser(language: string, format: string): DocumentParserPort {
    return Object.freeze({
        language,
        parse(bytes: Uint8Array): DocumentOutline {
            if (!(bytes instanceof Uint8Array)) throw new TypeError("document input must be a Uint8Array");
            throw new DocumentError("unsupported_format", `outline parsing for ${format} is not implemented; a host adapter is required`);
        },
    });
}
