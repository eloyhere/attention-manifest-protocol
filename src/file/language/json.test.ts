import assert from "node:assert/strict";
import test from "node:test";
import { SourceText } from "../range.ts";
import { LanguageRegistry } from "./registry.ts";
import { definition, parser } from "./json.ts";

function duplicates(values: readonly string[]): readonly string[] {
    return values.filter((value, index) => values.indexOf(value) !== index);
}

function assertSyntaxError(source: string, pattern: RegExp = /\d+:\d+/): void {
    assert.throws(() => parser.parse(source), (error: unknown) => {
        assert.ok(error instanceof SyntaxError, `expected SyntaxError for ${JSON.stringify(source)}`);
        assert.match(error.message, pattern);
        return true;
    });
}

test("JSON nested objects and arrays produce property and element nodes", () => {
    const source = '{"a":{"b":[1,{"c":true}]}}';
    const nodes = parser.parse(source);
    assert.deepEqual(nodes.map(node => node.name), ["a", "b", "[0]", "[1]", "c"]);
    const a = nodes[0]!;
    const b = nodes[1]!;
    const first = nodes[2]!;
    const second = nodes[3]!;
    const c = nodes[4]!;

    for (const node of nodes) assert.equal(node.kind, "symbol");
    assert.equal("parentId" in a, false);
    assert.equal(a.parentId, undefined);
    assert.equal(b.parentId, a.id);
    assert.equal(first.parentId, b.id);
    assert.equal(second.parentId, b.id);
    assert.equal(c.parentId, second.id);

    assert.equal(a.summary, "object (1 keys)");
    assert.equal(b.summary, "array (2 items)");
    assert.equal(first.summary, "number 1");
    assert.equal(second.summary, "object (1 keys)");
    assert.equal(c.summary, "boolean true");

    assert.equal(a.id, "json:$.a:1");
    assert.equal(b.id, "json:$.a.b:6");
    assert.equal(first.id, "json:$.a.b[0]:11");
    assert.equal(second.id, "json:$.a.b[1]:13");
    assert.equal(c.id, "json:$.a.b[1].c:14");

    for (const parent of [a, b, second]) {
        for (const child of nodes) {
            if (child.parentId !== parent.id) continue;
            assert.ok(parent.range.startLine <= child.range.startLine, parent.id);
            assert.ok(parent.range.endLine >= child.range.endLine, parent.id);
            assert.ok(parent.range.startByte <= child.range.startByte, parent.id);
            assert.ok(parent.range.endByte >= child.range.endByte, parent.id);
        }
    }
    assert.equal(a.range.startByte, 1);
    assert.equal(a.range.endByte, Buffer.byteLength(source.slice(0, source.length - 1)));
    assert.equal(b.range.startByte, 6);
    assert.equal(c.range.endByte, source.indexOf("true") + 4);
});

test("JSON top-level arrays label elements with zero-based indexes", () => {
    const source = '[{"x":1},2]';
    const nodes = parser.parse(source);
    assert.deepEqual(nodes.map(node => node.name), ["[0]", "x", "[1]"]);
    const first = nodes[0]!;
    const property = nodes[1]!;
    const second = nodes[2]!;

    assert.equal("parentId" in first, false);
    assert.equal("parentId" in second, false);
    assert.equal(property.parentId, first.id);
    assert.equal(first.summary, "object (1 keys)");
    assert.equal(property.summary, "number 1");
    assert.equal(second.summary, "number 2");
    assert.equal(first.id, "json:$[0]:1");
    assert.equal(property.id, "json:$[0].x:2");
    assert.equal(second.id, "json:$[1]:9");

    assert.ok(first.range.endByte >= property.range.endByte);
    assert.equal(second.range.startByte, 9);
    assert.equal(second.range.endByte, 10);

    const nested = parser.parse("[[1],[2,[3]]]");
    assert.deepEqual(nested.map(node => node.name), ["[0]", "[0]", "[1]", "[0]", "[1]", "[0]"]);
    assert.equal(nested[1]!.parentId, nested[0]!.id);
    assert.equal(nested[0]!.summary, "array (1 items)");
});

