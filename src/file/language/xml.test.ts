import assert from "node:assert/strict";
import test from "node:test";
import { SourceText } from "../range.ts";
import { LanguageRegistry } from "./registry.ts";
import { definition, parser } from "./xml.ts";

function duplicates(values: readonly string[]): readonly string[] {
    return values.filter((value, index) => values.indexOf(value) !== index);
}

test("XML nested catalog, book, chapter and section nodes nest by containment", () => {
    const source = `<catalog id="root">
  <book name="First">
    <chapter key="c1">
      <section id="s1">Body text</section>
    </chapter>
  </book>
</catalog>
`;
    const nodes = parser.parse(source);
    assert.deepEqual(nodes.map(node => node.name), ["root", "First", "c1", "s1"]);
    const catalog = nodes[0]!;
    const book = nodes[1]!;
    const chapter = nodes[2]!;
    const section = nodes[3]!;

    assert.equal(catalog.parentId, undefined);
    assert.equal("parentId" in catalog, false);
    assert.equal(book.parentId, catalog.id);
    assert.equal(chapter.parentId, book.id);
    assert.equal(section.parentId, chapter.id);

    for (const node of nodes) assert.equal(node.kind, "symbol");
    assert.ok(catalog.range.startLine <= book.range.startLine && catalog.range.endLine >= book.range.endLine);
    assert.ok(book.range.startLine <= chapter.range.startLine && book.range.endLine >= chapter.range.endLine);
    assert.ok(chapter.range.startLine <= section.range.startLine && chapter.range.endLine >= section.range.endLine);
    assert.ok(catalog.range.startByte <= book.range.startByte && catalog.range.endByte >= book.range.endByte);
    assert.ok(chapter.range.startByte <= section.range.startByte && chapter.range.endByte >= section.range.endByte);
});

test("XML namespace prefixes match structural local names and keep qualified names in summaries", () => {
    const source = `<x:Catalog xmlns:x="urn:test">
  <x:Book id="b1">
    <x:Chapter x:id="c1">
      <Section/>
    </x:Chapter>
  </x:Book>
  <y:Item name="other" xmlns:y="urn:other"/>
</x:Catalog>
`;
    const nodes = parser.parse(source);
    assert.deepEqual(nodes.map(node => node.name), ["Catalog", "b1", "Chapter", "Section", "other"]);
    const catalog = nodes[0]!;
    const book = nodes[1]!;
    const chapter = nodes[2]!;
    const section = nodes[3]!;
    const item = nodes[4]!;

    assert.equal(book.parentId, catalog.id);
    assert.equal(chapter.parentId, book.id);
    assert.equal(section.parentId, chapter.id);
    assert.equal(item.parentId, catalog.id);

    assert.ok(catalog.summary.includes("x:Catalog"));
    assert.ok(book.summary.includes("x:Book"));
    assert.ok(book.summary.includes("id=b1"));
    assert.ok(chapter.summary.includes("x:Chapter"));
    assert.ok(section.summary.includes("Section"));
    assert.ok(item.summary.includes("y:Item"));
    assert.ok(item.summary.includes("name=other"));
});

test("XML prolog, comments, CDATA and DOCTYPE internal subsets never produce nodes", () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<?target <book id="pi"/>?>
<!DOCTYPE catalog [
  <!ELEMENT catalog (book*)>
  <!ENTITY example "<book id='entity'>">
  <!ENTITY tricky "a]b > c">
  <!-- ] <book id="dtd-comment"/> -->
]>
<!-- <book id="comment"/> -->
<catalog>
  <![CDATA[<book id="cdata"/>]]>
  <book id="real">Text</book>
</catalog>
`;
    const nodes = parser.parse(source);
    assert.deepEqual(nodes.map(node => node.name), ["catalog", "real"]);
    for (const name of ["pi", "entity", "dtd-comment", "comment", "cdata", "tricky"]) {
        assert.equal(nodes.some(node => node.name === name), false, name);
    }
});

test("XML self-closing tags, quoted attribute values and entity references are parsed", () => {
    const source = `<catalog>
  <book id="a &gt; b" title='He said "hi"' class="c"/>
  <book name="Tom &amp; Jerry"/>
  <book key="x &unknown; y"/>
