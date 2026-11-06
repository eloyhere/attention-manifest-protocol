import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";
import { LanguageRegistry } from "../language/registry.ts";
import { definition } from "../language/cad.ts";
import { parseCad } from "./cad.ts";
import { DocumentError } from "./types.ts";

type GroupPair = readonly [number, string];

/** Encodes group-code/value pairs as CRLF-delimited DXF ASCII and terminates with EOF. */
function dxf(entries: readonly GroupPair[]): Uint8Array {
    const lines: string[] = [];
    for (const [code, value] of entries) lines.push(String(code), value);
    lines.push("0", "EOF");
    return new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
}

const DRAWING: readonly GroupPair[] = [
    [0, "SECTION"], [2, "HEADER"], [9, "$ACADVER"], [1, "AC1015"], [0, "ENDSEC"],
    [0, "SECTION"], [2, "TABLES"],
    [0, "TABLE"], [2, "LAYER"],
    [0, "LAYER"], [2, "0"], [62, "7"], [70, "0"],
    [0, "LAYER"], [2, "Walls"], [62, "1"], [70, "0"],
    [0, "ENDTAB"],
    [0, "ENDSEC"],
    [0, "SECTION"], [2, "BLOCKS"],
    [0, "BLOCK"], [8, "0"], [2, "DOOR"], [70, "0"], [10, "0.0"], [20, "0.0"],
    [0, "LINE"], [8, "0"], [10, "1.0"], [20, "1.0"],
    [0, "ENDBLK"],
    [0, "ENDSEC"],
    [0, "SECTION"], [2, "ENTITIES"],
    [0, "LINE"], [8, "Walls"], [10, "0.0"], [20, "0.0"], [11, "10.0"], [21, "10.0"],
    [0, "LINE"], [8, "Walls"], [10, "5.0"], [20, "5.0"], [11, "15.0"], [21, "15.0"],
    [0, "CIRCLE"], [8, "Walls"], [10, "5.0"], [20, "5.0"], [40, "2.0"],
    [0, "ENDSEC"],
];

const DWG_MIN_HEADER = 0x20;
const DWG_SECTION_COUNT_OFFSET = 0x15;
const DWG_SECTION_TABLE_OFFSET = 0x19;

interface DwgLayout {
    readonly recordBytes: 8 | 9;
    readonly littleEndian: boolean;
    readonly hasSectionNumber: boolean;
}

/**
 * The synthetic layout required by the task: a big-endian count and 8-byte big-endian
 * `{ seeker, size }` records.
 */
const CONTRACT_LAYOUT: DwgLayout = { recordBytes: 8, littleEndian: false, hasSectionNumber: false };

/**
 * The public AC15 layout: a little-endian count and 9-byte records
 * `{ sectionNumber: u8, seeker: i32, size: i32 }` with little-endian integers.
 */
const PUBLIC_AC15_LAYOUT: DwgLayout = { recordBytes: 9, littleEndian: true, hasSectionNumber: true };

interface DwgSectionSpec {
    readonly number?: number;
    readonly payload?: Uint8Array;
    readonly seeker?: number;
    readonly size?: number;
}

interface DwgFixtureOptions {
    readonly count?: number;
    readonly fileSize?: number;
    readonly headerSize?: number;
}

function writeVersion(bytes: Uint8Array, version: string): void {
    for (let index = 0; index < version.length; index += 1) {
        bytes[index] = version.charCodeAt(index);
    }
}

/**
 * Builds a minimal DWG-shaped fixture. Sections without an explicit seeker are laid out
 * sequentially after the header; explicit seeker/size values allow malformed fixtures.
 */
