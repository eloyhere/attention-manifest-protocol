/**
 * SQLite adapter for `AgentStore`.
 *
 * All table access goes through `TableSql`; this class owns mapping between the
 * database rows and the domain types. It deliberately does not expose rows or
 * a connection to the domain.
 */
import type { DatabaseSync } from "node:sqlite";

import type {
    AgentProfile,
    AgentStore,
    AffectState,
    BackgroundProcess,
    LifeEvent,
    Memory,
    MemoryQuery,
    Pid,
    Role,
    RoleAssignment,
    SelfNarrative,
} from "../../process/agent.ts";
import { AgentError } from "../../error/agentError.ts";
import type { SqlParameter } from "../sql/sql.ts";
import { TableSql } from "../sql/sql.ts";
import { BaseRepository } from "./base.ts";
import {
    AffectTable,
    AgentProfileTable,
    BackgroundTable,
    LifeEventTable,
    MemoryTable,
    PersonRoleTable,
    RoleTable,
    SelfNarrativeTable,
} from "../entity/agent.ts";
import type { AffectRow, AgentProfileRow, BackgroundRow, LifeEventRow, MemoryRow, PersonRoleRow, RoleRow, SelfNarrativeRow } from "../entity/agent.ts";

const parseJson = <T>(text: string, fallback: T): T => {
    try {
        return JSON.parse(text) as T;
    } catch {
        return fallback;
    }
};

const toProfile = (row: AgentProfileRow): AgentProfile => ({
    pid: row.pid,
    name: row.name,
    lifeChapter: row.life_chapter,
    values: parseJson<string[]>(row.values_json, []),
    constraints: parseJson<string[]>(row.constraints_json, []),
    version: row.version,
    updatedAt: row.updated_at,
});

const toNarrative = (row: SelfNarrativeRow): SelfNarrative => {
    const narrative: SelfNarrative = {
        pid: row.pid,
        version: row.version,
        identity: parseJson<Record<string, unknown>>(row.identity_json, {}),
        narrative: row.narrative,
        at: row.at,
    };
    if (row.object_seq !== null) {
        narrative.objectSeq = row.object_seq;
    }
    return narrative;
};

const toRole = (row: RoleRow): Role => ({
    id: row.id,
    label: row.label,
    obligations: parseJson(row.obligations_json, []),
    expectations: parseJson<string[]>(row.permissions_json, []),
    audiences: parseJson<string[]>(row.audiences_json, []),
    scripts: parseJson<string[]>(row.scripts_json, []),
    status: row.status as Role["status"],
    createdAt: row.created_at,
});

const toMemory = (row: MemoryRow): Memory => ({
    id: row.id,
    pid: row.pid,
    ...(row.role_id === null ? {} : { roleId: row.role_id }),
    kind: row.kind as Memory["kind"],
    content: row.content,
    salience: row.salience,
    at: row.at,
    refs: parseJson(row.refs_json, []),
    ...(row.source === null ? {} : { source: row.source }),
    consolidated: row.consolidated !== 0,
});

const toAffect = (row: AffectRow): AffectState => ({
    pid: row.pid,
    valence: row.valence,
    arousal: row.arousal,
    stress: row.stress,
    fatigue: row.fatigue,
    mood: row.mood,
    updatedAt: row.updated_at,
});

const toBackground = (row: BackgroundRow): BackgroundProcess => {
    const process: BackgroundProcess = {
        id: row.id,
        pid: row.pid,
        kind: row.kind as BackgroundProcess["kind"],
        label: row.label,
        intensity: row.intensity,
        status: row.status as BackgroundProcess["status"],
        updatedAt: row.updated_at,
    };
    if (row.trigger !== null) {
        process.trigger = row.trigger;
    }
    if (row.script !== null) {
        process.script = row.script;
    }
    return process;
};

const toLifeEvent = (row: LifeEventRow): LifeEvent => {
    const event: LifeEvent = {
        id: row.id,
        pid: row.pid,
        kind: row.kind as LifeEvent["kind"],
        summary: row.summary,
        at: row.at,
        impact: row.impact,
    };
    if (row.role_id !== null) {
        event.roleId = row.role_id;
    }
    if (row.narrative_version !== null) {
        event.narrativeVersion = row.narrative_version;
    }
    return event;
};

