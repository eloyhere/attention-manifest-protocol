/**
 * PowerPoint (.pptx) outline projection.
 *
 * Scope: this reader opens the package, follows `ppt/presentation.xml` ->
 * `p:sldIdLst` -> `ppt/_rels/presentation.xml.rels`, and projects the text shapes
 * (`p:sp/p:txBody/a:p/a:r/a:t`) of each referenced `ppt/slides/*.xml` part.
 *
 * It deliberately does not parse notes pages, slide masters/layouts, charts, images,
 * SmartArt, animations, comments or embedded objects, and it never claims that the
 * binary parts are editable text: locators point back into the original package.
 */
import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet, isString, useFrom } from "semantic-typescript";
import { assertNotLegacy } from "./legacy.ts";
import {
    DocumentError, defaultDocumentLimits,
    type DocumentEntry, type DocumentLimits, type DocumentLocator, type DocumentOutline,
} from "./types.ts";
import { ZipArchive } from "./zip.ts";
import { attrOf, childrenNamed, firstChild, parseXml, textOf, type XmlNode } from "./xml.ts";

const PRESENTATION_PART = "ppt/presentation.xml";
const PRESENTATION_RELATIONSHIPS_PART = "ppt/_rels/presentation.xml.rels";
const SLIDE_PART_PATTERN = /^ppt\/slides\/[^/]+\.xml$/;
const NAME_LIMIT = 120;

function invalidDocument(message: string): DocumentError {
    return new DocumentError("invalid_document", message);
}

function partText(archive: ZipArchive, part: string): Optional<string> {
    try {
        return archive.text(part);
    } catch {
        throw invalidDocument(`pptx part ${part} is not valid UTF-8`);
    }
}

function readXmlPart(archive: ZipArchive, part: string, limits: DocumentLimits, expected: string): XmlNode {
    const source = partText(archive, part);
    if (source.isEmpty()) throw invalidDocument(`pptx package has no ${part}`);
    const root = parseXml(source.get(), limits);
    if (root.local !== expected) {
        throw invalidDocument(`pptx part ${part} is not a <${expected}> element`);
    }
    return root;
}

interface SlideRelationships {
    readonly slides: SynchronousUnorderedMap<string, string>;
    readonly ignored: SynchronousUnorderedSet<string>;
}

/**
 * Resolves an OPC relationship target against the directory of `ppt/presentation.xml`.
 * External targets are filtered before this call; `..` is rejected outright because a
 * presentation relationship never needs to leave the package.
 */
function resolveRelationshipTarget(target: string): string {
    let decoded = target;
    try {
        decoded = decodeURIComponent(target);
    } catch {
        decoded = target;
    }
    if (decoded.includes("\\") || decoded.includes("\0")) {
        throw invalidDocument(`unsafe relationship target: ${target}`);
    }
    const segments = decoded.split("/");
    if (segments.includes("..")) {
        throw invalidDocument(`relationship target escapes the package: ${target}`);
    }
    const resolved: string[] = decoded.startsWith("/") ? [] : ["ppt"];
    for (const segment of segments) {
        if (segment === "" || segment === ".") continue;
        resolved.push(segment);
    }
    return resolved.join("/");
}

function slideRelationshipId(node: XmlNode): string | undefined {
    const qualified = node.attrs["r:id"];
    if (qualified !== undefined) return qualified;
    for (const [name, value] of Object.entries(node.attrs)) {
        if (name.includes(":") && name.split(":").at(-1) === "id") return value;
    }
    // `id` on `p:sldId` is normally the slide ordinal, so only use it when it is clearly
    // a relationship id (e.g. `rId1`) rather than a numeric slide id.
    const unqualified = node.attrs["id"];
    return unqualified !== undefined && !/^\d+$/.test(unqualified) ? unqualified : undefined;
}

function readSlideRelationships(archive: ZipArchive, limits: DocumentLimits): SlideRelationships {
    const slides = new SynchronousUnorderedMap<string, string>();
    const ignored = new SynchronousUnorderedSet<string>();
    const root = readXmlPart(archive, PRESENTATION_RELATIONSHIPS_PART, limits, "Relationships");
    for (const relationship of childrenNamed(root, "Relationship")) {
        const id = attrOf(relationship, "Id");
        const target = attrOf(relationship, "Target");
        if (!isString(id) || id === "") throw invalidDocument("presentation relationship has no Id");
        if (!isString(target) || target === "") throw invalidDocument(`presentation relationship ${id} has no Target`);
        if (slides.containsKey(id) || ignored.contains(id)) {
            throw invalidDocument(`duplicate presentation relationship id: ${id}`);
        }
        const mode = attrOf(relationship, "TargetMode");
        if (isString(mode) && mode.toLowerCase() === "external") {
            ignored.add(id);
            continue;
        }
        const part = resolveRelationshipTarget(target);
        if (SLIDE_PART_PATTERN.test(part)) slides.put(id, part);
        else ignored.add(id);
    }
    return { slides, ignored };
}

/**
 * Maps every `p:sldId` to a slide part, in `sldIdLst` order. External or non-slide
 * relationships produce an empty slot: they keep their ordinal but are not parsed.
 */
