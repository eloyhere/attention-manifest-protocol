import assert from "node:assert/strict";
import test from "node:test";
import { Optional, SynchronousOrderedMap } from "semantic-typescript";
import { LanguageRegistry } from "./registry.ts";
import type { LanguageDefinition } from "./types.ts";
import type { OutlineParserPort, ParsedOutlineNode } from "../outline.ts";

const node: ParsedOutlineNode = { id: "n1", kind: "symbol", name: "item", summary: "item", range: { startLine: 0, endLine: 1, startByte: 0, endByte: 4 } };
const parser: OutlineParserPort = { language: "js", parse: () => [node] };
const textParser: OutlineParserPort = { language: "plain", parse: source => source.split("\n").map((line, index) => ({ id: `line:${index}`, kind: "symbol", name: line, summary: line, range: { startLine: index, endLine: index + 1, startByte: index * 4, endByte: index * 4 + 3 } })) };
const def = (id: string, extensions: string[], mimeTypes: string[], support: LanguageDefinition["support"] = "outline", extras: Partial<LanguageDefinition> = {}): LanguageDefinition => ({ id, displayName: id, extensions, mimeTypes, support, ...extras });

test("find returns Optional and list is an isolated snapshot", () => {
    const registry = new LanguageRegistry({ definitions: [def("js", [".js", ".mjs"], ["text/javascript"], "outline", { parser })] });
    assert.ok(registry.find("js") instanceof Optional);
    assert.equal(registry.find("missing").isEmpty(), true);
    const list = registry.list();
    assert.equal(Object.isFrozen(list), true);
    assert.equal(Object.isFrozen(list[0]?.extensions), true);
    assert.throws(() => (list as LanguageDefinition[]).pop());
});

test("validates identifiers, names, extensions and MIME types", () => {
    const registry = new LanguageRegistry();
    for (const candidate of [def(" ", [".x"], []), { ...def("x", [".x"], []), displayName: " " }, def("x", ["x"], []), def("x", [".x"], ["bad"])]) assert.throws(() => registry.register(candidate));
});

test("registerMany validates atomically and detects duplicate IDs", () => {
    const registry = new LanguageRegistry();
    assert.throws(() => registry.registerMany([def("a", [".a"], []), def("b", [".a"], [])]), /extension conflict/);
    assert.equal(registry.list().length, 0);
    assert.throws(() => registry.registerMany([def("a", [], []), def("a", [], [])]), /id/);
});

test("rejects duplicate MIME mappings", () => {
    const registry = new LanguageRegistry({ definitions: [def("a", [], ["Text/Plain"])] });
    assert.throws(() => registry.register(def("b", [], ["text/plain"])), /MIME conflict/);
});

test("allows multiple extensions per language and normalizes lookup", () => {
    const registry = new LanguageRegistry({ definitions: [def("js", [".JS", ".mjs"], ["text/javascript"])] });
    assert.equal(registry.findByExtension("MJS").get().id, "js");
    assert.equal(registry.resolve("folder\\APP.Js").get().language.id, "js");
});

test("path matching uses the longest registered suffix in the final segment", () => {
    const registry = new LanguageRegistry({ definitions: [def("ts", [".ts"], []), def("dts", [".d.ts"], [])] });
    assert.equal(registry.resolve("dir.ts/file").isEmpty(), true);
    assert.equal(registry.resolve("types.d.ts").get().language.id, "dts");
    assert.equal(registry.findByExtension(".d.ts").get().id, "dts");
});

test("MIME match wins without a conflicting recognized extension", () => {
    const registry = new LanguageRegistry({ definitions: [def("a", [".a"], ["text/a"]), def("b", [".b"], ["text/b"])] });
    assert.equal(registry.resolve("unknown", " TEXT/A ").get().language.id, "a");
    assert.equal(registry.resolve("file.a", "text/b").isEmpty(), true);
});

test("rejects invalid and empty paths", () => {
    const registry = new LanguageRegistry();
    for (const path of ["", "  ", "/", "dir/", "../", "bad\0name"]) assert.equal(registry.resolve(path).isEmpty(), true);
});

test("fallback is restricted to text or unsupported definitions", () => {
    const registry = new LanguageRegistry({ definitions: [def("fallback", [], [], "text")], fallbackId: "fallback" });
    assert.equal(registry.resolve("unknown.bin").get().confidence, "fallback");
    assert.equal(new LanguageRegistry({ definitions: [def("fallback", [], [], "document")], fallbackId: "fallback" }).resolve("unknown").isEmpty(), true);
});

test("unregister is permanent for an ID and advances epoch", () => {
    const registry = new LanguageRegistry({ definitions: [def("a", [".a"], [])] });
    const epoch = registry.version;
    assert.equal(registry.unregister("a"), true);
    assert.equal(registry.version, epoch + 1);
    assert.equal(registry.unregister("a"), false);
    assert.throws(() => registry.register(def("a", [".a"], [])), /already used/);
    assert.equal(registry.register(def("b", [".a"], [])).id, "b");
});

