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

function errorCode(operation: () => unknown): string {
    try {
        operation();
    } catch (error) {
        if (error instanceof DocumentError) return error.code;
        throw error;
    }
    assert.fail("expected a DocumentError");
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

test("cad refuses DWG signatures and invalid UTF-8", () => {
    assert.equal(errorCode(() => parseCad(new TextEncoder().encode("AC1015\r\n0\r\nEOF\r\n"))), "unsupported_format");
    assert.equal(errorCode(() => parseCad(Uint8Array.from([0x41, 0x43, 0x31, 0x30, 0x31, 0x38, 0xff]))), "unsupported_format");
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
