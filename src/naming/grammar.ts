/**
 * Naming grammar: parser and formatter for `amp_<kind>_<component>[_<leaf>]`.
 *
 * The invariant is that a name is never accepted by convention. If `parseId`
 * returns an id, every structural budget (total length, segment shape, reserved
 * words and kind-specific leaf count) has been enforced, and `formatId` runs
 * the same validation before it returns a string. Formatting is therefore
 * closed over parsing: `parseId(formatId(kind, component, leaf))` always
 * reproduces the same kind, component and leaf.
 */

import { MaxComponentLength, MaxIdLength, MaxLeafSegments, Namespace } from "./ids.ts";
import type { Id, IdKind } from "./ids.ts";

const Prefix: string = `${Namespace}_`;

const SegmentPattern: RegExp = /^[a-z][a-z0-9]*$/;

const ReservedComponents: ReadonlySet<string> = new Set<string>(["protocol", "service", "tool"]);

/**
 * Stable, machine-readable rejection.
 *
 * Callers branch on `code` (for example to distinguish `missing-leaf` from an
 * unknown tool) instead of matching human-readable messages, which are allowed
 * to change for readability.
 */
export class NamingError extends Error {
    /**
     * Stable reason code such as `empty-segment` or `missing-leaf`.
     */
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "NamingError";
        this.code = code;
    }
}

/**
 * Throw a naming rejection without repeating `new NamingError` at every guard.
 *
 * The `never` return type lets TypeScript treat every guard as terminating, so
 * the happy path needs no defensive re-checks.
 */
const reject: (code: string, message: string) => never = (code: string, message: string): never => {
    throw new NamingError(code, message);
};

/**
 * Closed kind check for a token taken out of a name or passed by a JavaScript
 * caller that bypassed the type system.
 */
const isIdKind: (text: string) => text is IdKind = (text: string): text is IdKind => {
    return text === "protocol" || text === "service" || text === "tool";
};

/**
 * Segment shape check shared by the parser and the formatter.
 *
 * Returning the code instead of throwing keeps the caller in charge of which
 * part of the name appears in the diagnostic; the rule itself lives in exactly
 * one place.
 */
const segmentProblem: (segment: string) => string | undefined = (segment: string): string | undefined => {
    if (segment.length === 0) {
        return "empty-segment";
    }
    if (!SegmentPattern.test(segment)) {
        return "illegal-character";
    }
    return undefined;
};

/**
 * Reserved component words would make parsing ambiguous: `amp_tool_protocol_x`
 * could be read as either kind `tool` / component `protocol` or kind
 * `protocol` with a malformed prefix. Rejecting them keeps the grammar
 * token-position based, with no lookup table needed at parse time.
 */
export const isReservedComponent: (component: string) => boolean = (component: string): boolean => {
    return ReservedComponents.has(component);
};

/**
 * Parse a name or throw a `NamingError`.
 *
 * Parsing deliberately consults no registry: a new component or leaf works
 * without editing this file, while the format budgets keep every accepted name
 * inside the wire limits. Errors carry stable codes so dispatch code can tell a
 * malformed name from an unregistered one.
 *
 * `protocol` and `service` ids take no leaf; `tool` ids take one or two leaf
 * segments. A tool with no leaf is `missing-leaf`, and any kind with more than
 * two leaf segments is `too-many-segments`.
 */
