/**
 * In-memory reference implementation of `AgentStore`.
 *
 * A storage adapter implements the same port; this one exists so the agent
 * facets and context assembler are testable without SQLite.
 */
import { AgentError } from "../error/agentError.ts";
import type {
    ActivateRoleInput,
    AffectInput,
    AffectState,
    AgentProfile,
    AgentStore,
    AssignRoleInput,
    BackgroundProcess,
    BackgroundStatus,
    LifeEvent,
    Memory,
    MemoryQuery,
    NewAgentProfile,
    NewBackgroundProcess,
    NewLifeEvent,
    NewMemory,
    NewNarrative,
    NewRole,
    Pid,
    Role,
    RoleAssignment,
    SelfNarrative,
} from "./agent.ts";

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const clamp11 = (value: number): number => Math.max(-1, Math.min(1, value));

const cloneProfile = (profile: AgentProfile): AgentProfile => ({
    ...profile,
    values: [...profile.values],
    constraints: [...profile.constraints],
});

const cloneRole = (role: Role): Role => ({
    ...role,
    obligations: role.obligations.map((obligation) => ({ ...obligation, conflictsWith: obligation.conflictsWith?.slice() })),
    expectations: [...role.expectations],
    audiences: [...role.audiences],
    scripts: [...role.scripts],
});

const cloneAssignment = (assignment: RoleAssignment): RoleAssignment => ({
    role: cloneRole(assignment.role),
    salience: assignment.salience,
    active: assignment.active,
    since: assignment.since,
});

const cloneMemory = (memory: Memory): Memory => ({ ...memory, refs: [...memory.refs] });

export class InMemoryAgentStore implements AgentStore {
    private readonly profiles = new Map<Pid, AgentProfile>();
    private readonly narratives = new Map<Pid, SelfNarrative[]>();
    private readonly roleRegistry = new Map<string, Role>();
    private readonly assignments = new Map<Pid, Map<string, RoleAssignment>>();
    private readonly memoryRows = new Map<Pid, Memory[]>();
    private readonly affects = new Map<Pid, AffectState>();
    private readonly backgroundRows = new Map<Pid, BackgroundProcess[]>();
    private readonly events = new Map<Pid, LifeEvent[]>();
    private nextMemory = 1;
    private nextBackground = 1;
    private nextLifeEvent = 1;

    profile(pid: Pid): AgentProfile | undefined {
        const profile = this.profiles.get(pid);
        return profile === undefined ? undefined : cloneProfile(profile);
    }

    narrative(pid: Pid, version?: number): SelfNarrative | undefined {
        const versions = this.narratives.get(pid);
        if (versions === undefined || versions.length === 0) return undefined;
        const found = version === undefined ? versions[versions.length - 1] : versions.find((entry) => entry.version === version);
        return found === undefined ? undefined : { ...found, identity: { ...found.identity } };
    }

    roles(pid: Pid): RoleAssignment[] {
        return [...(this.assignments.get(pid)?.values() ?? [])].map(cloneAssignment);
    }

    activeRole(pid: Pid): RoleAssignment | undefined {
        return this.roles(pid).find((entry) => entry.active);
    }

    memories(pid: Pid, query: MemoryQuery = {}): Memory[] {
        let rows = [...(this.memoryRows.get(pid) ?? [])];
        if (query.kind !== undefined) rows = rows.filter((row) => row.kind === query.kind);
        if (query.roleId !== undefined) rows = rows.filter((row) => row.roleId === query.roleId);
        if (query.minSalience !== undefined) rows = rows.filter((row) => row.salience >= (query.minSalience ?? 0));
        if (query.before !== undefined) rows = rows.filter((row) => row.at < (query.before ?? ""));
        if (query.includeConsolidated === false) rows = rows.filter((row) => row.consolidated === false);
        rows.sort((left, right) => right.salience - left.salience || right.at.localeCompare(left.at));
        if (query.limit !== undefined) rows = rows.slice(0, Math.max(0, query.limit));
        return rows.map(cloneMemory);
    }

