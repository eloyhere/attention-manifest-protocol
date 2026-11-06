import assert from "node:assert/strict";
import test from "node:test";
import { parsePptx } from "./pptx.ts";
import { createZip } from "./testZip.ts";
import { DocumentError } from "./types.ts";
import { parseXml } from "./xml.ts";
import { ZipArchive } from "./zip.ts";

const encoder = new TextEncoder();

function errorCode(operation: () => unknown): string {
    try {
        operation();
    } catch (error) {
        if (error instanceof DocumentError) return error.code;
        throw error;
    }
    assert.fail("expected a DocumentError");
}

function oleBytes(size = 512): Uint8Array {
    const bytes = new Uint8Array(size);
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    return bytes;
}

/**
 * Rewrites an ASCII name in both the local header and the central directory. The
 * replacement keeps the byte length so no ZIP field has to be resized.
 */
function renameAscii(bytes: Uint8Array, from: string, to: string): Uint8Array {
    const source = encoder.encode(from);
    const replacement = encoder.encode(to);
    assert.equal(source.length, replacement.length, "replacement must keep the byte length");
    const output = new Uint8Array(bytes);
    let replacements = 0;
    for (let index = 0; index + source.length <= output.length; index += 1) {
        let matches = true;
        for (let offset = 0; offset < source.length; offset += 1) {
            if (output[index + offset] !== source[offset]) {
                matches = false;
                break;
            }
        }
        if (!matches) continue;
        output.set(replacement, index);
        replacements += 1;
    }
    assert.equal(replacements, 2, "the name must appear in the local header and the central directory");
    return output;
}

test("non-zip bytes and truncated archives are invalid_zip", () => {
    assert.equal(errorCode(() => ZipArchive.open(new Uint8Array(0))), "invalid_zip");
    assert.equal(errorCode(() => ZipArchive.open(new Uint8Array(64))), "invalid_zip");
    assert.equal(errorCode(() => ZipArchive.open(encoder.encode("this is definitely not a zip archive"))), "invalid_zip");
    const archive = createZip({ "a.txt": "hello" });
    assert.equal(errorCode(() => ZipArchive.open(archive.slice(0, archive.length - 5))), "invalid_zip");
    assert.equal(errorCode(() => ZipArchive.open(archive.slice(0, 30))), "invalid_zip");
});

test("the OLE signature is invalid_zip for the ZIP reader and unsupported_format for the parser", () => {
    const ole = oleBytes();
    assert.equal(errorCode(() => ZipArchive.open(ole)), "invalid_zip");
    assert.equal(errorCode(() => parsePptx(ole)), "unsupported_format");
});

test("the entry-count budget is enforced before reading entries", () => {
    const twoFiles = createZip({ "a.txt": "a", "b.txt": "b" });
    assert.equal(errorCode(() => ZipArchive.open(twoFiles, { maxEntries: 1 })), "limit_exceeded");
    assert.equal(ZipArchive.open(twoFiles, { maxEntries: 2 }).names().length, 2);
});

test("the per-entry size budget is enforced", () => {
    const nineBytes = createZip({ "a.txt": "123456789" });
    assert.equal(errorCode(() => ZipArchive.open(nineBytes, { maxEntryBytes: 8 })), "limit_exceeded");
    assert.equal(ZipArchive.open(nineBytes, { maxEntryBytes: 9 }).read("a.txt").get().size, 9);
});

test("the total uncompressed budget is enforced", () => {
    const twoTenByteFiles = createZip({ "a.txt": "0123456789", "b.txt": "0123456789" });
    assert.equal(errorCode(() => ZipArchive.open(twoTenByteFiles, { maxTotalBytes: 16 })), "limit_exceeded");
    assert.equal(ZipArchive.open(twoTenByteFiles, { maxTotalBytes: 20 }).names().length, 2);
});

test("the expansion-ratio budget is enforced", () => {
    const compressed = createZip({ "bomb.txt": "a".repeat(100_000) });
    assert.equal(errorCode(() => ZipArchive.open(compressed)), "limit_exceeded");
    assert.equal(ZipArchive.open(compressed, { maxExpansionRatio: 10_000 }).names().length, 1);
});

