import assert from "node:assert/strict";
import test from "node:test";

import {
    ENTITY_DECLARATIONS,
    ENTITY_LIFECYCLES,
    ENTITY_LIFECYCLE_REGISTRY,
    ENTITY_REGISTRY,
    LIFECYCLE_TRANSITIONS,
    SessionEntity,
    TaskEntity,
    EvidenceEntity,
    ReceiptEntity,
    StoreMetaEntity,
    descriptorFor,
    lifecycleFor,
} from "./index.ts";
import { ENTITY_KINDS, isEntityKind } from "./key.ts";
import type { Association, Entity, EntityKind } from "./index.ts";

const declarations = Object.entries(ENTITY_DECLARATIONS) as readonly (readonly [EntityKind, Entity])[];

function associationOf(metadata: Entity, property: string): Association {
    const association = metadata.associations.find(candidate => candidate.property === property);
    assert.ok(association, `missing ${metadata.kind}.${property} association`);
    return association;
}

function hasAssociationTarget(metadata: Entity, target: EntityKind): boolean {
    return metadata.associations.some(association => association.target === target);
}

test("every EntityKind has one concrete declaration and one registry entry", () => {
    assert.equal(ENTITY_KINDS.length, 32);
    assert.equal(declarations.length, 32);
    assert.deepEqual(Object.keys(ENTITY_DECLARATIONS).sort(), [...ENTITY_KINDS].sort());
    assert.deepEqual(Object.keys(ENTITY_REGISTRY).sort(), [...ENTITY_KINDS].sort());
    assert.ok(Object.isFrozen(ENTITY_DECLARATIONS));
    assert.ok(Object.isFrozen(ENTITY_REGISTRY));

    for (const kind of ENTITY_KINDS) {
        assert.ok(isEntityKind(kind));
        assert.equal(ENTITY_DECLARATIONS[kind].kind, kind);
        assert.equal(ENTITY_REGISTRY[kind].kind, kind);
        assert.strictEqual(ENTITY_REGISTRY[kind], ENTITY_DECLARATIONS[kind]);
        assert.strictEqual(ENTITY_DECLARATIONS[kind].lifecycle, ENTITY_LIFECYCLES[kind]);
        assert.strictEqual(SessionEntity, ENTITY_DECLARATIONS.session);
        assert.strictEqual(TaskEntity, ENTITY_DECLARATIONS.task);
        assert.strictEqual(EvidenceEntity, ENTITY_DECLARATIONS.evidence);
        assert.strictEqual(ReceiptEntity, ENTITY_DECLARATIONS.receipt);
        assert.strictEqual(StoreMetaEntity, ENTITY_DECLARATIONS.store_meta);
    }
});

test("declarations carry the shared JSON row schema and an assigned key", () => {
    for (const [kind, metadata] of declarations) {
        assert.equal(metadata.table, "entities");
        assert.equal(metadata.access, "field");
        assert.equal(metadata.versionColumn, "version");

        const keyProperty = kind === "store_meta" ? "key" : "id";
        assert.deepEqual(metadata.key.properties, [keyProperty]);
        assert.deepEqual(metadata.key.columns, [keyProperty]);
        assert.equal(metadata.key.strategy, "assigned");
        assert.equal(metadata.key.generated, false);

        const columnNames = metadata.columns.map(column => column.column);
        assert.deepEqual(
            [...columnNames].sort(),
            [keyProperty, "tenant_id", "session_id", "kind", "version", "updated_at", "payload"].sort(),
        );
        const properties = metadata.columns.map(column => column.property);
        for (const property of [keyProperty, "tenantId", "sessionId", "kind", "version", "updatedAt", "payload"]) {
            assert.ok(properties.includes(property), `${kind} missing column property ${property}`);
        }

        const keyColumn = metadata.columns.find(column => column.column === keyProperty);
        assert.ok(keyColumn);
        assert.equal(keyColumn.nullable, false);
        assert.equal(keyColumn.unique, true);

        const version = metadata.columns.find(column => column.column === "version");
        assert.ok(version);
        assert.equal(version.nullable, false);
        assert.equal(version.version, true);

        for (const column of ["updated_at", "payload"]) {
            const declared = metadata.columns.find(candidate => candidate.column === column);
            assert.ok(declared);
            assert.equal(declared.nullable, false);
        }
    }
});

