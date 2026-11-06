import assert from "node:assert/strict";
import test from "node:test";
import { parseXlsx } from "./xlsx.ts";
import { createZip } from "./testZip.ts";
import { DocumentError, defaultDocumentLimits } from "./types.ts";

const MAIN_NAMESPACE = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const RELATIONSHIPS_NAMESPACE = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const OFFICE_RELATIONSHIPS_NAMESPACE = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function workbook(sheets: readonly { readonly name: string; readonly relationshipId: string }[]): string {
    const entries = sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="${sheet.relationshipId}"/>`).join("");
    return `<?xml version="1.0"?><workbook ${MAIN_NAMESPACE} ${OFFICE_RELATIONSHIPS_NAMESPACE}><sheets>${entries}</sheets></workbook>`;
}

function relationships(entries: readonly { readonly id: string; readonly target: string; readonly mode?: string }[]): string {
    const body = entries.map(entry => `<Relationship Id="${entry.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${entry.target}"${entry.mode === undefined ? "" : ` TargetMode="${entry.mode}"`}/>`).join("");
    return `<?xml version="1.0"?><Relationships ${RELATIONSHIPS_NAMESPACE}>${body}</Relationships>`;
}

function worksheet(rows: string): string {
    return `<?xml version="1.0"?><worksheet ${MAIN_NAMESPACE}><sheetData>${rows}</sheetData></worksheet>`;
}

function errorCode(code: DocumentError["code"]) {
    return (error: unknown): boolean => error instanceof DocumentError && error.code === code;
}

const SHARED_STRINGS = `<?xml version="1.0"?><sst ${MAIN_NAMESPACE} count="2" uniqueCount="2">`
    + `<si><t>Hello</t></si><si><r><t>Rich</t></r><r><t> text</t></r></si></sst>`;

const MAIN_WORKSHEET = `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>`
    + `<row r="2"><c r="A2" t="inlineStr"><is><t>Inline</t></is></c><c r="B2" t="s"><v>1</v></c></row>`
    + `<row r="3"><c r="A3"/><c r="B3" t="s"><v>99</v></c></row>`;

function makeWorkbook(sheets: readonly { readonly name: string; readonly relationshipId: string }[]): Uint8Array {
    return createZip({
        "xl/workbook.xml": workbook(sheets),
        "xl/_rels/workbook.xml.rels": relationships([{ id: "rId1", target: "worksheets/sheet1.xml" }]),
        "xl/sharedStrings.xml": SHARED_STRINGS,
        "xl/worksheets/sheet1.xml": worksheet(MAIN_WORKSHEET),
    });
}

test("xlsx projects sheets, shared strings, inline strings and numbers", () => {
    const outline = parseXlsx(makeWorkbook([{ name: "Data", relationshipId: "rId1" }]));

    assert.equal(outline.language, "excel");
    assert.equal(outline.truncated, false);
    assert.equal(outline.entries.length, 5);

    const sheet = outline.entries[0]!;
    assert.equal(sheet.id, "xlsx:sheet:0");
    assert.equal(sheet.kind, "sheet");
    assert.equal(sheet.name, "Data");
    assert.equal(sheet.summary, "3 rows, 6 cells");
    assert.deepEqual(sheet.locator, { part: "xl/worksheets/sheet1.xml", sheet: "Data" });

    const cells = outline.entries.slice(1);
    assert.deepEqual(cells.map(cell => cell.id), ["xlsx:cell:0:A1", "xlsx:cell:0:B1", "xlsx:cell:0:A2", "xlsx:cell:0:B2"]);
    const byRef = (ref: string) => cells.find(cell => cell.locator.cell === ref)!;

    const shared = byRef("A1");
    assert.equal(shared.kind, "cell");
    assert.equal(shared.name, "Data!A1");
    assert.equal(shared.summary, "Hello");
    assert.equal(shared.parentId, "xlsx:sheet:0");
    assert.deepEqual(shared.locator, { part: "xl/worksheets/sheet1.xml", sheet: "Data", cell: "A1" });

    assert.equal(byRef("B1").summary, "42");
    assert.equal(byRef("A2").summary, "Inline");
    assert.equal(byRef("B2").summary, "Rich text");

    // A3 is empty and B3 points past the shared string table: neither yields an entry.
    assert.equal(cells.some(cell => cell.locator.cell === "A3"), false);
    assert.equal(cells.some(cell => cell.locator.cell === "B3"), false);
    assert.equal(outline.text, "3 rows, 6 cells\nHello\n42\nInline\nRich text");

    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    assert.equal(Object.isFrozen(sheet), true);
    assert.equal(Object.isFrozen(shared), true);
    assert.equal(Object.isFrozen(shared.locator), true);
});

test("xlsx confines relationship targets to xl/ and ignores external relationships", () => {
    const outline = parseXlsx(createZip({
        "xl/workbook.xml": workbook([
            { name: "First", relationshipId: "rId1" },
            { name: "External", relationshipId: "rId2" },
            { name: "Absolute", relationshipId: "rId3" },
            { name: "Escape", relationshipId: "rId4" },
            { name: "Prefixed", relationshipId: "rId5" },
        ]),
        "xl/_rels/workbook.xml.rels": relationships([
            { id: "rId1", target: "worksheets/sheet1.xml" },
            { id: "rId2", target: "https://example.com/book.xlsx", mode: "External" },
            { id: "rId3", target: "/xl/worksheets/sheet2.xml" },
            { id: "rId4", target: "../outside.xml" },
            { id: "rId5", target: "xl/worksheets/sheet3.xml" },
        ]),
        "xl/worksheets/sheet1.xml": worksheet(`<row r="1"><c r="A1"><v>1</v></c></row>`),
        "xl/worksheets/sheet2.xml": worksheet(`<row r="1"><c r="A1"><v>2</v></c></row>`),
        "xl/worksheets/sheet3.xml": worksheet(`<row r="1"><c r="A1"><v>3</v></c></row>`),
        "outside.xml": worksheet(`<row r="1"><c r="A1"><v>999</v></c></row>`),
    }));

    const sheets = outline.entries.filter(entry => entry.kind === "sheet");
    assert.deepEqual(sheets.map(entry => entry.name), ["First", "Absolute", "Prefixed"]);
    assert.deepEqual(sheets.map(entry => entry.id), ["xlsx:sheet:0", "xlsx:sheet:2", "xlsx:sheet:4"]);
    assert.deepEqual(sheets.map(entry => entry.locator.part), [
        "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml",
    ]);
    assert.equal(outline.entries.some(entry => entry.summary === "999"), false);
});

test("xlsx returns an empty outline for a workbook with no sheets", () => {
    const outline = parseXlsx(createZip({ "xl/workbook.xml": workbook([]) }));
    assert.deepEqual(outline.entries, []);
    assert.equal(outline.text, "");
    assert.equal(outline.truncated, false);
});

test("xlsx rejects missing parts, non-zip bytes and legacy OLE containers", () => {
    assert.throws(() => parseXlsx(createZip({ "xl/worksheets/sheet1.xml": worksheet("") })), errorCode("invalid_document"));
    assert.throws(() => parseXlsx(new TextEncoder().encode("plain text")), errorCode("invalid_zip"));
    assert.throws(() => parseXlsx(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), errorCode("unsupported_format"));
});

test("xlsx rejects malformed parts, missing relationships and non-byte input", () => {
    assert.throws(() => parseXlsx(createZip({ "xl/workbook.xml": "<workbook" })), errorCode("invalid_xml"));
    assert.throws(() => parseXlsx(createZip({ "xl/workbook.xml": workbook([{ name: "Data", relationshipId: "rId1" }]) })), errorCode("invalid_document"));
    assert.throws(() => parseXlsx(createZip({
        "xl/workbook.xml": workbook([{ name: "Data", relationshipId: "rId1" }]),
        "xl/_rels/workbook.xml.rels": relationships([{ id: "rId1", target: "worksheets/missing.xml" }]),
    })), errorCode("invalid_document"));
    assert.throws(() => parseXlsx("not bytes" as unknown as Uint8Array), TypeError);
});

test("xlsx clips cells at the per-sheet budget and marks the result truncated", () => {
    const rows: string[] = [];
    for (let index = 1; index <= 2_001; index += 1) {
        rows.push(`<row r="${index}"><c r="A${index}"><v>${index}</v></c></row>`);
    }
    const outline = parseXlsx(createZip({
        "xl/workbook.xml": workbook([{ name: "Big", relationshipId: "rId1" }]),
        "xl/_rels/workbook.xml.rels": relationships([{ id: "rId1", target: "worksheets/sheet1.xml" }]),
        "xl/worksheets/sheet1.xml": worksheet(rows.join("")),
    }));

    assert.equal(outline.truncated, true);
    assert.equal(outline.entries.length, 1 + 2_000);
    assert.equal(outline.entries.filter(entry => entry.kind === "cell").length, 2_000);
    assert.equal(outline.entries[0]!.summary, "2001 rows, 2001 cells");
    assert.equal(outline.entries.at(-1)!.id, "xlsx:cell:0:A2000");
    assert.ok(outline.text.length <= defaultDocumentLimits.maxTextCharacters);
});

test("xlsx clamps a single cell value to 2000 characters", () => {
    const outline = parseXlsx(createZip({
        "xl/workbook.xml": workbook([{ name: "Long", relationshipId: "rId1" }]),
        "xl/_rels/workbook.xml.rels": relationships([{ id: "rId1", target: "worksheets/sheet1.xml" }]),
        "xl/worksheets/sheet1.xml": worksheet(`<row r="1"><c r="A1"><v>${"z".repeat(2_500)}</v></c></row>`),
    }));

    assert.equal(outline.entries[1]!.summary.length, 2_000);
    assert.equal(outline.truncated, true);
});

test("xlsx honors caller-supplied outline budgets", () => {
    const outline = parseXlsx(makeWorkbook([{ name: "Data", relationshipId: "rId1" }]), { maxEntriesInOutline: 2 });
    assert.equal(outline.entries.length, 2);
    assert.equal(outline.entries[0]!.kind, "sheet");
    assert.equal(outline.entries[1]!.kind, "cell");
    assert.equal(outline.truncated, true);
});
