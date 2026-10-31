import { digestOf } from "../semantic/canonical.ts";
import { verifySnapshot } from "../ledger/persistence.ts";
import type { ChainEntry, LedgerSnapshot } from "../ledger/persistence.ts";
import type { Checkpoint, LedgerKind, PruneDecision, PrunePlan, PrunePolicy } from "./compactionTypes.ts";

/**
 * Context economy: pruning builds a view, compaction builds a checkpoint.
 *
 * Neither operation is allowed to lose warrant silently. Pruning keeps ids and
 * reasons, and refuses to drop anything a retained object still refers to.
 * Compaction commits to the digest of what it removes before removing it, and
 * refuses to compact a prefix the retained tail still points at.
 */

const LEDGER_KINDS: readonly LedgerKind[] = ["event", "frame", "receipt", "claim", "hypothesis", "unknown", "goal", "plan"];

const CLOSED_HYPOTHESES = ["supported", "refuted", "inconclusive", "out_of_scope"];

function isLedgerKind(value: unknown): value is LedgerKind {
    return typeof(value) === "string" && (LEDGER_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof(value) === "object" && value !== null && !Array.isArray(value);
}

function idOf(payload: unknown): string | undefined {
    if (!isRecord(payload)) {
        return undefined;
    }
    return typeof(payload.id) === "string" ? payload.id : undefined;
}

function keyOf(kind: string, id: string): string {
    return `${kind}:${id}`;
}

/**
 * Every `{kind, id}` reference inside a payload, at any depth.
 *
 * `supersedes` is deliberately not followed. It is a revision link, not a
 * warrant dependency: the successor states that the old claim is no longer
 * active, so the old claim may leave the view while the successor stays.
 */
function collectRefs(value: unknown, out: Set<string>, depth = 0): void {
    if (depth > 16) {
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectRefs(item, out, depth + 1);
        }
        return;
    }
    if (!isRecord(value)) {
        return;
    }
    if (isLedgerKind(value.kind) && typeof(value.id) === "string") {
        out.add(keyOf(value.kind, value.id));
    }
    for (const [key, child] of Object.entries(value)) {
        if (key === "amp" || key === "supersedes") {
            continue;
        }
        collectRefs(child, out, depth + 1);
    }
}

function utf8Bytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).length;
}

function hashOfEntry(entry: ChainEntry): string {
    return digestOf({ seq: entry.seq, kind: entry.kind, payload: entry.payload, prev: entry.prev });
}

type Candidate = { reason: PruneDecision["reason"]; revisit_if: string };

/**
 * Why an entry may leave the view, if it may. Conservative by design: a kind
 * with no rule is never pruned, and an object without an id is never pruned
 * because the plan could not say what it dropped.
 */
function classify(entry: ChainEntry, id: string, policy: PrunePolicy, supersededBy: Map<string, string>): Candidate | undefined {
    const payload = entry.payload;
    if (!isRecord(payload)) {
        return undefined;
    }

    if (entry.kind === "claim") {
        const newer = supersededBy.get(id);
        if (!policy.dropSupersededClaims || newer === (void 0)) {
            return undefined;
        }
        // A contested claim is the subject of adjudication; it stays until resolved.
        if (payload.status === "contested") {
            return undefined;
        }
        return { reason: "superseded", revisit_if: `if claim ${newer} is retracted or contested` };
    }

    if (entry.kind === "hypothesis") {
        if (!policy.dropClosedHypotheses) {
            return undefined;
        }
        const status = typeof(payload.status) === "string" ? payload.status : "";
        if (!CLOSED_HYPOTHESES.includes(status)) {
            return undefined;
        }
        return { reason: "closed", revisit_if: `if new evidence contradicts hypothesis ${id}` };
    }

    if (entry.kind === "unknown") {
        if (!policy.dropResolvedUnknowns) {
            return undefined;
        }
        if (payload.blocking === true) {
            return undefined;
        }
        if (payload.status !== "resolved") {
            return undefined;
        }
        return { reason: "resolved", revisit_if: `if unknown ${id} reopens` };
    }

    return undefined;
}

export interface PruneResult {
    plan: PrunePlan;
    /**
     * The view itself: retained entries in chain order.
     */
    keep: ChainEntry[];
}

