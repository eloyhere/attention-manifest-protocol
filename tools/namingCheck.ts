#!/usr/bin/env node
/**
 * Naming grammar, alias migration and catalog digest contract.
 *
 * The check protects three invariants: every advertised name parses and fits
 * the wrapped-name budget, the legacy names only ever resolve to canonical ids,
 * and a catalog digest follows the definition set while ignoring list order.
 * Every assertion is written so that a regression fails it rather than being
 * re-documented by it.
 */
import assert from "node:assert/strict";

import {
    buildCatalog,
    deprecatedToolAliases,
    formatId,
    isId,
    isReservedComponent,
    MaxComponentLength,
    MaxIdLength,
    MaxLeafSegments,
    MaxWireLength,
    Namespace,
    NamingError,
    parseId,
    ProtocolIds,
    resolveToolName,
    ServiceIds,
    ToolAliases,
    ToolIds,
    tryParseId,
    verifyCatalog,
    WorkspaceProtocolAliases,
} from "../src/naming/index.ts";
import type { CatalogEntry, CatalogVerdict, Id, IdKind, ToolCatalog } from "../src/naming/index.ts";
import { digestOf } from "../src/semantic/canonical.ts";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => void = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const ProtocolValues: readonly string[] = Object.values(ProtocolIds);
const ServiceValues: readonly string[] = Object.values(ServiceIds);
const ToolValues: readonly string[] = Object.values(ToolIds);
const AllIds: readonly string[] = [...ProtocolValues, ...ServiceValues, ...ToolValues];

/**
 * Run an operation and return its `NamingError` code, or a marker for the
 * wrong outcome. Returning the code makes a failed assertion print both the
 * expected and the actual code instead of a bare "did not throw".
 */
const rejectionCode: (operation: () => unknown) => string = (operation: () => unknown): string => {
    try {
        operation();
        return "accepted";
    } catch (error) {
        if (error instanceof NamingError) {
            return error.code;
        }
        return "non-naming-error";
    }
};

const ReadEntry: CatalogEntry = { id: ToolIds.workspaceRead, digest: `sha256:${"1".repeat(64)}`, risk: "read" };
const QueryEntry: CatalogEntry = { id: ToolIds.workspaceQuery, digest: `sha256:${"2".repeat(64)}`, risk: "read" };
const ReleaseEntry: CatalogEntry = { id: ToolIds.workspaceRelease, digest: `sha256:${"3".repeat(64)}`, risk: "destructive" };
const TreeEntry: CatalogEntry = { id: ToolIds.workspaceTree, digest: `sha256:${"4".repeat(64)}`, risk: "read" };
const CatalogEntries: readonly CatalogEntry[] = [ReleaseEntry, ReadEntry, QueryEntry];

test("protocol ids parse with the protocol kind and no leaf", () => {
    assert.ok(ProtocolValues.length >= 1);
    for (let index: number = 0; index < ProtocolValues.length; index += 1) {
        const text: string = ProtocolValues[index];
        const parsed: Id = parseId(text);
        assert.equal(parsed.text, text);
        assert.equal(parsed.kind, "protocol");
        assert.ok(parsed.component.length > 0);
        assert.deepEqual(parsed.leaf, []);
        assert.ok(parsed.leaf.length <= MaxLeafSegments);
    }
    assert.equal(ProtocolIds.workspace, "amp_protocol_workspace");
});

test("service ids parse with the service kind and no leaf", () => {
    assert.ok(ServiceValues.length >= 1);
    for (let index: number = 0; index < ServiceValues.length; index += 1) {
        const text: string = ServiceValues[index];
        const parsed: Id = parseId(text);
        assert.equal(parsed.text, text);
        assert.equal(parsed.kind, "service");
        assert.ok(parsed.component.length > 0);
        assert.deepEqual(parsed.leaf, []);
    }
    assert.equal(ServiceIds.workspace, "amp_service_workspace");
    assert.equal(ServiceIds.workspace.length, 21);
});

test("tool ids parse with the workspace component and their table leaf", () => {
    const workspaceTools: readonly string[] = ToolValues.filter((id: string): boolean => id.startsWith("amp_tool_workspace_"));
    const expected: readonly (readonly [string, string])[] = [
        [ToolIds.workspaceCapabilities, "capabilities"],
        [ToolIds.workspaceTree, "tree"],
        [ToolIds.workspaceQuery, "query"],
        [ToolIds.workspaceRelations, "relations"],
        [ToolIds.workspaceMaterialize, "materialize"],
        [ToolIds.workspaceRead, "read"],
        [ToolIds.workspaceRelease, "release"],
        [ToolIds.workspaceDiscover, "discover"],
    ];
    assert.equal(expected.length, 8);
    for (let index: number = 0; index < expected.length; index += 1) {
        const text: string = expected[index][0];
        const leaf: string = expected[index][1];
        const parsed: Id = parseId(text);
        assert.equal(parsed.text, text);
        assert.equal(parsed.kind, "tool");
        assert.equal(parsed.component, "workspace");
        assert.deepEqual(parsed.leaf, [leaf]);
        assert.ok(parsed.leaf.length >= 1 && parsed.leaf.length <= MaxLeafSegments);
        assert.equal(workspaceTools[index], text);
    }
});