test("JSON escaped object keys decode and id segments are percent-encoded", () => {
    const source = String.raw`{"a\"b":1,"\u4e2d\u6587":2}`;
    const nodes = parser.parse(source);
    assert.deepEqual(nodes.map(node => node.name), ["a\"b", "中文"]);
    const escaped = nodes[0]!;
    const chinese = nodes[1]!;

    assert.equal(escaped.id, `json:$.${encodeURIComponent("a\"b")}:1`);
    assert.equal(escaped.id, "json:$.a%22b:1");
    assert.equal(chinese.id, `json:$.${encodeURIComponent("中文")}:${source.indexOf(String.raw`"\u4e2d\u6587`)}`);
    assert.equal(chinese.id, "json:$.%E4%B8%AD%E6%96%87:10");
    assert.equal(escaped.summary, "number 1");
    assert.equal(chinese.summary, "number 2");

    const newline = parser.parse(String.raw`{"line\nbreak":"a\tb"}`);
    assert.deepEqual(newline.map(node => node.name), ["line\nbreak"]);
    assert.equal(newline[0]!.summary, `string "a\\tb" (3 chars)`);

    // A lone surrogate is legal JSON text and must not make path encoding throw.
    const lone = parser.parse(String.raw`{"\ud800":1}`);
    assert.equal(lone.length, 1);
    assert.equal(lone[0]!.name, "\ud800");
    assert.equal(lone[0]!.id.startsWith("json:$."), true);
});

test("JSONC comments and trailing commas are tolerated but never read inside strings", () => {
    const source = `{
  // line comment with "quotes" and /*
  "url": "http://example.com//path",
  /* block comment with {"fake": true} */
  "note": "/* not a comment */",
  "list": [1, 2,],
  "flag": true,
}`;
    const nodes = parser.parse(source);
    assert.deepEqual(nodes.map(node => node.name), ["url", "note", "list", "[0]", "[1]", "flag"]);
    const url = nodes[0]!;
    const note = nodes[1]!;
    const list = nodes[2]!;
    assert.equal(url.summary, `string "http://example.com//path" (24 chars)`);
    assert.equal(note.summary, `string "/* not a comment */" (19 chars)`);
    assert.equal(list.summary, "array (2 items)");
    assert.equal(nodes[3]!.summary, "number 1");
    assert.equal(nodes[4]!.summary, "number 2");
    assert.equal(nodes[5]!.summary, "boolean true");

    assert.doesNotThrow(() => parser.parse('{"a":1,}'));
    assert.doesNotThrow(() => parser.parse("[1,]"));
    assert.doesNotThrow(() => parser.parse('{"a":[1,2,],}'));
    assert.doesNotThrow(() => parser.parse("// leading\n{\"a\":1} // trailing"));

    const spaced = parser.parse('{ /*a*/ "k" /*b*/ : /*c*/ [ /*d*/ 1 /*e*/, /*f*/ 2 /*g*/ ] /*h*/ }');
    assert.deepEqual(spaced.map(node => node.name), ["k", "[0]", "[1]"]);
});

test("JSON property ranges cover key through value with UTF-8 byte offsets", () => {
    const source = `{
  "emoji": "😀",
  "中文": {"inner": "值"}
}`;
    const text = new SourceText(source);
    const nodes = parser.parse(source);
    const emoji = nodes[0]!;
    const chinese = nodes[1]!;
    const inner = nodes[2]!;

    const emojiKeyStart = source.indexOf("\"emoji\"");
    const emojiValueEnd = source.indexOf('",', emojiKeyStart) + 1;
    assert.equal(emoji.range.startLine, 1);
    assert.equal(emoji.range.endLine, 2);
    assert.equal(emoji.range.startByte, Buffer.byteLength(source.slice(0, emojiKeyStart)));
    assert.equal(emoji.range.startByte, text.byteAt(emojiKeyStart));
    assert.equal(emoji.range.endByte, Buffer.byteLength(source.slice(0, emojiValueEnd)));
    assert.equal(emoji.range.endByte, text.byteAt(emojiValueEnd));
    assert.equal(emoji.range.endByte - emoji.range.startByte, Buffer.byteLength(source.slice(emojiKeyStart, emojiValueEnd)));
    assert.equal(Buffer.byteLength("😀"), 4);

    assert.equal(chinese.parentId, undefined);
    assert.equal(inner.parentId, chinese.id);
    assert.ok(chinese.range.startLine <= inner.range.startLine && chinese.range.endLine >= inner.range.endLine);
    assert.ok(chinese.range.startByte <= inner.range.startByte && chinese.range.endByte >= inner.range.endByte);
    assert.equal(inner.summary, `string "值" (1 chars)`);
    assert.equal(chinese.range.endByte - inner.range.endByte > 0, true);
});

test("JSON structural errors throw SyntaxError with 1-based line and column", () => {
    assertSyntaxError('{"a":}');
    assertSyntaxError("[1,,]");
    assertSyntaxError('{"a":1,,"b":2}');
    assertSyntaxError('{"a"');
    assertSyntaxError('{"a":"x}');
    assertSyntaxError('{"a":1} /*');
    assertSyntaxError("/*");
    assertSyntaxError("{} {}");
    assertSyntaxError("[] 1");
    assertSyntaxError('{"a":1]');
    assertSyntaxError('{"a" 1}');
    assertSyntaxError('{"a", 1}');
    assertSyntaxError("[1 2]");
    assertSyntaxError("[");
    assertSyntaxError("{");
    assertSyntaxError("{'a':1}");
    assertSyntaxError("{a:1}");
    assertSyntaxError('{"a":01}');
    assertSyntaxError('{"a":1.}');
    assertSyntaxError('{"a":+1}');
    assertSyntaxError('{"a":tru}');
    assertSyntaxError("");
    assertSyntaxError("   \n\t ");
    assertSyntaxError("// comment only\n/* block */");
    assertSyntaxError('{\n  "a":\n}', /3:1/);
    assertSyntaxError('{\n  "a": "待续\n}', /2:11/);
    // Skipped regions (depth, array and node budgets) are still validated.
    assertSyntaxError("[[[[[[[[1,,]]]]]]]]");
    assertSyntaxError("[[[[[[[[1]");
    assertSyntaxError(String.raw`[[[[[[[["x]]]]]]]]`);
});

test("JSON parser rejects non-string sources with TypeError", () => {
    assert.throws(() => parser.parse(null as unknown as string), TypeError);
    assert.throws(() => parser.parse(undefined as unknown as string), TypeError);
    assert.throws(() => parser.parse(42 as unknown as string), TypeError);
});

test("JSON scalar summaries keep number text and never evaluate values", () => {
    const nodes = parser.parse('{"s":"hello","n":-1.5e+10,"nan":NaN,"inf":Infinity,"ninf":-Infinity,"f":false,"z":null}');
    assert.deepEqual(nodes.map(node => node.summary), [
        `string "hello" (5 chars)`, "number -1.5e+10", "number NaN", "number Infinity",
        "number -Infinity", "boolean false", "null",
    ]);
});

test("JSON string previews stop at 60 characters without splitting surrogate pairs", () => {
    const exact = "a".repeat(60);
    const exactNodes = parser.parse(`{"s":${JSON.stringify(exact)}}`);
    assert.equal(exactNodes[0]!.summary, `string ${JSON.stringify(exact)} (60 chars)`);
    assert.equal(exactNodes[0]!.summary.includes("…"), false);

    const longValue = "a".repeat(59) + "😀" + "た".repeat(10);
    const longNodes = parser.parse(`{"s":${JSON.stringify(longValue)}}`);
    const summary = longNodes[0]!.summary;
    assert.equal(summary.endsWith("(70 chars)"), true);
    assert.equal(summary.includes("…"), true);
    const quoted = summary.slice(summary.indexOf("\""), summary.lastIndexOf("\"") + 1);
    const preview = JSON.parse(quoted) as string;
    assert.equal([...preview].length, 61);
    assert.equal(preview, "a".repeat(59) + "😀" + "…");

    const split = parser.parse(`{"s":${JSON.stringify("a".repeat(60) + "😀")}}`);
    assert.equal(split[0]!.summary.includes("😀"), false);
    assert.equal(split[0]!.summary.includes("\\ud83d"), false);
});

test("JSON depth budget stops at six container levels and marks truncation", () => {
    const nested = (depth: number): string => {
        let value = "1";
        for (let level = depth; level >= 1; level -= 1) value = `{"l${level}":${value}}`;
        return value;
    };
    const nodes = parser.parse(nested(8));
    assert.deepEqual(nodes.map(node => node.name), ["l1", "l2", "l3", "l4", "l5", "l6"]);
    for (const node of nodes.slice(0, -1)) assert.equal(node.summary, "object (1 keys)");
    assert.equal(nodes.at(-1)!.summary, "object (1 keys) (truncated)");
    assert.equal(nodes.at(-1)!.name, "l6");

    const deepArray = parser.parse("[[[[[[[[1]]]]]]]]");
    assert.equal(deepArray.length, 6);
    assert.deepEqual(deepArray.map(node => node.name), ["[0]", "[0]", "[0]", "[0]", "[0]", "[0]"]);
    assert.equal(deepArray.at(-1)!.summary, "array (1 items) (truncated)");
});

test("JSON node budget caps output at 2000 nodes", () => {
    const members = Array.from({ length: 3000 }, (_, index) => `"k${index}":${index}`).join(",");
    const nodes = parser.parse(`{${members}}`);
    assert.equal(nodes.length, 2000);
    assert.equal(nodes[0]!.name, "k0");
    assert.equal(nodes.at(-1)!.name, "k1999");
    assert.deepEqual(duplicates(nodes.map(node => node.id)), []);
    assert.ok(Object.isFrozen(nodes));
});

test("JSON array budget expands at most 50 elements per array and marks truncation", () => {
    const items = Array.from({ length: 100 }, (_, index) => String(index)).join(",");
    const nodes = parser.parse(`{"items":[${items}]}`);
    assert.equal(nodes[0]!.summary, "array (100 items) (truncated)");
    const elements = nodes.filter(node => node.name.startsWith("["));
    assert.equal(elements.length, 50);
    assert.equal(elements[0]!.name, "[0]");
    assert.equal(elements.at(-1)!.name, "[49]");
    assert.equal(nodes.length, 51);

    const root = parser.parse(`[${items}]`);
    assert.equal(root.length, 50);
    assert.equal(root[0]!.name, "[0]");
    assert.equal(root.at(-1)!.name, "[49]");

    const fifty = Array.from({ length: 50 }, (_, index) => String(index)).join(",");
    const exact = parser.parse(`{"items":[${fifty}]}`);
    assert.equal(exact[0]!.summary, "array (50 items)");
    assert.equal(exact.length, 51);
});

test("JSON output is frozen and duplicate keys keep unique stable ids", () => {
    const source = '{"a":1,"a":2}';
    const nodes = parser.parse(source);
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0]!.name, "a");
    assert.equal(nodes[1]!.name, "a");
    assert.equal(nodes[0]!.id, "json:$.a:1");
    assert.equal(nodes[1]!.id, "json:$.a:7");
    assert.deepEqual(duplicates(nodes.map(node => node.id)), []);
    assert.deepEqual(parser.parse(source).map(node => node.id), nodes.map(node => node.id));

    assert.ok(Object.isFrozen(nodes));
    for (const node of nodes) {
        assert.ok(Object.isFrozen(node));
        assert.ok(Object.isFrozen(node.range));
        assert.equal(node.kind, "symbol");
    }

    assert.deepEqual(parser.parse("42"), []);
    assert.deepEqual(parser.parse("null"), []);
    assert.deepEqual(parser.parse("{}"), []);
    assert.deepEqual(parser.parse("[]"), []);
    assert.deepEqual(parser.parse("\uFEFF{}"), []);
    assert.ok(Object.isFrozen(parser.parse("42")));
});

