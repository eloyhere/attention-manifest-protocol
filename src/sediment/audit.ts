import { createHash } from "node:crypto";

function canonical(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(",")}]`;
    if (typeof value === "object") {
        const record = value as Readonly<Record<string, unknown>>;
        const entries = Object.keys(record)
            .filter(key => record[key] !== undefined)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`);
        return `{${entries.join(",")}}`;
    }
    return "null";
}

/** Stable JSON used for audit digests; object key order never changes a hash. */
export function stableStringify(value: unknown): string {
    return canonical(value);
}

export function digestOf(value: unknown): string {
    return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}