test("the tool table spells the canonical workspace ids", () => {
    /**
     * A new tool may be added to the table between releases, so this pins the
     * v0.5 ids as a subset instead of freezing the list length: an added id is a
     * feature, a renamed or dropped id is a breaking change.
     */
    const otherToolIds: readonly string[] = ToolValues.filter((id: string): boolean => !id.startsWith("amp_tool_workspace_"));
    assert.ok(otherToolIds.length > 0, "global and filesystem tools are registered");
    for (let index: number = 0; index < otherToolIds.length; index += 1) {
        const parsed: Id = parseId(otherToolIds[index]);
        assert.equal(parsed.kind, "tool");
        assert.ok(parsed.leaf.length >= 1 && parsed.leaf.length <= MaxLeafSegments);
    }
    assert.equal(new Set<string>(ToolValues).size, ToolValues.length);
    const v05ToolIds: readonly string[] = [
        "amp_tool_workspace_capabilities",
        "amp_tool_workspace_tree",
        "amp_tool_workspace_query",
        "amp_tool_workspace_relations",
        "amp_tool_workspace_materialize",
        "amp_tool_workspace_read",
        "amp_tool_workspace_release",
    ];
    for (let index: number = 0; index < v05ToolIds.length; index += 1) {
        assert.ok(ToolValues.includes(v05ToolIds[index]), v05ToolIds[index]);
    }
});

test("workspace component and leaf shape match the published table", () => {
    const capabilities: Id = parseId(ToolIds.workspaceCapabilities);
    assert.equal(capabilities.component, "workspace");
    assert.equal(capabilities.leaf.length, 1);
    assert.equal(capabilities.leaf[0], "capabilities");
    const protocol: Id = parseId(ProtocolIds.workspace);
    assert.deepEqual(protocol.leaf, []);
    assert.equal(protocol.kind, "protocol");
});

test("malformed ids are rejected with stable codes", () => {
    const longId: string = `amp_tool_${"a".repeat(MaxComponentLength)}_${"b".repeat(23)}`;
    assert.equal(longId.length, 49);
    const cases: readonly (readonly [string, string])[] = [
        ["amp_x_tool_a", "unknown-kind"],
        ["amp_tool_", "empty-segment"],
        ["amp_tool_workspace_", "empty-segment"],
        ["amp_tool_workspace", "missing-leaf"],
        ["amp_tool_protocol_x", "reserved-component"],
        ["amp_tool_workspace_read_extra_deep", "too-many-segments"],
        ["amp_tool_WorkSpace_read", "illegal-character"],
        ["amp_tool_workspace__read", "empty-segment"],
        [longId, "too-long"],
        ["amp_protocol_workspace_read", "unexpected-leaf"],
        ["amp_service_workspace_read", "unexpected-leaf"],
        ["amp.tool.workspace", "missing-prefix"],
        ["amp_tool_workspace_Read", "illegal-character"],
    ];
    for (let index: number = 0; index < cases.length; index += 1) {
        const text: string = cases[index][0];
        const code: string = cases[index][1];
        assert.equal(rejectionCode(() => parseId(text)), code, `expected ${text} to fail with ${code}`);
    }
    assert.equal(rejectionCode(() => parseId("amp_tool")), "empty-segment");
    assert.equal(rejectionCode(() => parseId("amp_")), "empty-segment");
});

test("the id limit is inclusive at 48 characters", () => {
    const budgetId: string = `amp_tool_${"a".repeat(MaxComponentLength)}_${"b".repeat(22)}`;
    assert.equal(budgetId.length, MaxIdLength);
    const parsed: Id = parseId(budgetId);
    assert.equal(parsed.text, budgetId);
    assert.equal(parsed.leaf[0].length, 22);
});

test("frozen budgets match the published contract", () => {
    assert.equal(Namespace, "amp");
    assert.equal(MaxIdLength, 48);
    assert.equal(MaxComponentLength, 16);
    assert.equal(MaxLeafSegments, 2);
    assert.equal(MaxWireLength, 64);
});