test("JSON definition registers with a fresh language registry", () => {
    assert.equal(definition.id, "json");
    assert.equal(definition.displayName, "JSON");
    assert.equal(definition.support, "outline");
    assert.deepEqual([...definition.extensions],
        [".json", ".jsonc", ".json5", ".geojson", ".topojson", ".webmanifest", ".har"]);
    assert.deepEqual([...definition.mimeTypes],
        ["application/json", "application/ld+json", "application/manifest+json", "application/geo+json"]);
    assert.deepEqual(duplicates(definition.extensions), []);
    assert.deepEqual(duplicates(definition.mimeTypes), []);
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.extensions));
    assert.ok(Object.isFrozen(definition.mimeTypes));
    assert.ok(Object.isFrozen(definition.parser));

    const registry = new LanguageRegistry({ definitions: [definition] });
    const match = registry.resolve("a.json");
    assert.equal(match.isPresent(), true);
    assert.equal(match.get().language.id, "json");
    assert.equal(match.get().extension, ".json");
    assert.equal(match.get().confidence, "exact");
    for (const path of ["x.geojson", "x.topojson", "manifest.webmanifest", "trace.har", "tsconfig.jsonc", "x.json5"]) {
        assert.equal(registry.resolve(path).get().language.id, "json", path);
    }
    assert.equal(registry.resolve("data.bin", "application/geo+json").get().language.id, "json");
    assert.equal(registry.resolve("a.json", "application/json").get().language.id, "json");
    assert.equal(registry.load("json").get().language, "json");
    assert.deepEqual(registry.load("json").get().parse('{"a":1}').map(node => node.name), ["a"]);

    const parsed = registry.parse("a.json", '{"a":{"b":[1,{"c":true}]}}');
    assert.equal(parsed.isPresent(), true);
    assert.deepEqual(parsed.get().nodes.map(node => node.name), ["a", "b", "[0]", "[1]", "c"]);
});
