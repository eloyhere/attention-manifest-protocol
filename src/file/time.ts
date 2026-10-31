/**
 * Timestamp formatting shared by tree nodes, journal rows and protocol
 * envelopes.
 *
 * Node metadata uses the wire shape `yyyy-MM-ddTHH:mm:ss` with no zone suffix.
 * The default is host-local wall time because that is what a person sees in an
 * explorer; `timeZone: "utc"` provides a reproducible snapshot for tests and
 * cross-host comparison.
 */
import type { NodeTime } from "./types.ts";

const pad: (value: number, width?: number) => string = (value: number, width: number = 2): string => String(value).padStart(width, "0");

/**
 * Format a date as `yyyy-MM-ddTHH:mm:ss`.
 *
 * @param date - Date to format.
 * @param timeZone - `local` (default) or `utc`.
 * @returns The truncated timestamp.
 */
export const formatNodeTime: (date: Date, timeZone?: "local" | "utc") => NodeTime = (date: Date, timeZone: "local" | "utc" = "local"): NodeTime => {
    const year: number = timeZone === "utc" ? date.getUTCFullYear() : date.getFullYear();
    const month: number = timeZone === "utc" ? date.getUTCMonth() + 1 : date.getMonth() + 1;
    const day: number = timeZone === "utc" ? date.getUTCDate() : date.getDate();
    const hour: number = timeZone === "utc" ? date.getUTCHours() : date.getHours();
    const minute: number = timeZone === "utc" ? date.getUTCMinutes() : date.getMinutes();
    const second: number = timeZone === "utc" ? date.getUTCSeconds() : date.getSeconds();
    return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
};

/**
 * Format an audit/envelope timestamp with milliseconds and a `Z` suffix.
 */
export const formatIsoTime: (date: Date) => string = (date: Date): string => date.toISOString();

/**
 * Parse either a `yyyy-MM-ddTHH:mm:ss` node time or an ISO timestamp.
 *
 * @param value - Timestamp text.
 * @returns The parsed date, or `undefined` when invalid.
 */
export const parseNodeTime: (value: string) => Date | undefined = (value: string): Date | undefined => {
    const parsed: Date = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
};

/**
 * Pick the useful creation time. Some filesystems report a zero birth time;
 * the caller then falls back to change time, and finally to modification time.
 */
export const creationTime: (stat: { birthtimeMs: number; ctimeMs: number; mtimeMs: number; }) => Date = (stat: {
    birthtimeMs: number;
    ctimeMs: number;
    mtimeMs: number;
}): Date => {
    if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) {
        return new Date(stat.birthtimeMs);
    }
    if (Number.isFinite(stat.ctimeMs) && stat.ctimeMs > 0) {
        return new Date(stat.ctimeMs);
    }
    return new Date(stat.mtimeMs);
};
