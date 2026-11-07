import type {
    IsolationChange,
    IsolationMergeConflict,
    IsolationMergeReceipt,
    IsolationMergeResult,
    IsolationMergedContent,
    IsolationSyntaxFinding,
    IsolationSyntaxValidator,
    IsolationTextEdit,
} from "./types.ts";

const fail = (message: string): never => {
    throw new TypeError(message);
};
const text = (value: unknown, field: string): string => typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);
const nonNegativeInteger = (value: unknown, field: string): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fail(`${field} must be a nonnegative safe integer`);

const hex = (value: number): string => (value >>> 0).toString(16).padStart(8, "0");

/**
 * Deterministic 64-bit FNV-1a-style digest used for content identity and receipt ids.
 * Two independent 32-bit lanes avoid a runtime `node:crypto` dependency.
 */
export const contentHash = (value: string): string => {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        first ^= code;
        first = Math.imul(first, 0x01000193);
        second ^= code + index;
        second = Math.imul(second, 0x85ebca6b);
    }
    return `fnv1a64:${hex(first)}${hex(second)}`;
};

const hashKey = (value: string): string => value.includes(":") ? value.slice(value.indexOf(":") + 1) : value;

const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|jsonc?|css|scss|less|html?|xhtml|svg|xml|ya?ml|toml|ini|py|pyi|rs|go|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|hh|cs|rb|php|pl|sh|bash|zsh|fish|ps1|sql|vue|svelte|astro|mdx)$/i;

/**
 * Lightweight delimiter/string balance check used when a semantic merge produces
 * code-shaped text. It is deliberately not an AST parser: hosts can inject a
 * parser-backed `IsolationSyntaxValidator` through adapter options.
 */
export const balancedSyntaxValidator: IsolationSyntaxValidator = (resourceId, content) => {
    if (!CODE_EXTENSIONS.test(resourceId)) return { resourceId, valid: true };
    const pairs: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
    const stack: { readonly char: string; readonly index: number }[] = [];
    let quote: string | undefined;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = 0; index < content.length; index += 1) {
        const char = content[index] as string;
        const next = content[index + 1];
        if (lineComment) {
            if (char === "\n") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === "*" && next === "/") {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote !== undefined) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === quote) quote = undefined;
            continue;
        }
        if (char === "/" && next === "/") {
            lineComment = true;
            index += 1;
            continue;
        }
        if (char === "/" && next === "*") {
            blockComment = true;
            index += 1;
            continue;
        }
        if (char === "\"" || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === "(" || char === "[" || char === "{") {
            stack.push({ char, index });
            continue;
        }
        if (char === ")" || char === "]" || char === "}") {
            const open = stack.pop();
            if (open === undefined || open.char !== pairs[char]) {
                return { resourceId, valid: false, reason: `unbalanced ${char} at offset ${index}` };
            }
        }
    }
    if (quote !== undefined) return { resourceId, valid: false, reason: `unterminated ${quote} literal` };
    if (blockComment) return { resourceId, valid: false, reason: "unterminated block comment" };
    if (stack.length > 0) {
        const open = stack[stack.length - 1] as { readonly char: string; readonly index: number };
        return { resourceId, valid: false, reason: `unclosed ${open.char} at offset ${open.index}` };
    }
    return { resourceId, valid: true };
};

export type IsolationMergeOptions = {
    /** Epoch milliseconds used by the merge receipt timestamp. */
    readonly clock?: () => number;
    readonly syntaxValidator?: IsolationSyntaxValidator;
};

const conflict = (reason: IsolationMergeConflict["reason"], change: IsolationChange, detail: string, changeIds?: readonly string[], agents?: readonly string[]): IsolationMergeConflict => Object.freeze({
    reason,
    resourceId: change.resourceId,
    changeIds: Object.freeze(changeIds ?? [change.changeId]),
    agents: Object.freeze(agents ?? [change.agentId]),
    detail,
});

