import { createHash } from "node:crypto";
import type { WorkflowStore } from "../workflow/store.ts";
import type { WorkflowEvent } from "../workflow/types.ts";
import { isWorkflowSettled, isWorkflowTerminal } from "../workflow/transitions.ts";
import { TurnError } from "./types.ts";
import type {
    Turn, TurnCompactionPolicy, TurnCompactionPolicySnapshot, TurnCompactionProtected, TurnCompactionRecord,
    TurnCompactionResult, TurnHistorySummary,
} from "./types.ts";

const stableJson = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== void 0)
        .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
};

const digestOf = (value: unknown): string => `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;

const validPolicy = (policy: TurnCompactionPolicy): TurnCompactionPolicySnapshot => {
    if (typeof policy !== "object" || policy === null) {
        throw new TurnError("invalid_policy", "Turn compaction policy must be an object");
    }
    if (!Number.isSafeInteger(policy.keepRecent) || policy.keepRecent < 0) {
        throw new TurnError("invalid_policy", "Turn compaction keepRecent must be a nonnegative safe integer");
    }
    const summarizeWithin = policy.summarizeWithin ?? policy.keepRecent;
    if (!Number.isSafeInteger(summarizeWithin) || summarizeWithin < 0) {
        throw new TurnError("invalid_policy", "Turn compaction summarizeWithin must be a nonnegative safe integer");
    }
    if (policy.sessionSummary !== void 0 && (typeof policy.sessionSummary !== "string" || policy.sessionSummary.trim() === "")) {
        throw new TurnError("invalid_policy", "Turn compaction sessionSummary must be nonempty when supplied");
    }
    if (policy.now !== void 0 && (typeof policy.now !== "string" || !Number.isFinite(Date.parse(policy.now)))) {
        throw new TurnError("invalid_policy", "Turn compaction now must be a valid instant");
    }
    return {
        keepRecent: policy.keepRecent,
        summarizeWithin,
        ...(policy.sessionSummary === void 0 ? {} : { sessionSummary: policy.sessionSummary }),
    };
};

const eventSummary = (turn: Turn, events: readonly WorkflowEvent[]): TurnHistorySummary => ({
    turnId: turn.id,
    id: turn.id,
    state: turn.state,
    tier: "event_summary",
    summary: events.length === 0
        ? `${turn.id} (${turn.state}) has no recorded lifecycle events`
        : `${turn.id} (${turn.state}): ${events.length} lifecycle event(s) — ${events.map(event => event.eventType).join(", ")}`,
    eventCount: events.length,
    createdAt: turn.createdAt,
});

const archivedSummary = (turn: Turn, events: readonly WorkflowEvent[]): TurnHistorySummary => ({
    turnId: turn.id,
    id: turn.id,
    state: turn.state,
    tier: "session_summary",
    summary: `${turn.id} (${turn.state})${events.length === 0 ? "" : `, ${events.length} event(s)`}`,
    eventCount: events.length,
    createdAt: turn.createdAt,
});

/**
 * Compacts Turn history for one Session (§4.2):
 * - the most recent `keepRecent` Turns stay complete;
 * - the next `summarizeWithin` Turns become event summaries;
 * - older Turns collapse into one session summary.
 *
 * Active Turns, Turns that captured unresolved Intents and Turns tied to an
 * active Mission are never compacted. The returned record is shaped as a
 * `system_rule` evidence source; the host attaches it to the evidence ledger.
 */
export function compactTurnHistory(store: WorkflowStore, sessionId: string, policy: TurnCompactionPolicy): TurnCompactionResult {
    if (store.find("session", sessionId).isEmpty()) {
        throw new TurnError("not_found", `Session ${sessionId} does not exist`);
    }
    const normalized = validPolicy(policy);
    const now = policy.now ?? new Date().toISOString();
    const turns = store.list("turn", sessionId).map((turn, index) => ({ turn, index }));
    const ordered = [...turns].sort((left, right) =>
        left.turn.createdAt.localeCompare(right.turn.createdAt) || left.index - right.index);

    const protectedEntries: TurnCompactionProtected[] = [];
    const protectedIds = new Set<string>();
    const protect = (turnId: string | undefined, reason: TurnCompactionProtected["reason"]): void => {
        if (turnId === void 0 || protectedIds.has(turnId)) return;
        if (!store.find("turn", turnId).isPresent()) return;
        protectedIds.add(turnId);
        protectedEntries.push({ turnId, reason });
    };
    for (const entry of ordered) {
        if (!isWorkflowTerminal(entry.turn)) protect(entry.turn.id, "active_turn");
    }
    const unresolvedIntents = store.list("intent", sessionId).filter(intent => !isWorkflowSettled(intent));
    for (const intent of unresolvedIntents) protect(intent.originTurnId, "unresolved_intent");
    const activeMissions = store.list("mission", sessionId).filter(mission => !isWorkflowTerminal(mission));
    for (const mission of activeMissions) {
        protect(mission.originTurnId, "active_mission");
        const intent = store.find("intent", mission.intentId);
        intent.ifPresent(value => protect(value.originTurnId, "active_mission"));
    }

    const candidates = ordered.filter(entry => !protectedIds.has(entry.turn.id));
    const keepCount = Math.min(normalized.keepRecent, candidates.length);
    const boundary = candidates.length - keepCount;
    const summarizeStart = Math.max(0, boundary - normalized.summarizeWithin);
    const keptCandidateIds = new Set(candidates.slice(boundary).map(entry => entry.turn.id));
    const summarizedTurns = candidates.slice(summarizeStart, boundary).map(entry => entry.turn);
    const archivedTurns = candidates.slice(0, summarizeStart).map(entry => entry.turn);
    const kept = ordered
        .filter(entry => protectedIds.has(entry.turn.id) || keptCandidateIds.has(entry.turn.id))
        .map(entry => entry.turn);

    const eventsByTurn = new Map<string, WorkflowEvent[]>();
    for (const event of store.history()) {
        if (event.entityKind !== "turn") continue;
        const list = eventsByTurn.get(event.entityId);
        if (list === void 0) eventsByTurn.set(event.entityId, [event]);
        else list.push(event);
    }
    const summarized = summarizedTurns.map(turn => eventSummary(turn, eventsByTurn.get(turn.id) ?? []));
    const archived = archivedTurns.map(turn => archivedSummary(turn, eventsByTurn.get(turn.id) ?? []));

    const generatedSummary = archived.length === 0
        ? `Session ${sessionId}: no Turns archived.`
        : `Session ${sessionId}: ${archived.length} earlier turn(s) collapsed — ${archived.map(item => `${item.turnId}(${item.state})`).join(", ")}.`;
    const sessionSummary = normalized.sessionSummary ?? generatedSummary;
    const reason = [
        `refract §4.2 turn history compaction for session ${sessionId}`,
        `keepRecent=${normalized.keepRecent} summarizeWithin=${normalized.summarizeWithin}`,
        `${kept.length} kept, ${summarized.length} summarized, ${archived.length} archived`,
        protectedEntries.length === 0
            ? "no protected turns"
            : `${protectedEntries.length} protected (active/unresolved/active-mission)`,
    ].join("; ") + ".";

    const policySnapshot: TurnCompactionPolicySnapshot = {
        keepRecent: normalized.keepRecent,
        summarizeWithin: normalized.summarizeWithin,
        ...(normalized.sessionSummary === void 0 ? {} : { sessionSummary: normalized.sessionSummary }),
    };
    const base = {
        evidenceKind: "system_rule" as const,
        sessionId,
        policy: policySnapshot,
        keptIds: kept.map(turn => turn.id),
        summarizedIds: summarized.map(item => item.turnId),
        archivedIds: archived.map(item => item.turnId),
        protected: protectedEntries,
        sessionSummary,
        reason,
        createdAt: now,
    };
    const digest = digestOf(base);
    const record: TurnCompactionRecord = {
        ...base,
        id: `turn-compaction:${digest}`,
        source: {
            type: "system_rule",
            reliability: 0.95,
            independenceKey: `system_rule:turn_compaction:${sessionId}:${digest}`,
        },
        digest,
    };
    return { kept, summarized, archived, record };
}
