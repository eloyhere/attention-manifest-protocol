import type { Identifier } from "../shared.ts";
import type { ProjectEnvironment } from "./environment.ts";

export type ViewKind = "er" | "sequence" | "flow" | "venn" | "architecture" | "mindmap";

/**
 * Why a consumer would read a projection. The purpose stays host-side: it
 * routes and validates a view but never renders it into model context (§13.5).
 */
export type ViewPurpose = "routing" | "verification" | "planning" | "diagnosis" | "retention";

export interface ProjectScope {
    readonly tenantId: Identifier;
    readonly rootId: Identifier;
}

export interface ProjectRule {
    readonly id: Identifier;
    readonly tenantId: Identifier;
    readonly rootId: Identifier;
    readonly text: string;
    readonly version: number;
    readonly hash: string;
    readonly source?: string;
    readonly updatedAt: string;
}

export type ProjectRuleInput = Omit<ProjectRule, "version" | "hash" | "updatedAt"> & { readonly expectedVersion?: number };

export interface ProjectMetadata {
    readonly path: string;
    readonly tenantId: Identifier;
    readonly rootId: Identifier;
    readonly kind?: string;
    readonly tags: readonly string[];
    readonly ruleIds: readonly Identifier[];
    readonly version: number;
    readonly updatedAt: string;
}

export interface ProjectView {
    readonly kind: ViewKind;
    readonly tenantId: Identifier;
    readonly rootId: Identifier;
    readonly projection: unknown;
    readonly sourceRuleIds: readonly Identifier[];
    readonly sourceVersions: readonly { readonly ruleId: Identifier; readonly version: number }[];
    readonly version: number;
    readonly stale: boolean;
    readonly updatedAt: string;
    /** Consumption intent of the projection; omitted for legacy callers. */
    readonly purpose?: ViewPurpose;
    /** Stable object references the projection is anchored to; they are checked against the project anchor registry. */
    readonly anchors?: readonly string[];
    /** Deterministic constraints the host enforces; they never enter model context. */
    readonly constraints?: readonly string[];
    /** Freshness of the projection from 0 (stale) to 1 (fresh). */
    readonly freshness?: number;
}

/**
 * Host-side registry of view anchors.
 *
 * Views are projections and must never invent their own truth: an anchor names
 * an object the host has registered for this project. Hosts persist the anchor
 * list and, after a restart, replay `registerAnchor` for every remembered entry
 * before putting views again. Registering the same anchor twice is rejected so
 * a replay can never silently mask a corrupt or duplicated persisted list.
 *
 * Implementations are synchronous because view validation is synchronous.
 */
export interface AnchorRegistry {
    /** Add one anchor. Throws `duplicate` when it is already registered. */
    registerAnchor(anchor: string): void;
    /** Remove one anchor; returns true when it was registered. */
    unregisterAnchor(anchor: string): boolean;
    /** True when the anchor is registered. */
    resolveAnchor(anchor: string): boolean;
    /** Registered anchors in stable registration order (frozen). */
    listAnchors(): readonly string[];
}

export interface ProjectOptions extends ProjectScope {
    readonly clock?: () => string;
    /** Initial environment; it is merged over an empty base and then versioned by the project. */
    readonly environment?: ProjectEnvironment;
    /** Project-kind id (go/tex/text/photoshop/cad/max3d/solidworks) recorded for guidance. */
    readonly kind?: string;
    /** Extra agent-facing configuration instructions shown in the environment brief. */
    readonly guidance?: readonly string[];
    /**
     * Host-side registry for view anchors. When provided, `putView` and
     * `Project.validateView` use it as the default anchor check and reject an
     * anchor that is not registered.
     */
    readonly anchorRegistry?: AnchorRegistry;
    /**
     * Initial anchors for host replay after a restart. Equivalent to calling
     * `registerAnchor` for each value in order; duplicates are rejected.
     */
    readonly anchors?: Iterable<string>;
    /**
     * Legacy host-side resolver for view anchors. When provided, `putView` and
     * `Project.validateView` reject anchors that do not name an existing object.
     */
    readonly anchorExists?: (anchor: string) => boolean;
}

/** Options used by `validateView` and `Project.validateView`. */
export interface ViewValidationOptions {
    /** Returns true when the anchor names an existing host object. */
    readonly anchorExists?: (anchor: string) => boolean;
    /** Explicit existing-anchor set for hosts that cannot provide a predicate. */
    readonly knownAnchors?: Iterable<string>;
}