export class AgentRepository extends BaseRepository<AgentProfileRow, number> implements AgentStore {
    private readonly narratives: TableSql<SelfNarrativeRow>;
    private readonly roleRows: TableSql<RoleRow>;
    private readonly assignments: TableSql<PersonRoleRow>;
    private readonly memoryRows: TableSql<MemoryRow>;
    private readonly affectRows: TableSql<AffectRow>;
    private readonly backgroundRows: TableSql<BackgroundRow>;
    private readonly eventRows: TableSql<LifeEventRow>;

    constructor(db: DatabaseSync) {
        super(db, AgentProfileTable);
        this.narratives = new TableSql(db, SelfNarrativeTable);
        this.roleRows = new TableSql(db, RoleTable);
        this.assignments = new TableSql(db, PersonRoleTable);
        this.memoryRows = new TableSql(db, MemoryTable);
        this.affectRows = new TableSql(db, AffectTable);
        this.backgroundRows = new TableSql(db, BackgroundTable);
        this.eventRows = new TableSql(db, LifeEventTable);
    }

    profile(pid: Pid): AgentProfile | undefined {
        const row = this.findById(pid);
        return row === (void 0) ? undefined : toProfile(row);
    }

    narrative(pid: Pid, version?: number): SelfNarrative | undefined {
        const rows =
            version === (void 0)
                ? this.narratives.select({ where: "pid = ?", params: [pid], orderBy: "ORDER BY version DESC", limit: 1 })
                : this.narratives.select({ where: "pid = ? AND version = ?", params: [pid, version], limit: 1 });
        return rows.length === 0 ? undefined : toNarrative(rows[0]);
    }

    roles(pid: Pid): RoleAssignment[] {
        const rows = this.assignments.select({ where: "pid = ?", params: [pid] });
        const result: RoleAssignment[] = [];
        for (const row of rows) {
            const role = this.roleRows.findById(row.rid);
            if (role === (void 0)) {
                continue;
            }
            result.push({ role: toRole(role), salience: row.salience, active: row.active !== 0, since: row.since });
        }
        return result;
    }

    activeRole(pid: Pid): RoleAssignment | undefined {
        return this.roles(pid).find((assignment) => assignment.active);
    }

    memories(pid: Pid, query: MemoryQuery = {}): Memory[] {
        const clauses: string[] = ["pid = ?"];
        const params: SqlParameter[] = [pid];
        if (query.kind !== (void 0)) {
            clauses.push("kind = ?");
            params.push(query.kind);
        }
        if (query.roleId !== (void 0)) {
            clauses.push("role_id = ?");
            params.push(query.roleId);
        }
        if (query.minSalience !== (void 0)) {
            clauses.push("salience >= ?");
            params.push(query.minSalience);
        }
        if (query.before !== (void 0)) {
            clauses.push("at < ?");
            params.push(query.before);
        }
        if (query.includeConsolidated === false) {
            clauses.push("consolidated = 0");
        }
        const rows = this.memoryRows.select({
            where: clauses.join(" AND "),
            params,
            orderBy: "ORDER BY salience DESC, at DESC",
            limit: query.limit ?? 200,
        });
        return rows.map(toMemory);
    }

    affect(pid: Pid): AffectState | undefined {
        const row = this.affectRows.findById(pid);
        return row === (void 0) ? undefined : toAffect(row);
    }

    background(pid: Pid, status?: BackgroundProcess["status"]): BackgroundProcess[] {
        const clauses: string[] = ["pid = ?"];
        const params: SqlParameter[] = [pid];
        if (status !== (void 0)) {
            clauses.push("status = ?");
            params.push(status);
        }
        return this.backgroundRows.select({ where: clauses.join(" AND "), params, orderBy: "ORDER BY intensity DESC" }).map(toBackground);
    }

    lifeEvents(pid: Pid, limit: number = 20): LifeEvent[] {
        return this.eventRows.select({ where: "pid = ?", params: [pid], orderBy: "ORDER BY at DESC", limit }).map(toLifeEvent);
    }

    createProfile(input: Parameters<AgentStore["createProfile"]>[0]): AgentProfile {
        if (this.findById(input.pid) !== (void 0)) {
            throw new AgentError("profile_exists", [`pid ${input.pid}`]);
        }
        this.queries.insert({
            pid: input.pid,
            name: input.name,
            narrative: "",
            values_json: JSON.stringify(input.values ?? []),
            constraints_json: JSON.stringify(input.constraints ?? []),
            life_chapter: input.lifeChapter ?? "starting",
            updated_at: input.at,
            version: 1,
        });
        const profile = this.profile(input.pid);
        if (profile === (void 0)) {
            throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        }
        return profile;
    }