const validateChange = (change: IsolationChange): void => {
    if (change === null || typeof change !== "object") fail("Isolation change must be an object");
    text(change.changeId, "Isolation change changeId");
    text(change.cooperationId, "Isolation change cooperationId");
    text(change.agentId, "Isolation change agentId");
    text(change.resourceId, "Isolation change resourceId");
    if (change.region !== undefined) validateRegion(change.region, `Isolation change region for ${change.changeId}`);
    if (change.baseContent !== undefined && typeof change.baseContent !== "string") fail(`Isolation change baseContent for ${change.changeId} must be a string`);
    if (change.baseHash !== undefined) text(change.baseHash, `Isolation change baseHash for ${change.changeId}`);
    if (change.edits !== undefined) {
        if (!Array.isArray(change.edits)) fail(`Isolation change edits for ${change.changeId} must be an array`);
        for (const edit of change.edits) validateEdit(edit, `Isolation change edit for ${change.changeId}`);
    }
};

const validateRegion = (region: { readonly start: number; readonly end: number }, field: string): void => {
    if (region === null || typeof region !== "object") fail(`${field} must be an object`);
    if (!Number.isSafeInteger(region.start) || region.start < 0) fail(`${field}.start must be a nonnegative safe integer`);
    if (!Number.isSafeInteger(region.end) || region.end < region.start) fail(`${field}.end must be a safe integer >= start`);
};

const validateEdit = (edit: IsolationTextEdit, field: string): void => {
    if (edit === null || typeof edit !== "object") fail(`${field} must be an object`);
    nonNegativeInteger(edit.start, `${field}.start`);
    nonNegativeInteger(edit.end, `${field}.end`);
    if (edit.end < edit.start) fail(`${field}.end must be >= start`);
    if (typeof edit.replacement !== "string") fail(`${field}.replacement must be a string`);
};

const regionsOverlap = (left: { readonly start: number; readonly end: number }, right: { readonly start: number; readonly end: number }): boolean => left.start < right.end && right.start < left.end;

const groupKey = (change: IsolationChange): string => `${change.cooperationId}\u0000${change.resourceId}`;

type SemanticGroup = {
    readonly changes: readonly IsolationChange[];
    readonly cooperationId: string;
    readonly resourceId: string;
};

