/**
 * Immutable context package contract.
 *
 * A `ContextPackage` is the complete, JSON-serializable payload an agent sees
 * for one assembly pass: bounded summaries, their provenance, the graph edges
 * between selected items, and an explicit list of what was left out. Detail
 * content never appears here; `detailRef` is an opaque host handle instead.
 *
 * The module also owns the package-level validation error and the canonical
 * rendering used to build `text`, so the builder and every consumer spell a
 * package the same way. Every returned package is deep-frozen and survives a
 * `JSON.parse(JSON.stringify(package))` round trip without a lossy field.
 */

/**
 * Maximum number of characters kept from one item summary.
 *
 * Summaries are bounded by construction rather than by later truncation: an
 * item that does not fit the token budget is omitted, never shortened, so a
 * caller can trust that `summary` is the whole summary it asked for.
 */
export const ContextSummaryLimit: number = 400;

/**
 * Item kinds a package can carry.
 *
 * `file`/`directory` describe tree objects, `outline` a symbol or heading,
 * `import`/`export`/`dependency` a graph fact, and `note` a host annotation.
 */
export type ContextItemKind = "file" | "directory" | "outline" | "import" | "export" | "dependency" | "note";

/**
 * Why an item entered the candidate set.
 *
 * Provenance is descriptive, never authorization: it records the mechanism
 * that produced the item so a prompt reader can weigh it.
 */
export type ContextProvenance = "anchor" | "outline" | "import" | "export" | "dependency" | "tree";

/**
 * Closed omission reasons. `budget` covers token and item ceilings, `duplicate`
 * a repeated or path-equivalent candidate, `missing` an unresolved target, and
 * `outside_scope` a target the session scope does not contain (an external
 * package, or a node beyond a requested filter).
 */
export type ContextOmissionReason = "budget" | "duplicate" | "missing" | "outside_scope";

/**
 * Graph edge kinds a package can express. `contains` is the structural edge
 * between an outline anchor and its symbols (or a directory and its entries);
 * the others mirror the filesystem graph.
 */
export type ContextRelationKind = "import" | "export" | "dependency" | "contains";

/**
 * Closed builder failure codes, mirroring the filesystem module's convention of
 * code-only messages that never echo a host path.
 */
export type ContextBuilderErrorCode = "invalid_arguments" | "not_directory" | "session_unavailable";

/**
 * One input or session-contract failure in the builder layer.
 *
 * Filesystem/session errors are deliberately not wrapped: they keep their own
 * classified code (`not_found`, `invalid_path`, `quota_exceeded`, ...) and
 * propagate unchanged, so a transport maps one code space per layer.
 */
export class ContextBuilderError extends Error {
    readonly code: ContextBuilderErrorCode;

    /**
     * @param code - Closed failure code; the message is the code itself.
     */
    constructor(code: ContextBuilderErrorCode) {
        super(code);
        this.name = "ContextBuilderError";
        this.code = code;
    }
}

/**
 * Inclusive 1-based line extent. Outlines store bigint ranges; a package range
 * is a pair of JSON-safe numbers because a prompt never addresses a line past
 * `Number.MAX_SAFE_INTEGER`.
 */
export interface ContextRange {
    readonly startLine: number;
    readonly endLine: number;
}

/**
 * One bounded prompt unit.
 *
 * `tokens` is the admission charge for the rendered line (see
 * {@link renderContextItem}), `score` the deterministic ranking value, and
 * `why` the short human-readable reason the item survived selection.
 */
export interface ContextItem {
    readonly id: string;
    readonly kind: ContextItemKind;
    readonly path: string;
    readonly summary: string;
    readonly detailRef?: string;
    readonly range?: ContextRange;
    readonly tokens: number;
    readonly score: number;
    readonly provenance: ContextProvenance;
    readonly why: string;
}

/**
 * One candidate that did not become an item.
 *
 * `requiredIds` names the surviving items whose presence made the omission
 * relevant: the winning duplicate for `duplicate`, the selected dependent for
 * `missing`/`outside_scope`, and the two endpoints for a dropped relation. A
 * budget-dropped item has no required IDs because nothing else needed it.
 */