    affect(pid: Pid): AffectState | undefined {
        const state = this.affects.get(pid);
        return state === undefined ? undefined : { ...state };
    }

    background(pid: Pid, status?: BackgroundStatus): BackgroundProcess[] {
        let rows = [...(this.backgroundRows.get(pid) ?? [])];
        if (status !== undefined) rows = rows.filter((row) => row.status === status);
        rows.sort((left, right) => right.intensity - left.intensity);
        return rows.map((process) => ({ ...process }));
    }

    lifeEvents(pid: Pid, limit = 20): LifeEvent[] {
        return [...(this.events.get(pid) ?? [])]
            .sort((left, right) => right.at.localeCompare(left.at))
            .slice(0, Math.max(0, limit))
            .map((event) => ({ ...event }));
    }

    createProfile(input: NewAgentProfile): AgentProfile {
        if (this.profiles.has(input.pid)) throw new AgentError("profile_exists", [`pid ${input.pid}`]);
        const profile: AgentProfile = {
            pid: input.pid,
            name: input.name,
            lifeChapter: input.lifeChapter ?? "starting",
            values: [...(input.values ?? [])],
            constraints: [...(input.constraints ?? [])],
            version: 1,
            updatedAt: input.at,
        };
        this.profiles.set(input.pid, profile);
        return cloneProfile(profile);
    }

    reviseNarrative(input: NewNarrative): SelfNarrative {
        if (!this.profiles.has(input.pid)) throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        if (input.narrative.trim().length === 0) throw new AgentError("invalid_memory", ["narrative is empty"]);
        const versions = this.narratives.get(input.pid) ?? [];
        const next: SelfNarrative = {
            pid: input.pid,
            version: versions.length + 1,
            identity: { ...input.identity },
            narrative: input.narrative,
            at: input.at,
        };
        versions.push(next);
        this.narratives.set(input.pid, versions);
        return { ...next, identity: { ...next.identity } };
    }

    addRole(input: NewRole): Role {
        if (this.roleRegistry.has(input.id)) throw new AgentError("role_not_found", [`role ${input.id} already exists`]);
        const role: Role = {
            id: input.id,
            label: input.label,
            obligations: (input.obligations ?? []).map((obligation) => ({ ...obligation, conflictsWith: obligation.conflictsWith?.slice() })),
            expectations: [...(input.expectations ?? [])],
            audiences: [...(input.audiences ?? [])],
            scripts: [...(input.scripts ?? [])],
            status: "active",
            createdAt: input.createdAt,
        };
        this.roleRegistry.set(role.id, role);
        return cloneRole(role);
    }

    private role(id: string): Role {
        const role = this.roleRegistry.get(id);
        if (role === undefined) throw new AgentError("role_not_found", [`role ${id}`]);
        return role;
    }

    assignRole(input: AssignRoleInput): RoleAssignment {
        if (!this.profiles.has(input.pid)) throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        const role = this.role(input.roleId);
        if (role.status === "retired") throw new AgentError("role_not_found", [`role ${input.roleId} is retired`]);
        const assignments = this.assignments.get(input.pid) ?? new Map<string, RoleAssignment>();
        if (input.active === true) {
            for (const assignment of assignments.values()) assignment.active = false;
        }
        const assignment: RoleAssignment = {
            role: cloneRole(role),
            salience: clamp01(input.salience ?? 0.5),
            active: input.active === true,
            since: input.since,
        };
        assignments.set(role.id, assignment);
        this.assignments.set(input.pid, assignments);
        return cloneAssignment(assignment);
    }

    activateRole(input: ActivateRoleInput): RoleAssignment {
        const assignments = this.assignments.get(input.pid);
        const current = assignments?.get(input.roleId);
        if (assignments === undefined || current === undefined) {
            throw new AgentError("role_not_assigned", [`pid ${input.pid} role ${input.roleId}`]);
        }
        for (const assignment of assignments.values()) assignment.active = false;
        current.active = true;
        current.since = input.at;
        return cloneAssignment(current);
    }

