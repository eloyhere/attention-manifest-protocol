import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryFileStorage, fileDigest } from "../core.ts";
import { createFileOutline } from "../outline.ts";
import { createDefaultLanguageRegistry } from "./builtins.ts";
import type { LazyOutlineNode, OutlineCurrentVersion } from "../outline.ts";
import { isRange } from "../range.ts";

function outlineOf(path: string, source: string) {
    const stored = new InMemoryFileStorage().put({ tenantId: "t", rootId: "r", path }, source);
    const version: OutlineCurrentVersion = { tenantId: "t", rootId: "r", path, contentHash: stored.hash, version: stored.version };
    const outline = createFileOutline(stored, source);
    return { outline, version };
}

test("markdown headings nest, ignore fenced code, and section ranges span children", () => {
    const source = "# Root\n\ntext\n\n```md\n# Not a heading\n```\n## Child\n### Deep\n## Second\n";
    const { outline, version } = outlineOf("guide.md", source);
    const root = outline.find("Root").get();
    const expanded = outline.expand(root.id, version).map(node => node.name);
    assert.deepEqual(expanded, ["Root", "Child", "Deep", "Second"]);
    assert.equal(outline.find("Not a heading").isEmpty(), true);
    assert.equal(outline.find("Child").get().parentId, root.id);
    assert.equal(outline.find("Deep").get().parentId, outline.find("Child").get().id);
    assert.equal(root.range.startLine, 0);
    assert.equal(root.range.endLine, source.split("\n").length);
    assert.equal(root.dirty, false);
});

test("plain text yields one entry per paragraph", () => {
    const { outline } = outlineOf("notes.txt", "alpha\nbeta\n\ngamma\n\n  \n");
    assert.equal(outline.find("alpha").isPresent(), true);
    assert.equal(outline.find("gamma").isPresent(), true);
    assert.equal(outline.find("alpha").get().range.startLine, 0);
    assert.equal(outline.find("alpha").get().range.endLine, 2);
    assert.equal(outline.find("gamma").get().range.startLine, 3);
});

test("TeX sections skip commented commands and nest by level", () => {
    const { outline } = outlineOf("paper.tex", "% \\section{fake}\n\\section{Real}\n\\subsection{Sub}\n");
    assert.equal(outline.find("fake").isEmpty(), true);
    assert.equal(outline.find("Real").isPresent(), true);
    assert.equal(outline.find("Sub").get().parentId, outline.find("Real").get().id);
});

test("JavaScript and TypeScript read declarations but not comments or strings", () => {
    const source = "// function fake() {}\nconst text = \"class Fake {}\";\nexport function real(a) {\n    return a;\n}\nclass Widget {\n    run() { return 1; }\n}\n";
    const { outline } = outlineOf("app.js", source);
    assert.equal(outline.find("text").isPresent(), true);
    assert.equal(outline.find("real").isPresent(), true);
    assert.equal(outline.find("Widget").isPresent(), true);
    assert.equal(outline.find("run").get().parentId, outline.find("Widget").get().id);
    assert.equal(outline.find("fake").isEmpty(), true);
    assert.equal(outline.find("Fake").isEmpty(), true);

    const typed = outlineOf("app.ts", "import { read } from \"node:fs\";\nexport interface Shape { width: number }\nexport type Kind = \"a\" | \"b\";\nenum Color { Red }\nnamespace Inner {\n    export const x = 1;\n}\n").outline;
    assert.equal(typed.find("node:fs").isPresent(), true);
    for (const name of ["Shape", "Kind", "Color", "Inner"]) assert.equal(typed.find(name).isPresent(), true, name);
});

test("C, C++, Java and C# expose types, namespaces and functions", () => {
    const c = outlineOf("a.c", "#define MAX 10\nstruct Point { int x; };\n// int fake(void) {}\nint add(int a, int b) { return a + b; }\n").outline;
    assert.equal(c.find("MAX").isPresent(), true);
    assert.equal(c.find("Point").isPresent(), true);
    assert.equal(c.find("add").isPresent(), true);
    assert.equal(c.find("fake").isEmpty(), true);

    const cpp = outlineOf("a.cpp", "namespace demo {\nclass Widget {\npublic:\n    void run() { }\n};\n}\n").outline;
    assert.equal(cpp.find("demo").isPresent(), true);
    assert.equal(cpp.find("Widget").isPresent(), true);
    assert.equal(cpp.find("run").get().parentId, cpp.find("Widget").get().id);

    const java = outlineOf("A.java", "package demo.app;\npublic class Widget {\n    public void run() { }\n}\n").outline;
    assert.equal(java.find("demo.app").isPresent(), true);
    assert.equal(java.find("Widget").isPresent(), true);
    assert.equal(java.find("run").isPresent(), true);

    const csharp = outlineOf("A.cs", "namespace Demo {\n    public class Widget {\n        public void Run() { }\n    }\n}\n").outline;
    assert.equal(csharp.find("Demo").isPresent(), true);
    assert.equal(csharp.find("Widget").isPresent(), true);
    assert.equal(csharp.find("Run").isPresent(), true);
});

test("Python functions and classes nest by indentation and ignore comments and strings", () => {
    const source = "# def fake():\npayload = \"\"\"\ndef hidden():\n    pass\n\"\"\"\ndef outer():\n    x = 1\n    def inner():\n        return x\n    return inner\nclass Thing:\n    pass\n";
    const { outline } = outlineOf("app.py", source);
    assert.equal(outline.find("outer").isPresent(), true);
    assert.equal(outline.find("inner").get().parentId, outline.find("outer").get().id);
    assert.equal(outline.find("Thing").isPresent(), true);
    assert.equal(outline.find("fake").isEmpty(), true);
    assert.equal(outline.find("hidden").isEmpty(), true);
});

