import test from "node:test";
import assert from "node:assert/strict";
import {
    ENTITY_KINDS, ENTITY_REGISTRY, descriptorFor, entityKey, jsonDescriptor,
    id, compositeId, generatedId, keyOf, assertKey,
    column, index, uniqueConstraint, entity, defineEntity,
    oneToOne, oneToMany, manyToOne, manyToMany, cascade,
} from "./index.ts";
import type { ManyToMany, EntityKind, IdStrategy, CascadeType, FetchType } from "./index.ts";

const base = () => ({ kind: "session" as const, table: "entities", key: id(), columns: [column("id", { nullable: false }), column("version", { version: true })] });

test("registry covers every entity kind and preserves Repository descriptors", () => {
    assert.equal(ENTITY_KINDS.length, 32);
    assert.deepEqual(Object.keys(ENTITY_REGISTRY).sort(), [...ENTITY_KINDS].sort());
    for (const kind of ENTITY_KINDS) {
        assert.equal(ENTITY_REGISTRY[kind].kind, kind);
        assert.strictEqual(descriptorFor(kind), ENTITY_REGISTRY[kind].descriptor);
        assert.equal(descriptorFor(kind).table, "entities");
        assert.ok(Object.isFrozen(ENTITY_REGISTRY[kind]));
    }
    assert.throws(() => descriptorFor("unknown" as EntityKind), /unknown/);
});

test("assigned and composite key values are validated and escaped", () => {
    assert.equal(keyOf(id(), { id: "hello" }), "hello");
    assert.equal(keyOf(compositeId(["tenantId", "id"]), { tenantId: "a:b", id: "x/y" }), "a%3Ab:x%2Fy");
    assert.equal(keyOf(id(), { id: 12n }), "12");
    assert.throws(() => keyOf(id(), {}), /missing key/);
    assert.throws(() => compositeId(["id", "id"]), /duplicate/);
    assert.throws(() => compositeId(["id", "tenantId"], { columns: ["id"] }), /same length/);
    assert.throws(() => assertKey({ properties: ["id"], columns: ["id"], strategy: "sequence", generated: false }), /assigned/);
});

test("every generated JPA strategy is supported", () => {
    for (const strategy of ["identity", "sequence", "table", "uuid", "auto"] as const) {
        assert.equal(generatedId("entityId", { strategy }).strategy, strategy);
        assert.equal(generatedId({ strategy }).generated, true);
    }
    assert.equal(id().strategy, "assigned");
    assert.throws(() => generatedId({ strategy: "assigned" }), /generated strategy/);
    assert.throws(() => generatedId({ strategy: "bad" as IdStrategy }), /unknown/);
    assert.throws(() => id({ strategy: "identity" }), /generatedId/);
    assert.throws(() => assertKey({ properties: ["id"], columns: ["id"], strategy: "assigned", generated: true }), /generated/);
});

test("entity validates key columns and duplicate columns", () => {
    assert.throws(() => entity({ ...base(), key: id("missing") }), /not a column/);
    assert.throws(() => entity({ ...base(), key: id({ column: "other" }) }), /mismatch/);
    assert.throws(() => entity({ ...base(), columns: [column("id", { transient: true })] }), /transient/);
    assert.throws(() => entity({ ...base(), columns: [column("id"), column("id")] }), /duplicate/);
    assert.throws(() => entity({ ...base(), columns: [column("id"), column("other", { column: "id" })] }), /duplicate/);
});

test("indexes and unique constraints must reference persistent columns", () => {
    const metadata = entity({ ...base(), indexes: [index("id_index", ["id"], { unique: true })], uniqueConstraints: [uniqueConstraint("id_unique", ["id"])] });
    assert.equal(metadata.indexes[0].unique, true);
    assert.throws(() => entity({ ...base(), indexes: [index("bad", ["absent"])] }), /unknown column/);
    assert.throws(() => entity({ ...base(), uniqueConstraints: [uniqueConstraint("bad", ["absent"])] }), /unknown column/);
    assert.throws(() => entity({ ...base(), indexes: [index("dup", ["id"]), index("dup", ["id"])] }), /duplicate/);
    assert.throws(() => entity({ ...base(), uniqueConstraints: [uniqueConstraint("dup", ["id"]), uniqueConstraint("dup", ["id"])] }), /duplicate/);
    assert.throws(() => index("bad", ["id", "id"]), /duplicate/);
});

test("version column is inferred and custom version properties drive descriptors", () => {
    const metadata = entity<{ id: string; revision: number }>({ ...base(), columns: [column("id"), column("revision", { column: "lock_version", version: true })] });
    assert.equal(metadata.versionColumn, "lock_version");
    assert.equal(metadata.descriptor.versionOf({ id: "s", revision: 4 }), 4);
    assert.equal(metadata.descriptor.encode({ id: "s", revision: 4 }).version, 4);
    assert.throws(() => metadata.descriptor.versionOf({ id: "s", revision: -1 }), /version/);
    assert.throws(() => entity({ ...base(), versionColumn: "missing" }), /not a column/);
    assert.throws(() => entity({ ...base(), versionColumn: "id" }), /flagged/);
    assert.throws(() => entity({ ...base(), columns: [...base().columns, column("revision", { version: true })] }), /at most one/);
    assert.throws(() => column("version", { version: true, transient: true }), /transient/);
});

