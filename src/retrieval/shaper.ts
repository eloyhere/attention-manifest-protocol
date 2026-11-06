import { useFrom } from "semantic-typescript";
import type { Page, ShapeOptions, ShapedRecord } from "./types.ts";

export function shape<T>(value: T, options: ShapeOptions<T>): ShapedRecord<T> {
    const original = structuredClone(value);
    const projected: ShapedRecord<T> = {
        summary: options.summary(value),
        original,
        originalDigest: options.digest(value),
        ...(options.fields ? { fields: structuredClone(options.fields(value)) } : {}),
    };
    if (!projected.originalDigest) throw new TypeError("digest must be nonempty");
    return projected;
}

/** Stable bounded page over a snapshot; cursor is an offset within that snapshot. */
export function paginate<T>(values: Iterable<T>, cursor: string | undefined, limit: number): Page<T> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive safe integer");
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("invalid cursor");
    const items = useFrom(values).toCollectable().toArray();
    const pageItems = items.slice(offset, offset + limit);
    const next = offset + pageItems.length;
    return { items: pageItems, total: items.length, ...(next < items.length ? { nextCursor: String(next) } : {}) };
}
