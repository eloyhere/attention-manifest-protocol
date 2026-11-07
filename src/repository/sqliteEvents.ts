import type { EventRecord } from "../entity/types.ts";
import { safeParse, safeStringify } from "../serialization/index.ts";
import type { SqlDriver, SqlRow, SqlValue } from "../sql/types.ts";

export type EventInput = Omit<EventRecord, "sequence"> & { readonly sequence?: number };

export interface ReadEventsOptions {
    readonly kind?: string;
    readonly limit?: number;
}

type EventRow = SqlRow & {
    readonly sequence: number | bigint;
    readonly kind: string;
    readonly entity_id: SqlValue;
    readonly recorded_at: string;
    readonly payload: string;
};

function serializePayload(payload: unknown): string {
    // Event payloads share the repository's persistence contract: a stored row
    // must be acyclic and de-duplicated, so the shared-reference filter is
    // requested explicitly.
    return safeStringify(payload, { filterShared: true });
}

function parsePayload(value: SqlValue): unknown {
    if (typeof value !== "string") throw new TypeError("events.payload must be a string");
    // Persisted payloads are external input: a malformed row must fail as a
    // SerializationError rather than yield a half-decoded value.
    return safeParse(value);
}

function sequenceOf(value: number | bigint): number {
    return typeof value === "bigint" ? Number(value) : value;
}

/** Appends one event and returns it with the database-assigned sequence. */
export function appendEvent(driver: SqlDriver, event: EventInput): EventRecord {
    const result = driver.run({
        sql: "INSERT INTO events (kind, entity_id, recorded_at, payload) VALUES (?, ?, ?, ?)",
        parameters: [event.kind, event.entityId ?? null, event.recordedAt, serializePayload(event.payload)],
    });
    return {
        sequence: sequenceOf(result.lastInsertRowid),
        kind: event.kind,
        ...(event.entityId === undefined ? {} : { entityId: event.entityId }),
        recordedAt: event.recordedAt,
        payload: event.payload,
    };
}

/** Reads events in append order, optionally narrowed by kind and limit. */
export function readEvents(driver: SqlDriver, options: ReadEventsOptions = {}): readonly EventRecord[] {
    const clauses: string[] = [];
    const parameters: SqlValue[] = [];
    if (options.kind !== undefined) {
        clauses.push("kind = ?");
        parameters.push(options.kind);
    }
    let limit = "";
    if (options.limit !== undefined) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 0) throw new RangeError("limit must be a non-negative safe integer");
        limit = " LIMIT ?";
        parameters.push(options.limit);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = driver.query<EventRow>({
        sql: `SELECT sequence, kind, entity_id, recorded_at, payload FROM events${where} ORDER BY sequence ASC${limit}`,
        parameters,
    });
    return rows.map((row) => ({
        sequence: sequenceOf(row.sequence),
        kind: row.kind,
        ...(typeof row.entity_id === "string" ? { entityId: row.entity_id } : {}),
        recordedAt: row.recorded_at,
        payload: parsePayload(row.payload),
    }));
}
