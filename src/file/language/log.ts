import type { OutlineParserPort, ParsedOutlineNode } from "../outline.ts";
import type { LanguageDefinition } from "./types.ts";

/**
 * Log-file outline.
 *
 * Groups a log by calendar day, then by severity, then by individual entry.
 * Supported timestamp shapes: ISO (`2026-11-07T12:34:56.789Z`) and the common
 * `2026-11-07 12:34:56,789` form; syslog (`Nov  7 12:34:56`) and bare level
 * lines (`ERROR ...`, `[warn] ...`) are also recognised. Continuation lines
 * (stack traces, wrapped messages) attach to the preceding entry.
 */

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?/;
const SYSLOG = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/;
const LEVEL = /\b(FATAL|CRITICAL|SEVERE|ERROR|WARN|WARNING|NOTICE|INFO|DEBUG|TRACE)\b/i;
const BRACKET_LEVEL = /^\[(FATAL|CRITICAL|SEVERE|ERROR|WARN|WARNING|NOTICE|INFO|DEBUG|TRACE)\]/i;

const CANONICAL: Readonly<Record<string, string>> = Object.freeze({
    FATAL: "FATAL", CRITICAL: "FATAL", SEVERE: "FATAL",
    ERROR: "ERROR", WARN: "WARN", WARNING: "WARN",
    NOTICE: "INFO", INFO: "INFO", DEBUG: "DEBUG", TRACE: "TRACE",
});

const MAX_ENTRIES = 5000;
const MAX_ENTRIES_PER_LEVEL = 200;
const MAX_NAME = 120;
const MAX_SUMMARY = 400;

interface Line {
    readonly line: number;
    readonly text: string;
    readonly startByte: number;
    readonly endByte: number;
}

interface Entry {
    date: string;
    time: string;
    level: string;
    message: string;
    readonly startLine: number;
    endLine: number;
    readonly startByte: number;
    endByte: number;
}

function lines(source: string): readonly Line[] {
    const result: Line[] = [];
    let start = 0;
    let byte = 0;
    let line = 0;
    for (let index = 0; index <= source.length; index += 1) {
        if (index === source.length || source[index] === "\n") {
            const text = source.slice(start, index);
            const length = Buffer.byteLength(text, "utf8");
            result.push({ line, text, startByte: byte, endByte: byte + length });
            byte += length + 1;
            start = index + 1;
            line += 1;
        }
    }
    return result;
}

function messageAfter(line: string, index: number): string {
    return line.slice(index).replace(/^[\s:|\-–—]+/, "").trim();
}

function parseTimestamp(text: string): { readonly date: string; readonly time: string; readonly end: number } | undefined {
    const iso = TIMESTAMP.exec(text);
    if (iso !== null) {
        return { date: iso[1]!, time: `${iso[2]}:${iso[3]}:${iso[4]}`, end: iso[0].length };
    }
    const syslog = SYSLOG.exec(text);
    if (syslog !== null) {
        const date = `${syslog[1]} ${syslog[2]!.padStart(2, "0")}`;
        return { date, time: `${syslog[3]}:${syslog[4]}:${syslog[5]}`, end: syslog[0].length };
    }
    return undefined;
}

function parseLevel(text: string): { readonly level: string; readonly end: number } | undefined {
    const bracket = BRACKET_LEVEL.exec(text);
    if (bracket !== null) return { level: CANONICAL[bracket[1]!.toUpperCase()] ?? "INFO", end: bracket[0].length };
    const match = LEVEL.exec(text);
    if (match === null) return undefined;
    return { level: CANONICAL[match[1]!.toUpperCase()] ?? "INFO", end: (match.index ?? 0) + match[0].length };
}

function truncate(value: string, limit: number): string {
    const oneLine = value.replace(/\s+/g, " ").trim();
    return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}