function buildDwg(
    version: string,
    sections: readonly DwgSectionSpec[],
    layout: DwgLayout,
    options: DwgFixtureOptions = {},
): Uint8Array {
    const count = options.count ?? sections.length;
    const tableEnd = DWG_SECTION_TABLE_OFFSET + count * layout.recordBytes;
    const headerSize = options.headerSize ?? Math.max(DWG_MIN_HEADER, tableEnd);
    let cursor = headerSize;
    const placements = sections.map(section => {
        const payload = section.payload ?? new Uint8Array(0);
        const seeker = section.seeker ?? cursor;
        const size = section.size ?? payload.length;
        if (section.seeker === undefined) cursor = Math.max(cursor, seeker + Math.max(size, 0));
        return { payload, seeker, size, number: section.number ?? 0 };
    });
    const fileSize = options.fileSize ?? Math.max(headerSize, cursor);
    const bytes = new Uint8Array(fileSize);
    writeVersion(bytes, version);
    const view = new DataView(bytes.buffer);
    view.setInt32(DWG_SECTION_COUNT_OFFSET, count, layout.littleEndian);
    for (let index = 0; index < placements.length && index < count; index += 1) {
        const placement = placements[index]!;
        const record = DWG_SECTION_TABLE_OFFSET + index * layout.recordBytes;
        if (record + layout.recordBytes > bytes.length) break;
        let field = record;
        if (layout.hasSectionNumber) {
            bytes[field] = placement.number;
            field += 1;
        }
        view.setInt32(field, placement.seeker, layout.littleEndian);
        view.setInt32(field + 4, placement.size, layout.littleEndian);
        if (placement.seeker >= 0
            && placement.size > 0
            && placement.payload.length > 0
            && placement.payload.length <= placement.size
            && placement.seeker + placement.payload.length <= bytes.length) {
            bytes.set(placement.payload, placement.seeker);
        }
    }
    return bytes;
}

function contractDwg(
    version: string,
    sections: readonly DwgSectionSpec[],
    options: DwgFixtureOptions = {},
): Uint8Array {
    return buildDwg(version, sections, CONTRACT_LAYOUT, options);
}

function ac15Dwg(
    version: string,
    sections: readonly DwgSectionSpec[],
    options: DwgFixtureOptions = {},
): Uint8Array {
    return buildDwg(version, sections, PUBLIC_AC15_LAYOUT, options);
}

function errorOf(operation: () => unknown): DocumentError {
    try {
        operation();
    } catch (error) {
        if (error instanceof DocumentError) return error;
        throw error;
    }
    assert.fail("expected a DocumentError");
}

function errorCode(operation: () => unknown): string {
    return errorOf(operation).code;
}

test("cad projects layers, block names and entity type counts in document order", () => {
    const outline = parseCad(dxf(DRAWING));

    assert.equal(outline.language, "cad");
    assert.equal(outline.truncated, false);
    assert.equal(outline.entries.length, 5);
    assert.deepEqual(outline.entries.map(entry => entry.id), [
        "cad:layer:1", "cad:layer:2", "cad:block:1", "cad:entity:LINE", "cad:entity:CIRCLE",
    ]);

    const defaultLayer = outline.entries[0]!;
    assert.equal(defaultLayer.kind, "section");
    assert.equal(defaultLayer.name, "0");
    assert.equal(defaultLayer.summary, "layer color=7");
    assert.deepEqual(defaultLayer.locator, { part: "dxf:tables" });

    const walls = outline.entries[1]!;
    assert.equal(walls.id, "cad:layer:2");
    assert.equal(walls.name, "Walls");
    assert.equal(walls.summary, "layer color=1");

    const door = outline.entries[2]!;
    assert.equal(door.id, "cad:block:1");
    assert.equal(door.kind, "section");
    assert.equal(door.name, "DOOR");
    assert.deepEqual(door.locator, { part: "dxf:blocks" });

    const lines = outline.entries[3]!;
    assert.equal(lines.id, "cad:entity:LINE");
    assert.equal(lines.kind, "note");
    assert.equal(lines.name, "LINE");
    assert.equal(lines.summary, "2 entities");
    assert.deepEqual(lines.locator, { part: "dxf:entities" });

    const circles = outline.entries[4]!;
    assert.equal(circles.id, "cad:entity:CIRCLE");
    assert.equal(circles.summary, "1 entities");

    assert.equal(outline.text, [
        "layer color=7", "layer color=1", "block", "2 entities", "1 entities",
    ].join("\n"));
    assert.equal(outline.text, outline.entries.map(entry => entry.summary).join("\n"));
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    assert.equal(Object.isFrozen(defaultLayer), true);
    assert.equal(Object.isFrozen(defaultLayer.locator), true);
});

