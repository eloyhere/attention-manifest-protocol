#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkspaceEntity } from "../src/context/workspace.ts";
import { catalogKey } from "../src/database/entity/catalog.ts";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import { assertJsonValue } from "../src/semantic/jsonValue.ts";
import { projectSearchRecords } from "../src/search/projection.ts";
import type { SearchProjectionInput } from "../src/search/projection.ts";

const namespace = "projection-test";
const key = (kind: string, id: string): string => catalogKey(namespace, kind, id);
const entity = (id: string, kind: WorkspaceEntity["kind"], parentId?: string): WorkspaceEntity => ({
    id, kind, projectId: "project", label: id, summary: `${id} summary`, parentId,
    source: { uri: `workspace:${id}`, revision: "source-revision", startLine: 2, endLine: 4 },
    detailRef: `detail:${id}`, tags: ["workspace"], searchTerms: [id],
});
const find = (records: CatalogRecord[], kind: string, id: string): CatalogRecord => {
    const found = records.find((record) => record.kind === kind && record.id === id);
    assert.ok(found, `${kind}/${id} missing`);
    return found;
};
const hasEdge = (record: CatalogRecord, relation: string, targetId: string): void => {
    assert.ok(record.relations?.some((edge) => edge.relation === relation && edge.targetId === targetId), `${relation} -> ${targetId}`);
};

function fixture(): SearchProjectionInput {
    return {
        namespace, revision: "snapshot-revision",
        workspace: [entity("project", "project"), entity("directory", "directory", "project"), entity("file", "file", "directory"),
            entity("symbol", "symbol", "file"), entity("package", "package", "project"), entity("workspace-knowledge", "knowledge", "project")],
        relations: [{ from: "file", to: "symbol", kind: "references", source: { uri: "workspace:file", revision: "source-revision" }, method: "compiler" }],
        projects: [{ id: "project", name: "Host project", description: "Long description", purpose: "Purpose", summary: "Host summary", tags: ["host"], rootId: "directory" }],
        host: [
            { id: "plugin", kind: "plugin", name: "Plugin", description: "Plugin description", version: "1.0", status: "active", purpose: "Plugin purpose", projectId: "project",
                relatedIds: ["ambiguous-id"], skillIds: ["skill"], knowledgeIds: ["knowledge"], toolIds: ["tool"], protocolIds: ["protocol"] },
            { id: "service", kind: "service", name: "Service", description: "Service description", endpoint: "https://example.test/service" },
            { id: "tool", kind: "tool", name: "Tool", description: "Tool description" },
            { id: "environment", kind: "module", name: "Environment host", description: "Host environment description", capabilities: ["execute"] },
        ],
        environments: [{ id: "environment", kind: "module", name: "Environment", description: "Environment description", category: "runtime", availability: "available",
            platforms: ["linux"], extensions: [".sh"], skillIds: ["skill"], relatedIds: ["runtime.sh"] }],
        skills: [{ id: "skill", name: "Skill", description: "Skill description", instructions: "Full instructions", version: "1", enabled: true, tags: ["skill-tag"], capabilities: ["skill-capability"] }],
        knowledge: [{ id: "knowledge", title: "Knowledge", summary: "Knowledge summary", content: "Full knowledge body", sourceUri: "https://example.test/knowledge", version: "2", skillIds: ["skill"], updatedAt: "2026-01-01" }],
        protocols: [{ id: "protocol", name: "Protocol", description: "Protocol description", version: "3", status: "deprecated", endpoint: "https://example.test/protocol", capabilities: ["exchange"] }],
        records: [{ id: "external", kind: "custom-module", name: "External", summary: "External summary", payload: { nested: { keep: true, optional: undefined }, body: "Complete body" },
            relations: [{ relation: "custom", targetId: "unresolved" }] }],
    };
}

test("all discoverable kinds retain complete JSON-safe payload and snapshot revision", () => {
    const input = fixture();
    const records = projectSearchRecords(input);
    assert.equal(records.length, 14);
    for (const record of records) assertJsonValue(record);
    assert.equal(find(records, "file", "file").revision, "snapshot-revision");
    assert.equal(find(records, "file", "file").payload.detailRef, "detail:file");
    assert.deepEqual(find(records, "file", "file").payload.source, input.workspace![2].source);
    assert.equal(find(records, "skill", "skill").payload.instructions, "Full instructions");
    assert.equal(find(records, "knowledge", "knowledge").payload.content, "Full knowledge body");
    assert.equal(find(records, "knowledge", "knowledge").payload.updatedAt, "2026-01-01");
    assert.equal(find(records, "protocol", "protocol").payload.endpoint, "https://example.test/protocol");
    assert.equal(find(records, "plugin", "plugin").payload.purpose, "Plugin purpose");
    assert.equal(find(records, "custom-module", "external").payload.body, "Complete body");
    assert.deepEqual(find(records, "custom-module", "external").payload.nested, { keep: true });
    assert.equal(find(records, "service", "service").revision, undefined);
    assert.equal(projectSearchRecords({ namespace, workspace: [entity("file", "file")] })[0].revision, "source-revision");
});

