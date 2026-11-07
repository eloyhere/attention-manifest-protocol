import { isString } from "semantic-typescript";
import { SourceText } from "./range.ts";
import type {
    ByteTarget, DiffHunk, EditMatch, LineTarget, OutlineProvider, OutlineTarget, RegexTarget, ReplaceTarget, StringTarget, WriteTarget,
} from "./types.ts";
import { WorkspaceError } from "../workspace/types.ts";

/** Character span in the buffer, `end` exclusive. */
export interface Region {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

const MAX_MATCHES = 5000;

export function isWriteTarget(value: unknown): value is WriteTarget {
    if (typeof value !== "object" || value === null || !("mode" in value)) return false;
    const mode = (value as { mode?: unknown }).mode;
    return mode === "line" || mode === "byte" || mode === "outline";
}

export function isReplaceTarget(value: unknown): value is ReplaceTarget {
    if (typeof value !== "object" || value === null || !("mode" in value)) return false;
    const mode = (value as { mode?: unknown }).mode;
    return mode === "line" || mode === "byte" || mode === "outline" || mode === "string" || mode === "regex";
}

function targetMode(target: ReplaceTarget): ReplaceTarget["mode"] {
    if (typeof target !== "object" || target === null || !isString((target as { mode?: unknown }).mode)) {
        throw new WorkspaceError("invalid_target", "edit target must be an object with a mode");
    }
    return target.mode;
}

function checkedBounds(start: unknown, end: unknown, limit: number): { start: number; end: number } {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        throw new WorkspaceError("invalid_range", "target bounds must be safe integers");
    }
    const from = start as number;
    const to = end as number;
    if (from < 0 || to < from || to > limit) throw new WorkspaceError("invalid_range", `target range ${from}..${to} is outside 0..${limit}`);
    return { start: from, end: to };
}

/** UTF-8 byte offset to UTF-16 index; rejects offsets inside a multi-byte code point. */
export function byteToCharIndex(content: string, byteOffset: number): number {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) throw new WorkspaceError("invalid_range", "byte offset must be a nonnegative safe integer");
    let bytes = 0;
    for (let index = 0; index < content.length;) {
        if (bytes === byteOffset) return index;
        const point = content.codePointAt(index) ?? 0;
        const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (bytes + width > byteOffset) throw new WorkspaceError("invalid_range", `byte offset ${byteOffset} is inside a UTF-8 code point`);
        bytes += width;
        index += point > 0xffff ? 2 : 1;
    }
    if (bytes === byteOffset) return content.length;
    throw new WorkspaceError("invalid_range", `byte offset ${byteOffset} exceeds the buffer`);
}

function lineSpan(content: string, target: LineTarget): Region {
    const text = new SourceText(content);
    const bounds = checkedBounds(target.start, target.end, text.lineCount);
    const start = bounds.start >= text.lineCount ? content.length : (text.lineStarts[bounds.start] ?? content.length);
    const end = bounds.end >= text.lineCount ? content.length : (text.lineStarts[bounds.end] ?? content.length);
    return { start, end, text: content.slice(start, end) };
}

function byteSpan(content: string, target: ByteTarget): Region {
    const limit = Buffer.byteLength(content, "utf8");
    const bounds = checkedBounds(target.start, target.end, limit);
    const start = byteToCharIndex(content, bounds.start);
    const end = byteToCharIndex(content, bounds.end);
    return { start, end, text: content.slice(start, end) };
}

function outlineSpan(content: string, target: OutlineTarget, outline: OutlineProvider | undefined, path: string): Region {
    if (!isString(target.id) || !target.id.trim()) throw new WorkspaceError("invalid_target", "outline target needs a node id");
    if (!outline) throw new WorkspaceError("outline_unavailable", "outline editing requires an outline provider on the mount");
    const entry = outline.entries(path, content).find(candidate => candidate.id === target.id);
    if (!entry) throw new WorkspaceError("not_found", `outline node ${target.id} is not present in the current buffer`);
    const start = byteToCharIndex(content, entry.range.startByte);
    const end = byteToCharIndex(content, entry.range.endByte);
    return { start, end, text: content.slice(start, end) };
}

function stringRegions(content: string, target: StringTarget): Region[] {
    if (!isString(target.text) || target.text === "") throw new WorkspaceError("invalid_target", "string target must be nonempty text");
    const regions: Region[] = [];
    let cursor = 0;
    while (regions.length <= MAX_MATCHES) {
        const index = content.indexOf(target.text, cursor);
        if (index < 0) break;
        regions.push({ start: index, end: index + target.text.length, text: target.text });
        cursor = index + target.text.length;
    }
    if (regions.length > MAX_MATCHES) throw new WorkspaceError("invalid_target", `string target matches more than ${MAX_MATCHES} times`);
    return regions;
}

