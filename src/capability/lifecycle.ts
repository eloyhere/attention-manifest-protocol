import { Optional, SynchronousUnorderedMap } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import type {
    CapabilityLifecycleEvent,
    CapabilityLifecycleKind,
    CapabilityLifecycleQuery,
    CapabilityLifecycleRecord,
    CapabilityLifecycleRegistration,
    CapabilityLifecycleState,
    CapabilityReference,
    CapabilityReferences,
    Clock,
    CognitionState,
    ProtocolState,
    SkillState,
    ToolState,
} from "./types.ts";

const clone = <T>(value: T): T => structuredClone(value);
const fail = (message: string): never => {
    throw new TypeError(message);
};
const text = (value: unknown, field: string): string =>
    typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);
const edgesOf = <T extends string>(edges: readonly T[]): readonly T[] => Object.freeze(edges);

/**
 * Legal Tool transitions (refract §6.3).
 *
 * `degraded` is entered by consecutive failures / error-rate pressure and left
 * through a half-open probe; `unavailable` is the hard-failure state. A
 * capability may be deprecated from any state in which it is still callable so
 * that operators can announce a compatibility window without first forcing a
 * failure (the diagram's minimal edge is `unavailable → deprecated`).
 */
export const TOOL_LIFECYCLE_TRANSITIONS: Readonly<Record<ToolState, readonly ToolState[]>> = Object.freeze({
    registered: edgesOf(["validated"]),
    validated: edgesOf(["available"]),
    available: edgesOf(["degraded", "unavailable", "deprecated"]),
    degraded: edgesOf(["available", "unavailable", "deprecated"]),
    unavailable: edgesOf(["deprecated"]),
    deprecated: edgesOf(["retired"]),
    retired: edgesOf([]),
});

/**
 * Legal Skill transitions (refract §6.4).
 *
 * `ready ⇄ cooling` is the recovery loop; `failed` is reachable from every
 * state that still holds bound dependencies because §6.7 propagates an
 * unavailable Tool into `failed` regardless of whether the Skill was binding,
 * ready, cooling or active.
 */
export const SKILL_LIFECYCLE_TRANSITIONS: Readonly<Record<SkillState, readonly SkillState[]>> = Object.freeze({
    draft: edgesOf(["validated"]),
    validated: edgesOf(["binding"]),
    binding: edgesOf(["ready", "failed"]),
    ready: edgesOf(["cooling", "active", "failed"]),
    cooling: edgesOf(["ready", "failed"]),
    active: edgesOf(["completed", "cooling", "failed"]),
    completed: edgesOf(["deprecated"]),
    failed: edgesOf(["deprecated"]),
    deprecated: edgesOf(["retired"]),
    retired: edgesOf([]),
});

/**
 * Legal Protocol transitions (refract §6.5).
 *
 * Breaking changes move an active protocol to `versioned`; binders that have
 * not migrated are marked `deprecated`, and retirement is only reachable after
 * every binder has migrated (`deprecated → migrated → retired`).
 */
export const PROTOCOL_LIFECYCLE_TRANSITIONS: Readonly<Record<ProtocolState, readonly ProtocolState[]>> = Object.freeze({
    defined: edgesOf(["negotiated"]),
    negotiated: edgesOf(["bound"]),
    bound: edgesOf(["active"]),
    active: edgesOf(["versioned", "deprecated"]),
    versioned: edgesOf(["deprecated"]),
    deprecated: edgesOf(["migrated"]),
    migrated: edgesOf(["retired"]),
    retired: edgesOf([]),
});

/**
 * Legal Cognition transitions (refract §6.6).
 *
 * `activated ⇄ cooling` is the availability loop; periodic evaluation moves an
 * activated strategy to `evaluated` and then to `promoted` or `demoted`.
 * Demotion is terminal for the current version and propagates to referencing
 * Skills through {@link propagateCognitionDemotion}; re-entry happens by
 * validating a new version.
 */
export const COGNITION_LIFECYCLE_TRANSITIONS: Readonly<Record<CognitionState, readonly CognitionState[]>> = Object.freeze({
    registered: edgesOf(["validated"]),
    validated: edgesOf(["available"]),
    available: edgesOf(["activated"]),
    activated: edgesOf(["cooling", "evaluated"]),
    cooling: edgesOf(["activated"]),
    evaluated: edgesOf(["promoted", "demoted"]),
    promoted: edgesOf(["deprecated"]),
    demoted: edgesOf(["deprecated"]),
    deprecated: edgesOf(["retired"]),
    retired: edgesOf([]),
});

