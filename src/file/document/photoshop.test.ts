import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";
import { LanguageRegistry } from "../language/registry.ts";
import { definition } from "../language/photoshop.ts";
import { parsePsd } from "./photoshop.ts";
import { DocumentError } from "./types.ts";

/** Big-endian writer for hand-built PSD/PSB fixtures; no third-party encoders are involved. */
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

    /** Encodes a non-negative integer as a big-endian u64; fixtures stay below 2^53. */
    u64(value: number): this {
        const high = Math.floor(value / 0x1_0000_0000);
        return this.u32(high).u32(value - high * 0x1_0000_0000);
    }

    ascii(value: string): this {
        for (let index = 0; index < value.length; index += 1) this.bytes.push(value.charCodeAt(index) & 0xff);
        return this;
    }

    utf16be(value: string): this {
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            this.bytes.push((code >>> 8) & 0xff, code & 0xff);
        }
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

/** Pascal string: one length byte, the bytes, then zero padding to a four-byte boundary. */
function pascal(value: string): readonly number[] {
    const encoded = [...new TextEncoder().encode(value)];
    const output = [encoded.length, ...encoded];
    while (output.length % 4 !== 0) output.push(0);
    return output;
}

interface ExtraBlock {
    readonly key: string;
    readonly data: readonly number[];
}

interface LayerFixture {
    readonly name: string;
    /** When present, emitted as a `luni` tagged block and preferred over `name`. */
    readonly unicodeName?: string;
    readonly sectionType?: number;
    readonly dividerKey?: "lsct" | "lsdk";
    readonly top?: number;
    readonly left?: number;
    readonly bottom?: number;
    readonly right?: number;
    readonly opacity?: number;
    readonly blend?: string;
    readonly masked?: boolean;
    readonly blendingRanges?: boolean;
    readonly channelLength?: number;
    readonly extraBlocks?: readonly ExtraBlock[];
    /** Appended raw bytes after the last tagged block, used to corrupt the block stream. */
    readonly extraTail?: readonly number[];
    readonly blendSignature?: string;
}

interface PsdFixtureOptions {
    readonly version?: number;
    readonly signature?: string;
    readonly reserved?: readonly number[];
    readonly channels?: number;
    readonly width?: number;
    readonly height?: number;
    readonly depth?: number;
    readonly colorMode?: number;
    readonly colorModeData?: readonly number[];
    readonly imageResources?: readonly number[];
    readonly withLayerSection?: boolean;
    readonly layerCount?: number;
    readonly sectionLengthOverride?: number;
    readonly layerInfoLengthOverride?: number;
    /** Channel image bytes appended after the layer records inside the layer info section. */
    readonly channelData?: readonly number[];
}

function layerRecord(layer: LayerFixture, version: number): Uint8Array {
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
    if (layer.unicodeName !== undefined) {
        const data = new Writer();
        data.u32(layer.unicodeName.length).utf16be(layer.unicodeName);
        extra.ascii("8BIM").ascii("luni").u32(data.length).raw(data.toBytes());
    }
    if (layer.sectionType !== undefined) {
        extra.ascii("8BIM").ascii(layer.dividerKey ?? "lsct").u32(4).u32(layer.sectionType);
    }
    for (const block of layer.extraBlocks ?? []) {
        extra.ascii("8BIM").ascii(block.key).u32(block.data.length).raw(block.data);
        if (block.data.length % 2 === 1) extra.u8(0);
    }
    if (layer.extraTail !== undefined) extra.raw(layer.extraTail);

    const record = new Writer();
    record.i32(layer.top ?? 0).i32(layer.left ?? 0).i32(layer.bottom ?? 0).i32(layer.right ?? 0);
    record.u16(1).i16(0);
    // The only PSD/PSB record difference: channel data length is u32 in PSD, u64 in PSB.
    if (version === 2) record.u64(layer.channelLength ?? 0);
    else record.u32(layer.channelLength ?? 0);
    record.ascii(layer.blendSignature ?? "8BIM").ascii(layer.blend ?? "norm");
    record.u8(layer.opacity ?? 255).u8(0).u8(2).u8(0);
    record.u32(extra.length).raw(extra.toBytes());
    return record.toBytes();
}