test("lazy parser is invoked once and cached after successful load", () => {
    let calls = 0;
    const registry = new LanguageRegistry({ definitions: [def("js", [".js"], [], "outline", { loadParser: () => { calls += 1; return parser; } })] });
    const loaded = registry.load("js").get();
    assert.notEqual(loaded, parser);
    assert.equal(loaded.language, "js");
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(registry.load("js").get(), loaded);
    assert.equal(calls, 1);
});

test("failed lazy parser load is retried", () => {
    let calls = 0;
    const registry = new LanguageRegistry({ definitions: [def("js", [".js"], [], "outline", { loadParser: () => { calls += 1; if (calls === 1) throw new Error("transient"); return parser; } })] });
    assert.throws(() => registry.load("js"), /transient/);
    assert.equal(registry.load("js").get().language, "js");
    assert.equal(calls, 2);
});

test("recursive or unregistering loaders cannot poison parser cache", () => {
    let registry: LanguageRegistry;
    let calls = 0;
    registry = new LanguageRegistry({ definitions: [def("js", [".js"], [], "outline", { loadParser: () => {
        calls += 1;
        assert.equal(registry.load("js").isEmpty(), true);
        registry.unregister("js");
        return parser;
    } })] });
    assert.equal(registry.load("js").isEmpty(), true);
    assert.equal(registry.load("js").isEmpty(), true);
    assert.equal(calls, 1);
});

test("load has Optional and throwing variants", () => {
    const registry = new LanguageRegistry({ definitions: [def("text", [".txt"], [], "text")] });
    assert.equal(registry.load("text").isEmpty(), true);
    assert.throws(() => registry.requireParser("text"), /no outline parser/);
});

test("parse returns isolated nodes and only for outline languages", () => {
    const registry = new LanguageRegistry({ definitions: [def("js", [".js"], [], "outline", { parser })] });
    const result = registry.parse("a.js", "source").get();
    assert.equal(result.nodes[0]?.id, "n1");
    assert.equal(Object.isFrozen(result.nodes), true);
    assert.throws(() => (result.nodes as ParsedOutlineNode[]).pop());
    assert.equal(registry.parse("a.txt", "source").isEmpty(), true);
    const secondResult = registry.parse("a.js", "source").get();
    assert.notEqual(secondResult.nodes[0], result.nodes[0]);
    assert.deepEqual(secondResult.nodes[0], result.nodes[0]);
});

test("text support may project lines as symbols but unsupported kinds remain rejected", () => {
    const registry = new LanguageRegistry({ definitions: [def("plain", [".txt"], [], "text", { loadParser: () => textParser })] });
    assert.equal(registry.parse("file.txt", "one\ntwo").get().nodes.length, 2);
    assert.throws(() => new LanguageRegistry({ definitions: [def("both", [], [], "outline", { parser, loadParser: () => parser })] }));
});

test("validates parser language, nodes, parents, cycles, and source ranges", () => {
    const invalids: readonly ParsedOutlineNode[][] = [
        [{ ...node, id: "" }],
        [{ ...node, kind: "file" as "symbol" }],
        [node, node],
        [{ ...node, parentId: "missing" }],
        [{ ...node, parentId: "n1" }],
        [{ ...node, range: { startLine: 0, endLine: 9, startByte: 0, endByte: 4 } }],
        [{ ...node, range: { startLine: 0, endLine: 1, startByte: 0, endByte: 99 } }],
        [{ ...node, range: { startLine: 1, endLine: 0, startByte: 0, endByte: 4 } }],
    ];
    for (const output of invalids) {
        const invalidParser: OutlineParserPort = { language: "js", parse: () => output };
        const registry = new LanguageRegistry({ definitions: [def("js", [".js"], [], "outline", { parser: invalidParser })] });
        assert.throws(() => registry.parse("file.js", "line"));
    }
    const mismatch: OutlineParserPort = { language: "other", parse: () => [] };
    assert.throws(() => new LanguageRegistry({ definitions: [def("js", [".js"], [], "outline", { parser: mismatch })] }));
});

test("registry snapshots preserve epoch and definitions across mutation", () => {
    const registry = new LanguageRegistry({ definitions: [def("a", [".a"], [])] });
    const snapshot = registry.snapshot();
    registry.register(def("b", [".b"], []));
    assert.equal(snapshot.epoch + 1, registry.version);
    assert.equal(snapshot.definitions.length, 1);
});

test("uses semantic ordered storage for deterministic listing", () => {
    const map = new SynchronousOrderedMap<string, string>();
    map.put("first", "1");
    const registry = new LanguageRegistry({ definitions: [def("first", [], []), def("second", [], [])] });
    assert.deepEqual(registry.list().map(item => item.id), ["first", "second"]);
    assert.equal(map.get("first").get(), "1");
});