const semanticContent = (
    group: SemanticGroup,
    syntaxValidator: IsolationSyntaxValidator,
    conflicts: IsolationMergeConflict[],
    syntax: IsolationSyntaxFinding[],
): IsolationMergedContent | undefined => {
    const changes = group.changes;
    const decorated = changes.filter(change => change.baseContent !== undefined);
    const bases = [...new Set(decorated.map(change => change.baseContent as string))];
    if (bases.length > 1) {
        conflicts.push(conflict("base_conflict", decorated[0] as IsolationChange, `changes for ${group.resourceId} use different baseContent values`));
        return undefined;
    }
    const base = bases[0];
    if (base !== undefined) {
        for (const change of changes) {
            if (change.baseHash !== undefined && hashKey(change.baseHash) !== hashKey(contentHash(base))) {
                conflicts.push(conflict("base_conflict", change, `baseHash does not match baseContent for ${group.resourceId}`));
                return undefined;
            }
        }
    }
    const hasEdits = changes.some(change => change.edits !== undefined && change.edits.length > 0);
    if (base === undefined) {
        if (hasEdits) {
            conflicts.push(conflict("base_conflict", changes[0] as IsolationChange, `semantic edits for ${group.resourceId} require baseContent`));
            return undefined;
        }
        if (changes.length === 1) {
            const value = changes[0]?.value;
            if (typeof value === "string") return buildContent(group.resourceId, value, syntaxValidator, syntax);
        }
        return undefined;
    }

    const edits: { readonly edit: IsolationTextEdit; readonly change: IsolationChange }[] = [];
    let wholeReplacement: { readonly content: string; readonly change: IsolationChange } | undefined;
    for (const change of changes) {
        if (change.edits !== undefined) {
            for (const edit of change.edits) {
                if (edit.end > base.length) {
                    conflicts.push(conflict("invalid_edit", change, `edit [${edit.start}, ${edit.end}) exceeds base length ${base.length} for ${group.resourceId}`));
                    return undefined;
                }
                if (change.region !== undefined && (edit.start < change.region.start || edit.end > change.region.end)) {
                    conflicts.push(conflict("invalid_edit", change, `edit [${edit.start}, ${edit.end}) lies outside declared region for ${group.resourceId}`));
                    return undefined;
                }
                edits.push({ edit, change });
            }
        } else if (typeof change.value === "string" && change.region === undefined) {
            if (wholeReplacement !== undefined) {
                conflicts.push(conflict("resource_conflict", change, `multiple whole-content replacements for ${group.resourceId}`, [wholeReplacement.change.changeId, change.changeId], [wholeReplacement.change.agentId, change.agentId]));
                return undefined;
            }
            wholeReplacement = { content: change.value, change };
        }
    }
    if (wholeReplacement !== undefined && edits.length > 0) {
        conflicts.push(conflict("resource_conflict", wholeReplacement.change, `whole-content replacement cannot be merged with region edits for ${group.resourceId}`));
        return undefined;
    }
    if (wholeReplacement !== undefined) return buildContent(group.resourceId, wholeReplacement.content, syntaxValidator, syntax);

    edits.sort((left, right) => left.edit.start - right.edit.start || left.edit.end - right.edit.end);
    for (let index = 1; index < edits.length; index += 1) {
        const previous = edits[index - 1] as { readonly edit: IsolationTextEdit; readonly change: IsolationChange };
        const current = edits[index] as { readonly edit: IsolationTextEdit; readonly change: IsolationChange };
        if (current.edit.start < previous.edit.end) {
            conflicts.push(conflict(
                "edit_overlap",
                current.change,
                `edits overlap on ${group.resourceId}: [${previous.edit.start}, ${previous.edit.end}) and [${current.edit.start}, ${current.edit.end})`,
                [previous.change.changeId, current.change.changeId],
                [previous.change.agentId, current.change.agentId],
            ));
            return undefined;
        }
    }
    let merged = base;
    for (let index = edits.length - 1; index >= 0; index -= 1) {
        const entry = edits[index] as { readonly edit: IsolationTextEdit; readonly change: IsolationChange };
        merged = merged.slice(0, entry.edit.start) + entry.edit.replacement + merged.slice(entry.edit.end);
    }
    return buildContent(group.resourceId, merged, syntaxValidator, syntax);
};