    reviseNarrative(input: Parameters<AgentStore["reviseNarrative"]>[0]): SelfNarrative {
        if (this.findById(input.pid) === (void 0)) {
            throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        }
        const count = this.narratives.count("pid = ?", input.pid);
        const version = count + 1;
        this.narratives.insert({
            pid: input.pid,
            version,
            identity_json: JSON.stringify(input.identity),
            narrative: input.narrative,
            at: input.at,
        });
        const narrative = this.narrative(input.pid, version);
        if (narrative === (void 0)) {
            throw new AgentError("agent_not_found", [`narrative ${input.pid}/${version}`]);
        }
        return narrative;
    }

    addRole(input: Parameters<AgentStore["addRole"]>[0]): Role {
        this.roleRows.insert({
            id: input.id,
            label: input.label,
            obligations_json: JSON.stringify(input.obligations ?? []),
            permissions_json: JSON.stringify(input.expectations ?? []),
            audiences_json: JSON.stringify(input.audiences ?? []),
            scripts_json: JSON.stringify(input.scripts ?? []),
            status: "active",
            created_at: input.createdAt,
        });
        const row = this.roleRows.select({ where: "id = ?", params: [input.id], limit: 1 })[0];
        if (row === (void 0)) {
            throw new AgentError("role_not_found", [`role ${input.id}`]);
        }
        return toRole(row);
    }

    assignRole(input: Parameters<AgentStore["assignRole"]>[0]): RoleAssignment {
        if (this.findById(input.pid) === (void 0)) {
            throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        }
        const role = this.roleRows.select({ where: "id = ?", params: [input.roleId], limit: 1 })[0];
        if (role === (void 0)) {
            throw new AgentError("role_not_found", [`role ${input.roleId}`]);
        }
        const active = input.active === true ? 1 : 0;
        if (active === 1) {
            this.assignments.updateWhere("pid = ?", { active: 0 }, input.pid);
        }
        const existing = this.assignments.select({ where: "pid = ? AND rid = ?", params: [input.pid, role.rid], limit: 1 });
        if (existing.length === 0) {
            this.assignments.insert({ pid: input.pid, rid: role.rid, salience: input.salience ?? 0.5, active, since: input.since });
        } else {
            this.assignments.updateWhere("pid = ? AND rid = ?", { salience: input.salience ?? 0.5, active, since: input.since }, input.pid, role.rid);
        }
        const assignment = this.assignments.select({ where: "pid = ? AND rid = ?", params: [input.pid, role.rid], limit: 1 })[0];
        if (assignment === (void 0)) {
            throw new AgentError("role_not_assigned", [`pid ${input.pid} role ${input.roleId}`]);
        }
        return { role: toRole(role), salience: assignment.salience, active: assignment.active !== 0, since: assignment.since };
    }

    activateRole(input: Parameters<AgentStore["activateRole"]>[0]): RoleAssignment {
        const role = this.roleRows.select({ where: "id = ?", params: [input.roleId], limit: 1 })[0];
        if (role === (void 0)) {
            throw new AgentError("role_not_found", [`role ${input.roleId}`]);
        }
        const assigned = this.assignments.select({ where: "pid = ? AND rid = ?", params: [input.pid, role.rid], limit: 1 });
        if (assigned.length === 0) {
            throw new AgentError("role_not_assigned", [`pid ${input.pid} role ${input.roleId}`]);
        }
        this.assignments.updateWhere("pid = ?", { active: 0 }, input.pid);
        this.assignments.updateWhere("pid = ? AND rid = ?", { active: 1, since: input.at }, input.pid, role.rid);
        const assignment = this.assignments.select({ where: "pid = ? AND rid = ?", params: [input.pid, role.rid], limit: 1 })[0];
        if (assignment === (void 0)) {
            throw new AgentError("role_not_assigned", [`pid ${input.pid} role ${input.roleId}`]);
        }
        return { role: toRole(role), salience: assignment.salience, active: true, since: assignment.since };
    }

