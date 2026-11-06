import type { Identifier } from "../shared.ts";
import type { ProjectEnvironment } from "./environment.ts";

export type ViewKind = "er" | "sequence" | "flow" | "venn" | "architecture" | "mindmap";

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
}

export interface ProjectOptions extends ProjectScope {
    readonly clock?: () => string;
    /** Initial environment; it is merged over an empty base and then versioned by the project. */
    readonly environment?: ProjectEnvironment;
    /** Project-kind id (go/tex/text/photoshop/cad/max3d/solidworks) recorded for guidance. */
    readonly kind?: string;
    /** Extra agent-facing configuration instructions shown in the environment brief. */
    readonly guidance?: readonly string[];
}