test("SQL statements resolve dialect quoted identifiers and skip comments and strings", () => {
    const source = "-- CREATE TABLE fake (x int);\nCREATE TABLE real (id int);\nCREATE VIEW v AS SELECT 'CREATE TABLE nope' AS x;\nCREATE PROCEDURE p AS BEGIN SELECT 1; END;\nALTER TABLE `quoted name` ADD COLUMN c int;\n";
    for (const path of ["a.sql", "a.mysql", "a.pls"]) {
        const { outline } = outlineOf(path, source);
        assert.equal(outline.find("real").isPresent(), true, path);
        assert.equal(outline.find("v").isPresent(), true, path);
        assert.equal(outline.find("p").isPresent(), true, path);
        assert.equal(outline.find("quoted name").isPresent(), true, path);
        assert.equal(outline.find("fake").isEmpty(), true, path);
        assert.equal(outline.find("nope").isEmpty(), true, path);
    }
});

test("HTML nests elements, honours quoted attributes and ignores raw text and comments", () => {
    const source = "<main id=\"app\">\n  <!-- <fake></fake> -->\n  <section class=\"one\">\n    <img src=\"x>y\">\n    <span>中文</span>\n  </section>\n</main>\n";
    const { outline } = outlineOf("index.html", source);
    const main = outline.find("main#app").get();
    const section = outline.find("section.one").get();
    assert.equal(section.parentId, main.id);
    assert.equal(outline.find("fake").isEmpty(), true);
    assert.equal(outline.find("span").isEmpty(), true);
    const script = outlineOf("raw.html", "<div id=\"a\"><script>const x = \"<div id='fake'>\";</script></div>").outline;
    assert.equal(script.find("fake").isEmpty(), true);
    assert.equal(script.find("div#a").isPresent(), true);
});

test("Vue exposes block structure plus template, script and style entries", () => {
    const source = "<template>\n  <main id=\"app\"><span>x</span></main>\n</template>\n<script setup lang=\"ts\">\nconst value: number = 1;\nfunction read() { return value; }\n</script>\n<style scoped>\n.card { color: red; }\n</style>\n";
    const { outline } = outlineOf("App.vue", source);
    assert.equal(outline.find("template").isPresent(), true);
    assert.equal(outline.find("script setup").isPresent(), true);
    assert.equal(outline.find("style").isPresent(), true);
    assert.equal(outline.find("main#app").get().parentId, outline.find("template").get().id);
    assert.equal(outline.find("value").get().parentId, outline.find("script setup").get().id);
    assert.equal(outline.find("read").isPresent(), true);
    assert.equal(outline.find(".card").get().parentId, outline.find("style").get().id);
});

test("CSS, SCSS and Sass expose selectors, at-rules, variables and nested blocks", () => {
    const css = outlineOf("a.css", "/* comment */\n.card {\n  color: red;\n}\n@media (min-width: 10px) {\n  .inner { color: blue; }\n}\n").outline;
    assert.equal(css.find(".card").isPresent(), true);
    assert.equal(css.find(".inner").isPresent(), true);
    assert.equal(css.find("@media (min-width: 10px)").isPresent(), true);
    assert.equal(css.find("color").isEmpty(), true);

    const scss = outlineOf("a.scss", "$tone: red;\n@mixin theme($x) { color: $x; }\n.panel {\n  @include theme($tone);\n  .child { width: 2px; }\n}\n").outline;
    assert.equal(scss.find("$tone").isPresent(), true);
    assert.equal(scss.find("@mixin theme").isPresent(), true);
    assert.equal(scss.find(".child").get().parentId, scss.find(".panel").get().id);
    assert.equal(scss.find("@include theme($tone)").isPresent(), true);

    const sass = outlineOf("a.sass", "$tone: red\n.card\n  color: $tone\n  .label\n    content: \"中文\"\n").outline;
    assert.equal(sass.find("$tone").isPresent(), true);
    assert.equal(sass.find(".card").isPresent(), true);
    assert.equal(sass.find(".label").get().parentId, sass.find(".card").get().id);
    assert.equal(sass.find("content").get().parentId, sass.find(".label").get().id);
});

test("every lazy node carries a valid range and parents contain children", () => {
    const source = "# Root\n\n## Child\n\ntext\n";
    const { outline, version } = outlineOf("a.md", source);
    const lineCount = source.split("\n").length;
    const byteLength = Buffer.byteLength(source, "utf8");
    const visit = (node: LazyOutlineNode): void => {
        assert.equal(isRange(node.range), true, node.id);
        assert.ok(node.range.startLine >= 0 && node.range.endLine <= lineCount, node.id);
        assert.ok(node.range.startByte >= 0 && node.range.endByte <= byteLength, node.id);
        for (const child of node.children) {
            visit(child);
            assert.ok(node.range.startLine <= child.range.startLine && node.range.endLine >= child.range.endLine, child.id);
            assert.ok(node.range.startByte <= child.range.startByte && node.range.endByte >= child.range.endByte, child.id);
        }
    };
    visit(outline.lazyTree(() => version));
});

test("binary office formats register without pretending to produce a text outline", () => {
    const registry = createDefaultLanguageRegistry();
    assert.equal(registry.list().length, 32);
    assert.equal(registry.find("word").get().support, "document");
    assert.equal(registry.load("word").isEmpty(), true);
    assert.equal(registry.find("excel").get().support, "tabular");
    assert.equal(registry.load("excel").isEmpty(), true);
    assert.throws(() => createFileOutline({ tenantId: "t", rootId: "r", path: "a.docx", contentHash: fileDigest("x"), version: 1 }, "x"), /no outline parser/);
});