    remember(input: Parameters<AgentStore["remember"]>[0]): Memory {
        if (this.findById(input.pid) === (void 0)) {
            throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        }
        const next = this.memoryRows.queryOne<{ n: number }>("SELECT COALESCE(MAX(mem_id), 0) + 1 AS n FROM memories")?.n ?? 1;
        const id = `mem.${input.pid}.${next}`;
        this.memoryRows.insert({
            id,
            pid: input.pid,
            role_id: input.roleId ?? null,
            kind: input.kind,
            content: input.content,
            salience: input.salience ?? 0.5,
            at: input.at,
            refs_json: JSON.stringify(input.refs ?? []),
            source: input.source ?? null,
            consolidated: 0,
        });
        const row = this.memoryRows.select({ where: "id = ?", params: [id], limit: 1 })[0];
        if (row === (void 0)) {
            throw new AgentError("memory_not_found", [`memory ${id}`]);
        }
        return toMemory(row);
    }

    forget(pid: Pid, memoryId: string): boolean {
        return this.memoryRows.deleteWhere("pid = ? AND id = ?", pid, memoryId) > 0;
    }

    consolidate(pid: Pid, memoryIds: string[], _at: string): number {
        let changed = 0;
        for (const id of memoryIds) {
            changed += this.memoryRows.updateWhere("pid = ? AND id = ?", { consolidated: 1 }, pid, id);
        }
        return changed;
    }

    setAffect(pid: Pid, input: Parameters<AgentStore["setAffect"]>[1], at: string): AffectState {
        if (this.findById(pid) === (void 0)) {
            throw new AgentError("agent_not_found", [`pid ${pid}`]);
        }
        const previous = this.affect(pid);
        this.affectRows.upsert({
            pid,
            valence: input.valence ?? previous?.valence ?? 0,
            arousal: input.arousal ?? previous?.arousal ?? 0,
            stress: input.stress ?? previous?.stress ?? 0,
            fatigue: input.fatigue ?? previous?.fatigue ?? 0,
            mood: input.mood ?? previous?.mood ?? "neutral",
            updated_at: at,
        });
        const affect = this.affect(pid);
        if (affect === (void 0)) {
            throw new AgentError("invalid_affect", [`pid ${pid}`]);
        }
        return affect;
    }

    addBackground(input: Parameters<AgentStore["addBackground"]>[0]): BackgroundProcess {
        if (this.findById(input.pid) === (void 0)) {
            throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        }
        const next = this.backgroundRows.queryOne<{ n: number }>("SELECT COALESCE(MAX(bpid), 0) + 1 AS n FROM background_processes")?.n ?? 1;
        const id = `bg.${input.pid}.${next}`;
        this.backgroundRows.insert({
            id,
            pid: input.pid,
            kind: input.kind,
            label: input.label,
            intensity: input.intensity ?? 0.5,
            trigger: input.trigger ?? null,
            script: input.script ?? null,
            status: "active",
            updated_at: input.at,
        });
        const row = this.backgroundRows.select({ where: "id = ?", params: [id], limit: 1 })[0];
        if (row === (void 0)) {
            throw new AgentError("agent_not_found", [`background ${id}`]);
        }
        return toBackground(row);
    }

    setBackgroundStatus(pid: Pid, id: string, status: BackgroundProcess["status"], at: string): BackgroundProcess {
        const changed = this.backgroundRows.updateWhere("pid = ? AND id = ?", { status, updated_at: at }, pid, id);
        if (changed === 0) {
            throw new AgentError("agent_not_found", [`background ${id}`]);
        }
        const row = this.backgroundRows.select({ where: "id = ?", params: [id], limit: 1 })[0];
        if (row === (void 0)) {
            throw new AgentError("agent_not_found", [`background ${id}`]);
        }
        return toBackground(row);
    }

    recordLifeEvent(input: Parameters<AgentStore["recordLifeEvent"]>[0]): LifeEvent {
        if (this.findById(input.pid) === (void 0)) {
            throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        }
        const next = this.eventRows.queryOne<{ n: number }>("SELECT COALESCE(MAX(ev_id), 0) + 1 AS n FROM life_events")?.n ?? 1;
        const id = `ev.${input.pid}.${next}`;
        this.eventRows.insert({
            id,
            pid: input.pid,
            kind: input.kind,
            summary: input.summary,
            at: input.at,
            role_id: input.roleId ?? null,
            impact: input.impact ?? 0.5,
            narrative_version: input.narrativeVersion ?? null,
        });
        const row = this.eventRows.select({ where: "id = ?", params: [id], limit: 1 })[0];
        if (row === (void 0)) {
            throw new AgentError("agent_not_found", [`life event ${id}`]);
        }
        return toLifeEvent(row);
    }
}