/**
 * Build a view of a verified snapshot.
 *
 * Order of work: the retention floor, then per-kind eligibility, then the
 * reference closure. The closure runs last and wins: a superseded claim that a
 * retained plan still cites is kept, because dropping it would leave the
 * citation dangling.
 */
export function planPrune(snapshot: LedgerSnapshot, overrides: Partial<PrunePolicy> = {}): PruneResult {
    const verdict = verifySnapshot(snapshot);
    if (!verdict.ok) {
        throw new Error(`refusing to prune an unverified ledger: ${verdict.reasons.join("; ")}`);
    }

    const policy: PrunePolicy = {
        amp: "0.1",
        kind: "prune-policy",
        keepRecent: 50,
        dropSupersededClaims: true,
        dropClosedHypotheses: true,
        dropResolvedUnknowns: true,
        ...overrides,
    };

    const entries = snapshot.entries;
    const floor = Math.max(0, policy.keepRecent);
    const cutoff = entries.length - floor;

    const supersededBy = new Map<string, string>();
    for (const entry of entries) {
        if (entry.kind !== "claim" || !isRecord(entry.payload)) {
            continue;
        }
        const supersedes = entry.payload.supersedes;
        if (isRecord(supersedes) && typeof(supersedes.id) === "string") {
            supersededBy.set(supersedes.id, `${entry.payload.id}`);
        }
    }

    const candidates: { entry: ChainEntry; id: string; decision: Candidate }[] = [];
    entries.forEach((entry, index) => {
        if (index >= cutoff) {
            return;
        }
        const id = idOf(entry.payload);
        if (!id) {
            return;
        }
        const decision = classify(entry, id, policy, supersededBy);
        if (decision) {
            candidates.push({ entry, id, decision });
        }
    });

    const candidateSet = new Set(candidates.map((c) => c.entry));
    const retained = entries.filter((entry) => !candidateSet.has(entry));

    // Reference closure: retained objects pull in whatever they cite.
    const queue = [...retained];
    while (queue.length > 0) {
        const entry = queue.pop();
        if (!entry) {
            break;
        }
        const refs = new Set<string>();
        collectRefs(entry.payload, refs);
        for (const candidate of candidates) {
            if (candidateSet.has(candidate.entry) === false) {
                continue;
            }
            if (!refs.has(keyOf(candidate.entry.kind, candidate.id))) {
                continue;
            }
            candidateSet.delete(candidate.entry);
            retained.push(candidate.entry);
            queue.push(candidate.entry);
        }
    }

    const dropped: PruneDecision[] = candidates
        .filter((c) => candidateSet.has(c.entry))
        .map((c) => ({
            seq: c.entry.seq,
            kind: c.entry.kind,
            id: c.id,
            reason: c.decision.reason,
            revisit_if: c.decision.revisit_if,
            bytes: utf8Bytes(c.entry),
        }));

    const reclaimedBytes = dropped.reduce((sum, decision) => sum + decision.bytes, 0);
    const kept = entries.filter((entry) => !candidateSet.has(entry));

    return {
        plan: {
            amp: "0.1",
            kind: "prune-plan",
            agent: snapshot.agent,
            sourceTip: snapshot.tip,
            sourceCount: snapshot.count,
            kept: kept.map((entry) => entry.seq),
            dropped,
            reclaimedBytes,
            estimatedTokens: Math.ceil(reclaimedBytes / 4),
            policy,
        },
        keep: kept,
    };
}

export interface Compaction {
    checkpoint: Checkpoint;
    /**
     * The part of the chain that remains in storage, continuing from `checkpoint.tip`.
     */
    tail: LedgerSnapshot;
    /**
     * The entries the checkpoint covers. Kept here so the commitment is checkable.
     */
    removed: ChainEntry[];
}

export class CompactionRefused extends Error {
    readonly pinned: string[];

    constructor(message: string, pinned: string[] = []) {
        super(message);
        this.name = "CompactionRefused";
        this.pinned = pinned;
    }
}

export interface CompactionOptions {
    keepRecent?: number;
    now?: string;
}

/**
 * Replace the cold prefix with a checkpoint.
 *
 * Refuses when the retained tail still references an entry in the prefix: the
 * checkpoint would commit to data the agent can no longer read, which is how a
 * ledger becomes unusable while claiming to be intact.
 */
