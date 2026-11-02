#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";

import { catalogKey } from "../src/database/entity/catalog.ts";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import type { HostComponent, HostProject } from "../src/discover/types.ts";
import type { EnvironmentEntry } from "../src/environment/catalog.ts";
import type { WorkspaceEntity } from "../src/context/workspace.ts";
import { projectSearchRecords } from "../src/search/projection.ts";

const ns = "audit:namespace/[x]";
const record = (id: string, kind = "custom", extra: Partial<CatalogRecord> = {}): CatalogRecord => ({
    id, kind, name: id, summary: "", payload: {}, ...extra,
});
const find = (rows: CatalogRecord[], kind: string, id: string): CatalogRecord => {
    const value = rows.find((row) => row.kind === kind && row.id === id);
    assert.ok(value, `${kind}/${id} was not projected`);
    return value;
};
const project = (overrides: Partial<WorkspaceEntity> = {}): WorkspaceEntity => ({
    id: "p", kind: "project", projectId: "p", label: "P", summary: "", source: { uri: "workspace:p", revision: "r1" },
    ...overrides,
});

// These are expected safe boundaries, retained in the report's coverage list.
test("namespace and tuple keys do not collide on delimiters, quotes, or Unicode", () => {
    const pairs = [
        ["a|b", "c", "d"], ["a", "b|c", "d"], ["a", "b", "c|d"],
        ["a\u0000b", "c", "d"], ["a", "c", "b\u0000d"], ["\"x\"", "kind/one", "id:[two]"],
        ["雪", "語", "🙂"],
    ];
    const keys = pairs.map(([namespace, kind, id]) => catalogKey(namespace, kind, id));
    assert.equal(new Set(keys).size, pairs.length);
    const rows = projectSearchRecords({ namespace: ns, records: [record("same", "one"), record("same", "two")] });
    assert.equal(rows.length, 2);
});

test("required namespace, revision, ID, kind and name reject blank values", () => {
    for (const namespace of ["", " \t\n"]) assert.throws(() => projectSearchRecords({ namespace }), TypeError);
    assert.throws(() => projectSearchRecords({ namespace: ns, revision: " " }), TypeError);
    for (const [field, value] of [["id", " "], ["kind", ""], ["name", "\t"]] as const) {
        const candidate = { ...record("ok"), [field]: value };
        assert.throws(() => projectSearchRecords({ namespace: ns, records: [candidate] }), TypeError);
    }
});

test("current ID and namespace boundary accepts opaque long and whitespace-preserving identifiers", () => {
    const longId = "x".repeat(200_000);
    const whitespaceId = " id ";
    const output = projectSearchRecords({ namespace: ` ${ns} `, records: [record(longId), record(whitespaceId)] });
    assert.equal(output[0].id.length, longId.length);
    assert.equal(output[1].id, whitespaceId);
    assert.equal(output.length, 2);
});

test("workspace and host project merge only on matching kind and ID; ownership conflict rejects", () => {
    const row = projectSearchRecords({ namespace: ns, revision: "snap", workspace: [project()], projects: [
        { id: "p", name: "host", description: "d", purpose: "purpose", summary: "summary" },
    ] });
    assert.equal(row.length, 1);
    assert.deepEqual(Object.keys(row[0].payload).filter((key) => ["workspace", "project"].includes(key)).sort(), ["project", "workspace"]);
    assert.throws(() => projectSearchRecords({ namespace: ns, workspace: [project({ projectId: "other" })], projects: [
        { id: "p", name: "host", description: "d", purpose: "purpose", summary: "summary" },
    ] }), /conflicting project/);
});

test("host and environment merge in the supported order and reject same-source duplicates", () => {
    const host: HostComponent = { id: "x", kind: "module", name: "host", description: "host" };
    const environment: EnvironmentEntry = { ...host, kind: "module", name: "environment", category: "runtime", availability: "unknown" };
    assert.equal(projectSearchRecords({ namespace: ns, host: [host], environments: [environment] }).length, 1);
    assert.throws(() => projectSearchRecords({ namespace: ns, host: [host, host], environments: [environment] }), /duplicate/);
    assert.throws(() => projectSearchRecords({ namespace: ns, environments: [environment, environment] }), /duplicate/);
});

test("typed relation targets distinguish same IDs while unknown raw targets remain unresolved", () => {
    const rows = projectSearchRecords({ namespace: ns,
        workspace: [project(), { ...project(), id: "file", kind: "file", parentId: "p" }],
        skills: [{ id: "x", name: "skill", description: "d", instructions: "i" }],
        records: [record("x", "custom")],
        host: [{ id: "host", kind: "plugin", name: "plugin", description: "d", skillIds: ["x"], relatedIds: ["missing"] }],
    });
    const host = find(rows, "plugin", "host");
    assert.ok(host.relations?.some((edge) => edge.targetId === catalogKey(ns, "skill", "x")));
    assert.ok(host.relations?.some((edge) => edge.relation === "related" && edge.targetId === "missing"));
    assert.ok(find(rows, "file", "file").relations?.some((edge) => edge.targetId === catalogKey(ns, "project", "p")));
    assert.ok(rows.every((entry) => !entry.relations?.some((edge) => edge.targetId === catalogKey("other", "skill", "x"))));
});

