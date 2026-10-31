/**
 * AMP workspace extension v1. Local entity IDs are opaque workspace keys,
 * not paths or global AMP object IDs. JSON Schemas are shared by all adapters.
 */
type WorkspaceProtocolName = "amp.workspace";
type WorkspaceVersion = 1;
export const WorkspaceProtocol: WorkspaceProtocolName = "amp.workspace";
export const WorkspaceProtocolVersion: WorkspaceVersion = 1;

export type WorkspaceErrorCode =
    | "invalid_arguments"
    | "unknown_tool"
    | "revision_mismatch"
    | "not_available"
    | "frame_unavailable"
    | "budget_exhausted"
    | "capacity_exceeded"
    | "response_too_large"
    | "integrity_failure"
    | "internal_error";

export type WorkspaceResponse = {
    protocol: typeof WorkspaceProtocol;
    version: typeof WorkspaceProtocolVersion;
    revision: string;
} & ({ ok: true; data: Record<string, unknown>; } | { ok: false; error: { code: WorkspaceErrorCode; message: string; }; });

export interface WorkspaceToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

const Key: Record<string, unknown> = { type: "string", minLength: 1, maxLength: 4096 };
const Keys: Record<string, unknown> = { type: "array", items: Key, maxItems: 100 };
const Kinds: string[] = ["project_depends_on", "imports", "calls", "references", "documents"];
const Page: Record<string, unknown> = {
    offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: "integer", minimum: 1, maximum: 100 },
};
const definition: (name: string, description: string, properties: Record<string, unknown>, required?: string[]) => WorkspaceToolDefinition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): WorkspaceToolDefinition => ({
    name: `amp_workspace_${name}`,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
});

const Definitions: WorkspaceToolDefinition[] = [
    definition("capabilities", "Discover authorized workspace projects, revision, registered Frame IDs and service limits. Does not grant new access.", {}),
    definition(
        "tree",
        "List project roots or direct structural children with native source locations; no summary or detail bodies. Use offset for pagination.",
        { revision: Key, parentId: Key, ...Page },
        ["revision"],
    ),
    definition(
        "query",
        "Find candidate IDs using lexical AND search and bounded graph traversal. Candidates need host Frame allocation before content reads.",
        {
            revision: Key,
            text: { type: "string", maxLength: 4096 },
            seedIds: Keys,
            projectIds: Keys,
            relationKinds: { type: "array", items: { type: "string", enum: Kinds }, maxItems: 5 },
            direction: { type: "string", enum: ["incoming", "outgoing", "both"] },
            maxDepth: { type: "integer", minimum: 0, maximum: 10 },
            limit: Page.limit,
        },
        ["revision"],
    ),
    definition(
        "relations",
        "Page descriptive dependency/call/reference edges for one authorized node. Does not materialize either endpoint.",
        {
            revision: Key,
            nodeId: Key,
            direction: { type: "string", enum: ["incoming", "outgoing"] },
            relationKind: { type: "string", enum: Kinds },
            ...Page,
        },
        ["revision", "nodeId", "direction"],
    ),
    definition(
        "materialize",
        "Materialize a host-registered Frame once. Repeated calls reuse its Context. Only summaries fitting the requested and host/Frame budgets are returned.",
        {
            revision: Key,
            frameId: Key,
            budgetTokens: { type: "integer", minimum: 1, maximum: 32000 },
        },
        ["revision", "frameId", "budgetTokens"],
    ),
    definition(
        "read",
        "Read a bounded page of CAS-verified detail from an explicitly allocated, materialized target. Structural ancestors alone do not grant detail access. Offsets count UTF-16 code units.",
        {
            revision: Key,
            contextId: Key,
            nodeId: Key,
            offset: Page.offset,
            maxChars: { type: "integer", minimum: 1, maximum: 16000 },
        },
        ["revision", "contextId", "nodeId"],
    ),
    definition(
        "release",
        "Release this service's Context handle. Does not create an action Receipt or refund/reopen its Frame budget.",
        { revision: Key, contextId: Key },
        ["revision", "contextId"],
    ),
];

export const workspaceToolDefinitions: () => WorkspaceToolDefinition[] = (): WorkspaceToolDefinition[] => structuredClone(Definitions);
