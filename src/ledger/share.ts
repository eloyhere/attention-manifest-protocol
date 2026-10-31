import type { Ledger } from "./ledger.ts";
import { digestOf } from "../semantic/canonical.ts";
import { exportLedger } from "./persistence.ts";
import type { ChainEntry, LedgerSnapshot } from "./persistence.ts";

export type ShareMode = "full" | "summary" | "reference";

export interface SharedView {
    amp: "0.1";
    kind: "shared-ledger";
    mode: ShareMode;
    agent: string;
    tip: string;
    count: number;
    digest: string;
    entries?: unknown[];
    summary?: {
        byKind: Record<string, number>;
        claims: string[];
    };
}

/**
 * Fields every granularity shares; the digest and the mode-specific payload
 * are added on top.
 */
type SharedBase = Omit<SharedView, "digest" | "entries" | "summary">;

/**
 * The part of a claim payload the summary view reads.
 */
type ClaimPayload = {
    id?: string;
};

/**
 * Signature of the ledger sharing entry point.
 */
type ShareLedger = (ledger: Ledger, agent: string, mode: ShareMode) => SharedView;

/**
 * Three sharing granularities, all integrity-checkable.
 *
 * full      — everything; only for a trusted peer in the same domain
 * summary   — counts + claim ids; no payloads
 * reference — tip + count + digest; the receiver must ask for more
 */
export const shareLedger: ShareLedger = (ledger: Ledger, agent: string, mode: ShareMode): SharedView => {
    const snapshot: LedgerSnapshot = exportLedger(ledger, agent);
    const base: SharedBase = {
        amp: "0.1",
        kind: "shared-ledger",
        mode,
        agent,
        tip: snapshot.tip,
        count: snapshot.count,
    };

    if (mode === "full") {
        return { ...base, digest: digestOf({ ...base, entries: snapshot.entries }), entries: snapshot.entries };
    }

    if (mode === "summary") {
        const byKind: Record<string, number> = {};
        const claims: string[] = [];
        for (let index: number = 0; index < snapshot.entries.length; index += 1) {
            const entry: ChainEntry = snapshot.entries[index];
            byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
            if (entry.kind === "claim") {
                const payload: ClaimPayload = entry.payload as ClaimPayload;
                if (payload.id) {
                    claims.push(payload.id);
                }
            }
        }
        return { ...base, digest: digestOf({ ...base, byKind, claims }), summary: { byKind, claims } };
    }

    return { ...base, digest: digestOf(base) };
};
