import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryFileStorage } from "../core.ts";
import { NodeFileStorage } from "../node.ts";
import { Workspace } from "../../workspace/core.ts";
import { WorkspaceError } from "../../workspace/types.ts";
import { DocumentError } from "./types.ts";
import { createZip } from "./testZip.ts";

const docx = (): Uint8Array => createZip({
    "word/document.xml": `<w:document xmlns:w="w"><w:body>`
        + `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>`
        + `<w:p><w:r><w:t>Body text</w:t></w:r></w:p>`
        + `</w:body></w:document>`,
});

const xlsx = (): Uint8Array => createZip({
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Budget" sheetId="1" r:id="s1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="s1" Target="worksheets/data.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Revenue</t></si></sst>`,
    "xl/worksheets/data.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
});

const pptx = (): Uint8Array => createZip({
    "ppt/presentation.xml": `<p:presentation xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="r1"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Quarterly</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
});

function memory(path: string, bytes: Uint8Array | string, mode: "read-only" | "writable" = "read-only") {
    const storage = new InMemoryFileStorage();
    const ref = { tenantId: "t", rootId: "r", path };
    if (typeof bytes === "string") storage.put(ref, bytes);
    else storage.putBytes(ref, bytes);
    const workspace = new Workspace({ tenantId: "t", rootId: "r", storage });
    return { storage, file: workspace.mount(path, { mode, owner: "agent" }) };
}

function documentCode(code: DocumentError["code"]) {
    return (error: unknown): boolean => error instanceof DocumentError && error.code === code;
}

test("DOCX mounts as bytes and exposes a heading/paragraph outline", () => {
    const { file } = memory("report.docx", docx());
    assert.equal(file.snapshot().binary, true);
    assert.equal(file.snapshot().size > 0, true);
    const outline = file.documentOutline();
    assert.equal(outline.language, "word");
    assert.deepEqual(outline.entries.map(entry => entry.kind), ["heading", "paragraph"]);
    assert.equal(outline.entries[0]?.name, "Title");
    assert.equal(outline.entries[0]?.locator.part, "word/document.xml");
    assert.equal(outline.entries[0]?.locator.paragraph, 1);
    assert.equal(outline.entries[1]?.summary, "Body text");
    assert.equal(outline.text.includes("Title"), true);
});

test("XLSX exposes sheets and cells with parent links and locators", () => {
    const { file } = memory("book.xlsx", xlsx());
    const outline = file.documentOutline();
    assert.equal(outline.language, "excel");
    const sheet = outline.entries.find(entry => entry.kind === "sheet");
    const cell = outline.entries.find(entry => entry.kind === "cell");
    assert.ok(sheet && cell);
    assert.equal(sheet.name, "Budget");
    assert.equal(cell.name, "Budget!A1");
    assert.equal(cell.summary, "Revenue");
    assert.equal(cell.parentId, sheet.id);
    assert.equal(cell.locator.sheet, "Budget");
    assert.equal(cell.locator.cell, "A1");
});

test("PPTX exposes slides in presentation order", () => {
    const { file } = memory("deck.pptx", pptx());
    const outline = file.documentOutline();
    assert.equal(outline.language, "powerpoint");
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]?.kind, "slide");
    assert.equal(outline.entries[0]?.name, "Quarterly");
    assert.equal(outline.entries[0]?.locator.slide, 1);
});

test("legacy and proprietary containers fail with explicit document errors", () => {
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const access = memory("db.accdb", ole).file;
    assert.throws(() => access.documentOutline(), documentCode("unsupported_format"));
    const publisher = memory("doc.pub", ole).file;
    assert.throws(() => publisher.documentOutline(), documentCode("unsupported_format"));
    const legacyWord = memory("old.doc", ole).file;
    assert.throws(() => legacyWord.documentOutline(), documentCode("unsupported_format"));
});

test("text files refuse document outlines and binary text operations are rejected", () => {
    const text = memory("notes.txt", "alpha\n").file;
    assert.throws(() => text.documentOutline(), documentCode("unsupported_format"));
    const binary = memory("report.docx", docx()).file;
    for (const action of [
        () => binary.read(),
        () => binary.write("x"),
        () => binary.readLines(0, 1),
        () => binary.outline(),
        () => binary.diff(),
    ]) assert.throws(action, (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_target");
});

test("binary mounts read and commit bytes through the lease", () => {
    const { storage, file } = memory("report.docx", docx(), "writable");
    const before = file.readBytes();
    assert.equal(before.length, file.snapshot().size);
    assert.equal(file.readBytes({ start: 0, end: 2 })[0], 0x50);
    const replacement = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    file.writeBytes(replacement);
    assert.equal(file.snapshot().dirty, true);
    file.flush();
    assert.equal(file.snapshot().dirty, false);
    assert.deepEqual([...storage.readBytes({ tenantId: "t", rootId: "r", path: "report.docx" })!.bytes], [...replacement]);
    assert.throws(() => file.readBytes({ start: 0, end: 99 }), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_range");
});

test("the real adapter mounts Office bytes and keeps them on disk", (t) => {
    const root = mkdtempSync(join(tmpdir(), "amp-doc-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "report.docx"), docx());
    const storage = new NodeFileStorage({ root, fsync: false });
    const file = new Workspace({ tenantId: "t", rootId: "r", storage })
        .mount("report.docx", { mode: "writable", owner: "agent" });
    assert.equal(file.snapshot().binary, true);
    assert.equal(file.documentOutline().entries.length, 2);
    const bytes = file.readBytes();
    file.writeBytes(bytes);
    file.flush();
    assert.deepEqual([...readFileSync(join(root, "report.docx"))], [...bytes]);
    assert.throws(() => file.read(), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_target");
});