function makePsd(layers: readonly LayerFixture[], options: PsdFixtureOptions = {}): Uint8Array {
    const version = options.version ?? 1;
    const writer = new Writer();
    writer.ascii(options.signature ?? "8BPS");
    writer.u16(version);
    writer.raw(options.reserved ?? [0, 0, 0, 0, 0, 0]);
    writer.u16(options.channels ?? 3);
    writer.u32(options.height ?? 200);
    writer.u32(options.width ?? 300);
    writer.u16(options.depth ?? 8);
    writer.u16(options.colorMode ?? 3);
    const colorModeData = options.colorModeData ?? [];
    writer.u32(colorModeData.length).raw(colorModeData);
    const imageResources = options.imageResources ?? [];
    writer.u32(imageResources.length).raw(imageResources);
    if (options.withLayerSection === false) return writer.toBytes();

    const layerInfo = new Writer();
    layerInfo.i16(options.layerCount ?? (layers.length === 0 ? 0 : -layers.length));
    for (const layer of layers) layerInfo.raw(layerRecord(layer, version));
    if (options.channelData !== undefined) layerInfo.raw(options.channelData);
    const section = new Writer();
    const layerInfoLength = options.layerInfoLengthOverride ?? layerInfo.length;
    if (version === 2) section.u64(layerInfoLength);
    else section.u32(layerInfoLength);
    section.raw(layerInfo.toBytes()).u32(0); // global layer mask info
    const sectionLength = options.sectionLengthOverride ?? section.length;
    if (version === 2) writer.u64(sectionLength);
    else writer.u32(sectionLength);
    writer.raw(section.toBytes());
    return writer.toBytes();
}

/**
 * Six on-disk records, four projected entries:
 *   Group A (lsct=1, luni name)
 *     Child One (luni name overrides the Pascal name)
 *     Group B (lsdk=1, Pascal-only name)
 *       Nested Child (luni name)
 *   </Layer group> (lsdk=2, closes Group B)
 *   </Layer group> (lsct=2, closes Group A)
 */
const TREE: readonly LayerFixture[] = Object.freeze([
    Object.freeze({
        name: "Group A", unicodeName: "Group A ✓", sectionType: 1,
        top: 0, left: 0, bottom: 100, right: 200,
    }),
    Object.freeze({
        name: "pascal-child", unicodeName: "Child One", opacity: 200,
        top: 10, left: 20, bottom: 60, right: 120,
    }),
    Object.freeze({ name: "Group B", sectionType: 1, dividerKey: "lsdk" }),
    Object.freeze({ name: "Deep", unicodeName: "Nested Child", top: 5, left: 6, bottom: 25, right: 46 }),
    Object.freeze({ name: "</Layer group>", sectionType: 2, dividerKey: "lsdk" }),
    Object.freeze({ name: "</Layer group>", sectionType: 2 }),
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

test("psd reconstructs nested groups with luni names, Pascal fallbacks and stable record ids", () => {
    const outline = parsePsd(makePsd(TREE));

    assert.equal(outline.language, "photoshop");
    assert.equal(outline.truncated, false);
    assert.equal(outline.entries.length, 4);
    assert.deepEqual(outline.entries.map(entry => entry.id), ["psd:layer:1", "psd:layer:2", "psd:layer:3", "psd:layer:4"]);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Group A ✓", "Child One", "Group B", "Nested Child"]);
    assert.deepEqual(outline.entries.map(entry => entry.parentId),
        [undefined, "psd:layer:1", "psd:layer:1", "psd:layer:3"]);
    assert.deepEqual(outline.entries.map(entry => entry.summary), [
        "200×100 @ (0,0) blend=norm opacity=255",
        "100×50 @ (20,10) blend=norm opacity=200",
        "0×0 @ (0,0) blend=norm opacity=255",
        "40×20 @ (6,5) blend=norm opacity=255",
    ]);
    assert.deepEqual(outline.entries.map(entry => entry.locator), [
        { part: "psd:layers", paragraph: 1 },
        { part: "psd:layers", paragraph: 2 },
        { part: "psd:layers", paragraph: 3 },
        { part: "psd:layers", paragraph: 4 },
    ]);
    assert.equal(outline.text, outline.entries.map(entry => entry.summary).join("\n"));
    assert.equal("parentId" in outline.entries[0]!, false);

    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    for (const entry of outline.entries) {
        assert.equal(Object.isFrozen(entry), true);
        assert.equal(Object.isFrozen(entry.locator), true);
    }
});

test("psb parses the same layer tree through its 64-bit length fields", () => {
    const psd = parsePsd(makePsd(TREE));
    const psb = parsePsd(makePsd(TREE, { version: 2 }));

    assert.equal(psb.language, "photoshop");
    assert.equal(psb.truncated, false);
    assert.deepEqual(psb.entries, psd.entries);
    assert.equal(psb.text, psd.text);
});

test("psb reads a whole 64-bit channel length instead of a 32-bit prefix", () => {
    // Eight channel bytes are present; a 32-bit read would consume only the high half of the
    // u64 field, leaving the low half to misalign the blend signature that follows it.
    const outline = parsePsd(makePsd([{ name: "Wide channel", channelLength: 8 }], {
        version: 2,
        channelData: [0, 0, 1, 2, 3, 4, 5, 6],
    }));
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.name, "Wide channel");
    assert.equal(outline.entries[0]!.summary, "0×0 @ (0,0) blend=norm opacity=255");
});

test("psd skips color-mode data and image resources by their u32 lengths", () => {
    for (const version of [1, 2]) {
        const outline = parsePsd(makePsd([{ name: "After trailers" }], {
            version,
            colorModeData: [1, 2, 3],
            imageResources: [4, 5, 6, 7],
        }));
        assert.equal(outline.entries.length, 1);
        assert.equal(outline.entries[0]!.name, "After trailers");
    }
});

test("psd skips layer masks and blending ranges in both versions", () => {
    for (const version of [1, 2]) {
        const outline = parsePsd(makePsd([{ name: "Masked", masked: true, blendingRanges: true }], { version }));
        assert.equal(outline.entries.length, 1);
        assert.equal(outline.entries[0]!.name, "Masked");
        assert.equal(outline.entries[0]!.summary, "0×0 @ (0,0) blend=norm opacity=255");
    }
});

test("psd falls back to a generated name for an empty Pascal string", () => {
    const outline = parsePsd(makePsd([{ name: "" }]));
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.name, "Layer 1");
});