export interface ContextOmission {
    readonly id: string;
    readonly reason: ContextOmissionReason;
    readonly requiredIds?: readonly string[];
}

/**
 * One edge whose two endpoints are both selected items.
 */
export interface ContextRelation {
    readonly from: string;
    readonly to: string;
    readonly kind: ContextRelationKind;
}

/**
 * Immutable, JSON-serializable assembly result.
 *
 * Invariants:
 * - `items` are sorted by descending `score`, then ascending `path`, then `id`;
 * - `usedTokens` is the sum of item and relation admission charges and never
 *   exceeds `budgetTokens`;
 * - every relation endpoint is an `items[].id`;
 * - `text` is exactly the rendering of `items` followed by `relations`.
 */
export interface ContextPackage {
    readonly sessionId: string;
    readonly revision: string;
    readonly budgetTokens: number;
    readonly usedTokens: number;
    readonly items: readonly ContextItem[];
    readonly omitted: readonly ContextOmission[];
    readonly relations: readonly ContextRelation[];
    readonly text: string;
    readonly truncated: boolean;
}

/**
 * Collapse whitespace and bound one summary to {@link ContextSummaryLimit}.
 *
 * Newlines and whitespace are folded to single spaces and remaining C0/C1
 * control characters are removed, so a summary can never break the
 * one-line-per-item prompt format or smuggle a terminal escape into it; an
 * overlong summary keeps its first `limit - 3` characters and an explicit
 * ellipsis.
 *
 * @param text - Raw summary text, possibly multiline.
 * @returns A single-line summary of at most `ContextSummaryLimit` characters.
 */
export const clampSummary: (text: string) => string = (text: string): string => {
    const single: string = text
        .replace(/\s+/gu, " ")
        .replace(/[\u0000-\u001f\u007f]/gu, "")
        .trim();
    if (single.length <= ContextSummaryLimit) {
        return single;
    }
    return `${single.slice(0, ContextSummaryLimit - 3)}...`;
};

/**
 * Line number accepted by range projection: outline facts carry bigint, JSON
 * facts carry number.
 */
type LineInput = bigint | number;

/**
 * Convert one outline line value without relying on `toString`.
 *
 * A value above `Number.MAX_SAFE_INTEGER` is clamped to that ceiling instead of
 * falling back to 1: a generated file can legitimately report a line count past
 * the JSON-safe range, and clamping to the top keeps the extent monotonic.
 *
 * @param value - Line number as a bigint or number.
 * @returns A positive safe integer, or 1 when the value cannot be represented.
 */
const safeLine: (value: LineInput) => number = (value: LineInput): number => {
    const numeric: number = typeof(value) === "bigint" ? Number(value) : value;
    if (Number.isSafeInteger(numeric) && numeric >= 1) {
        return numeric;
    }
    return numeric > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : 1;
};

/**
 * Project a line pair to a JSON-safe range.
 *
 * Non-positive or non-finite values are clamped to 1 and an inverted extent is
 * repaired to a single line, because outline ranges are advisory metadata.
 *
 * @param startLine - 1-based start line as a bigint or number.
 * @param endLine - 1-based inclusive end line as a bigint or number.
 * @returns The clamped inclusive range.
 */
export const toContextRange: (startLine: LineInput, endLine: LineInput) => ContextRange = (startLine: LineInput, endLine: LineInput): ContextRange => {
    const start: number = safeLine(startLine);
    const end: number = Math.max(start, safeLine(endLine));
    return { startLine: start, endLine: end };
};

/**
 * Render one item as a single prompt line.
 *
 * The format is stable and deliberately flat: hierarchy is expressed by
 * `contains` relations, not indentation, so the same item renders identically
 * wherever it appears. A note has no workspace path and renders its id instead.
 *
 * @param item - Item to render.
 * @returns One `- [kind] locus @Lx-y: summary` line.
 */
