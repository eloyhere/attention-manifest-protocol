import assert from "node:assert/strict";
import test from "node:test";
import { fileDigest } from "./core.ts";
import { createFileOutline, createOutlineProvider, markdownHeadingParser, type SourceVersion } from "./outline.ts";

const sourceText = "# Root\n\n```md\n# Not a heading\n```\n## Nested\n### Deep\n## Repeat\n## Repeat\n";
const version: SourceVersion = { tenantId: "tenant-a", rootId: "root-a", path: "docs/guide.md", contentHash: fileDigest(sourceText), version: 4 };

test("Markdown headings form nested sections while fenced hashes are ignored", () => {
    const outline = createFileOutline(version, sourceText);
    const root = outline.find("Root").get();
    const children = outline.expand(root.id, version);
    assert.deepEqual(children.map(node => node.name), ["Root", "Nested", "Deep", "Repeat", "Repeat"]);
    assert.equal(children[0]?.parentId?.startsWith("file:"), true);
    assert.equal(children[1]?.parentId, children[0]?.id);
    assert.equal(children[2]?.parentId, children[1]?.id);
    assert.equal(children.some(node => node.name === "Not a heading"), false);
    assert.notEqual(children[3]?.id, children[4]?.id);
    assert.equal(children.every(node => node.dirty === false), true);
});

test("lookup and find use Optional for missing results", () => {
    const outline = createFileOutline(version, sourceText);
    assert.equal(outline.lookup("missing").isEmpty(), true);
    assert.equal(outline.find("missing").isEmpty(), true);
});

test("ranges use 0-based exclusive lines and UTF-8 exclusive bytes", () => {
    const outline = createFileOutline(version, sourceText);
    const deep = outline.find("Deep").get();
    assert.equal(deep.range.startLine, 6);
    assert.equal(deep.range.endLine, 7);
    assert.equal(outline.locate(6, version).get().id, deep.id);
    assert.equal(outline.locate(7, version).get().name, "Repeat");
    const root = outline.find("Root").get();
    assert.equal(root.range.startLine, 0);
    assert.equal(root.range.endLine, sourceText.split("\n").length);
});

test("byte offsets count UTF-8 bytes rather than code units", () => {
    const source = "# 中文😀\ntext";
    const unicode: SourceVersion = { tenantId: "tenant-a", rootId: "root-a", path: "unicode.md", contentHash: fileDigest(source), version: 1 };
    const outline = createFileOutline(unicode, source);
    const heading = outline.find("中文😀").get();
    const byteLength = Buffer.byteLength(source, "utf8");
    assert.equal(byteLength, 17);
    assert.notEqual(byteLength, source.length);
    assert.equal(heading.range.startByte, 0);
    assert.equal(heading.range.startLine, 0);
    assert.equal(heading.range.endByte, byteLength);
    const paragraphSource = "中文😀\n\ntext";
    const paragraph = createFileOutline({ tenantId: "tenant-a", rootId: "root-a", path: "unicode.txt",
        contentHash: fileDigest(paragraphSource), version: 1 }, paragraphSource).find("中文😀").get();
    assert.equal(paragraph.range.startByte, 0);
    assert.equal(paragraph.range.endByte, 10);
    assert.equal(paragraph.range.endLine, 1);
});

test("dirty tracks an uncommitted buffer or an explicit override", () => {
    assert.equal(createFileOutline(version, sourceText).dirty, false);
    assert.equal(createFileOutline({ ...version, bufferVersion: 5 }, sourceText).dirty, true);
    const forced = createFileOutline(version, sourceText, { dirty: true });
    assert.equal(forced.dirty, true);
    assert.equal(forced.find("Root").get().dirty, true);
});

test("version changes stale an outline and scope changes are rejected", () => {
    const outline = createFileOutline(version, sourceText);
    assert.throws(() => outline.requireCurrent({ ...version, contentHash: "changed" }), /stale/);
    assert.throws(() => outline.requireCurrent({ ...version, tenantId: "tenant-b" }), /scope mismatch/);
    assert.throws(() => outline.expand(outline.find("Root").get().id, { ...version, version: 5 }), /stale/);
});

test("returned nodes and child arrays cannot mutate stored outline", () => {
    const outline = createFileOutline(version, sourceText);
    const root = outline.find("Root").get();
    assert.throws(() => (root.childIds as string[]).push("corrupted"), TypeError);
    const rootAgain = outline.lookup(root.id).get();
    assert.equal(rootAgain.childIds.includes("corrupted"), false);
    const expanded = outline.expand(root.id, version) as readonly { name: string }[];
    const changed = [...expanded] as Array<{ name: string }>;
    changed[0]!.name = "changed";
    assert.equal(outline.find("Root").get().name, "Root");
    assert.throws(() => { (root.range as { startLine: number }).startLine = 3; }, TypeError);
});