test("psd ignores unmatched closers and keeps record ordinals stable", () => {
    const outline = parsePsd(makePsd([
        { name: "Before" },
        { name: "</Layer group>", sectionType: 2 },
        { name: "After", unicodeName: "After luni" },
    ]));
    assert.deepEqual(outline.entries.map(entry => entry.id), ["psd:layer:1", "psd:layer:3"]);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Before", "After luni"]);
    assert.equal(outline.entries[0]!.parentId, undefined);
    assert.equal(outline.entries[1]!.parentId, undefined);
});

test("psd keeps the children of a group that is never closed", () => {
    const outline = parsePsd(makePsd([
        { name: "Open", sectionType: 1 },
        { name: "Child" },
    ]));
    assert.equal(outline.entries.length, 2);
    assert.equal(outline.entries[1]!.parentId, "psd:layer:1");
});

test("psd closes a group before the layer that follows it", () => {
    const outline = parsePsd(makePsd([
        { name: "Group", sectionType: 1 },
        { name: "Inside" },
        { name: "</Layer group>", sectionType: 2 },
        { name: "Outside" },
    ]));
    assert.deepEqual(outline.entries.map(entry => entry.id), ["psd:layer:1", "psd:layer:2", "psd:layer:4"]);
    assert.deepEqual(outline.entries.map(entry => entry.parentId), [undefined, "psd:layer:1", undefined]);
});

test("psd treats a boundary group as a leaf that captures no later layers", () => {
    const outline = parsePsd(makePsd([
        { name: "Boundary", sectionType: 3 },
        { name: "After" },
    ]));
    assert.equal(outline.entries.length, 2);
    assert.equal(outline.entries[0]!.parentId, undefined);
    assert.equal(outline.entries[1]!.parentId, undefined);
});

test("psd skips unknown additional-information blocks including odd-length padding", () => {
    const outline = parsePsd(makePsd([
        { name: "Odd", extraBlocks: [{ key: "TEST", data: [1, 2, 3] }] },
        { name: "Even", extraBlocks: [{ key: "lyid", data: [0, 0, 0, 7] }] },
    ]));
    assert.equal(outline.entries.length, 2);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Odd", "Even"]);
    assert.deepEqual(outline.entries.map(entry => entry.summary), [
        "0×0 @ (0,0) blend=norm opacity=255",
        "0×0 @ (0,0) blend=norm opacity=255",
    ]);
});

