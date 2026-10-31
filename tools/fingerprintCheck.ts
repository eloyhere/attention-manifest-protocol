#!/usr/bin/env node
/**
 * Fingerprint regression checks.
 *
 * Every assertion here is an anti-regression for a defect the design audit
 * measured: the unpaired-surrogate collision (`"\uD800"` hashed as U+FFFD), the
 * `-0`/`0` collision, the binary-unsafe UTF-8 file read (`0x80` and `0x81`
 * collided), the missing algorithm/policy identity, and the absence of a single
 * verification entry point. The known-answer vectors and the `node:crypto`
 * cross-checks make a broken SHA-256 fail here rather than in production; this
 * file may import `node:crypto`, the module under test may not.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    FingerprintError,
    FingerprintIOError,
    FingerprintMismatch,
    NormalizationRejected,
    Policy,
    UnsupportedKind,
    createSha256,
    fingerprintBoolean,
    fingerprintBytes,
    fingerprintFile,
    fingerprintFileMeta,
    fingerprintJson,
    fingerprintNull,
    fingerprintNumber,
    fingerprintOf,
    fingerprintString,
    fingerprintText,
    fingerprintTree,
    formatRef,
    formatShort,
    matches,
    parseRef,
    parseShort,
    sha256Bytes,
    verify,
} from "../src/fingerprint/index.ts";
import type { ByteHasher, FileFingerprint, Fingerprint, FingerprintRef, TreeFingerprint } from "../src/fingerprint/index.ts";
import { describeError } from "../src/fingerprint/error.ts";
import { assertKind, createPayloadHasher } from "../src/fingerprint/preimage.ts";
import { encodeUtf8Strict } from "../src/fingerprint/text.ts";
import { sha256Hex } from "../src/semantic/sha256.ts";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => void = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error: unknown) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${describeError(error)}`);
    }
};

const testAsync: (name: string, fn: () => Promise<void>) => Promise<void> = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
        await fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error: unknown) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${describeError(error)}`);
    }
};

const hex: (bytes: Uint8Array) => string = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const cryptoHex: (bytes: Uint8Array) => string = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const utf8: (text: string) => Uint8Array = (text: string): Uint8Array => encodeUtf8Strict(text);

const u32be: (value: number) => Buffer = (value: number): Buffer => {
    const buffer: Buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value, 0);
    return buffer;
};

const u64be: (value: bigint) => Buffer = (value: bigint): Buffer => {
    const buffer: Buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(value, 0);
    return buffer;
};

const makePayload: (length: number) => Uint8Array = (length: number): Uint8Array => {
    const bytes: Uint8Array = new Uint8Array(length);
    for (let index: number = 0; index < length; index += 1) {
        bytes[index] = (index * 31 + 7) % 256;
    }
    return bytes;
};

const TempRoot: string = join(".cache", "fingerprint-check");

const fixturePath: (relative: string) => string = (relative: string): string => join(TempRoot, relative);

const makeDirectory: (relative: string) => string = (relative: string): string => {
    const path: string = fixturePath(relative);
    mkdirSync(path, { recursive: true });
    return path;
};

const writeFixture: (relative: string, content: Uint8Array) => string = (relative: string, content: Uint8Array): string => {
    const path: string = fixturePath(relative);
    writeFileSync(path, content);
    return path;
};

rmSync(TempRoot, { recursive: true, force: true });
mkdirSync(TempRoot, { recursive: true });

const FormulaDirectory: string = makeDirectory("tree-formula");
writeFixture("tree-formula/a.txt", utf8("hi"));

const FileFixturePath: string = writeFixture("file-content.bin", makePayload(5000));
const Byte80Path: string = writeFixture("bin-80.bin", Uint8Array.of(0x80));
const Byte81Path: string = writeFixture("bin-81.bin", Uint8Array.of(0x81));
const TextCrlfPath: string = writeFixture("text-crlf.txt", utf8("e\u0301\r\nx"));
const TextNfcPath: string = writeFixture("text-nfc.txt", utf8("\u00e9\nx"));
const InvalidUtf8Path: string = writeFixture("invalid-utf8.bin", Uint8Array.of(0xff, 0xfe));
const BomPath: string = writeFixture("bom.txt", Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
const PlainPath: string = writeFixture("plain.txt", utf8("hi"));

makeDirectory("file-directory");

makeDirectory("tree-mode-file");
writeFixture("tree-mode-file/x", new Uint8Array());
makeDirectory("tree-mode-dir/x");

makeDirectory("tree-change");
writeFixture("tree-change/base.txt", utf8("base"));

makeDirectory("tree-sorted/a");
writeFixture("tree-sorted/a.txt", utf8("a"));
writeFixture("tree-sorted/a/b.txt", utf8("ab"));
writeFixture("tree-sorted/b.txt", utf8("b"));

makeDirectory("tree-exclude/node_modules");
writeFixture("tree-exclude/keep.txt", utf8("keep"));
writeFixture("tree-exclude/node_modules/dep.txt", utf8("dep"));

makeDirectory("tree-custom-exclude/node_modules");
writeFixture("tree-custom-exclude/keep.txt", utf8("keep"));
writeFixture("tree-custom-exclude/skip.txt", utf8("skip"));
writeFixture("tree-custom-exclude/node_modules/dep.txt", utf8("dep"));

makeDirectory("tree-order");
writeFixture("tree-order/\uE000.txt", utf8("private"));
writeFixture("tree-order/\u{1F600}.txt", utf8("emoji"));

makeDirectory("tree-empty");

test("sha256 matches the FIPS 180-4 known-answer vectors", () => {
    assert.equal(hex(sha256Bytes(utf8("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(hex(sha256Bytes(new Uint8Array())), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("the digest is sha256 over the documented header plus payload", () => {
    const bytePayload: Uint8Array = utf8("abc");
    const byteHeader: string = `amp.fp/1\nbytes\n${Policy.bytesRaw}\n${bytePayload.length}\n`;
    const byteExpected: string = cryptoHex(Buffer.concat([Buffer.from(byteHeader, "utf8"), Buffer.from(bytePayload)]));
    assert.equal(fingerprintBytes(bytePayload).ref.digest, byteExpected);

    const textPayload: Uint8Array = utf8("hello");
    const textHeader: string = `amp.fp/1\ntext\n${Policy.textRaw}\n${textPayload.length}\n`;
    const textExpected: string = cryptoHex(Buffer.concat([Buffer.from(textHeader, "utf8"), Buffer.from(textPayload)]));
    assert.equal(fingerprintText("hello", { policy: "raw" }).ref.digest, textExpected);
});

test("the hasher buffers partial blocks across awkward chunk splits", () => {
    const payload: Uint8Array = makePayload(300);
    const expected: string = cryptoHex(payload);
    const sizes: readonly number[] = [1, 55, 56, 63, 64, 65];
    for (let index: number = 0; index < sizes.length; index += 1) {
        const size: number = sizes[index];
        const hasher: ByteHasher = createSha256();
        for (let offset: number = 0; offset < payload.length; offset += size) {
            hasher.update(payload.subarray(offset, offset + size));
        }
        assert.equal(hex(hasher.digest()), expected);
    }
    assert.equal(hex(sha256Bytes(payload)), expected);
});

test("1 MiB fed in three uneven chunks equals node:crypto", () => {
    const payload: Uint8Array = makePayload(1024 * 1024);
    const hasher: ByteHasher = createSha256();
    hasher.update(payload.subarray(0, 1000));
    hasher.update(payload.subarray(1000, 500_000));
    hasher.update(payload.subarray(500_000));
    assert.equal(hex(hasher.digest()), cryptoHex(payload));
});

test("a sha256 hasher refuses a second digest and a late update", () => {
    const hasher: ByteHasher = createSha256();
    hasher.update(utf8("abc"));
    assert.equal(hex(hasher.digest()), cryptoHex(utf8("abc")));
    assert.throws(() => hasher.digest(), FingerprintError);
    assert.throws(() => hasher.update(utf8("x")), FingerprintError);
});

test("strict UTF-8 hashing equals sha256Hex for ASCII, CJK, emoji and 10 KB", () => {
    const samples: readonly string[] = ["abc", "漢字とかな", "👩‍👩‍👧‍👦", "x".repeat(10_000)];
    for (let index: number = 0; index < samples.length; index += 1) {
        const sample: string = samples[index];
        assert.equal(hex(sha256Bytes(utf8(sample))), sha256Hex(sample));
    }
});

test("string fingerprints reject lone surrogates instead of hashing U+FFFD", () => {
    assert.throws(() => fingerprintString("\uD800"), NormalizationRejected);
    assert.throws(() => fingerprintString("\uDC00"), NormalizationRejected);
    assert.throws(() => fingerprintString("a\uD800b"), NormalizationRejected);
    assert.equal(fingerprintString("\uFFFD").ref.bytes, 3);
});

test("text fingerprints reject lone surrogates under both policies", () => {
    assert.throws(() => fingerprintText("ok\uD800"), NormalizationRejected);
    assert.throws(() => fingerprintText("ok\uD800", { policy: "raw" }), NormalizationRejected);
    assert.throws(() => fingerprintText("ok\uDC00"), NormalizationRejected);
});

test("text policy rejects U+0000 and strips exactly one leading BOM", () => {
    assert.throws(() => fingerprintText("a\u0000b"), NormalizationRejected);
    assert.equal(fingerprintText("\uFEFFa").digest, fingerprintText("a").digest);
    assert.notEqual(fingerprintText("\uFEFF\uFEFFa").digest, fingerprintText("a").digest);
    assert.notEqual(fingerprintText("a\uFEFFb").digest, fingerprintText("ab").digest);
});

test("numbers reject -0, NaN and infinities", () => {
    assert.throws(() => fingerprintNumber(-0), NormalizationRejected);
    assert.throws(() => fingerprintNumber(Number.NaN), NormalizationRejected);
    assert.throws(() => fingerprintNumber(Number.POSITIVE_INFINITY), NormalizationRejected);
    assert.throws(() => fingerprintNumber(Number.NEGATIVE_INFINITY), NormalizationRejected);
    assert.equal(fingerprintNumber(0).digest, fingerprintNumber(0).digest);
    assert.notEqual(fingerprintNumber(0).digest, fingerprintNumber(1).digest);
});

test("number/integer rejects values outside the safe integer range", () => {
    assert.throws(() => fingerprintNumber(1.5, { policy: "integer" }), NormalizationRejected);
    assert.throws(() => fingerprintNumber(2 ** 60, { policy: "integer" }), NormalizationRejected);
    assert.throws(() => fingerprintNumber(-0, { policy: "integer" }), NormalizationRejected);
    assert.equal(fingerprintNumber(42, { policy: "integer" }).ref.policy, Policy.numberInteger);
    assert.notEqual(fingerprintNumber(42).digest, fingerprintNumber(42, { policy: "integer" }).digest);
});

test("json rejects -0 unless the caller declares as-zero", () => {
    assert.throws(() => fingerprintJson({ a: -0 }), NormalizationRejected);
    assert.throws(() => fingerprintJson([-0]), NormalizationRejected);
    assert.equal(fingerprintJson({ a: -0 }, { negativeZero: "as-zero" }).digest, fingerprintJson({ a: 0 }).digest);
    assert.equal(fingerprintJson(-0, { negativeZero: "as-zero" }).digest, fingerprintJson(0).digest);
});

test("text NFC folds canonical equivalents and CRLF", () => {
    assert.equal(fingerprintText("\u00e9").digest, fingerprintText("e\u0301").digest);
    assert.equal(fingerprintText("a\r\nb").digest, fingerprintText("a\nb").digest);
    assert.equal(fingerprintText("a\rb").digest, fingerprintText("a\nb").digest);
    assert.notEqual(fingerprintText("\u00e9").digest, fingerprintString("\u00e9").digest);
});

test("raw text policy preserves every code unit", () => {
    assert.notEqual(fingerprintText("\u00e9", { policy: "raw" }).digest, fingerprintText("e\u0301", { policy: "raw" }).digest);
    assert.notEqual(fingerprintText("a\r\nb", { policy: "raw" }).digest, fingerprintText("a\nb", { policy: "raw" }).digest);
    assert.equal(fingerprintText("a\r\nb", { policy: "raw" }).digest, fingerprintText("a\r\nb", { policy: "raw" }).digest);
});

test("the same octets under different kinds and policies never share a digest", () => {
    const payload: Uint8Array = utf8("abc");
    const fromBytes: Fingerprint = fingerprintBytes(payload);
    const fromString: Fingerprint = fingerprintString("abc");
    const fromText: Fingerprint = fingerprintText("abc", { policy: "raw" });
    assert.equal(fromBytes.ref.bytes, 3);
    assert.equal(fromBytes.ref.kind, "bytes");
    assert.equal(fromBytes.ref.policy, Policy.bytesRaw);
    assert.equal(fromBytes.digest, `sha256:${fromBytes.ref.digest}`);
    assert.notEqual(fromBytes.ref.digest, fromString.ref.digest);
    assert.notEqual(fromBytes.ref.digest, fromText.ref.digest);
    assert.notEqual(fromString.ref.digest, fromText.ref.digest);
});

test("fingerprintOf dispatches on the runtime shape", () => {
    assert.deepEqual(fingerprintOf("abc").ref, fingerprintString("abc").ref);
    assert.deepEqual(fingerprintOf(1).ref, fingerprintNumber(1).ref);
    assert.deepEqual(fingerprintOf(true).ref, fingerprintBoolean(true).ref);
    assert.deepEqual(fingerprintOf(null).ref, fingerprintNull().ref);
    assert.deepEqual(fingerprintOf(utf8("bin")).ref, fingerprintBytes(utf8("bin")).ref);
    assert.deepEqual(fingerprintOf({ a: 1 }).ref, fingerprintJson({ a: 1 }).ref);
    assert.notEqual(fingerprintOf(1).digest, fingerprintOf("1").digest);
});

test("json sorts members by UTF-16 code units and keeps array order", () => {
    assert.equal(fingerprintJson({ b: 1, a: 2 }).digest, fingerprintJson({ a: 2, b: 1 }).digest);
    assert.equal(fingerprintJson({ z: { y: 1, x: [3, 2, 1] } }).digest, fingerprintJson({ z: { x: [3, 2, 1], y: 1 } }).digest);
    assert.notEqual(fingerprintJson([1, 2]).digest, fingerprintJson([2, 1]).digest);
});

test("json rejects cycles", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assert.throws(() => fingerprintJson(cycle), NormalizationRejected);
});

test("json rejects sparse arrays", () => {
    const sparse: unknown[] = [];
    sparse[2] = "x";
    assert.throws(() => fingerprintJson(sparse), NormalizationRejected);
});

test("json rejects NaN and infinities", () => {
    assert.throws(() => fingerprintJson(Number.NaN), NormalizationRejected);
    assert.throws(() => fingerprintJson({ a: Number.POSITIVE_INFINITY }), NormalizationRejected);
});

test("json rejects non-plain objects such as Date", () => {
    assert.throws(() => fingerprintJson(new Date(0)), NormalizationRejected);
    assert.throws(() => fingerprintJson(new Map()), NormalizationRejected);
});

test("json rejects accessor properties", () => {
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "value", { get: () => 1, enumerable: true });
    assert.throws(() => fingerprintJson(accessor), NormalizationRejected);
});

test("json rejects bigint, function, symbol and undefined", () => {
    assert.throws(() => fingerprintJson(1n), NormalizationRejected);
    assert.throws(() => fingerprintJson(() => 1), NormalizationRejected);
    assert.throws(() => fingerprintJson(Symbol("s")), NormalizationRejected);
    assert.throws(() => fingerprintJson(undefined), NormalizationRejected);
});

test("json accepts a deeply nested plain value and stays deterministic", () => {
    const value: Record<string, unknown> = { a: { b: { c: [1, "x", true, null, { d: 2 }] } } };
    const first: Fingerprint = fingerprintJson(value);
    const second: Fingerprint = fingerprintJson({ a: { b: { c: [1, "x", true, null, { d: 2 }] } } });
    assert.equal(first.digest, second.digest);
    assert.equal(first.ref.policy, Policy.jsonJcs);
    assert.ok(first.ref.bytes > 0);
});

test("formatShort and parseShort round-trip", () => {
    const fingerprint: Fingerprint = fingerprintBytes(utf8("abc"));
    const short: string = formatShort(fingerprint.ref);
    assert.equal(short, fingerprint.digest);
    assert.deepEqual(parseShort(short), { algorithm: "sha256", digest: fingerprint.ref.digest });
});

test("parseShort rejects uppercase, unknown algorithms and wrong lengths", () => {
    const fingerprint: Fingerprint = fingerprintBytes(utf8("abc"));
    const digest: string = fingerprint.ref.digest;
    assert.equal(parseShort(`SHA256:${digest}`), (void 0));
    assert.equal(parseShort(`sha256:${digest.toUpperCase()}`), (void 0));
    assert.equal(parseShort(`sha256:${digest.slice(1)}`), (void 0));
    assert.equal(parseShort(`sha256:${digest}0`), (void 0));
    assert.equal(parseShort(`nope:${digest}`), (void 0));
    assert.equal(parseShort(digest), (void 0));
});

test("formatRef and parseRef round-trip the full reference", () => {
    const fingerprint: Fingerprint = fingerprintJson({ a: [1, "\u00e9"] });
    const text: string = formatRef(fingerprint.ref);
    assert.ok(text.startsWith("ampfp1:sha256:json:json%2Fjcs:"));
    assert.deepEqual(parseRef(text), fingerprint.ref);
    const plain: string = `ampfp1:sha256:json:json/jcs:${fingerprint.ref.bytes}:${fingerprint.ref.digest}`;
    assert.deepEqual(parseRef(plain), fingerprint.ref);
});

test("parseRef rejects malformed references", () => {
    const fingerprint: Fingerprint = fingerprintBytes(utf8("x"));
    const digest: string = fingerprint.ref.digest;
    assert.equal(parseRef("not-a-ref"), (void 0));
    assert.equal(parseRef(`ampfp1:sha256:bytes:bytes%2Fraw:1:${digest.toUpperCase()}`), (void 0));
    assert.equal(parseRef(`ampfp1:sha256:nope:bytes%2Fraw:1:${digest}`), (void 0));
    assert.equal(parseRef(`ampfp1:sha256:bytes:nope:1:${digest}`), (void 0));
    assert.equal(parseRef(`ampfp1:sha256:bytes:bytes%2Fraw:01:${digest}`), (void 0));
    assert.equal(parseRef(`sha256:bytes:bytes%2Fraw:1:${digest}`), (void 0));
});

test("matches refuses equal hex under a different policy, kind or algorithm", () => {
    const base: FingerprintRef = fingerprintBytes(utf8("abc")).ref;
    const flipped: string = base.digest.startsWith("0") ? `1${base.digest.slice(1)}` : `0${base.digest.slice(1)}`;
    assert.equal(matches(base, { ...base }), true);
    assert.equal(matches(base, { ...base, policy: Policy.textRaw }), false);
    assert.equal(matches(base, { ...base, kind: "text" }), false);
    assert.equal(matches(base, { ...base, algorithm: "sha512" }), false);
    assert.equal(matches(base, { ...base, digest: flipped }), false);
});

test("verify throws on kind and bytes mismatches even with an equal digest", () => {
    const base: FingerprintRef = fingerprintBytes(utf8("abc")).ref;
    assert.doesNotThrow(() => verify(base, { ...base }));
    assert.throws(() => verify(base, { ...base, kind: "text" }), FingerprintMismatch);
    assert.throws(() => verify(base, { ...base, bytes: base.bytes + 1 }), FingerprintMismatch);
});

test("verify names both references in the mismatch message", () => {
    const base: FingerprintRef = fingerprintBytes(utf8("abc")).ref;
    try {
        verify(base, { ...base, kind: "text" });
        assert.fail("verify should have thrown");
    } catch (error: unknown) {
        assert.ok(error instanceof FingerprintMismatch);
        assert.ok(error.message.includes(base.digest));
        assert.ok(error.message.includes("kind differs"));
    }
});

test("preimage builders refuse kinds and policies outside the frozen sets", () => {
    assert.throws(() => assertKind("bogus"), UnsupportedKind);
    assert.throws(() => createPayloadHasher("sha256", "text", "text/raw\nbytes", 0), FingerprintError);
    assert.throws(() => createPayloadHasher("sha256", "text", "bogus/policy", 0), FingerprintError);
});

await testAsync("file fingerprints are chunk-boundary independent and report size", async () => {
    const one: FileFingerprint = await fingerprintFile(FileFixturePath, { chunkBytes: 1 });
    const seven: FileFingerprint = await fingerprintFile(FileFixturePath, { chunkBytes: 7 });
    const whole: FileFingerprint = await fingerprintFile(FileFixturePath, { chunkBytes: 1024 * 1024 });
    assert.equal(one.size, 5000);
    assert.equal(one.ref.bytes, 5000);
    assert.equal(one.ref.kind, "file");
    assert.equal(one.ref.policy, Policy.fileBytes);
    assert.equal(one.digest, seven.digest);
    assert.equal(one.digest, whole.digest);
});

await testAsync("a 0x80 file and a 0x81 file get different fingerprints", async () => {
    const low: FileFingerprint = await fingerprintFile(Byte80Path);
    const high: FileFingerprint = await fingerprintFile(Byte81Path);
    assert.equal(low.ref.bytes, 1);
    assert.equal(high.ref.bytes, 1);
    assert.notEqual(low.digest, high.digest);
});

await testAsync("text-mode files normalise NFC and CRLF and reject invalid UTF-8", async () => {
    const crlf: FileFingerprint = await fingerprintFile(TextCrlfPath, { mode: "text" });
    const nfc: FileFingerprint = await fingerprintFile(TextNfcPath, { mode: "text" });
    assert.equal(crlf.digest, nfc.digest);
    assert.equal(crlf.ref.policy, Policy.fileText);
    assert.equal(crlf.size, 6);
    await assert.rejects(() => fingerprintFile(InvalidUtf8Path, { mode: "text" }), NormalizationRejected);
});

await testAsync("text mode strips exactly one leading BOM from a file", async () => {
    const withBom: FileFingerprint = await fingerprintFile(BomPath, { mode: "text" });
    const plain: FileFingerprint = await fingerprintFile(PlainPath, { mode: "text" });
    assert.equal(withBom.digest, plain.digest);
    assert.notEqual(withBom.ref.bytes, withBom.size);
});

await testAsync("file metadata fingerprints carry the weak file/meta policy", async () => {
    const first: Fingerprint = await fingerprintFileMeta(PlainPath);
    const second: Fingerprint = await fingerprintFileMeta(PlainPath);
    assert.equal(first.ref.kind, "file");
    assert.equal(first.ref.policy, "file/meta");
    assert.equal(first.digest, second.digest);
    assert.notEqual(first.digest, (await fingerprintFile(PlainPath)).digest);
});

await testAsync("file fingerprints reject directories", async () => {
    await assert.rejects(() => fingerprintFile(fixturePath("file-directory")), FingerprintIOError);
});

await testAsync("tree root follows the canonical leaf and root formula", async () => {
    const tree: TreeFingerprint = await fingerprintTree(FormulaDirectory);
    const filePath: string = fixturePath("tree-formula/a.txt");
    const mode: number = (lstatSync(filePath).mode & 0o111) !== 0 ? 2 : 1;
    const childDigest: Buffer = createHash("sha256").update(Buffer.from(utf8("hi"))).digest();
    const pathBytes: Buffer = Buffer.from("a.txt", "utf8");
    const leafInput: Buffer = Buffer.concat([Buffer.from([0x00]), u32be(pathBytes.length), pathBytes, u32be(mode), u64be(2n), childDigest]);
    const leaf: Buffer = createHash("sha256").update(leafInput).digest();
    const policyDigest: Buffer = createHash("sha256").update(Buffer.from(Policy.treeV1, "utf8")).digest();
    const expectedRoot: string = createHash("sha256").update(Buffer.concat([Buffer.from([0x02]), u64be(1n), leaf, policyDigest])).digest("hex");
    assert.equal(tree.root, expectedRoot);
    assert.equal(tree.ref.digest, expectedRoot);
    assert.equal(tree.digest, `sha256:${expectedRoot}`);
    assert.equal(tree.entries.length, 1);
    assert.equal(tree.entries[0].path, "a.txt");
    assert.equal(tree.entries[0].size, 2);
    assert.equal(tree.entries[0].mode, mode);
    assert.equal(tree.entries[0].digest, childDigest.toString("hex"));
    assert.equal(tree.ref.bytes, 49 + pathBytes.length);
});

await testAsync("the empty tree hashes entryCount 0, sha256(empty) and the policy", async () => {
    const tree: TreeFingerprint = await fingerprintTree(fixturePath("tree-empty"));
    const policyDigest: Buffer = createHash("sha256").update(Buffer.from(Policy.treeV1, "utf8")).digest();
    const emptyDigest: Buffer = createHash("sha256").digest();
    const expectedRoot: string = createHash("sha256")
        .update(Buffer.concat([Buffer.from([0x02]), u64be(0n), emptyDigest, policyDigest]))
        .digest("hex");
    assert.equal(tree.entries.length, 0);
    assert.equal(tree.ref.bytes, 0);
    assert.equal(tree.root, expectedRoot);
});

await testAsync("mode is part of the leaf: a file and a directory at the same path differ", async () => {
    const fileTree: TreeFingerprint = await fingerprintTree(fixturePath("tree-mode-file"));
    const dirTree: TreeFingerprint = await fingerprintTree(fixturePath("tree-mode-dir"));
    assert.equal(fileTree.entries.length, 1);
    assert.equal(dirTree.entries.length, 1);
    assert.equal(fileTree.entries[0].path, "x");
    assert.equal(dirTree.entries[0].path, "x");
    assert.equal(fileTree.entries[0].mode, 1);
    assert.equal(dirTree.entries[0].mode, 3);
    assert.equal(fileTree.entries[0].size, dirTree.entries[0].size);
    assert.equal(fileTree.entries[0].digest, dirTree.entries[0].digest);
    assert.notEqual(fileTree.root, dirTree.root);
});

await testAsync("adding and removing a file changes the root and restores it", async () => {
    const directory: string = fixturePath("tree-change");
    const before: TreeFingerprint = await fingerprintTree(directory);
    const addedPath: string = writeFixture("tree-change/added.txt", utf8("new"));
    const added: TreeFingerprint = await fingerprintTree(directory);
    assert.notEqual(before.root, added.root);
    rmSync(addedPath);
    const restored: TreeFingerprint = await fingerprintTree(directory);
    assert.equal(restored.root, before.root);
});

await testAsync("re-running a tree fingerprint is stable", async () => {
    const first: TreeFingerprint = await fingerprintTree(fixturePath("tree-sorted"));
    const second: TreeFingerprint = await fingerprintTree(fixturePath("tree-sorted"));
    assert.equal(first.root, second.root);
    assert.deepEqual(first.entries, second.entries);
});

await testAsync("default exclusions are skipped and reported", async () => {
    const tree: TreeFingerprint = await fingerprintTree(fixturePath("tree-exclude"));
    assert.deepEqual(tree.entries.map((entry) => entry.path), ["keep.txt"]);
    assert.ok(tree.excluded.includes("node_modules"));
    assert.equal(tree.excluded.includes("keep.txt"), false);
});

await testAsync("a custom exclusion set replaces the defaults", async () => {
    const tree: TreeFingerprint = await fingerprintTree(fixturePath("tree-custom-exclude"), { exclude: ["skip.txt"] });
    assert.deepEqual(tree.entries.map((entry) => entry.path), ["keep.txt", "node_modules", "node_modules/dep.txt"]);
    assert.deepEqual(tree.excluded, ["skip.txt"]);
});

await testAsync("entries are sorted by UTF-8 bytes, not locale or UTF-16 order", async () => {
    const sorted: TreeFingerprint = await fingerprintTree(fixturePath("tree-sorted"));
    assert.deepEqual(sorted.entries.map((entry) => entry.path), ["a", "a.txt", "a/b.txt", "b.txt"]);
    const ordered: TreeFingerprint = await fingerprintTree(fixturePath("tree-order"));
    assert.deepEqual(ordered.entries.map((entry) => entry.path), ["\uE000.txt", "\u{1F600}.txt"]);
});

await testAsync("tree fingerprints reject a file root", async () => {
    await assert.rejects(() => fingerprintTree(PlainPath), FingerprintIOError);
});

try {
    rmSync(TempRoot, { recursive: true, force: true });
} catch (error: unknown) {
    console.error(`cleanup failed: ${describeError(error)}`);
}

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
