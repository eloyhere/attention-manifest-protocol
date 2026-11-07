import assert from "node:assert/strict";
import test from "node:test";
import { decodeText, detectCharset, detectLineEnding, encodeText, normalizeToEol, normalizeToLf } from "./charset.ts";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

test("UTF-8 text detects LF, CRLF and missing final newline", () => {
    const lf = detectCharset(new TextEncoder().encode("a\nb\n"));
    assert.deepEqual({ ...lf }, { encoding: "utf-8", bom: false, eol: "\n", mixedEol: false, finalNewline: true, binary: false });
    const crlf = detectCharset(new TextEncoder().encode("a\r\nb\r\n"));
    assert.equal(crlf.eol, "\r\n");
    assert.equal(crlf.mixedEol, false);
    const noFinal = detectCharset(new TextEncoder().encode("a\nb"));
    assert.equal(noFinal.finalNewline, false);
});

test("mixed line endings are reported instead of silently normalized", () => {
    const mixed = detectCharset(new TextEncoder().encode("a\r\nb\nc\r\n"));
    assert.equal(mixed.mixedEol, true);
    assert.equal(mixed.eol, "\r\n");
    assert.equal(detectCharset(new TextEncoder().encode("a\rb")).mixedEol, true);
});

test("newline-free and empty text default to LF instead of CRLF", () => {
    assert.deepEqual(detectLineEnding("abc"), { eol: "\n", mixed: false, finalNewline: false });
    assert.equal(detectLineEnding("").eol, "\n");
    assert.equal(detectLineEnding("\uFEFF").eol, "\n", "a BOM-only document has no line-ending evidence");
    assert.equal(detectCharset(bytes(0xef, 0xbb, 0xbf)).eol, "\n");
    assert.equal(detectLineEnding("a\rb").eol, "\r\n", "lone CR still selects the CRLF family");
    assert.equal(detectLineEnding("a\r\nb").eol, "\r\n");
    assert.equal(detectLineEnding("a\nb\r\nc\n").eol, "\n");
});

test("BOMs select UTF-8, UTF-16LE and UTF-16BE and are stripped from the buffer", () => {
    const utf8 = detectCharset(bytes(0xef, 0xbb, 0xbf, 0x61, 0x0a));
    assert.equal(utf8.encoding, "utf-8");
    assert.equal(utf8.bom, true);
    const utf16 = detectCharset(bytes(0xff, 0xfe, 0x61, 0x00, 0x0a, 0x00));
    assert.equal(utf16.encoding, "utf-16le");
    assert.equal(utf16.bom, true);
    assert.equal(decodeText(bytes(0xff, 0xfe, 0x61, 0x00, 0x0a, 0x00), utf16), "a\n");
    const bigEndian = detectCharset(bytes(0xfe, 0xff, 0x00, 0x61, 0x00, 0x0a));
    assert.equal(bigEndian.encoding, "utf-16be");
    assert.equal(decodeText(bytes(0xfe, 0xff, 0x00, 0x61, 0x00, 0x0a), bigEndian), "a\n");
});

test("BOM-less UTF-16 is guessed from NUL patterns, not mistaken for UTF-8", () => {
    const le = detectCharset(bytes(0x61, 0x00, 0x0a, 0x00, 0x62, 0x00, 0x0a, 0x00));
    assert.equal(le.encoding, "utf-16le");
    assert.equal(le.binary, false);
    assert.equal(decodeText(bytes(0x61, 0x00, 0x0a, 0x00, 0x62, 0x00, 0x0a, 0x00), le), "a\nb\n");
    const be = detectCharset(bytes(0x00, 0x61, 0x00, 0x0a, 0x00, 0x62, 0x00, 0x0a));
    assert.equal(be.encoding, "utf-16be");
});

test("binary and unsupported encodings are flagged rather than decoded", () => {
    assert.equal(detectCharset(bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0x01)).binary, true);
    assert.equal(detectCharset(bytes(0xff, 0xfe, 0x00, 0x00, 0x61, 0x00)).binary, true);
    assert.equal(detectCharset(bytes(0x61, 0x00, 0x62)).binary, true);
    assert.equal(detectCharset(new Uint8Array(0)).binary, false);
});

test("encodeText restores the original encoding, BOM and line endings", () => {
    const source = "a\nb\n";
    const encoded = encodeText(source, { encoding: "utf-16le", bom: true, eol: "\r\n", mixedEol: false, finalNewline: true, binary: false });
    assert.deepEqual([...encoded.subarray(0, 2)], [0xff, 0xfe]);
    assert.equal(decodeText(encoded, detectCharset(encoded)), "a\r\nb\r\n".replace(/\r\n/g, "\n"));
    assert.equal(normalizeToEol(source, "\r\n"), "a\r\nb\r\n");
    assert.equal(normalizeToLf("a\r\nb\rc\n"), "a\nb\nc\n");
    const roundTrip = detectCharset(encoded);
    assert.equal(roundTrip.encoding, "utf-16le");
    assert.equal(roundTrip.eol, "\r\n");
});

test("invalid arguments are rejected", () => {
    assert.throws(() => decodeText(Uint8Array.from([0x00]), { ...detectCharset(new TextEncoder().encode("a")), binary: true }), TypeError);
    assert.throws(() => encodeText("x", { ...detectCharset(new TextEncoder().encode("a")), binary: true }), TypeError);
    assert.throws(() => normalizeToLf(undefined as unknown as string), TypeError);
});