test("declared indexes and unique columns always reference existing columns", () => {
    for (const [kind, metadata] of declarations) {
        const columnNames = new Set(metadata.columns.map(column => column.column));
        const expected = [
            [`idx_${kind}_tenant`, ["tenant_id"]],
            [`idx_${kind}_session`, ["session_id"]],
            [`idx_${kind}_updated`, ["updated_at"]],
        ] as const;
        assert.equal(metadata.indexes.length, expected.length);
        for (const [name, columns] of expected) {
            const declared = metadata.indexes.find(candidate => candidate.name === name);
            assert.ok(declared, `${kind} missing index ${name}`);
            assert.deepEqual(declared.columns, columns);
            assert.equal(declared.unique, false);
        }
        for (const declared of metadata.indexes) {
            assert.ok(Object.isFrozen(declared));
            for (const column of declared.columns) assert.ok(columnNames.has(column), `${kind}.${declared.name} references ${column}`);
        }
        for (const constraint of metadata.uniqueConstraints) {
            assert.ok(Object.isFrozen(constraint));
            for (const column of constraint.columns) assert.ok(columnNames.has(column), `${kind}.${constraint.name} references ${column}`);
        }
        for (const column of metadata.columns) {
            if (column.unique) assert.ok(columnNames.has(column.column));
        }
    }
});

test("association targets exist and every mappedBy has a reverse side", () => {
    for (const [kind, metadata] of declarations) {
        for (const association of metadata.associations) {
            assert.ok(Object.isFrozen(association));
            const target = ENTITY_DECLARATIONS[association.target];
            assert.ok(target, `${kind}.${association.property} targets unknown ${association.target}`);
            assert.equal(target.kind, association.target);

            if (association.mappedBy !== undefined) {
                const reverse = target.associations.find(candidate => candidate.property === association.mappedBy);
                assert.ok(reverse, `${kind}.${association.property} mappedBy ${association.target}.${association.mappedBy} is missing`);
                assert.equal(reverse.target, kind);
            }
            if (association.kind === "many_to_many") {
                if (association.mappedBy === undefined) assert.ok(association.joinTable, `${kind}.${association.property} owning many_to_many needs joinTable`);
                else assert.equal(association.joinTable, undefined);
            }
            if (association.kind === "one_to_many") assert.ok(association.mappedBy);
            if (association.kind === "many_to_one") assert.equal(association.mappedBy, undefined);
        }
    }
});

test("the previously declared relationship edges are preserved", () => {
    assert.equal(associationOf(SessionEntity, "turns").kind, "one_to_many");
    assert.equal(associationOf(SessionEntity, "turns").target, "turn");
    assert.equal(associationOf(ENTITY_DECLARATIONS.turn, "session").target, "session");
    assert.equal(associationOf(ENTITY_DECLARATIONS.turn, "intents").target, "intent");
    assert.equal(associationOf(ENTITY_DECLARATIONS.mission, "goals").target, "goal");
    assert.equal(associationOf(ENTITY_DECLARATIONS.goal, "plans").target, "plan");
    assert.equal(associationOf(ENTITY_DECLARATIONS.plan, "tasks").target, "task");
    assert.equal(associationOf(ENTITY_DECLARATIONS.task, "actions").target, "action");

    const evidenceReceipt = associationOf(EvidenceEntity, "receipt");
    assert.equal(evidenceReceipt.kind, "many_to_one");
    assert.equal(evidenceReceipt.target, "receipt");
    const receiptEvidence = associationOf(ReceiptEntity, "evidence");
    assert.equal(receiptEvidence.kind, "one_to_many");
    assert.equal(receiptEvidence.target, "evidence");
    assert.equal(receiptEvidence.mappedBy, "receipt");

    assert.ok(hasAssociationTarget(ENTITY_DECLARATIONS.project_rule, "project_metadata"));
    assert.ok(hasAssociationTarget(ENTITY_DECLARATIONS.project_rule, "project_view"));
    assert.ok(hasAssociationTarget(ENTITY_DECLARATIONS.budget_ledger, "budget_reservation"));
    assert.ok(hasAssociationTarget(ENTITY_DECLARATIONS.cooperation_task, "cooperation_message"));
    assert.ok(hasAssociationTarget(ENTITY_DECLARATIONS.execution_invocation, "execution_observation"));
    assert.ok(hasAssociationTarget(ENTITY_DECLARATIONS.context_checkpoint, "context_cache_entry"));

    const dependencies = associationOf(ENTITY_DECLARATIONS.goal, "dependencies");
    assert.equal(dependencies.kind, "many_to_many");
    assert.equal(dependencies.joinTable, "goal_dependencies");
    assert.deepEqual(dependencies.joinColumns, ["goal_id"]);
    assert.deepEqual(dependencies.inverseJoinColumns, ["dependency_id"]);
});