test("psd returns an empty outline for a flattened document with no layer records", () => {
    const outline = parsePsd(makePsd([]));
    assert.deepEqual(outline.entries, []);
    assert.equal(outline.text, "");
    assert.equal(outline.truncated, false);
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);

    const zeroLength = parsePsd(makePsd([], { layerInfoLengthOverride: 0 }));
    assert.deepEqual(zeroLength.entries, []);
    assert.equal(zeroLength.truncated, false);
});

test("psd clips at the entry and text budgets and marks the outline truncated", () => {
    const entries = parsePsd(makePsd(TREE), { maxEntriesInOutline: 2 });
    assert.equal(entries.entries.length, 2);
    assert.deepEqual(entries.entries.map(entry => entry.id), ["psd:layer:1", "psd:layer:2"]);
    assert.equal(entries.text, entries.entries.map(entry => entry.summary).join("\n"));
    assert.equal(entries.truncated, true);

    const text = parsePsd(makePsd(TREE), { maxTextCharacters: 5 });
    assert.equal(text.entries.length, 1);
    assert.equal(text.entries[0]!.summary, "200×1");
    assert.equal(text.text, "200×1");
    assert.equal(text.truncated, true);
});

test("psd raises limit_exceeded when the node budget is exhausted", () => {
    assert.equal(parsePsd(makePsd([{ name: "Plain" }]), { maxNodes: 1 }).entries.length, 1);
    assert.equal(errorCode(() => parsePsd(
        makePsd([{ name: "Named", unicodeName: "Named" }]), { maxNodes: 1 })), "limit_exceeded");
    assert.equal(errorCode(() => parsePsd(makePsd(TREE), { maxNodes: 1 })), "limit_exceeded");
    assert.equal(parsePsd(makePsd(TREE), { maxNodes: 4096 }).entries.length, 4);
});

test("psd rejects malformed headers and truncated input", () => {
    assert.equal(errorCode(() => parsePsd(makePsd([], { signature: "8BPX" }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { reserved: [1, 0, 0, 0, 0, 0] }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { channels: 0 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { channels: 57 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { depth: 7 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { width: 0 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { width: 300_001 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { height: 0 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { colorMode: 10 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { withLayerSection: false }))), "invalid_document");

    const complete = makePsd(TREE);
    assert.equal(errorCode(() => parsePsd(complete.slice(0, complete.length - 2))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(complete.slice(0, 30))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(new Uint8Array(0))), "invalid_document");
    assert.throws(() => parsePsd("not bytes" as unknown as Uint8Array), TypeError);
});

test("psd treats unknown versions as invalid rather than unsupported", () => {
    assert.equal(errorCode(() => parsePsd(makePsd([], { version: 3 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([], { version: 0 }))), "invalid_document");
    const emptyPsb = parsePsd(makePsd([], { version: 2 }));
    assert.deepEqual(emptyPsb.entries, []);
    assert.equal(emptyPsb.truncated, false);
});

test("psd rejects broken blend signatures, bogus counts and length mismatches", () => {
    assert.equal(errorCode(() => parsePsd(makePsd([{ name: "Bad", blendSignature: "8BIT" }]))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd(TREE, { layerCount: 99 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd(TREE, { layerCount: 2 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd(TREE, { sectionLengthOverride: 10_000 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd(TREE, { layerInfoLengthOverride: 10_000 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd(TREE, { sectionLengthOverride: 2 }))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd(TREE, { version: 2, sectionLengthOverride: 6 }))), "invalid_document");
    const badBlock = [0x58, 0x58, 0x58, 0x58, 0, 0, 0, 0, 0, 0, 0, 0];
    assert.equal(errorCode(() => parsePsd(makePsd([{ name: "Tail", extraTail: badBlock }]))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([
        { name: "Bad divider", extraBlocks: [{ key: "lsct", data: [1, 2] }] },
    ]))), "invalid_document");
    assert.equal(errorCode(() => parsePsd(makePsd([
        { name: "Bad unicode", extraBlocks: [{ key: "luni", data: [0, 0, 0, 10] }] },
    ]))), "invalid_document");
    const complete = makePsd(TREE, { version: 2 });
    assert.equal(errorCode(() => parsePsd(complete.slice(0, complete.length - 3))), "invalid_document");
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
