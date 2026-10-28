/**
 * Offline structural adapters. OOXML archives are read in memory, never
 * extracted to disk. Original packages remain available as scoped details.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { UnzipFileInfo } from "fflate";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";

import type { ContentStore } from "../../src/context/contentStore.ts";
import { encodeDocumentDetail } from "../../src/context/document.ts";
import type { DocumentCell, DocumentDetail, DocumentLocator, SlideObject } from "../../src/context/document.ts";
import { workspaceTerms } from "../../src/context/workspace.ts";
import type { WorkspaceEntity, WorkspaceSnapshot, WorkspaceSource } from "../../src/context/workspace.ts";
import { scanWorkspace } from "./workspaceScanner.ts";
import type { WorkspaceFile } from "./workspaceScanner.ts";
import { addTexStructure } from "./texScanner.ts";

export interface StructuredWorkspaceFile {
    path: string;
    content: string | Uint8Array;
}

type StructuredScanner = (inputs: readonly StructuredWorkspaceFile[], store: ContentStore) => WorkspaceSnapshot;
type DocumentArguments = [
    key: string,
    parentId: string,
    label: string,
    locator: DocumentLocator,
    detail: DocumentDetail,
    body: string,
    kind: WorkspaceEntity["structureKind"],
];
type DocumentAdder = (...args: DocumentArguments) => WorkspaceEntity;

interface HeadingEntry {
    id: string;
    level: number;
}

interface SheetInput {
    name: string;
    node: WorkspaceEntity;
    cells: DocumentCell[];
    part: string;
}

interface CellCoordinate {
    column: string;
    rank: number;
    row: number;
}

interface XmlItem {
    [key: string]: XmlItem[] | string | Record<string, string>;
}

interface Element {
    name: string;
    attrs: Record<string, string>;
    children: Element[];
    text: string;
    raw: XmlItem;
}

interface Relationship {
    id: string;
    type: string;
    target: string;
    external: boolean;
}

const MaxInputBytes: number = 16 * 1024 * 1024;
const MaxExpandedBytes: number = 32 * 1024 * 1024;
const Parser: XMLParser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false });
const Builder: XMLBuilder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false });
const hash: (value: string | Uint8Array) => string = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const short: (text: string) => string = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 180);
const cellRange: (cells: DocumentCell[]) => string = (cells: DocumentCell[]): string => {
    if (cells.length === 0) {
        return "A1";
    }
    const addresses: CellCoordinate[] = cells.map((cell: DocumentCell) => {
        const match: RegExpExecArray = /^([A-Z]+)(\d+)$/.exec(cell.address)!;
        return {
            column: match[1],
            rank: [...match[1]].reduce((sum: number, char: string): number => sum * 26 + char.charCodeAt(0) - 64, 0),
            row: Number(match[2]),
        };
    });
    addresses.sort((left, right): number => left.rank - right.rank);
    const rows: number[] = addresses.map((address): number => address.row);
    const first: string = `${addresses[0].column}${rows.reduce((minimum: number, row: number): number => Math.min(minimum, row), Infinity)}`;
    const last: string = `${addresses.at(-1)!.column}${rows.reduce((maximum: number, row: number): number => Math.max(maximum, row), 1)}`;
    return first === last ? first : `${first}:${last}`;
};
const local: (name: string) => string = (name: string): string => name.split(":").at(-1)!;
const attr: (node: Element | undefined, name: string) => string = (node: Element | undefined, name: string): string =>
    node === (void 0) ? "" : (node.attrs[name] ?? Object.entries(node.attrs).find(([key]: [string, string]): boolean => local(key) === name)?.[1] ?? "");
const relationshipId: (node: Element) => string = (node: Element): string =>
    node.attrs["r:id"] ?? Object.entries(node.attrs).find(([key]: [string, string]): boolean => key.includes(":") && local(key) === "id")?.[1] ?? "";
const children: (node: Element, name: string) => Element[] = (node: Element, name: string): Element[] =>
    node.children.filter((child: Element): boolean => local(child.name) === name);
const descendants: (node: Element, name: string) => Element[] = (node: Element, name: string): Element[] =>
    node.children.flatMap((child: Element): Element[] => [...(local(child.name) === name ? [child] : []), ...descendants(child, name)]);
const text: (node: Element) => string = (node: Element): string => node.text + node.children.map(text).join("");
const paragraphs: (node: Element) => string = (node: Element): string =>
    descendants(node, "p")
        .map((paragraph: Element): string => descendants(paragraph, "t").map(text).join(""))
        .join("\n");
const xml: (node: Element) => string = (node: Element): string => Builder.build([node.raw]) as string;
const elements: (items: XmlItem[]) => Element[] = (items: XmlItem[]): Element[] =>
    items.flatMap((item: XmlItem): Element[] => {
        const name: string | undefined = Object.keys(item).find((key: string): boolean => key !== ":@" && key !== "#text" && !key.startsWith("?"));
        if (name === (void 0)) {
            return [];
        }
        const content: XmlItem[] = item[name] as XmlItem[];
        return [
            {
                name,
                attrs: Object.fromEntries(
                    Object.entries((item[":@"] ?? {}) as Record<string, string>).map(([key, value]: [string, string]): [string, string] => [
                        key.slice(2),
                        value,
                    ]),
                ),
                children: elements(content),
                text: content
                    .filter((child: XmlItem): boolean => "#text" in child)
                    .map((child: XmlItem): string => `${child["#text"]}`)
                    .join(""),
                raw: item,
            },
        ];
    });

const parseXml: (content: string) => Element = (content: string): Element => {
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) {
        throw new Error("DTD/entity declarations are unsupported");
    }
    let depth: number = 0;
    const tags: RegExpMatchArray[] = [...content.matchAll(/<[^>]+>/g)];
    for (let tagIndex: number = 0; tagIndex < tags.length; tagIndex += 1) {
        const match: RegExpMatchArray = tags[tagIndex];
        if (/^<\//.test(match[0])) {
            depth -= 1;
        } else if (!/^<[!?]/.test(match[0]) && !/\/>$/.test(match[0])) {
            depth += 1;
        }
        if (depth > 128) {
            throw new Error("XML nesting exceeds 128");
        }
    }
    if (XMLValidator.validate(content) !== true) {
        throw new Error("malformed XML");
    }
    const roots: Element[] = elements(Parser.parse(content) as XmlItem[]);
    if (roots.length !== 1) {
        throw new Error("XML requires one root");
    }
    return roots[0];
};

class Package {
    private readonly parts: Record<string, Uint8Array>;
    private readonly parsed: Map<string, Element> = new Map();

    constructor(bytes: Uint8Array) {
        let total: number = 0;
        const names: Set<string> = new Set();
        this.parts = unzipSync(bytes, {
            filter: (entry: UnzipFileInfo): boolean => {
                if (
                    names.has(entry.name) ||
                    names.size >= 4096 ||
                    entry.name.startsWith("/") ||
                    entry.name.includes("\\") ||
                    posix.normalize(entry.name) !== entry.name ||
                    entry.name.startsWith("../")
                ) {
                    throw new Error("invalid, duplicate or excessive ZIP entries");
                }
                names.add(entry.name);
                total += entry.originalSize;
                if (entry.originalSize > 8 * 1024 * 1024 || total > MaxExpandedBytes) {
                    throw new Error("OOXML expansion limit exceeded");
                }
                return /\.(?:xml|rels)$/.test(entry.name);
            },
        });
    }

    has(part: string): boolean {
        return Object.hasOwn(this.parts, part);
    }

    read(part: string): Element {
        const cached: Element | undefined = this.parsed.get(part);
        if (cached !== (void 0)) {
            return cached;
        }
        if (!this.has(part)) {
            throw new Error(`missing OOXML part ${part}`);
        }
        const root: Element = parseXml(strFromU8(this.parts[part]));
        this.parsed.set(part, root);
        return root;
    }

    relationships(part: string): Relationship[] {
        const rels: string = posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
        if (!this.has(rels)) {
            return [];
        }
        return children(this.read(rels), "Relationship").map((node: Element): Relationship => ({
            id: attr(node, "Id"),
            type: attr(node, "Type").split("/").at(-1)!,
            target:
                attr(node, "TargetMode") === "External"
                    ? attr(node, "Target")
                    : posix.normalize(
                          attr(node, "Target").startsWith("/") ? attr(node, "Target").slice(1) : posix.join(posix.dirname(part), attr(node, "Target")),
                      ),
            external: attr(node, "TargetMode") === "External",
        }));
    }

    target(part: string, id: string): string {
        const relation: Relationship | undefined = this.relationships(part).find((item: Relationship): boolean => item.id === id);
        if (!relation || relation.external) {
            throw new Error(`missing or external OOXML relationship ${id}`);
        }
        return relation.target;
    }
}

/**
 * Sources are canonical relative paths. Code/Markdown retain their existing
 * adapters; modern Office documents add native structural knowledge nodes.
 */