test("ids fit the id and wrapped-name budgets", () => {
    for (let index: number = 0; index < AllIds.length; index += 1) {
        const text: string = AllIds[index];
        assert.ok(text.length <= MaxIdLength, `${text} is ${text.length} characters`);
        assert.ok(text.startsWith(`${Namespace}_`), text);
    }
    for (let index: number = 0; index < ToolValues.length; index += 1) {
        const toolId: string = ToolValues[index];
        const wrapped: number = 5 + ServiceIds.workspace.length + 2 + toolId.length;
        assert.ok(wrapped <= MaxWireLength, `${toolId} wraps to ${wrapped} characters`);
    }
    const longest: string = ToolValues.reduce((left: string, right: string): string => (left.length >= right.length ? left : right));
    assert.equal(longest.length, 33);
    assert.ok(longest.length <= MaxIdLength, longest);
});

test("formatId round-trips every id", () => {
    for (let index: number = 0; index < AllIds.length; index += 1) {
        const text: string = AllIds[index];
        const parsed: Id = parseId(text);
        assert.equal(formatId(parsed.kind, parsed.component, parsed.leaf), text);
    }
    assert.equal(formatId("protocol", "workspace"), "amp_protocol_workspace");
    assert.equal(formatId("service", "workspace"), "amp_service_workspace");
    assert.equal(formatId("tool", "workspace", ["read"]), ToolIds.workspaceRead);
    assert.equal(formatId("tool", "workspace", ["read", "extra"]), "amp_tool_workspace_read_extra");
    /**
     * The grammar allows two leaf segments; only a third segment is too many.
     */
    const twoLeaf: Id = parseId("amp_tool_workspace_read_extra");
    assert.deepEqual(twoLeaf.leaf, ["read", "extra"]);
});

test("formatId rejects parts it cannot represent unambiguously", () => {
    const cases: readonly (readonly [() => string, string])[] = [
        [() => formatId("tool", "workspace"), "missing-leaf"],
        [() => formatId("tool", "workspace", []), "missing-leaf"],
        [() => formatId("tool", "protocol", ["x"]), "reserved-component"],
        [() => formatId("protocol", "workspace", ["read"]), "unexpected-leaf"],
        [() => formatId("service", "workspace", ["read"]), "unexpected-leaf"],
        [() => formatId("tool", "workspace", ["read", "extra", "deep"]), "too-many-segments"],
        [() => formatId("tool", "workspace", ["Read"]), "illegal-character"],
        [() => formatId("tool", "workspace", [""]), "empty-segment"],
        [() => formatId("tool", "workspace", ["read_more"]), "illegal-character"],
        [() => formatId("tool", "work_shop", ["read"]), "illegal-character"],
        [() => formatId("tool", "a".repeat(MaxComponentLength + 1), ["read"]), "component-too-long"],
        [() => formatId("bogus" as IdKind, "workspace", ["read"]), "unknown-kind"],
        [() => formatId("tool", "workspace", ["b".repeat(MaxIdLength)]), "too-long"],
    ];
    for (let index: number = 0; index < cases.length; index += 1) {
        const code: string = cases[index][1];
        assert.equal(rejectionCode(cases[index][0]), code, `expected format case ${index} to fail with ${code}`);
    }
});

test("reserved component words are detectable and rejected", () => {
    assert.equal(isReservedComponent("protocol"), true);
    assert.equal(isReservedComponent("service"), true);
    assert.equal(isReservedComponent("tool"), true);
    assert.equal(isReservedComponent("workspace"), false);
    assert.equal(isReservedComponent("Protocol"), false);
    const reserved: readonly string[] = ["protocol", "service", "tool"];
    for (let index: number = 0; index < reserved.length; index += 1) {
        assert.equal(rejectionCode(() => formatId("tool", reserved[index], ["read"])), "reserved-component");
    }
});

test("tryParseId reports validity without throwing", () => {
    const parsed: Id | undefined = tryParseId(ToolIds.workspaceRead);
    assert.ok(parsed);
    assert.equal(parsed.text, ToolIds.workspaceRead);
    assert.equal(tryParseId("amp_tool_"), undefined);
    assert.equal(tryParseId("not-an-id"), undefined);
});

