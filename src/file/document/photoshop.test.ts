import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";
import { LanguageRegistry } from "../language/registry.ts";
import { definition } from "../language/photoshop.ts";
import { parsePsd } from "./photoshop.ts";
import { DocumentError } from "./types.ts";

/** Big-endian writer for hand-built PSD fixtures; no third-party encoders are involved. */
class Writer {
    private readonly bytes: number[] = [];

    get length(): number {
        return this.bytes.length;
    }

    u8(value: number): this {
        this.bytes.push(value & 0xff);
        return this;
    }

    u16(value: number): this {
        this.bytes.push((value >>> 8) & 0xff, value & 0xff);
        return this;
    }

    i16(value: number): this {
        return this.u16(value < 0 ? value + 0x10000 : value);
    }

    u32(value: number): this {
        const normalized = value >>> 0;
        this.bytes.push((normalized >>> 24) & 0xff, (normalized >>> 16) & 0xff, (normalized >>> 8) & 0xff, normalized & 0xff);
        return this;
    }

    i32(value: number): this {
        return this.u32(value);
    }

    ascii(value: string): this {
        for (let index = 0; index < value.length; index += 1) this.bytes.push(value.charCodeAt(index) & 0xff);
        return this;
    }

    raw(values: readonly number[] | Uint8Array): this {
        for (const value of values) this.bytes.push(value & 0xff);
        return this;
    }

    toBytes(): Uint8Array {
        return Uint8Array.from(this.bytes);
    }
}

function pascal(value: string): readonly number[] {
    const encoded = [...new TextEncoder().encode(value)];
    const output = [encoded.length, ...encoded];
    while (output.length % 4 !== 0) output.push(0);
    return output;
}

interface LayerFixture {
    readonly name: string;
    readonly top?: number;
    readonly left?: number;
    readonly bottom?: number;
    readonly right?: number;
    readonly opacity?: number;
    readonly blend?: string;
    readonly sectionType?: number;
    readonly masked?: boolean;
    readonly blendingRanges?: boolean;
}

interface PsdFixtureOptions {
    readonly signature?: string;
    readonly version?: number;
    readonly width?: number;
    readonly height?: number;
    readonly channels?: number;
    readonly depth?: number;
    readonly colorMode?: number;
    readonly withLayerSection?: boolean;
}

function layerRecord(layer: LayerFixture): Uint8Array {
    const extra = new Writer();
    if (layer.masked === true) {
        // A minimal 18-byte mask header: rectangle, default colour and flags.
        extra.u32(18).i32(0).i32(0).i32(10).i32(10).u8(0).u8(0);
    } else {
        extra.u32(0); // layer mask data length
    }
    if (layer.blendingRanges === true) {
        extra.u32(8).raw([0, 0, 0, 0, 255, 255, 255, 255]);
    } else {
        extra.u32(0); // blending ranges length
    }
    extra.raw(pascal(layer.name));
    if (layer.sectionType !== undefined) {
        extra.ascii("8BIM").ascii("lsct").u32(4).i32(layer.sectionType);
    }
    const record = new Writer();
    record.i32(layer.top ?? 0).i32(layer.left ?? 0).i32(layer.bottom ?? 0).i32(layer.right ?? 0);
    record.u16(1).i16(0).u32(0); // one channel, id 0, no channel image data is parsed
    record.ascii("8BIM").ascii(layer.blend ?? "norm");
    record.u8(layer.opacity ?? 255).u8(0).u8(2).u8(0);
    record.u32(extra.length).raw(extra.toBytes());
    return record.toBytes();
}

function makePsd(layers: readonly LayerFixture[], options: PsdFixtureOptions = {}): Uint8Array {
    const writer = new Writer();
    writer.ascii(options.signature ?? "8BPS");
    writer.u16(options.version ?? 1);
    writer.raw([0, 0, 0, 0, 0, 0]);
    writer.u16(options.channels ?? 3);
    writer.u32(options.height ?? 200);
    writer.u32(options.width ?? 300);
    writer.u16(options.depth ?? 8);
    writer.u16(options.colorMode ?? 3);
    writer.u32(0); // color mode data
    writer.u32(0); // image resources
    if (options.withLayerSection === false) return writer.toBytes();

    const layerInfo = new Writer();
    layerInfo.i16(layers.length === 0 ? 0 : -layers.length);
    for (const layer of layers) layerInfo.raw(layerRecord(layer));
    const section = new Writer();
    section.u32(layerInfo.length).raw(layerInfo.toBytes()).u32(0); // global layer mask info
    writer.u32(section.length).raw(section.toBytes());
    return writer.toBytes();
}

const LAYERS: readonly LayerFixture[] = Object.freeze([
    Object.freeze({ name: "Background", top: 0, left: 0, bottom: 200, right: 300, opacity: 255 }),
    Object.freeze({ name: "Logo", top: 10, left: 20, bottom: 110, right: 220, opacity: 128 }),
    Object.freeze({ name: "<Layer group>", sectionType: 2, opacity: 255 }),
]);