test("hierarchy, project, workspace and typed dependency relations persist", () => {
    const records = projectSearchRecords(fixture());
    hasEdge(find(records, "file", "file"), "parent", key("directory", "directory"));
    hasEdge(find(records, "directory", "directory"), "contains", key("file", "file"));
    hasEdge(find(records, "file", "file"), "project", key("project", "project"));
    hasEdge(find(records, "project", "project"), "workspace", key("directory", "directory"));
    hasEdge(find(records, "file", "file"), "references", key("symbol", "symbol"));
    const originalEdge = (find(records, "file", "file").payload.workspaceRelations as object[])[0];
    assert.deepEqual(originalEdge, fixture().relations![0]);
    const plugin = find(records, "plugin", "plugin");
    for (const kind of ["skill", "knowledge", "tool", "protocol"]) hasEdge(plugin, `uses_${kind}`, key(kind, kind));
    hasEdge(plugin, "related", "ambiguous-id");
    hasEdge(plugin, "project", key("project", "project"));
    hasEdge(find(records, "knowledge", "knowledge"), "uses_skill", key("skill", "skill"));
    hasEdge(find(records, "custom-module", "external"), "custom", "unresolved");
});

test("expected cross-source overlaps merge metadata, arrays and relations without losing source payloads", () => {
    const input = fixture();
    const records = projectSearchRecords(input);
    const project = find(records, "project", "project");
    assert.equal(project.name, "Host project");
    assert.equal(project.sourceUri, "workspace:project");
    assert.deepEqual(project.tags, ["workspace", "host"]);
    assert.deepEqual(project.payload.workspace, JSON.parse(JSON.stringify(input.workspace![0])));
    assert.deepEqual(project.payload.project, input.projects![0]);
    const environment = find(records, "module", "environment");
    assert.deepEqual(environment.tags, ["execute", "linux", ".sh"]);
    assert.equal(environment.payload.category, "runtime");
    assert.deepEqual(environment.payload.host, input.host![3]);
    assert.deepEqual(environment.payload.environment, input.environments![0]);
    hasEdge(environment, "uses_skill", key("skill", "skill"));
    hasEdge(environment, "related", "runtime.sh");
});

test("projection does not mutate inputs or share nested arrays and objects", () => {
    const input = fixture();
    const before = structuredClone(input);
    const records = projectSearchRecords(input);
    assert.deepEqual(input, before);
    find(records, "file", "file").tags!.push("mutated");
    (find(records, "file", "file").payload.source as { uri: string }).uri = "mutated";
    ((find(records, "project", "project").payload.workspace as { tags: string[] }).tags).push("mutated");
    (find(records, "custom-module", "external").payload.nested as { keep: boolean }).keep = false;
    find(records, "file", "file").relations![0].targetId = "mutated";
    assert.deepEqual(input, before);
});

test("disabled skills and protocols are excluded while deprecated protocols remain", () => {
    const input = fixture();
    const records = projectSearchRecords({ namespace,
        skills: [...input.skills!, { ...input.skills![0], id: "disabled-skill", enabled: false }],
        protocols: [...input.protocols!, { ...input.protocols![0], id: "disabled-protocol", status: "disabled" }],
        records: [
            { id: "generic-skill", kind: "skill", name: "Disabled", summary: "", payload: { enabled: false } },
            { id: "generic-protocol", kind: "protocol", name: "Disabled", summary: "", payload: { status: "disabled" } },
        ],
    });
    assert.deepEqual(records.map((record) => record.id), ["skill", "protocol"]);
});

test("unexpected duplicates and conflicting project ownership fail explicitly", () => {
    const input = fixture();
    assert.throws(() => projectSearchRecords({ namespace, workspace: [entity("file", "file"), entity("file", "file")] }), /duplicate/);
    assert.throws(() => projectSearchRecords({ namespace, skills: [input.skills![0], input.skills![0]] }), /duplicate/);
    assert.throws(() => projectSearchRecords({ namespace, host: [input.host![0], input.host![0]] }), /duplicate/);
    assert.throws(() => projectSearchRecords({ namespace, projects: [input.projects![0], input.projects![0]] }), /duplicate/);
    assert.throws(() => projectSearchRecords({ namespace, host: [input.host![0]], records: [{ id: "plugin", kind: "plugin", name: "Collision", summary: "", payload: {} }] }), /duplicate/);
    assert.throws(() => projectSearchRecords({ namespace, host: [{ ...input.environments![0], projectId: "a" }], environments: [{ ...input.environments![0], projectId: "b" }] }), /conflicting project/);
});

test("undefined object fields are removed but non-JSON values fail without toJSON coercion", () => {
    const base: CatalogRecord = { id: "record", kind: "custom", name: "Custom", summary: "", payload: {} };
    for (const invalid of [NaN, Infinity, 1n, () => 1, new Date(), Symbol("invalid"), [undefined], Array(1), { get unsafe() { throw new Error("getter executed"); } }]) {
        assert.throws(() => projectSearchRecords({ namespace, records: [{ ...base, payload: { invalid } }] }), TypeError);
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    assert.throws(() => projectSearchRecords({ namespace, records: [{ ...base, payload: cycle }] }), /cycle/);
    assert.throws(() => projectSearchRecords({ namespace: " " }), /namespace/);
    assert.throws(() => projectSearchRecords({ namespace, relations: [{ from: "missing", to: "target", kind: "imports", method: "explicit", source: { uri: "x", revision: "r" } }] }), /source is missing/);
});
