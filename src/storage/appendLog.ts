import type { Digest, Timestamp } from "../types/common.ts";
import type { ChainEntry, EntryKind, LedgerSnapshot } from "../ledger/persistence.ts";
import type { KeyPair } from "../manifest/sign.ts";
import type { CheckpointOptions, LedgerCheckpoint } from "../ledger/checkpoint.ts";
import { sealCheckpoint } from "../ledger/checkpoint.ts";
import { digestOf } from "../semantic/canonical.ts";

const GENESIS: Digest = `sha256:${"0".repeat(64)}`;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const ENTRY_KINDS: readonly EntryKind[] = ["event", "frame", "receipt", "claim", "hypothesis", "unknown", "goal", "plan"];
const ENTRY_KIND_SET: ReadonlySet<string> = new Set<string>(ENTRY_KINDS);

/**
 * Pluggable destination for JSONL lines.
 *
 * `append` must not resolve until the line is accepted by the storage medium;
 * `readAll` returns the lines in write order. Each element is one complete JSON
 * object; blank lines are treated as corruption by {@link AppendLog.open}. A
 * host can wrap a file, a database table, or a remote log behind this
 * interface. `AppendLog` never touches the platform filesystem itself.
 */
export interface AppendSink {
    append(line: string): void | Promise<void>;
    readAll(): string[] | Promise<string[]>;
}

/**
 * In-memory sink for tests, demos, and deterministic replays.
 *
 * Nothing is durable: the lines live in an array and disappear with the
 * process. Production hosts should provide a sink whose `append` resolves only
 * after the line is safely stored. `readAll` returns a copy; {@link lines} is a
 * live read-only view for harnesses.
 */
export class MemoryAppendSink implements AppendSink {
    private readonly items: string[];

    constructor(lines: readonly string[] = []) {
        this.items = [...lines];
    }

    append(line: string): void {
        this.items.push(line);
    }

    readAll(): string[] {
        return [...this.items];
    }

    /**
     * Live view of the stored lines for test harnesses; `readAll()` returns the copy.
     */
    get lines(): string[] {
        return this.items;
    }
}

/**
 * One entry in the append-only log.
 *
 * Shape-compatible with `ChainEntry` from `persistence.ts`; `at` is advisory
 * metadata and is deliberately not covered by `hash`.
 */
export interface LogEntry {
    seq: number;
    kind: EntryKind;
    payload: unknown;
    prev: Digest;
    hash: Digest;
    at?: Timestamp;
}

/**
 * Thrown when a sink contains data that fails structural or hash verification.
 */
export class AppendLogError extends Error {
    /**
     * Individual failures, in the order they were found.
     */
    readonly reasons: string[];

    constructor(message: string, reasons: readonly string[] = []) {
        super(message);
        this.name = "AppendLogError";
        this.reasons = [...reasons];
    }
}

function isDigest(value: unknown): value is Digest {
    return typeof(value) === "string" && DIGEST_PATTERN.test(value);
}

function isEntryKind(value: unknown): value is EntryKind {
    return typeof(value) === "string" && ENTRY_KIND_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof(value) === "object" && value !== null && !Array.isArray(value);
}

/**
 * Must match `persistence.ts` exactly so logs and snapshots verify alike.
 */
function hashOf(seq: number, kind: EntryKind, payload: unknown, prev: Digest): Digest {
    return digestOf({ seq, kind, payload, prev });
}

/**
 * JSONL stores JSON, not JavaScript values. Normalizing before hashing keeps
 * the line self-consistent for `undefined` properties, `Date`, and other
 * values that `JSON.stringify` would otherwise rewrite or drop.
 */
function jsonValue(value: unknown): unknown {
    const text = JSON.stringify(value);
    return text === (void 0) ? null : JSON.parse(text);
}