test("unknown language needs an injected parser and parser output is validated", () => {
    assert.throws(() => createFileOutline({ ...version, path: "src/code.unknown" }, sourceText), /no outline parser/);
    const custom = { language: "test", parse: () => [{ id: "symbol:one", kind: "symbol" as const, name: "one", summary: "short metadata",
        range: { startLine: 1, endLine: 2, startByte: 0, endByte: 4 } }] };
    const outline = createFileOutline(version, sourceText, { parser: custom });
    assert.equal(outline.language, "test");
    assert.equal(outline.find("one").get().summary, "short metadata");
    const invalid = { language: "test", parse: () => [{ id: "bad", kind: "symbol" as const, name: "bad", summary: "bad",
        range: { startLine: 0, endLine: 1, startByte: 0, endByte: 9999 } }] };
    assert.throws(() => createFileOutline(version, sourceText, { parser: invalid }), /invalid range/);
});

test("outline nodes and provider entries carry the source version hash", () => {
    const outline = createFileOutline(version, sourceText);
    assert.equal(outline.find("Root").get().versionHash, version.contentHash);
    assert.equal(outline.entries().every(node => node.versionHash === version.contentHash), true);
    const entries = createOutlineProvider().entries(version.path, sourceText);
    assert.equal(entries.length > 0, true);
    assert.equal(entries.every(entry => entry.versionHash === version.contentHash), true);
    assert.equal(entries.every(entry => entry.versionHash === fileDigest(sourceText)), true);
});

test("Markdown parser itself preserves heading order and ignores fences", () => {
    assert.deepEqual(markdownHeadingParser.parse("# A\n~~~\n## B\n~~~\n# A").map(node => node.name), ["A", "A"]);
});

test("lazy trees load direct children on access, retain references and protect metadata", () => {
    const outline = createFileOutline(version, sourceText);
    const loaded: string[] = [];
    const root = outline.lazyTree(() => version, { onLoad: id => loaded.push(id) });
    assert.equal(root.kind, "file");
    assert.deepEqual(loaded, []);
    const children = root.children;
    assert.equal(children.length, 1);
    assert.deepEqual(loaded, [root.id]);
    assert.equal(root.children, children);
    assert.equal(root.children[0], children[0]);
    const heading = children[0]!;
    assert.equal(heading.name, "Root");
    assert.deepEqual(loaded, [root.id]);
    const headingChildren = heading.children;
    assert.deepEqual(headingChildren.map(node => node.name), ["Nested", "Repeat", "Repeat"]);
    assert.deepEqual(loaded, [root.id, heading.id]);
    assert.equal(heading.children, headingChildren);
    assert.equal(Object.isFrozen(children), true);
    assert.throws(() => (children as unknown[]).push("corruption"), TypeError);
    assert.throws(() => { (heading.range as { startLine: number }).startLine = 99; }, TypeError);
    assert.throws(() => { (heading.childIds as string[]).push("corruption"); }, TypeError);
    assert.throws(() => { (heading as { name: string }).name = "corruption"; }, /read-only/);
    assert.equal(outline.find("Root").get().name, "Root");
    assert.equal(heading.range.startLine, 0);
    assert.equal(heading.dirty, false);
});

test("lazy cached properties and retained descendants reject changed host versions", () => {
    const outline = createFileOutline(version, sourceText);
    let current = { ...version };
    const root = outline.lazyTree(() => current);
    const children = root.children;
    const heading = children[0]!;
    const serialize = heading.toJSON;
    assert.equal(root.children, children);
    current = { ...version, version: version.version + 1 };
    assert.throws(() => root.children, /stale/);
    assert.throws(() => root.name, /stale/);
    assert.throws(() => heading.summary, /stale/);
    assert.throws(() => serialize(), /stale/);
    assert.throws(() => JSON.stringify(root), /stale/);
    current = { ...version, rootId: "another-root" };
    assert.throws(() => heading.children, /scope mismatch/);
    assert.equal(outline.lookup("missing").isEmpty(), true);
});

test("lazy enumeration and JSON disclose only metadata without reading file bodies", () => {
    const outline = createFileOutline(version, sourceText);
    let bodyReads = 0;
    const host = { ...version, get content(): string { bodyReads += 1; throw new Error("body must not be read"); } };
    const loaded: string[] = [];
    const root = outline.lazyTree(() => host, { onLoad: id => loaded.push(id) });
    assert.equal("children" in root, true);
    assert.equal(Object.keys(root).includes("children"), true);
    assert.equal(Object.getOwnPropertyDescriptor(root, "children")?.get instanceof Function, true);
    assert.deepEqual(loaded, []);
    const json = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
    assert.equal(json.kind, "file");
    assert.equal("children" in json, false);
    assert.equal("toJSON" in json, false);
    assert.equal("content" in json, false);
    assert.deepEqual(loaded, []);
    void root.children[0]?.children;
    assert.equal(bodyReads, 0);
    assert.equal(loaded.length, 2);
    const detached = root.toJSON();
    assert.throws(() => { (detached.range as { startByte: number }).startByte = 200; }, TypeError);
    assert.equal(root.range.startByte, 0);
    assert.equal(outline.lazyNode("missing", () => version).isEmpty(), true);
});
