import type { Identifier } from "../shared.ts";

export type Profession = {
    readonly id: Identifier;
    readonly version: string;
    readonly allowedCapabilityIds: readonly Identifier[];
    readonly deniedCapabilityIds: readonly Identifier[];
    readonly verificationStrictness: "standard" | "strict" | "paranoid";
    readonly riskPreference: "low" | "balanced" | "high";
};

export type PermissionScope = {
    readonly capabilityIds: readonly Identifier[];
    readonly operations: readonly string[];
    readonly resources: readonly string[];
    readonly allowWrite: boolean;
};