function verifyEntries(entries: readonly LogEntry[]): string[] {
    const reasons: string[] = [];
    let prev: Digest = GENESIS;

    entries.forEach((entry, index) => {
        if (!Number.isSafeInteger(entry.seq) || entry.seq !== index) {
            reasons.push(`entry ${index}: seq ${`${entry.seq}`} is out of order`);
        }
        if (!isEntryKind(entry.kind)) {
            reasons.push(`entry ${index}: kind ${`${entry.kind}`} is not a supported entry kind`);
        }
        if (entry.prev !== prev) {
            reasons.push(`entry ${index}: prev does not match the previous hash`);
        }
        const expected = hashOf(entry.seq, entry.kind, entry.payload, entry.prev);
        if (entry.hash !== expected) {
            reasons.push(`entry ${index}: hash does not cover its canonical fields`);
        }
        prev = entry.hash;
    });

    return reasons;
}

/**
 * Parses one JSONL line without trusting its `seq`, `prev`, or `hash` fields.
 */
function entryFromLine(line: unknown, index: number, reasons: string[]): LogEntry | undefined {
    if (typeof(line) !== "string") {
        reasons.push(`line ${index}: expected a string`);
        return undefined;
    }
    if (line.trim().length === 0) {
        reasons.push(`line ${index}: empty line`);
        return undefined;
    }

    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        reasons.push(`line ${index}: not valid JSON`);
        return undefined;
    }
    if (!isRecord(value)) {
        reasons.push(`line ${index}: expected a JSON object`);
        return undefined;
    }

    const { seq, kind, prev, hash, at } = value;
    if (typeof(seq) !== "number" || !Number.isSafeInteger(seq)) {
        reasons.push(`line ${index}: seq is not an integer`);
        return undefined;
    }
    if (!isEntryKind(kind)) {
        reasons.push(`line ${index}: unknown entry kind ${`${kind}`}`);
        return undefined;
    }
    if (!isDigest(prev)) {
        reasons.push(`line ${index}: prev is not a sha256 digest`);
        return undefined;
    }
    if (!isDigest(hash)) {
        reasons.push(`line ${index}: hash is not a sha256 digest`);
        return undefined;
    }
    if (at !== (void 0) && typeof(at) !== "string") {
        reasons.push(`line ${index}: at is not a timestamp string`);
        return undefined;
    }

    const entry: LogEntry = { seq, kind, payload: value.payload, prev, hash };
    if (typeof(at) === "string") {
        entry.at = at;
    }
    return entry;
}

function toChainEntry(entry: LogEntry): ChainEntry {
    return {
        seq: entry.seq,
        kind: entry.kind,
        payload: entry.payload,
        prev: entry.prev,
        hash: entry.hash,
    };
}

/**
 * A verified, append-only hash chain over a pluggable {@link AppendSink}.
 *
 * Every line is one canonical entry serialized as JSON; `append` writes exactly
 * one line and only advances the in-memory tip after the sink resolves. The
 * hash function is identical to `persistence.ts`
 * (`digestOf({ seq, kind, payload, prev })`), so a log can be exported as a
 * `LedgerSnapshot` and checked by existing tooling.
 *
 * Durability and atomicity are properties of the sink, not of this class; there
 * is no guarantee beyond "the sink resolved". A sink that throws after
 * physically writing its line can leave storage and memory out of sync, so
 * hosts should use an atomic append. A single `AppendLog` serializes its own
 * writes, but concurrent instances sharing a sink are not coordinated.
 *
 * `at` is preserved but outside the hash, matching `ChainEntry`. A clean
 * deletion of the tail produces a shorter, internally valid prefix; detecting
 * it requires an external commitment such as a signed checkpoint.
 */
export class AppendLog {
    private readonly sink: AppendSink;
    private readonly items: LogEntry[];
    private tail: Promise<void> = Promise.resolve();

    /**
     * Owner of the ledger. Needed when sealing a checkpoint, because a checkpoint
     * binds the agent identity as well as the tip. Set it through
     * {@link AppendLog.open} or assign it before sealing.
     */
    agent: string;

    private constructor(sink: AppendSink, entries: LogEntry[], agent: string) {
        this.sink = sink;
        this.items = entries;
        this.agent = agent;
    }