test("path traversal entry names are rejected as invalid_zip", () => {
    const safe = createZip({ "xx/evil.xml": "<a/>" });
    const traversal = renameAscii(safe, "xx/evil.xml", "../evil.xml");
    assert.equal(errorCode(() => ZipArchive.open(traversal)), "invalid_zip");
    assert.equal(errorCode(() => parsePptx(traversal)), "invalid_zip");
});

test("backslash entry names and duplicate entry names are rejected as invalid_zip", () => {
    const safe = createZip({ "xx/evil.xml": "<a/>" });
    assert.equal(errorCode(() => ZipArchive.open(renameAscii(safe, "xx/evil.xml", "xx\\evil.xml"))), "invalid_zip");
    const duplicateSource = createZip({ "aa.txt": "a", "bb.txt": "b" });
    assert.equal(errorCode(() => ZipArchive.open(renameAscii(duplicateSource, "bb.txt", "aa.txt"))), "invalid_zip");
});

test("parseXml rejects DTDs and entity declarations", () => {
    assert.equal(errorCode(() => parseXml('<!DOCTYPE a SYSTEM "a.dtd"><a/>')), "invalid_xml");
    assert.equal(errorCode(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')), "invalid_xml");
});

test("parseXml rejects unclosed and mismatched tags", () => {
    assert.equal(errorCode(() => parseXml("<a><b></b>")), "invalid_xml");
    assert.equal(errorCode(() => parseXml("<a><b></a>")), "invalid_xml");
    assert.equal(errorCode(() => parseXml("<a>")), "invalid_xml");
});

test("parseXml decodes known entities and rejects unknown ones", () => {
    const node = parseXml('<a k="&amp; &quot;q&quot;">x &amp; y &lt; &#65; &#x42;</a>');
    assert.equal(node.text, 'x & y < A B');
    assert.equal(node.attrs.k, '& "q"');
    assert.equal(errorCode(() => parseXml("<a>&nope;</a>")), "invalid_xml");
    assert.equal(errorCode(() => parseXml('<a k="&nope;"/>')), "invalid_xml");
});

test("parseXml enforces the depth budget", () => {
    const nested = "<a><b><c><d></d></c></b></a>";
    assert.equal(errorCode(() => parseXml(nested, { maxDepth: 3 })), "limit_exceeded");
    const accepted = parseXml(nested);
    assert.equal(accepted.children[0]!.children[0]!.children[0]!.name, "d");
    assert.equal(parseXml(nested, { maxDepth: 4 }).name, "a");
});

test("parseXml enforces the node budget", () => {
    assert.equal(errorCode(() => parseXml("<a><b/><b/></a>", { maxNodes: 1 })), "limit_exceeded");
    assert.equal(parseXml("<a><b/><b/></a>", { maxNodes: 3 }).children.length, 2);
});

test("parseXml builds the expected structure for nested elements", () => {
    const root = parseXml("<a><b><c/></b><d/></a>");
    assert.equal(root.name, "a");
    assert.equal(root.local, "a");
    assert.equal(root.children.length, 2);
    assert.equal(root.children[0]!.name, "b");
    assert.equal(root.children[0]!.children[0]!.name, "c");
    assert.equal(root.children[1]!.name, "d");
});

test("parseXml preserves CDATA text verbatim", () => {
    const root = parseXml("<a><![CDATA[x < y & z &amp;]]></a>");
    assert.equal(root.text, "x < y & z &amp;");
});

test("parseXml rejects non-string input", () => {
    assert.throws(() => parseXml(42 as unknown as string), TypeError);
});

test("parsed nodes, children arrays and attributes are frozen", () => {
    const root = parseXml('<a k="v"><b/></a>');
    assert.equal(Object.isFrozen(root), true);
    assert.equal(Object.isFrozen(root.children), true);
    assert.equal(Object.isFrozen(root.attrs), true);
    assert.equal(Object.isFrozen(root.children[0]), true);
    assert.equal(Object.isFrozen(root.children[0]!.attrs), true);
    assert.equal(Object.isFrozen(root.children[0]!.children), true);
});