test("entity metadata and descriptor are deeply frozen", () => {
    for (const metadata of Object.values(ENTITY_DECLARATIONS)) {
        for (const value of [
            metadata,
            metadata.key,
            metadata.key.properties,
            metadata.key.columns,
            metadata.columns,
            metadata.indexes,
            metadata.uniqueConstraints,
            metadata.associations,
            metadata.descriptor,
            metadata.lifecycle,
        ]) {
            assert.ok(Object.isFrozen(value), `${metadata.kind} metadata is not frozen`);
        }
        for (const column of metadata.columns) assert.ok(Object.isFrozen(column));
        for (const declared of metadata.indexes) assert.ok(Object.isFrozen(declared));
        for (const declared of metadata.associations) assert.ok(Object.isFrozen(declared));
    }
});

test("registry descriptors remain Store-compatible JSON record codecs", () => {
    for (const kind of ENTITY_KINDS) {
        const keyProperty = kind === "store_meta" ? "key" : "id";
        const value = {
            [keyProperty]: `id-${kind}`,
            tenantId: "tenant-1",
            sessionId: "session-1",
            kind,
            version: 3,
            updatedAt: "2026-01-01T00:00:00.000Z",
            payload: { nested: { kind } },
        };
        const descriptor = descriptorFor<typeof value>(kind);
        assert.strictEqual(descriptor, ENTITY_REGISTRY[kind].descriptor);
        assert.equal(descriptor.table, "entities");
        assert.equal(descriptor.keyOf(value), `id-${kind}`);

        const record = descriptor.encode(value);
        assert.equal(record.id, `id-${kind}`);
        assert.equal(record.tenantId, "tenant-1");
        assert.equal(record.sessionId, "session-1");
        assert.equal(record.kind, kind);
        assert.equal(record.version, 3);
        assert.equal(record.updatedAt, "2026-01-01T00:00:00.000Z");
        assert.deepEqual(descriptor.decode(record), value);
        assert.equal(descriptor.versionOf(value), 3);
    }
    assert.throws(() => descriptorFor("not-a-kind" as EntityKind), /unknown/);
});