test("cad uses the DXF default colour when a LAYER record has no 62 group", () => {
    const outline = parseCad(dxf([
        [0, "SECTION"], [2, "TABLES"],
        [0, "TABLE"], [2, "LAYER"],
        [0, "LAYER"], [2, "Hidden"],
        [0, "ENDTAB"],
        [0, "ENDSEC"],
    ]));
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.name, "Hidden");
    assert.equal(outline.entries[0]!.summary, "layer color=7");
});

test("cad returns an empty outline for an empty or header-only drawing", () => {
    for (const bytes of [new Uint8Array(0), new TextEncoder().encode(""), dxf([])]) {
        const outline = parseCad(bytes);
        assert.deepEqual(outline.entries, []);
        assert.equal(outline.text, "");
        assert.equal(outline.truncated, false);
    }
});

test("cad rejects truncated DWG headers and invalid UTF-8 DXF text", () => {
    assert.equal(errorCode(() => parseCad(new TextEncoder().encode("AC1015"))), "invalid_document");
    assert.equal(errorCode(() => parseCad(new TextEncoder().encode("AC1015\r\n0\r\nEOF\r\n"))), "invalid_document");
    assert.equal(errorCode(() => parseCad(Uint8Array.from([0x30, 0x0a, 0xff, 0xfe, 0x0a]))), "invalid_document");
});

test("cad rejects non-integer group codes but tolerates unknown groups and missing structure", () => {
    assert.equal(errorCode(() => parseCad(new TextEncoder().encode("0\r\nSECTION\r\nnope\r\nvalue\r\n"))), "invalid_document");
    assert.equal(errorCode(() => parseCad(new TextEncoder().encode("1.5\r\nvalue\r\n"))), "invalid_document");

    const tolerant = parseCad(new TextEncoder().encode("999\r\nignored\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n"));
    assert.deepEqual(tolerant.entries, []);
    assert.equal(tolerant.truncated, false);

    // A LAYER record outside the TABLES section is not a table entry.
    const stray = parseCad(new TextEncoder().encode("0\r\nLAYER\r\n2\r\nStray\r\n0\r\nEOF\r\n"));
    assert.deepEqual(stray.entries, []);
});

test("cad clips at the entry and text budgets and marks the outline truncated", () => {
    const entries = parseCad(dxf(DRAWING), { maxEntriesInOutline: 2 });
    assert.equal(entries.entries.length, 2);
    assert.equal(entries.entries[1]!.id, "cad:layer:2");
    assert.equal(entries.truncated, true);

    const text = parseCad(dxf(DRAWING), { maxTextCharacters: 5 });
    assert.equal(text.entries.length, 1);
    assert.equal(text.entries[0]!.summary, "layer");
    assert.equal(text.text, "layer");
    assert.equal(text.truncated, true);
});

test("cad definition is a valid document language and resolves DXF/DWG paths", () => {
    assert.equal(definition.id, "cad");
    assert.equal(definition.support, "document");
    assert.deepEqual([...definition.extensions], [".dxf", ".dwg", ".dwt"]);
    assert.deepEqual([...definition.mimeTypes], ["image/vnd.dxf", "application/acad"]);
    assert.equal(definition.documentParser?.language, "cad");
    assert.equal(Object.isFrozen(definition), true);

    const registry = new LanguageRegistry({ definitions: [definition] });
    const dxfMatch = registry.resolve("floor-plan.dxf");
    assert.equal(dxfMatch.isPresent(), true);
    assert.equal(dxfMatch.get().language.id, "cad");
    const dwgMatch = registry.resolve("floor-plan.dwg");
    assert.equal(dwgMatch.isPresent(), true);
    assert.equal(dwgMatch.get().language.id, "cad");
});

