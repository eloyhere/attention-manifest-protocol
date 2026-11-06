import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryFileStorage, fileDigest } from "../core.ts";
import { createFileOutline, type FileOutline, type LazyOutlineNode, type OutlineCurrentVersion, type OutlineNode } from "../outline.ts";
import { isRange } from "../range.ts";
import { createDefaultLanguageRegistry } from "./builtins.ts";
import { parser } from "./swift.ts";

function outlineOf(path: string, source: string): { outline: FileOutline; version: OutlineCurrentVersion } {
    const stored = new InMemoryFileStorage().put({ tenantId: "t", rootId: "r", path }, source);
    const version: OutlineCurrentVersion = { tenantId: "t", rootId: "r", path, contentHash: stored.hash, version: stored.version };
    return { outline: createFileOutline(stored, source), version };
}

function only(outline: FileOutline, name: string): OutlineNode {
    const matches = outline.entries().filter(node => node.name === name);
    assert.equal(matches.length, 1, `expected exactly one node named ${name}`);
    return matches[0]!;
}

test("Swift types, members and nested functions nest by containment", () => {
    const source = `public final class Service {
    @MainActor
    public static func shared() -> Service {
        return Service()
    }

    public init() {
        start()
    }

    deinit {
        stop()
    }

    private(set) var cache: [String: Int] = [:]
    lazy var worker: Worker = Worker()

    public func start() {
        let local = 1
        func helper() {
            cache["x"] = local
        }
        helper()
    }

    public func transform<T>(_ value: T) async throws -> T where T: Equatable {
        return value
    }

    @available(iOS 13, *)
    @MainActor
    public func modern() {}

    subscript(index: Int) -> Int {
        return cache["\\(index)"] ?? 0
    }
}

struct Point {
    var x: Int
    var y: Int

    mutating func move() {
        x += 1
    }
}

enum Direction {
    func flipped() -> Direction {
        return .south
    }
}

protocol Drawable {
    func draw()
}

extension Point: Drawable {
    func draw() {}
}

actor Counter {
    var value = 0

    func increment() {
        value += 1
    }
}
`;
    const { outline } = outlineOf("Model.swift", source);
    const service = only(outline, "Service");
    for (const name of ["shared", "init", "deinit", "cache", "worker", "start", "transform", "modern", "subscript"]) {
        assert.equal(only(outline, name).parentId, service.id, name);
    }
    const start = only(outline, "start");
    assert.equal(only(outline, "local").parentId, start.id);
    assert.equal(only(outline, "helper").parentId, start.id);

    const move = only(outline, "move");
    const points = outline.entries().filter(node => node.name === "Point");
    assert.equal(points.length, 2);
    const point = points.find(node => node.childIds.includes(move.id));
    assert.ok(point);
    assert.equal(move.parentId, point.id);

    const direction = only(outline, "Direction");
    assert.equal(only(outline, "flipped").parentId, direction.id);
    assert.equal(only(outline, "x").parentId, point.id);
    assert.equal(only(outline, "y").parentId, point.id);

    const drawable = only(outline, "Drawable");
    const draws = outline.entries().filter(node => node.name === "draw");
    assert.equal(draws.length, 2);
    const protocolDraw = draws.find(node => node.parentId === drawable.id);
    assert.ok(protocolDraw);
    const extensionDraw = draws.find(node => node.parentId !== drawable.id);
    assert.ok(extensionDraw);
    const extensionParent = outline.lookup(extensionDraw.parentId ?? "").get();
    assert.equal(extensionParent.name, "Point");
    assert.notEqual(extensionParent.id, point.id);

    const counter = only(outline, "Counter");
    assert.equal(only(outline, "value").parentId, counter.id);
    assert.equal(only(outline, "increment").parentId, counter.id);
});

test("Swift imports, type aliases and stored declarations are outline entries", () => {
    const source = `import Foundation
import struct Foundation.Date
@testable import MyModule

public typealias Handler = (Int) -> Void

let globalValue = 1
var globalFlag = false
`;
    const { outline } = outlineOf("Globals.swift", source);
    assert.equal(outline.find("Foundation").get().range.startLine, 0);
    assert.equal(outline.find("Foundation").get().range.endLine, 1);
    assert.equal(outline.find("Foundation.Date").isPresent(), true);
    assert.equal(outline.find("MyModule").isPresent(), true);
    assert.equal(outline.find("Handler").isPresent(), true);
    assert.equal(outline.find("globalValue").isPresent(), true);
    assert.equal(outline.find("globalFlag").isPresent(), true);
});