function resolveSlideParts(
    slideIds: readonly XmlNode[], relationships: SlideRelationships,
): readonly Optional<string>[] {
    return useFrom(slideIds).map(node => {
        const id = slideRelationshipId(node);
        if (!isString(id) || id === "") throw invalidDocument("a presentation slide id has no relationship id");
        const part = relationships.slides.get(id);
        if (part.isPresent()) return part;
        if (relationships.ignored.contains(id)) return Optional.empty<string>();
        throw invalidDocument(`slide relationship ${id} is missing from ${PRESENTATION_RELATIONSHIPS_PART}`);
    }).toCollectable().toArray();
}

function collectShapes(node: XmlNode, shapes: XmlNode[]): void {
    for (const child of node.children) {
        if (child.local === "sp") shapes.push(child);
        else if (child.local === "grpSp") collectShapes(child, shapes);
    }
}

function paragraphText(paragraph: XmlNode): string {
    return childrenNamed(paragraph, "r")
        .map(run => firstChild(run, "t").map(textOf).orElse(""))
        .join("");
}

/** Every `a:p` under every `p:sp`, in document order; `graphicFrame` is skipped. */
function slideParagraphs(slide: XmlNode): readonly string[] {
    const slideData = firstChild(slide, "cSld");
    if (slideData.isEmpty()) return Object.freeze([]);
    const shapeTree = firstChild(slideData.get(), "spTree");
    if (shapeTree.isEmpty()) return Object.freeze([]);
    const shapes: XmlNode[] = [];
    collectShapes(shapeTree.get(), shapes);
    const paragraphs: string[] = [];
    for (const shape of shapes) {
        const body = firstChild(shape, "txBody");
        if (body.isEmpty()) continue;
        for (const paragraph of childrenNamed(body.get(), "p")) paragraphs.push(paragraphText(paragraph));
    }
    return Object.freeze(paragraphs);
}

function firstNonEmptyParagraph(paragraphs: readonly string[]): string | undefined {
    for (const paragraph of paragraphs) {
        const trimmed = paragraph.trim();
        if (trimmed !== "") return trimmed;
    }
    return undefined;
}

function truncate(value: string, limit: number): string {
    return value.length > limit ? value.slice(0, limit) : value;
}

export function parsePptx(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("pptx input must be a Uint8Array");
    assertNotLegacy(bytes, "PowerPoint", ".pptx");
    const archive = ZipArchive.open(bytes, limits);
    if (!archive.has(PRESENTATION_PART)) {
        throw invalidDocument(`pptx package has no ${PRESENTATION_PART}`);
    }
    const presentation = readXmlPart(archive, PRESENTATION_PART, limits, "presentation");
    const slideList = firstChild(presentation, "sldIdLst");
    const slideIds: readonly XmlNode[] = slideList.isPresent() ? childrenNamed(slideList.get(), "sldId") : [];
    const budgets = { ...defaultDocumentLimits, ...limits };
    const entries: DocumentEntry[] = [];
    let truncated = false;
    if (slideIds.length > 0) {
        if (!archive.has(PRESENTATION_RELATIONSHIPS_PART)) {
            throw invalidDocument(`pptx package has no ${PRESENTATION_RELATIONSHIPS_PART} but references slides`);
        }
        const parts = resolveSlideParts(slideIds, readSlideRelationships(archive, limits));
        const paragraphCache = new SynchronousUnorderedMap<string, readonly string[]>();
        let textCharacters = 0;
        for (let position = 0; position < parts.length; position += 1) {
            const part = parts[position]!;
            if (part.isEmpty()) continue;
            const index = position + 1;
            const slidePart = part.get();
            const cached = paragraphCache.get(slidePart);
            let paragraphs: readonly string[];
            if (cached.isPresent()) {
                paragraphs = cached.get();
            } else {
                paragraphs = slideParagraphs(readXmlPart(archive, slidePart, limits, "sld"));
                paragraphCache.put(slidePart, paragraphs);
            }
            const title = firstNonEmptyParagraph(paragraphs);
            if (title === undefined) continue;
            if (entries.length >= budgets.maxEntriesInOutline) {
                truncated = true;
                continue;
            }
            const separator = entries.length === 0 ? 0 : 1;
            const remaining = budgets.maxTextCharacters - textCharacters - separator;
            if (remaining <= 0) {
                truncated = true;
                continue;
            }
            const summary = paragraphs.join("\n");
            const projected = truncate(summary, remaining);
            if (projected.length < summary.length) truncated = true;
            const locator: DocumentLocator = Object.freeze({ part: slidePart, slide: index });
            entries.push(Object.freeze({
                id: `pptx:slide:${index}`, kind: "slide" as const,
                name: truncate(title, NAME_LIMIT), summary: projected, locator,
            }));
            textCharacters += separator + projected.length;
        }
    }
    return Object.freeze({
        language: "powerpoint",
        entries: Object.freeze(entries),
        text: entries.map(entry => entry.summary).join("\n"),
        truncated,
    });
}