test("cad outlines AC1015 section metadata from the big-endian fixture contract", () => {
    const outline = parseCad(contractDwg("AC1015", [
        { payload: new TextEncoder().encode("HDR") },
        { payload: new TextEncoder().encode("CLS") },
    ]));

    assert.equal(outline.language, "cad");
    assert.equal(outline.truncated, false);
    assert.equal(outline.entries.length, 2);
    assert.deepEqual(outline.entries.map(entry => entry.id), [
        "cad:dwg:section:0", "cad:dwg:section:1",
    ]);

    const header = outline.entries[0]!;
    assert.equal(header.kind, "section");
    assert.equal(header.name, "Section 0");
    assert.equal(header.summary, "offset=41 size=3");
    assert.deepEqual(header.locator, { part: "dwg:sections", paragraph: 1 });

    const classes = outline.entries[1]!;
    assert.equal(classes.kind, "section");
    assert.equal(classes.name, "Section 1");
    assert.equal(classes.summary, "offset=44 size=3");
    assert.deepEqual(classes.locator, { part: "dwg:sections", paragraph: 2 });

    assert.equal(outline.text, "offset=41 size=3\noffset=44 size=3");
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    assert.equal(Object.isFrozen(header), true);
    assert.equal(Object.isFrozen(header.locator), true);
    assert.equal(outline.entries.some(entry => entry.id.startsWith("cad:dwg:class:")), false);
});

test("cad recognizes R13 and R14 section tables", () => {
    for (const version of ["AC1012", "AC1014"]) {
        const outline = parseCad(contractDwg(version, [{ payload: Uint8Array.from([1, 2, 3]) }]));
        assert.equal(outline.language, "cad");
        assert.equal(outline.entries.length, 1);
        assert.equal(outline.entries[0]!.name, "Section 0");
        assert.equal(outline.entries[0]!.summary, "offset=33 size=3");
    }
});

test("cad reads the public 9-byte little-endian AC15 locator layout", () => {
    const outline = parseCad(ac15Dwg("AC1015", [
        { number: 0, payload: Uint8Array.from([0xaa, 0xbb]) },
        { number: 1, payload: Uint8Array.from([0xcc]) },
        { number: 2, payload: Uint8Array.from([0xdd]) },
        { number: 3, seeker: 0, size: 0 },
        { number: 4, payload: Uint8Array.from([0xee]) },
        { number: 5, payload: Uint8Array.from([0xff]) },
    ], { headerSize: 0x61 }));

    assert.equal(outline.entries.length, 6);
    assert.deepEqual(outline.entries.map(entry => entry.id), [
        "cad:dwg:section:0", "cad:dwg:section:1", "cad:dwg:section:2",
        "cad:dwg:section:3", "cad:dwg:section:4", "cad:dwg:section:5",
    ]);
    assert.deepEqual(outline.entries.map(entry => entry.summary), [
        "offset=97 size=2",
        "offset=99 size=1",
        "offset=100 size=1",
        "offset=0 size=0",
        "offset=101 size=1",
        "offset=102 size=1",
    ]);
    assert.equal(outline.entries[3]!.kind, "section");
    assert.equal(outline.entries[5]!.locator.paragraph, 6);
    assert.equal(outline.truncated, false);
});

test("cad keeps CLASSES as a section and does not invent class entries", () => {
    const classLike = Uint8Array.from([
        0x01, 0xf4, 0x00, 0x03, 0x41, 0x42, 0x43,
        0x00, 0x03, 0x44, 0x45, 0x46, 0x00, 0x03, 0x47, 0x48, 0x49, 0x00, 0x00,
    ]);
    for (const payload of [classLike, classLike.subarray(0, 5)]) {
        const outline = parseCad(contractDwg("AC1015", [
            { payload: Uint8Array.from([1]) },
            { payload },
        ]));
        assert.equal(outline.entries.length, 2);
        assert.equal(outline.entries[1]!.name, "Section 1");
        assert.equal(outline.entries.some(entry => entry.id.startsWith("cad:dwg:class:")), false);
        assert.equal(outline.truncated, false);
    }
});

