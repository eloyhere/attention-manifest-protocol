import assert from "node:assert/strict";
import test from "node:test";
import type { ParsedOutlineNode } from "../outline.ts";
import { isRange } from "../range.ts";
import { definition, parser } from "./go.ts";
import { LanguageRegistry } from "./registry.ts";
import { parser as texParser } from "./tex.ts";

function parse(source: string): readonly ParsedOutlineNode[] {
    return parser.parse(source);
}

function node(nodes: readonly ParsedOutlineNode[], name: string): ParsedOutlineNode {
    const matches = nodes.filter(candidate => candidate.name === name);
    assert.equal(matches.length, 1, `expected exactly one node named ${name}`);
    return matches[0]!;
}

function absent(nodes: readonly ParsedOutlineNode[], name: string): void {
    assert.equal(nodes.some(candidate => candidate.name === name), false, `unexpected node named ${name}`);
}

test("Go package clauses and import paths are outline entries", () => {
    const source = [
        "package main",
        "",
        'import "fmt"',
        "import (",
        '    "os"',
        '    alias "net/http"',
        '    _ "embed"',
        ")",
        "",
        "func run() {",
        "    fmt.Println(os.Args)",
        "}",
        "",
    ].join("\n");
    const nodes = parse(source);
    const packageNode = node(nodes, "main");
    assert.equal(packageNode.kind, "symbol");
    assert.equal(packageNode.summary, "symbol main");
    assert.equal(packageNode.range.startLine, 0);
    assert.equal(packageNode.range.endLine, 1);
    for (const path of ["fmt", "os", "net/http", "embed"]) {
        const imported = node(nodes, path);
        assert.equal(imported.kind, "symbol");
        assert.equal(imported.summary, `symbol ${path}`);
    }
    assert.equal(node(nodes, "os").range.startLine, 4);
    absent(nodes, "alias");
    assert.equal(node(nodes, "run").parentId, undefined);
});

test("Go structs, methods, interfaces and aliases nest by receiver", () => {
    const source = [
        "package demo",
        "",
        "type Server struct {",
        "    addr string",
        "}",
        "",
        "func (s *Server) Start(port int) error {",
        '    s.addr = "up"',
        "    return nil",
        "}",
        "",
        "func (s *Server) Stop() {}",
        "",
        "type Shape interface {",
        "    Area() float64",
        "}",
        "",
        "type Handler = func(string) error",
        "",
        "type Callback func(int) bool",
        "",
    ].join("\n");
    const nodes = parse(source);
    const server = node(nodes, "Server");
    assert.equal(server.kind, "symbol");
    assert.equal(node(nodes, "Start").parentId, server.id);
    assert.equal(node(nodes, "Stop").parentId, server.id);
    absent(nodes, "addr");
    const shape = node(nodes, "Shape");
    assert.equal(shape.parentId, undefined);
    absent(nodes, "Area");
    assert.equal(node(nodes, "Handler").parentId, undefined);
    assert.equal(node(nodes, "Callback").parentId, undefined);
    assert.equal(node(nodes, "Start").range.startLine, 6);
    assert.equal(node(nodes, "Start").range.endLine, 10);
});

test("Go methods attach to a declared receiver type across intervening declarations", () => {
    const source = [
        "package demo",
        "",
        "type Server struct {",
        "    addr string",
        "}",
        "",
        "func NewServer() *Server {",
        "    return &Server{}",
        "}",
        "",
        "func (s *Server) Start() {}",
        "",
        "type Other struct{}",
        "",
        "var defaultServer = NewServer()",
        "",
        "func (s *Server) Stop() {}",
        "",
        "func (g Ghost) Haunt() {}",
        "",
    ].join("\n");
    const nodes = parse(source);
    const server = node(nodes, "Server");
    assert.equal(node(nodes, "Start").parentId, server.id);
    assert.equal(node(nodes, "Stop").parentId, server.id);
    assert.equal(node(nodes, "NewServer").parentId, undefined);
    assert.equal(node(nodes, "Other").parentId, undefined);
    assert.equal(node(nodes, "defaultServer").parentId, undefined);
    assert.equal(node(nodes, "Stop").range.startLine, 16);
    assert.ok(server.range.startLine <= node(nodes, "Stop").range.startLine);
    assert.ok(server.range.endLine >= node(nodes, "Stop").range.endLine);
    assert.equal(node(nodes, "Haunt").parentId, undefined);
    absent(nodes, "Ghost");
});