export const parseId: (text: string) => Id = (text: string): Id => {
    if (text.length > MaxIdLength) {
        reject("too-long", `id exceeds ${MaxIdLength} characters: "${text}" is ${text.length}`);
    }
    if (!text.startsWith(Prefix)) {
        reject("missing-prefix", `id must start with "${Prefix}": "${text}"`);
    }
    const rest: string = text.slice(Prefix.length);
    if (rest.length === 0) {
        reject("empty-segment", `id "${text}" has no component`);
    }
    const tokens: string[] = rest.split("_");
    const kindToken: string = tokens[0];
    if (!isIdKind(kindToken)) {
        reject("unknown-kind", `unknown id kind "${kindToken}" in "${text}"`);
    }
    const component: string = tokens.length > 1 ? tokens[1] : "";
    if (component.length === 0) {
        reject("empty-segment", `empty component segment in "${text}"`);
    }
    if (component.length > MaxComponentLength) {
        reject("component-too-long", `component "${component}" exceeds ${MaxComponentLength} characters`);
    }
    const componentProblem: string | undefined = segmentProblem(component);
    if (componentProblem !== (void 0)) {
        reject(componentProblem, `invalid component segment "${component}" in "${text}"`);
    }
    if (isReservedComponent(component)) {
        reject("reserved-component", `component "${component}" is reserved in "${text}"`);
    }
    const leaf: string[] = tokens.slice(2);
    if (leaf.length > MaxLeafSegments) {
        reject("too-many-segments", `id "${text}" has ${leaf.length} leaf segments, at most ${MaxLeafSegments} allowed`);
    }
    for (let index: number = 0; index < leaf.length; index += 1) {
        const segment: string = leaf[index];
        const problem: string | undefined = segmentProblem(segment);
        if (problem !== (void 0)) {
            reject(problem, `invalid leaf segment "${segment}" in "${text}"`);
        }
    }
    if (kindToken === "tool") {
        if (leaf.length === 0) {
            reject("missing-leaf", `tool id "${text}" has no leaf segment`);
        }
    } else if (leaf.length > 0) {
        reject("unexpected-leaf", `${kindToken} id "${text}" must not carry a leaf`);
    }
    return { text, kind: kindToken, component, leaf };
};

/**
 * Non-throwing probe for boundary code that only needs a yes/no answer.
 *
 * Only `NamingError` is swallowed: a genuine programmer error (for example a
 * broken regular expression) must not be silently reported as "invalid id".
 */
export const tryParseId: (text: string) => Id | undefined = (text: string): Id | undefined => {
    try {
        return parseId(text);
    } catch (error) {
        if (error instanceof NamingError) {
            return undefined;
        }
        throw error;
    }
};

/**
 * Build a name from its parts, or throw instead of producing an unparseable or
 * ambiguous string.
 *
 * Each part is validated before concatenation. That matters: an unchecked
 * component such as `work_shop` would concatenate into a perfectly parseable id
 * whose component is `work` and whose leaf starts with `shop`, so validating
 * only the finished string would silently change the caller's intent. The
 * length check happens last because it depends on all parts.
 */
export const formatId: (kind: IdKind, component: string, leaf?: readonly string[]) => string = (kind: IdKind, component: string, leaf?: readonly string[]): string => {
    if (!isIdKind(kind)) {
        reject("unknown-kind", `unknown id kind "${kind}"`);
    }
    if (component.length === 0) {
        reject("empty-segment", "component must not be empty");
    }
    if (component.length > MaxComponentLength) {
        reject("component-too-long", `component "${component}" exceeds ${MaxComponentLength} characters`);
    }
    const componentProblem: string | undefined = segmentProblem(component);
    if (componentProblem !== (void 0)) {
        reject(componentProblem, `invalid component segment "${component}"`);
    }
    if (isReservedComponent(component)) {
        reject("reserved-component", `component "${component}" is reserved`);
    }
    const segments: readonly string[] = leaf === (void 0) ? [] : leaf;
    if (segments.length > MaxLeafSegments) {
        reject("too-many-segments", `${segments.length} leaf segments requested, at most ${MaxLeafSegments} allowed`);
    }
    for (let index: number = 0; index < segments.length; index += 1) {
        const segment: string = segments[index];
        const problem: string | undefined = segmentProblem(segment);
        if (problem !== (void 0)) {
            reject(problem, `invalid leaf segment "${segment}"`);
        }
    }
    if (kind === "tool") {
        if (segments.length === 0) {
            reject("missing-leaf", "tool id requires a leaf segment");
        }
    } else if (segments.length > 0) {
        reject("unexpected-leaf", `${kind} id must not carry a leaf`);
    }
    const suffix: string = segments.length === 0 ? "" : `_${segments.join("_")}`;
    const text: string = `${Prefix}${kind}_${component}${suffix}`;
    if (text.length > MaxIdLength) {
        reject("too-long", `formatted id exceeds ${MaxIdLength} characters: "${text}" is ${text.length}`);
    }
    return text;
};

/**
 * True exactly when `parseId` would return, for guards that must not throw.
 */
export const isId: (text: string) => boolean = (text: string): boolean => {
    return tryParseId(text) !== (void 0);
};