function parseEntries(source: string): readonly Entry[] {
    const table = lines(source);
    const entries: Entry[] = [];
    let current: Entry | undefined;
    for (const item of table) {
        if (entries.length >= MAX_ENTRIES) break;
        const text = item.text.endsWith("\r") ? item.text.slice(0, -1) : item.text;
        if (text.trim().length === 0) {
            if (current !== undefined) {
                current.endLine = item.line;
                current.endByte = item.endByte;
            }
            continue;
        }
        const timestamp = parseTimestamp(text);
        const level = parseLevel(text);
        if (timestamp !== undefined || level !== undefined) {
            const date = timestamp?.date ?? current?.date ?? "undated";
            const time = timestamp?.time ?? current?.time ?? "??:??:??";
            const end = timestamp?.end ?? level?.end ?? 0;
            const messageIndex = timestamp !== undefined && level !== undefined
                ? Math.max(timestamp.end, level.end)
                : end;
            current = {
                date, time, level: level?.level ?? "INFO",
                message: messageAfter(text, messageIndex),
                startLine: item.line, endLine: item.line,
                startByte: item.startByte, endByte: item.endByte,
            };
            entries.push(current);
            continue;
        }
        if (current !== undefined) {
            current.endLine = item.line;
            current.endByte = item.endByte;
        }
    }
    return entries;
}

function rangeOf(entry: Entry): ParsedOutlineNode["range"] {
    return Object.freeze({
        startLine: entry.startLine, endLine: entry.endLine + 1,
        startByte: entry.startByte, endByte: entry.endByte,
    });
}

function parse(source: string): readonly ParsedOutlineNode[] {
    if (typeof source !== "string") throw new TypeError("source must be a string");
    const entries = parseEntries(source);
    if (entries.length === 0) {
        const table = lines(source);
        const last = table.at(-1);
        return Object.freeze([Object.freeze({
            id: "log:empty:0", kind: "symbol", name: "log (no timestamped entries)",
            summary: `${table.length} line(s)`,
            range: Object.freeze({ startLine: 0, endLine: table.length, startByte: 0, endByte: last?.endByte ?? 0 }),
        } satisfies ParsedOutlineNode)]);
    }
    const dates = new Map<string, Entry[]>();
    for (const entry of entries) {
        const bucket = dates.get(entry.date);
        if (bucket === undefined) dates.set(entry.date, [entry]);
        else bucket.push(entry);
    }
    const nodes: ParsedOutlineNode[] = [];
    for (const [date, group] of dates) {
        const first = group[0]!;
        const last = group.at(-1)!;
        nodes.push(Object.freeze({
            id: `log:date:${encodeURIComponent(date)}:${first.startLine}`,
            kind: "heading",
            name: `${date} (${group.length} entr${group.length === 1 ? "y" : "ies"})`,
            summary: `${first.time}–${last.time}; ${group.length} entries`,
            range: Object.freeze({
                startLine: first.startLine, endLine: last.endLine + 1,
                startByte: first.startByte, endByte: last.endByte,
            }),
        }));
        const levels = new Map<string, Entry[]>();
        for (const entry of group) {
            const bucket = levels.get(entry.level);
            if (bucket === undefined) levels.set(entry.level, [entry]);
            else bucket.push(entry);
        }
        for (const [level, levelEntries] of levels) {
            const levelFirst = levelEntries[0]!;
            const levelLast = levelEntries.at(-1)!;
            nodes.push(Object.freeze({
                id: `log:${encodeURIComponent(date)}:${level}:${levelFirst.startLine}`,
                parentId: `log:date:${encodeURIComponent(date)}:${first.startLine}`,
                kind: "symbol",
                name: `${level} ×${levelEntries.length}`,
                summary: truncate(levelFirst.message, MAX_SUMMARY),
                range: Object.freeze({
                    startLine: levelFirst.startLine, endLine: levelLast.endLine + 1,
                    startByte: levelFirst.startByte, endByte: levelLast.endByte,
                }),
            }));
            for (const entry of levelEntries.slice(0, MAX_ENTRIES_PER_LEVEL)) {
                nodes.push(Object.freeze({
                    id: `log:entry:${entry.startLine}:${entry.startByte}`,
                    parentId: `log:${encodeURIComponent(date)}:${level}:${levelFirst.startLine}`,
                    kind: "symbol",
                    name: truncate(`${entry.time} ${entry.message}`, MAX_NAME),
                    summary: truncate(entry.message, MAX_SUMMARY),
                    range: rangeOf(entry),
                }));
            }
        }
    }
    return Object.freeze(nodes);
}

export const parser: OutlineParserPort = Object.freeze({ language: "log", parse });

export const definition: LanguageDefinition = Object.freeze({
    id: "log", displayName: "Log file",
    extensions: Object.freeze([".log"]),
    mimeTypes: Object.freeze(["text/x-log"]),
    support: "outline", parser,
});
