import { createHash } from "node:crypto";
import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { WorkflowEntityService } from "../workflow/service.ts";
import { isWorkflowSettled, isWorkflowTerminal } from "../workflow/transitions.ts";
import { compactTurnHistory } from "./history.ts";
import { TURN_INTERRUPTION_SCHEMA_VERSION, TurnError } from "./types.ts";
import type {
    Turn, TurnCompactionPolicy, TurnCompactionResult, TurnInterruptOptions, TurnInterruptionSnapshot,
    TurnResumeOptions, TurnState, WorkspaceChangeKind, WorkspaceChangeSummary,
} from "./types.ts";

interface TurnOverlay {
    readonly interruption: TurnInterruptionSnapshot;
    readonly resumed: boolean;
}

const overlays = new WeakMap<WorkflowStore, Map<Identifier, TurnOverlay>>();

const overlayMap = (store: WorkflowStore): Map<Identifier, TurnOverlay> => {
    const existing = overlays.get(store);
    if (existing !== undefined) return existing;
    const created = new Map<Identifier, TurnOverlay>();
    overlays.set(store, created);
    return created;
};

const stableJson = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== void 0)
        .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
};

const digestOf = (value: unknown): string => `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const WORKSPACE_CHANGE_KINDS = ["added", "modified", "deleted", "renamed", "unknown"] as const satisfies readonly WorkspaceChangeKind[];

const workspaceChangesOf = (input: unknown): readonly WorkspaceChangeSummary[] => {
    if (input === void 0) return [];
    if (!Array.isArray(input)) throw new TurnError("invalid_snapshot", "workspaceChanges must be an array");
    return input.map(value => {
        if (!isRecord(value) || !text(value.path)) {
            throw new TurnError("invalid_snapshot", "workspaceChanges entries require a nonempty path");
        }
        if (typeof value.change !== "string" || !(WORKSPACE_CHANGE_KINDS as readonly string[]).includes(value.change)) {
            throw new TurnError("invalid_snapshot", `Invalid workspace change kind: ${String(value.change)}`);
        }
        if (value.digest !== void 0 && !text(value.digest)) {
            throw new TurnError("invalid_snapshot", "Workspace change digest must be nonempty when supplied");
        }
        if (value.summary !== void 0 && !text(value.summary)) {
            throw new TurnError("invalid_snapshot", "Workspace change summary must be nonempty when supplied");
        }
        return {
            path: value.path as string,
            change: value.change as WorkspaceChangeKind,
            ...(value.digest === void 0 ? {} : { digest: value.digest as string }),
            ...(value.summary === void 0 ? {} : { summary: value.summary as string }),
        };
    });
};

/** Digest input excludes the digest itself so tampering is detectable. */
const snapshotBody = (snapshot: TurnInterruptionSnapshot): Omit<TurnInterruptionSnapshot, "digest"> => ({
    schemaVersion: snapshot.schemaVersion,
    turnId: snapshot.turnId,
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    version: snapshot.version,
    ...(snapshot.originTurnId === void 0 ? {} : { originTurnId: snapshot.originTurnId }),
    ...(snapshot.pendingIntentId === void 0 ? {} : { pendingIntentId: snapshot.pendingIntentId }),
    pendingIntentIds: snapshot.pendingIntentIds,
    workspaceChanges: snapshot.workspaceChanges,
    reason: snapshot.reason,
    actor: snapshot.actor,
    capturedAt: snapshot.capturedAt,
});

const ABANDON_PATHS: Readonly<Partial<Record<TurnState, readonly TurnState[]>>> = {
    received: ["interpreting", "abandoned"],
    interpreting: ["abandoned"],
    clarifying: ["abandoned"],
    acting: ["interrupted", "abandoned"],
    interrupted: ["abandoned"],
    resumed: ["abandoned"],
    responding: ["failed"],
};

export class TurnService extends WorkflowEntityService<"turn"> {
    constructor(store: WorkflowStore) { super(store, "turn"); }

    override get(id: Identifier): Turn { return this.effective(super.get(id)); }

    override find(id: Identifier) {
        const found = super.find(id);
        return found.map(turn => this.effective(turn));
    }

    override list(sessionId?: Identifier): Turn[] {
        return super.list(sessionId).map(turn => this.effective(turn));
    }

    override transition(id: Identifier, state: TurnState, options: TransitionOptions): Turn {
        return this.effective(super.transition(id, state, options));
    }

    interpret(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "interpreting", options); }
    clarify(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "clarifying", options); }
    /** Matching linkage is checked by the common writer; the original Turn survives. */
    resumeClarification(id: Identifier, continuationKey: string, options: TransitionOptions): Turn {
        return this.interpret(id, { ...options, clarification: { replyTo: id, continuationKey } });
    }
    act(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "acting", options); }
    respond(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "responding", options); }
    complete(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "completed", options); }

    /**
     * Interrupts an acting Turn and records the minimal on-site snapshot from
     * §4.2: lifecycle state, origin Turn, pending Intent and workspace changes.
     */
    interrupt(id: Identifier): Turn;
    interrupt(id: Identifier, reason: string, options?: TransitionOptions): Turn;
    interrupt(id: Identifier, options: TurnInterruptOptions): Turn;
    interrupt(id: Identifier, options: TransitionOptions): Turn;
    interrupt(id: Identifier, reasonOrOptions?: string | TransitionOptions | TurnInterruptOptions, maybeOptions?: TransitionOptions): Turn {
        const current = super.get(id);
        if (current.state === "interrupted") {
            const existing = overlayMap(this.store).get(id);
            if (existing !== void 0) return this.effective(current);
        }
        const simpleReason = typeof reasonOrOptions === "string" ? reasonOrOptions : void 0;
        const options = typeof reasonOrOptions === "object" ? reasonOrOptions : maybeOptions;
        const detailed = options as TurnInterruptOptions | undefined;
        const reason = simpleReason ?? detailed?.reason ?? "interrupted";
        if (current.state !== "acting") {
            throw new TurnError("invalid_state", `Only an acting Turn can be interrupted; ${id} is ${current.state}`);
        }
        const pendingIntentIds = this.pendingIntentIds(current);
        if (detailed?.pendingIntentId !== void 0 && !pendingIntentIds.includes(detailed.pendingIntentId)) {
            pendingIntentIds.unshift(detailed.pendingIntentId);
        }
        const actor = options?.actor ?? "host";
        const capturedAt = detailed?.now ?? new Date().toISOString();
        if (!Number.isFinite(Date.parse(capturedAt))) throw new TurnError("invalid_snapshot", "Interruption requires a valid timestamp");
        const body: Omit<TurnInterruptionSnapshot, "digest"> = {
            schemaVersion: TURN_INTERRUPTION_SCHEMA_VERSION,
            turnId: current.id,
            sessionId: current.sessionId,
            state: current.state,
            version: current.version,
            ...(current.originTurnId === void 0 ? {} : { originTurnId: current.originTurnId }),
            ...(pendingIntentIds[0] === void 0 ? {} : { pendingIntentId: pendingIntentIds[0] }),
            pendingIntentIds,
            workspaceChanges: workspaceChangesOf(detailed?.workspaceChanges),
            reason,
            actor,
            capturedAt,
        };
        const snapshot: TurnInterruptionSnapshot = { ...body, digest: digestOf(body) };
        const interrupted = super.transition(id, "interrupted", {
            expectedVersion: options?.expectedVersion ?? current.version,
            actor,
            reason,
        });
        overlayMap(this.store).set(id, { interruption: snapshot, resumed: false });
        return this.effective(interrupted);
    }

    /**
     * Validates the interruption snapshot and continues the Turn back into
     * `acting` through `interrupted -> resumed -> acting` (§4.2). Replaying the
     * same snapshot is idempotent and does not advance the version.
     */
    resume(id: Identifier, options: TurnResumeOptions = {}): Turn {
        const current = super.get(id);
        const overlay = overlayMap(this.store).get(id);
        const candidate: unknown = options.snapshot ?? overlay?.interruption;
        if (candidate === void 0) throw new TurnError("invalid_snapshot", `Turn ${id} has no interruption snapshot`);
        if (!isRecord(candidate)) throw new TurnError("invalid_snapshot", "Turn interruption snapshot must be an object");
        if (candidate.schemaVersion !== TURN_INTERRUPTION_SCHEMA_VERSION || candidate.state !== "acting") {
            throw new TurnError("invalid_snapshot", "Interruption snapshot does not describe an acting Turn");
        }
        if (!text(candidate.turnId) || !text(candidate.sessionId) || !text(candidate.reason) || !text(candidate.actor)
            || !text(candidate.capturedAt) || !Number.isFinite(Date.parse(candidate.capturedAt))
            || typeof candidate.version !== "number" || !Number.isSafeInteger(candidate.version) || candidate.version < 0) {
            throw new TurnError("invalid_snapshot", "Turn interruption snapshot has invalid identity or metadata");
        }
        if (candidate.originTurnId !== void 0 && !text(candidate.originTurnId)) {
            throw new TurnError("invalid_snapshot", "Snapshot originTurnId must be a nonempty identifier");
        }
        if (!Array.isArray(candidate.pendingIntentIds) || !candidate.pendingIntentIds.every(item => text(item))
            || !Array.isArray(candidate.workspaceChanges)) {
            throw new TurnError("invalid_snapshot", "Turn interruption snapshot has invalid pending intents or workspace changes");
        }
        const pendingIntentIds = [...candidate.pendingIntentIds] as string[];
        const workspaceChanges = workspaceChangesOf(candidate.workspaceChanges);
        const pendingIntentId = candidate.pendingIntentId === void 0 ? void 0 : candidate.pendingIntentId;
        if (pendingIntentId !== void 0 && (!text(pendingIntentId) || !pendingIntentIds.includes(pendingIntentId))) {
            throw new TurnError("invalid_snapshot", "Pending Intent id must belong to the snapshot's pending set");
        }
        if (!text(candidate.digest)) throw new TurnError("invalid_snapshot", "Interruption snapshot digest is required");
        const normalized: TurnInterruptionSnapshot = {
            schemaVersion: TURN_INTERRUPTION_SCHEMA_VERSION,
            turnId: candidate.turnId,
            sessionId: candidate.sessionId,
            state: candidate.state,
            version: candidate.version,
            ...(candidate.originTurnId === void 0 ? {} : { originTurnId: candidate.originTurnId }),
            ...(pendingIntentId === void 0 ? {} : { pendingIntentId }),
            pendingIntentIds,
            workspaceChanges,
            reason: candidate.reason,
            actor: candidate.actor,
            capturedAt: candidate.capturedAt,
            digest: candidate.digest,
        };
        const digest = digestOf(snapshotBody(normalized));
        if (candidate.digest !== digest) throw new TurnError("invalid_snapshot", `Turn interruption snapshot ${id} failed its digest check`);
        if (candidate.turnId !== id) throw new TurnError("invalid_snapshot", `Snapshot ${candidate.turnId} does not belong to Turn ${id}`);
        if (candidate.sessionId !== current.sessionId) throw new TurnError("invalid_snapshot", "Interruption snapshot crosses Session scope");
        const replay = overlay?.resumed === true && overlay.interruption.digest === digest;
        if (replay && (current.state === "acting" || current.state === "resumed")) return this.effective(current);
        if (current.state !== "interrupted") {
            throw new TurnError("invalid_state", `Turn ${id} is ${current.state} and cannot resume an interruption`);
        }
        if (normalized.version + 1 !== current.version) {
            throw new TurnError("stale_snapshot", `Snapshot version ${normalized.version} does not match interrupted Turn version ${current.version}`);
        }
        for (const intentId of normalized.pendingIntentIds) {
            const intent = this.store.find("intent", intentId);
            if (intent.isEmpty() || isWorkflowSettled(intent.get())) {
                throw new TurnError("stale_snapshot", `Pending Intent ${intentId} is no longer unresolved; resolve the stale workspace before resuming`);
            }
        }
        const actor = options.actor ?? normalized.actor;
        const resumed = super.transition(id, "resumed", {
            expectedVersion: options.expectedVersion ?? current.version,
            actor,
            reason: options.reason ?? `resume interruption ${digest}`,
        });
        const acting = super.transition(id, "acting", {
            expectedVersion: resumed.version,
            actor,
            reason: options.reason ?? `resume interruption ${digest}`,
        });
        overlayMap(this.store).set(id, { interruption: normalized, resumed: true });
        return this.effective(acting);
    }

    /**
     * §4.2 "用户显式取消": the Turn becomes `abandoned` through legal edges.
     * A `responding` Turn has no abandoned edge and is failed instead; the
     * returned entity always reports the final state.
     */
    abandon(id: Identifier): Turn;
    abandon(id: Identifier, reason: string, options?: TransitionOptions): Turn;
    abandon(id: Identifier, options: TransitionOptions): Turn;
    abandon(id: Identifier, reasonOrOptions?: string | TransitionOptions, maybeOptions?: TransitionOptions): Turn {
        const current = super.get(id);
        const simpleReason = typeof reasonOrOptions === "string" ? reasonOrOptions : void 0;
        const options = typeof reasonOrOptions === "object" ? reasonOrOptions : maybeOptions;
        const reason = simpleReason ?? options?.reason ?? "turn abandoned";
        if (isWorkflowTerminal(current)) {
            if (current.state === "abandoned") return this.effective(current);
            throw new TurnError("invalid_state", `Turn ${id} is ${current.state} and cannot be abandoned`);
        }
        const path = ABANDON_PATHS[current.state];
        if (path === void 0) throw new TurnError("invalid_state", `Turn ${id} is ${current.state} and cannot be abandoned`);
        const actor = options?.actor ?? "host";
        let next = current;
        if (current.state === "acting") {
            const pendingIntentIds = this.pendingIntentIds(current);
            const capturedAt = new Date().toISOString();
            const body: Omit<TurnInterruptionSnapshot, "digest"> = {
                schemaVersion: TURN_INTERRUPTION_SCHEMA_VERSION,
                turnId: current.id,
                sessionId: current.sessionId,
                state: current.state,
                version: current.version,
                ...(current.originTurnId === void 0 ? {} : { originTurnId: current.originTurnId }),
                ...(pendingIntentIds[0] === void 0 ? {} : { pendingIntentId: pendingIntentIds[0] }),
                pendingIntentIds,
                workspaceChanges: [],
                reason,
                actor,
                capturedAt,
            };
            overlayMap(this.store).set(id, { interruption: { ...body, digest: digestOf(body) }, resumed: false });
        }
        for (const [index, state] of path.entries()) {
            next = super.transition(id, state, {
                expectedVersion: options?.expectedVersion !== void 0 && index === 0 ? options.expectedVersion : next.version,
                actor,
                reason,
            });
        }
        return this.effective(next);
    }

    /**
     * §4.2 "用户打断（新输入）": the current Turn is superseded by new input.
     * An acting Turn is interrupted with its snapshot preserved; other
     * unfinished Turns are abandoned so the new Turn can start cleanly.
     */
    supersede(id: Identifier, reason: string, options?: TransitionOptions): Turn {
        const current = super.get(id);
        if (isWorkflowTerminal(current)) return this.effective(current);
        const label = `superseded by new input: ${reason}`;
        if (current.state === "acting") return this.interrupt(id, label, options);
        return this.abandon(id, label, options);
    }

    /** Returns the last captured interruption snapshot, if any. */
    interruption(id: Identifier): TurnInterruptionSnapshot | undefined {
        return overlayMap(this.store).get(id)?.interruption ?? super.get(id).interruption;
    }

    /** Compacts Turn history for a Session (§4.2); see `compactTurnHistory`. */
    compactHistory(sessionId: Identifier, policy: TurnCompactionPolicy): TurnCompactionResult {
        return compactTurnHistory(this.store, sessionId, policy);
    }

    private effective(turn: Turn): Turn {
        const overlay = overlayMap(this.store).get(turn.id);
        if (overlay === void 0) return turn;
        return {
            ...turn,
            interruption: overlay.interruption,
            ...(overlay.resumed ? { resumedFromSnapshot: true } : {}),
        };
    }

    private pendingIntentIds(turn: Turn): Identifier[] {
        return this.store.list("intent", turn.sessionId)
            .filter(intent => intent.originTurnId === turn.id && !isWorkflowSettled(intent))
            .map(intent => intent.id);
    }
}