const buildContent = (resourceId: string, content: string, syntaxValidator: IsolationSyntaxValidator, syntax: IsolationSyntaxFinding[]): IsolationMergedContent => {
    try {
        syntax.push(syntaxValidator(resourceId, content));
    } catch (error) {
        syntax.push({ resourceId, valid: false, reason: `syntax validator failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    return Object.freeze({ resourceId, content, hash: contentHash(content), bytes: new TextEncoder().encode(content).byteLength });
};

/**
 * Metadata + semantic merge. Metadata conflicts (duplicate ids, overlapping regions,
 * conflicting whole-resource writes) are detected first. When all changes for a
 * resource share a `baseContent`, non-overlapping `edits` are applied and the result
 * is syntax-checked. Conflicts are atomic: `merged` is empty if any conflict exists.
 */
export const mergeIsolationChanges = (changes: readonly IsolationChange[], options: IsolationMergeOptions = {}): IsolationMergeResult => {
    if (!Array.isArray(changes)) fail("Isolation merge changes must be an array");
    const conflicts: IsolationMergeConflict[] = [];
    const syntax: IsolationSyntaxFinding[] = [];
    const contents: IsolationMergedContent[] = [];
    const unique = new Map<string, IsolationChange>();
    const duplicateIds = new Set<string>();
    for (const change of changes) {
        validateChange(change);
        const existing = unique.get(change.changeId);
        if (existing !== undefined) {
            if (!duplicateIds.has(change.changeId)) {
                duplicateIds.add(change.changeId);
                conflicts.push(conflict("duplicate_change", change, `duplicate isolation change id: ${change.changeId}`, [change.changeId], [existing.agentId, change.agentId]));
            }
            continue;
        }
        unique.set(change.changeId, change);
    }
    const groups = new Map<string, IsolationChange[]>();
    for (const change of unique.values()) {
        const key = groupKey(change);
        const group = groups.get(key);
        if (group === undefined) groups.set(key, [change]);
        else group.push(change);
    }
    if (conflicts.length === 0) {
        for (const groupChanges of groups.values()) {
            for (let left = 0; left < groupChanges.length; left += 1) {
                for (let right = left + 1; right < groupChanges.length; right += 1) {
                    const first = groupChanges[left] as IsolationChange;
                    const second = groupChanges[right] as IsolationChange;
                    if (first.agentId === second.agentId) continue;
                    if (first.region !== undefined && second.region !== undefined) {
                        if (!regionsOverlap(first.region, second.region)) continue;
                        conflicts.push(conflict("region_overlap", first, `region changes overlap on ${first.resourceId}`, [first.changeId, second.changeId], [first.agentId, second.agentId]));
                        continue;
                    }
                    conflicts.push(conflict("resource_conflict", first, `different agents changed the whole resource ${first.resourceId}`, [first.changeId, second.changeId], [first.agentId, second.agentId]));
                }
            }
        }
    }
    if (conflicts.length === 0) {
        const validator = options.syntaxValidator ?? balancedSyntaxValidator;
        for (const groupChanges of groups.values()) {
            const first = groupChanges[0] as IsolationChange;
            const merged = semanticContent({
                changes: groupChanges,
                cooperationId: first.cooperationId,
                resourceId: first.resourceId,
            }, validator, conflicts, syntax);
            if (merged !== undefined) contents.push(merged);
        }
    }
    for (const groupChanges of groups.values()) {
        const first = groupChanges[0] as IsolationChange;
        const finding = syntax.find(entry => entry.resourceId === first.resourceId);
        if (finding !== undefined && !finding.valid) {
            conflicts.push(conflict("syntax_invalid", first, finding.reason ?? `syntax validation failed for ${first.resourceId}`));
        }
    }
    const mergedChanges = conflicts.length === 0 ? changes.map(change => structuredClone(change)) : [];
    const cooperationId = changes.length === 0 ? "unknown" : (changes[0] as IsolationChange).cooperationId;
    const receiptBase = {
        kind: "merge_receipt" as const,
        cooperationId,
        mergedChangeIds: conflicts.length === 0 ? [...unique.keys()] : [],
        conflictCount: conflicts.length,
        contents: contents.map(content => Object.freeze({ resourceId: content.resourceId, hash: content.hash, bytes: content.bytes })),
        syntaxChecked: syntax.length > 0,
        syntaxValid: syntax.every(finding => finding.valid),
    };
    const clock = options.clock ?? (() => Date.now());
    const mergedAt = new Date(clock()).toISOString();
    const receipt: IsolationMergeReceipt | undefined = changes.length === 0 ? undefined : Object.freeze({
        ...receiptBase,
        receiptId: `merge-receipt:${contentHash(JSON.stringify({ ...receiptBase, mergedAt }))}`,
        mergedAt,
    });
    return Object.freeze({
        merged: Object.freeze(mergedChanges),
        conflicts: Object.freeze(conflicts),
        contents: Object.freeze(contents),
        syntax: Object.freeze(syntax),
        ...(receipt === undefined ? {} : { receipt }),
    });
};
