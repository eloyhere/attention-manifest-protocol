/**
 * Compatibility aliases for the v0.5.0 rename.
 *
 * Tool names are proposed by clients, so the rename cannot be a hard cut: the
 * legacy `amp_workspace_*` strings stay valid inputs for one minor version
 * while `tools/list` advertises only canonical ids. Aliases never appear in a
 * catalog, pin or audit record; they are resolved to a canonical id at the
 * boundary and then forgotten.
 */

import { ToolIds } from "./ids.ts";

/**
 * Legacy `protocol` field values that a lenient host may still compare against.
 *
 * The server writes only `amp_protocol_workspace`; this list exists so a host
 * upgrading from `amp.workspace` does not have to hard-code the old value, and
 * it is not an input alias: nothing on the wire may still send it.
 */
export const WorkspaceProtocolAliases: readonly string[] = Object.freeze(["amp.workspace"]);

/**
 * Ordered pairs so the map and the sorted deprecated list are generated from a
 * single source. Adding an alias therefore cannot update one and forget the
 * other.
 */
const ToolAliasPairs: readonly (readonly [string, string])[] = [
    ["amp_workspace_capabilities", ToolIds.workspaceCapabilities],
    ["amp_workspace_tree", ToolIds.workspaceTree],
    ["amp_workspace_query", ToolIds.workspaceQuery],
    ["amp_workspace_relations", ToolIds.workspaceRelations],
    ["amp_workspace_materialize", ToolIds.workspaceMaterialize],
    ["amp_workspace_read", ToolIds.workspaceRead],
    ["amp_workspace_release", ToolIds.workspaceRelease],
];

/**
 * Legacy wire name to canonical id.
 *
 * A `ReadonlyMap` is the type-level contract; runtime mutation is not part of
 * the API. The table is additive for one minor version and is removed in
 * v0.6.0, at which point callers keep the same import and only the contents
 * disappear.
 */
export const ToolAliases: ReadonlyMap<string, string> = new Map<string, string>(ToolAliasPairs);

/**
 * Sorted legacy names for the `deprecatedAliases` field of a capabilities
 * response.
 *
 * The sort is the default UTF-16 code-unit order, not `localeCompare`, because
 * a locale-sensitive order would differ between hosts and make a response
 * unstable. The local binding stays PascalCase because it is module data; the
 * public export uses the frozen contract name.
 */
const DeprecatedToolAliases: readonly string[] = Object.freeze(ToolAliasPairs.map((pair: readonly [string, string]): string => pair[0]).sort());

export { DeprecatedToolAliases as deprecatedToolAliases };

/**
 * The registered tool ids, used as the closed membership test for resolution.
 *
 * The grammar is open by design (a new component parses without editing the
 * grammar), so a grammatical string is not evidence that this server serves it.
 */
const CanonicalToolIds: ReadonlySet<string> = new Set<string>(Object.values(ToolIds));

/**
 * Resolve a client-supplied tool name to its canonical id.
 *
 * Resolution is closed over the registered tool table, not over the open
 * grammar: `amp_tool_workspace_missing` is a well-formed id but not a tool this
 * server serves, so it returns `undefined`. Returning the string anyway would
 * let a typo look like a known tool and defer the failure to dispatch, where
 * the error no longer names the bad input. Aliases are checked first because a
 * legacy name must never be reinterpreted as a component/leaf pair.
 */
export const resolveToolName: (text: string) => string | undefined = (text: string): string | undefined => {
    const canonical: string | undefined = ToolAliases.get(text);
    if (canonical !== (void 0)) {
        return canonical;
    }
    if (CanonicalToolIds.has(text)) {
        return text;
    }
    return undefined;
};
