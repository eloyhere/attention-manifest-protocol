#!/usr/bin/env node
/**
 * Person domain checks with the in-memory port. No SQLite, no database module.
 *
 * These tests are the executable form of docs/agent-as-person.md: append-only narrative,
 * one active role, typed memory, affect as state, social membership, and a
 * budgeted context assembly that records exclusions.
 */
import assert from "node:assert/strict";

import { AgentError } from "../src/error/agentError.ts";
import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import type {
    AffectState,
    AgentExecutionPort,
    BackgroundProcess,
    CreateAgentResult,
    CreateProcessResult,
    Memory,
    Role,
    RoleConflict,
    SelfNarrative,
} from "../src/process/index.ts";
import type { Institution, Membership, Relationship } from "../src/ipc/index.ts";
import type { AgentContext } from "../src/context/agentContext.ts";

const At: string = "2026-10-24T00:00:00.000Z";
const Later: string = "2026-10-25T00:00:00.000Z";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => void = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed += 1;
        console.log(`\x1b[32m\u2713\x1b[0m ${name}`);
    } catch (error) {
        Failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m\u2717\x1b[0m ${name}\n      ${message}`);
    }
};

/**
 * Store and service instances a check builds on.
 */
type SetupResult = {
    agents: InMemoryAgentStore;
    social: InMemorySocialStore;
    service: AgentService;
    created: CreateAgentResult;
};

class FakeExecution implements AgentExecutionPort {
    private next: number = 1;

    createProcess(): CreateProcessResult {
        const pid: number = this.next;
        this.next += 1;
        return { pid };
    }
}

const setup: () => SetupResult = (): SetupResult => {
    const agents: InMemoryAgentStore = new InMemoryAgentStore();
    const social: InMemorySocialStore = new InMemorySocialStore();
    const service: AgentService = new AgentService(agents, social, new FakeExecution());
    const created: CreateAgentResult = service.createAgent({
        id: "a.person.1",
        name: "Ada",
        values: ["truth", "care"],
        constraints: ["do not fabricate evidence"],
        narrative: "I am learning to separate what I know from what I fear.",
        at: At,
    });
    return { agents, social, service, created };
};

test("an agent is created as a process with profile, role, narrative and affect", () => {
    const { agents, created }: SetupResult = setup();
    assert.equal(created.pid, 1);
    assert.equal(created.profile.name, "Ada");
    assert.deepEqual(created.profile.values, ["truth", "care"]);
    assert.equal(created.narrative.version, 1);
    assert.equal(created.role.active, true);
    assert.equal(created.role.role.id, "role.self.1");
    assert.equal(agents.narrative(1)?.version, 1);
    assert.equal(agents.affect(1)?.mood, "neutral");
});

test("self narrative is append-only and old versions remain readable", () => {
    const { service, agents }: SetupResult = setup();
    const version2: SelfNarrative = service.reviseNarrative(1, "I now see the fear as information, not a command.", { name: "Ada", chapter: "second" }, Later);
    assert.equal(version2.version, 2);
    assert.equal(agents.narrative(1)?.narrative.includes("information"), true);
    assert.equal(agents.narrative(1, 1)?.narrative.includes("fear"), true);
    assert.equal(agents.narrative(1, 2)?.version, 2);
});

test("roles are social positions with one active role and explicit conflicts", () => {
    const { service }: SetupResult = setup();
    const engineer: Role = service.addRole({
        id: "role.engineer",
        label: "Engineer",
        obligations: [{ id: "ob.deploy", statement: "deploy the release", conflictsWith: ["ob.rest"] }],
        audiences: ["team"],
        scripts: ["check the build"],
        createdAt: At,
    });
    const parent: Role = service.addRole({
        id: "role.parent",
        label: "Parent",
        obligations: [{ id: "ob.rest", statement: "be present at bedtime" }],
        audiences: ["family"],
        createdAt: At,
    });
    service.assignRole({ pid: 1, roleId: engineer.id, salience: 0.8, active: false, since: At });
    service.activateRole({ pid: 1, roleId: engineer.id, at: Later });
    assert.equal(service.agents.activeRole(1)?.role.id, "role.engineer");
    service.assignRole({ pid: 1, roleId: parent.id, salience: 0.7, active: false, since: At });
    service.activateRole({ pid: 1, roleId: parent.id, at: Later });
    assert.equal(service.agents.activeRole(1)?.role.id, "role.parent");
    assert.equal(service.agents.roles(1).length, 3);
    const conflicts: RoleConflict[] = service.roleConflicts(1);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.obligation, "ob.deploy");
    assert.throws(
        () => service.activateRole({ pid: 1, roleId: "role.missing", at: Later }),
        (error: unknown) => error instanceof AgentError && error.code === "role_not_assigned",
    );
});

test("memory is typed, salience-ranked, and explicitly forgotten or consolidated", () => {
    const { service, agents }: SetupResult = setup();
    const episodic: Memory = service.remember({ pid: 1, kind: "episodic", content: "The deploy broke checkout.", salience: 0.9, at: At });
    service.remember({ pid: 1, kind: "semantic", content: "Checkout depends on the payment service.", salience: 0.6, at: At });
    service.remember({ pid: 1, kind: "social", content: "Mira warned me about the coupling.", salience: 0.7, at: Later });
    assert.equal(service.recall(1, { kind: "semantic" }).length, 1);
    assert.equal(service.recall(1)[0]?.id, episodic.id);
    assert.equal(agents.consolidate(1, [episodic.id], Later), 1);
    assert.equal(agents.memories(1)[0]?.consolidated, true);
    assert.equal(agents.forget(1, episodic.id), true);
    assert.equal(
        agents.memories(1).some((memory) => memory.id === episodic.id),
        false,
    );
});

test("affect is state, clamped, and background processes can be paused", () => {
    const { service, agents }: SetupResult = setup();
    const affect: AffectState = service.setAffect(1, { valence: -2, arousal: 1.4, stress: 0.9, fatigue: 0.2, mood: "tense" }, Later);
    assert.equal(affect.valence, -1);
    assert.equal(affect.arousal, 1);
    assert.equal(affect.stress, 0.9);
    assert.equal(agents.affect(1)?.mood, "tense");

    const habit: BackgroundProcess = service.addBackground({
        pid: 1,
        kind: "habit",
        label: "check messages when anxious",
        intensity: 0.8,
        trigger: "stress > 0.7",
        at: Later,
    });
    assert.equal(agents.background(1, "active").length, 1);
    service.setBackgroundStatus(1, habit.id, "paused", Later);
    assert.equal(agents.background(1, "active").length, 0);
    assert.equal(agents.background(1, "paused").length, 1);
});

test("relationships and institutions are social facts, not message history", () => {
    const { service }: SetupResult = setup();
    const relationship: Relationship = service.relate({
        fromPid: 1,
        toPid: 2,
        kind: "colleague",
        trust: 0.85,
        attachment: 0.4,
        obligations: ["review before merge"],
        since: At,
        lastContact: Later,
    });
    assert.equal(relationship.trust, 0.85);
    const institution: Institution = service.createInstitution({
        id: "org.incident-team",
        name: "Incident Team",
        norms: ["blameless review", "write the timeline"],
    });
    const membership: Membership = service.joinInstitution({ pid: 1, institutionId: institution.id, role: "responder", since: At });
    assert.equal(membership.status, "active");
    assert.equal(service.memberships(1)[0]?.institution.name, "Incident Team");
    assert.equal(service.relationships(1).length, 1);
    service.leaveInstitution(1, institution.id, Later);
    assert.equal(service.memberships(1)[0]?.status, "left");
});

test("context assembly respects budget, orders self first, and records exclusions", () => {
    const { service }: SetupResult = setup();
    for (let index: number = 0; index < 12; index += 1) {
        service.remember({
            pid: 1,
            kind: index % 2 === 0 ? "episodic" : "semantic",
            content: `Memory ${index}: a fairly long observation about the incident and its causes.`,
            salience: 0.3 + index * 0.05,
            at: At,
        });
    }
    service.relate({ fromPid: 1, toPid: 2, kind: "colleague", trust: 0.9, obligations: ["review before merge"], since: At });
    service.addBackground({ pid: 1, kind: "monitor", label: "watch deploy health", intensity: 0.6, at: At });

    const context: AgentContext = service.context(1, { tokens: 220 });
    assert.equal(context.segments[0]?.kind, "self");
    assert.equal(
        context.segments.some((segment) => segment.kind === "role"),
        true,
    );
    assert.equal(context.tokens <= 220, true);
    assert.equal(context.excluded.length > 0, true);
    assert.equal(context.activeRole?.role.id, "role.self.1");

    const onlySelf: AgentContext = service.context(1, { tokens: 220 }, { includeKinds: ["self"] });
    assert.equal(onlySelf.segments.length, 1);
    assert.equal(onlySelf.segments[0]?.kind, "self");
});

test("creating an agent without a pid or execution port is rejected", () => {
    const service: AgentService = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
    assert.throws(() => service.createAgent({ id: "a.no.pid", name: "Nobody", at: At }), /needs a pid/);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