test("isId is grammar-based and rejects legacy aliases", () => {
    for (let index: number = 0; index < AllIds.length; index += 1) {
        assert.equal(isId(AllIds[index]), true, AllIds[index]);
    }
    assert.equal(deprecatedToolAliases.length, 7);
    for (let index: number = 0; index < deprecatedToolAliases.length; index += 1) {
        assert.equal(isId(deprecatedToolAliases[index]), false, deprecatedToolAliases[index]);
    }
    assert.deepEqual([...WorkspaceProtocolAliases], ["amp.workspace"]);
    assert.equal(isId("amp.workspace"), false);
    /**
     * `amp_tool_workspace_missing` is grammatically valid, so it is an id even
     * though it is not a registered tool. `resolveToolName` is the registry
     * gate, not `isId`.
     */
    assert.equal(isId("amp_tool_workspace_missing"), true);
    assert.equal(isId(""), false);
});

test("resolveToolName maps legacy names and registered canonical ids", () => {
    assert.deepEqual(deprecatedToolAliases, [
        "amp_workspace_capabilities",
        "amp_workspace_materialize",
        "amp_workspace_query",
        "amp_workspace_read",
        "amp_workspace_relations",
        "amp_workspace_release",
        "amp_workspace_tree",
    ]);
    for (let index: number = 0; index < deprecatedToolAliases.length; index += 1) {
        const alias: string = deprecatedToolAliases[index];
        const canonical: string | undefined = resolveToolName(alias);
        assert.equal(canonical, ToolAliases.get(alias));
        assert.equal(typeof(canonical), "string");
    }
    const expectedPairs: readonly (readonly [string, string])[] = [
        ["amp_workspace_capabilities", ToolIds.workspaceCapabilities],
        ["amp_workspace_tree", ToolIds.workspaceTree],
        ["amp_workspace_query", ToolIds.workspaceQuery],
        ["amp_workspace_relations", ToolIds.workspaceRelations],
        ["amp_workspace_materialize", ToolIds.workspaceMaterialize],
        ["amp_workspace_read", ToolIds.workspaceRead],
        ["amp_workspace_release", ToolIds.workspaceRelease],
    ];
    for (let index: number = 0; index < expectedPairs.length; index += 1) {
        assert.equal(resolveToolName(expectedPairs[index][0]), expectedPairs[index][1]);
    }
    for (let index: number = 0; index < ToolValues.length; index += 1) {
        assert.equal(resolveToolName(ToolValues[index]), ToolValues[index]);
    }
    assert.equal(resolveToolName("amp_tool_workspace_missing"), undefined);
    assert.equal(resolveToolName("amp_workspace_missing"), undefined);
    assert.equal(resolveToolName(ProtocolIds.workspace), undefined);
    assert.equal(resolveToolName(ServiceIds.workspace), undefined);
    assert.equal(resolveToolName(""), undefined);
});

test("aliases never shadow canonical ids and stay one-to-one", () => {
    const keys: string[] = [...ToolAliases.keys()];
    const values: string[] = [...ToolAliases.values()];
    /**
     * The v0.5 alias table is fixed, but the canonical table may grow, so the
     * count is a floor rather than an equality: a tool added after v0.5 has no
     * legacy spelling and must not invent one.
     */
    assert.ok(keys.length >= 7, `expected at least the seven v0.5 aliases, found ${keys.length}`);
    assert.equal(new Set<string>(keys).size, keys.length);
    assert.equal(new Set<string>(values).size, values.length);
    for (let index: number = 0; index < keys.length; index += 1) {
        const key: string = keys[index];
        const value: string = values[index];
        assert.equal(AllIds.includes(key), false, key);
        assert.equal(isId(key), false, key);
        assert.ok(AllIds.includes(value), value);
        assert.equal(ToolAliases.has(value), false, value);
    }
    assert.deepEqual([...keys].sort(), [...deprecatedToolAliases]);
    /**
     * Every alias resolves to a tool that still exists; a tool added after v0.5
     * simply has no legacy spelling, so this is a subset check, not equality.
     */
    for (let index: number = 0; index < values.length; index += 1) {
        assert.ok(ToolValues.includes(values[index]), values[index]);
    }
});

test("catalog entries are sorted by id and input order is untouched", () => {
    const catalog: ToolCatalog = buildCatalog(CatalogEntries);
    const ids: string[] = catalog.entries.map((entry: CatalogEntry): string => entry.id);
    assert.deepEqual(ids, [ToolIds.workspaceQuery, ToolIds.workspaceRead, ToolIds.workspaceRelease]);
    assert.equal(catalog.sortedBy, "id");
    const inputIds: string[] = CatalogEntries.map((entry: CatalogEntry): string => entry.id);
    assert.deepEqual(inputIds, [ToolIds.workspaceRelease, ToolIds.workspaceRead, ToolIds.workspaceQuery]);
});