/** Canonical first state for each capability kind. */
export const INITIAL_CAPABILITY_STATES: Readonly<Record<CapabilityLifecycleKind, CapabilityLifecycleState>> = Object.freeze({
    tool: "registered",
    skill: "draft",
    protocol: "defined",
    cognition: "registered",
});

const TRANSITIONS: Readonly<Record<CapabilityLifecycleKind, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
    tool: TOOL_LIFECYCLE_TRANSITIONS,
    skill: SKILL_LIFECYCLE_TRANSITIONS,
    protocol: PROTOCOL_LIFECYCLE_TRANSITIONS,
    cognition: COGNITION_LIFECYCLE_TRANSITIONS,
});

const STATE_SETS: Readonly<Record<CapabilityLifecycleKind, ReadonlySet<string>>> = Object.freeze({
    tool: new Set<string>(Object.keys(TOOL_LIFECYCLE_TRANSITIONS)),
    skill: new Set<string>(Object.keys(SKILL_LIFECYCLE_TRANSITIONS)),
    protocol: new Set<string>(Object.keys(PROTOCOL_LIFECYCLE_TRANSITIONS)),
    cognition: new Set<string>(Object.keys(COGNITION_LIFECYCLE_TRANSITIONS)),
});

const keyOf = (capabilityId: Identifier, version: string): string => `${capabilityId}@${version}`;

export function isCapabilityLifecycleKind(value: unknown): value is CapabilityLifecycleKind {
    return value === "tool" || value === "skill" || value === "protocol" || value === "cognition";
}

export function assertCapabilityLifecycleKind(value: unknown): CapabilityLifecycleKind {
    return isCapabilityLifecycleKind(value) ? value : fail(`unknown capability lifecycle kind: ${String(value)}`);
}

export function isToolState(value: unknown): value is ToolState {
    return typeof value === "string" && STATE_SETS.tool.has(value);
}
export function isSkillState(value: unknown): value is SkillState {
    return typeof value === "string" && STATE_SETS.skill.has(value);
}
export function isProtocolState(value: unknown): value is ProtocolState {
    return typeof value === "string" && STATE_SETS.protocol.has(value);
}
export function isCognitionState(value: unknown): value is CognitionState {
    return typeof value === "string" && STATE_SETS.cognition.has(value);
}

/** True when `state` is a declared state of `kind` (not necessarily reachable). */
export function isCapabilityLifecycleState(kind: CapabilityLifecycleKind, state: unknown): state is CapabilityLifecycleState {
    return isCapabilityLifecycleKind(kind) && STATE_SETS[kind].has(state as string);
}

export function assertCapabilityLifecycleState(kind: CapabilityLifecycleKind, state: unknown): CapabilityLifecycleState {
    return isCapabilityLifecycleState(kind, state) ? state : fail(`unknown ${kind} lifecycle state: ${String(state)}`);
}

/** Pure edge predicate. Unknown states or kinds are never transitionable. */
export function canTransition(kind: CapabilityLifecycleKind, from: CapabilityLifecycleState, to: CapabilityLifecycleState): boolean {
    if (!isCapabilityLifecycleKind(kind) || !isCapabilityLifecycleState(kind, from) || !isCapabilityLifecycleState(kind, to)) return false;
    return (TRANSITIONS[kind][from] ?? []).includes(to);
}

export function assertCapabilityTransition(kind: CapabilityLifecycleKind, from: CapabilityLifecycleState, to: CapabilityLifecycleState): void {
    assertCapabilityLifecycleState(kind, to);
    if (!canTransition(kind, from, to)) fail(`invalid ${kind} lifecycle transition: ${from} -> ${to}`);
}

const reference = (value: CapabilityReference, field: string): CapabilityReference => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${field} must be an object`);
    const id = text(value.id, `${field}.id`);
    if (value.version !== undefined) text(value.version, `${field}.version`);
    return Object.freeze({ id, ...(value.version === undefined ? {} : { version: value.version }) });
};

const referencesOf = (value: CapabilityReferences | undefined, field: string): CapabilityReferences => {
    if (value === undefined) return Object.freeze({ tools: Object.freeze([]), protocols: Object.freeze([]), cognitions: Object.freeze([]), behaviors: Object.freeze([]) });
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${field} must be an object`);
    const section = (entries: readonly CapabilityReference[] | undefined, name: string): readonly CapabilityReference[] => {
        if (entries === undefined) return Object.freeze([]);
        if (!Array.isArray(entries)) fail(`${field}.${name} must be an array`);
        return Object.freeze(entries.map((entry, index) => reference(entry, `${field}.${name}[${index}]`)));
    };
    return Object.freeze({
        tools: section(value.tools, "tools"),
        protocols: section(value.protocols, "protocols"),
        cognitions: section(value.cognitions, "cognitions"),
        behaviors: section(value.behaviors, "behaviors"),
    });
};