test("Go generic functions, methods and types keep their declared names", () => {
    const source = [
        "package demo",
        "",
        "func Map[T any](items []T, fn func(T) T) []T {",
        "    return items",
        "}",
        "",
        "type List[T any] struct {",
        "    items []T",
        "}",
        "",
        "func (l *List[T]) Push(value T) {}",
        "",
    ].join("\n");
    const nodes = parse(source);
    const map = node(nodes, "Map");
    assert.equal(map.kind, "symbol");
    const list = node(nodes, "List");
    assert.equal(node(nodes, "Push").parentId, list.id);
});

test("Go comments, strings and raw strings do not produce pseudo declarations", () => {
    const source = [
        "package demo",
        "",
        "// func FakeComment() {}",
        '// import "fake/comment"',
        "/* type FakeBlock struct {",
        "   func FakeNested() {}",
        "} */",
        'var text = "func FakeString() {}"',
        "var raw = `func FakeRaw() {}",
        "type FakeRawType struct{}",
        'import "fake/path"',
        "`",
        "",
        "func real() {}",
        "",
    ].join("\n");
    const nodes = parse(source);
    for (const name of ["FakeComment", "fake/comment", "FakeBlock", "FakeNested", "FakeString", "FakeRaw",
        "FakeRawType", "fake/path"]) absent(nodes, name);
    assert.equal(node(nodes, "text").kind, "symbol");
    assert.equal(node(nodes, "raw").kind, "symbol");
    assert.equal(node(nodes, "real").range.startLine, 13);
});

test("Go const and var declarations cover single lines and grouped blocks", () => {
    const source = [
        "package demo",
        "",
        "const Pi = 3.14",
        "",
        "const (",
        "    StatusOK = 200",
        "    statusBad",
        ")",
        "",
        "var Global = 1",
        "",
        "var (",
        "    count = 1",
        "    label string",
        ")",
        "",
        "func compute() int {",
        "    const local = 2",
        "    var step = 3",
        "    return count + local + step",
        "}",
        "",
    ].join("\n");
    const nodes = parse(source);
    for (const name of ["Pi", "StatusOK", "statusBad", "Global", "count", "label", "local", "step"]) {
        assert.equal(node(nodes, name).kind, "symbol");
    }
    absent(nodes, "200");
    const compute = node(nodes, "compute");
    assert.equal(node(nodes, "local").parentId, compute.id);
    assert.equal(node(nodes, "step").parentId, compute.id);
    assert.equal(node(nodes, "count").parentId, undefined);
    assert.equal(node(nodes, "StatusOK").parentId, undefined);
});

test("Go grouped type declarations expose every spec", () => {
    const source = [
        "package demo",
        "",
        "type (",
        "    Reader struct {",
        "        source string",
        "    }",
        "    Writer interface {",
        "        Write(value string) error",
        "    }",
        "    Alias = Reader",
        ")",
        "",
        "func (r *Reader) Read() string {",
        "    return r.source",
        "}",
        "",
    ].join("\n");
    const nodes = parse(source);
    const reader = node(nodes, "Reader");
    assert.equal(reader.kind, "symbol");
    assert.equal(node(nodes, "Writer").kind, "symbol");
    assert.equal(node(nodes, "Alias").kind, "symbol");
    absent(nodes, "source");
    absent(nodes, "Write");
    assert.equal(node(nodes, "Read").parentId, reader.id);
    assert.ok(reader.range.endLine >= node(nodes, "Read").range.endLine);
});

test("Go ranges cover function bodies and parents contain their methods", () => {
    const source = [
        "package demo",
        "",
        "type Widget struct {",
        "    count int",
        "}",
        "",
        "func (w *Widget) Run() {",
        "    var local = 1",
        "    _ = local",
        "}",
        "",
        "func Free() int {",
        "    return 1",
        "}",
        "",
    ].join("\n");
    const nodes = parse(source);
    const widget = node(nodes, "Widget");
    const run = node(nodes, "Run");
    const local = node(nodes, "local");
    const free = node(nodes, "Free");
    assert.equal(widget.range.startLine, 2);
    assert.equal(widget.range.endLine, 10);
    assert.equal(run.range.startLine, 6);
    assert.equal(run.range.endLine, 10);
    assert.equal(local.range.startLine, 7);
    assert.equal(local.range.endLine, 8);
    assert.equal(run.parentId, widget.id);
    assert.ok(widget.range.startLine <= run.range.startLine && widget.range.endLine >= run.range.endLine);
    assert.ok(widget.range.startByte <= run.range.startByte && widget.range.endByte >= run.range.endByte);
    assert.ok(run.range.startLine <= local.range.startLine && run.range.endLine >= local.range.endLine);
    assert.equal(free.parentId, undefined);
    assert.equal(free.range.startLine, 11);
    assert.equal(free.range.endLine, 14);
    for (const candidate of nodes) assert.equal(isRange(candidate.range), true, candidate.id);
});

