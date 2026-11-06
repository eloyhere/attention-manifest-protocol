import assert from "node:assert/strict";
import test from "node:test";
import { definition } from "../language/solidworks.ts";
import { LanguageRegistry } from "../language/registry.ts";
import { parseSolidworks } from "./solidworks.ts";
import { DocumentError } from "./types.ts";

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

const compoundFile = (size = 512): Uint8Array => {
    const bytes = new Uint8Array(size);
    bytes.set(OLE_SIGNATURE);
    return bytes;
};

const errorCode = (operation: () => unknown): string => {
    try {
        operation();
    } catch (error) {
        if (error instanceof DocumentError) return error.code;
        throw error;
    }
    assert.fail("expected a DocumentError");
};

test("SolidWorks compound documents are unsupported_format", () => {
    assert.throws(() => parseSolidworks(compoundFile()), (error: unknown) => error instanceof DocumentError
        && error.code === "unsupported_format"
        && error.message.includes("SolidWorks")
        && error.message.includes("proprietary OLE streams")
        && error.message.includes("host adapter"));
});

test("non-OLE input is invalid_document instead of an empty outline", () => {
    const stepText = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n");
    assert.equal(errorCode(() => parseSolidworks(stepText)), "invalid_document");
    assert.equal(errorCode(() => parseSolidworks(new Uint8Array(0))), "invalid_document");
    assert.equal(errorCode(() => parseSolidworks(new Uint8Array(512))), "invalid_document");
});

test("non-byte input is a TypeError", () => {
    assert.throws(() => parseSolidworks("not bytes" as unknown as Uint8Array), TypeError);
    assert.throws(() => parseSolidworks(new ArrayBuffer(8) as unknown as Uint8Array), TypeError);
});

test("the solidworks definition is valid and resolves all three extensions", () => {
    assert.equal(definition.id, "solidworks");
    assert.equal(definition.displayName, "SolidWorks");
    assert.equal(definition.support, "document");
    assert.deepEqual(definition.extensions, [".sldprt", ".sldasm", ".slddrw"]);
    assert.deepEqual(definition.mimeTypes, ["application/x-solidworks", "application/x-sldprt"]);
    assert.equal(definition.documentParser?.language, "solidworks");
    assert.throws(() => definition.documentParser!.parse(compoundFile()), (error: unknown) => error instanceof DocumentError
        && error.code === "unsupported_format");

    const registry = new LanguageRegistry({ definitions: [definition] });
    for (const extension of [".sldprt", ".sldasm", ".slddrw"]) {
        const match = registry.resolve(`part${extension}`).get();
        assert.equal(match.language.id, "solidworks");
        assert.equal(match.extension, extension);
        assert.equal(match.confidence, "exact");
    }
    assert.equal(registry.resolve("part.sldprt", "application/x-sldprt").get().language.id, "solidworks");
});
