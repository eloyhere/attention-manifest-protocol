/**
 * Discovery vocabulary.
 *
 * Kept free of context imports so the wire contract can import the enums
 * without depending on the workspace domain.
 */

export const ModuleKinds = [
    "service",
    "tool",
    "controller",
    "route",
    "repository",
    "model",
    "config",
    "test",
    "middleware",
    "component",
    "util",
    "unknown",
] as const;

export type ModuleKind = (typeof ModuleKinds)[number];

export const ComponentKinds = ["plugin", "service", "tool", "module"] as const;

export type ComponentKind = (typeof ComponentKinds)[number];

export const DiscoveryScopes = ["all", "projects", "host"] as const;

export type DiscoveryScope = (typeof DiscoveryScopes)[number];

export const ComponentStatuses = ["active", "disabled", "deprecated"] as const;

export type ComponentStatus = (typeof ComponentStatuses)[number];