test("column options reject invalid precision and runtime boolean metadata", () => {
    assert.equal(column("tenantId").column, "tenant_id");
    assert.throws(() => column("cost", { precision: 2, scale: 3 }), /scale/);
    assert.throws(() => column("text", { length: 0 }), /length/);
    assert.throws(() => column("id", { nullable: "yes" as unknown as boolean }), /boolean/);
});

test("four association builders support ownership metadata", () => {
    assert.equal(oneToOne("profile", "session", { mappedBy: "owner" }).mappedBy, "owner");
    assert.equal(oneToMany("turns", "turn", { mappedBy: "session", orphanRemoval: true }).orphanRemoval, true);
    assert.equal(manyToOne("session", "session", { joinColumns: ["session_id"], fetch: "eager" }).fetch, "eager");
    const owning = manyToMany("goals", "goal", { joinTable: "session_goals", joinColumns: ["session_id"], inverseJoinColumns: ["goal_id"], cascade: ["persist", "merge"] });
    assert.equal(owning.joinTable, "session_goals");
    assert.equal(manyToMany("sessions", "session", { mappedBy: "goals" }).mappedBy, "goals");
    assert.ok(Object.isFrozen(owning.joinColumns));
});

test("association ownership and orphan removal are validated", () => {
    assert.throws(() => manyToMany("goals", "goal"), /joinTable/);
    assert.throws(() => oneToMany("turns", "turn"), /mappedBy/);
    assert.throws(() => manyToOne("parent", "session", { orphanRemoval: true }), /orphanRemoval/);
    assert.throws(() => manyToMany("goals", "goal", { joinTable: "links", orphanRemoval: true }), /orphanRemoval/);
    assert.throws(() => manyToOne("parent", "session", { mappedBy: "child" }), /mappedBy/);
    assert.throws(() => manyToMany("goals", "goal", { mappedBy: "sessions", joinTable: "links" }), /inverse/);
    assert.throws(() => oneToOne("parent", "session", { mappedBy: "child", joinColumns: ["parent_id"] }), /inverse/);
    assert.throws(() => oneToOne("parent", "unknown" as EntityKind), /unknown/);
});

test("cascade and fetch are checked and cascade lists frozen", () => {
    assert.deepEqual(cascade("persist", "persist", "remove"), ["persist", "remove"]);
    assert.ok(Object.isFrozen(cascade("persist")));
    assert.throws(() => cascade("all" as CascadeType), /unknown cascade/);
    assert.throws(() => oneToOne("parent", "session", { fetch: "bad" as FetchType }), /fetch/);
    assert.throws(() => entity({ ...base(), associations: [oneToOne("parent", "session"), oneToOne("parent", "session")] }), /duplicate/);
    assert.throws(() => entity({ ...base(), associations: [oneToOne("id", "session")] }), /already a column/);
});

test("ManyToMany target wrapper compiles and preserves target type", () => {
    const relation: ManyToMany<{ readonly id: string }> = { association: "many_to_many", target: [{ id: "goal" }] };
    const identifier: string = relation.target[0].id;
    assert.equal(identifier, "goal");
});

test("entity metadata is deeply frozen and copies caller-owned lists", () => {
    const columns = base().columns;
    const metadata = defineEntity({ ...base(), columns, indexes: [index("lookup", ["id"])], associations: [oneToMany("turns", "turn", { mappedBy: "session" })] });
    columns.push(column("later"));
    assert.equal(metadata.columns.length, 2);
    for (const object of [metadata, metadata.key, metadata.key.properties, metadata.key.columns, metadata.columns, metadata.columns[0], metadata.indexes, metadata.indexes[0], metadata.indexes[0].columns, metadata.associations, metadata.associations[0], metadata.descriptor]) assert.ok(Object.isFrozen(object));
    assert.throws(() => { (metadata.columns as unknown as unknown[]).push({}); }, TypeError);
});

test("JSON descriptors roundtrip independently and validate key/version", () => {
    const descriptor = jsonDescriptor<{ id: string; version: number; nested: { count: number } }>("session", { idOf: item => item.id, versionOf: item => item.version });
    const value = { id: "s", version: 2, nested: { count: 1 } };
    const record = descriptor.encode(value);
    assert.equal(record.id, "s");
    assert.equal(record.version, 2);
    const decoded = descriptor.decode(record);
    assert.deepEqual(decoded, value);
    assert.notStrictEqual(decoded.nested, value.nested);
    assert.throws(() => descriptor.encode({ ...value, id: "" }), /usable id/);
    assert.throws(() => descriptor.encode({ ...value, version: 0.5 }), /version/);
    assert.equal(entityKey("session", "s"), "session:s");
    assert.throws(() => entityKey("session", ""), /non-empty/);
});
