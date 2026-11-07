import type { Identifier, JsonValue } from "../shared.ts";

export type Clock = () => string;
export type CapabilityKind = "tool" | "skill" | "protocol" | "cognition" | "behavior";
export type CapabilityStatus = "active" | "degraded" | "failed" | "revoked";

export type CapabilityDependency = {
    readonly capabilityId: Identifier;
    readonly version: string;
    readonly required: boolean;
    readonly fallback?: { readonly capabilityId: Identifier; readonly version: string };
};

export type CapabilityDefinition = {
    readonly id: Identifier;
    readonly version: string;
    readonly kind: CapabilityKind;
    readonly digest: string;
    readonly contract: JsonValue;
    readonly dependencies: readonly CapabilityDependency[];
    readonly risk: "low" | "medium" | "high" | "critical";
    readonly definedAt: string;
    readonly source?: Identifier;
};

export type DependencyResolution = {
    readonly capabilityId: Identifier;
    readonly version: string;
    readonly status: "available" | "fallback" | "missing" | "invalid";
    readonly required: boolean;
    readonly resolvedCapabilityId?: Identifier;
    readonly resolvedVersion?: string;
};

export type CapabilityActivation = {
    readonly activationId: Identifier;
    readonly capabilityId: Identifier;
    readonly version: string;
    readonly status: CapabilityStatus;
    readonly activatedAt: string;
    readonly invalidatedAt?: string;
    readonly dependencies: readonly DependencyResolution[];
    readonly reason?: string;
};

export type CapabilityQuery = {
    readonly kind?: CapabilityKind;
    readonly id?: Identifier;
    readonly usableOnly?: boolean;
};

/* ------------------------------------------------------------------------- */
/* Lifecycle states (refract §6.3–§6.6)                                      */
/* ------------------------------------------------------------------------- */

/** Tool lifecycle states (refract §6.3): `registered → validated → available ⇄ degraded → unavailable → deprecated → retired`. */
export type ToolState = "registered" | "validated" | "available" | "degraded" | "unavailable" | "deprecated" | "retired";

/** Skill lifecycle states (refract §6.4). */
export type SkillState =
    | "draft"
    | "validated"
    | "binding"
    | "ready"
    | "cooling"
    | "active"
    | "completed"
    | "failed"
    | "deprecated"
    | "retired";

/** Protocol lifecycle states (refract §6.5). */
export type ProtocolState =
    | "defined"
    | "negotiated"
    | "bound"
    | "active"
    | "versioned"
    | "deprecated"
    | "migrated"
    | "retired";

/** Cognition lifecycle states (refract §6.6). */
export type CognitionState =
    | "registered"
    | "validated"
    | "available"
    | "activated"
    | "cooling"
    | "evaluated"
    | "promoted"
    | "demoted"
    | "deprecated"
    | "retired";

/** The four capability kinds governed by {@link CapabilityLifecycleRegistry}. Behavior has its own lifecycle (refract §7.4). */
export type CapabilityLifecycleKind = "tool" | "skill" | "protocol" | "cognition";

export type CapabilityLifecycleState = ToolState | SkillState | ProtocolState | CognitionState;

/** An exact or floating capability reference. A missing `version` means "any version". */
export type CapabilityReference = {
    readonly id: Identifier;
    readonly version?: string;
};

/** References a Skill declares to the capabilities its steps depend on (refract §6.4). */
export type CapabilityReferences = {
    readonly tools?: readonly CapabilityReference[];
    readonly protocols?: readonly CapabilityReference[];
    readonly cognitions?: readonly CapabilityReference[];
    readonly behaviors?: readonly CapabilityReference[];
};

export type CapabilityLifecycleEvent = {
    /** Absent only for the synthetic registration event. */
    readonly from?: CapabilityLifecycleState;
    readonly to: CapabilityLifecycleState;
    readonly at: string;
    readonly reason?: string;
};

/**
 * A registered capability and its current lifecycle position. Events are the
 * audit trail; the record itself is immutable and every transition returns a
 * new record.
 */
export type CapabilityLifecycleRecord = {
    readonly capabilityId: Identifier;
    readonly version: string;
    readonly kind: CapabilityLifecycleKind;
    readonly state: CapabilityLifecycleState;
    readonly references: CapabilityReferences;
    readonly events: readonly CapabilityLifecycleEvent[];
    readonly registeredAt: string;
    readonly updatedAt: string;
};

export type CapabilityLifecycleRegistration = {
    readonly capabilityId: Identifier;
    readonly version: string;
    readonly kind: CapabilityLifecycleKind;
    /**
     * Restored lifecycle position for persistence/rehydration. Omitted means the
     * kind's canonical initial state (`registered` / `draft` / `defined` / `registered`).
     */
    readonly state?: CapabilityLifecycleState;
    readonly references?: CapabilityReferences;
    /** Optional registration audit note (e.g. "restored from host persistence"). */
    readonly reason?: string;
};

export type CapabilityLifecycleQuery = {
    readonly kind?: CapabilityLifecycleKind;
    readonly capabilityId?: Identifier;
    readonly state?: CapabilityLifecycleState;
};
