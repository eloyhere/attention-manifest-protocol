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