export const scanStructuredWorkspace: StructuredScanner = (inputs: readonly StructuredWorkspaceFile[], store: ContentStore): WorkspaceSnapshot => {
    const normalized: StructuredWorkspaceFile[] = inputs.map((file: StructuredWorkspaceFile): StructuredWorkspaceFile => ({
        ...file,
        path: file.path.replace(/\\/g, "/"),
    }));
    const isText: (path: string) => boolean = (path: string): boolean => /\.(?:md|txt|[cm]?[jt]sx?|json)$/i.test(path);
    const snapshot: WorkspaceSnapshot = scanWorkspace(
        normalized.map((file: StructuredWorkspaceFile): WorkspaceFile => ({
            path: file.path,
            content:
                isText(file.path) && !/\.txt$/i.test(file.path)
                    ? typeof(file.content) === "string"
                        ? file.content
                        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.content)
                    : "",
        })),
        store,
    );
    const revisions: Map<string, string> = new Map(normalized.map((file: StructuredWorkspaceFile): [string, string] => [file.path, hash(file.content)]));
    snapshot.revision = hash(JSON.stringify([...revisions].sort(([left], [right]): number => (left < right ? -1 : left > right ? 1 : 0))));
    snapshot.entities
        .filter((entity: WorkspaceEntity): boolean => entity.kind === "directory" || (entity.kind === "project" && entity.source.uri === "."))
        .forEach((entity: WorkspaceEntity): void => {
            entity.source.revision = snapshot.revision;
        });
    const entities: Map<string, WorkspaceEntity> = new Map(snapshot.entities.map((entity: WorkspaceEntity): [string, WorkspaceEntity] => [entity.id, entity]));
    const texInputs: WorkspaceFile[] = [];
    for (let inputIndex: number = 0; inputIndex < normalized.length; inputIndex += 1) {
        const input: StructuredWorkspaceFile = normalized[inputIndex];
        const path: string = input.path;
        if (isText(path) && !/\.txt$/i.test(path)) {
            continue;
        }
        const file: WorkspaceEntity = entities.get(`file:${path}`)!;
        const revision: string = revisions.get(path)!;
        file.source.revision = revision;
        const bytes: Uint8Array = typeof(input.content) === "string" ? new TextEncoder().encode(input.content) : input.content;
        if (/\.(?:tex|ltx|sty|cls|bib)$/i.test(path)) {
            try {
                if (bytes.byteLength > MaxInputBytes) {
                    throw new Error("TeX source exceeds 16 MiB");
                }
                const content: string = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
                file.detailRef = store.put(content);
                texInputs.push({ path, content });
            } catch (error) {
                delete file.detailRef;
                snapshot.diagnostics.push({ uri: path, code: "invalid_tex", message: error instanceof Error ? error.message : "TeX decoding failed" });
            }
            continue;
        }
        if (/\.(?:png|jpe?g|eps|svg|webp)$/i.test(path)) {
            delete file.detailRef;
            file.tags = ["document-asset"];
            continue;
        }
        const added: WorkspaceEntity[] = [];
        const source: (locator: DocumentLocator) => WorkspaceSource = (locator: DocumentLocator): WorkspaceSource => ({ uri: path, revision, locator });
        const add: DocumentAdder = (key, parentId, label, locator, detail, body, kind): WorkspaceEntity => {
            const entity: WorkspaceEntity = {
                id: `knowledge:${path}#${key}`,
                kind: "knowledge",
                projectId: file.projectId,
                parentId,
                label,
                summary: short(`${label}: ${body}`),
                source: source(locator),
                structureKind: kind,
                detailRef: store.put(encodeDocumentDetail(detail)),
                searchTerms: workspaceTerms(body),
                summaryProvenance: { method: "extractive-v1", sources: [{ uri: path, revision }], children: [] },
            };
            added.push(entity);
            return entity;
        };
        try {
            if (bytes.byteLength > MaxInputBytes) {
                throw new Error("document exceeds 16 MiB input limit");
            }
            if (/\.txt$/i.test(path)) {
                const body: string = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
                add("text", file.id, path, { kind: "part", part: path }, { kind: "text", text: body }, body, "document");
                file.detailRef = store.put(body);
            } else if (/\.(?:docx|xlsx|pptx)$/i.test(path)) {
                const pkg: Package = new Package(bytes);
                if (/\.docx$/i.test(path)) {
                    const part: string = "word/document.xml";
                    const root: Element = pkg.read(part);
                    const body: Element | undefined = children(root, "body")[0];
                    if (!body) {
                        throw new Error("Word document body missing");
                    }
                    const sections: HeadingEntry[] = [];
                    let ordinal: number = 0;
                    for (let blockIndex: number = 0; blockIndex < body.children.length; blockIndex += 1) {
                        const block: Element = body.children[blockIndex];
                        ordinal += 1;
                        const name: string = local(block.name);
                        if (!["p", "tbl"].includes(name)) {
                            continue;
                        }
                        const locator: DocumentLocator = { kind: "part", part, element: `body/*[${ordinal}]` };
                        if (name === "tbl") {
                            const rows: string[][] = children(block, "tr").map((row: Element): string[] => children(row, "tc").map(paragraphs));
                            add(
                                `table${ordinal}`,
                                sections.at(-1)?.id ?? file.id,
                                `Table ${ordinal}`,
                                locator,
                                { kind: "table", rows, xml: xml(block) },
                                rows.flat().join(" "),
                                "table",
                            );
                        } else {
                            const style: string = attr(descendants(block, "pStyle")[0], "val");
                            const outline: string = attr(descendants(block, "outlineLvl")[0], "val");
                            const level: number = outline && Number(outline) < 9 ? Number(outline) + 1 : Number(/^Heading([1-9])$/i.exec(style)?.[1] ?? 0);
                            const bodyText: string = descendants(block, "t").map(text).join("");
                            if (level > 0) {
                                while (sections.length > 0 && sections.at(-1)!.level >= level) {
                                    sections.pop();
                                }
                            }
                            const node: WorkspaceEntity = add(
                                `p${ordinal}`,
                                sections.at(-1)?.id ?? file.id,
                                level ? bodyText : `Paragraph ${ordinal}`,
                                locator,
                                { kind: "text", text: bodyText, xml: xml(block) },
                                bodyText,
                                level ? "section" : "paragraph",
                            );
                            if (level > 0) {
                                sections.push({ id: node.id, level });
                            }
                        }
                    }
                    snapshot.diagnostics.push({
                        uri: path,
                        code: "docx_structure_partial",
                        message:
                            "Main body, standard Heading styles and direct outline levels indexed; custom styles, headers, notes, revisions and images remain in original package",
                    });
                } else if (/\.xlsx$/i.test(path)) {
                    const part: string = "xl/workbook.xml";
                    const root: Element = pkg.read(part);
                    const shared: string[] = pkg.has("xl/sharedStrings.xml")
                        ? children(pkg.read("xl/sharedStrings.xml"), "si").map((item: Element): string => descendants(item, "t").map(text).join(""))
                        : [];
                    const sheets: SheetInput[] = [];
                    const sheetElements: Element[] = descendants(root, "sheet");
                    for (let sheetIndex: number = 0; sheetIndex < sheetElements.length; sheetIndex += 1) {
                        const sheet: Element = sheetElements[sheetIndex];
                        const name: string = attr(sheet, "name");
                        const sheetPart: string = pkg.target(part, relationshipId(sheet));
                        const sheetXml: Element = pkg.read(sheetPart);
                        const cells: DocumentCell[] = descendants(sheetXml, "c").map((cell: Element): DocumentCell => {
                            const formula: Element | undefined = children(cell, "f")[0];
                            const value: Element | undefined = children(cell, "v")[0];
                            const type: string = attr(cell, "t") || "n";
                            const address: string = attr(cell, "r");
                            if (!/^[A-Z]+[1-9]\d*$/.test(address)) {
                                throw new Error("sheet cell requires an A1 address");
                            }
                            return {
                                address,
                                type,
                                ...(value ? { value: type === "s" ? (shared[Number(text(value))] ?? text(value)) : text(value) } : {}),
                                ...(type === "inlineStr" ? { value: descendants(cell, "t").map(text).join("") } : {}),
                                ...(formula ? { formula: text(formula), formulaAttributes: { ...formula.attrs } } : {}),
                                ...(attr(cell, "s") ? { style: attr(cell, "s") } : {}),
                            };
                        });
                        const range: string = cellRange(cells);
                        const node: WorkspaceEntity = add(
                            `sheet:${attr(sheet, "sheetId")}`,
                            file.id,
                            name,
                            { kind: "cells", part: sheetPart, sheet: name, range },
                            {
                                kind: "sheet",
                                name,
                                cells,
                                merges: descendants(sheetXml, "mergeCell").map((item: Element): string => attr(item, "ref")),
                                xml: xml(sheetXml),
                            },
                            cells.map((cell: DocumentCell): string => `${cell.address} ${cell.value ?? ""} ${cell.formula ?? ""}`).join("\n"),
                            "sheet",
                        );
                        sheets.push({ name, node, cells, part: sheetPart });
                    }
                    for (let sheetIndex: number = 0; sheetIndex < sheets.length; sheetIndex += 1) {
                        const sheet: (typeof sheets)[number] = sheets[sheetIndex];
                        for (let cellIndex: number = 0; cellIndex < sheet.cells.length; cellIndex += 1) {
                            const cell: DocumentCell = sheet.cells[cellIndex];
                            const references: RegExpMatchArray[] = [
                                ...(cell.formula ?? "")
                                    .replace(/"(?:[^"]|"")*"/g, "")
                                    .matchAll(/(?<![\p{L}\p{N}_.\]])(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!\$?[A-Z]+\$?[1-9]\d*/gu),
                            ];
                            for (let referenceIndex: number = 0; referenceIndex < references.length; referenceIndex += 1) {
                                const match: RegExpMatchArray = references[referenceIndex];
                                const targetName: string = (match[1] ?? match[2]).replace(/''/g, "'");
                                const target: WorkspaceEntity | undefined = sheets.find(
                                    (item): boolean => item.name.toLowerCase() === targetName.toLowerCase(),
                                )?.node;
                                if (target) {
                                    snapshot.relations.push({
                                        from: sheet.node.id,
                                        to: target.id,
                                        kind: "references",
                                        method: "explicit",
                                        source: source({ kind: "cells", part: sheet.part, sheet: sheet.name, range: cell.address }),
                                    });
                                }
                            }
                        }
                    }
                    snapshot.diagnostics.push({
                        uri: path,
                        code: "formula_graph_partial",
                        message:
                            "No recalculation: values are stored caches; graph covers literal cross-sheet A1 references only; named, dynamic, external and shared-formula expansion remain unanalysed. Styles/charts/table definitions remain in original package",
                    });
                } else {
                    const part: string = "ppt/presentation.xml";
                    let ordinal: number = 0;
                    const slideElements: Element[] = descendants(pkg.read(part), "sldId");
                    for (let slideIndex: number = 0; slideIndex < slideElements.length; slideIndex += 1) {
                        const slide: Element = slideElements[slideIndex];
                        ordinal += 1;
                        const slidePart: string = pkg.target(part, relationshipId(slide));
                        const root: Element = pkg.read(slidePart);
                        const objects: SlideObject[] = [];
                        const collect: (element: Element) => void = (element: Element): void => {
                            for (let childIndex: number = 0; childIndex < element.children.length; childIndex += 1) {
                                const child: Element = element.children[childIndex];
                                if (["sp", "pic", "graphicFrame", "cxnSp"].includes(local(child.name))) {
                                    const properties: Element | undefined = descendants(child, "cNvPr")[0];
                                    objects.push({
                                        id: attr(properties, "id"),
                                        kind: local(child.name),
                                        text: paragraphs(child),
                                        xml: xml(child),
                                        locator: { kind: "slide", part: slidePart, slide: ordinal, objectId: attr(properties, "id") },
                                    });
                                } else {
                                    collect(child);
                                }
                            }
                        };
                        collect(root);
                        const note: Relationship | undefined = pkg
                            .relationships(slidePart)
                            .find((item: Relationship): boolean => item.type === "notesSlide" && !item.external);
                        const notes: string = note ? paragraphs(pkg.read(note.target)) : "";
                        add(
                            `slide${ordinal}`,
                            file.id,
                            `Slide ${ordinal}`,
                            { kind: "slide", part: slidePart, slide: ordinal },
                            { kind: "slide", objects, notes, xml: xml(root) },
                            `${objects.map((object: SlideObject): string => object.text).join("\n")}\n${notes}`,
                            "slide",
                        );
                    }
                    snapshot.diagnostics.push({
                        uri: path,
                        code: "pptx_structure_partial",
                        message:
                            "Slide order, objects, native layout XML and speaker notes retained; charts/images/themes remain in original package; no OCR or layout inference",
                    });
                }
                add(
                    "original",
                    file.id,
                    "Original package",
                    { kind: "part", part: "/" },
                    {
                        kind: "original",
                        mediaType: `application/vnd.openxmlformats-officedocument.${/\.docx$/i.test(path) ? "wordprocessingml.document" : /\.xlsx$/i.test(path) ? "spreadsheetml.sheet" : "presentationml.presentation"}`,
                        encoding: "base64",
                        data: Buffer.from(bytes).toString("base64"),
                    },
                    "Original Office package; allocate this node to retrieve complete binary contents",
                    "document",
                );
                delete file.detailRef;
            } else {
                snapshot.diagnostics.push({
                    uri: path,
                    code: "unsupported_document",
                    message:
                        "Supported document formats: Markdown, UTF-8 TXT, TeX/LaTeX, BibTeX, DOCX, XLSX, PPTX. Convert PDF/EPUB/legacy Office formats before ingestion",
                });
                delete file.detailRef;
                continue;
            }
            file.structureKind = "document";
            const childrenByParent: Map<string, WorkspaceEntity[]> = new Map();
            added.forEach((entity: WorkspaceEntity): void => {
                const siblings: WorkspaceEntity[] = childrenByParent.get(entity.parentId!) ?? [];
                siblings.push(entity);
                childrenByParent.set(entity.parentId!, siblings);
            });
            for (let entityIndex: number = added.length - 1; entityIndex >= 0; entityIndex -= 1) {
                const entity: WorkspaceEntity = added[entityIndex];
                const children: WorkspaceEntity[] = childrenByParent.get(entity.id) ?? [];
                if (children.length > 0) {
                    entity.summary = short(`${entity.summary} ${children.map((child: WorkspaceEntity): string => child.summary).join("; ")}`);
                }
            }
            for (let entityIndex: number = 0; entityIndex < added.length; entityIndex += 1) {
                const entity: WorkspaceEntity = added[entityIndex];
                entity.summaryProvenance!.children = (childrenByParent.get(entity.id) ?? []).map((child: WorkspaceEntity): string => child.id);
                entities.set(entity.id, entity);
            }
            file.summary = short(`${path}: ${(childrenByParent.get(file.id) ?? []).map((entity: WorkspaceEntity): string => entity.summary).join("; ")}`);
            file.summaryProvenance = {
                method: "extractive-v1",
                sources: [{ uri: path, revision }],
                children: (childrenByParent.get(file.id) ?? []).map((entity: WorkspaceEntity): string => entity.id),
            };
        } catch (error) {
            delete file.detailRef;
            snapshot.relations = snapshot.relations.filter(
                (edge): boolean => !added.some((entity: WorkspaceEntity): boolean => entity.id === edge.from || entity.id === edge.to),
            );
            snapshot.diagnostics.push({ uri: path, code: "invalid_document", message: error instanceof Error ? error.message : "document parsing failed" });
        }
    }
    snapshot.entities = [...entities.values()];
    addTexStructure(snapshot, texInputs, store);
    return snapshot;
};