test("Swift comments and strings do not produce pseudo declarations", () => {
    const source = `// class Fake {}
/* /* nested */ class Fake2 {} */
let text = "struct Fake3 {}"
let block = """
func fakeMultiline() {}
class Fake4 {}
"""
let after = 1
`;
    const { outline } = outlineOf("Noise.swift", source);
    for (const name of ["Fake", "Fake2", "Fake3", "fakeMultiline", "Fake4"]) {
        assert.equal(outline.find(name).isEmpty(), true, name);
    }
    assert.equal(outline.find("text").isPresent(), true);
    assert.equal(outline.find("block").isPresent(), true);
    assert.equal(outline.find("after").isPresent(), true);
});

test("Swift string interpolation does not produce pseudo declarations", () => {
    const source = `let value = 1
let message = "\\(value) class NotReal {}"
let nested = "\\(pick("struct NotReal2 {}"))"
`;
    const { outline } = outlineOf("Interpolation.swift", source);
    assert.equal(outline.find("value").isPresent(), true);
    assert.equal(outline.find("message").isPresent(), true);
    assert.equal(outline.find("nested").isPresent(), true);
    assert.equal(outline.find("NotReal").isEmpty(), true);
    assert.equal(outline.find("NotReal2").isEmpty(), true);
});

test("Swift backticked identifiers lose their backticks and may use keywords", () => {
    const source = `struct Keyword {
    func \`default\`() {
        let \`class\` = 1
    }
    var \`switch\`: Int = 0
}
`;
    const { outline } = outlineOf("Keywords.swift", source);
    const keyword = only(outline, "Keyword");
    assert.equal(only(outline, "default").parentId, keyword.id);
    assert.equal(only(outline, "class").parentId, only(outline, "default").id);
    assert.equal(only(outline, "switch").parentId, keyword.id);
});

test("Swift ranges cover bodies and parents contain descendants", () => {
    const source = "struct Widget {\n    func run() {\n        let inner = 1\n        print(inner)\n    }\n}\n";
    const { outline, version } = outlineOf("Widget.swift", source);
    const widget = only(outline, "Widget");
    const run = only(outline, "run");
    const inner = only(outline, "inner");
    assert.equal(widget.range.startLine, 0);
    assert.equal(widget.range.endLine, 6);
    assert.equal(run.range.startLine, 1);
    assert.equal(run.range.endLine, 5);
    assert.ok(run.range.startByte > 0);
    assert.ok(widget.range.startLine <= run.range.startLine && widget.range.endLine >= run.range.endLine);
    assert.ok(widget.range.startByte <= run.range.startByte && widget.range.endByte >= run.range.endByte);
    assert.ok(run.range.startLine <= inner.range.startLine && run.range.endLine >= inner.range.endLine);
    assert.equal(outline.locate(0, version).get().name, "Widget");
    assert.equal(outline.locate(2, version).get().name, "inner");
    assert.equal(outline.locate(3, version).get().name, "run");
    assert.equal(outline.locate(4, version).get().name, "run");

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

test("Swift registers with the default registry and resolves .swift files", () => {
    const registry = createDefaultLanguageRegistry();
    assert.ok(registry.list().length >= 24, "Swift must be part of every default registry");
    assert.equal(registry.find("swift").isPresent(), true);
    const resolved = registry.resolve("Sources/App.swift").get();
    assert.equal(resolved.language.id, "swift");
    assert.equal(resolved.extension, ".swift");
    assert.equal(resolved.confidence, "exact");
    assert.equal(registry.resolve("A.swift", "text/x-swift").get().language.id, "swift");
    assert.equal(registry.load("swift").get().language, "swift");

    const { outline } = outlineOf("A.swift", "struct S {\n    func f() {}\n}\n");
    assert.equal(outline.language, "swift");
    assert.equal(outline.find("S").isPresent(), true);
    assert.equal(outline.find("f").isPresent(), true);
    assert.throws(() => createFileOutline({ tenantId: "t", rootId: "r", path: "a.docx",
        contentHash: fileDigest("x"), version: 1 }, "x"), /no outline parser/);
});

test("Swift parser rejects non-string source", () => {
    assert.throws(() => parser.parse(null as unknown as string), TypeError);
    assert.throws(() => parser.parse(42 as unknown as string), TypeError);
});
