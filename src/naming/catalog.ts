/**
 * Tool catalog summary: one canonical order plus one digest over the sorted
 * entries.
 *
 * The invariant is that reordering the same tool set never changes the catalog
 * digest (prompt caches match prefixes, so order must be canonical), while a
 * changed per-tool definition digest does. The naming module never inspects MCP
 * descriptors: callers compute each entry digest from the fields that affect
 * what the model sees and what arguments validate.
 */

import { digestOf } from "../semantic/canonical.ts";

export interface CatalogEntry {
    /**
     * Canonical tool id (`amp_tool_...`). It is the identity key of the entry,
     * so a rename is visible as one removal plus one addition rather than as a
     * changed definition.
     */
    readonly id: string;
    /**
     * Digest of the entry's definition fields (description, input schema,
     * annotations and risk). The caller owns this value because only the
     * caller can see the definition; naming only sorts and summarizes.
     */
    readonly digest: string;
    /**
     * Side-effect class used by approval and audit policy. It is repeated in
     * the catalog because a consumer may need to gate a call before fetching
     * the full descriptor.
     */
    readonly risk: "read" | "write" | "destructive";
}

export interface ToolCatalog {
    /**
     * Semantic version of the definition set. The caller advances it when a
     * definition changes; the digest is the byte-level proof of that change.
     */
    readonly version: string;
    /**
     * Cache lifetime hint in milliseconds. `0` means "do not cache", which is
     * the honest default until the caller can promise that a changed definition
     * always changes the digest.
     */
    readonly ttlMs: number;
    /**
     * Whether a shared cache may reuse this catalog. Private is the default
     * because an entry list can reveal internal schema.
     */
    readonly cacheScope: "private" | "public";
    /**
     * Stable ordering promise. A client may cache by position only because the
     * server commits to sorting by id.
     */
    readonly sortedBy: "id";
    /**
     * Entries sorted by plain string comparison of `id`, never by arrival
     * order and never by locale.
     */
    readonly entries: readonly CatalogEntry[];
    /**
     * Digest of `entries` in their sorted order, so list order is not a
     * definition change and a definition change cannot hide behind a reorder.
     */
    readonly digest: string;
}

export interface CatalogVerdict {
    /**
     * True only when every expected id is present with the same digest and
     * risk and no unexpected id appeared.
     */
    readonly ok: boolean;
    /**
     * Human-readable drift reasons (`tool added: ...`, `tool removed: ...`,
     * `tool changed: ...`), one per drifting id.
     */
    readonly reasons: readonly string[];
    /**
     * Ids that were added, removed or changed, sorted for deterministic output.
     */
    readonly changed: readonly string[];
}

/**
 * Caller-supplied catalog metadata.
 *
 * Kept structural and local so the frozen public signature can stay anonymous;
 * every field is optional because the defaults below are the safe values.
 */
interface CatalogOptions {
    version?: string;
    ttlMs?: number;
    cacheScope?: "private" | "public";
}

/**
 * Plain id comparison.
 *
 * `localeCompare` is deliberately not used: the digest must be identical on
 * every machine, and locale-sensitive collation would make the sorted array
 * depend on the host's ICU data.
 */
const compareById: (left: CatalogEntry, right: CatalogEntry) => number = (left: CatalogEntry, right: CatalogEntry): number => {
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

/**
 * Index entries by id for order-independent comparison.
 *
 * A later duplicate replaces an earlier one; catalogs are built from a set, so
 * duplicates indicate a caller bug rather than a meaningful catalog state.
 */
const indexEntries: (entries: readonly CatalogEntry[]) => Map<string, CatalogEntry> = (entries: readonly CatalogEntry[]): Map<string, CatalogEntry> => {
    const index: Map<string, CatalogEntry> = new Map<string, CatalogEntry>();
    for (let position: number = 0; position < entries.length; position += 1) {
        const entry: CatalogEntry = entries[position];
        index.set(entry.id, entry);
    }
    return index;
};

/**
 * Build a catalog from per-tool definition digests.
 *
 * Entries are copied and sorted by plain `<` (UTF-16 code-unit order), which is
 * stable and locale-independent. The digest covers only the sorted array, so
 * feeding the same set in a different order produces the same digest; that is
 * what lets a client treat a reorder as cache noise instead of a pin failure.
 *
 * Defaults: version `1.0.0`, `ttlMs` 0 ("do not cache"), and `cacheScope`
 * private. A positive `ttlMs` is safe only when the caller guarantees that any
 * definition change changes that entry's digest.
 */
export const buildCatalog: (entries: readonly CatalogEntry[], options?: CatalogOptions) => ToolCatalog = (entries: readonly CatalogEntry[], options?: CatalogOptions): ToolCatalog => {
    const version: string = options?.version ?? "1.0.0";
    const ttlMs: number = options?.ttlMs ?? 0;
    const cacheScope: "private" | "public" = options?.cacheScope ?? "private";
    const sorted: CatalogEntry[] = [...entries].sort(compareById);
    return {
        version,
        ttlMs,
        cacheScope,
        sortedBy: "id",
        entries: sorted,
        digest: digestOf(sorted),
    };
};

/**
 * Compare a previously built catalog with freshly observed entries.
 *
 * The comparison is keyed by id, so changing the order of an unchanged set is
 * not drift. Each drifting id produces one actionable reason and appears in
 * `changed`; the array shape mirrors `PinVerdict` in `src/execution/pin.ts` so
 * the two drift reports can be consumed by the same code.
 *
 * Risk is compared separately from the entry digest because this module cannot
 * know whether the caller folded risk into that digest. Reporting a risk-only
 * change is safer than silently accepting it.
 */
export const verifyCatalog: (expected: ToolCatalog, actual: readonly CatalogEntry[]) => CatalogVerdict = (expected: ToolCatalog, actual: readonly CatalogEntry[]): CatalogVerdict => {
    const expectedById: Map<string, CatalogEntry> = indexEntries(expected.entries);
    const actualById: Map<string, CatalogEntry> = indexEntries(actual);
    const reasons: string[] = [];
    const changed: Set<string> = new Set<string>();
    const expectedEntries: CatalogEntry[] = [...expectedById.values()];
    for (let position: number = 0; position < expectedEntries.length; position += 1) {
        const entry: CatalogEntry = expectedEntries[position];
        const observed: CatalogEntry | undefined = actualById.get(entry.id);
        if (observed === (void 0)) {
            reasons.push(`tool removed: ${entry.id}`);
            changed.add(entry.id);
            continue;
        }
        if (observed.digest !== entry.digest) {
            reasons.push(`tool changed: ${entry.id} ${entry.digest} -> ${observed.digest}`);
            changed.add(entry.id);
            continue;
        }
        if (observed.risk !== entry.risk) {
            reasons.push(`tool changed: ${entry.id} risk ${entry.risk} -> ${observed.risk}`);
            changed.add(entry.id);
        }
    }
    const actualIds: string[] = [...actualById.keys()];
    for (let position: number = 0; position < actualIds.length; position += 1) {
        const id: string = actualIds[position];
        if (!expectedById.has(id)) {
            reasons.push(`tool added: ${id}`);
            changed.add(id);
        }
    }
    const sortedChanged: string[] = [...changed].sort();
    return { ok: reasons.length === 0, reasons, changed: sortedChanged };
};
