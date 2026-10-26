#!/usr/bin/env node
/**
 * Agent/Social SQLite adapter checks.
 *
 * These run the real `AgentStore`/`SocialStore` adapters through the database
 * facade, using the new TableSql/Repository architecture. The domain tests
 * (`agent-check`) remain storage-free; this file proves the adapter mapping.
 */
import assert from "node:assert/strict";

import { Database } from "../src/database/service/database.ts";
import { AgentService } from "../src/process/index.ts";
import type { AgentExecutionPort } from "../src/process/index.ts";

const At: string = "2026-10-24T00:00:00.000Z";
const Later: string = "2026-10-25T00:00:00.000Z";

let passed: number = 0;
let failed: number = 0;

const test = (name: string, fn: () => void): void => {
    try {
        fn();
        passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

const setup = () => {
    const db = new Database(":memory:");
    const execution: AgentExecutionPort = {
        createProcess: ({ id, name, at }) => {
            const process = db.processService.create({ id, name }, at);
            return { pid: process.pid };
        },
    };
    const service = new AgentService(db.adapters.agents, db.adapters.social, execution);
    const created = service.createAgent({
        id: "a.sqlite.1",
        name: "Ada SQLite",
        values: ["truth", "care"],
        constraints: ["do not fabricate evidence"],
        narrative: "I am learning to separate evidence from fear.",
        at: At,
    });
    return { db, service, created };
};

test("SQLite adapter creates the process and the agent profile", () => {
    const { db, created } = setup();
    assert.equal(created.pid, 1);
    assert.equal(created.profile.name, "Ada SQLite");
    assert.deepEqual(created.profile.values, ["truth", "care"]);
    assert.equal(db.processService.byId(created.pid)?.state, "created");
    assert.equal(db.adapters.agents.narrative(created.pid)?.version, 1);
    db.close();
});

test("roles, memories, affect and background processes round-trip", () => {
    const { db, service, created } = setup();
    const parent = service.addRole({
        id: "role.parent",
        label: "Parent",
        obligations: [{ id: "ob.rest", statement: "be present at bedtime", conflictsWith: ["ob.deploy"] }],
        expectations: ["patient"],
        audiences: ["family"],
        scripts: ["bedtime"],
        createdAt: At,
    });
    service.assignRole({ pid: created.pid, roleId: parent.id, salience: 0.8, active: false, since: At });
    service.activateRole({ pid: created.pid, roleId: parent.id, at: Later });
    assert.equal(service.agents.activeRole(created.pid)?.role.id, "role.parent");

    const memory = service.remember({ pid: created.pid, kind: "episodic", content: "The deploy broke checkout.", salience: 0.9, at: At });
    assert.equal(service.recall(created.pid, { kind: "episodic" })[0]?.id, memory.id);
    service.setAffect(created.pid, { valence: -0.5, stress: 0.8, mood: "tense" }, Later);
    assert.equal(service.agents.affect(created.pid)?.stress, 0.8);

    const habit = service.addBackground({ pid: created.pid, kind: "habit", label: "check messages when anxious", intensity: 0.7, at: Later });
    service.setBackgroundStatus(created.pid, habit.id, "paused", Later);
    assert.equal(service.agents.background(created.pid, "paused").length, 1);
    db.close();
});

test("relationships and institutions round-trip through SocialStore", () => {
    const { db, service, created } = setup();
    db.processService.create({ id: "a.sqlite.2", name: "Other Agent" }, At);
    const relationship = service.relate({
        fromPid: created.pid,
        toPid: 2,
        kind: "colleague",
        trust: 0.85,
        attachment: 0.4,
        obligations: ["review before merge"],
        since: At,
        lastContact: Later,
    });
    assert.equal(relationship.trust, 0.85);
    const institution = service.createInstitution({ id: "org.incident", name: "Incident Team", norms: ["blameless review"] });
    service.joinInstitution({ pid: created.pid, institutionId: institution.id, role: "responder", since: At });
    assert.equal(service.memberships(created.pid)[0]?.status, "active");
    service.leaveInstitution(created.pid, institution.id, Later);
    assert.equal(service.memberships(created.pid)[0]?.status, "left");
    db.close();
});

test("agent context is assembled from the SQLite adapter", () => {
    const { db, service, created } = setup();
    db.processService.create({ id: "a.sqlite.2", name: "Other Agent" }, At);
    service.remember({ pid: created.pid, kind: "semantic", content: "Checkout depends on payments.", salience: 0.7, at: At });
    service.relate({ fromPid: created.pid, toPid: 2, kind: "colleague", trust: 0.9, since: At });
    const context = service.context(created.pid, { tokens: 300 });
    assert.equal(context.profile.name, "Ada SQLite");
    assert.equal(context.segments[0]?.kind, "self");
    assert.equal(context.tokens <= 300, true);
    db.close();
});

test("life events and narrative versions persist", () => {
    const { db, service, created } = setup();
    service.reviseNarrative(created.pid, "I now treat fear as information.", { name: "Ada SQLite", chapter: "second" }, Later);
    service.recordLifeEvent({ pid: created.pid, kind: "insight", summary: "separated fear from evidence", at: Later, impact: 0.8, narrativeVersion: 2 });
    assert.equal(service.agents.narrative(created.pid)?.version, 2);
    assert.equal(service.agents.narrative(created.pid, 1)?.version, 1);
    assert.equal(service.agents.lifeEvents(created.pid).length, 1);
    db.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