interface RegexRegion extends Region { readonly groups: readonly string[]; readonly named: Readonly<Record<string, string>> }

function regexRegions(content: string, target: RegexTarget): RegexRegion[] {
    if (!isString(target.pattern) || target.pattern === "") throw new WorkspaceError("invalid_target", "regex target must be a nonempty pattern");
    const flags = target.flags ?? "";
    if (!/^[imsuv]*$/.test(flags)) throw new WorkspaceError("invalid_target", `unsupported regex flags "${flags}"; g and y are managed internally`);
    let expression: RegExp;
    try {
        expression = new RegExp(target.pattern, `${flags}g`);
    } catch (error) {
        throw new WorkspaceError("invalid_target", `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    const regions: RegexRegion[] = [];
    for (let match = expression.exec(content); match !== null; match = expression.exec(content)) {
        if (match[0] === "") throw new WorkspaceError("invalid_target", "regex target matched an empty string; use an explicit boundary");
        regions.push({ start: match.index, end: match.index + match[0].length, text: match[0],
            groups: Object.freeze([...match]), named: Object.freeze({ ...(match.groups ?? {}) }) });
        if (regions.length > MAX_MATCHES) throw new WorkspaceError("invalid_target", `regex target matches more than ${MAX_MATCHES} times`);
    }
    return regions;
}

export function resolveRegions(content: string, target: ReplaceTarget, outline: OutlineProvider | undefined, path: string): Region[] {
    switch (targetMode(target)) {
        case "line": return [lineSpan(content, target as LineTarget)];
        case "byte": return [byteSpan(content, target as ByteTarget)];
        case "outline": return [outlineSpan(content, target as OutlineTarget, outline, path)];
        case "string": return stringRegions(content, target as StringTarget);
        case "regex": return regexRegions(content, target as RegexTarget);
        default: throw new WorkspaceError("invalid_target", `unsupported edit mode ${String((target as { mode?: unknown }).mode)}`);
    }
}

/** Exact, literal substitution: `$` sequences are not interpreted. */
export function literalReplacement(replacement: string): (region: Region) => string {
    return () => replacement;
}

/** Expands `$$`, `$&`, `` $` ``, `$'`, `$1`-`$99` and `$<name>` for regex replacements. */
export function regexReplacement(replacement: string, content: string): (region: Region) => string {
    return region => {
        const groups = (region as RegexRegion).groups;
        return replacement.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (_token, key: string) => {
            if (key === "$") return "$";
            if (key === "&") return region.text;
            if (key === "`") return content.slice(0, region.start);
            if (key === "'") return content.slice(region.end);
            if (key.startsWith("<")) return (region as RegexRegion).named[key.slice(1, -1)] ?? "";
            const group = Number(key);
            return groups[group] ?? "";
        });
    };
}

function describeAmbiguity(content: string, regions: readonly Region[]): string {
    const text = new SourceText(content);
    const lines = regions.slice(0, 8).map(region => text.lineAt(region.start) + 1);
    const suffix = regions.length > lines.length ? ", ..." : "";
    return `target matched ${regions.length} regions at lines ${lines.join(", ")}${suffix}; pass occurrence or all: true`;
}

/** Applies the uniqueness/occurrence contract shared by `string` and `regex` targets. */
export function selectRegions(content: string, regions: readonly Region[], target: StringTarget | RegexTarget): readonly Region[] {
    const all = target.all === true;
    const occurrence = target.occurrence;
    if (all && occurrence !== undefined) throw new WorkspaceError("invalid_target", "occurrence and all are mutually exclusive");
    if (occurrence !== undefined && (!Number.isSafeInteger(occurrence) || occurrence < 1)) {
        throw new WorkspaceError("invalid_target", "occurrence must be a positive integer");
    }
    if (regions.length === 0) throw new WorkspaceError("no_match", "target matched nothing in the current buffer");
    if (occurrence !== undefined) {
        const selected = regions[occurrence - 1];
        if (!selected) throw new WorkspaceError("no_match", `occurrence ${occurrence} exceeds ${regions.length} matches`);
        return [selected];
    }
    if (all) return regions;
    if (regions.length > 1) throw new WorkspaceError("ambiguous_match", describeAmbiguity(content, regions));
    return regions;
}

/** Splices regions in descending order so earlier offsets stay valid. */
export function spliceRegions(content: string, regions: readonly Region[], replacement: (region: Region, index: number) => string): string {
    const ordered = [...regions].sort((left, right) => right.start - left.start);
    let result = content;
    for (const [index, region] of ordered.entries()) {
        result = result.slice(0, region.start) + replacement(region, index) + result.slice(region.end);
    }
    return result;
}

/**
 * Line and byte writes keep the file's line structure: when the removed block ended
 * with a newline and the replacement does not, the newline is restored.
 */
export function structuralReplacement(content: string, region: Region, replacement: string): string {
    const endedWithNewline = region.end > region.start && content[region.end - 1] === "\n";
    return endedWithNewline && !replacement.endsWith("\n") ? `${replacement}\n` : replacement;
}

export function toEditMatches(content: string, regions: readonly Region[]): readonly EditMatch[] {
    const text = new SourceText(content);
    return Object.freeze(regions.map(region => Object.freeze({ ...text.range(region.start, region.end), text: region.text })));
}

type DiffLine = { readonly type: " " | "-" | "+"; readonly text: string; readonly beforeLine: number; readonly afterLine: number };

function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
    const rows = before.length;
    const columns = after.length;
    const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
    for (let row = rows - 1; row >= 0; row -= 1) {
        for (let column = columns - 1; column >= 0; column -= 1) {
            table[row]![column] = before[row] === after[column]
                ? table[row + 1]![column + 1]! + 1
                : Math.max(table[row + 1]![column]!, table[row]![column + 1]!);
        }
    }
    const output: DiffLine[] = [];
    let row = 0;
    let column = 0;
    while (row < rows && column < columns) {
        if (before[row] === after[column]) {
            output.push({ type: " ", text: before[row]!, beforeLine: row + 1, afterLine: column + 1 });
            row += 1;
            column += 1;
        } else if (table[row + 1]![column]! >= table[row]![column + 1]!) {
            output.push({ type: "-", text: before[row]!, beforeLine: row + 1, afterLine: column });
            row += 1;
        } else {
            output.push({ type: "+", text: after[column]!, beforeLine: row, afterLine: column + 1 });
            column += 1;
        }
    }
    while (row < rows) {
        output.push({ type: "-", text: before[row]!, beforeLine: row + 1, afterLine: column });
        row += 1;
    }
    while (column < columns) {
        output.push({ type: "+", text: after[column]!, beforeLine: row, afterLine: column + 1 });
        column += 1;
    }
    return output;
}

interface DiffGroup {
    readonly start: number;
    readonly end: number;
}

/** Merges changed line indexes into unified-diff hunk ranges over the op array. */
function diffGroups(ops: readonly DiffLine[], context: number): DiffGroup[] {
    const changed = ops.map((line, index) => line.type === " " ? -1 : index).filter(index => index >= 0);
    const groups: { start: number; end: number }[] = [];
    for (const index of changed) {
        const start = Math.max(0, index - context);
        const end = Math.min(ops.length, index + context + 1);
        const last = groups.at(-1);
        if (last && start <= last.end) last.end = Math.max(last.end, end);
        else groups.push({ start, end });
    }
    return groups;
}

/**
 * Structured view of the unified diff hunks. The grouping (3 context lines) is identical to
 * `unifiedDiff`; each hunk reports the changed lines only, using 0-based exclusive lines in
 * the base text and counts of removed/added lines.
 */
export function diffHunks(before: string, after: string, context = 3): readonly DiffHunk[] {
    if (before === after) return Object.freeze([]);
    const ops = diffLines(before.split("\n"), after.split("\n"));
    const output: DiffHunk[] = [];
    for (const group of diffGroups(ops, context)) {
        let removed = 0;
        let added = 0;
        let startLine = Number.POSITIVE_INFINITY;
        let endLine = -1;
        for (const op of ops.slice(group.start, group.end)) {
            if (op.type === "+") {
                added += 1;
                startLine = Math.min(startLine, op.beforeLine);
            } else if (op.type === "-") {
                removed += 1;
                startLine = Math.min(startLine, op.beforeLine - 1);
                endLine = Math.max(endLine, op.beforeLine);
            }
        }
        if (!Number.isFinite(startLine)) continue;
        output.push(Object.freeze({ startLine, endLine: endLine < 0 ? startLine : endLine, removed, added }));
    }
    return Object.freeze(output);
}

/** Unified diff with 3 context lines; returns "" when the texts are identical. */
export function unifiedDiff(before: string, after: string, fromLabel = "a", toLabel = "b", context = 3): string {
    if (before === after) return "";
    const ops = diffLines(before.split("\n"), after.split("\n"));
    const hunks = diffGroups(ops, context);
    if (hunks.length === 0) return "";
    const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
    for (const hunk of hunks) {
        const slice = ops.slice(hunk.start, hunk.end);
        const beforeCount = slice.filter(line => line.type !== "+").length;
        const afterCount = slice.filter(line => line.type !== "-").length;
        const beforeStart = slice.find(line => line.type !== "+")?.beforeLine ?? 0;
        const afterStart = slice.find(line => line.type !== "-")?.afterLine ?? 0;
        lines.push(`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`);
        lines.push(...slice.map(line => `${line.type}${line.text}`));
    }
    return lines.join("\n");
}
