#!/usr/bin/env node
/**
 * Integration checks with in-memory OOXML ZIP packages; no Office code runs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import { readDocumentDetail } from "../src/context/document.ts";
import type { DocumentDetail } from "../src/context/document.ts";
import { WorkspaceIndex } from "../src/context/workspace.ts";
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import type { Frame } from "../src/frame/frame.ts";
import type { Context } from "../src/context/lifecycle.ts";
import { scanStructuredWorkspace } from "./support/documentScanner.ts";
import type { StructuredWorkspaceFile } from "./support/documentScanner.ts";

const archive: (parts: Record<string, string>) => Uint8Array = (parts: Record<string, string>): Uint8Array =>
    zipSync(
        Object.fromEntries(
            Object.entries({
                "[Content_Types].xml":
                    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
                ...parts,
            }).map(([name, content]: [string, string]): [string, Uint8Array] => [name, strToU8(content)]),
        ),
    );
const Word: Uint8Array = archive({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Policy</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">${"padding ".repeat(40)}NEEDLE_EXACT 001 &amp; 002</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Limits</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Budget</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
});
const Workbook: Uint8Array = archive({
    "xl/workbook.xml":
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Input Data" sheetId="3" r:id="rIn"/><sheet name="Result" sheetId="7" r:id="rOut"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rIn" Type="worksheet" Target="/xl/worksheets/sheet8.xml"/><Relationship Id="rOut" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><r><t>001</t></r><r><t> USD</t></r></si></sst>",
    "xl/worksheets/sheet8.xml":
        '<worksheet><dimension ref="A1:B4"/><sheetData><row r="1"><c r="A1" t="s" s="2"><v>0</v></c><c r="B1" t="inlineStr"><is><t>units</t></is></c></row><row r="4"><c r="B4"><v>12.50</v></c></row></sheetData><mergeCells><mergeCell ref="A2:B2"/></mergeCells></worksheet>',
    "xl/worksheets/sheet2.xml":
        '<worksheet><dimension ref="A1:C1"/><sheetData><row r="1"><c r="A1"><f t="shared" si="0" ref="A1:A2">\'input data\'!$B$4*2</f><v>25</v></c><c r="B1" t="str"><f>"Result!A1"</f><v>Result!A1</v></c><c r="C1"><f>[Book]Result!A1</f></c></row></sheetData></worksheet>',
});
const Slides: Uint8Array = archive({
    "ppt/presentation.xml":
        '<p:presentation xmlns:p="p" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="300" rel:id="slideB"/><p:sldId id="301" rel:id="slideA"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="slideB" Type="slide" Target="slides/slide9.xml"/><Relationship Id="slideA" Type="slide" Target="slides/slide1.xml"/></Relationships>',
    "ppt/slides/slide9.xml":
        '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:grpSp><p:grpSpPr><a:xfrm><a:off x="10" y="20"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="11" name="Title"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Launch plan</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp><p:pic><p:nvPicPr><p:cNvPr id="12" name="Picture"/></p:nvPicPr></p:pic></p:spTree></p:cSld></p:sld>',
    "ppt/slides/_rels/slide9.xml.rels":
        '<Relationships><Relationship Id="note" Type="notesSlide" Target="../notesSlides/notesSlide2.xml"/><Relationship Id="external" Type="image" Target="https://invalid.example/never-fetched.png" TargetMode="External"/></Relationships>',
    "ppt/notesSlides/notesSlide2.xml":
        '<p:notes xmlns:p="p" xmlns:a="a"><p:sp><p:txBody><a:p><a:r><a:t>Speaker secret detail</a:t></a:r></a:p></p:txBody></p:sp></p:notes>',
    "ppt/slides/slide1.xml": '<p:sld xmlns:p="p"><p:cSld><p:spTree/></p:cSld></p:sld>',
});
const Store: MemoryContentStore = new MemoryContentStore();
const Snapshot: WorkspaceSnapshot = scanStructuredWorkspace(
    [
        { path: "docs/policy.docx", content: Word },
        { path: "data/budget.xlsx", content: Workbook },
        { path: "talk.pptx", content: Slides },
        { path: "book.md", content: "# Book\nIntro\n## Chapter A\nAlpha\n### Detail\nFact\n## Chapter B\nBeta\n```\n# not a chapter\n```" },
        { path: "article.txt", content: "Article body with direct recall" },
        { path: "calc.ts", content: "export function compute() { return 42; }" },
    ],
    Store,
);
const Index: WorkspaceIndex = new WorkspaceIndex(Snapshot, Store);
const frame: (ids: string[]) => Frame = (ids: string[]): Frame => ({
    amp: "0.1",
    kind: "frame",
    id: "f.documents",
    agent: "a.test",
    cycle: 1,
    ts: "2026-10-29T00:00:00Z",
    digest: "0".repeat(64),
    mode: "explore",
    slots: ids.map((id: string): Frame["slots"][number] => ({
        target: { kind: "other", id },
        role: "artifact",
        salience: 1,
        cost: {},
        why: "explicit document selection",
        state: "active",
    })),
    budget: { allocated: { tokens: 12000 }, spent: {} },
});
const detail: (id: string) => DocumentDetail = (id: string): DocumentDetail => readDocumentDetail(Index.context(frame([id]), 12000), id)!;
const entity: (id: string) => WorkspaceEntity = (id: string): WorkspaceEntity => Index.entity(id)!;

test("Word sections and tables preserve exact text, XML structure and paragraph anchors", (): void => {
    assert.ok(!Snapshot.diagnostics.some((item): boolean => item.code === "invalid_document"), JSON.stringify(Snapshot.diagnostics));
    assert.equal(entity("knowledge:docs/policy.docx#p2").parentId, "knowledge:docs/policy.docx#p1");
    assert.equal(entity("knowledge:docs/policy.docx#table4").parentId, "knowledge:docs/policy.docx#p3");
    assert.deepEqual(entity("knowledge:docs/policy.docx#table4").source.locator, { kind: "part", part: "word/document.xml", element: "body/*[4]" });
    const table: DocumentDetail = detail("knowledge:docs/policy.docx#table4");
    assert.equal(table.kind, "table");
    if (table.kind === "table") {
        assert.deepEqual(table.rows, [["Budget", "42"]]);
        assert.match(table.xml, /gridSpan/);
    }
    const paragraph: DocumentDetail = detail("knowledge:docs/policy.docx#p2");
    assert.ok(paragraph.kind === "text" && paragraph.text.endsWith("NEEDLE_EXACT 001 & 002"));
});

test("Excel preserves sparse addresses, rich strings, formulas, cache values, styles and merges", (): void => {
    assert.deepEqual(entity("knowledge:data/budget.xlsx#sheet:3").source.locator, {
        kind: "cells",
        part: "xl/worksheets/sheet8.xml",
        sheet: "Input Data",
        range: "A1:B4",
    });
    const input: DocumentDetail = detail("knowledge:data/budget.xlsx#sheet:3");
    const result: DocumentDetail = detail("knowledge:data/budget.xlsx#sheet:7");
    assert.equal(input.kind, "sheet");
    assert.equal(result.kind, "sheet");
    if (input.kind === "sheet" && result.kind === "sheet") {
        assert.deepEqual(
            input.cells.map((cell): string => cell.address),
            ["A1", "B1", "B4"],
        );
        assert.equal(input.cells[0].value, "001 USD");
        assert.equal(input.cells[0].style, "2");
        assert.equal(input.cells[2].value, "12.50");
        assert.deepEqual(input.merges, ["A2:B2"]);
        assert.equal(result.cells[0].formula, "'input data'!$B$4*2");
        assert.equal(result.cells[0].value, "25");
        assert.deepEqual(result.cells[0].formulaAttributes, { t: "shared", si: "0", ref: "A1:A2" });
    }
    const edges: WorkspaceSnapshot["relations"] = Index.relations("knowledge:data/budget.xlsx#sheet:7", "outgoing", "references");
    assert.equal(edges.length, 1);
    assert.equal(edges[0].to, "knowledge:data/budget.xlsx#sheet:3");
    assert.deepEqual(edges[0].source.locator, { kind: "cells", part: "xl/worksheets/sheet2.xml", sheet: "Result", range: "A1" });
    assert.equal(Snapshot.entities.filter((item): boolean => item.structureKind === "sheet").length, 2);
});

test("PPT follows declared slide order and preserves grouped layout, objects and notes", (): void => {
    const slide: DocumentDetail = detail("knowledge:talk.pptx#slide1");
    assert.deepEqual(entity("knowledge:talk.pptx#slide1").source.locator, { kind: "slide", part: "ppt/slides/slide9.xml", slide: 1 });
    assert.equal(slide.kind, "slide");
    if (slide.kind === "slide") {
        assert.deepEqual(
            slide.objects.map((object): string => object.id),
            ["11", "12"],
        );
        assert.equal(slide.objects[0].text, "Launch plan");
        assert.deepEqual(slide.objects[0].locator, { kind: "slide", part: "ppt/slides/slide9.xml", slide: 1, objectId: "11" });
        assert.equal(slide.notes, "Speaker secret detail");
        assert.match(slide.xml, /x="10"/);
    }
});

test("Markdown hierarchy, text articles and code AST share the existing workspace tree", (): void => {
    assert.equal(entity("knowledge:book.md#L3").parentId, "knowledge:book.md#L1");
    assert.equal(entity("knowledge:book.md#L5").parentId, "knowledge:book.md#L3");
    assert.equal(entity("knowledge:book.md#L7").parentId, "knowledge:book.md#L1");
    assert.ok(Snapshot.entities.some((item): boolean => item.kind === "symbol" && item.label === "compute"));
    assert.deepEqual(detail("knowledge:article.txt#text"), { kind: "text", text: "Article body with direct recall" });
});

test("full source recall finds facts omitted from summaries and detail reads obey Frame and budget", (): void => {
    const id: string = "knowledge:docs/policy.docx#p2";
    assert.ok(!entity(id).summary.includes("NEEDLE_EXACT"));
    assert.ok(Index.query({ text: "NEEDLE_EXACT", maxDepth: 0 }).candidates.some((item): boolean => item.id === id));
    const context: Context = Index.context(frame([id]), 12000);
    assert.equal(readDocumentDetail(context, "knowledge:docs/policy.docx#table4"), (void 0));
    assert.equal(readDocumentDetail(context, "file:docs/policy.docx"), (void 0));
    assert.equal(readDocumentDetail(context, "knowledge:docs/policy.docx#original"), (void 0));
    assert.equal(readDocumentDetail(Index.context(frame([id]), 1), id), (void 0));
    const original: DocumentDetail = detail("knowledge:docs/policy.docx#original");
    assert.ok(original.kind === "original");
    if (original.kind === "original") {
        assert.deepEqual(new Uint8Array(Buffer.from(original.data, "base64")), Word);
    }
    assert.equal(context.frame.slots.length, 1);
});

test("summary provenance invalidates recursively and snapshot copies isolate nested locators", (): void => {
    const id: string = "knowledge:docs/policy.docx#p1";
    assert.equal(Index.summaryState(id), "fresh");
    assert.equal(Index.summaryState(id, [{ uri: "docs/policy.docx", revision: "edited" }]), "stale");
    assert.equal(Index.summaryState(id, []), "stale");
    const copy: WorkspaceSnapshot = Index.snapshot();
    const child: WorkspaceEntity = copy.entities.find((item): boolean => item.id === "knowledge:docs/policy.docx#p2")!;
    child.summary = "obsoleteexclusiveword";
    child.summaryProvenance!.sources[0].revision = "old";
    const stale: WorkspaceIndex = new WorkspaceIndex(copy, Store);
    assert.equal(stale.summaryState(id), "stale");
    assert.equal(stale.query({ text: "obsoleteexclusiveword" }).candidates.length, 0);
    assert.match(stale.project().node(id)!.summary, /summary stale/);
    assert.equal(Index.summaryState(id), "fresh");
    child.source.locator!.part = "corrupt.xml";
    assert.equal(entity(child.id).source.locator!.part, "word/document.xml");
    const rebuilt: WorkspaceSnapshot = scanStructuredWorkspace(
        [{ path: "docs/policy.docx", content: archive({ "word/document.xml": "<document><body><p><r><t>Changed</t></r></p></body></document>" }) }],
        Store,
    );
    assert.notEqual(rebuilt.revision, Snapshot.revision);
    assert.equal(
        rebuilt.entities.some((item): boolean => item.id.endsWith("#table4")),
        false,
    );
});

test("invalid packages, missing/external relationships, malformed XML and expansion limits are diagnosed", (): void => {
    const files: StructuredWorkspaceFile[] = [
        { path: "broken.docx", content: strToU8("not zip") },
        { path: "badutf8.txt", content: new Uint8Array([0xff]) },
        { path: "badxml.docx", content: archive({ "word/document.xml": "<document><body></document>" }) },
        { path: "entity.docx", content: archive({ "word/document.xml": '<!DOCTYPE document [<!ENTITY x "expand">]><document><body/></document>' }) },
        { path: "deep.docx", content: archive({ "word/document.xml": `${"<a>".repeat(130)}${"</a>".repeat(130)}` }) },
        { path: "large.docx", content: archive({ "word/document.xml": " ".repeat(8 * 1024 * 1024 + 1) }) },
        {
            path: "external.xlsx",
            content: archive({
                "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="Missing" sheetId="1" r:id="ext"/></sheets></workbook>',
                "xl/_rels/workbook.xml.rels":
                    '<Relationships><Relationship Id="ext" Type="worksheet" Target="https://invalid.example/book" TargetMode="External"/></Relationships>',
            }),
        },
        { path: "legacy.doc", content: strToU8("legacy") },
    ];
    const snapshot: WorkspaceSnapshot = scanStructuredWorkspace(files, new MemoryContentStore());
    assert.equal(snapshot.diagnostics.filter((item): boolean => item.code === "invalid_document").length, 7);
    assert.equal(snapshot.diagnostics.filter((item): boolean => item.code === "unsupported_document").length, 1);
    assert.equal(
        snapshot.entities.some((item): boolean => item.kind === "knowledge"),
        false,
    );
    assert.ok(snapshot.entities.filter((item): boolean => item.kind === "file").every((item): boolean => item.detailRef === (void 0)));
    assert.doesNotThrow((): void => {
        new WorkspaceIndex(snapshot, Store);
    });
    assert.throws((): void => {
        scanStructuredWorkspace([{ path: "../escape.docx", content: Word }], Store);
    });
});