test("generic records preserve foreign catalog-key targets as opaque unresolved strings", () => {
    const foreign = catalogKey("other-namespace", "skill", "s");
    const rows = projectSearchRecords({ namespace: ns, records: [record("holder", "custom", { relations: [{ relation: "ref", targetId: foreign }] }), record("s", "skill")] });
    assert.deepEqual(find(rows, "custom", "holder").relations, [{ relation: "ref", targetId: foreign }]);
});

test("JSON-safe copy rejects cycles, accessors, symbols, class instances and lossy primitives", () => {
    const base = record("json");
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const symbolKey = { [Symbol("secret")]: 1 };
    const getter = Object.defineProperty({}, "secret", { enumerable: true, get: () => { throw new Error("executed"); } });
    for (const invalid of [cycle, new Date(), symbolKey, getter, { n: NaN }, { n: Infinity }, { n: 1n }, [undefined], Array(1)]) {
        assert.throws(() => projectSearchRecords({ namespace: ns, records: [{ ...base, payload: invalid as Record<string, unknown> }] }));
    }
    const undefinedOutput = projectSearchRecords({ namespace: ns, records: [{ ...base, id: "undefined", payload: { optional: undefined } }] });
    assert.deepEqual(find(undefinedOutput, "custom", "undefined").payload, {});
    const proto = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(proto, "__proto__", { value: { safe: true }, enumerable: true });
    const output = projectSearchRecords({ namespace: ns, records: [{ ...base, payload: proto }] });
    assert.deepEqual(Object.getOwnPropertyDescriptor(find(output, "custom", "json").payload, "__proto__")?.value, { safe: true });
});

test("JSON-safe copies detach repeated references and do not mutate source payload", () => {
    const shared = { value: [1] };
    const payload = { left: shared, right: shared, optional: undefined };
    const output = projectSearchRecords({ namespace: ns, records: [record("copy", "custom", { payload })] });
    const copied = find(output, "custom", "copy").payload;
    assert.notEqual(copied.left, copied.right);
    assert.equal("optional" in copied, false);
    (copied.left as { value: number[] }).value.push(2);
    assert.deepEqual(shared.value, [1]);
});

test("disabled skill/protocol states are filtered for typed and generic projections only", () => {
    const rows = projectSearchRecords({ namespace: ns,
        skills: [
            { id: "enabled", name: "enabled", description: "d", instructions: "i", enabled: true },
            { id: "default-enabled", name: "default", description: "d", instructions: "i" },
            { id: "disabled", name: "off", description: "d", instructions: "i", enabled: false },
        ],
        protocols: [
            { id: "active", name: "active", description: "d", version: "1", status: "active" },
            { id: "deprecated", name: "deprecated", description: "d", version: "1", status: "deprecated" },
            { id: "off", name: "off", description: "d", version: "1", status: "disabled" },
        ],
        records: [record("generic-off-skill", "skill", { payload: { enabled: false } }),
            record("generic-off-protocol", "protocol", { payload: { status: "disabled" } })],
    });
    assert.deepEqual(rows.map(({ id }) => id), ["enabled", "default-enabled", "active", "deprecated"]);
});

test("optional catalog metadata and string arrays are validated", () => {
    const candidates = [
        record("blank-project", "custom", { projectId: "" }),
        record("blank-revision", "custom", { revision: " " }),
        record("blank-uri", "custom", { sourceUri: "" }),
        record("bad-tags", "custom", { tags: [42] as unknown as string[] }),
        record("bad-terms", "custom", { searchTerms: [null] as unknown as string[] }),
    ];
    for (const candidate of candidates) assert.throws(() => projectSearchRecords({ namespace: ns, records: [candidate] }), TypeError);
});

test("host field getters are rejected before execution", () => {
    let calls = 0;
    const hostile = { id: "hostile", kind: "plugin", name: "plugin", description: "d" } as HostComponent;
    Object.defineProperty(hostile, "purpose", { enumerable: true, get() { calls += 1; return "triggered"; } });
    assert.throws(() => projectSearchRecords({ namespace: ns, host: [hostile] }), /accessor/);
    assert.equal(calls, 0);
});

test("finding reproduction: relation strings accept foreign keys and unrestricted lengths", () => {
    const foreign = catalogKey("foreign", "kind", "id");
    const target = "z".repeat(200_000);
    const rows = projectSearchRecords({ namespace: ns, records: [
        record("a", "custom", { relations: [{ relation: "ref", targetId: foreign }, { relation: "ref", targetId: target }] }),
    ] });
    assert.deepEqual(find(rows, "custom", "a").relations?.map((edge) => edge.targetId), [foreign, target]);
});