export function compactLedger(snapshot: LedgerSnapshot, options: CompactionOptions = {}): Compaction {
    const verdict = verifySnapshot(snapshot);
    if (!verdict.ok) {
        throw new CompactionRefused(`refusing to compact an unverified ledger: ${verdict.reasons.join("; ")}`);
    }

    const keepRecent = Math.max(0, options.keepRecent ?? 0);
    const cut = snapshot.entries.length - keepRecent;
    if (cut <= 0) {
        throw new CompactionRefused("nothing to compact: the ledger is inside the retention window");
    }

    const removed = snapshot.entries.slice(0, cut);
    const tail = snapshot.entries.slice(cut);

    const tailRefs = new Set<string>();
    for (const entry of tail) {
        collectRefs(entry.payload, tailRefs);
    }

    const pinned: string[] = [];
    for (const entry of removed) {
        const id = idOf(entry.payload);
        if (id && tailRefs.has(keyOf(entry.kind, id))) {
            pinned.push(keyOf(entry.kind, id));
        }
    }
    if (pinned.length > 0) {
        throw new CompactionRefused("refusing to compact entries the retained tail still references", pinned);
    }

    const first = removed[0];
    const last = removed[removed.length - 1];
    const root = digestOf(removed);
    const checkpoint: Checkpoint = {
        amp: "0.1",
        kind: "checkpoint",
        id: `cp.${first.seq}-${last.seq}`,
        agent: snapshot.agent,
        from: first.seq,
        to: last.seq,
        count: removed.length,
        tip: last.hash,
        root,
        created: options.now ?? new Date().toISOString(),
        policy: { keepRecent },
    };

    const tailTip = tail.length > 0 ? tail[tail.length - 1].hash : last.hash;
    return {
        checkpoint,
        tail: {
            amp: "0.1",
            kind: "ledger-snapshot",
            agent: snapshot.agent,
            tip: tailTip,
            count: tail.length,
            entries: tail,
        },
        removed,
    };
}

/**
 * Check a compaction without trusting any of it.
 *
 * The root cannot be recomputed from the tail alone — that is the point of
 * compaction — so the caller must supply the removed entries. What this proves
 * is that *these* entries are the ones the checkpoint committed to, and that
 * the tail continues the same chain.
 */
export function verifyCompaction(compaction: Compaction): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const { checkpoint, tail, removed } = compaction;

    if (digestOf(removed) !== checkpoint.root) {
        reasons.push("checkpoint root does not cover the removed entries");
    }
    if (removed.length !== checkpoint.count) {
        reasons.push(`checkpoint count ${checkpoint.count} does not match ${removed.length} removed entries`);
    }

    const first = removed[0];
    const last = removed[removed.length - 1];
    if (!first || !last) {
        reasons.push("no entries were removed");
    } else {
        if (first.seq !== checkpoint.from) {
            reasons.push(`checkpoint starts at ${checkpoint.from} but the first removed entry is ${first.seq}`);
        }
        if (last.seq !== checkpoint.to) {
            reasons.push(`checkpoint ends at ${checkpoint.to} but the last removed entry is ${last.seq}`);
        }
        if (last.hash !== checkpoint.tip) {
            reasons.push("checkpoint tip does not match the last removed entry");
        }
    }

    if (tail.count !== tail.entries.length) {
        reasons.push(`tail count ${tail.count} does not match ${tail.entries.length} entries`);
    }

    let prev = checkpoint.tip;
    tail.entries.forEach((entry, index) => {
        const expectedSeq = checkpoint.to + 1 + index;
        if (entry.seq !== expectedSeq) {
            reasons.push(`tail entry ${index}: seq ${entry.seq} does not continue from ${checkpoint.to}`);
        }
        if (entry.prev !== prev) {
            reasons.push(`tail entry ${index}: prev does not continue the chain`);
        }
        if (hashOfEntry(entry) !== entry.hash) {
            reasons.push(`tail entry ${index}: hash does not cover its payload`);
        }
        prev = entry.hash;
    });

    if (tail.tip !== prev) {
        reasons.push("tail tip does not match the chain it contains");
    }

    return { ok: reasons.length === 0, reasons };
}