test("Go grouped specs and signatures keep their own declaration ranges", () => {
    const source = [
        "package demo",
        "",
        "var (",
        "    first *Thing",
        "    second = map[string]int{",
        '        "a": 1,',
        "    }",
        ")",
        "",
        "func add(a, b int) int",
        "",
        "func long(",
        "    value int,",
        ") error {",
        "    return nil",
        "}",
        "",
    ].join("\n");
    const nodes = parse(source);
    const first = node(nodes, "first");
    const second = node(nodes, "second");
    assert.equal(first.parentId, undefined);
    assert.equal(second.parentId, undefined);
    assert.equal(first.range.startLine, 3);
    assert.equal(first.range.endLine, 4);
    assert.equal(second.range.startLine, 4);
    assert.equal(second.range.endLine, 7);
    absent(nodes, "a");
    assert.equal(node(nodes, "add").range.startLine, 9);
    assert.equal(node(nodes, "add").range.endLine, 10);
    assert.equal(node(nodes, "long").range.startLine, 11);
    assert.equal(node(nodes, "long").range.endLine, 16);
});

test("Go parser handles empty input and rejects non-string source", () => {
    assert.deepEqual(parser.parse(""), []);
    assert.deepEqual(parser.parse("\n\n   \n"), []);
    assert.throws(() => parser.parse(null as unknown as string), TypeError);
    assert.throws(() => parser.parse(42 as unknown as string), TypeError);
});

test("Go definition exposes consistent registry metadata", () => {
    assert.equal(definition.id, "go");
    assert.equal(definition.displayName, "Go");
    assert.equal(definition.support, "outline");
    assert.equal(definition.parser, parser);
    assert.deepEqual([...definition.extensions], [".go"]);
    assert.ok(definition.extensions.length > 0);
    assert.ok(definition.mimeTypes.length > 0);
    assert.equal(definition.extensions.every((value, index) => definition.extensions.indexOf(value) === index), true);
    assert.equal(definition.mimeTypes.every((value, index) => definition.mimeTypes.indexOf(value) === index), true);
    assert.equal(definition.mimeTypes.every(value => /^[^\s;/]+\/[^\s;/]+$/.test(value)), true);
});

test("TeX part and subparagraph levels nest around the existing hierarchy", () => {
    const source = "\\part{A}\n\\chapter{B}\n\\section{C}\n\\subparagraph{D}\n\\part*{E}\n";
    const nodes = texParser.parse(source);
    const part = node(nodes, "A");
    const chapter = node(nodes, "B");
    const section = node(nodes, "C");
    const subparagraph = node(nodes, "D");
    const starred = node(nodes, "E");
    assert.equal(part.kind, "heading");
    assert.equal(chapter.parentId, part.id);
    assert.equal(section.parentId, chapter.id);
    assert.equal(subparagraph.parentId, section.id);
    assert.equal(part.range.startLine, 0);
    assert.equal(part.range.endLine, 4);
    assert.equal(starred.parentId, undefined);
    assert.equal(starred.range.startLine, 4);
});

test("Go registers with a standalone language registry", () => {
    const registry = new LanguageRegistry({ definitions: [definition] });
    const resolved = registry.resolve("main.go").get();
    assert.equal(resolved.language.id, "go");
    assert.equal(resolved.extension, ".go");
    assert.equal(resolved.confidence, "exact");
    assert.equal(registry.resolve("MAIN.GO").get().language.id, "go");
    assert.equal(registry.load("go").get().language, "go");
    assert.equal(registry.resolve("main.txt").isEmpty(), true);

    const source = "package demo\n\ntype T struct {\n    value int\n}\n\nfunc (t T) M() {\n    var local = 1\n    _ = local\n}\n";
    const parsed = registry.parse("main.go", source).get();
    assert.deepEqual(parsed.nodes.map(entry => entry.name), ["demo", "T", "M", "local"]);
    const owner = parsed.nodes.find(entry => entry.name === "T");
    assert.ok(owner);
    assert.equal(parsed.nodes.find(entry => entry.name === "M")?.parentId, owner.id);
    assert.equal(parsed.nodes.find(entry => entry.name === "local")?.parentId, parsed.nodes.find(entry => entry.name === "M")?.id);
});
