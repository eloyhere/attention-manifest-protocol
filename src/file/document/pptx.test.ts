import assert from "node:assert/strict";
import test from "node:test";
import { parsePptx } from "./pptx.ts";
import { createZip } from "./testZip.ts";
import { DocumentError } from "./types.ts";

const NAMESPACES = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const SLIDE_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";

interface SlideIdFixture {
    readonly id: number;
    readonly rid: string;
}

interface RelationshipFixture {
    readonly id: string;
    readonly target: string;
    readonly external?: boolean;
}

function escapeXml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function presentationXml(slideIds: readonly SlideIdFixture[]): string {
    const items = slideIds.map(item => `<p:sldId id="${item.id}" r:id="${item.rid}"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<p:presentation ${NAMESPACES}><p:sldIdLst>${items}</p:sldIdLst></p:presentation>`;
}

function relationshipsXml(relationships: readonly RelationshipFixture[]): string {
    const items = relationships.map(item => `<Relationship Id="${item.id}" Type="${SLIDE_RELATIONSHIP}"`
        + ` Target="${item.target}"${item.external === true ? ' TargetMode="External"' : ""}/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">${items}</Relationships>`;
}

/** Builds `p:sp` shapes; each paragraph is a list of run texts. */
function shapes(paragraphsPerShape: readonly (readonly (readonly string[])[])[]): string {
    return paragraphsPerShape.map(paragraphs => {
        const body = paragraphs.map(runs => `<a:p>${runs.map(run => `<a:r><a:t>${escapeXml(run)}</a:t></a:r>`).join("")}</a:p>`).join("");
        return `<p:sp><p:txBody><a:bodyPr/>${body}</p:txBody></p:sp>`;
    }).join("");
}

function slideXml(...shapeMarkup: readonly string[]): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<p:sld ${NAMESPACES}><p:cSld><p:spTree>${shapeMarkup.join("")}</p:spTree></p:cSld></p:sld>`;
}

function oneShapeDeck(titles: readonly string[]): Uint8Array {
    const slideIds = titles.map((_, index) => ({ id: 256 + index, rid: `rId${index + 1}` }));
    const files: Record<string, string> = {
        "ppt/presentation.xml": presentationXml(slideIds),
        "ppt/_rels/presentation.xml.rels": relationshipsXml(
            slideIds.map((item, index) => ({ id: item.rid, target: `slides/slide${index + 1}.xml` })),
        ),
    };
    for (const [index, title] of titles.entries()) {
        files[`ppt/slides/slide${index + 1}.xml`] = slideXml(shapes([[[title]]]));
    }
    return createZip(files);
}

function errorCode(operation: () => unknown): string {
    try {
        operation();
    } catch (error) {
        if (error instanceof DocumentError) return error.code;
        throw error;
    }
    assert.fail("expected a DocumentError");
}

test("slide order follows sldIdLst, resolving relative and absolute targets and ignoring external relationships", () => {
    const bytes = createZip({
        "ppt/presentation.xml": presentationXml([{ id: 256, rid: "rId2" }, { id: 257, rid: "rId1" }]),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([
            { id: "rId1", target: "slides/slide1.xml" },
            { id: "rId2", target: "/ppt/slides/slide2.xml" },
            { id: "rId3", target: "https://example.com/external", external: true },
        ]),
        "ppt/slides/slide1.xml": slideXml(shapes([[[ "File One" ], [ "First body" ]]])),
        "ppt/slides/slide2.xml": slideXml(shapes([[[ "Deck Title" ], [ "Second body" ]]])),
    });
    const outline = parsePptx(bytes);
    assert.equal(outline.language, "powerpoint");
    assert.equal(outline.truncated, false);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Deck Title", "File One"]);
    assert.deepEqual(outline.entries.map(entry => entry.id), ["pptx:slide:1", "pptx:slide:2"]);
    assert.deepEqual(outline.entries.map(entry => entry.kind), ["slide", "slide"]);
    assert.deepEqual(outline.entries.map(entry => entry.locator), [
        { part: "ppt/slides/slide2.xml", slide: 1 },
        { part: "ppt/slides/slide1.xml", slide: 2 },
    ]);
    assert.equal(outline.entries[0]!.summary, "Deck Title\nSecond body");
    assert.equal(outline.entries[1]!.summary, "File One\nFirst body");
    assert.equal(outline.text, "Deck Title\nSecond body\nFile One\nFirst body");
});

test("paragraphs and runs are concatenated and graphic frames are skipped", () => {
    const graphicFrame = '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody>'
        + "<a:p><a:r><a:t>Chart text</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>";
    const slide = slideXml(
        shapes([[[ "Hello ", "world" ], [ "Second" ]], [[ "Third" ]]]),
        graphicFrame,
    );
    const bytes = createZip({
        "ppt/presentation.xml": presentationXml([{ id: 256, rid: "rId1" }]),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([{ id: "rId1", target: "slides/slide1.xml" }]),
        "ppt/slides/slide1.xml": slide,
    });
    const outline = parsePptx(bytes);
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.name, "Hello world");
    assert.equal(outline.entries[0]!.summary, "Hello world\nSecond\nThird");
    assert.equal(outline.text, "Hello world\nSecond\nThird");
});

test("textless slides are skipped but later slides keep their sldIdLst index", () => {
    const bytes = createZip({
        "ppt/presentation.xml": presentationXml([
            { id: 256, rid: "rId1" }, { id: 257, rid: "rId2" }, { id: 258, rid: "rId3" },
        ]),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([
            { id: "rId1", target: "slides/slide1.xml" },
            { id: "rId2", target: "slides/slide2.xml" },
            { id: "rId3", target: "slides/slide3.xml" },
        ]),
        "ppt/slides/slide1.xml": slideXml(shapes([[[ "First" ]]])),
        "ppt/slides/slide2.xml": slideXml(shapes([[[]]])),
        "ppt/slides/slide3.xml": slideXml(shapes([[[ "Third" ]]])),
    });
    const outline = parsePptx(bytes);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["First", "Third"]);
    assert.deepEqual(outline.entries.map(entry => entry.id), ["pptx:slide:1", "pptx:slide:3"]);
    assert.deepEqual(outline.entries.map(entry => entry.locator.slide), [1, 3]);
    assert.equal(outline.entries[1]!.locator.part, "ppt/slides/slide3.xml");
    assert.equal(outline.text, "First\nThird");
});

test("external slide relationships keep their ordinal but produce no entry", () => {
    const bytes = createZip({
        "ppt/presentation.xml": presentationXml([{ id: 256, rid: "rId1" }, { id: 257, rid: "rId2" }]),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([
            { id: "rId1", target: "https://example.com/slides/remote.xml", external: true },
            { id: "rId2", target: "slides/slide1.xml" },
        ]),
        "ppt/slides/slide1.xml": slideXml(shapes([[[ "Local" ]]])),
    });
    const outline = parsePptx(bytes);
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.name, "Local");
    assert.equal(outline.entries[0]!.locator.slide, 2);
    assert.equal(outline.entries[0]!.locator.part, "ppt/slides/slide1.xml");
});

test("an empty presentation is a valid document with no entries", () => {
    const emptyPresentation = `<?xml version="1.0"?><p:presentation ${NAMESPACES}><p:sldIdLst/></p:presentation>`;
    const outline = parsePptx(createZip({ "ppt/presentation.xml": emptyPresentation }));
    assert.deepEqual(outline.entries, []);
    assert.equal(outline.text, "");
    assert.equal(outline.truncated, false);
    assert.equal(outline.language, "powerpoint");
});

test("a package without presentation.xml is an invalid document", () => {
    assert.equal(errorCode(() => parsePptx(createZip({ "docProps/app.xml": "<Properties/>" }))), "invalid_document");
});

test("non-zip bytes, OLE bytes and non-byte input fail with the documented codes", () => {
    assert.equal(errorCode(() => parsePptx(new Uint8Array(64))), "invalid_zip");
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    assert.equal(errorCode(() => parsePptx(ole)), "unsupported_format");
    assert.throws(() => parsePptx("not bytes" as unknown as Uint8Array), TypeError);
});

test("a presentation that references slides without a relationship table is invalid", () => {
    const bytes = createZip({
        "ppt/presentation.xml": presentationXml([{ id: 256, rid: "rId1" }]),
        "ppt/slides/slide1.xml": slideXml(shapes([[[ "Orphan" ]]])),
    });
    assert.equal(errorCode(() => parsePptx(bytes)), "invalid_document");
});

test("relationship targets may not escape the package or resolve outside ppt/slides", () => {
    const escaped = createZip({
        "ppt/presentation.xml": presentationXml([{ id: 256, rid: "rId1" }]),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([{ id: "rId1", target: "../slides/slide1.xml" }]),
        "ppt/slides/slide1.xml": slideXml(shapes([[[ "Escaped" ]]])),
    });
    assert.equal(errorCode(() => parsePptx(escaped)), "invalid_document");
    const outside = createZip({
        "ppt/presentation.xml": presentationXml([{ id: 256, rid: "rId1" }, { id: 257, rid: "rId2" }]),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([
            { id: "rId1", target: "slides/slide1.xml" },
            { id: "rId2", target: "notesMasters/notesMaster1.xml" },
        ]),
        "ppt/slides/slide1.xml": slideXml(shapes([[[ "Kept" ]]])),
    });
    const outline = parsePptx(outside);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Kept"]);
});

test("malformed slide parts raise XML or document errors", () => {
    const brokenXml = createZip({
        "ppt/presentation.xml": presentationXml([{ id: 256, rid: "rId1" }]),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([{ id: "rId1", target: "slides/slide1.xml" }]),
        "ppt/slides/slide1.xml": "<p:sld><p:cSld>",
    });
    assert.equal(errorCode(() => parsePptx(brokenXml)), "invalid_xml");
    const wrongRoot = createZip({
        "ppt/presentation.xml": presentationXml([{ id: 256, rid: "rId1" }]),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([{ id: "rId1", target: "slides/slide1.xml" }]),
        "ppt/slides/slide1.xml": "<p:notASlide/>",
    });
    assert.equal(errorCode(() => parsePptx(wrongRoot)), "invalid_document");
});

test("maxEntriesInOutline truncates the entry list without throwing", () => {
    const outline = parsePptx(oneShapeDeck(["One", "Two", "Three"]), { maxEntriesInOutline: 2 });
    assert.deepEqual(outline.entries.map(entry => entry.name), ["One", "Two"]);
    assert.equal(outline.text, "One\nTwo");
    assert.equal(outline.truncated, true);
});

test("the default entry budget truncates a very large deck without throwing", () => {
    const slideIds = Array.from({ length: 20_001 }, (_, index) => ({ id: 256 + index, rid: "rId1" }));
    const files: Record<string, string> = {
        "ppt/presentation.xml": presentationXml(slideIds),
        "ppt/_rels/presentation.xml.rels": relationshipsXml([{ id: "rId1", target: "slides/slide1.xml" }]),
        "ppt/slides/slide1.xml": slideXml(shapes([[[ "Slide" ]]])),
    };
    const outline = parsePptx(createZip(files));
    assert.equal(outline.entries.length, 20_000);
    assert.equal(outline.entries.at(-1)!.id, "pptx:slide:20000");
    assert.equal(outline.text.length, 20_000 * "Slide".length + 19_999);
    assert.equal(outline.truncated, true);
});

test("maxTextCharacters truncates the text projection without throwing", () => {
    const outline = parsePptx(oneShapeDeck(["0123456789abcdef"]), { maxTextCharacters: 10 });
    assert.equal(outline.text, "0123456789");
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.summary, "0123456789");
    assert.equal(outline.entries[0]!.name, "0123456789abcdef");
    assert.equal(outline.truncated, true);
});

test("titles are capped at 120 characters without marking the outline truncated", () => {
    const longTitle = "T".repeat(180);
    const outline = parsePptx(oneShapeDeck([longTitle]));
    assert.equal(outline.entries[0]!.name.length, 120);
    assert.equal(outline.text, longTitle);
    assert.equal(outline.truncated, false);
});

test("entries, entries arrays and locators are frozen", () => {
    const outline = parsePptx(oneShapeDeck(["Frozen One", "Frozen Two"]));
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    assert.equal(outline.entries.length, 2);
    for (const entry of outline.entries) {
        assert.equal(Object.isFrozen(entry), true);
        assert.equal(Object.isFrozen(entry.locator), true);
    }
    const empty = parsePptx(createZip({
        "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${NAMESPACES}><p:sldIdLst/></p:presentation>`,
    }));
    assert.equal(Object.isFrozen(empty.entries), true);
});