function errorCode(operation: () => unknown): string {
    try {
        operation();
    } catch (error) {
        if (error instanceof DocumentError) return error.code;
        throw error;
    }
    assert.fail("expected a DocumentError");
}

test("psd projects every layer record with its rectangle, blend mode, opacity and locator", () => {
    const outline = parsePsd(makePsd(LAYERS));

    assert.equal(outline.language, "photoshop");
    assert.equal(outline.truncated, false);
    assert.equal(outline.entries.length, 3);

    const background = outline.entries[0]!;
    assert.equal(background.id, "psd:layer:1");
    assert.equal(background.kind, "section");
    assert.equal(background.name, "Background");
    assert.equal(background.summary, "300×200 @ (0,0) blend=norm opacity=255");
    assert.deepEqual(background.locator, { part: "psd:layers", paragraph: 1 });

    const logo = outline.entries[1]!;
    assert.equal(logo.id, "psd:layer:2");
    assert.equal(logo.name, "Logo");
    assert.equal(logo.summary, "200×100 @ (20,10) blend=norm opacity=128");
    assert.deepEqual(logo.locator, { part: "psd:layers", paragraph: 2 });

    const group = outline.entries[2]!;
    assert.equal(group.id, "psd:layer:3");
    assert.equal(group.name, "<Layer group>");
    assert.equal(group.summary, "0×0 @ (0,0) blend=norm opacity=255");
    assert.deepEqual(group.locator, { part: "psd:layers", paragraph: 3 });

    assert.equal(outline.text, outline.entries.map(entry => entry.summary).join("\n"));
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    assert.equal(Object.isFrozen(background), true);
    assert.equal(Object.isFrozen(background.locator), true);
});

test("psd falls back to a generated name for an empty Pascal string", () => {
    const outline = parsePsd(makePsd([{ name: "" }]));
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.name, "Layer 1");
});

test("psd skips a layer mask header and blending range payloads", () => {
    const outline = parsePsd(makePsd([{ name: "Masked", masked: true, blendingRanges: true }]));
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.name, "Masked");
    assert.equal(outline.entries[0]!.summary, "0×0 @ (0,0) blend=norm opacity=255");
});

test("psd returns an empty outline for a flattened document with no layer records", () => {
    const outline = parsePsd(makePsd([]));
    assert.deepEqual(outline.entries, []);
    assert.equal(outline.text, "");
    assert.equal(outline.truncated, false);
});

test("psd rejects a bad header, bad dimensions and a truncated file", () => {
    assert.equal(errorCode(() => parsePsd(makePsd([], { signature: "8BPX" }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { channels: 0 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { depth: 7 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { width: 0 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { colorMode: 10 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { withLayerSection: false }))), "invalid_document");

    const complete = makePsd(LAYERS);
    assert.equal(errorCode(() => parsePsd(complete.slice(0, complete.length - 2))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(complete.slice(0, 30))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(new Uint8Array(0))), "invalid_document");
    assert.throws(() => parsePsd("not bytes" as unknown as Uint8Array), TypeError);
});

test("psd reports unsupported versions instead of misreading them", () => {
    assert.equal(errorCode(() => parsePsd(makePsd([], { version: 3 }))), "unsupported_format");
    // PSB stores 64-bit layer lengths; the reader refuses rather than guessing.
    assert.equal(errorCode(() => parsePsd(makePsd([], { version: 2 }))), "unsupported_format");
});

test("psd clips at the entry and text budgets and marks the outline truncated", () => {
    const entries = parsePsd(makePsd(LAYERS), { maxEntriesInOutline: 1 });
    assert.equal(entries.entries.length, 1);
    assert.equal(entries.truncated, true);
    assert.equal(entries.entries[0]!.id, "psd:layer:1");

    const text = parsePsd(makePsd(LAYERS), { maxTextCharacters: 5 });
    assert.equal(text.entries.length, 1);
    assert.equal(text.entries[0]!.summary, "300×2");
    assert.equal(text.text, "300×2");
    assert.equal(text.truncated, true);
});

test("photoshop definition is a valid document language and resolves PSD-family paths", () => {
    assert.equal(definition.id, "photoshop");
    assert.equal(definition.support, "document");
    assert.deepEqual([...definition.extensions], [".psd", ".psb", ".psdt"]);
    assert.deepEqual([...definition.mimeTypes], ["image/vnd.adobe.photoshop", "application/x-photoshop"]);
    assert.equal(definition.documentParser?.language, "photoshop");
    assert.equal(Object.isFrozen(definition), true);

    const registry = new LanguageRegistry({ definitions: [definition] });
    const psd = registry.resolve("artwork.psd");
    assert.equal(psd.isPresent(), true);
    assert.equal(psd.get().language.id, "photoshop");
    const psb = registry.resolve("artwork.psb");
    assert.equal(psb.isPresent(), true);
    assert.equal(psb.get().language.id, "photoshop");
});