    /**
     * Reads every line, parses it, and verifies the chain before returning.
     *
     * An empty sink opens as an empty log with the genesis tip. Any malformed
     * line, gap, bad link, or hash mismatch throws {@link AppendLogError}; the
     * log is never returned in a partially trusted state.
     *
     * @param sink - Storage to read (and later append to).
     * @param agent - Ledger owner used by {@link seal}; may also be set later.
     */
    static async open(sink: AppendSink, agent = ""): Promise<AppendLog> {
        const lines = await sink.readAll();
        if (!Array.isArray(lines)) {
            throw new AppendLogError("append sink readAll() did not return an array of lines", ["readAll() did not return an array"]);
        }

        const reasons: string[] = [];
        const entries: LogEntry[] = [];
        for (let index = 0; index < lines.length; index += 1) {
            const entry = entryFromLine(lines[index], index, reasons);
            if (entry === (void 0)) {
                break;
            }
            entries.push(entry);
        }
        if (reasons.length === 0) {
            reasons.push(...verifyEntries(entries));
        }
        if (reasons.length > 0) {
            throw new AppendLogError(`append log failed verification: ${reasons.join("; ")}`, reasons);
        }

        return new AppendLog(sink, entries, agent);
    }

    /**
     * Number of entries currently committed.
     */
    get count(): number {
        return this.items.length;
    }

    /**
     * Hash of the last entry, or the genesis hash for an empty log.
     */
    get tip(): Digest {
        return this.items.at(-1)?.hash ?? GENESIS;
    }

    /**
     * A shallow copy of the entries, in sequence order.
     */
    entries(): readonly LogEntry[] {
        return [...this.items];
    }

    /**
     * Rechecks the in-memory chain; a mutation since `open`/`append` fails closed.
     */
    verify(): { ok: boolean; reasons: string[] } {
        const reasons = verifyEntries(this.items);
        return { ok: reasons.length === 0, reasons };
    }

    /**
     * Appends one entry and one JSONL line.
     *
     * Calls are serialized so concurrent appends get distinct, contiguous
     * sequence numbers. In-memory `count`/`tip` advance only after
     * `sink.append` resolves; if it rejects, this instance is unchanged and the
     * same sequence number can be retried. Payloads are normalized through
     * `JSON.stringify`/`JSON.parse` before hashing, so the stored line can always
     * be reopened even when the caller passed `undefined` properties or other
     * values JSON would rewrite.
     */
    async append(kind: EntryKind, payload: unknown, options: { at?: Timestamp } = {}): Promise<LogEntry> {
        const operation = this.tail.then(() => this.write(kind, payload, options));
        this.tail = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    private async write(kind: EntryKind, payload: unknown, options: { at?: Timestamp }): Promise<LogEntry> {
        const seq = this.items.length;
        const prev = this.tip;
        const stored = jsonValue(payload);
        const hash = hashOf(seq, kind, stored, prev);
        const entry: LogEntry = { seq, kind, payload: stored, prev, hash };
        if (options.at !== (void 0)) {
            entry.at = options.at;
        }

        await this.sink.append(JSON.stringify(entry));
        this.items.push(entry);
        return entry;
    }

    /**
     * Signs the current tip through {@link sealCheckpoint}.
     *
     * Refuses to sign a log whose in-memory chain no longer verifies. The agent
     * comes from `options.agent` if present, otherwise from this log; sealing
     * without an agent is an error rather than an anonymous checkpoint.
     */
    async seal(key: KeyPair, options: CheckpointOptions & { agent?: string }): Promise<LedgerCheckpoint> {
        await this.tail;
        const verdict = this.verify();
        if (!verdict.ok) {
            throw new AppendLogError("refusing to seal a broken append log", verdict.reasons);
        }

        const agent = options.agent ?? this.agent;
        if (agent.trim().length === 0) {
            throw new AppendLogError("cannot seal a checkpoint without an agent: pass one to AppendLog.open or in the seal options", ["agent is empty"]);
        }

        const snapshot: LedgerSnapshot = {
            amp: "0.1",
            kind: "ledger-snapshot",
            agent,
            tip: this.tip,
            count: this.count,
            entries: this.items.map(toChainEntry),
        };
        return sealCheckpoint(snapshot, key, options);
    }
}