export const renderContextItem: (item: ContextItem) => string = (item: ContextItem): string => {
    const locus: string = item.path.length === 0 ? item.id : item.path;
    const range: string = item.range === (void 0) ? "" : ` @L${item.range.startLine}-${item.range.endLine}`;
    return `- [${item.kind}] ${locus}${range}: ${item.summary}`;
};

/**
 * Render one relation as a single prompt line.
 *
 * @param relation - Relation to render.
 * @returns One `- [relation:kind] from -> to` line.
 */
export const renderContextRelation: (relation: ContextRelation) => string = (relation: ContextRelation): string => {
    return `- [relation:${relation.kind}] ${relation.from} -> ${relation.to}`;
};

/**
 * Ordered item list used by the envelope's read-only fields.
 */
type ItemList = readonly ContextItem[];

/**
 * Ordered relation list used by the envelope's read-only fields.
 */
type RelationList = readonly ContextRelation[];

/**
 * Render the complete prompt text for a selection.
 *
 * Items come first and relations second, each in the order the builder already
 * sorted. The empty selection renders to an empty string, not to a placeholder.
 *
 * @param items - Selected items in prompt order.
 * @param relations - Emitted relations in prompt order.
 * @returns Newline-joined prompt text.
 */
export const renderContextPackageText: (items: ItemList, relations: RelationList) => string = (items: ItemList, relations: RelationList): string => {
    const lines: string[] = [];
    items.forEach((item: ContextItem): void => {
        lines.push(renderContextItem(item));
    });
    relations.forEach((relation: ContextRelation): void => {
        lines.push(renderContextRelation(relation));
    });
    return lines.join("\n");
};

/**
 * Deep-freeze one item, including its range.
 *
 * @param item - Item to freeze.
 * @returns The frozen item.
 */
const freezeContextItem: (item: ContextItem) => ContextItem = (item: ContextItem): ContextItem => {
    const range: ContextRange | undefined =
        item.range === (void 0) ? (void 0) : Object.freeze({ startLine: item.range.startLine, endLine: item.range.endLine });
    return Object.freeze({ ...item, ...(range === (void 0) ? {} : { range }) });
};

/**
 * Freeze one omission and its required ID list.
 *
 * @param omission - Omission to freeze.
 * @returns The frozen omission.
 */
const freezeContextOmission: (omission: ContextOmission) => ContextOmission = (omission: ContextOmission): ContextOmission => {
    return Object.freeze({
        id: omission.id,
        reason: omission.reason,
        ...(omission.requiredIds === (void 0) ? {} : { requiredIds: Object.freeze([...omission.requiredIds]) }),
    });
};

/**
 * Freeze one relation.
 *
 * @param relation - Relation to freeze.
 * @returns The frozen relation.
 */
const freezeContextRelation: (relation: ContextRelation) => ContextRelation = (relation: ContextRelation): ContextRelation => {
    return Object.freeze({ from: relation.from, to: relation.to, kind: relation.kind });
};

/**
 * Deep-freeze a package so a caller cannot edit the prompt after allocation.
 *
 * `Object.freeze` is shallow, so the arrays and every nested object are frozen
 * explicitly. The input is not mutated: the result is a new object graph.
 *
 * @param input - Complete package produced by the builder.
 * @returns A deeply frozen package with the same values.
 */
export const freezeContextPackage: (input: ContextPackage) => ContextPackage = (input: ContextPackage): ContextPackage => {
    return Object.freeze({
        sessionId: input.sessionId,
        revision: input.revision,
        budgetTokens: input.budgetTokens,
        usedTokens: input.usedTokens,
        items: Object.freeze(input.items.map((item: ContextItem): ContextItem => freezeContextItem(item))),
        omitted: Object.freeze(input.omitted.map((omission: ContextOmission): ContextOmission => freezeContextOmission(omission))),
        relations: Object.freeze(input.relations.map((relation: ContextRelation): ContextRelation => freezeContextRelation(relation))),
        text: input.text,
        truncated: input.truncated,
    });
};