test("cad refuses R2004 and newer DWG with a version-specific compressed/encrypted error", () => {
    for (const [version, name] of [
        ["AC1018", "R2004"],
        ["AC1021", "R2007"],
        ["AC1024", "R2010"],
        ["AC1027", "R2013"],
        ["AC1032", "R2018"],
    ] as const) {
        // The version stamp alone identifies this family; a truncated header must not turn
        // the version-specific refusal into a generic invalid_document.
        const error = errorOf(() => parseCad(new TextEncoder().encode(version)));
        assert.equal(error.code, "unsupported_format");
        assert.equal(
            error.message,
            `DWG ${name} sections are compressed/encrypted; export DXF (or R2000-.dwg) for an outline`,
        );
    }
});

test("cad recognizes R10 and R11/R12 but refuses their pre-R13 layout", () => {
    for (const [version, name] of [["AC1006", "R10"], ["AC1009", "R11/R12"]] as const) {
        const error = errorOf(() => parseCad(contractDwg(version, [], { count: 0 })));
        assert.equal(error.code, "unsupported_format");
        assert.equal(error.message.includes(name), true, error.message);
        assert.equal(error.message.includes("DXF"), true, error.message);
    }
});

test("cad rejects unknown, short, negative and out-of-range DWG tables", () => {
    assert.equal(errorCode(() => parseCad(contractDwg("AC9999", [], { count: 0 }))), "invalid_document");
    assert.equal(errorCode(() => parseCad(contractDwg("ABCDEF", [], { count: 0 }))), "invalid_document");

    const valid = contractDwg("AC1015", [], { count: 0 });
    assert.equal(errorCode(() => parseCad(valid.subarray(0, 0x1f))), "invalid_document");
    assert.equal(errorCode(() => parseCad(valid.subarray(0, 2))), "invalid_document");

    assert.equal(errorCode(() => parseCad(contractDwg("AC1015", [
        { payload: Uint8Array.from([1]), seeker: 0x100, size: 1 },
    ], { fileSize: 0x30 }))), "invalid_document");
    assert.equal(errorCode(() => parseCad(contractDwg("AC1015", [
        { payload: Uint8Array.from([1]), seeker: 0x2f, size: 2 },
    ], { fileSize: 0x30 }))), "invalid_document");
    assert.equal(errorCode(() => parseCad(contractDwg("AC1015", [
        { payload: Uint8Array.from([1]), seeker: -1, size: 1 },
    ], { fileSize: 0x30 }))), "invalid_document");
    assert.equal(errorCode(() => parseCad(contractDwg("AC1015", [
        { payload: Uint8Array.from([1]), size: -1 },
    ]))), "invalid_document");
    assert.equal(errorCode(() => parseCad(contractDwg("AC1015", [], {
        count: 10, headerSize: 0x20, fileSize: 0x20,
    }))), "invalid_document");
    assert.equal(errorCode(() => parseCad(contractDwg("AC1015", [], {
        count: -1, headerSize: 0x20, fileSize: 0x20,
    }))), "invalid_document");
});

test("cad clips DWG section entries at maxNodes and maxEntriesInOutline", () => {
    const bytes = contractDwg("AC1015", [
        { payload: Uint8Array.from([1]) },
        { payload: Uint8Array.from([2]) },
        { payload: Uint8Array.from([3]) },
    ]);

    const nodes = parseCad(bytes, { maxNodes: 2 });
    assert.equal(nodes.entries.length, 2);
    assert.deepEqual(nodes.entries.map(entry => entry.id), ["cad:dwg:section:0", "cad:dwg:section:1"]);
    assert.equal(nodes.truncated, true);

    const outlined = parseCad(bytes, { maxEntriesInOutline: 1 });
    assert.equal(outlined.entries.length, 1);
    assert.equal(outlined.entries[0]!.id, "cad:dwg:section:0");
    assert.equal(outlined.truncated, true);

    const none = parseCad(bytes, { maxNodes: 0 });
    assert.equal(none.entries.length, 0);
    assert.equal(none.text, "");
    assert.equal(none.truncated, true);
});

test("cad rejects non-Uint8Array input with a TypeError", () => {
    assert.throws(() => parseCad(null as unknown as Uint8Array), TypeError);
    assert.throws(() => parseCad("AC1015" as unknown as Uint8Array), TypeError);
    assert.throws(() => parseCad(new ArrayBuffer(0x20) as unknown as Uint8Array), TypeError);
});