</catalog>
`;
    const nodes = parser.parse(source);
    assert.deepEqual(nodes.map(node => node.name), ["catalog", "a > b", "Tom & Jerry", "x &unknown; y"]);
    const quoted = nodes[1]!;
    assert.ok(quoted.summary.includes("id=a > b"));
    assert.ok(quoted.summary.includes("class=c"));
    assert.equal(quoted.summary.includes("He said"), false);
    assert.equal(quoted.range.startLine, 1);
    assert.equal(quoted.range.endLine, 2);
    assert.equal(quoted.range.endByte - quoted.range.startByte,
        Buffer.byteLength(`<book id="a &gt; b" title='He said "hi"' class="c"/>`, "utf8"));
});

test("XML structural elements need no identity attribute while ordinary elements only nest", () => {
    const source = `<catalog>
  <span class="wrapper">
    <book id="nested"/>
    <custom>
      <section/>
    </custom>
  </span>
  <section id="top"/>
</catalog>
`;
    const nodes = parser.parse(source);
    assert.deepEqual(nodes.map(node => node.name), ["catalog", "nested", "section", "top"]);
    const catalog = nodes[0]!;
    assert.equal(nodes.length, 4);
    for (const node of nodes.slice(1)) assert.equal(node.parentId, catalog.id);
    assert.equal(nodes.some(node => node.name === "span" || node.name === "custom"), false);
    assert.equal(nodes[2]!.summary, "<section>");
    assert.equal(nodes[3]!.parentId, catalog.id);
});

test("XML ranges use 0-based lines and UTF-8 byte offsets", () => {
    const source = `<catalog id="目录">
  <book name="书">
    <section id="节">正文</section>
  </book>
</catalog>
`;
    const text = new SourceText(source);
    const nodes = parser.parse(source);
    const catalog = nodes[0]!;
    const book = nodes[1]!;
    const section = nodes[2]!;

    assert.equal(catalog.range.startLine, 0);
    assert.equal(book.range.startLine, 1);
    assert.equal(section.range.startLine, 2);
    assert.equal(catalog.range.endLine, 5);
    assert.equal(book.range.endLine, 4);
    assert.equal(section.range.endLine, 3);

    const bookStart = source.indexOf("<book");
    const sectionStart = source.indexOf("<section");
    const sectionEnd = source.indexOf("</section>") + "</section>".length;
    assert.equal(catalog.range.startByte, 0);
    assert.equal(book.range.startByte, Buffer.byteLength(source.slice(0, bookStart), "utf8"));
    assert.equal(book.range.startByte, text.byteAt(bookStart));
    assert.equal(section.range.startByte, text.byteAt(sectionStart));
    assert.equal(section.range.endByte, Buffer.byteLength(source.slice(0, sectionEnd), "utf8"));
    assert.deepEqual(section.range, text.range(sectionStart, sectionEnd));

    assert.ok(catalog.range.startByte <= book.range.startByte && catalog.range.endByte >= book.range.endByte);
    assert.ok(book.range.startByte <= section.range.startByte && book.range.endByte >= section.range.endByte);
    assert.ok(book.range.startLine <= section.range.startLine && book.range.endLine >= section.range.endLine);
});

test("XML malformed closing tags and unclosed elements do not throw", () => {
    const source = `<catalog>
  <book id="b">
    <chapter>
  </book>
  <section id="s">
