/**
 * Portable document facts. Parsers live outside the runtime; typed reads use
 * the same captured, Frame-scoped content references as ordinary expansion.
 */
import type { Context } from "./lifecycle.ts";

interface PartLocator {
    kind: "part";
    part: string;
    element?: string;
}

interface CellLocator {
    kind: "cells";
    part: string;
    sheet: string;
    range: string;
}

interface SlideLocator {
    kind: "slide";
    part: string;
    slide: number;
    objectId?: string;
}

export type DocumentLocator = PartLocator | CellLocator | SlideLocator;

export interface DocumentSourceRevision {
    uri: string;
    revision: string;
}

export interface SummaryProvenance {
    method: "extractive-v1";
    sources: DocumentSourceRevision[];
    children: string[];
}

export interface DocumentCell {
    address: string;
    type: string;
    value?: string;
    formula?: string;
    formulaAttributes?: Record<string, string>;
    style?: string;
}

export interface SlideObject {
    id: string;
    kind: string;
    text: string;
    locator: SlideLocator;
    /**
     * Native XML keeps layout and chart/image relationships.
     */
    xml: string;
}

interface TextDetail {
    kind: "text";
    text: string;
    xml?: string;
}

interface TableDetail {
    kind: "table";
    rows: string[][];
    xml: string;
}

interface SheetDetail {
    kind: "sheet";
    name: string;
    cells: DocumentCell[];
    merges: string[];
    xml: string;
}

interface SlideDetail {
    kind: "slide";
    objects: SlideObject[];
    notes: string;
    xml: string;
}

interface OriginalDetail {
    kind: "original";
    mediaType: string;
    encoding: "base64";
    data: string;
}

export interface TexDependency {
    from: string;
    to: string;
    command: string;
}

export interface TexProjectDetail {
    kind: "tex-project";
    root: string;
    files: string[];
    dependencies: TexDependency[];
}

export type DocumentDetail = TextDetail | TableDetail | SheetDetail | SlideDetail | OriginalDetail | TexProjectDetail;
type DocumentReader = (context: Context, nodeId: string) => DocumentDetail | undefined;

export interface DocumentEnvelope {
    ampDocument: 1;
    detail: DocumentDetail;
}

export const encodeDocumentDetail: (detail: DocumentDetail) => string = (detail: DocumentDetail): string =>
    JSON.stringify({ ampDocument: 1, detail } satisfies DocumentEnvelope);

/**
 * The reader never follows embedded refs, graph edges or descendant IDs.
 */
export const readDocumentDetail: DocumentReader = (context: Context, nodeId: string): DocumentDetail | undefined => {
    const content: string | undefined = context.expand(nodeId);
    if (content === (void 0)) {
        return (void 0);
    }
    try {
        const value: DocumentEnvelope = JSON.parse(content) as DocumentEnvelope;
        if (value?.ampDocument === 1 && value.detail && ["text", "table", "sheet", "slide", "original", "tex-project"].includes(value.detail.kind)) {
            return value.detail;
        }
    } catch {
        /**
         * Legacy text details remain readable without migration.
         */
    }
    return { kind: "text", text: content };
};