    remember(input: NewMemory): Memory {
        if (!this.profiles.has(input.pid)) throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        if (input.content.trim().length === 0) throw new AgentError("invalid_memory", ["content is empty"]);
        const memory: Memory = {
            id: `mem.${input.pid}.${this.nextMemory}`,
            pid: input.pid,
            roleId: input.roleId,
            kind: input.kind,
            content: input.content,
            salience: clamp01(input.salience ?? 0.5),
            at: input.at,
            refs: [...(input.refs ?? [])],
            source: input.source,
            consolidated: false,
        };
        this.nextMemory += 1;
        const rows = this.memoryRows.get(input.pid) ?? [];
        rows.push(memory);
        this.memoryRows.set(input.pid, rows);
        return cloneMemory(memory);
    }

    forget(pid: Pid, memoryId: string): boolean {
        const rows = this.memoryRows.get(pid);
        if (rows === undefined) return false;
        const index = rows.findIndex((row) => row.id === memoryId);
        if (index < 0) return false;
        rows.splice(index, 1);
        return true;
    }

    consolidate(pid: Pid, memoryIds: string[], _at: string): number {
        const rows = this.memoryRows.get(pid) ?? [];
        let changed = 0;
        for (const row of rows) {
            if (!memoryIds.includes(row.id) || row.consolidated) continue;
            row.consolidated = true;
            row.salience = clamp01(row.salience + 0.1);
            changed += 1;
        }
        return changed;
    }

    setAffect(pid: Pid, input: AffectInput, at: string): AffectState {
        if (!this.profiles.has(pid)) throw new AgentError("agent_not_found", [`pid ${pid}`]);
        const previous = this.affects.get(pid) ?? {
            pid,
            valence: 0,
            arousal: 0,
            stress: 0,
            fatigue: 0,
            mood: "neutral",
            updatedAt: at,
        };
        const next: AffectState = {
            pid,
            valence: clamp11(input.valence ?? previous.valence),
            arousal: clamp01(input.arousal ?? previous.arousal),
            stress: clamp01(input.stress ?? previous.stress),
            fatigue: clamp01(input.fatigue ?? previous.fatigue),
            mood: input.mood ?? previous.mood,
            updatedAt: at,
        };
        this.affects.set(pid, next);
        return { ...next };
    }

    addBackground(input: NewBackgroundProcess): BackgroundProcess {
        if (!this.profiles.has(input.pid)) throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        const process: BackgroundProcess = {
            id: `bg.${input.pid}.${this.nextBackground}`,
            pid: input.pid,
            kind: input.kind,
            label: input.label,
            intensity: clamp01(input.intensity ?? 0.5),
            trigger: input.trigger,
            script: input.script,
            status: "active",
            updatedAt: input.at,
        };
        this.nextBackground += 1;
        const rows = this.backgroundRows.get(input.pid) ?? [];
        rows.push(process);
        this.backgroundRows.set(input.pid, rows);
        return { ...process };
    }

    setBackgroundStatus(pid: Pid, id: string, status: BackgroundStatus, at: string): BackgroundProcess {
        const rows = this.backgroundRows.get(pid) ?? [];
        const process = rows.find((row) => row.id === id);
        if (process === undefined) throw new AgentError("agent_not_found", [`background ${id}`]);
        process.status = status;
        process.updatedAt = at;
        return { ...process };
    }

    recordLifeEvent(input: NewLifeEvent): LifeEvent {
        if (!this.profiles.has(input.pid)) throw new AgentError("agent_not_found", [`pid ${input.pid}`]);
        const event: LifeEvent = {
            id: `ev.${input.pid}.${this.nextLifeEvent}`,
            pid: input.pid,
            kind: input.kind,
            summary: input.summary,
            at: input.at,
            roleId: input.roleId,
            impact: clamp01(input.impact ?? 0.5),
            narrativeVersion: input.narrativeVersion,
        };
        this.nextLifeEvent += 1;
        const rows = this.events.get(input.pid) ?? [];
        rows.push(event);
        this.events.set(input.pid, rows);
        return { ...event };
    }
}