</catalog>
<orphan>text</orphan>
`;
    const nodes = parser.parse(source);
    assert.deepEqual(nodes.map(node => node.name), ["catalog", "b", "chapter", "s"]);
    const catalog = nodes[0]!;
    const book = nodes[1]!;
    const chapter = nodes[2]!;
    const section = nodes[3]!;
    assert.equal(book.parentId, catalog.id);
    assert.equal(chapter.parentId, book.id);
    assert.equal(section.parentId, catalog.id);
    assert.equal(chapter.range.endByte, book.range.endByte);
    assert.equal(section.range.endByte, catalog.range.endByte);
    assert.ok(catalog.range.endLine >= section.range.endLine);

    const unclosed = parser.parse(`<catalog><book id="x">`);
    assert.deepEqual(unclosed.map(node => node.name), ["catalog", "x"]);
    assert.equal(unclosed[0]!.range.startByte, 0);
    assert.equal(unclosed[0]!.range.endByte, Buffer.byteLength(`<catalog><book id="x">`, "utf8"));
    assert.equal(unclosed[0]!.range.endLine, 1);
    assert.equal(unclosed[1]!.range.endByte, unclosed[0]!.range.endByte);

    assert.doesNotThrow(() => parser.parse(`<catalog><book id="a"></other></book></catalog>`));
    const mismatched = parser.parse(`<catalog><book id="a"></other></book></catalog>`);
    assert.deepEqual(mismatched.map(node => node.name), ["catalog", "a"]);
});

test("XML empty input and non-string input", () => {
    assert.deepEqual(parser.parse(""), []);
    assert.equal(Object.isFrozen(parser.parse("")), true);
    assert.throws(() => parser.parse(null as unknown as string), TypeError);
    assert.throws(() => parser.parse(42 as unknown as string), TypeError);
});

test("XML definition registers with a fresh language registry", () => {
    assert.equal(definition.id, "xml");
    assert.equal(definition.displayName, "XML");
    assert.equal(definition.support, "outline");
    assert.ok(definition.extensions.includes(".xml"));
    assert.ok(definition.mimeTypes.includes("text/xml"));
    assert.deepEqual(duplicates(definition.extensions), []);
    assert.deepEqual(duplicates(definition.mimeTypes), []);
    for (const extension of definition.extensions) assert.ok(extension.startsWith("."), extension);

    const registry = new LanguageRegistry({ definitions: [definition] });
    const match = registry.resolve("a.xml");
    assert.equal(match.isPresent(), true);
    assert.equal(match.get().language.id, "xml");
    assert.equal(match.get().extension, ".xml");
    assert.equal(match.get().confidence, "exact");
    assert.equal(registry.resolve("schema.xsd").get().language.id, "xml");
    assert.equal(registry.resolve("image.svg", "image/svg+xml").get().language.id, "xml");
    assert.equal(registry.resolve("a.plist", "application/x-plist").get().language.id, "xml");
    assert.equal(registry.load("xml").get().language, "xml");
});

test("XML parser output is frozen and ids are stable and unique", () => {
    const source = `<catalog><book id="b"/><section>secret body</section></catalog>`;
    const nodes = parser.parse(source);
    assert.equal(Object.isFrozen(nodes), true);
    for (const node of nodes) {
        assert.equal(Object.isFrozen(node), true);
        assert.equal(Object.isFrozen(node.range), true);
    }
    assert.equal(nodes[0]!.id, "xml:catalog:0");
    assert.equal(nodes[1]!.id, "xml:book:9");
    assert.deepEqual(duplicates(nodes.map(node => node.id)), []);
    assert.deepEqual(parser.parse(source).map(node => node.id), nodes.map(node => node.id));
    assert.ok(nodes[2]!.summary.includes("<section>"));
    assert.equal(nodes[2]!.summary.includes("secret"), false);
});

test("XML label attributes prefer id over name and key and summaries exclude element text", () => {
    const nodes = parser.parse(`<catalog><record id="one" name="Two" key="three" class="data">SECRET BODY</record></catalog>`);
    assert.deepEqual(nodes.map(node => node.name), ["catalog", "one"]);
    const record = nodes[1]!;
    assert.ok(record.summary.includes("id=one"));
    assert.ok(record.summary.includes("name=Two"));
    assert.ok(record.summary.includes("class=data"));
    assert.equal(record.summary.includes("SECRET"), false);
    assert.equal(record.range.startLine, 0);
    assert.equal(record.range.endLine, 1);

    const named = parser.parse(`<catalog><record name="N" key="K"/></catalog>`);
    assert.equal(named[1]!.name, "N");

    const xmlId = parser.parse(`<catalog><section xml:id="sec"/></catalog>`);
    assert.equal(xmlId[1]!.name, "sec");

    const long = parser.parse(`<catalog><book id="${"x".repeat(130)}"/></catalog>`);
    assert.equal(long[1]!.name.length, 120);
});