test("legacy domain identifier properties remain addressable through descriptors", () => {
    const cases: readonly (readonly [EntityKind, Record<string, unknown>, string])[] = [
        ["budget_ledger", { budgetKey: "budget-1" }, "budget-1"],
        ["action_attempt", { attemptId: "attempt-1" }, "attempt-1"],
        ["manifest", { manifestId: "manifest-1" }, "manifest-1"],
        ["capability_activation", { activationId: "activation-1" }, "activation-1"],
        ["cooperation_task", { taskId: "task-1" }, "task-1"],
        ["cooperation_message", { messageId: "message-1" }, "message-1"],
        ["behavior_candidate", { candidateId: "candidate-1" }, "candidate-1"],
        ["context_cache_entry", { signature: "signature-1" }, "signature-1"],
        ["project_metadata", { tenantId: "t", rootId: "r", path: "src/a.ts" }, "t:r:src%2Fa.ts"],
        ["project_view", { tenantId: "t", rootId: "r", kind: "er" }, "t:r:er"],
        ["project_environment", { tenantId: "t", rootId: "r" }, "t:r"],
    ];
    for (const [kind, value, expected] of cases) {
        const descriptor = descriptorFor<Record<string, unknown>>(kind);
        assert.equal(descriptor.keyOf(value), expected);
        assert.equal(descriptor.encode({ ...value, version: 1 }).id, expected);
        // An explicit `id` still wins over the legacy identifier fallback.
        assert.equal(descriptor.keyOf({ ...value, id: "explicit" }), "explicit");
    }
});

test("each declaration has frozen lifecycle hooks with repeatable guards", () => {
    assert.ok(Object.isFrozen(ENTITY_LIFECYCLES));
    for (const kind of ENTITY_KINDS) {
        const hooks = ENTITY_LIFECYCLES[kind];
        assert.ok(hooks, `${kind} has no lifecycle hooks`);
        assert.ok(Object.isFrozen(hooks));
        assert.strictEqual(lifecycleFor(kind), hooks);
        assert.deepEqual(ENTITY_LIFECYCLE_REGISTRY.get(kind), hooks);
        assert.equal(ENTITY_LIFECYCLE_REGISTRY.has(kind), true);
    }

    const context = { kind: "session" as const, state: "new" as const, version: 0, now: "2026-01-01T00:00:00.000Z" };
    const sessionPrePersist = ENTITY_LIFECYCLES.session.prePersist;
    assert.ok(sessionPrePersist);
    assert.doesNotThrow(() => sessionPrePersist({ id: "session-1", version: 0 }, context));
    assert.throws(() => sessionPrePersist({ id: "", version: 0 }, context), /non-empty id/);
    assert.throws(() => sessionPrePersist({ id: "session-1", version: -1 }, context), /version/);

    const storeMetaPrePersist = ENTITY_LIFECYCLES.store_meta.prePersist;
    assert.ok(storeMetaPrePersist);
    assert.doesNotThrow(() => storeMetaPrePersist(
        { key: "meta", version: 0 },
        { kind: "store_meta", state: "new", version: 0, now: "2026-01-01T00:00:00.000Z" },
    ));

    for (const kind of ["session", "task", "evidence", "receipt"] as const) {
        const postLoad = ENTITY_LIFECYCLES[kind].postLoad;
        assert.ok(postLoad, `${kind} needs a postLoad example`);
        const loaded: Record<string, unknown> = { id: `${kind}-1`, version: 1 };
        postLoad(loaded, { kind, state: "managed", version: 1, now: "2026-01-01T00:00:00.000Z" });
        assert.ok(Object.isFrozen(loaded));
        assert.doesNotThrow(() => postLoad(loaded, { kind, state: "managed", version: 1, now: "2026-01-01T00:00:00.000Z" }));
    }

    const fired = ENTITY_LIFECYCLE_REGISTRY.fire(
        "session",
        "prePersist",
        { id: "session-1", version: 0 },
        context,
    );
    assert.equal(fired.invoked, 1);
    assert.deepEqual(fired.errors, []);
    assert.ok(Object.isFrozen(fired));
});

test("the declared lifecycle transition table is complete and frozen", () => {
    assert.deepEqual(Object.keys(LIFECYCLE_TRANSITIONS).sort(), ["deleted", "detached", "managed", "new", "removed"]);
    for (const targets of Object.values(LIFECYCLE_TRANSITIONS)) assert.ok(Object.isFrozen(targets));
    assert.deepEqual(LIFECYCLE_TRANSITIONS.new, ["managed"]);
    assert.deepEqual(LIFECYCLE_TRANSITIONS.removed, []);
    assert.deepEqual(LIFECYCLE_TRANSITIONS.deleted, []);
});