/**
 * Registry for the Tool / Skill / Protocol / Cognition lifecycle state machines
 * (refract §6.3–§6.6, governance layer §6.8). The registry owns registration and
 * legal transitions only; evaluation, shadow execution and evidence stay with
 * the host. Every mutation returns a fresh record and appends one audit event.
 */
export class CapabilityLifecycleRegistry {
    private readonly records = new SynchronousUnorderedMap<string, CapabilityLifecycleRecord>();
    private readonly clock: Clock;

    constructor(clock: Clock = () => new Date().toISOString()) {
        this.clock = clock;
    }

    /**
     * Registers a capability. Omitted `state` starts at the kind's canonical
     * initial state; an explicit state is accepted for host rehydration and is
     * checked against the kind's state set (never against reachability).
     */
    register(input: CapabilityLifecycleRegistration): CapabilityLifecycleRecord {
        if (typeof input !== "object" || input === null || Array.isArray(input)) fail("Capability lifecycle registration must be an object");
        const capabilityId = text(input.capabilityId, "capabilityId");
        const version = text(input.version, "version");
        const kind = assertCapabilityLifecycleKind(input.kind);
        const state = input.state === undefined ? INITIAL_CAPABILITY_STATES[kind] : assertCapabilityLifecycleState(kind, input.state);
        const key = keyOf(capabilityId, version);
        if (this.records.containsKey(key)) fail(`capability already registered: ${key}`);
        const references = referencesOf(input.references, "references");
        const at = this.clock();
        const event: CapabilityLifecycleEvent = Object.freeze({
            to: state,
            at,
            ...(input.reason === undefined ? {} : { reason: text(input.reason, "reason") }),
        });
        const record: CapabilityLifecycleRecord = Object.freeze({
            capabilityId,
            version,
            kind,
            state,
            references,
            events: Object.freeze([event]),
            registeredAt: at,
            updatedAt: at,
        });
        this.records.put(key, clone(record));
        return clone(record);
    }

    get(capabilityId: Identifier, version: string): CapabilityLifecycleRecord | undefined {
        const value = this.find(capabilityId, version);
        return value.isPresent() ? clone(value.get()) : undefined;
    }

    find(capabilityId: Identifier, version: string): Optional<CapabilityLifecycleRecord> {
        return this.records.get(keyOf(capabilityId, version)).map(clone);
    }

    list(query: CapabilityLifecycleQuery = {}): readonly CapabilityLifecycleRecord[] {
        return Object.freeze(this.records.values().toArray()
            .filter(record =>
                (query.kind === undefined || record.kind === query.kind)
                && (query.capabilityId === undefined || record.capabilityId === query.capabilityId)
                && (query.state === undefined || record.state === query.state))
            .map(clone));
    }

    /** Moves one capability along its machine, or rejects the edge. */
    transition(capabilityId: Identifier, version: string, next: CapabilityLifecycleState, reason?: string): CapabilityLifecycleRecord {
        const current = this.require(capabilityId, version);
        assertCapabilityLifecycleState(current.kind, next);
        assertCapabilityTransition(current.kind, current.state, next);
        const at = this.clock();
        const event: CapabilityLifecycleEvent = Object.freeze({
            from: current.state,
            to: next,
            at,
            ...(reason === undefined ? {} : { reason: text(reason, "reason") }),
        });
        const updated: CapabilityLifecycleRecord = Object.freeze({
            ...current,
            state: next,
            events: Object.freeze([...current.events, event]),
            updatedAt: at,
        });
        this.records.put(keyOf(capabilityId, version), clone(updated));
        return clone(updated);
    }

    /** Edge predicate for a registered record; unknown records are not transitionable. */
    canTransition(capabilityId: Identifier, version: string, next: CapabilityLifecycleState): boolean {
        const current = this.find(capabilityId, version);
        return current.isPresent() && canTransition(current.get().kind, current.get().state, next);
    }

    /** Immutable audit trail, oldest event first. */
    events(capabilityId: Identifier, version: string): readonly CapabilityLifecycleEvent[] {
        return Object.freeze([...this.require(capabilityId, version).events]);
    }

    private require(capabilityId: Identifier, version: string): CapabilityLifecycleRecord {
        const value = this.records.get(keyOf(capabilityId, version));
        if (value.isEmpty()) fail(`unknown capability lifecycle record: ${keyOf(capabilityId, version)}`);
        return value.get();
    }
}
