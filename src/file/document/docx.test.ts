import assert from "node:assert/strict";
import test from "node:test";
import { parseDocx } from "./docx.ts";
import { createZip } from "./testZip.ts";
import { DocumentError, defaultDocumentLimits } from "./types.ts";

const WORD_NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function documentXml(body: string): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${WORD_NAMESPACE}><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

function makeDocx(body: string): Uint8Array {
    return createZip({ "word/document.xml": documentXml(body) });
}

function paragraph(text: string, style?: string): string {
    const properties = style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
    return `<w:p>${properties}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function table(rows: readonly (readonly string[])[]): string {
    const trs = rows.map(row => `<w:tr>${row.map(cell => `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("");
    return `<w:tbl><w:tblPr/>${trs}</w:tbl>`;
}

function errorCode(code: DocumentError["code"]) {
    return (error: unknown): boolean => error instanceof DocumentError && error.code === code;
}

test("docx projects headings, paragraphs and tables in body order", () => {
    const outline = parseDocx(makeDocx([
        paragraph("Quarterly report", "Title"),
        paragraph("Opening paragraph."),
        table([["A1", "B1"], ["A2", "B2"]]),
        paragraph(""),
        paragraph("Closing paragraph."),
    ].join("")));

    assert.equal(outline.language, "word");
    assert.equal(outline.truncated, false);
    assert.equal(outline.entries.length, 4);

    const title = outline.entries[0]!;
    assert.equal(title.id, "word:paragraph:1");
    assert.equal(title.kind, "heading");
    assert.equal(title.name, "Quarterly report");
    assert.equal(title.summary, "Quarterly report");
    assert.deepEqual(title.locator, { part: "word/document.xml", paragraph: 1 });

    const opening = outline.entries[1]!;
    assert.equal(opening.id, "word:paragraph:2");
    assert.equal(opening.kind, "paragraph");
    assert.equal(opening.summary, "Opening paragraph.");
    assert.deepEqual(opening.locator, { part: "word/document.xml", paragraph: 2 });

    const tableEntry = outline.entries[2]!;
    assert.equal(tableEntry.id, "word:table:1");
    assert.equal(tableEntry.kind, "table");
    assert.equal(tableEntry.name, "Table 1");
    assert.equal(tableEntry.summary, "A1 | B1\nA2 | B2");
    assert.deepEqual(tableEntry.locator, { part: "word/document.xml" });

    const closing = outline.entries[3]!;
    assert.equal(closing.id, "word:paragraph:4");
    assert.equal(closing.kind, "paragraph");
    assert.equal(closing.summary, "Closing paragraph.");
    // The empty body paragraph occupies paragraph number 3 even though it has no entry.
    assert.deepEqual(closing.locator, { part: "word/document.xml", paragraph: 4 });

    assert.equal(outline.text, "Quarterly report\nOpening paragraph.\nA1 | B1\nA2 | B2\nClosing paragraph.");

    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    assert.equal(Object.isFrozen(title), true);
    assert.equal(Object.isFrozen(title.locator), true);
});

test("docx joins split text runs, decodes entities and clamps names to 120 characters", () => {
    const longText = "x".repeat(150);
    const outline = parseDocx(makeDocx([
        `<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world &amp; friends</w:t></w:r></w:p>`,
        `<w:p><w:pPr><w:pStyle w:val="heading3"/></w:pPr><w:r><w:t>${longText}</w:t></w:r></w:p>`,
    ].join("")));

    assert.equal(outline.entries.length, 2);
    const combined = outline.entries[0]!;
    assert.equal(combined.kind, "paragraph");
    assert.equal(combined.summary, "Hello world & friends");
    const heading = outline.entries[1]!;
    assert.equal(heading.kind, "heading");
    assert.equal(heading.name.length, 120);
    assert.equal(heading.summary, longText);
});

test("docx returns an empty outline for a legal document with no body content", () => {
    const outline = parseDocx(makeDocx(""));
    assert.deepEqual(outline.entries, []);
    assert.equal(outline.text, "");
    assert.equal(outline.truncated, false);
});

test("docx rejects missing parts, non-zip bytes and legacy OLE containers", () => {
    assert.throws(() => parseDocx(createZip({ "word/styles.xml": "<styles/>" })), errorCode("invalid_document"));
    assert.throws(() => parseDocx(new TextEncoder().encode("plain text")), errorCode("invalid_zip"));
    assert.throws(() => parseDocx(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), errorCode("unsupported_format"));
});

test("docx rejects malformed XML, a missing body and non-byte input", () => {
    assert.throws(() => parseDocx(createZip({ "word/document.xml": "<w:document" })), errorCode("invalid_xml"));
    assert.throws(() => parseDocx(createZip({ "word/document.xml": `<w:document ${WORD_NAMESPACE}></w:document>` })), errorCode("invalid_document"));
    assert.throws(() => parseDocx("not bytes" as unknown as Uint8Array), TypeError);
});

test("docx clips at the outline budget and marks the result truncated", () => {
    const body: string[] = [];
    const count = defaultDocumentLimits.maxEntriesInOutline + 1;
    for (let index = 0; index < count; index += 1) body.push(paragraph(`Entry ${index} ${index.toString(36)}`));
    const outline = parseDocx(makeDocx(body.join("")));

    assert.equal(outline.entries.length, defaultDocumentLimits.maxEntriesInOutline);
    assert.equal(outline.truncated, true);
    assert.ok(outline.text.length <= defaultDocumentLimits.maxTextCharacters);
});

test("docx honors caller-supplied outline budgets", () => {
    const entries = parseDocx(makeDocx([
        paragraph("One"),
        paragraph("Two"),
        paragraph("Three"),
    ].join("")), { maxEntriesInOutline: 2 });
    assert.equal(entries.entries.length, 2);
    assert.equal(entries.truncated, true);

    const text = parseDocx(makeDocx(paragraph("0123456789abcdef")), { maxTextCharacters: 10 });
    assert.equal(text.entries[0]!.summary, "0123456789");
    assert.equal(text.text, "0123456789");
    assert.equal(text.truncated, true);
});