test("catalog digest is stable and independent of input order", () => {
    const first: ToolCatalog = buildCatalog(CatalogEntries);
    const second: ToolCatalog = buildCatalog(CatalogEntries);
    const reversed: ToolCatalog = buildCatalog([...CatalogEntries].reverse());
    assert.equal(first.digest, second.digest);
    assert.equal(first.digest, reversed.digest);
    assert.equal(first.digest, digestOf(first.entries));
    assert.deepEqual(first.entries, reversed.entries);
});

test("catalog digest changes when one definition digest changes", () => {
    const before: ToolCatalog = buildCatalog(CatalogEntries);
    const changedEntry: CatalogEntry = { ...ReadEntry, digest: `sha256:${"9".repeat(64)}` };
    const after: ToolCatalog = buildCatalog([changedEntry, ReleaseEntry, QueryEntry]);
    assert.notEqual(before.digest, after.digest);
    assert.equal(after.entries.length, CatalogEntries.length);
});

test("catalog defaults and explicit metadata are honored", () => {
    const defaults: ToolCatalog = buildCatalog([]);
    assert.equal(defaults.version, "1.0.0");
    assert.equal(defaults.ttlMs, 0);
    assert.equal(defaults.cacheScope, "private");
    assert.equal(defaults.sortedBy, "id");
    assert.deepEqual(defaults.entries, []);
    assert.equal(defaults.digest, digestOf([]));
    const explicit: ToolCatalog = buildCatalog(CatalogEntries, { version: "2.3.4", ttlMs: 60_000, cacheScope: "public" });
    assert.equal(explicit.version, "2.3.4");
    assert.equal(explicit.ttlMs, 60_000);
    assert.equal(explicit.cacheScope, "public");
});

test("verifyCatalog accepts identical entries in any order", () => {
    const catalog: ToolCatalog = buildCatalog(CatalogEntries);
    const verdict: CatalogVerdict = verifyCatalog(catalog, [...CatalogEntries].reverse());
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.reasons, []);
    assert.deepEqual(verdict.changed, []);
});

test("verifyCatalog reports an added tool", () => {
    const catalog: ToolCatalog = buildCatalog(CatalogEntries);
    const verdict: CatalogVerdict = verifyCatalog(catalog, [...CatalogEntries, TreeEntry]);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.reasons, [`tool added: ${ToolIds.workspaceTree}`]);
    assert.deepEqual(verdict.changed, [ToolIds.workspaceTree]);
});

test("verifyCatalog reports a removed tool", () => {
    const catalog: ToolCatalog = buildCatalog(CatalogEntries);
    const verdict: CatalogVerdict = verifyCatalog(catalog, [ReadEntry, QueryEntry]);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.reasons, [`tool removed: ${ToolIds.workspaceRelease}`]);
    assert.deepEqual(verdict.changed, [ToolIds.workspaceRelease]);
});

test("verifyCatalog reports a changed tool definition", () => {
    const catalog: ToolCatalog = buildCatalog(CatalogEntries);
    const changedEntry: CatalogEntry = { ...ReadEntry, digest: `sha256:${"9".repeat(64)}` };
    const verdict: CatalogVerdict = verifyCatalog(catalog, [ReleaseEntry, changedEntry, QueryEntry]);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.reasons, [`tool changed: ${ReadEntry.id} ${ReadEntry.digest} -> ${changedEntry.digest}`]);
    assert.deepEqual(verdict.changed, [ToolIds.workspaceRead]);
});

test("verifyCatalog reports a risk-only change", () => {
    const catalog: ToolCatalog = buildCatalog(CatalogEntries);
    const risky: CatalogEntry = { ...ReadEntry, risk: "write" };
    const verdict: CatalogVerdict = verifyCatalog(catalog, [ReleaseEntry, risky, QueryEntry]);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.reasons, [`tool changed: ${ReadEntry.id} risk read -> write`]);
    assert.deepEqual(verdict.changed, [ToolIds.workspaceRead]);
});

test("verifyCatalog combines drift kinds with a sorted changed list", () => {
    const catalog: ToolCatalog = buildCatalog(CatalogEntries);
    const changedEntry: CatalogEntry = { ...ReadEntry, digest: `sha256:${"9".repeat(64)}` };
    const verdict: CatalogVerdict = verifyCatalog(catalog, [QueryEntry, changedEntry, TreeEntry]);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.reasons, [
        `tool changed: ${ToolIds.workspaceRead} ${ReadEntry.digest} -> ${changedEntry.digest}`,
        `tool removed: ${ToolIds.workspaceRelease}`,
        `tool added: ${ToolIds.workspaceTree}`,
    ]);
    assert.deepEqual(verdict.changed, [ToolIds.workspaceRead, ToolIds.workspaceRelease, ToolIds.workspaceTree]);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
